/** FSRS-7 memory for the isolated Node desktop profile. */
import { FSRS7Algorithm, FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS } from 'ts-fsrs/models/fsrs-7';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { currentFastStability, ensureFsrs7LogMemoryTable } from '../repository/fsrs-stats.ts';
import { appError } from './errors.ts';
import { MS_PER_DAY, type Fsrs7Curve } from './fsrs-types.ts';
import { scheduleAllRatings, type RatingScheduler } from './review-scheduling.ts';

export const FSRS7_VERSION = 'ts-fsrs-7@6.0.0';
export const fsrs7 = new FSRS7Algorithm(FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS);
export const FSRS7_CURVE = { model: 'fsrs-7' } as const;
const grades = ['again', 'hard', 'good', 'easy'] as const;

// Created only by the trial plugin, after the standard storage migrations.
// The active review log is the source of truth, so undo restores both traces
// by restoring the card snapshot and soft-deleting the undone log atomically.
export function initializeFsrs7(db: SqlExecutor): void {
  ensureFsrs7LogMemoryTable(db);
}

export function fsrs7Curve(stabilityFast: number | null, difficulty: number | null): Fsrs7Curve {
  if (stabilityFast == null || difficulty == null || !(stabilityFast > 0) || !Number.isFinite(difficulty)) {
    throw appError('Database', 'FSRS-7 memory is incomplete');
  }
  return { ...FSRS7_CURVE, stabilityFast, difficulty };
}

export function fsrs7Recall(days: number, stability: number, curve: Fsrs7Curve): number {
  return fsrs7.curve(days, { ...curve, stability }).retrievability;
}

export const scheduleFsrs7: RatingScheduler = (db, before, nowMs, config) => {
  let memory: { stability: number; stabilityFast: number; difficulty: number } | null = null;
  if (before.state !== 0 || before.lastReviewMs !== null || before.reps !== 0) {
    if (before.fsrsParamsVersion !== FSRS7_VERSION || before.lastReviewMs === null || before.stability === null) {
      throw appError('Validation', 'Only cards created or learned in the FSRS-7 trial can be rated');
    }
    const { stabilityFast, difficulty } = fsrs7Curve(currentFastStability(db, before.id), before.difficulty);
    memory = { stability: before.stability, stabilityFast, difficulty };
  }
  if (before.lastReviewMs !== null && nowMs < before.lastReviewMs) throw appError('Validation', 'Review time precedes the last rating');
  const elapsed = before.lastReviewMs === null ? 0 : (nowMs - before.lastReviewMs) / MS_PER_DAY;
  const next = grades.map((_, index) => fsrs7.next_state(memory, elapsed, index + 1));
  const answers = scheduleAllRatings(before, nowMs, config, {
    nextStates(_memory, target) {
      const outcomes = next.map(state => ({ memory: state, interval: fsrs7.next_interval(state, target) }));
      return { again: outcomes[0]!, hard: outcomes[1]!, good: outcomes[2]!, easy: outcomes[3]! };
    },
  });
  return answers.map((outcome, index) => ({ ...outcome, elapsedDays: elapsed, modelVersion: FSRS7_VERSION,
    stabilityFast: next[index]!.stabilityFast }));
};
