// dstu-learning/src/mastery/bias.rs: bounded application-layer bias, not FSRS memory.
export const MASTERY_NEUTRAL_SCORE = 0.5;
export const MASTERY_LOW_THRESHOLD = 0.5;
export const MASTERY_HIGH_THRESHOLD = 0.5;
export const MAX_ADVANCE_FRAC = 0.40;
export const MAX_DELAY_FRAC = 0.15;
export const MAX_ADVANCE_MS = 3 * 86_400_000;
export const MAX_DELAY_MS = 86_400_000;
export const MIN_BIASABLE_INTERVAL_MS = 3_600_000;

export function masteryDueBiasDeltaMs(score: number, intervalMs: number): number {
  score = Math.min(1, Math.max(0, score));
  if (intervalMs < MIN_BIASABLE_INTERVAL_MS) return 0;
  if (score < 0.5) return -Math.min(Math.round(intervalMs * Math.min((0.5 - score) * 0.80, MAX_ADVANCE_FRAC)), MAX_ADVANCE_MS);
  if (score > 0.5) return Math.min(Math.round(intervalMs * Math.min((score - 0.5) * 0.30, MAX_DELAY_FRAC)), MAX_DELAY_MS);
  return 0;
}
export function applyMasteryDueBias(score: number, nowMs: number, dueMs: number): number {
  const interval = dueMs - nowMs;
  if (interval < MIN_BIASABLE_INTERVAL_MS) return dueMs;
  return Math.max(nowMs, dueMs + masteryDueBiasDeltaMs(score, interval));
}
export function masteryQueuePriorityKey(score: number | null, dueMs: number): number {
  if (score === null) return dueMs;
  score = Math.min(1, Math.max(0, score));
  if (score >= 0.5) return dueMs;
  return dueMs - Math.min(2 * 86_400_000, Math.max(0, Math.round((0.5 - score) * 4 * 86_400_000)));
}
export function queueSortKey(state: number, score: number | null, dueMs: number): [number, number] {
  return state === 1 || state === 3 ? [0, dueMs] : [1, masteryQueuePriorityKey(score, dueMs)];
}
