/**
 * 题目集复习（review_plans）的 FSRS 调度适配层（UX 审计决议 D2：放弃 SM-2，改用 FSRS）。
 *
 * 不另写一套算法：把一条复习计划换成闪卡用的 `FsrsCardState`，交给
 * `review-scheduling.ts` 的 `scheduleAllRatings`（Anki 语义学习步 + FSRS-6 记忆模型，
 * 与闪卡完全同一实现）算出四档结果，再写回 review_plans 的 SM-2 兼容列与 FSRS 状态列。
 *
 * 评分口径沿用 0-5 的 quality（命令 / 智能体工具 / 每日冲刺都按它传）：
 *   0-2 → 重来（Again） · 3 → 困难（Hard，算答对） · 4 → 良好（Good） · 5 → 简单（Easy）
 *
 * 没有当前版本 FSRS 状态的计划：下一次评分 / 预演时按 SM-2 列惰性换算，不改写 next_review_date——
 *   - 从没复习过（total_reviews = 0 且 repetitions = 0）→ new，记忆为空；
 *   - repetitions > 0 → review 态：稳定度 S = max(1, interval_days)（期望保持率 0.9 时 FSRS 间隔≈S），
 *     难度 D 由易度因子线性映射（EF 1.3 → 10、2.5 → 5，夹在 [1, 10]）；
 *   - 复习过但最近一次答错（repetitions = 0）→ relearning 第 0 步，S = 1，D 同上；
 *   - 上次复习时刻取 last_review_date 当天中午（没有就按 interval_days 倒推）。
 */
import type { ReviewPlan, ReviewPlanFsrsState, ReviewPlanRatingPreviews } from '../../vfs-repos/api.ts';
import { localDateKey } from './local-date.ts';
import { scheduleAllRatings, type ScheduleOutcome } from './review-scheduling.ts';
import { defaultSchedulerConfig, MS_PER_DAY, type FsrsCardState, type FsrsSchedulerConfig } from './fsrs-types.ts';

export type FsrsRating = 1 | 2 | 3 | 4;

const PHASES = ['new', 'learning', 'review', 'relearning'] as const;
type Phase = (typeof PHASES)[number];

const MIN_EASE = 1.3;
const BASE_EASE = 2.5;
/** EF 每降 1.2 难度升 5：EF 1.3 → D 10，EF 2.5 → D 5。 */
const EASE_TO_DIFFICULTY_SLOPE = 5 / (BASE_EASE - MIN_EASE);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** 0-5 quality → FSRS 四档。 */
export function fsrsRatingFromQuality(quality: number): FsrsRating {
  const q = Math.trunc(quality);
  if (q <= 2) return 1;
  if (q === 3) return 2;
  if (q === 4) return 3;
  return 4;
}

/** FSRS 四档里只有「重来」算没记住（与闪卡一致：困难也是想起来了）。 */
export function fsrsRatingPassed(rating: FsrsRating): boolean {
  return rating >= 2;
}

export function difficultyFromEase(easeFactor: number): number {
  const ease = Number.isFinite(easeFactor) ? easeFactor : BASE_EASE;
  return clamp(10 - (Math.max(MIN_EASE, ease) - MIN_EASE) * EASE_TO_DIFFICULTY_SLOPE, 1, 10);
}

/** 反向映射，只为让 ease_factor 列（统计里的平均易度）继续有意义。 */
export function easeFromDifficulty(difficulty: number): number {
  return Math.max(MIN_EASE, Math.round((MIN_EASE + (10 - clamp(difficulty, 1, 10)) / EASE_TO_DIFFICULTY_SLOPE) * 1000) / 1000);
}

function localNoonMs(dateKey: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (match === null) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

const phaseIndex = (phase: Phase): number => PHASES.indexOf(phase);

/** 一条计划当前的 FSRS 状态；SM-2 遗留行按文件头的规则换算（纯函数，不写库）。 */
export function resolvePlanFsrsState(plan: ReviewPlan, stored: ReviewPlanFsrsState | null | undefined, nowMs: number): ReviewPlanFsrsState {
  if (stored && stored.phase !== null) return stored;
  const difficulty = difficultyFromEase(plan.ease_factor);
  const lastReview = (plan.last_review_date ? localNoonMs(plan.last_review_date) : null)
    ?? (plan.total_reviews > 0 ? nowMs - Math.max(1, plan.interval_days) * MS_PER_DAY : null);
  if (plan.total_reviews === 0 && plan.repetitions === 0) {
    return { stability: null, difficulty: null, phase: 'new', learning_step: 0, lapses: 0, due_at: null, last_review_at: null };
  }
  if (plan.repetitions === 0) {
    return {
      stability: 1, difficulty, phase: 'relearning', learning_step: 0,
      lapses: Math.max(1, plan.consecutive_failures), due_at: null, last_review_at: lastReview,
    };
  }
  return {
    stability: Math.max(1, plan.interval_days), difficulty, phase: 'review', learning_step: 0,
    lapses: 0, due_at: null, last_review_at: lastReview,
  };
}

function cardState(plan: ReviewPlan, state: ReviewPlanFsrsState, nowMs: number): FsrsCardState {
  const lastReviewMs = state.last_review_at !== null && state.last_review_at <= nowMs ? state.last_review_at : (state.last_review_at === null ? null : nowMs);
  return {
    id: plan.id,
    ankiCardId: plan.question_id,
    deckId: plan.exam_id,
    state: phaseIndex(state.phase ?? 'new'),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsedDays: 0,
    scheduledDays: plan.interval_days,
    reps: plan.total_reviews,
    lapses: state.lapses,
    dueMs: state.due_at ?? nowMs,
    lastReviewMs,
    suspended: plan.status === 'suspended',
    fsrsParamsVersion: '',
    desiredRetention: null,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    leech: false,
    buriedUntilMs: null,
    learningStep: state.learning_step,
  };
}

export interface PlanFsrsOutcome {
  rating: FsrsRating;
  passed: boolean;
  /** 写回 review_plans.interval_days（分钟级学习步为 0）。 */
  intervalDays: number;
  /** 写回 next_review_date（按日口径；学习步当天到期 = 今天）。 */
  nextReviewDate: string;
  intervalMinutes: number;
  fsrs: ReviewPlanFsrsState;
  easeFactor: number;
  phase: Phase;
}

function toPlanOutcome(rating: FsrsRating, outcome: ScheduleOutcome, nowMs: number, lapsesBefore: number): PlanFsrsOutcome {
  const phase = PHASES[outcome.state] ?? 'review';
  const intervalMinutes = Math.max(0, Math.round((outcome.dueMs - nowMs) / 60_000));
  return {
    rating,
    passed: fsrsRatingPassed(rating),
    intervalDays: Math.max(0, Math.round(outcome.scheduledDays)),
    nextReviewDate: localDateKey(new Date(outcome.dueMs)),
    intervalMinutes,
    easeFactor: easeFromDifficulty(outcome.difficulty),
    phase,
    fsrs: {
      stability: outcome.stability,
      difficulty: outcome.difficulty,
      phase,
      learning_step: outcome.learningStep,
      lapses: Math.max(lapsesBefore, outcome.lapses),
      due_at: outcome.dueMs,
      last_review_at: nowMs,
    },
  };
}

/** 四档评分各自的结果（顺序：重来 / 困难 / 良好 / 简单）。 */
export function schedulePlanAllRatings(
  plan: ReviewPlan, stored: ReviewPlanFsrsState | null | undefined, nowMs: number,
  config: FsrsSchedulerConfig = defaultSchedulerConfig(),
): PlanFsrsOutcome[] {
  const state = resolvePlanFsrsState(plan, stored, nowMs);
  const outcomes = scheduleAllRatings(cardState(plan, state, nowMs), nowMs, config);
  return outcomes.map((outcome, index) => toPlanOutcome((index + 1) as FsrsRating, outcome, nowMs, state.lapses));
}

export function schedulePlanReview(
  plan: ReviewPlan, stored: ReviewPlanFsrsState | null | undefined, quality: number, nowMs: number,
  config?: FsrsSchedulerConfig,
): PlanFsrsOutcome {
  const rating = fsrsRatingFromQuality(quality);
  return schedulePlanAllRatings(plan, stored, nowMs, config)[rating - 1]!;
}

/** 评分按钮上的间隔预演（「1 分钟 / 6 分钟 / 10 分钟 / 3 天」）。 */
export function planRatingPreviews(
  plan: ReviewPlan, stored: ReviewPlanFsrsState | null | undefined, nowMs: number,
): ReviewPlanRatingPreviews {
  const [again, hard, good, easy] = schedulePlanAllRatings(plan, stored, nowMs).map(outcome => ({
    interval_minutes: outcome.intervalMinutes,
    next_review_date: outcome.nextReviewDate,
  }));
  return { again: again!, hard: hard!, good: good!, easy: easy! };
}
