// Rust: chatanki_executor.rs:13817–14210 status snapshot and workflow projection.
import type { AnkiCard, DocumentTask, TaskStatus } from '../api.ts';
import { now, nowEpochNanos } from '../../../platform/time/index.ts';
import { f32ToJsonNumber } from '../../../platform/util/f32-json.ts';
import { rustTrim } from '../../../platform/util/text.ts';

// ============================================================================
// Status snapshot / workflow projection (chatanki_executor.rs:13817–14210)
// ============================================================================

export const GLOBAL_CARD_LIMIT_MARKER = 'GLOBAL_CARD_LIMIT_REACHED';
export const PIPELINE_CANCELLED_MARKER = 'PIPELINE_CANCELLED_BY_CONTROLLER';

/** dstu-core agent::block_status. */
export const BLOCK_STATUS = { RUNNING: 'running', SUCCESS: 'success', ERROR: 'error' } as const;

export type GenerationTerminalKind = 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';

const IN_FLIGHT_STATUSES: readonly TaskStatus[] = ['Pending', 'Processing', 'Streaming'];
const FAILED_STATUSES: readonly TaskStatus[] = ['Failed', 'Truncated'];

let stateRevision = 0;

/**
 * chatanki_executor.rs:95–104: `Utc::now().timestamp_micros()` (microsecond
 * wall clock, not ms×1000), stored as `max(now, prev + 1)`. Microsecond epoch
 * values stay below 2^53, so number arithmetic is exact here.
 */
export function nextChatankiStateRevision(
  nowMicros: number = Number(nowEpochNanos() / 1000n),
): number {
  stateRevision = Math.max(nowMicros, stateRevision + 1);
  return stateRevision;
}

function isLimitCancelledTask(task: DocumentTask): boolean {
  return task.status === 'Cancelled' && task.error_message === GLOBAL_CARD_LIMIT_MARKER;
}

/** 用户/系统主动取消（排除「按上限完成」）。 */
export function tasksUserCancelled(tasks: readonly DocumentTask[]): boolean {
  return tasks.some((task) => task.status === 'Cancelled' && !isLimitCancelledTask(task));
}

export function tasksLimitReached(tasks: readonly DocumentTask[]): boolean {
  return tasks.some(isLimitCancelledTask);
}

export function generationTerminalStage(kind: GenerationTerminalKind): string {
  switch (kind) {
    case 'completed': return 'completed';
    case 'completed_with_errors': return 'completed_with_errors';
    case 'failed': return 'error';
    case 'cancelled': return 'cancelled';
  }
}

export function classifyGenerationTerminal(
  tasks: readonly DocumentTask[], cards: readonly AnkiCard[],
): GenerationTerminalKind {
  if (tasksUserCancelled(tasks)) return 'cancelled';
  const hasFailed = tasks.some((task) => FAILED_STATUSES.includes(task.status));
  if (!hasFailed) return 'completed';
  const hasSuccessfulSegment = tasks.some((task) => task.status === 'Completed');
  const hasUsableCard = cards.some((card) => !card.is_error_card);
  return hasSuccessfulSegment || hasUsableCard ? 'completed_with_errors' : 'failed';
}

export interface StatusSnapshot {
  status: string;
  error: string | null;
  shouldRetry: boolean;
}

export function deriveStatusSnapshot(
  tasks: readonly DocumentTask[], cards: readonly AnkiCard[],
): StatusSnapshot {
  const paused = tasks.some((task) => task.status === 'Paused');
  const inProgress = tasks.some((task) => IN_FLIGHT_STATUSES.includes(task.status));
  let status: string;
  if (tasks.length === 0 && cards.length === 0) status = 'not_found';
  else if (inProgress) status = 'running';
  else if (paused) status = 'paused';
  else status = generationTerminalStage(classifyGenerationTerminal(tasks, cards));
  return {
    status,
    error: status === 'not_found' ? 'blocks.ankiCards.errors.statusNotFound' : null,
    shouldRetry: status === 'not_found',
  };
}

export interface TaskCounts {
  counts: Record<string, number>;
  completedRatio: number;
}

export function computeTaskCounts(tasks: readonly DocumentTask[]): TaskCounts {
  const counts: Record<string, number> = {
    total: tasks.length, pending: 0, processing: 0, streaming: 0, paused: 0,
    completed: 0, failed: 0, truncated: 0, cancelled: 0,
  };
  for (const task of tasks) {
    const key = task.status.toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const terminal = (counts.completed ?? 0) + (counts.failed ?? 0)
    + (counts.truncated ?? 0) + (counts.cancelled ?? 0);
  return {
    counts,
    // Rust `json!(f32)` under arbitrary_precision keeps f32's shortest decimal (1/3 → 0.33333334).
    completedRatio: tasks.length > 0 ? f32ToJsonNumber(terminal / tasks.length) ?? 0 : 0,
  };
}

export function classifyGenerationIssue(error: string): { code: string; retryable: boolean } {
  const normalized = error.toLowerCase();
  if (normalized.includes('balance is insufficient')
    || normalized.includes('余额不足') || normalized.includes('额度不足')) {
    return { code: 'provider_quota_exhausted', retryable: false };
  }
  if (normalized.includes('403') || normalized.includes('访问被拒绝')) {
    return { code: 'provider_forbidden', retryable: false };
  }
  if (normalized.includes('401') || normalized.includes('api key') || normalized.includes('认证失败')) {
    return { code: 'provider_auth_failed', retryable: false };
  }
  return { code: 'generation_failed', retryable: true };
}

export interface ChatAnkiWorkflowProjection {
  blockStatus: typeof BLOCK_STATUS[keyof typeof BLOCK_STATUS];
  blockError: string | null;
  outputPatch: Record<string, unknown>;
}

export function projectChatankiWorkflow(
  tasks: readonly DocumentTask[],
  cards: readonly AnkiCard[],
  recoveryHint: string | null,
  recoveredCards: number,
): ChatAnkiWorkflowProjection {
  const { counts, completedRatio } = computeTaskCounts(tasks);
  const usableCards = cards.filter((card) => !card.is_error_card).length;
  const hasInFlight = tasks.some((task) => IN_FLIGHT_STATUSES.includes(task.status));
  const isPaused = tasks.some((task) => task.status === 'Paused');
  const terminalKind = classifyGenerationTerminal(tasks, cards);
  const hasGenerationFailure = tasks.some((task) => FAILED_STATUSES.includes(task.status));
  const hasCompletedSegment = tasks.some((task) => task.status === 'Completed');
  const recoveryStatus = hasGenerationFailure && usableCards > 0
    ? recoveryHint ?? (hasCompletedSegment ? 'none' : 'existing_cards')
    : 'none';

  let workflowStatus: string;
  let generationStatus: string;
  let finalStatus: string;
  let blockStatus: ChatAnkiWorkflowProjection['blockStatus'];
  let blockError: string | null;
  if (hasInFlight) {
    [workflowStatus, generationStatus, finalStatus] = ['running', 'running', 'generating'];
    blockStatus = BLOCK_STATUS.RUNNING;
    blockError = null;
  } else if (isPaused) {
    [workflowStatus, generationStatus, finalStatus] = ['paused', 'paused', 'paused'];
    blockStatus = BLOCK_STATUS.RUNNING;
    blockError = null;
  } else {
    switch (terminalKind) {
      case 'completed':
        [workflowStatus, generationStatus, finalStatus] = ['completed', 'completed', 'completed'];
        blockStatus = BLOCK_STATUS.SUCCESS;
        blockError = null;
        break;
      case 'completed_with_errors':
        [workflowStatus, generationStatus, finalStatus] = [
          'completed_with_warnings', hasCompletedSegment ? 'partial' : 'failed', 'completed_with_errors',
        ];
        blockStatus = BLOCK_STATUS.SUCCESS;
        blockError = null;
        break;
      case 'failed':
        [workflowStatus, generationStatus, finalStatus] = ['failed', 'failed', 'error'];
        blockStatus = BLOCK_STATUS.ERROR;
        blockError = 'blocks.ankiCards.errors.generationFailed';
        break;
      case 'cancelled':
        [workflowStatus, generationStatus, finalStatus] = ['cancelled', 'cancelled', 'cancelled'];
        blockStatus = BLOCK_STATUS.SUCCESS;
        blockError = null;
        break;
    }
  }

  const generationErrors = tasks
    .filter((task) => FAILED_STATUSES.includes(task.status))
    .map((task) => (task.error_message == null ? undefined : rustTrim(task.error_message)))
    .filter((error): error is string => typeof error === 'string' && error.length > 0);
  const primaryError = generationErrors[0] ?? null;
  const primaryRetryable = generationErrors
    .some((error) => classifyGenerationIssue(error).retryable);
  const issues = generationErrors.map((error) => {
    const { code, retryable } = classifyGenerationIssue(error);
    return {
      scope: 'generation', code, severity: usableCards > 0 ? 'warning' : 'error',
      retryable, recovered: usableCards > 0, detail: error,
    };
  });
  const wasRecovered = workflowStatus === 'completed_with_warnings' && recoveryStatus !== 'none';
  const warnings = workflowStatus === 'completed_with_warnings'
    ? [{
      code: wasRecovered ? 'generation_recovered' : 'partial_generation',
      messageKey: wasRecovered
        ? 'blocks.ankiCards.warnings.generationRecovered'
        : 'blocks.ankiCards.progress.messages.completedWithErrors',
      messageParams: { count: usableCards, recovered: recoveredCards },
    }]
    : [];
  const isError = blockStatus === BLOCK_STATUS.ERROR;

  return {
    blockStatus,
    blockError,
    outputPatch: {
      schemaVersion: 2,
      stateRevision: nextChatankiStateRevision(),
      workflowStatus,
      generationStatus,
      deliveryStatus: usableCards > 0 ? 'ready' : 'empty',
      recoveryStatus,
      availableCards: usableCards,
      recoveredCards,
      status: finalStatus,
      finalStatus,
      finalError: isError ? primaryError : null,
      error: isError ? primaryError : null,
      shouldRetry: hasGenerationFailure && primaryRetryable,
      issues,
      warnings,
      progress: {
        stage: finalStatus,
        messageKey: workflowStatus === 'completed_with_warnings'
          ? (wasRecovered
            ? 'blocks.ankiCards.progress.messages.recovered'
            : 'blocks.ankiCards.progress.messages.completedWithErrors')
          : null,
        messageParams: workflowStatus === 'completed_with_warnings'
          ? { count: usableCards }
          : null,
        cardsGenerated: usableCards,
        counts,
        completedRatio,
        lastUpdatedAt: now().rfc3339,
      },
    },
  };
}
