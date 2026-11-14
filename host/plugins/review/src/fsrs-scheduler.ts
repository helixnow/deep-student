/**
 * Anki 语义的 FSRS 调度层（纯函数，无 I/O）的 TypeScript 迁移。
 *
 * 原实现：`src-tauri/crates/dstu-learning/src/fsrs_scheduler.rs`
 * 记忆模型：fsrs-rs 6.6.2（FSRS-6）的 `next_states` / `memory_state` / `step`
 * 的等价移植；调度规则（学习步 / fuzz / 逻辑日）与 Rust 一致。
 *
 * 记忆模型（`next_states` / `memory_state` / 遗忘曲线）直接使用 F7 平台模块
 * `host/platform/native/fsrs`，本 lane 只保留 Anki 调度规则。这两个同步模型函数就是
 * `nativeFsrs`（桌面 `index.ts` 与移动端 `web.ts`）返回的同一实现，不经 WASM。
 */
import { fsrsMemoryState, fsrsNextStates } from '../../../platform/native/fsrs/api.ts';
import {
  DEFAULT_PARAMETERS, effectiveParameters, forgettingCurveConstants, retrievability,
} from '../../../platform/native/fsrs/parameters.ts';
import { civilTime, ymd } from '../../../platform/time/index.ts';
import { encodeUtf8 } from '../../../platform/util/portable.ts';

export {
  DEFAULT_PARAMETERS, effectiveParameters, forgettingCurveConstants, retrievability,
};

export const DEFAULT_LEARNING_STEPS_MINUTES = [1, 10] as const;
export const DEFAULT_RELEARNING_STEPS_MINUTES = [10] as const;
export const DEFAULT_MAXIMUM_INTERVAL_DAYS = 36_500;
export const DEFAULT_DAY_ROLLOVER_HOUR = 4;
export const MAX_STEP_MINUTES = 525_600;
export const MAX_STEPS = 16;
export const MINUTES_PER_DAY = 1440;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

export type CardPhase = 'new' | 'learning' | 'review' | 'relearning';

export interface MemoryState {
  stability: number;
  difficulty: number;
}

export interface CardSnapshot {
  phase: CardPhase;
  memory: MemoryState | null;
  learningStep: number;
  daysElapsed: number;
  reps: number;
  lapses: number;
}

export interface SchedulerContext {
  fsrs: Pick<Fsrs6, 'nextStates'>;
  desiredRetention: number;
  learningSteps: readonly number[];
  relearningSteps: readonly number[];
  maximumInterval: number;
  fuzzFactor: number | null;
}

export type ScheduledDelay =
  | { readonly kind: 'minutes'; readonly minutes: number }
  | { readonly kind: 'days'; readonly days: number };

export interface ScheduledAnswer {
  phase: CardPhase;
  memory: MemoryState;
  learningStep: number;
  delay: ScheduledDelay;
  reps: number;
  lapses: number;
}

export interface ScheduledAnswers {
  again: ScheduledAnswer;
  hard: ScheduledAnswer;
  good: ScheduledAnswer;
  easy: ScheduledAnswer;
}

export interface FsrsReview {
  rating: number;
  deltaT: number;
}

export interface NextStates {
  again: { memory: MemoryState; interval: number };
  hard: { memory: MemoryState; interval: number };
  good: { memory: MemoryState; interval: number };
  easy: { memory: MemoryState; interval: number };
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** `fsrs::check_and_fill_parameters(params).is_ok()`：仅接受 17 / 19 / 21 个有限值。 */
export function checkParametersUsable(params: readonly number[]): boolean {
  if (params.length !== 17 && params.length !== 19 && params.length !== 21) return false;
  return params.every(value => Number.isFinite(value));
}

/** fsrs-rs `FSRS` 的最小等价包装；记忆模型由 F7 平台模块提供。 */
export class Fsrs6 {
  readonly parameters: readonly number[];

  constructor(params: readonly number[] = []) {
    this.parameters = effectiveParameters(params);
  }

  nextStates(memory: MemoryState | null, desiredRetention: number, daysElapsed: number): NextStates {
    return fsrsNextStates(this.parameters, memory, desiredRetention, daysElapsed);
  }

  /** fsrs-rs `memory_state`：按复习序列重放稳定度 / 难度。 */
  memoryState(reviews: readonly FsrsReview[], starting: MemoryState | null = null): MemoryState {
    return fsrsMemoryState(this.parameters, {
      reviews: reviews.map(review => ({ rating: review.rating, delta_t: review.deltaT })),
    }, starting);
  }
}

export function buildFsrs(params: readonly number[] = []): Fsrs6 {
  return new Fsrs6(params);
}

/** 计算四档评分的下一状态。 */
export function schedule(card: CardSnapshot, ctx: SchedulerContext): ScheduledAnswers {
  const memory = card.phase === 'new'
    ? null
    : card.memory !== null && card.memory.stability > 0 && card.memory.difficulty > 0
      ? card.memory
      : null;
  const daysElapsed = memory !== null ? card.daysElapsed : 0;
  const next = ctx.fsrs.nextStates(memory, ctx.desiredRetention, daysElapsed);
  const reps = Math.min(2_147_483_647, card.reps + 1);
  if (card.phase === 'review' && memory !== null) return reviewAnswers(card, ctx, next, reps);
  if (card.phase === 'relearning' && memory !== null) {
    return steppedAnswers(card, ctx, next, reps, ctx.relearningSteps, 'relearning');
  }
  return steppedAnswers(card, ctx, next, reps, ctx.learningSteps, 'learning');
}

function steppedAnswers(
  card: CardSnapshot,
  ctx: SchedulerContext,
  next: NextStates,
  reps: number,
  steps: readonly number[],
  steppingPhase: CardPhase,
): ScheduledAnswers {
  const isNew = card.phase === 'new' || card.memory === null;
  const index = isNew ? 0 : Math.min(card.learningStep, Math.max(0, steps.length - 1));
  const stepping = (memory: MemoryState, step: number, minutes: number): ScheduledAnswer => ({
    phase: steppingPhase, memory, learningStep: step,
    delay: { kind: 'minutes', minutes }, reps, lapses: card.lapses,
  });
  const review = (memory: MemoryState, days: number): ScheduledAnswer => ({
    phase: 'review', memory, learningStep: 0, delay: { kind: 'days', days }, reps, lapses: card.lapses,
  });
  const [goodDays, easyDays] = graduationIntervals(ctx, next);
  const easy = review(next.easy.memory, easyDays);

  if (steps.length === 0) {
    const shortOrReview = (memory: MemoryState, interval: number, minimumDays: number): ScheduledAnswer =>
      interval < 1
        ? stepping(memory, 0, Math.max(interval * MINUTES_PER_DAY, 1))
        : review(memory, constrainInterval(ctx, interval, minimumDays, 0));
    const again = shortOrReview(next.again.memory, next.again.interval, 1);
    const hard = shortOrReview(next.hard.memory, next.hard.interval, 1);
    if (hard.delay.kind === 'days') {
      hard.delay = { kind: 'days', days: Math.min(hard.delay.days, goodDays) };
    }
    return { again, hard, good: review(next.good.memory, goodDays), easy };
  }

  const again = stepping(next.again.memory, 0, steps[0]!);
  const hard = stepping(next.hard.memory, index, hardDelay(steps, index));
  const goodStep = isNew ? 1 : index + 1;
  const good = steps[goodStep] !== undefined
    ? stepping(next.good.memory, goodStep, steps[goodStep]!)
    : review(next.good.memory, goodDays);
  return { again, hard, good, easy };
}

function reviewAnswers(card: CardSnapshot, ctx: SchedulerContext, next: NextStates, reps: number): ScheduledAnswers {
  const lapses = Math.min(2_147_483_647, card.lapses + 1);
  const again: ScheduledAnswer = ctx.relearningSteps.length > 0
    ? {
        phase: 'relearning', memory: next.again.memory, learningStep: 0,
        delay: { kind: 'minutes', minutes: ctx.relearningSteps[0]! }, reps, lapses,
      }
    : {
        phase: 'review', memory: next.again.memory, learningStep: 0,
        delay: { kind: 'days', days: constrainInterval(ctx, next.again.interval, 1, 0) }, reps, lapses,
      };
  const elapsed = card.daysElapsed;
  const hardDays = constrainInterval(ctx, next.hard.interval, 1, elapsed);
  const goodDays = constrainInterval(ctx, next.good.interval, hardDays + 1, elapsed);
  const easyDays = constrainInterval(ctx, next.easy.interval, goodDays + 1, elapsed);
  const passing = (memory: MemoryState, days: number): ScheduledAnswer => ({
    phase: 'review', memory, learningStep: 0, delay: { kind: 'days', days }, reps, lapses: card.lapses,
  });
  return {
    again,
    hard: passing(next.hard.memory, hardDays),
    good: passing(next.good.memory, goodDays),
    easy: passing(next.easy.memory, easyDays),
  };
}

function graduationIntervals(ctx: SchedulerContext, next: NextStates): [number, number] {
  const good = constrainInterval(ctx, next.good.interval, 1, 0);
  const easy = constrainInterval(ctx, next.easy.interval, good + 1, 0);
  return [good, easy];
}

/** Hard 的学习步延迟（Anki `LearningSteps::hard_delay_secs`）。 */
export function hardDelay(steps: readonly number[], index: number): number {
  const current = steps[Math.min(index, Math.max(0, steps.length - 1))]!;
  if (index > 0) return current;
  const next = steps[1];
  return next !== undefined ? (current + next) / 2 : Math.min(current * 1.5, current + MINUTES_PER_DAY);
}

export function fuzzDelta(interval: number): number {
  if (interval < 2.5) return 0;
  const ranges: readonly [number, number, number][] = [
    [2.5, 7, 0.15], [7, 20, 0.1], [20, Number.MAX_VALUE, 0.05],
  ];
  return ranges.reduce((delta, [start, end, factor]) =>
    delta + factor * Math.max(0, Math.min(interval, end) - start), 1);
}

export function constrainedFuzzBounds(interval: number, minimum: number, maximum: number): [number, number] {
  const min = Math.min(minimum, maximum);
  const value = clamp(interval, min, maximum);
  const delta = fuzzDelta(value);
  let lower = clamp(Math.round(Math.max(0, value - delta)), min, maximum);
  let upper = clamp(Math.round(Math.max(0, value + delta)), min, maximum);
  if (upper === lower && upper > 2 && upper < maximum) upper = lower + 1;
  if (lower > upper) [lower, upper] = [upper, lower];
  return [lower, upper];
}

/** Anki `with_review_fuzz`。 */
export function withReviewFuzz(fuzzFactor: number | null, interval: number, minimum: number, maximum: number): number {
  const value = Number.isFinite(interval) ? interval : minimum;
  if (fuzzFactor !== null && fuzzFactor !== undefined) {
    const [lower, upper] = constrainedFuzzBounds(value, minimum, maximum);
    const factor = clamp(fuzzFactor, 0, 0.999999);
    return Math.floor(lower + factor * (upper - lower + 1));
  }
  return clamp(Math.max(0, Math.round(value)), Math.min(minimum, maximum), maximum);
}

function constrainInterval(ctx: SchedulerContext, interval: number, minimum: number, daysElapsed: number): number {
  const maximum = Math.max(1, ctx.maximumInterval);
  let min = Math.max(1, minimum);
  if (ctx.fuzzFactor !== null && interval > daysElapsed) min = Math.max(min, daysElapsed + 1);
  return withReviewFuzz(ctx.fuzzFactor, interval, Math.min(min, maximum), maximum);
}

/** 确定性 fuzz 因子 ∈ [0, 1)：只依赖 `(card_state_id, reps)`（FNV-1a + splitmix64）。 */
export function fuzzFactorFor(cardStateId: string, reps: number): number {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = encodeUtf8(cardStateId);
  const repBytes = new Uint8Array(4);
  new DataView(repBytes.buffer).setInt32(0, reps | 0, true);
  for (const byte of [...bytes, ...repBytes]) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  hash ^= hash >> 30n;
  hash = (hash * 0xbf58476d1ce4e5b9n) & mask;
  hash ^= hash >> 27n;
  hash = (hash * 0x94d049bb133111ebn) & mask;
  hash ^= hash >> 31n;
  return Number(hash >> 40n) / 2 ** 24;
}

/** 规范化学习步：去掉非有限值 / 非正值，限制单步时长与步数。 */
export function sanitizeSteps(steps: readonly number[]): number[] {
  return steps.filter(minutes => Number.isFinite(minutes) && minutes > 0)
    .map(minutes => Math.min(minutes, MAX_STEP_MINUTES))
    .slice(0, MAX_STEPS);
}

// ---- 逻辑日 ----

interface DateParts { year: number; month: number; day: number }

function localParts(ms: number, rolloverHour: number): DateParts {
  const time = civilTime(BigInt(ms) * 1_000_000n, true);
  const day = new Date(Date.UTC(time.year, time.month - 1, time.day - (time.hour < rolloverHour ? 1 : 0)));
  return { year: day.getUTCFullYear(), month: day.getUTCMonth(), day: day.getUTCDate() };
}

function offsetParts(ms: number, offsetMinutes: number, rolloverHour: number): DateParts {
  const time = civilTime(BigInt(ms + offsetMinutes * 60_000 - rolloverHour * 3_600_000) * 1_000_000n, false);
  return { year: time.year, month: time.month - 1, day: time.day };
}

function partsToUtcMs(parts: DateParts, hour = 0): number {
  return Date.UTC(parts.year, parts.month, parts.day, hour, 0, 0, 0);
}

/** 逻辑日 key（YYYY-MM-DD）。`offsetMinutes` 仅测试用，缺省为本地时区。 */
export function logicalDayKey(ms: number, rolloverHour: number, offsetMinutes?: number): string {
  const parts = offsetMinutes === undefined ? localParts(ms, Math.min(23, rolloverHour)) : offsetParts(ms, offsetMinutes, Math.min(23, rolloverHour));
  return ymd({
    year: parts.year, month: parts.month + 1, day: parts.day,
    hour: 0, minute: 0, second: 0, nanos: 0, offsetMinutes: 0,
  });
}

/** 两个时刻之间相差的逻辑日数。 */
export function logicalDaysBetween(fromMs: number, toMs: number, rolloverHour: number, offsetMinutes?: number): number {
  const from = offsetMinutes === undefined ? localParts(fromMs, Math.min(23, rolloverHour)) : offsetParts(fromMs, offsetMinutes, Math.min(23, rolloverHour));
  const to = offsetMinutes === undefined ? localParts(toMs, Math.min(23, rolloverHour)) : offsetParts(toMs, offsetMinutes, Math.min(23, rolloverHour));
  const days = Math.round((partsToUtcMs(to) - partsToUtcMs(from)) / MS_PER_DAY);
  return Math.max(0, Math.min(4_294_967_295, days));
}

function dayStartMs(parts: DateParts, rolloverHour: number, offsetMinutes?: number): number {
  const hour = Math.min(23, rolloverHour);
  if (offsetMinutes !== undefined) return partsToUtcMs(parts, hour) - offsetMinutes * 60_000;
  return new Date(parts.year, parts.month, parts.day, hour, 0, 0, 0).getTime();
}

function nextDay(parts: DateParts): DateParts {
  const date = new Date(Date.UTC(parts.year, parts.month, parts.day + 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() };
}

/** 当前逻辑日的毫秒边界 `[start, next_start)`。 */
export function logicalDayBoundsMs(nowMs: number, rolloverHour: number, offsetMinutes?: number): [number, number] {
  const hour = Math.min(23, rolloverHour);
  const today = offsetMinutes === undefined ? localParts(nowMs, hour) : offsetParts(nowMs, offsetMinutes, hour);
  const start = dayStartMs(today, hour, offsetMinutes);
  const next = dayStartMs(nextDay(today), hour, offsetMinutes);
  return [start, Math.max(start + 1, next)];
}

/** 学习步到期时间：不跨日按分钟计；跨过日切时按整逻辑日起点。 */
export function learningDueMs(nowMs: number, minutes: number, rolloverHour: number, offsetMinutes?: number): number {
  const due = nowMs + Math.round(Math.max(0, minutes) * MS_PER_MINUTE);
  const [, nextDayStart] = logicalDayBoundsMs(nowMs, rolloverHour, offsetMinutes);
  if (due < nextDayStart) return due;
  const hour = Math.min(23, rolloverHour);
  const dueParts = offsetMinutes === undefined ? localParts(due, hour) : offsetParts(due, offsetMinutes, hour);
  return dayStartMs(dueParts, hour, offsetMinutes);
}
