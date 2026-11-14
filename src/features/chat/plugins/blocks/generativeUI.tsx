/**
 * Chat V2 — Generative UI 块渲染插件
 *
 * toolOutput.intent 携带结构化 UI 意图，由 GenerativeUIRenderer 渲染。
 * actionHandlers 从 modeState.canvasNoteId + toolInput.noteEdit 注入 Notes HITL 链。
 * 合法 researchSessionId 才触发 HPIAS 事件桥 + 实时研究面板。
 */

import React, { useCallback, useMemo } from 'react';
import { FolderSimplePlus, PushPinSimple } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { registerArtifactRenderer } from '@/components/previews/artifactRendererRegistry';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { sessionManager } from '../../core/session/sessionManager';
import { useSessionListStore } from '../../stores/sessionListStore';
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
import {
  requestPinArtifactToCanvas,
  usePinnedArtifactStore,
} from '@/stores/pinnedArtifactStore';
import { useHpiasStore } from '@/stores/researchStore';
import { getErrorMessage } from '@/utils/errorUtils';

registerArtifactRenderer('generative-ui', function GenerativeUIPinnedArtifactRenderer({ content }) {
  let resolvedIntent: Parameters<typeof GenerativeUIRenderer>[0]['intent'] = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const inner = record.intent ?? record.spec ?? parsed;
      resolvedIntent = inner as Parameters<typeof GenerativeUIRenderer>[0]['intent'];
    }
  } catch {
    resolvedIntent = content;
  }
  return <GenerativeUIRenderer intent={resolvedIntent} isStreaming={false} showChrome={false} />;
});

function readIntentQuestion(intent: unknown): string | undefined {
  if (!intent || typeof intent !== 'object') return undefined;
  const meta = (intent as { meta?: { title?: string; description?: string } }).meta;
  return meta?.title ?? meta?.description;
}

function GenerativeUIBlockComponent({ block, isStreaming, store }: BlockComponentProps) {
  const { t } = useTranslation('generativeUi');
  const exportMarkdownLabels = useMemo(() => buildExportMarkdownI18nLabels(t), [t]);
  const canvasNoteId = getCanvasNoteIdFromModeState(store?.getState().modeState ?? null);
  const resolvedSessionId =
    store?.getState().sessionId || sessionManager.getCurrentSessionId() || undefined;
  const resolvedGroupId = useSessionListStore((state) =>
    resolvedSessionId
      ? state.sessions.find((session) => session.id === resolvedSessionId)?.groupId
      : undefined,
  );

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

  const serializedArtifactContent = useMemo(() => {
    if (displayIntent == null) return '';
    if (typeof displayIntent === 'string') return displayIntent;
    return JSON.stringify(displayIntent, null, 2);
  }, [displayIntent]);

  const artifactTitle = useMemo(() => {
    if (displayIntent && typeof displayIntent === 'object') {
      const fromMeta = readIntentQuestion(displayIntent)?.trim();
      if (fromMeta) return fromMeta;
    }
    return t('artifact.defaultGenuiTitle');
  }, [displayIntent, t]);

  const artifactWidgetId = `widget-genui-${block.id}`;

  const handlePinToCanvas = useCallback(() => {
    if (!serializedArtifactContent) return;
    requestPinArtifactToCanvas({
      kind: 'generative-ui',
      language: 'json',
      title: artifactTitle,
      content: serializedArtifactContent,
      sourceMessageId: block.messageId || block.id,
      widgetId: artifactWidgetId,
      sessionId: resolvedSessionId,
      groupId: resolvedGroupId,
    });
  }, [
    artifactTitle,
    artifactWidgetId,
    block.id,
    block.messageId,
    resolvedGroupId,
    resolvedSessionId,
    serializedArtifactContent,
  ]);

  const handleSaveToSpace = useCallback(async () => {
    if (!serializedArtifactContent) return;
    try {
      const result = await usePinnedArtifactStore.getState().saveArtifactToStudySpace({
        title: artifactTitle,
        kind: 'generative-ui',
        language: 'json',
        content: serializedArtifactContent,
        sessionId: resolvedSessionId,
        groupId: resolvedGroupId,
      });
      try {
        showGlobalNotification(
          'success',
          result.pinnedToGroup ? t('artifact.savedToSpace') : t('artifact.savedAsNote'),
        );
      } catch {
        // ignore notification errors in headless environments
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      try {
        showGlobalNotification('error', t('artifact.saveFailed', { message }));
      } catch {
        // ignore notification errors in headless environments
      }
    }
  }, [artifactTitle, resolvedGroupId, resolvedSessionId, serializedArtifactContent, t]);

  if (!extracted) {
    return (
      <div className="text-sm text-muted-foreground px-1" data-block-type={GENERATIVE_UI_BLOCK_TYPE}>
        {t('panel.no_intent')}
      </div>
    );
  }

  const effectiveStreaming = Boolean(isStreaming ?? extracted.isStreaming);

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
        <div>
          <GenerativeUIRenderer
            intent={displayIntent}
            isStreaming={effectiveStreaming}
            showChrome={!isStreaming && !showLiveResearch}
            actionHandlers={actionHandlers}
          />
          {!effectiveStreaming && serializedArtifactContent && (
            <div
              className="mt-2 flex items-center justify-end gap-1.5 border-t border-border/35 pt-2"
              data-testid="generative-ui-artifact-actions"
            >
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handlePinToCanvas}
                data-testid="generative-ui-pin-button"
                className="[@media(pointer:coarse)]:!min-h-11"
              >
                <PushPinSimple size={13} />
                <span>{t('artifact.pinToCanvas')}</span>
              </DsButton>
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => void handleSaveToSpace()}
                data-testid="generative-ui-save-space-button"
                className="[@media(pointer:coarse)]:!min-h-11"
              >
                <FolderSimplePlus size={13} />
                <span>{t('artifact.saveToSpace')}</span>
              </DsButton>
            </div>
          )}
        </div>
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
