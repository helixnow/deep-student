/**
 * FSRS 调度结果与掌握度偏置（拆分自 `review.ts`）。
 *
 * 只负责把 `fsrs-scheduler.ts` 的答案转换为命令结果使用的 due/interval 形状；
 * 状态读写仍由 `FsrsReviewService` 与其仓储完成。
 */
import { CommandError } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { appError } from './errors.ts';
import { applyMasteryDueBias } from './bias.ts';
import {
  buildFsrs, fuzzFactorFor, learningDueMs, logicalDaysBetween, schedule, sanitizeSteps,
  type CardSnapshot, type MemoryState, type ScheduledAnswer, type SchedulerContext,
} from './fsrs-scheduler.ts';
import {
  MS_PER_DAY,
  type FsrsCardState, type FsrsDueCard, type FsrsSchedulerConfig,
} from './fsrs-types.ts';

function toPhase(state: number): CardSnapshot['phase'] {
  return state === 0 ? 'new' : state === 1 ? 'learning' : state === 2 ? 'review' : 'relearning';
}

function fromPhase(phase: CardSnapshot['phase']): number {
  return phase === 'new' ? 0 : phase === 'learning' ? 1 : phase === 'review' ? 2 : 3;
}

export interface ScheduleOutcome {
  state: number;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  elapsedDays: number;
  dueMs: number;
  reps: number;
  lapses: number;
  learningStep: number;
  modelVersion?: string;
  stabilityFast?: number;
}

export type RatingScheduler = (
  db: SqlExecutor, before: FsrsCardState, nowMs: number, config: FsrsSchedulerConfig,
) => ScheduleOutcome[];

export function scheduleAllRatings(
  before: FsrsCardState, nowMs: number, config: FsrsSchedulerConfig,
  fsrs: SchedulerContext['fsrs'] = buildFsrs(config.fsrsParams),
): ScheduleOutcome[] {
  const learningSteps = sanitizeSteps(config.learningSteps);
  const relearningSteps = sanitizeSteps(config.relearningSteps);
  const memory: MemoryState | null = before.stability !== null && before.difficulty !== null
    && Number.isFinite(before.stability) && Number.isFinite(before.difficulty) && before.stability > 0
    ? { stability: before.stability, difficulty: before.difficulty }
    : null;
  const daysElapsed = before.lastReviewMs === null
    ? 0
    : logicalDaysBetween(before.lastReviewMs, nowMs, config.dayRolloverHour);
  const snapshot: CardSnapshot = {
    phase: toPhase(before.state),
    memory,
    learningStep: before.learningStep,
    daysElapsed,
    reps: before.reps,
    lapses: before.lapses,
  };
  const answers = schedule(snapshot, {
    fsrs,
    desiredRetention: config.desiredRetention,
    learningSteps,
    relearningSteps,
    maximumInterval: Math.max(1, config.maximumInterval),
    fuzzFactor: config.enableFuzz ? fuzzFactorFor(before.id, before.reps) : null,
  });
  const toOutcome = (answer: ScheduledAnswer): ScheduleOutcome => {
    let dueMs: number;
    let scheduledDays: number;
    if (answer.delay.kind === 'minutes') {
      dueMs = learningDueMs(nowMs, answer.delay.minutes, config.dayRolloverHour);
      scheduledDays = 0;
    } else {
      dueMs = nowMs + answer.delay.days * MS_PER_DAY;
      scheduledDays = answer.delay.days;
    }
    return {
      state: fromPhase(answer.phase),
      stability: answer.memory.stability,
      difficulty: answer.memory.difficulty,
      scheduledDays,
      elapsedDays: daysElapsed,
      dueMs,
      reps: answer.reps,
      lapses: answer.lapses,
      learningStep: answer.learningStep,
    };
  };
  const ordered = [answers.again, answers.hard, answers.good, answers.easy];
  return ordered.map(toOutcome);
}

export function scheduleReviewOutcome(
  before: FsrsCardState, rating: number, nowMs: number, config: FsrsSchedulerConfig,
): ScheduleOutcome {
  return scheduleAllRatings(before, nowMs, config)[rating - 1]!;
}

export function applyMasteryBiasToOutcome(
  outcome: ScheduleOutcome, masteryScore: number | null | undefined, nowMs: number,
): void {
  if (masteryScore === null || masteryScore === undefined) return;
  const fsrsDue = outcome.dueMs;
  let biasedDue = applyMasteryDueBias(masteryScore, nowMs, fsrsDue);
  if (outcome.state === 2) {
    // Graduated Review outcomes must retain at least a 1-day interval (never collapse to 0d).
    const minReviewDue = nowMs + MS_PER_DAY;
    if (biasedDue < minReviewDue) biasedDue = minReviewDue;
  }
  if (biasedDue === fsrsDue) {
    if (outcome.state === 2 && outcome.scheduledDays < 1) {
      outcome.scheduledDays = Math.max(1, (outcome.dueMs - nowMs) / MS_PER_DAY);
    }
    return;
  }
  const oldInterval = fsrsDue - nowMs;
  const newInterval = biasedDue - nowMs;
  if (oldInterval > 0 && outcome.scheduledDays > 0) {
    const scaled = outcome.scheduledDays * newInterval / oldInterval;
    outcome.scheduledDays = outcome.state === 2 ? Math.max(1, scaled) : scaled;
  } else if (outcome.state === 2) {
    outcome.scheduledDays = Math.max(1, newInterval / MS_PER_DAY);
  }
  outcome.dueMs = biasedDue;
}

/**
 * Applies mastery bias across all 4 rating outcomes `[again, hard, good, easy]`
 * while preserving the `>= 1d` floor on graduated Review outcomes (`state === 2`)
 * and `Again <= Hard <= Good < Easy` monotonicity whenever unbiased FSRS ordered them.
 */
export function applyMasteryBiasToOutcomes(
  outcomes: readonly ScheduleOutcome[], masteryScore: number | null | undefined, nowMs: number,
): void {
  if (masteryScore === null || masteryScore === undefined) return;
  const originalDues = outcomes.map(outcome => outcome.dueMs);
  for (const outcome of outcomes) {
    applyMasteryBiasToOutcome(outcome, masteryScore, nowMs);
  }
  for (let index = 1; index < outcomes.length; index++) {
    const prev = outcomes[index - 1]!;
    const curr = outcomes[index]!;
    const origPrev = originalDues[index - 1]!;
    const origCurr = originalDues[index]!;
    if (origCurr < origPrev) continue;
    const needsDaySeparation = curr.state === 2 && prev.state === 2 && origCurr > origPrev;
    const minDue = needsDaySeparation ? prev.dueMs + MS_PER_DAY : prev.dueMs;
    if (curr.dueMs < minDue) {
      const targetDue = masteryScore < 0.5 && origCurr > prev.dueMs
        ? Math.min(origCurr, minDue)
        : minDue;
      curr.dueMs = Math.max(curr.state === 2 ? nowMs + MS_PER_DAY : nowMs, targetDue);
      if (curr.state === 2) {
        curr.scheduledDays = Math.max(1, (curr.dueMs - nowMs) / MS_PER_DAY);
      }
    }
  }
}

export function interleaveNewCards(review: FsrsDueCard[], fresh: FsrsDueCard[]): FsrsDueCard[] {
  if (fresh.length === 0 || review.length === 0) return [...review, ...fresh];
  const total = review.length + fresh.length;
  const newLen = fresh.length;
  const out: FsrsDueCard[] = [];
  let reviewIndex = 0;
  let newIndex = 0;
  let placedNew = 0;
  for (let index = 0; index < total; index++) {
    const newDue = Math.floor((index + 1) * newLen / total) > placedNew;
    let card: FsrsDueCard | undefined;
    if (newDue) {
      card = fresh[newIndex++] ?? review[reviewIndex++];
    } else {
      card = review[reviewIndex++] ?? fresh[newIndex++];
    }
    if (card !== undefined) {
      if (card.state === 0) placedNew += 1;
      out.push(card);
    }
  }
  return out;
}

export function diagnosticError(cardId: string): ReturnType<typeof appError> {
  return new CommandError(AppError.with_details('Validation', 'Diagnostic error cards cannot be reviewed', {
    errorCode: 'fsrs_diagnostic_card_not_reviewable',
    cardId,
  }));
}
