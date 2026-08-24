/**
 * Chat V2 — Generative UI 块渲染插件
 *
 * toolOutput.intent 携带结构化 UI 意图，由 GenerativeUIRenderer 渲染。
 * actionHandlers 从 modeState.canvasNoteId + toolInput.noteEdit 注入 Notes HITL 链。
 * researchSessionId / Research 块触发 HPIAS 事件桥 + 实时研究面板。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  extractGenerativeUIIntent,
  GENERATIVE_UI_BLOCK_TYPE,
} from '@/features/generative-ui/bridge/chatBlockBridge';
import {
  intentHasResearchBlocks,
  omitResearchBlocksFromIntent,
} from '@/features/generative-ui/bridge/hpiasEventBridge';
import { resolveGenerativeUIChatActionHandlers } from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';
import { HpiasGenerativeResearchPanel } from '@/features/generative-ui/components/HpiasGenerativeResearchPanel';
import { useHpiasEventBridge } from '@/features/generative-ui/hooks/useHpiasEventBridge';
import { extractResearchSessionId } from '@/features/generative-ui/utils/extractResearchSessionId';
import { getCanvasNoteIdFromModeState } from '@/features/chat/adapters/tauri/requestHelpers';
import { useHpiasStore } from '@/stores/researchStore';

function readIntentQuestion(intent: unknown): string | undefined {
  if (!intent || typeof intent !== 'object') return undefined;
  const meta = (intent as { meta?: { title?: string; description?: string } }).meta;
  return meta?.title ?? meta?.description;
}

function GenerativeUIBlockComponent({ block, isStreaming, store }: BlockComponentProps) {
  const { t } = useTranslation('generativeUi');
  const canvasNoteId = getCanvasNoteIdFromModeState(store?.getState().modeState ?? null);

  const extracted = extractGenerativeUIIntent(
    block.toolOutput,
    block.content,
    block.toolInput,
    block.id,
  );

  const researchSessionId = useMemo(
    () =>
      extractResearchSessionId(
        block.toolInput,
        block.toolOutput,
        extracted && typeof extracted.intent !== 'string' ? extracted.intent : undefined,
      ),
    [block.toolInput, block.toolOutput, extracted],
  );

  const shouldBridgeHpias = useMemo(() => {
    if (researchSessionId) return true;
    if (!extracted || typeof extracted.intent === 'string') return false;
    return intentHasResearchBlocks(extracted.intent);
  }, [extracted, researchSessionId]);

  useHpiasEventBridge({
    enabled: shouldBridgeHpias && !isStreaming,
    sessionId: researchSessionId,
  });

  const hpiasSessionId = useHpiasStore((s) => s.sessionId);
  const showLiveResearch =
    shouldBridgeHpias &&
    !!hpiasSessionId &&
    (!researchSessionId || hpiasSessionId === researchSessionId);

  const displayIntent = useMemo(() => {
    if (!extracted) return null;
    if (typeof extracted.intent === 'string') return extracted.intent;
    if (!showLiveResearch) return extracted.intent;
    const filtered = omitResearchBlocksFromIntent(extracted.intent);
    return filtered.blocks.length > 0 ? filtered : null;
  }, [extracted, showLiveResearch]);

  const researchQuestion = useMemo(() => {
    if (!extracted || typeof extracted.intent === 'string') return undefined;
    return readIntentQuestion(extracted.intent);
  }, [extracted]);

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
    <div className="space-y-3" data-block-type={GENERATIVE_UI_BLOCK_TYPE}>
      {shouldBridgeHpias && (
        <HpiasGenerativeResearchPanel
          showChrome={!isStreaming}
          question={researchQuestion}
        />
      )}
      {displayIntent != null && (
        <GenerativeUIRenderer
          intent={displayIntent}
          isStreaming={isStreaming ?? extracted.isStreaming}
          showChrome={!isStreaming && !showLiveResearch}
          actionHandlers={actionHandlers}
        />
      )}
    </div>
  );
}

blockRegistry.register(GENERATIVE_UI_BLOCK_TYPE, {
  type: GENERATIVE_UI_BLOCK_TYPE,
  component: GenerativeUIBlockComponent,
  onAbort: 'keep-content',
});

export { GenerativeUIBlockComponent };
