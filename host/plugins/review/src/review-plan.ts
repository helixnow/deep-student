/**
 * 复习计划服务（SM-2）。Rust 源：
 * `dstu-qbank/src/review_plan_service.rs` + `dstu-vfs/src/vfs/repos/review_plan_repo.rs`。
 */
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import type { QuestionFilters, VfsReposService } from '../../vfs-repos/api.ts';
import type { MasteryService } from '../api.ts';
import { eventConcept } from '../repository/mastery.ts';
import { utcNow } from './clock.ts';
import { errorText } from './errors.ts';
import { addLocalDays, localDateKey } from './local-date.ts';
import type {
  BatchCreateResult, DueReviewsFilter, DueReviewsResult, ProcessReviewResult, ReviewHistory,
  ReviewPlan, ReviewPlanStatus, ReviewStats, CalendarHeatmapData,
} from './review-plan-types.ts';

export interface ReviewPlanStore {
  readonly questions: {
    getQuestion(conn: SqlExecutor, id: string): { exam_id: string; tags: string[] } | null;
    listQuestions(
      conn: SqlExecutor, examId: string, filters: QuestionFilters, page: number, pageSize: number,
    ): { questions: readonly { id: string }[]; has_more: boolean };
  };
  readonly reviewPlans: VfsReposService['reviewPlans'];
}

/**
 * `create_review_plan` 的 anyhow 最外层 context：命令层只看到这一条消息，
 * 批量创建还要通过 `alreadyExists` 判断是否计入 skipped。
 */
export class ReviewPlanCreateError extends Error {
  readonly questionId: string;
  readonly alreadyExists: boolean;

  constructor(questionId: string, alreadyExists: boolean) {
    super(`Failed to create review plan for question_id=${questionId}`);
    this.questionId = questionId;
    this.alreadyExists = alreadyExists;
    this.name = 'ReviewPlanCreateError';
  }
}

export const DEFAULT_EASE_FACTOR = 2.5;
export const FIRST_INTERVAL = 1;
export const SECOND_INTERVAL = 6;
export const PASSING_GRADE = 3;
export const MAX_INTERVAL = 730;
export const MIN_EASE_FACTOR = 1.3;

const GRADUATION_INTERVAL_THRESHOLD = 21;
const GRADUATION_REPETITIONS_THRESHOLD = 3;
const DIFFICULT_THRESHOLD = 3;

const DAY_MS = 86_400_000;

/** Rust `ReviewQuality`（serde snake_case 数值枚举）。 */
export type ReviewQuality = 0 | 1 | 2 | 3 | 4 | 5;

export const ReviewQuality = {
  Blackout: 0,
  WrongButFamiliar: 1,
  WrongButEasy: 2,
  Difficult: 3,
  Good: 4,
  Perfect: 5,
  fromU8(value: number): ReviewQuality | null {
    switch (value) {
      case 0: return 0;
      case 1: return 1;
      case 2: return 2;
      case 3: return 3;
      case 4: return 4;
      case 5: return 5;
      default: return null;
    }
  },
  asU8(value: ReviewQuality): number { return value; },
  isPassing(value: ReviewQuality): boolean { return value >= PASSING_GRADE; },
} as const;

/** Rust `SM2Result`（字段名保持 snake_case 与序列化形状一致）。 */
export interface SM2Result {
  new_interval: number;
  new_ease_factor: number;
  new_repetitions: number;
  passed: boolean;
}

/** 解析 `YYYY-MM-DD` 为自 1970-01-01 起的 UTC 日序号；非法日期返回 null。 */
function parseDateKey(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day) return null;
  return Math.floor(date.getTime() / DAY_MS);
}

/** 自 1970-01-01 起的 UTC 日序号格式化为 chrono `%Y-%m-%d`。 */
function formatDateKey(dayNumber: number): string {
  const date = new Date(dayNumber * DAY_MS);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface ReviewPlanServiceConfig {
  initial_ease_factor: number;
  graduation_interval_threshold: number;
  graduation_repetitions_threshold: number;
  difficult_threshold: number;
}

export function defaultReviewPlanConfig(): ReviewPlanServiceConfig {
  return {
    initial_ease_factor: DEFAULT_EASE_FACTOR,
    graduation_interval_threshold: GRADUATION_INTERVAL_THRESHOLD,
    graduation_repetitions_threshold: GRADUATION_REPETITIONS_THRESHOLD,
    difficult_threshold: DIFFICULT_THRESHOLD,
  };
}

/** SM-2：返回 `(new_interval, new_ease_factor, new_repetitions)`。 */
export function calculateNextReview(
  quality: number, repetitions: number, easeFactor: number, interval: number,
): [number, number, number] {
  const q = Math.min(5, quality);
  const currentEf = Math.max(MIN_EASE_FACTOR, easeFactor);
  if (q < PASSING_GRADE) return [FIRST_INTERVAL, currentEf, 0];
  const newEf = calculateEaseFactor(currentEf, q);
  const newReps = repetitions + 1;
  let newInterval: number;
  if (newReps === 1) newInterval = FIRST_INTERVAL;
  else if (newReps === 2) newInterval = SECOND_INTERVAL;
  else {
    const calculated = Math.round(interval * newEf);
    newInterval = Math.min(MAX_INTERVAL, Math.max(interval + 1, calculated));
  }
  return [newInterval, newEf, newReps];
}

/** SM-2 易度因子增量：`EF' = EF + (0.1 - (5-q)*(0.08+(5-q)*0.02))`。 */
export function calculateEaseFactor(easeFactor: number, quality: number): number {
  const delta = 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02);
  return Math.max(MIN_EASE_FACTOR, easeFactor + delta);
}

/** Rust `calculate_next_review_advanced`：枚举入口返回 `SM2Result`。 */
export function calculateNextReviewAdvanced(
  quality: ReviewQuality, repetitions: number, easeFactor: number, interval: number,
): SM2Result {
  const [newInterval, newEaseFactor, newRepetitions] = calculateNextReview(
    ReviewQuality.asU8(quality), repetitions, easeFactor, interval,
  );
  return {
    new_interval: newInterval,
    new_ease_factor: newEaseFactor,
    new_repetitions: newRepetitions,
    passed: ReviewQuality.isPassing(quality),
  };
}

function fuzzInterval(interval: number): number {
  if (interval <= 2) return interval;
  const fuzzRange = Math.max(1, Math.round(interval * 0.05));
  const offset = Math.floor(Math.random() * (fuzzRange * 2 + 1));
  return Math.min(MAX_INTERVAL, Math.max(1, interval + offset - fuzzRange));
}

/** SM-2：基于本地“今天”的模糊间隔日期。 */
export function calculateNextReviewDate(interval: number): string {
  return addLocalDays(localDateKey(), fuzzInterval(interval));
}

/** Rust `calculate_next_review_timestamp`：当前 UTC 时刻 + 间隔（毫秒）。 */
export function calculateNextReviewTimestamp(interval: number): number {
  return Number(BigInt(utcNow().ms) + BigInt(Math.trunc(interval)) * BigInt(DAY_MS));
}

/** Rust `calculate_next_review_date_from_last`：解析失败返回 null。 */
export function calculateNextReviewDateFromLast(
  lastReviewDate: string, interval: number,
): string | null {
  const last = parseDateKey(lastReviewDate);
  if (last === null) return null;
  return formatDateKey(last + Math.trunc(interval));
}

/** Rust `is_due_for_review`：到期或已过期返回 true，非法日期按到期处理。 */
export function isDueForReview(nextReviewDate: string): boolean {
  const review = parseDateKey(nextReviewDate);
  if (review === null) return true;
  return review <= (parseDateKey(localDateKey()) ?? 0);
}

/** Rust `days_overdue`：正数为过期天数，负数为剩余天数，非法日期返回 0。 */
export function daysOverdue(nextReviewDate: string): number {
  const review = parseDateKey(nextReviewDate);
  if (review === null) return 0;
  return (parseDateKey(localDateKey()) ?? 0) - review;
}

/**
 * anyhow `with_context` 后的最外层消息（命令层 `to_string()` 只看到这一条）。
 * 原错误保留在 `cause`，供复习工具识别 REVIEW_CONFLICT（见 review-tool-executor.ts `mutationError`）。
 */
class ReviewPlanContextError extends Error {
  constructor(message: string, cause: unknown) {
    // RUST-FIX(RF-W03-review-conflict-context-chain): anyhow Display 丢掉 cause，Rust 工具层因此认不出冲突
    super(message, { cause });
    this.name = 'ReviewPlanContextError';
  }
}

function withContext<T>(message: string, fn: () => T): T {
  try {
    return fn();
  } catch (cause) {
    throw new ReviewPlanContextError(message, cause);
  }
}

/** Rust `{:?}` 对 `Option<&str>` 的输出，用于错误消息。 */
function debugOption(value: string | null): string {
  return value === null ? 'None' : `Some("${value}")`;
}

type MasteryWriter = Pick<MasteryService, 'recordQbankAnswerWithConn' | 'syncLearnerProfile'>;

export class ReviewPlanService {
  private readonly db: DatabaseHandle;
  private readonly repos: ReviewPlanStore;
  private readonly mastery: MasteryWriter | null;
  private readonly config: ReviewPlanServiceConfig;
  private readonly warn: (message: string) => void;
  private readonly info: (message: string) => void;

  constructor(
    db: DatabaseHandle,
    repos: ReviewPlanStore,
    mastery: MasteryWriter | null = null,
    config: ReviewPlanServiceConfig = defaultReviewPlanConfig(),
    warn: (message: string) => void = () => undefined,
    info: (message: string) => void = () => undefined,
  ) {
    this.db = db;
    this.repos = repos;
    this.mastery = mastery;
    this.config = config;
    this.warn = warn;
    this.info = info;
  }

  // ---------------------------------------------------------------- create

  createReviewPlan(questionId: string, examId: string): ReviewPlan {
    const question = withContext(
      `Failed to get question: ${questionId}`,
      () => this.repos.questions.getQuestion(this.db, questionId),
    );
    if (question === null) throw new Error(`Question not found: ${questionId}`);
    if (question.exam_id !== examId) {
      throw new Error(`Question ${questionId} belongs to exam_id=${question.exam_id}, but got exam_id=${examId}`);
    }
    try {
      const plan = this.repos.reviewPlans.createPlan(this.db, {
        question_id: questionId,
        exam_id: examId,
        initial_ease_factor: this.config.initial_ease_factor,
      });
      this.info(`[ReviewPlanService] Created review plan: id=${plan.id}, question_id=${questionId}`);
      return plan;
    } catch (error) {
      // RUST-FIX(RF-W03-review-plan-batch-skip-by-input-text): only the createPlan failure is matched, not lookup/mismatch errors that echo caller ids.
      const alreadyExists = error instanceof Error
        && (error.message.includes('already exists') || error.message.includes('AlreadyExists'));
      throw new ReviewPlanCreateError(questionId, alreadyExists);
    }
  }

  batchCreateFromQuestions(questionIds: readonly string[], examId: string): BatchCreateResult {
    let created = 0;
    let skipped = 0;
    let failed = 0;
    const plans: ReviewPlan[] = [];
    for (const questionId of questionIds) {
      try {
        plans.push(this.createReviewPlan(questionId, examId));
        created += 1;
      } catch (error) {
        const alreadyExists = error instanceof ReviewPlanCreateError && error.alreadyExists;
        if (alreadyExists) skipped += 1;
        else {
          failed += 1;
          this.warn(`[ReviewPlanService] Failed to create review plan for question_id=${questionId}: ${errorText(error)}`);
        }
      }
    }
    this.info(`[ReviewPlanService] Batch create result: created=${created}, skipped=${skipped}, failed=${failed}`);
    return { created, skipped, failed, plans };
  }

  createPlansForExam(examId: string): BatchCreateResult {
    const aggregate: BatchCreateResult = { created: 0, skipped: 0, failed: 0, plans: [] };
    let page = 1;
    for (;;) {
      const result = withContext(
        `Failed to list questions for exam_id=${examId}, page=${page}, page_size=500`,
        () => this.repos.questions.listQuestions(this.db, examId, {}, page, 500),
      );
      if (result.questions.length === 0) break;
      const batch = this.batchCreateFromQuestions(result.questions.map(question => question.id), examId);
      aggregate.created += batch.created;
      aggregate.skipped += batch.skipped;
      aggregate.failed += batch.failed;
      aggregate.plans.push(...batch.plans);
      if (!result.has_more) break;
      page += 1;
    }
    this.info(`[ReviewPlanService] Create plans for exam finished: exam_id=${examId}, created=${aggregate.created}, skipped=${aggregate.skipped}, failed=${aggregate.failed}`);
    return aggregate;
  }

  // ---------------------------------------------------------------- process

  processReview(
    planId: string, quality: number, userAnswer: string | null, timeSpentSeconds: number | null,
    operationId?: string,
  ): ProcessReviewResult {
    return this.processReviewImpl(planId, quality, userAnswer, timeSpentSeconds, null, true, operationId);
  }

  processReviewWithExpected(
    planId: string, quality: number, userAnswer: string | null, timeSpentSeconds: number | null,
    expectedUpdatedAt: string | null,
  ): ProcessReviewResult {
    return this.processReviewImpl(planId, quality, userAnswer, timeSpentSeconds, expectedUpdatedAt, true);
  }

  advanceFromPractice(planId: string): ProcessReviewResult {
    return this.processReviewImpl(planId, 4, null, null, null, false);
  }

  private processReviewImpl(
    planId: string,
    qualityInput: number,
    userAnswer: string | null,
    timeSpentSeconds: number | null,
    expectedUpdatedAt: string | null,
    recordMastery: boolean,
    operationId?: string,
  ): ProcessReviewResult {
    const quality = Math.min(5, qualityInput);
    const plan = withContext(
      `Failed to get review plan: ${planId}`,
      () => this.repos.reviewPlans.getPlan(this.db, planId),
    );
    if (plan === null) throw new Error(`Review plan not found: ${planId}`);
    if (expectedUpdatedAt !== null && plan.updated_at !== expectedUpdatedAt) {
      throw new Error(`CONFLICT(review_plan.updated_at): REVIEW_CONFLICT: review plan ${planId} changed after revision ${expectedUpdatedAt} was read`);
    }
    // Rust: get_question(...).ok().flatten() —— 题目读取失败按无标签处理，不影响复习。
    let tags: string[] | null = null;
    try {
      tags = this.repos.questions.getQuestion(this.db, plan.question_id)?.tags ?? null;
    } catch {
      tags = null;
    }
    const [newInterval, newEase, newReps] = calculateNextReview(
      quality, plan.repetitions, plan.ease_factor, plan.interval_days,
    );
    const today = localDateKey();
    const nextReviewDate = calculateNextReviewDate(newInterval);
    const passed = quality >= PASSING_GRADE;
    const { status, consecutiveFailures, isDifficult } = this.calculateNewStatus(
      plan, passed, newInterval, newReps,
    );
    const expected = expectedUpdatedAt ?? plan.updated_at;
    const history: { value: ReviewHistory | null } = { value: null };
    const updatedPlan: { value: ReviewPlan | null } = { value: null };
    let masteryState: ReturnType<MasteryWriter['recordQbankAnswerWithConn']> | null = null;
    let replayed = false;
    if (operationId !== undefined && this.mastery === null) {
      throw new Error('Sprint review requires mastery for its transactional receipt');
    }

    try {
      this.db.transaction(tx => {
        if (operationId !== undefined && eventConcept(tx, `me_qbank_${operationId}`) !== null) {
          replayed = true;
          return plan;
        }
        const updated = withContext(
          `Failed to update review plan: ${planId}`,
          () => this.repos.reviewPlans.updatePlan(tx, planId, {
            ease_factor: newEase,
            interval_days: newInterval,
            repetitions: newReps,
            next_review_date: nextReviewDate,
            last_review_date: today,
            status,
            total_reviews: plan.total_reviews + 1,
            total_correct: passed ? plan.total_correct + 1 : plan.total_correct,
            consecutive_failures: consecutiveFailures,
            is_difficult: isDifficult,
            expected_updated_at: expected,
          }),
        );
        updatedPlan.value = updated;
        history.value = withContext(
          `Failed to record review history for plan: ${planId}`,
          () => this.repos.reviewPlans.recordHistory(tx, {
            plan_id: planId,
            question_id: plan.question_id,
            quality,
            passed,
            ease_factor_before: plan.ease_factor,
            ease_factor_after: newEase,
            interval_before: plan.interval_days,
            interval_after: newInterval,
            repetitions_before: plan.repetitions,
            repetitions_after: newReps,
            user_answer: userAnswer,
            time_spent_seconds: timeSpentSeconds,
          }),
        );
        if (recordMastery && (tags !== null || operationId !== undefined) && this.mastery !== null && history.value !== null) {
          try {
            masteryState = this.mastery.recordQbankAnswerWithConn(
              tx, operationId ?? `review:${history.value.id}`, plan.question_id, tags ?? [], passed,
            );
          } catch (error) {
            if (operationId !== undefined) throw error;
            masteryState = null;
          }
        }
        return updated;
      }, { behavior: operationId === undefined ? 'deferred' : 'immediate' });
    } catch (error) {
      if (error instanceof ReviewPlanContextError) throw error;
      throw new Error('Failed to commit process_review transaction');
    }

    if (replayed) {
      const current = this.repos.reviewPlans.getPlan(this.db, planId);
      const priorHistory = this.repos.reviewPlans.getHistory(this.db, planId, 1)[0];
      if (current === null || priorHistory === undefined) throw new Error('Missing replayed sprint review');
      return { plan: current, passed: priorHistory.passed, new_interval: current.interval_days,
        next_review_date: current.next_review_date, history: priorHistory };
    }
    if (masteryState !== null && this.mastery !== null) {
      try {
        this.mastery.syncLearnerProfile(masteryState);
      } catch (error) {
        // Rust: sync 失败只告警；事件已在同一事务内提交。
        this.warn(`[ReviewPlanService] mastery profile reflux failed for plan ${planId}: ${errorText(error)}`);
      }
    }
    if (history.value === null || updatedPlan.value === null) {
      throw new Error(`Failed to record review history for plan: ${planId}`);
    }
    this.info(`[ReviewPlanService] Processed review: plan_id=${planId}, quality=${quality}, passed=${passed}, new_interval=${newInterval}, next_date=${nextReviewDate}`);
    return {
      plan: updatedPlan.value,
      passed,
      new_interval: newInterval,
      next_review_date: nextReviewDate,
      history: history.value,
    };
  }

  private calculateNewStatus(
    plan: ReviewPlan, passed: boolean, newInterval: number, newRepetitions: number,
  ): { status: ReviewPlanStatus; consecutiveFailures: number; isDifficult: boolean } {
    const consecutiveFailures = passed ? 0 : plan.consecutive_failures + 1;
    const isDifficult = consecutiveFailures >= this.config.difficult_threshold;
    let status: ReviewPlanStatus;
    if (plan.status === 'suspended') status = 'suspended';
    else if (newRepetitions === 0) status = 'new';
    else if (newRepetitions < 2) status = 'learning';
    else if (newInterval >= this.config.graduation_interval_threshold
      && newRepetitions >= this.config.graduation_repetitions_threshold) status = 'graduated';
    else status = 'reviewing';
    return { status, consecutiveFailures, isDifficult };
  }

  // ---------------------------------------------------------------- reads

  getDueReviews(examId: string | null, untilDate: string | null): DueReviewsResult {
    return withContext('Failed to list due reviews', () => this.repos.reviewPlans.listDueReviews(this.db, {
      exam_id: examId, until_date: untilDate, status: null, difficult_only: null,
      limit: 500, offset: null,
    }));
  }

  getDueReviewsWithFilter(filter: DueReviewsFilter): DueReviewsResult {
    return withContext('Failed to list due reviews with filter', () => this.repos.reviewPlans.listDueReviews(this.db, filter));
  }

  getReviewStats(examId: string | null): ReviewStats {
    return withContext(
      `Failed to get review stats for exam_id=${debugOption(examId)}`,
      () => this.repos.reviewPlans.getStats(this.db, examId),
    );
  }

  refreshReviewStats(examId: string | null): ReviewStats {
    return withContext(
      `Failed to refresh review stats for exam_id=${debugOption(examId)}`,
      () => this.repos.reviewPlans.refreshStats(this.db, examId),
    );
  }

  getPlanByQuestion(questionId: string): ReviewPlan | null {
    return withContext(
      `Failed to get review plan for question_id=${questionId}`,
      () => this.repos.reviewPlans.getPlanByQuestion(this.db, questionId),
    );
  }

  getPlan(planId: string): ReviewPlan | null {
    return withContext(
      `Failed to get review plan: ${planId}`,
      () => this.repos.reviewPlans.getPlan(this.db, planId),
    );
  }

  getReviewHistory(planId: string, limit: number | null): ReviewHistory[] {
    return withContext(
      `Failed to get review history for plan: ${planId}`,
      () => this.repos.reviewPlans.getHistory(this.db, planId, limit),
    );
  }

  listPlansByExam(examId: string, limit: number | null, offset: number | null): DueReviewsResult {
    return withContext(
      `Failed to list review plans for exam_id=${examId}`,
      () => this.repos.reviewPlans.listPlansByExam(this.db, examId, limit, offset),
    );
  }

  hasReviewPlan(questionId: string): boolean {
    return this.getPlanByQuestion(questionId) !== null;
  }

  getOrCreatePlan(questionId: string, examId: string): ReviewPlan {
    return this.getPlanByQuestion(questionId) ?? this.createReviewPlan(questionId, examId);
  }

  getCalendarData(
    startDate: string | null, endDate: string | null, examId: string | null,
  ): CalendarHeatmapData[] {
    return withContext('Failed to get calendar data',
      () => this.repos.reviewPlans.getCalendarData(this.db, startDate, endDate, examId));
  }

  // ---------------------------------------------------------------- mutate

  suspendPlan(planId: string): ReviewPlan {
    const plan = withContext(
      `Failed to suspend review plan: ${planId}`,
      () => this.repos.reviewPlans.suspendPlan(this.db, planId),
    );
    this.info(`[ReviewPlanService] Suspended review plan: ${planId}`);
    return plan;
  }

  suspendPlanIfUnchanged(planId: string, expectedUpdatedAt: string): ReviewPlan {
    const plan = withContext(
      `Failed to suspend review plan: ${planId}`,
      () => this.repos.reviewPlans.suspendPlanIfUnchanged(this.db, planId, expectedUpdatedAt),
    );
    this.info(`[ReviewPlanService] Suspended review plan: ${planId}`);
    return plan;
  }

  resumePlan(planId: string): ReviewPlan {
    const plan = withContext(
      `Failed to resume review plan: ${planId}`,
      () => this.repos.reviewPlans.resumePlan(this.db, planId),
    );
    this.info(`[ReviewPlanService] Resumed review plan: ${planId}`);
    return plan;
  }

  resumePlanIfUnchanged(planId: string, expectedUpdatedAt: string): ReviewPlan {
    const plan = withContext(
      `Failed to resume review plan: ${planId}`,
      () => this.repos.reviewPlans.resumePlanIfUnchanged(this.db, planId, expectedUpdatedAt),
    );
    this.info(`[ReviewPlanService] Resumed review plan: ${planId}`);
    return plan;
  }

  deletePlan(planId: string): void {
    withContext(
      `Failed to delete review plan: ${planId}`,
      () => this.repos.reviewPlans.deletePlan(this.db, planId),
    );
    this.info(`[ReviewPlanService] Deleted review plan: ${planId}`);
  }

  deletePlanIfUnchanged(planId: string, expectedUpdatedAt: string): void {
    withContext(
      `Failed to delete review plan: ${planId}`,
      () => this.repos.reviewPlans.deletePlanIfUnchanged(this.db, planId, expectedUpdatedAt),
    );
    this.info(`[ReviewPlanService] Deleted review plan: ${planId}`);
  }
}
