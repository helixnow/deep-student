/**
 * Small pure helpers used while constructing backend requests / reconciling Anki state.
 * Heavy send-option assembly stays on the adapter façade.
 */

/** Session load / history backfill knobs (behavior-preserving constants). */
export const LOAD_SESSION_TAIL_LIMIT = 80;
export const FULL_HISTORY_IDLE_TIMEOUT_MS = 1_000;
export const FULL_HISTORY_MAX_RETRIES = 2;
export const FULL_HISTORY_RETRY_BASE_MS = 500;
/**
 * History backfill page size: aligned with backend chat_v2_load_messages_page default limit.
 */
export const HISTORY_BACKFILL_PAGE_SIZE = 100;
/**
 * Max backfill pages per session open (🚀 2026-09-25 长会话内存窗口化：由 100
 * 收紧到 5 = 500 条）。回填方向为从尾窗起点向更早历史倒序推进；触顶后停止
 * 自动回填（fullHistoryLoadComplete 不置位），更早历史由滚动向上补页按既有
 * 机制续拉。≤500 条消息的会话行为与全量回填完全一致。
 */
export const HISTORY_BACKFILL_MAX_PAGES = 5;

export interface NormalizedChatModelSelection {
  /** Stable/base chat model, usually the session default assignment. */
  modelId: string;
  /** Runtime override picked in the current conversation, when present. */
  model2OverrideId?: string;
  /** The model that should be used for this backend request. */
  effectiveModelId: string;
  modelDisplayName?: string;
}

export function isRetryableTerminalAnkiBlock(
  status: unknown,
  output: Record<string, unknown>,
): boolean {
  const finalStatus = String(output.finalStatus ?? '').trim().toLowerCase();
  const progress = output.progress as Record<string, unknown> | undefined;
  const progressStage = String(progress?.stage ?? '').trim().toLowerCase();
  return (
    status === 'error' ||
    ['error', 'failed', 'completed_with_errors'].includes(finalStatus) ||
    progressStage === 'completed_with_errors'
  );
}

export function getCanvasNoteIdFromModeState(
  modeState: Record<string, unknown> | null,
): string | undefined {
  if (!modeState || typeof modeState !== 'object') {
    return undefined;
  }
  const raw = modeState['canvasNoteId'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}
