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
  const biasedDue = applyMasteryDueBias(masteryScore, nowMs, fsrsDue);
  if (biasedDue === fsrsDue) return;
  const oldInterval = fsrsDue - nowMs;
  const newInterval = biasedDue - nowMs;
  if (oldInterval > 0 && outcome.scheduledDays > 0) {
    outcome.scheduledDays = outcome.scheduledDays * newInterval / oldInterval;
  }
  outcome.dueMs = biasedDue;
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
