/**
 * PDF 阅读划词能力接入层。
 *
 * 改造前 PDF 划词只有一条高亮选色条，聊天里已有的「解释 / 翻译 / 保存为笔记 /
 * 生成卡片」在阅读场景完全够不着。这里把共享层的 SelectionToolbar 挂到 PDF 选区上，
 * 复用同一套组件与同一批能力实现，不另起一条平行链路：
 *
 * - 解释 / 翻译 → 复用 chat 的 ExplainPopover / TranslationPopover（两者都只吃
 *   sourceText，不依赖聊天 store）
 * - 保存为笔记 → 复用 @/shared/notes 的目录选择 + 「打开笔记」toast
 * - 生成卡片   → 复用 chat 的 selectionCardGeneration（内部走既有 CardForge 适配器）
 * - 添加到聊天 → 复用全局 CHAT_V2_SET_INPUT（WorkbenchEventBridge 兜底建窗）
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
import { ExplainPopover } from '@/features/chat/components/ExplainPopover';
import { TranslationPopover } from '@/features/chat/components/TranslationPopover';
import { generateCardsFromSelection } from '@/features/chat/services/selectionCardGeneration';
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
  /** 文档标题，用于笔记标题与卡片上下文 */
  documentTitle?: string;
}

export const PdfSelectionActions: React.FC<PdfSelectionActionsProps> = ({
  containerRef,
  enabled,
  isMobileLike,
  documentTitle,
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

  const handleSaveAsNote = useCallback((text: string) => {
    startSaveAsNote({
      content: documentTitle ? `> ${documentTitle}\n\n${text}` : text,
    });
  }, [startSaveAsNote, documentTitle]);

  const handleMakeCards = useCallback((text: string) => {
    void generateCardsFromSelection({
      selectedText: text,
      contextBefore: selection.contextBefore,
      contextAfter: selection.contextAfter,
      t,
    });
  }, [selection.contextBefore, selection.contextAfter, t]);

  const handleAddToChat = useCallback((text: string) => {
    window.dispatchEvent(new CustomEvent('CHAT_V2_SET_INPUT', {
      detail: { content: text, autoSend: false },
    }));
  }, []);

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
            {explainText !== null && (
              <ExplainPopover
                sourceText={explainText}
                isVisible
                onClose={closePanel}
                onAddToInput={handleAddToChat}
              />
            )}
            {translateState !== null && (
              <TranslationPopover
                sourceText={translateState.text}
                isVisible
                contextBefore={translateState.contextBefore}
                contextAfter={translateState.contextAfter}
                onClose={closePanel}
                onAddToInput={handleAddToChat}
              />
            )}
          </CustomScrollArea>
        </div>
      )}

      <SaveAsNoteFolderPicker {...saveAsNoteFlow.pickerProps} />
    </>
  );
};

export default PdfSelectionActions;
