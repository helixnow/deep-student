/**
 * Chat V2 — Generative UI 块渲染插件
 *
 * toolOutput.intent 携带结构化 UI 意图，由 GenerativeUIRenderer 渲染。
 * actionHandlers 从 modeState.canvasNoteId + toolInput.noteEdit 注入 Notes HITL 链。
 * 合法 researchSessionId 才触发 HPIAS 事件桥 + 实时研究面板。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { StoreApi } from 'zustand';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import type { Block, ChatStore } from '../../core/types';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import {
  extractGenerativeUIIntent,
  extractPreparingGenerativeUIIntent,
  GENERATIVE_UI_BLOCK_TYPE,
} from '@/features/generative-ui/bridge/chatBlockBridge';
import {
  dismissGenuiAnswer,
  listPendingGenuiAnswers,
  submitGenuiAnswer,
} from '@/features/generative-ui/bridge/genuiInteractionApi';
import { readGenerativeUIInteraction } from '@/features/generative-ui/interaction/readInteraction';
import type {
  GenerativeUIAnswerPayload,
  GenerativeUIInteractionBinding,
  GenerativeUISubmitOutcome,
} from '@/features/generative-ui/interaction/types';
import type { GenerativeUIIntent } from '@/features/generative-ui/types';
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

const EMPTY_STREAMING_INTENT: GenerativeUIIntent = { version: '1', blocks: [] };

const noopSubscribe = () => () => {};

/** 订阅会话流状态（判定 live 等待是否可作答） */
function useSessionStatus(store: StoreApi<ChatStore> | undefined): string {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => store?.getState().sessionStatus ?? 'idle',
    () => store?.getState().sessionStatus ?? 'idle',
  );
}

/**
 * awaitAnswer 交互绑定（方案 2.4–2.6）：
 * - readGenerativeUIInteraction 判定状态；needsPendingCheck 时调一次 list_pending（按 toolCallId 只查一次）；
 * - onSubmit / onSkip 调 Tauri 命令；accepted / expired 之后同一 toolCallId 不再重复 IPC。
 * 非 await 块返回 undefined。
 */
function useGenerativeUIInteractionBinding(
  block: Block,
  store: StoreApi<ChatStore> | undefined,
): GenerativeUIInteractionBinding | undefined {
  const sessionStatus = useSessionStatus(store);
  const sessionId = store?.getState().sessionId ?? '';
  const [pendingCheck, setPendingCheck] = useState<{ toolCallId: string; live: boolean } | null>(null);
  const checkedToolCallIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const settledRef = useRef<{ toolCallId: string; outcome: Promise<GenerativeUISubmitOutcome> } | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const base = readGenerativeUIInteraction(block, { sessionStatus });
  const toolCallId = base?.toolCallId;
  const livePending =
    pendingCheck && toolCallId && pendingCheck.toolCallId === toolCallId ? pendingCheck.live : null;
  const read =
    base && base.needsPendingCheck && livePending !== null
      ? readGenerativeUIInteraction(block, { sessionStatus, livePending })
      : base;
  const needsPendingCheck = Boolean(base?.needsPendingCheck && toolCallId && livePending === null);

  useEffect(() => {
    if (!needsPendingCheck || !toolCallId || !sessionId) return;
    if (checkedToolCallIdRef.current === toolCallId) return;
    checkedToolCallIdRef.current = toolCallId;
    listPendingGenuiAnswers(sessionId)
      .then((ids) => ids.includes(toolCallId))
      .catch((error: unknown) => {
        console.warn('[GenerativeUI] list pending answers failed:', error);
        return false;
      })
      .then((live) => {
        if (mountedRef.current) setPendingCheck({ toolCallId, live });
      });
  }, [needsPendingCheck, sessionId, toolCallId]);

  const onSubmit = useCallback(
    (payload: GenerativeUIAnswerPayload): Promise<GenerativeUISubmitOutcome> => {
      if (!toolCallId || !sessionId) return Promise.resolve('expired');
      const settled = settledRef.current;
      if (settled && settled.toolCallId === toolCallId) return settled.outcome;
      const outcome = submitGenuiAnswer(sessionId, toolCallId, payload);
      const entry = { toolCallId, outcome };
      settledRef.current = entry;
      // 校验失败 / IPC 失败允许重提；accepted / expired 锁定（后端只消费一次）
      outcome.then(
        (result) => {
          if (typeof result === 'object' && settledRef.current === entry) settledRef.current = null;
        },
        () => {
          if (settledRef.current === entry) settledRef.current = null;
        },
      );
      return outcome;
    },
    [sessionId, toolCallId],
  );

  const onSkip = useCallback(async (): Promise<void> => {
    if (!toolCallId || !sessionId) return;
    await dismissGenuiAnswer(sessionId, toolCallId, 'skipped');
  }, [sessionId, toolCallId]);

  const state = read?.state;
  const canSubmit = read?.canSubmit ?? false;
  const reason = read?.reason;
  const answered = read?.answered;

  return useMemo<GenerativeUIInteractionBinding | undefined>(() => {
    if (!state) return undefined;
    return {
      state,
      canSubmit,
      ...(answered ? { answered } : {}),
      ...(reason ? { reason } : {}),
      ...(canSubmit ? { onSubmit, onSkip } : {}),
    };
  }, [answered, canSubmit, onSkip, onSubmit, reason, state]);
}

function GenerativeUIBlockComponent({ block, isStreaming, store }: BlockComponentProps) {
  const { t } = useTranslation('generativeUi');
  const exportMarkdownLabels = useMemo(() => buildExportMarkdownI18nLabels(t), [t]);
  const canvasNoteId = getCanvasNoteIdFromModeState(store?.getState().modeState ?? null);
  const interaction = useGenerativeUIInteractionBinding(block, store);

  // preparing：content 是 render_generative_ui 的原始参数增量，截取 intent 流式预览；
  // 执行器 start 前（或 start 后完整 intent chunk 到达前）用空意图显示流式骨架。
  const extracted = useMemo(
    () =>
      block.isPreparing
        ? extractPreparingGenerativeUIIntent(block.id, block.content)
        : (extractGenerativeUIIntent(block.toolOutput, block.content, block.toolInput, block.id) ??
          (block.status === 'running'
            ? { intent: EMPTY_STREAMING_INTENT, isStreaming: true }
            : null)),
    [block.content, block.id, block.isPreparing, block.status, block.toolInput, block.toolOutput],
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
      chatStore: store ?? null,
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
          // 等待作答期间块仍在 activeBlockIds（isStreaming=true），但 intent 已完整：
          // 按非流式渲染，控件由 interaction.canSubmit 决定是否可用。
          isStreaming={
            interaction?.state === 'pending' && !extracted.isStreaming
              ? false
              : (isStreaming ?? extracted.isStreaming)
          }
          showChrome={!isStreaming && !showLiveResearch}
          actionHandlers={actionHandlers}
          interaction={interaction}
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
