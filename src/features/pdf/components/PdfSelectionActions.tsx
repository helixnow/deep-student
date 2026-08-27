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

import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { SelectionToolbar, useTextSelection } from '@/shared/selection';
import { SaveAsNoteFolderPicker, useSaveAsNoteFlow } from '@/shared/notes';
import { buildSelectionNoteContent, type PdfSelectionPayload } from '../pdfSelectionActions';
// 静态导入安全：selectionStudyActions 只依赖 @/events 与 UnifiedNotification
// （均在主 chunk），不会把聊天/cardforge 拉进本组件的懒加载 chunk
import { sendSelectionToChatInput } from '../selectionStudyActions';

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
}

export const PdfSelectionActions: React.FC<PdfSelectionActionsProps> = ({
  containerRef,
  enabled,
  isMobileLike,
  documentTitle,
  onQuoteToChat,
}) => {
  const { t } = useTranslation(['pdf', 'chatV2', 'common']);
  const selection = useTextSelection(containerRef);
  const panelRef = useRef<HTMLDivElement>(null);

  const [explainText, setExplainText] = useState<string | null>(null);
  const [translateState, setTranslateState] = useState<{
    text: string;
    contextBefore: string;
    contextAfter: string;
  } | null>(null);

  const saveAsNoteFlow = useSaveAsNoteFlow({ openSource: 'pdf-selection' });
  const startSaveAsNote = saveAsNoteFlow.start;

  const panelOpen = explainText !== null || translateState !== null;
  const closePanel = useCallback(() => {
    setExplainText(null);
    setTranslateState(null);
  }, []);

  // 📱 Android 返回键：先关结果面板，不要直接退出阅读器。
  // 用共享可见性守卫注册：保活但不可见的 PDF 实例（ViewLayerRenderer
  // keep-alive 隐藏层）若残留打开的面板，不得吞掉活跃页面的返回键。
  React.useEffect(() => {
    if (!panelOpen) return;
    return registerVisibilityGuardedBackHandler(containerRef, () => {
      closePanel();
      return true;
    }, BACK_PRIORITY.overlay);
  }, [panelOpen, closePanel, containerRef]);

  const handleExplain = useCallback((text: string) => {
    setTranslateState(null);
    setExplainText(text);
  }, []);

  const handleTranslate = useCallback((text: string) => {
    setExplainText(null);
    setTranslateState({
      text,
      contextBefore: selection.contextBefore,
      contextAfter: selection.contextAfter,
    });
  }, [selection.contextBefore, selection.contextAfter]);

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

  const handleSaveAsNote = useCallback((text: string) => {
    // 有 fileName + 页码时与链路 A 摘录笔记同一落地格式：
    // 引用块正文 + 来源行「—— 摘自《fileName》第 N 页」（page locator），
    // 标题取摘录首 30 字。documentTitle 由挂载方保证是 fileName 而非资源 ID。
    const page = resolveSelectionPage();
    if (documentTitle && typeof page === 'number') {
      const compactTitle = text.replace(/\s+/g, ' ').trim().slice(0, 30);
      startSaveAsNote({
        content: buildSelectionNoteContent({
          text,
          sourceLabel: t('pdf:selection.note_source', { name: documentTitle, page }),
        }),
        title: compactTitle || documentTitle,
      });
      return;
    }
    // 页码不可得时的降级：至少保留文档名做来源
    startSaveAsNote({
      content: documentTitle ? `> ${documentTitle}\n\n${text}` : text,
    });
  }, [startSaveAsNote, documentTitle, resolveSelectionPage, t]);

  const handleMakeCards = useCallback((text: string) => {
    // 动态 import：selectionCardGeneration 顶层静态依赖 cardforge 的 cardAgent，
    // 只在用户真点「制卡」时才载入，避免 cardforge 打进 PDF 侧 chunk
    const input = {
      selectedText: text,
      contextBefore: selection.contextBefore,
      contextAfter: selection.contextAfter,
      t,
    };
    void import('@/features/chat/services/selectionCardGeneration').then(
      ({ generateCardsFromSelection }) => generateCardsFromSelection(input)
    );
  }, [selection.contextBefore, selection.contextAfter, t]);

  // 工具条「添加到聊天」：优先链路 A 同形的 locator 回调（资源引用 + page，
  // Agent 可回读原文）；无回调或页码不可得时走 PREFILL 包装（先切聊天视图再
  // 注入文本，payload 带 page/sourceName），不派发裸 CHAT_V2_SET_INPUT
  const handleAddToChat = useCallback((text: string) => {
    const page = resolveSelectionPage();
    if (onQuoteToChat && typeof page === 'number') {
      onQuoteToChat({ text, page });
      return;
    }
    sendSelectionToChatInput({ text, sourceName: documentTitle, page });
  }, [onQuoteToChat, documentTitle, resolveSelectionPage]);

  // 解释/翻译结果面板的「添加到输入框」：内容是 AI 生成文本而非原文选区，
  // 不适用 locator 引用语义，固定走 PREFILL 文本注入（此时选区已清，无页码）
  const handleAddDerivedTextToChat = useCallback((text: string) => {
    sendSelectionToChatInput({ text, sourceName: documentTitle });
  }, [documentTitle]);

  if (!enabled) return null;

  return (
    <>
      <SelectionToolbar
        selectedText={selection.selectedText}
        selectionRect={selection.selectionRect}
        isVisible={selection.isVisible && !panelOpen}
        containerRef={containerRef}
        onClear={selection.clear}
        onExplain={handleExplain}
        onTranslate={handleTranslate}
        onSaveAsNote={handleSaveAsNote}
        onMakeCards={handleMakeCards}
        onAddToChat={handleAddToChat}
        hideUnavailableActions
        placement="below"
        viewportBottomInset={isMobileLike ? MOBILE_BOTTOM_INSET_PX : 0}
        dismissOnLeaveView={null}
        ariaLabel={t('chatV2:selectionToolbar.ariaLabel')}
        className="z-[150]"
      />

      {panelOpen && (
        <div
          ref={panelRef}
          className="ds-pdf__selection-panel"
          role="region"
          aria-label={t('chatV2:selectionToolbar.ariaLabel')}
        >
          <div className="ds-pdf__selection-panel-close">
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="ds-btn ds-btn-sm"
              onClick={closePanel}
              aria-label={t('common:close')}
            >
              <X size={16} />
            </DsButton>
          </div>
          <CustomScrollArea className="ds-pdf__selection-panel-body" fullHeight>
            <React.Suspense fallback={null}>
              {explainText !== null && (
                <ExplainPopover
                  sourceText={explainText}
                  isVisible
                  onClose={closePanel}
                  onAddToInput={handleAddDerivedTextToChat}
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
