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
import { DotsSixVertical } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import { cn } from '@/utils/cn';
import { SelectionToolbar, useTextSelection, type TextSelectionState } from '@/shared/selection';
import type { SelectionSourceKind } from '@/features/chat/context/selectionRef';
import '../styles/selection-panel.css';
import { SaveAsNoteFolderPicker, truncateNoteTitle, useSaveAsNoteFlow } from '@/shared/notes';
import { normalizePdfAcademicText } from '../pdfAcademicText';
import { buildSelectionNoteContent, type PdfSelectionPayload } from '../pdfSelectionActions';
import { buildAnnotationSourceLine } from '../pdfAnnotationList';
// 静态导入安全：selectionStudyActions 只依赖 @/events 与 UnifiedNotification
// （均在主 chunk），不会把聊天/cardforge 拉进本组件的懒加载 chunk
import { sendSelectionToChatInput } from '../selectionStudyActions';
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
}

interface SelectionExcerptSnapshot {
  text: string;
  page: number;
  rect?: { x: number; y: number; w: number; h: number };
}

/** 拖拽胶囊宽度估计（夹在容器内） */
const DRAG_CHIP_WIDTH_PX = 96;

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

  const saveAsNoteFlow = useSaveAsNoteFlow({ openSource: 'pdf-selection' });
  const startSaveAsNote = saveAsNoteFlow.start;

  const panelOpen = explainState !== null || translateState !== null;
  // 面板打开后原选区仍在，工具条让位；但读者接着选了另一段时要能直接再解释 / 翻译，
  // 不必先手动关面板（新动作会替换面板内容）
  const panelSourceText = explainState?.text ?? translateState?.text ?? null;
  const normalizedSelectedText = selection.selectedText ? normalizeText(selection.selectedText) : '';
  const toolbarVisible =
    selection.isVisible && (!panelOpen || normalizedSelectedText !== panelSourceText);
  const closePanel = useCallback(() => {
    setExplainState(null);
    setTranslateState(null);
  }, []);

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
    // 页码不可得时的降级：至少保留文档名做来源
    startSaveAsNote({
      content: documentTitle ? `> ${documentTitle}\n\n${text}` : text,
    });
  }, [normalizeText, startSaveAsNote, documentTitle, resolveSelectionPage, t, selectionSourceId]);

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
  const [dragChipPos, setDragChipPos] = useState<{ top: number; left: number } | null>(null);

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
      setDragChipPos(null);
      return;
    }
    const snapshot = captureSelectionSnapshot();
    snapshotRef.current = snapshot;
    const container = containerRef.current;
    const rect = selection.selectionRect;
    if (!snapshot || !container || !rect) {
      setDragChipPos(null);
      return;
    }
    // 胶囊贴在选区右侧（放不下翻到左侧，都放不下才落到右上角）：
    // 上方是高亮选色菜单，下方是共享划词工具条，两侧不与任何一个重叠
    const outer = container.getBoundingClientRect();
    const rightSide = rect.left + rect.width - outer.left + 6;
    const leftSide = rect.left - outer.left - DRAG_CHIP_WIDTH_PX - 6;
    const top = Math.max(4, rect.top - outer.top);
    if (rightSide + DRAG_CHIP_WIDTH_PX <= outer.width - 4) {
      setDragChipPos({ top, left: rightSide });
    } else if (leftSide >= 4) {
      setDragChipPos({ top, left: leftSide });
    } else {
      setDragChipPos({
        top: Math.max(4, rect.top - outer.top - 30),
        left: Math.max(4, outer.width - DRAG_CHIP_WIDTH_PX - 4),
      });
    }

  }, [
    interopEnabled,
    selection.isVisible,
    selection.selectedText,
    selection.selectionRect,
    captureSelectionSnapshot,
    containerRef,
    autoExcerptActive,
    interopResourceId,
    buildSnapshotPayload,
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

  if (!enabled) return null;

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
        hideUnavailableActions
        placement="below"
        viewportBottomInset={isMobileLike ? MOBILE_BOTTOM_INSET_PX : 0}
        dismissOnLeaveView={null}
        ariaLabel={t('chatV2:selectionToolbar.ariaLabel')}
               className="z-30"
      />

      {interopEnabled && toolbarVisible && dragChipPos && (
        <div
          // 与共享工具条同一标记：按下胶囊不被 useTextSelection 视为「点空白清选区」
          data-selection-toolbar=""
          className="absolute z-30"
          style={{ top: dragChipPos.top, left: dragChipPos.left }}
        >
          <button
            type="button"
            draggable
            onDragStart={handleExcerptDragStart}
            onDragEnd={handleExcerptDragEnd}
            data-testid="pdf-excerpt-drag-chip"
            title={t('pdf:interop.drag_excerpt')}
            aria-label={t('pdf:interop.drag_excerpt')}
            className={cn(
              'inline-flex h-6 select-none items-center gap-1 rounded-full border border-border/35 bg-card/95 px-2',
              'text-[11px] text-muted-foreground shadow-sm backdrop-blur-sm transition-colors',
              'cursor-grab hover:text-foreground active:cursor-grabbing',
            )}
          >
            <DotsSixVertical size={14} aria-hidden="true" />
            <span>{t('pdf:interop.drag_excerpt')}</span>
          </button>
        </div>
      )}

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
            </React.Suspense>
          </CustomScrollArea>
        </div>
      )}

      <SaveAsNoteFolderPicker {...saveAsNoteFlow.pickerProps} />
    </>
  );
};

export default PdfSelectionActions;
