/**
 * Chat V2 — Generative UI 块渲染插件
 *
 * toolOutput.intent 携带结构化 UI 意图，由 GenerativeUIRenderer 渲染。
 * actionHandlers 从 modeState.canvasNoteId + toolInput.noteEdit 注入 Notes HITL 链。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  extractGenerativeUIIntent,
  GENERATIVE_UI_BLOCK_TYPE,
} from '@/features/generative-ui/bridge/chatBlockBridge';
import { resolveGenerativeUIChatActionHandlers } from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';
import { getCanvasNoteIdFromModeState } from '@/features/chat/adapters/tauri/requestHelpers';

function GenerativeUIBlockComponent({ block, isStreaming, store }: BlockComponentProps) {
  const { t } = useTranslation('generativeUi');
  const canvasNoteId = getCanvasNoteIdFromModeState(store?.getState().modeState ?? null);

  const extracted = extractGenerativeUIIntent(
    block.toolOutput,
    block.content,
    block.toolInput,
    block.id,
  );

  const actionHandlers = useMemo(() => {
    if (!extracted || typeof extracted.intent === 'string') {
      return undefined;
    }
    return resolveGenerativeUIChatActionHandlers({
      canvasNoteId,
      intent: extracted.intent,
      toolInput: block.toolInput,
      toolOutput: block.toolOutput,
      noteEditLabels: {
        applyEdit: t('notes.edit_apply'),
        dismissSuggestion: t('notes.edit_dismiss'),
      },
      flashcardLabels: {
        saveToLibrary: t('flashcard.save_to_library'),
      },
      flashcardContext: {
        blockId: block.id,
        businessSessionId: store?.getState().sessionId,
      },
    });
  }, [block.id, block.toolInput, block.toolOutput, canvasNoteId, extracted, store, t]);

  if (!extracted) {
    return (
      <div className="text-sm text-muted-foreground px-1" data-block-type={GENERATIVE_UI_BLOCK_TYPE}>
        无 UI 意图数据
      </div>
    );
  }

  return (
    <GenerativeUIRenderer
      intent={extracted.intent}
      isStreaming={isStreaming ?? extracted.isStreaming}
      showChrome={!isStreaming}
      actionHandlers={actionHandlers}
    />
  );
}

blockRegistry.register(GENERATIVE_UI_BLOCK_TYPE, {
  type: GENERATIVE_UI_BLOCK_TYPE,
  component: GenerativeUIBlockComponent,
  onAbort: 'keep-content',
});

export { GenerativeUIBlockComponent };
