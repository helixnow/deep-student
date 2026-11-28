/**
 * PDF 阅读划词能力接入层。
 *
 * 改造前 PDF 划词只有一条高亮选色条，聊天里已有的「解释 / 翻译 / 保存为笔记 /
 * 生成卡片」在阅读场景完全够不着。这里把共享层的 SelectionToolbar 挂到 PDF 选区上，
 * 复用同一套组件与同一批能力实现，不另起一条平行链路：
 *
 * - 解释 / 翻译 → 复用 chat 的 ExplainPopover / TranslationPopover（两者都只吃
 *   sourceText，不依赖聊天 store）
 * - 保存为笔记 → 复用 @/shared/notes 的目录选择 + 「打开笔记」toast；正文带
 *   来源行（fileName + page locator，与链路 A 摘录笔记同一落地格式）
 * - 生成卡片   → 复用 chat 的 selectionCardGeneration（内部走既有 CardForge 适配器）
 * - 添加到聊天 → 优先走宿主注入的 onQuoteToChat locator 回调（与链路 A
 *   「引用到对话」同形：资源引用 + page locator）；无回调或页码不可得时走
 *   selectionStudyActions.sendSelectionToChatInput 的 PREFILL_CHAT_INPUT 包装
 *   （先切聊天视图再注入，payload 带 page/sourceName），不派发裸 CHAT_V2_SET_INPUT
 *
 * 边界：高亮选色不在本工具条——色板留在 viewer 内建的 ds-highlight-menu。
 *
 * 定位契约：
 * - 工具条挂在 `.ds-pdf-viewer`（position: relative）内，absolute 定位，随宿主滚动
 * - 桌面优先放在选区「下方」：选区上方已被既有高亮选色菜单占用，避免两条重叠
 * - 触屏同样在下方（让开系统选择手柄与放大镜），底部再避让阅读器底栏 + Home Indicator
 * - 结果卡片（解释 / 翻译）走底部内联面板，不用 Dialog，窄屏不会溢出
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  ArrowSquareOut,
  Check,
  DotsSixVertical,
  FilePlus,
  Lightning,
  X,
} from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import { useOptionalSlot, useOptionalUiKernel } from '@/ui-kernel/react';
import { SlotEntryScope, runSlotCallback } from '@/ui-kernel/outlet';
import type { PdfSelectionToolbarContribution } from '@/ui-kernel/contracts/surfaces';
import type { SlotEntry } from '@/ui-kernel/slots';
import { cn } from '@/utils/cn';
import { SelectionToolbar, useTextSelection, type TextSelectionState } from '@/shared/selection';
import type { SelectionToolbarExtraAction } from '@/shared/selection/SelectionToolbar';
import type { SelectionSourceKind } from '@/features/chat/context/selectionRef';
import '../styles/selection-panel.css';
import { SaveAsNoteFolderPicker, truncateNoteTitle, useSaveAsNoteFlow } from '@/shared/notes';
import { normalizePdfAcademicText } from '../pdfAcademicText';
import { buildSelectionNoteContent, type PdfSelectionPayload } from '../pdfSelectionActions';
import { buildAnnotationSourceLine } from '../pdfAnnotationList';
// 静态导入安全：selectionStudyActions 仅静态依赖轻量协议与纯函数，
// workbench/notes/anki 均为触发时按需动态 import，不拖入 PDF chunk 或启动闭包
import {
  appendSelectionToActiveNote,
  buildQuickCardDraft,
  createQuickLocalCard,
  sendSelectionToChatInput,
  wrapSelectionWithCloze,
  type UndoAppendResult,
} from '../selectionStudyActions';
import {
  buildExcerptDragLabel,
  buildPdfExcerptPayload,
  buildPdfSemanticAnchor,
  computeNormalizedSelectionBounds,
  pdfAutoExcerptKey,
  rotateNormalizedRect,
  setCompactDragImage,
  sharedPdfExcerptGuard,
} from '../interop/pdfInteropBridge';

// 解释/翻译结果卡片复用聊天组件，但必须懒加载：静态导入会把整条翻译链路
// 打进 PDF 侧 chunk，抵消 EnhancedPdfViewer 与 selectionStudyActions 的拆包设计。
// 用户点「解释/翻译」时结果面板才挂载，首帧多一次 chunk 加载可接受。
const ExplainPopover = React.lazy(() =>
  import('@/features/chat/components/ExplainPopover').then((m) => ({ default: m.ExplainPopover }))
);
const TranslationPopover = React.lazy(() =>
  import('@/features/chat/components/TranslationPopover').then((m) => ({
    default: m.TranslationPopover,
  }))
);
import { registerVisibilityGuardedBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

/**
 * 触屏底部避让高度：阅读器底栏 + 进度细线 + Home Indicator 的经验值。
 * 只用于「选区下方放不放得下」的判断，放不下时工具条翻到选区上方。
 */
const MOBILE_BOTTOM_INSET_PX = 132;

export interface PdfSelectionActionsProps {
  /** 阅读器根元素（.ds-pdf-viewer，position: relative），工具条的定位容器 */
  containerRef: React.RefObject<HTMLElement | null>;
  /** 文本层是否启用；关闭时整套划词能力不挂载 */
  enabled: boolean;
  /** 触屏 / 窄屏形态 */
  isMobileLike: boolean;
  /** 文档标题（必须是人类可读的 fileName，不是 DSTU 资源 ID），用于笔记来源行与聊天来源标注 */
  documentTitle?: string;
  /**
   * 「添加到聊天」locator 回调，与链路 A（viewer 的 onQuoteToChat）同形：
   * 上层视图接 useReferenceToChat 后注入资源引用 + `page:N` locator，Agent 可回读原文。
   * 缺省（或选区页码不可得）时走 PREFILL_CHAT_INPUT 文本注入兜底。
   */
  onQuoteToChat?: (payload: PdfSelectionPayload) => void;
  /**
   * P0 选区即上下文：源资源 id（tb_xxx / file_xxx）。提供时工具条渲染
   * 「引用到聊天」动作——选区文本快照 + page locator 作为结构化 contextRef
   * 注入（与 onQuoteToChat 的整资源引用语义不同，精准且省 token）。
   */
  selectionSourceId?: string;
  /**
   * 外部提供的选区（如 EPUB 正文在 iframe 里，用 useIframeTextSelection）。
   * 不传时检测 containerRef 内的页面选区（PDF 文本层）。
   */
  selectionOverride?: TextSelectionState;
  /** 选区来源类型（引用到聊天的 source.kind），默认 pdf */
  selectionKind?: SelectionSourceKind;
  /** 无 PDF 页码时的定位（如 EPUB 的 `chapter:N`），用于引用到聊天 */
  resolveFallbackLocator?: () => string | undefined;
  /** 将 AI 翻译 / 精读结果一键钉入当前选区对应的高亮批注笔记 */
  onPinToAnnotation?: (payload: {
    sourceText: string;
    noteText: string;
    page?: number;
  }) => void;
  /**
   * 跨插件摘录的锚点资源 id（selectionSourceId 或 resourcePath）。
   * 提供时显示「拖入导图」胶囊，并允许「划选即入图」自动摘录；EPUB 等非 PDF 宿主不传。
   */
  interopResourceId?: string;
  /** 锚点的别名资源 id（VFS resourceId），便于反查 */
  interopAliasResourceId?: string;
  /** 「划选即入图」开关：选区稳定后自动送入当前导图 / 笔记 */
  autoExcerptActive?: boolean;
  /** 可选顶部扩展槽位（桌面端合并高亮色板/批注/引文到同一气泡，避免三气泡重叠） */
  headerSlot?: React.ReactNode;
}

interface SelectionExcerptSnapshot {
  text: string;
  page: number;
  rect?: { x: number; y: number; w: number; h: number };
}

interface QuickCardPanelState {
  sourceText: string;
  page?: number;
  mode: 'basic' | 'cloze';
  front: string;
  back: string;
  clozeText: string;
  clozeExtra: string;
  submitting: boolean;
  error: string | null;
}

interface AppendFeedbackState {
  noteId: string;
  title: string;
  openNote: () => void;
  undo: () => Promise<UndoAppendResult>;
  undoing: boolean;
}

const APPEND_FEEDBACK_DURATION_MS = 8000;

export const PdfSelectionActions: React.FC<PdfSelectionActionsProps> = ({
  containerRef,
  enabled,
  isMobileLike,
  documentTitle,
  onQuoteToChat,
  selectionSourceId,
  selectionOverride,
  selectionKind = 'pdf',
  resolveFallbackLocator,
  onPinToAnnotation,
  interopResourceId,
  interopAliasResourceId,
  autoExcerptActive = false,
  headerSlot,
}) => {
  const { t } = useTranslation(['pdf', 'chatV2', 'common']);
  const pageSelection = useTextSelection(containerRef);
  const selection = selectionOverride ?? pageSelection;
  const panelRef = useRef<HTMLDivElement>(null);

  const normalizeText = useCallback(
    (raw: string) => (selectionKind === 'pdf' ? normalizePdfAcademicText(raw) : raw.trim()),
    [selectionKind],
  );

  const [explainState, setExplainState] = useState<{
    text: string;
    contextBefore: string;
    contextAfter: string;
    page?: number;
  } | null>(null);
  const [translateState, setTranslateState] = useState<{
    text: string;
    contextBefore: string;
    contextAfter: string;
    page?: number;
  } | null>(null);
  const [quickCardState, setQuickCardState] = useState<QuickCardPanelState | null>(null);
  const [appendFeedback, setAppendFeedback] = useState<AppendFeedbackState | null>(null);
  const appendFeedbackTimerRef = useRef<number | null>(null);
  const clozeTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const saveAsNoteFlow = useSaveAsNoteFlow({ openSource: 'pdf-selection' });
  const startSaveAsNote = saveAsNoteFlow.start;

  const panelOpen = explainState !== null || translateState !== null || quickCardState !== null;
  // 面板打开后原选区仍在，工具条让位；但读者接着选了另一段时要能直接再解释 / 翻译 / 制卡，
  // 不必先手动关面板（新动作会替换面板内容）
  const panelSourceText =
    explainState?.text ?? translateState?.text ?? quickCardState?.sourceText ?? null;
  const normalizedSelectedText = selection.selectedText ? normalizeText(selection.selectedText) : '';
  const toolbarVisible =
    selection.isVisible && (!panelOpen || normalizedSelectedText !== panelSourceText);
  const closePanel = useCallback(() => {
    setExplainState(null);
    setTranslateState(null);
    setQuickCardState(null);
  }, []);

  const clearAppendFeedbackTimer = useCallback(() => {
    if (appendFeedbackTimerRef.current !== null) {
      window.clearTimeout(appendFeedbackTimerRef.current);
      appendFeedbackTimerRef.current = null;
    }
  }, []);

  const dismissAppendFeedback = useCallback(() => {
    clearAppendFeedbackTimer();
    setAppendFeedback(null);
  }, [clearAppendFeedbackTimer]);

  useEffect(() => clearAppendFeedbackTimer, [clearAppendFeedbackTimer]);

  const prevDocumentIdentityRef = useRef({
    selectionSourceId,
    interopResourceId,
    documentTitle,
  });
  useEffect(() => {
    const prev = prevDocumentIdentityRef.current;
    if (
      prev.selectionSourceId === selectionSourceId &&
      prev.interopResourceId === interopResourceId &&
      prev.documentTitle === documentTitle
    ) {
      return;
    }
    prevDocumentIdentityRef.current = {
      selectionSourceId,
      interopResourceId,
      documentTitle,
    };
    closePanel();
    dismissAppendFeedback();
  }, [selectionSourceId, interopResourceId, documentTitle, closePanel, dismissAppendFeedback]);

  // Android 返回键：先关结果面板，不要直接退出阅读器。
  // 用共享可见性守卫注册：保活但不可见的 PDF 实例（ViewLayerRenderer
  // keep-alive 隐藏层）若残留打开的面板，不得吞掉活跃页面的返回键。
  React.useEffect(() => {
    if (!panelOpen) return;
    return registerVisibilityGuardedBackHandler(containerRef, () => {
      closePanel();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [panelOpen, closePanel, containerRef]);

  /**
   * 解析当前选区所在页码（1-based，取自页面包裹层的 data-page-number）。
   *
   * 点击时机可靠：SelectionToolbar 对 mousedown preventDefault（防清选区），
   * 各动作回调触发时 DOM 选区仍在。解析失败（无选区 / 不在页面包裹层内）
   * 返回 undefined，调用方按无页码降级，不阻断动作本身。
   */
  const resolveSelectionPage = useCallback((): number | undefined => {
    const container = containerRef.current;
    const domSelection = window.getSelection();
    if (!container || !domSelection || domSelection.rangeCount === 0) return undefined;
    const node = domSelection.getRangeAt(0).startContainer;
    const element = node instanceof Element ? node : node.parentElement;
    const pageEl = element?.closest('[data-page-number]');
    if (!pageEl || !container.contains(pageEl)) return undefined;
    const page = Number.parseInt(pageEl.getAttribute('data-page-number') ?? '', 10);
    return Number.isInteger(page) && page > 0 ? page : undefined;
  }, [containerRef]);

  const handleExplain = useCallback(
    (rawText: string) => {
      const clean = normalizeText(rawText);
      if (!clean) return;
      const page = resolveSelectionPage();
      setTranslateState(null);
      setQuickCardState(null);
      setExplainState({
        text: clean,
        contextBefore: selection.contextBefore,
        contextAfter: selection.contextAfter,
        page,
      });
    },
    [normalizeText, resolveSelectionPage, selection.contextBefore, selection.contextAfter],
  );

  const handleTranslate = useCallback(
    (rawText: string) => {
      const clean = normalizeText(rawText);
      if (!clean) return;
      const page = resolveSelectionPage();
      setExplainState(null);
      setQuickCardState(null);
      setTranslateState({
        text: clean,
        contextBefore: selection.contextBefore,
        contextAfter: selection.contextAfter,
        page,
      });
    },
    [normalizeText, resolveSelectionPage, selection.contextBefore, selection.contextAfter],
  );

  // 划词单键快捷键桥（阅读器内选中文本后按 T 翻译 / 按 E 解释）
  React.useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;
    const onTrigger = (ev: Event) => {
      const detail = (ev as CustomEvent<{ action?: 'translate' | 'explain'; text?: string }>).detail;
      const targetText = detail?.text || selection.selectedText;
      if (!targetText?.trim()) return;
      if (detail?.action === 'translate') {
        handleTranslate(targetText);
      } else if (detail?.action === 'explain') {
        handleExplain(targetText);
      }
    };
    container.addEventListener('pdf-selection-trigger-action', onTrigger);
    return () => container.removeEventListener('pdf-selection-trigger-action', onTrigger);
  }, [enabled, containerRef, selection.selectedText, handleTranslate, handleExplain]);

  const handleSaveAsNote = useCallback((rawText: string) => {
    const text = normalizeText(rawText);
    // 有 fileName + 页码时与链路 A 摘录笔记同一落地格式：
    // 引用块正文 + 来源行「—— 摘自《fileName》第 N 页」（page locator），
    // 标题取摘录首 30 字。documentTitle 由挂载方保证是 fileName 而非资源 ID。
    const page = resolveSelectionPage();
    if (documentTitle && typeof page === 'number') {
      const compactTitle = truncateNoteTitle(text, 30);
      const label = t('pdf:selection.note_source', { name: documentTitle, page });
      startSaveAsNote({
        content: buildSelectionNoteContent({
          text,
          // 与批注导出同一格式：有资源 id 时来源行是 pdfref:// 回链，笔记里点击回到原页
          sourceLabel: buildAnnotationSourceLine({ label, sourceId: selectionSourceId, page, quote: text }),
        }),
        title: compactTitle || documentTitle,
        origin: selectionSourceId ? { kind: 'resource', resourceId: selectionSourceId, page, title: documentTitle, quote: text.slice(0, 120) } : undefined,
      });
      return;
    }
    // EPUB / 富文档等无 PDF 页码场景：消费 resolveFallbackLocator 写入章节溯源与 _origin
    const fallbackLocator = resolveFallbackLocator?.()?.trim() || undefined;
    if (fallbackLocator || selectionSourceId) {
      const compactTitle = truncateNoteTitle(text, 30);
      const chapterMatch = fallbackLocator ? /^chapter:(\d+)$/i.exec(fallbackLocator) : null;
      const sourceLabel = documentTitle
        ? chapterMatch
          ? t('pdf:selection.epub_chapter_source', {
              defaultValue: '—— 摘自《{{name}}》第 {{chapter}} 章',
              name: documentTitle,
              chapter: chapterMatch[1],
            })
          : fallbackLocator
            ? t('pdf:selection.locator_source', {
                defaultValue: '—— 摘自《{{name}}》（{{locator}}）',
                name: documentTitle,
                locator: fallbackLocator,
              })
            : `—— ${documentTitle}`
        : fallbackLocator
          ? `—— ${fallbackLocator}`
          : undefined;
      startSaveAsNote({
        content: sourceLabel
          ? buildSelectionNoteContent({ text, sourceLabel })
          : documentTitle
            ? `> ${documentTitle}\n\n${text}`
            : text,
        ...(compactTitle || documentTitle ? { title: compactTitle || documentTitle } : {}),
        ...(selectionSourceId
          ? {
              origin: {
                kind: 'resource' as const,
                resourceId: selectionSourceId,
                ...(fallbackLocator ? { locator: fallbackLocator } : {}),
                title: documentTitle,
                quote: text.slice(0, 120),
              },
            }
          : {}),
      });
      return;
    }
    // 页码与回退定位均不可得时的降级：至少保留文档名做来源
    startSaveAsNote({
      content: documentTitle ? `> ${documentTitle}\n\n${text}` : text,
    });
  }, [normalizeText, startSaveAsNote, documentTitle, resolveSelectionPage, resolveFallbackLocator, t, selectionSourceId]);

  const handleMakeCards = useCallback((rawText: string) => {
    const text = normalizeText(rawText);
    // 动态 import：selectionCardGeneration 顶层静态依赖 cardforge 的 cardAgent，
    // 只在用户真点「制卡」时才载入，避免 cardforge 打进 PDF 侧 chunk
    const page = resolveSelectionPage();
    const input = {
      selectedText: text,
      contextBefore: selection.contextBefore,
      contextAfter: selection.contextAfter,
      sourceRef: selectionSourceId
        ? { kind: 'resource' as const, id: selectionSourceId, title: documentTitle || undefined, page: typeof page === 'number' ? page : undefined, quote: text.slice(0, 120) }
        : undefined,
      t,
    };
    void import('@/features/chat/services/selectionCardGeneration').then(
      ({ generateCardsFromSelection }) => generateCardsFromSelection(input)
    );
  }, [normalizeText, selection.contextBefore, selection.contextAfter, t, resolveSelectionPage, selectionSourceId, documentTitle]);

  // Gap S2-A：1-Click 追加到当前活跃笔记（> quote + pdfref:// 回链 + View/Undo），无打开笔记时回退目录选择器
  const handleAppendToActiveNote = useCallback(
    (rawText: string) => {
      const text = normalizeText(rawText);
      if (!text) return;
      const page = resolveSelectionPage();
      const fallbackLocator = resolveFallbackLocator?.()?.trim() || undefined;
      void appendSelectionToActiveNote(
        {
          text,
          sourceId: selectionSourceId,
          aliasResourceId: interopAliasResourceId,
          documentTitle,
          page,
          fallbackLocator,
        },
        t,
      ).then((result) => {
        if (result.ok === true) {
          clearAppendFeedbackTimer();
          setAppendFeedback({
            noteId: result.noteId,
            title: result.title,
            openNote: result.openNote,
            undo: result.undo,
            undoing: false,
          });
          appendFeedbackTimerRef.current = window.setTimeout(() => {
            appendFeedbackTimerRef.current = null;
            setAppendFeedback(null);
          }, APPEND_FEEDBACK_DURATION_MS);
        } else if (result.ok === false && result.reason === 'no_active_note') {
          handleSaveAsNote(rawText);
        }
      });
    },
    [
      normalizeText,
      resolveSelectionPage,
      resolveFallbackLocator,
      selectionSourceId,
      interopAliasResourceId,
      documentTitle,
      t,
      clearAppendFeedbackTimer,
      handleSaveAsNote,
    ],
  );

  const handleUndoAppendFeedback = useCallback(() => {
    if (!appendFeedback || appendFeedback.undoing) return;
    clearAppendFeedbackTimer();
    const current = appendFeedback;
    setAppendFeedback((prev) => (prev ? { ...prev, undoing: true } : null));
    void current.undo().finally(() => {
      setAppendFeedback((prev) => (prev?.noteId === current.noteId ? null : prev));
    });
  }, [appendFeedback, clearAppendFeedbackTimer]);

  // Gap S2-B：1-Click 本地快速闪卡内联面板（Basic / Cloze，0 LLM 等待，带 pdfref:// 来源）
  const handleOpenQuickCard = useCallback(
    (rawText: string) => {
      const text = normalizeText(rawText);
      if (!text) return;
      const page = resolveSelectionPage();
      const draft = buildQuickCardDraft({ text, documentTitle, page });
      setExplainState(null);
      setTranslateState(null);
      setQuickCardState({
        sourceText: text,
        page,
        mode: 'basic',
        front: draft.front,
        back: draft.back,
        clozeText: draft.clozeText,
        clozeExtra: draft.clozeExtra,
        submitting: false,
        error: null,
      });
    },
    [normalizeText, resolveSelectionPage, documentTitle],
  );

  const handleWrapCloze = useCallback(() => {
    setQuickCardState((prev) => {
      if (!prev) return null;
      const el = clozeTextareaRef.current;
      const start = el?.selectionStart ?? 0;
      const end = el?.selectionEnd ?? 0;
      const wrapped = wrapSelectionWithCloze(prev.clozeText, start, end);
      window.requestAnimationFrame(() => {
        if (clozeTextareaRef.current) {
          clozeTextareaRef.current.focus();
          clozeTextareaRef.current.setSelectionRange(wrapped.nextCaret, wrapped.nextCaret);
        }
      });
      return { ...prev, clozeText: wrapped.text, error: null };
    });
  }, []);

  const handleSubmitQuickCard = useCallback(async () => {
    if (!quickCardState || quickCardState.submitting) return;
    setQuickCardState((prev) => (prev ? { ...prev, submitting: true, error: null } : null));
    const result = await createQuickLocalCard(
      {
        mode: quickCardState.mode,
        front: quickCardState.mode === 'cloze' ? quickCardState.clozeText : quickCardState.front,
        back: quickCardState.mode === 'cloze' ? quickCardState.clozeExtra : quickCardState.back,
        sourceText: quickCardState.sourceText,
        sourceId: selectionSourceId,
        aliasResourceId: interopAliasResourceId,
        documentTitle,
        page: quickCardState.page,
      },
      t,
    );
    if (result.ok === true) {
      setQuickCardState(null);
      return;
    }
    const failureMessage =
      (result.ok === false ? result.error : undefined) ??
      t('pdf:selection.quick_card_failed', { defaultValue: '创建快速闪卡失败' });
    setQuickCardState((prev) =>
      prev
        ? {
            ...prev,
            submitting: false,
            error: failureMessage,
          }
        : null,
    );
  }, [quickCardState, selectionSourceId, interopAliasResourceId, documentTitle, t]);


  // P0 选区即上下文：选区快照 + page locator → 结构化 contextRef。
  // 动态 import 避免把 chat context 链路静态打进 PDF 侧 chunk（同制卡的纪律）。
  const handleAddAsContext = useCallback((rawText: string) => {
    if (!selectionSourceId) return;
    const text = normalizeText(rawText);
    const page = resolveSelectionPage();
    void import('@/features/chat/context/selectionRef').then(({ selectionToChat }) =>
      selectionToChat({
        text,
        source: {
          kind: selectionKind,
          sourceId: selectionSourceId,
          locator: typeof page === 'number' ? `page:${page}` : resolveFallbackLocator?.(),
          title: documentTitle,
        },
      })
    );
  }, [normalizeText, selectionSourceId, documentTitle, resolveSelectionPage, selectionKind, resolveFallbackLocator]);

  // 工具条「添加到聊天」（唯一入口）：有资源 id 时走选区即上下文（选区快照 + page locator，
  // 可点回原页）——旧实现走宿主 onQuoteToChat 的整文档引用，selectedText 只塞进 metadata
  // 而上下文定义不读取，模型拿到的是整本书而非选区；且与「引用到聊天」两个按钮并存易混淆。
  // 无资源 id（未入库的临时文件）时退回 PREFILL 文本注入。
  const handleAddToChat = useCallback((rawText: string) => {
    const text = normalizeText(rawText);
    if (selectionSourceId) {
      handleAddAsContext(text);
      return;
    }
    sendSelectionToChatInput({ text, sourceName: documentTitle, page: resolveSelectionPage() });
  }, [normalizeText, selectionSourceId, handleAddAsContext, documentTitle, resolveSelectionPage]);

  // 解释/翻译结果面板的「添加到输入框」：内容是 AI 生成文本而非原文选区，
  // 不适用 locator 引用语义，固定走 PREFILL 文本注入（此时选区已清，无页码）
  const handleAddDerivedTextToChat = useCallback((text: string) => {
    sendSelectionToChatInput({ text, sourceName: documentTitle });
  }, [documentTitle]);

  // ---------------------------------------------------------------- 跨插件摘录（拖拽 / 划选即入图）
  // 选区稳定时立刻快照（页码 + 归一化包围盒 + 文本）：按下拖拽胶囊时浏览器可能已折叠 DOM 选区，
  // dragstart 只读快照，不依赖实时选区；也从不拦截文本层的 mousedown，原生划词不受影响。
  const interopEnabled = enabled && selectionKind === 'pdf' && Boolean(interopResourceId) && !selectionOverride;
  const snapshotRef = useRef<SelectionExcerptSnapshot | null>(null);
  const [hasDragSnapshot, setHasDragSnapshot] = useState(false);

  const captureSelectionSnapshot = useCallback((): SelectionExcerptSnapshot | null => {
    const container = containerRef.current;
    const domSelection = window.getSelection();
    if (!container || !domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) return null;
    const range = domSelection.getRangeAt(0);
    const node = range.startContainer;
    const element = node instanceof Element ? node : node.parentElement;
    const pageEl = element?.closest('[data-page-number]');
    if (!pageEl || !container.contains(pageEl)) return null;
    const page = Number.parseInt(pageEl.getAttribute('data-page-number') ?? '', 10);
    if (!Number.isInteger(page) || page < 1) return null;
    const text = normalizeText(domSelection.toString());
    if (text.length < 2) return null;
    const displayRect = typeof range.getClientRects === 'function'
      ? computeNormalizedSelectionBounds(range.getClientRects(), pageEl.getBoundingClientRect())
      : undefined;
    const rect = displayRect && rotateNormalizedRect(displayRect, -Number(pageEl.getAttribute('data-page-rotation') ?? 0));
    return { text, page, ...(rect ? { rect } : {}) };
  }, [containerRef, normalizeText]);

  const buildSnapshotPayload = useCallback((snapshot: SelectionExcerptSnapshot) => {
    const anchor = buildPdfSemanticAnchor({
      resourceId: interopResourceId ?? '',
      aliasResourceId: interopAliasResourceId,
      page: snapshot.page,
      rect: snapshot.rect,
      quote: snapshot.text,
      documentTitle,
    });
    return buildPdfExcerptPayload({ excerptKind: 'text', text: snapshot.text, anchor, documentTitle });
  }, [interopResourceId, interopAliasResourceId, documentTitle]);

  useEffect(() => {
    if (!interopEnabled || !selection.isVisible || !selection.selectedText) {
      // 拖拽进行中保留快照：dragstart 之后选区折叠也不能丢载荷
      if (!sharedPdfExcerptGuard.isDragging()) snapshotRef.current = null;
      setHasDragSnapshot(false);
      return;
    }
    const snapshot = captureSelectionSnapshot();
    snapshotRef.current = snapshot;
    setHasDragSnapshot(Boolean(snapshot));
  }, [
    interopEnabled,
    selection.isVisible,
    selection.selectedText,
    selection.selectionRect,
    captureSelectionSnapshot,
  ]);

  // 仅完成一次真实的页面划词手势才发送；开关、滚动、清选区与工具条重渲染均不发送旧选区。
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !interopEnabled || !autoExcerptActive) return;
    let gesture: { x: number; y: number; text: string } | null = null;
    const inTextLayer = (target: EventTarget | null) => target instanceof Element
      && Boolean(target.closest('.textLayer, .react-pdf__Page__textContent'))
      && !target.closest('button, [data-selection-toolbar], .ds-pdf__margin-backlinks');
    const onDown = (event: MouseEvent) => {
      gesture = event.button === 0 && inTextLayer(event.target)
        ? { x: event.clientX, y: event.clientY, text: window.getSelection()?.toString() ?? '' }
        : null;
    };
    const onUp = (event: MouseEvent) => {
      const start = gesture;
      gesture = null;
      if (!start || event.button !== 0 || !inTextLayer(event.target) || sharedPdfExcerptGuard.isDragging()) return;
      const snapshot = captureSelectionSnapshot();
      if (!snapshot?.rect || Array.from(snapshot.text.replace(/\s/g, '')).length < 2) return;
      if (normalizeText(start.text) === snapshot.text
        && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 3) return;
      const key = pdfAutoExcerptKey(interopResourceId ?? '', snapshot.page, snapshot.text);
      if (!sharedPdfExcerptGuard.shouldEmitAuto(key)) return;
      getAppKernel().dnd.emitAutoExcerpt(buildSnapshotPayload(snapshot));
    };
    container.addEventListener('mousedown', onDown);
    container.addEventListener('mouseup', onUp);
    return () => {
      container.removeEventListener('mousedown', onDown);
      container.removeEventListener('mouseup', onUp);
    };
  }, [containerRef, interopEnabled, autoExcerptActive, captureSelectionSnapshot, normalizeText, interopResourceId, buildSnapshotPayload]);

  const endOwnedDragRef = useRef<(() => void) | null>(null);

  const handleExcerptDragStart = useCallback((event: React.DragEvent<HTMLButtonElement>) => {
    const snapshot = snapshotRef.current ?? captureSelectionSnapshot();
    if (!snapshot) {
      event.preventDefault();
      return;
    }
    endOwnedDragRef.current = sharedPdfExcerptGuard.beginDrag();
    const payload = getAppKernel().dnd.startExcerptDrag(event.nativeEvent, buildSnapshotPayload(snapshot));
    if (!payload) {
      endOwnedDragRef.current?.();
      endOwnedDragRef.current = null;
      event.preventDefault();
      return;
    }
    setCompactDragImage(event.dataTransfer, buildExcerptDragLabel(`P.${snapshot.page}`, snapshot.text));
  }, [captureSelectionSnapshot, buildSnapshotPayload]);

  const handleExcerptDragEnd = useCallback(() => {
    endOwnedDragRef.current?.();
    endOwnedDragRef.current = null;
  }, []);

  useEffect(() => handleExcerptDragEnd, [handleExcerptDragEnd, interopResourceId]);

  const kernel = useOptionalUiKernel();
  const pdfToolbarEntries = useOptionalSlot('pdf.selectionToolbar');
  const reportedPdfToolbarErrorsRef = useRef(new WeakSet<SlotEntry<unknown>>());
  const failedPdfToolbarFilters: Array<{ entry: SlotEntry<PdfSelectionToolbarContribution>; error: unknown }> = [];
  const visiblePdfToolbarEntries = (pdfToolbarEntries ?? []).filter((entry) => {
    try {
      return !entry.value.kinds || entry.value.kinds.includes(selectionKind);
    } catch (error) {
      failedPdfToolbarFilters.push({ entry, error });
      return false;
    }
  });
  useEffect(() => {
    for (const { entry, error } of failedPdfToolbarFilters) {
      if (reportedPdfToolbarErrorsRef.current.has(entry)) continue;
      reportedPdfToolbarErrorsRef.current.add(entry);
      kernel?.errors.report({
        pluginId: entry.owner,
        origin: entry.origin,
        version: entry.version,
        phase: 'filter',
        slot: 'pdf.selectionToolbar',
        entryId: entry.id,
        error,
      });
    }
  });
  const contributedExtraActions: SelectionToolbarExtraAction[] = visiblePdfToolbarEntries.map((entry) => {
    const Icon = entry.value.icon;
    return {
      key: `${entry.owner}:${entry.id}`,
      label: entry.value.label,
      hideLabelOnTouch: Boolean(Icon),
      icon: Icon
        ? ({ touchTarget }) => (
            <SlotEntryScope slot="pdf.selectionToolbar" entry={entry}>
              <Icon size={touchTarget ? 16 : 14} />
            </SlotEntryScope>
          )
        : null,
      run: (rawText) => {
        const page = resolveSelectionPage();
        runSlotCallback(kernel, 'pdf.selectionToolbar', entry, () =>
          entry.value.run({
            text: normalizeText(rawText),
            contextBefore: selection.contextBefore,
            contextAfter: selection.contextAfter,
            ...(page !== undefined ? { page } : {}),
            ...(selectionSourceId ? { resourceId: selectionSourceId } : {}),
            ...(documentTitle ? { documentTitle } : {}),
            kind: selectionKind,
          })
        );
      },
    };
  });

  const builtinExtraActions: SelectionToolbarExtraAction[] = [
    {
      key: 'pdf:append-active-note',
      label: t('pdf:selection.append_to_active_note', { defaultValue: '追加到当前笔记' }),
      hideLabelOnTouch: true,
      icon: ({ touchTarget }) => <FilePlus size={touchTarget ? 16 : 14} />,
      run: handleAppendToActiveNote,
    },
    {
      key: 'pdf:quick-local-card',
      label: t('pdf:selection.quick_card', { defaultValue: '快速闪卡' }),
      hideLabelOnTouch: true,
      icon: ({ touchTarget }) => <Lightning size={touchTarget ? 16 : 14} />,
      run: handleOpenQuickCard,
    },
  ];
  const allExtraActions: SelectionToolbarExtraAction[] = [
    ...builtinExtraActions,
    ...contributedExtraActions,
  ];

  if (!enabled) return null;

  const quickCardOriginText = quickCardState
    ? [
        documentTitle,
        typeof quickCardState.page === 'number' ? `P.${quickCardState.page}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

  const showInlineDragChip = interopEnabled && hasDragSnapshot;
  const unifiedHeaderSlot =
    headerSlot || showInlineDragChip ? (
      <div className="flex w-full flex-wrap items-center justify-between gap-1.5">
        <div className="flex flex-wrap items-center gap-1">{headerSlot}</div>
        {showInlineDragChip && (
          <DsButton
            variant="ghost"
            size="sm"
            draggable
            onDragStart={handleExcerptDragStart}
            onDragEnd={handleExcerptDragEnd}
            data-testid="pdf-excerpt-drag-chip"
            title={t('pdf:interop.drag_excerpt')}
            aria-label={t('pdf:interop.drag_excerpt')}
            className={cn(
              'select-none gap-1 border border-border/40 bg-muted/50 px-2',
              'text-xs text-muted-foreground',
              'cursor-grab hover:bg-muted hover:text-foreground active:cursor-grabbing',
            )}
          >
            <DotsSixVertical size={13} aria-hidden="true" />
            <span>{t('pdf:interop.drag_excerpt')}</span>
          </DsButton>
        )}
      </div>
    ) : undefined;

  return (
    <>
      <SelectionToolbar
        selectedText={selection.selectedText}
        selectionRect={selection.selectionRect}
        isVisible={toolbarVisible}
        containerRef={containerRef}
        onClear={selection.clear}
        onExplain={handleExplain}
        onTranslate={handleTranslate}
        onSaveAsNote={handleSaveAsNote}
        onMakeCards={handleMakeCards}
        onAddToChat={handleAddToChat}
        onAddAsContext={undefined}
        extraActions={allExtraActions}
        headerSlot={unifiedHeaderSlot}
        hideUnavailableActions
        placement="below"
        viewportBottomInset={isMobileLike ? MOBILE_BOTTOM_INSET_PX : 0}
        dismissOnLeaveView={null}
        ariaLabel={t('chatV2:selectionToolbar.ariaLabel')}
        className="z-30"
      />

      {panelOpen && (
        <div
          ref={panelRef}
          className="ds-pdf__selection-panel ui-rise-in border-border/35 bg-popover/95 backdrop-blur-md"
          role="region"
          aria-label={t('chatV2:selectionToolbar.ariaLabel')}
        >
          {/* 解释 / 翻译弹层自带关闭钮，面板不再叠第二个 */}
          <CustomScrollArea className="ds-pdf__selection-panel-body" fullHeight>
            <React.Suspense fallback={null}>
              {explainState !== null && (
                <ExplainPopover
                  sourceText={explainState.text}
                  isVisible
                  academicMode={selectionKind === 'pdf'}
                  contextBefore={explainState.contextBefore}
                  contextAfter={explainState.contextAfter}
                  onClose={closePanel}
                  onAddToInput={handleAddDerivedTextToChat}
                  onSaveToAnnotation={
                    onPinToAnnotation
                      ? (noteText) =>
                          onPinToAnnotation({
                            sourceText: explainState.text,
                            noteText,
                            page: explainState.page,
                          })
                      : undefined
                  }
                />
              )}
              {translateState !== null && (
                <TranslationPopover
                  sourceText={translateState.text}
                  isVisible
                  contextBefore={translateState.contextBefore}
                  contextAfter={translateState.contextAfter}
                  onClose={closePanel}
                  onAddToInput={handleAddDerivedTextToChat}
                  onSaveToAnnotation={
                    onPinToAnnotation
                      ? (noteText) =>
                          onPinToAnnotation({
                            sourceText: translateState.text,
                            noteText,
                            page: translateState.page,
                          })
                      : undefined
                  }
                  showModelName={false}
                />
              )}
              {quickCardState !== null && (
                <div
                  data-testid="pdf-quick-card-popover"
                  className="flex flex-col gap-2.5 p-3 text-xs text-foreground"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      closePanel();
                    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      e.stopPropagation();
                      void handleSubmitQuickCard();
                    }
                  }}
                >
                  <div className="flex items-center justify-between gap-2 border-b border-border/40 pb-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <Lightning size={14} className="shrink-0 text-primary" aria-hidden="true" />
                      <span className="font-semibold text-sm truncate">
                        {t('pdf:selection.quick_card_title', { defaultValue: '快速闪卡（本地）' })}
                      </span>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <div
                        className="inline-flex rounded-md border border-border/50 bg-muted/40 p-0.5"
                        role="group"
                        aria-label={t('pdf:selection.quick_card', { defaultValue: '快速闪卡' })}
                      >
                        <DsButton
                          variant="ghost"
                          size="sm"
                          data-testid="pdf-quick-card-mode-basic"
                          aria-pressed={quickCardState.mode === 'basic'}
                          onClick={() =>
                            setQuickCardState((prev) =>
                              prev ? { ...prev, mode: 'basic', error: null } : null,
                            )
                          }
                          className={cn(
                            '!h-6 !px-2 text-xs font-medium',
                            quickCardState.mode === 'basic'
                              ? 'bg-background text-foreground shadow-xs'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {t('pdf:selection.quick_card_basic', { defaultValue: '问答卡' })}
                        </DsButton>
                        <DsButton
                          variant="ghost"
                          size="sm"
                          data-testid="pdf-quick-card-mode-cloze"
                          aria-pressed={quickCardState.mode === 'cloze'}
                          onClick={() =>
                            setQuickCardState((prev) =>
                              prev ? { ...prev, mode: 'cloze', error: null } : null,
                            )
                          }
                          className={cn(
                            '!h-6 !px-2 text-xs font-medium',
                            quickCardState.mode === 'cloze'
                              ? 'bg-background text-foreground shadow-xs'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {t('pdf:selection.quick_card_cloze', { defaultValue: '填空卡' })}
                        </DsButton>
                      </div>
                      <DsButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        className="!h-6 !w-6"
                        onClick={closePanel}
                        aria-label={t('pdf:a11y.close')}
                      >
                        <X size={14} />
                      </DsButton>
                    </div>
                  </div>

                  {quickCardState.mode === 'basic' ? (
                    <>
                      <label className="flex flex-col gap-1">
                        <span className="text-2xs font-medium text-muted-foreground">
                          {t('pdf:selection.quick_card_front_label', { defaultValue: '正面（问题）' })}
                        </span>
                        <textarea
                          data-testid="pdf-quick-card-front"
                          rows={2}
                          value={quickCardState.front}
                          onChange={(e) =>
                            setQuickCardState((prev) =>
                              prev ? { ...prev, front: e.target.value, error: null } : null,
                            )
                          }
                          placeholder={t('pdf:selection.quick_card_front_placeholder', {
                            defaultValue: '输入提问或关键词…',
                          })}
                          className="w-full resize-none rounded-md border border-border/50 bg-background/80 px-2.5 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary"
                          autoFocus
                        />
                      </label>
                      <label className="flex flex-col gap-1">
                        <span className="text-2xs font-medium text-muted-foreground">
                          {t('pdf:selection.quick_card_back_label', { defaultValue: '背面（答案 / 摘录）' })}
                        </span>
                        <textarea
                          data-testid="pdf-quick-card-back"
                          rows={3}
                          value={quickCardState.back}
                          onChange={(e) =>
                            setQuickCardState((prev) =>
                              prev ? { ...prev, back: e.target.value, error: null } : null,
                            )
                          }
                          placeholder={t('pdf:selection.quick_card_back_placeholder', {
                            defaultValue: '输入答案或原文摘录…',
                          })}
                          className="w-full resize-none rounded-md border border-border/50 bg-background/80 px-2.5 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary"
                        />
                      </label>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-2xs font-medium text-muted-foreground">
                            {t('pdf:selection.quick_card_cloze_label', {
                              defaultValue: '填空文本（使用 {{c1::...}} 标记挖空）',
                            })}
                          </span>
                          <DsButton
                            variant="ghost"
                            size="sm"
                            data-testid="pdf-quick-card-wrap-cloze"
                            onClick={handleWrapCloze}
                            className="!h-6 !px-2 text-2xs text-primary"
                          >
                            {t('pdf:selection.quick_card_wrap_cloze', { defaultValue: '设为填空' })}
                          </DsButton>
                        </div>
                        <textarea
                          ref={clozeTextareaRef}
                          data-testid="pdf-quick-card-cloze"
                          rows={3}
                          value={quickCardState.clozeText}
                          onChange={(e) =>
                            setQuickCardState((prev) =>
                              prev ? { ...prev, clozeText: e.target.value, error: null } : null,
                            )
                          }
                          placeholder={t('pdf:selection.quick_card_cloze_placeholder', {
                            defaultValue: '选中文字后点击「设为填空」…',
                          })}
                          className="w-full resize-none rounded-md border border-border/50 bg-background/80 px-2.5 py-1.5 text-xs leading-relaxed text-foreground outline-none focus:border-primary"
                          autoFocus
                        />
                      </div>
                      <label className="flex flex-col gap-1">
                        <span className="text-2xs font-medium text-muted-foreground">
                          {t('pdf:selection.quick_card_extra_label', { defaultValue: '补充说明（可选）' })}
                        </span>
                        <input
                          type="text"
                          data-testid="pdf-quick-card-extra"
                          value={quickCardState.clozeExtra}
                          onChange={(e) =>
                            setQuickCardState((prev) =>
                              prev ? { ...prev, clozeExtra: e.target.value, error: null } : null,
                            )
                          }
                          placeholder={t('pdf:selection.quick_card_extra_placeholder', {
                            defaultValue: '补充理解或例子（来源回链会自动附带）…',
                          })}
                          className="w-full rounded-md border border-border/50 bg-background/80 px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary"
                        />
                      </label>
                    </>
                  )}

                  {quickCardOriginText && (
                    <div
                      data-testid="pdf-quick-card-origin"
                      className="truncate text-2xs text-muted-foreground"
                    >
                      {t('pdf:selection.quick_card_origin_badge', {
                        origin: quickCardOriginText,
                        defaultValue: '来源回链：{{origin}}',
                      })}
                    </div>
                  )}

                  {quickCardState.error && (
                    <div
                      role="alert"
                      data-testid="pdf-quick-card-error"
                      className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-2xs text-destructive"
                    >
                      {quickCardState.error}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-1.5 border-t border-border/40 pt-2">
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={closePanel}
                      disabled={quickCardState.submitting}
                    >
                      {t('pdf:selection.quick_card_cancel', { defaultValue: '取消' })}
                    </DsButton>
                    <DsButton
                      variant="primary"
                      size="sm"
                      data-testid="pdf-quick-card-submit"
                      disabled={quickCardState.submitting}
                      onClick={() => void handleSubmitQuickCard()}
                      className="gap-1"
                    >
                      <Check size={13} aria-hidden="true" />
                      <span>
                        {quickCardState.submitting
                          ? t('pdf:selection.quick_card_creating', { defaultValue: '创建中…' })
                          : t('pdf:selection.quick_card_create', { defaultValue: '创建闪卡' })}
                      </span>
                    </DsButton>
                  </div>
                </div>
              )}
            </React.Suspense>
          </CustomScrollArea>
        </div>
      )}

      {appendFeedback && (
        <div
          role="status"
          aria-live="polite"
          data-testid="pdf-append-note-feedback"
          className={cn(
            'absolute right-3 z-40 flex max-w-[calc(100%-24px)] items-center gap-1.5',
            'rounded-lg border border-border/50 bg-popover/95 px-2.5 py-1.5 text-xs text-popover-foreground shadow-md backdrop-blur-md',
          )}
          style={{
            bottom:
              'calc(var(--ds-pdf-toolbar-h, 40px) + var(--ds-pdf-progress-h, 3px) + var(--ds-pdf-safe-bottom, 0px) + 10px)',
          }}
        >
          <span className="truncate">
            {t('pdf:selection.appended_to_active_note', {
              title: appendFeedback.title,
              defaultValue: '已追加到当前笔记「{{title}}」',
            })}
          </span>
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="pdf-append-note-view"
            className="!h-6 shrink-0 gap-1 !px-2 text-xs text-primary"
            onClick={() => {
              appendFeedback.openNote();
              dismissAppendFeedback();
            }}
          >
            <ArrowSquareOut size={12} aria-hidden="true" />
            <span>{t('pdf:selection.view_note', { defaultValue: '查看笔记' })}</span>
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            data-testid="pdf-append-note-undo"
            disabled={appendFeedback.undoing}
            className="!h-6 shrink-0 gap-1 !px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleUndoAppendFeedback}
          >
            <ArrowCounterClockwise size={12} aria-hidden="true" />
            <span>{t('pdf:selection.undo_append', { defaultValue: '撤销' })}</span>
          </DsButton>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="!h-5 !w-5 shrink-0"
            onClick={dismissAppendFeedback}
            aria-label={t('pdf:a11y.close')}
          >
            <X size={12} />
          </DsButton>
        </div>
      )}

      <SaveAsNoteFolderPicker {...saveAsNoteFlow.pickerProps} />
    </>
  );
};

export default PdfSelectionActions;
