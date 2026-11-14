// Rust: chatanki_executor.rs:8353–8892, step 4 of run_chatanki_pipeline_background: poll the document's
// tasks and cards every 900ms, stream progress into the anki_cards block, enforce maxCards and the
// idle/total timeouts, then write the terminal block and event.
import type { AnkiCard, DocumentTask } from '../api.ts';
import { convertBackendCard, persistAnkiCardsRunningPatch, persistAnkiCardsTerminalBlock } from './block-patch.ts';
import {
  decidePipelineTimeout, PIPELINE_IDLE_TIMEOUT_MS, PIPELINE_MAX_TOTAL_DURATION_MS,
} from './block-timing.ts';
import { errorText } from './execution.ts';
import { deepMergeValue } from './mutation-target.ts';
import type { BackgroundParams } from './run-pipeline.ts';
import {
  BLOCK_STATUS, classifyGenerationTerminal, computeTaskCounts, GLOBAL_CARD_LIMIT_MARKER,
  generationTerminalStage, projectChatankiWorkflow, tasksLimitReached, tasksUserCancelled,
} from './workflow-status.ts';
import { now } from '../../../platform/time/index.ts';

const POLL_INTERVAL_MS = 900;
const MAX_CARDS_PER_CHUNK = 25;
const PIPELINE_IDLE_TIMEOUT_MARKER = 'PIPELINE_IDLE_TIMEOUT';
const PIPELINE_TOTAL_TIMEOUT_MARKER = 'PIPELINE_TOTAL_TIMEOUT';

function nonFinished(task: DocumentTask, withPaused: boolean): boolean {
  return task.status === 'Pending' || task.status === 'Processing' || task.status === 'Streaming'
    || (withPaused && task.status === 'Paused');
}

export async function pollUntilTerminal(
  params: BackgroundParams, documentId: string, route: string, warnings: Record<string, unknown>[],
  ankiAvailable: boolean | null, ankiError: string | null, debugRef: unknown,
): Promise<void> {
  const { clock } = params;
  const seenCards = new Set<string>();
  let lastCounts: string | null = null;
  let lastRatio: number | null = null;
  const startedAt = clock.monotonicMs();
  let lastProgressAt = clock.monotonicMs();
  let timeoutInfo: Record<string, unknown> | null = null;
  let timeoutTasksMarked = false;
  const globalCardLimit = params.maxCards !== null && params.maxCards > 0 ? params.maxCards : null;
  let limitCancelTriggered = false;
  let pipelineCancelTriggered = false;

  for (;;) {
    if (!pipelineCancelTriggered && params.isCancelled()) {
      pipelineCancelTriggered = true;
      params.warn(`[ChatAnkiToolExecutor] pipeline cancel requested for ${documentId} (kill switch / chat cancel); performing non-destructive cancel`);
      try { await params.generation.cancelDocumentProcessing(documentId); }
      catch (caught) {
        params.warn(`[ChatAnkiToolExecutor] non-destructive cancel failed for ${documentId}: ${errorText(caught)}`);
      }
    }

    const tasks = params.tasks.getTasksForDocument(documentId);
    const cards: AnkiCard[] = params.cards.getCardsForDocument(documentId);
    const counts = computeTaskCounts(tasks);
    const ratio = counts.completedRatio;
    const isPaused = tasks.some((task) => task.status === 'Paused');
    const isInProgress = tasks.some((task) => nonFinished(task, false));
    const hasUserCancelled = tasksUserCancelled(tasks);
    const hasLimitCancelled = tasksLimitReached(tasks);

    if (globalCardLimit !== null && cards.length >= globalCardLimit && isInProgress && !limitCancelTriggered) {
      limitCancelTriggered = true;
      for (const task of tasks) {
        if (task.status === 'Processing' || task.status === 'Streaming') {
          try { await params.generation.cancelStreaming(task.id); }
          catch { /* boundary-allow empty-catch: chatanki_executor.rs:8466 `let _ = streaming.cancel_streaming(…)` */ }
        }
      }
      for (const task of tasks) {
        if (nonFinished(task, true)) {
          try { params.generation.updateTaskStatus(task.id, 'Cancelled', GLOBAL_CARD_LIMIT_MARKER); }
          catch { /* boundary-allow empty-catch: chatanki_executor.rs:8477 `let _ = proc.update_task_status(…)` */ }
        }
      }
    }

    const stage = isInProgress ? 'generating' : isPaused ? 'paused' : hasUserCancelled ? 'cancelled' : 'completed';
    const stageMessageKey = stage === 'paused' ? 'blocks.ankiCards.progress.messages.paused'
      : stage === 'cancelled' ? 'blocks.ankiCards.progress.messages.cancelled'
        : stage === 'completed' && hasLimitCancelled ? 'blocks.ankiCards.progress.messages.limitReached'
          : null;
    const stageMessageParams = stage === 'completed' && hasLimitCancelled ? { limit: globalCardLimit ?? 0 } : null;

    const visibleCardCount = globalCardLimit === null ? cards.length : Math.min(cards.length, globalCardLimit);
    const newCards: Record<string, unknown>[] = [];
    for (const card of cards.slice(0, visibleCardCount)) {
      if (!seenCards.has(card.id)) {
        seenCards.add(card.id);
        newCards.push(convertBackendCard(card));
      }
    }

    const countsChanged = lastCounts === null || lastCounts !== JSON.stringify(counts);
    const ratioChanged = lastRatio === null || Math.abs(lastRatio - ratio) > 0.001;

    if (countsChanged || ratioChanged || newCards.length > 0) {
      const progress = () => ({
        stage,
        route,
        messageKey: stageMessageKey,
        messageParams: stageMessageParams === null ? null : { ...stageMessageParams },
        cardsGenerated: visibleCardCount,
        counts: { ...counts.counts },
        completedRatio: ratio,
        lastUpdatedAt: now().rfc3339,
      });
      const progressPatch = { documentId, progress: progress() };
      for (let cursor = 0; cursor < newCards.length; cursor += MAX_CARDS_PER_CHUNK) {
        params.emitChunk(params.ankiBlockId, {
          documentId,
          cards: newCards.slice(cursor, cursor + MAX_CARDS_PER_CHUNK),
          progress: progress(),
        });
      }
      if (newCards.length === 0) params.emitChunk(params.ankiBlockId, structuredClone(progressPatch));
      persistAnkiCardsRunningPatch(params.blocks, params.messageId, params.ankiBlockId, params.toolName, progressPatch);
      lastCounts = JSON.stringify(counts);
      lastRatio = ratio;
    }

    if (countsChanged || ratioChanged || newCards.length > 0 || isPaused) lastProgressAt = clock.monotonicMs();

    if (isInProgress || isPaused) {
      const idleMs = Math.floor(clock.monotonicMs() - lastProgressAt);
      const totalMs = Math.floor(clock.monotonicMs() - startedAt);
      const kind = decidePipelineTimeout(idleMs, totalMs);
      if (kind !== null) {
        if (timeoutTasksMarked) {
          const errorKey = 'blocks.ankiCards.errors.pipelineTimeout';
          params.warn(`[ChatAnkiToolExecutor] pipeline timeout for ${documentId} did not converge after marking tasks failed; forcing terminal error`);
          if (timeoutInfo !== null) {
            persistAnkiCardsRunningPatch(params.blocks, params.messageId, params.ankiBlockId, params.toolName, { timeout: structuredClone(timeoutInfo) });
          }
          params.emitBlockError(params.ankiBlockId, errorKey);
          persistAnkiCardsTerminalBlock(params.blocks, params.messageId, params.ankiBlockId, params.toolName, BLOCK_STATUS.ERROR, null, errorKey);
          return;
        }
        timeoutTasksMarked = true;
        const reason = kind === 'idle'
          ? `${PIPELINE_IDLE_TIMEOUT_MARKER}: no generation progress for ${Math.floor(idleMs / 1000)}s (limit ${PIPELINE_IDLE_TIMEOUT_MS / 1000}s); unfinished segments marked failed and retryable`
          : `${PIPELINE_TOTAL_TIMEOUT_MARKER}: pipeline exceeded total duration cap of ${PIPELINE_MAX_TOTAL_DURATION_MS / 1000}s; unfinished segments marked failed and retryable`;
        params.warn(`[ChatAnkiToolExecutor] pipeline timeout (${kind}) for ${documentId}: idle=${idleMs}ms total=${totalMs}ms`);
        timeoutInfo = {
          kind,
          idleMs,
          totalMs,
          idleLimitMs: PIPELINE_IDLE_TIMEOUT_MS,
          totalLimitMs: PIPELINE_MAX_TOTAL_DURATION_MS,
          reason,
          at: now().rfc3339,
        };
        for (const task of tasks) {
          if (task.status === 'Processing' || task.status === 'Streaming') {
            try { await params.generation.cancelStreaming(task.id); }
            catch (caught) { params.warn(`[ChatAnkiToolExecutor] timeout cancel_streaming failed for task ${task.id}: ${errorText(caught)}`); }
          }
        }
        for (const task of tasks) {
          if (nonFinished(task, true)) {
            try { params.generation.updateTaskStatus(task.id, 'Failed', reason); }
            catch (caught) { params.warn(`[ChatAnkiToolExecutor] timeout mark-failed failed for task ${task.id}: ${errorText(caught)}`); }
          }
        }
        continue;
      }
    }

    if (!isInProgress && !isPaused) {
      finishGeneration(params, {
        documentId, route, warnings, tasks, cards, visibleCardCount, globalCardLimit, hasUserCancelled,
        hasLimitCancelled, counts: counts.counts, ratio, ankiAvailable, ankiError, debugRef, timeoutInfo,
      });
      return;
    }
    await clock.sleep(POLL_INTERVAL_MS);
  }
}

interface TerminalState {
  documentId: string;
  route: string;
  warnings: Record<string, unknown>[];
  tasks: DocumentTask[];
  cards: AnkiCard[];
  visibleCardCount: number;
  globalCardLimit: number | null;
  hasUserCancelled: boolean;
  hasLimitCancelled: boolean;
  counts: Record<string, number>;
  ratio: number;
  ankiAvailable: boolean | null;
  ankiError: string | null;
  debugRef: unknown;
  timeoutInfo: Record<string, unknown> | null;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** :8713–8885: over-limit warning, `fsrs://changed`, workflow projection, terminal block and event. */
function finishGeneration(params: BackgroundParams, state: TerminalState): void {
  const { cards, visibleCardCount, globalCardLimit, documentId } = state;
  const warnings = state.warnings;
  const hiddenOverLimitCount = Math.max(0, cards.length - visibleCardCount);
  if (cards.length > visibleCardCount) {
    const retained = cards.length - visibleCardCount;
    params.info(`[ChatAnkiToolExecutor] over-limit cards retained / hidden from batch: ${retained} (limit=${globalCardLimit === null ? 'None' : `Some(${globalCardLimit})`}) for ${documentId}`);
    warnings.push({
      code: 'over_limit_cards_retained',
      messageKey: 'blocks.ankiCards.warnings.overLimitCardsRetained',
      messageParams: { count: retained, limit: globalCardLimit ?? 0 },
    });
  }
  const visibleCards = cards.slice(0, visibleCardCount);
  const finalCards = visibleCards.map(convertBackendCard);
  if (!state.hasUserCancelled && finalCards.length > 0) {
    params.emitEvent('fsrs://changed', {
      source: 'agent',
      action: 'cards_persisted',
      entityIds: visibleCards.map((card) => card.id),
      runId: params.ankiBlockId,
    });
  }

  const terminalKind = classifyGenerationTerminal(state.tasks, cards);
  const hasCompleteFailure = terminalKind === 'failed';
  const projection = projectChatankiWorkflow(state.tasks, visibleCards, null, 0);
  const finalStage = generationTerminalStage(terminalKind);
  const finalMessageKey = state.hasUserCancelled ? 'blocks.ankiCards.progress.messages.cancelled'
    : state.hasLimitCancelled ? 'blocks.ankiCards.progress.messages.limitReached' : null;
  const finalMessageParams = !state.hasUserCancelled && state.hasLimitCancelled ? { limit: globalCardLimit ?? 0 } : null;
  const finalErrorKey = state.timeoutInfo !== null && projection.blockStatus === BLOCK_STATUS.ERROR
    ? 'blocks.ankiCards.errors.pipelineTimeout' : projection.blockError;
  let finalOutput: Record<string, unknown> = {
    cards: finalCards,
    documentId,
    templateId: params.templateId,
    templateIds: params.templateIds,
    templateMode: params.templateMode,
    syncStatus: 'pending',
    businessSessionId: params.sessionId,
    messageStableId: params.messageId,
    options: {
      deck_name: params.deckName,
      note_type: params.noteType,
      template_id: params.templateId,
      template_ids: params.templateIds,
      template_mode: params.templateMode,
      enable_images: false,
      max_cards_per_source: 0,
    },
    warnings: structuredClone(warnings),
    status: finalStage,
    limitReached: state.hasLimitCancelled,
    hiddenOverLimitCount,
    progress: {
      stage: finalStage,
      route: state.route,
      messageKey: finalMessageKey,
      messageParams: finalMessageParams,
      cardsGenerated: visibleCardCount,
      counts: state.counts,
      completedRatio: state.ratio,
      lastUpdatedAt: now().rfc3339,
    },
    ankiConnect: { available: state.ankiAvailable, error: state.ankiError, checkedAt: now().rfc3339 },
    debug: params.debugEnabled ? state.debugRef : null,
  };
  finalOutput = deepMergeValue(finalOutput, structuredClone(projection.outputPatch)) as Record<string, unknown>;
  const combined = [...warnings];
  const projected = projection.outputPatch.warnings;
  if (Array.isArray(projected)) {
    for (const warning of projected) {
      if (!combined.some((existing) => sameJson(existing, warning))) combined.push(structuredClone(warning) as Record<string, unknown>);
    }
  }
  finalOutput.warnings = combined;
  if (state.hasLimitCancelled) {
    const progress = finalOutput.progress as Record<string, unknown>;
    progress.messageKey = finalMessageKey;
    progress.messageParams = finalMessageParams;
  }
  if (state.timeoutInfo !== null) finalOutput.timeout = structuredClone(state.timeoutInfo);

  persistAnkiCardsTerminalBlock(
    params.blocks, params.messageId, params.ankiBlockId, params.toolName, projection.blockStatus,
    structuredClone(finalOutput), finalErrorKey,
  );
  if (hasCompleteFailure) {
    params.emitChunk(params.ankiBlockId, structuredClone(finalOutput));
    params.emitBlockError(params.ankiBlockId, finalErrorKey ?? 'blocks.ankiCards.errors.generationFailed');
  } else {
    params.emitBlockEnd(params.ankiBlockId, finalOutput);
  }
}
