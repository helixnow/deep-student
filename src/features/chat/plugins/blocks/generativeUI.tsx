/**
 * Chat V2 — Generative UI 块渲染插件
 *
 * toolOutput.intent 携带结构化 UI 意图，由 GenerativeUIRenderer 渲染。
 * actionHandlers 从 modeState.canvasNoteId + toolInput.noteEdit 注入 Notes HITL 链。
 * 合法 researchSessionId 才触发 HPIAS 事件桥 + 实时研究面板。
 */

import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  extractGenerativeUIIntent,
  GENERATIVE_UI_BLOCK_TYPE,
} from '@/features/generative-ui/bridge/chatBlockBridge';
import { omitResearchBlocksFromIntent } from '@/features/generative-ui/bridge/hpiasEventBridge';
import { resolveGenerativeUIChatActionHandlers } from '@/features/generative-ui/bridge/resolveGenerativeUIChatActionHandlers';
import { HpiasGenerativeResearchPanel } from '@/features/generative-ui/components/HpiasGenerativeResearchPanel';
import { useHpiasEventBridge } from '@/features/generative-ui/hooks/useHpiasEventBridge';
import { extractResearchSessionId } from '@/features/generative-ui/utils/extractResearchSessionId';
import { buildExportMarkdownI18nLabels } from '@/features/generative-ui/utils/buildExportMarkdownI18nLabels';
import { getCanvasNoteIdFromModeState } from '@/features/chat/adapters/tauri/requestHelpers';
import { useHpiasStore } from '@/stores/researchStore';

function readIntentQuestion(intent: unknown): string | undefined {
  if (!intent || typeof intent !== 'object') return undefined;
  const meta = (intent as { meta?: { title?: string; description?: string } }).meta;
  return meta?.title ?? meta?.description;
}

function GenerativeUIBlockComponent({ block, isStreaming, store }: BlockComponentProps) {
  const { t } = useTranslation('generativeUi');
  const exportMarkdownLabels = useMemo(() => buildExportMarkdownI18nLabels(t), [t]);
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

  const shouldBridgeHpias = Boolean(researchSessionId);

  useHpiasEventBridge({
    enabled: shouldBridgeHpias,
    sessionId: researchSessionId ?? undefined,
  });

  const liveSessionSlice = useHpiasStore((s) =>
    researchSessionId ? s.sessions[researchSessionId] : undefined,
  );
  const showLiveResearch = Boolean(
    researchSessionId && liveSessionSlice?.sessionId === researchSessionId,
  );

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
      researchLabels: {
        copyReport: t('research.actions.copy_report'),
        exportPlan: t('research.actions.export_plan'),
        exportIntent: t('research.actions.export_intent'),
      },
      copyIntentLabels: {
        copyIntent: t('action.copy_intent'),
      },
      copyBlockLabels: {
        copyBlock: t('action.copy_block'),
      },
      workbenchLabels: {
        startReview: t('workbench.briefing.start_review'),
        openQbank: t('workbench.briefing.open_qbank'),
        exportPlan: t('research.actions.export_plan'),
        openTaskDashboard: t('workbench.dashboard.open_task_dashboard'),
      },
      intentExportLabels: exportMarkdownLabels.intent,
      researchExportLabels: exportMarkdownLabels.research,
    });
  }, [
    block.id,
    block.toolInput,
    block.toolOutput,
    canvasNoteId,
    exportMarkdownLabels.intent,
    exportMarkdownLabels.research,
    extracted,
    store,
    t,
  ]);

  if (!extracted) {
    return (
      <div className="text-sm text-muted-foreground px-1" data-block-type={GENERATIVE_UI_BLOCK_TYPE}>
        {t('panel.no_intent')}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-block-type={GENERATIVE_UI_BLOCK_TYPE}>
      {shouldBridgeHpias && (
        <HpiasGenerativeResearchPanel
          sessionId={researchSessionId ?? undefined}
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
