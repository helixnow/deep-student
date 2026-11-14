/**
 * L11 `vfsRepo` 的测试替身（仅测试使用）。
 *
 * 生产代码只经 L11 公开服务读写；本文件保留 `dstu-vfs/src/vfs/repos/review_plan_repo.rs`
 * 的等价 SQL，用于在单 lane 测试中驱动复习计划服务。
 */
import { nanoid } from 'nanoid';
import type { SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import type { Question } from '../../vfs-repos/api.ts';
import { errorText } from '../src/errors.ts';
import { localDateKey, utcNowRfc } from '../src/local-date.ts';
import type { ReviewPlanStore } from '../src/review-plan.ts';
import type {
  CalendarHeatmapData, DueReviewsFilter, DueReviewsResult, ReviewHistory, ReviewPlan,
  ReviewPlanStatus, ReviewStats,
} from '../src/review-plan-types.ts';

export class ReviewPlanAlreadyExistsError extends Error {
  readonly questionId: string;

  constructor(questionId: string) {
    super(`review_plan already exists: ${questionId}`);
    this.questionId = questionId;
    this.name = 'ReviewPlanAlreadyExistsError';
  }
}

export class ReviewPlanNotFoundError extends Error {
  readonly planId: string;

  constructor(planId: string) {
    super(`review_plan not found: ${planId}`);
    this.planId = planId;
    this.name = 'ReviewPlanNotFoundError';
  }
}

export class ReviewPlanConflictError extends Error {
  readonly planId: string;
  readonly expectedUpdatedAt: string;

  constructor(planId: string, expectedUpdatedAt: string) {
    super(`CONFLICT(review_plan.updated_at): REVIEW_CONFLICT: review plan ${planId} changed after revision ${expectedUpdatedAt} was read`);
    this.planId = planId;
    this.expectedUpdatedAt = expectedUpdatedAt;
    this.name = 'ReviewPlanConflictError';
  }
}

const PLAN_COLUMNS = `id, question_id, exam_id, ease_factor, interval_days, repetitions,
  next_review_date, last_review_date, status, total_reviews, total_correct,
  consecutive_failures, is_difficult, created_at, updated_at`;

function mapPlan(row: Record<string, unknown>): ReviewPlan {
  return {
    id: String(row.id),
    question_id: String(row.question_id),
    exam_id: String(row.exam_id),
    ease_factor: Number(row.ease_factor),
    interval_days: Number(row.interval_days),
    repetitions: Number(row.repetitions),
    next_review_date: String(row.next_review_date),
    last_review_date: row.last_review_date === null ? null : String(row.last_review_date),
    status: String(row.status) as ReviewPlanStatus,
    total_reviews: Number(row.total_reviews),
    total_correct: Number(row.total_correct),
    consecutive_failures: Number(row.consecutive_failures),
    is_difficult: Number(row.is_difficult) !== 0,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapHistory(row: Record<string, unknown>): ReviewHistory {
  return {
    id: String(row.id),
    plan_id: String(row.plan_id),
    question_id: String(row.question_id),
    quality: Number(row.quality),
    passed: Number(row.passed) !== 0,
    ease_factor_before: Number(row.ease_factor_before),
    ease_factor_after: Number(row.ease_factor_after),
    interval_before: Number(row.interval_before),
    interval_after: Number(row.interval_after),
    repetitions_before: Number(row.repetitions_before),
    repetitions_after: Number(row.repetitions_after),
    reviewed_at: String(row.reviewed_at),
    user_answer: row.user_answer === null ? null : String(row.user_answer),
    time_spent_seconds: row.time_spent_seconds === null ? null : Number(row.time_spent_seconds),
  };
}

function query<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    // Rust 仓储返回 VfsError；命令层只看到服务方法的 anyhow 最外层 context，
    // 因此这里保持普通 Error，由服务层补 context 字符串。
    throw new Error(errorText(error));
  }
}

// ------------------------------------------------------------------ questions

export function questionExamId(db: SqlExecutor, questionId: string): string | null {
  return query(() => {
    const row = db.get<{ exam_id: string }>(
      'SELECT exam_id FROM questions WHERE id = ?1 AND deleted_at IS NULL', [questionId],
    );
    return row === undefined ? null : String(row.exam_id);
  });
}

export function questionTags(db: SqlExecutor, questionId: string): string[] | null {
  return query(() => {
    const row = db.get<{ tags: string | null }>(
      'SELECT tags FROM questions WHERE id = ?1 AND deleted_at IS NULL', [questionId],
    );
    if (row === undefined) return null;
    if (row.tags === null) return [];
    try {
      const value: unknown = JSON.parse(String(row.tags));
      return Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : [];
    } catch {
      // Rust `row_to_question`：tags JSON 非法时按空标签处理。
      return [];
    }
  });
}

/** `VfsQuestionRepo::list_questions` 的默认筛选分页（page_size 被仓储夹紧到 100）。 */
export function listQuestionIdsForExam(
  db: SqlExecutor, examId: string, page: number, pageSize: number,
): { ids: string[]; hasMore: boolean } {
  return query(() => {
    const limit = Math.min(100, Math.max(1, pageSize));
    const offset = (Math.max(1, page) - 1) * limit;
    const total = Number(db.pluck<number>(
      'SELECT COUNT(*) FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL', [examId],
    ) ?? 0);
    const ids = db.all<{ id: string }>(
      `SELECT id FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL
       ORDER BY created_at ASC, id ASC LIMIT ?2 OFFSET ?3`, [examId, limit, offset],
    ).map(row => String(row.id));
    return { ids, hasMore: offset + limit < total };
  });
}

// ------------------------------------------------------------------ plans

export function getPlan(db: SqlExecutor, planId: string): ReviewPlan | null {
  const row = query(() => db.get<Record<string, unknown>>(
    `SELECT ${PLAN_COLUMNS} FROM review_plans WHERE id = ?1`, [planId],
  ));
  return row === undefined ? null : mapPlan(row);
}

export function getPlanByQuestion(db: SqlExecutor, questionId: string): ReviewPlan | null {
  const row = query(() => db.get<Record<string, unknown>>(
    `SELECT ${PLAN_COLUMNS} FROM review_plans WHERE question_id = ?1`, [questionId],
  ));
  return row === undefined ? null : mapPlan(row);
}

export function createPlan(
  db: SqlExecutor, questionId: string, examId: string, initialEaseFactor: number,
): ReviewPlan {
  if (getPlanByQuestion(db, questionId) !== null) throw new ReviewPlanAlreadyExistsError(questionId);
  const id = `rp_${nanoid(10)}`;
  const now = utcNowRfc();
  const today = localDateKey();
  query(() => db.run(
    `INSERT INTO review_plans (
       id, question_id, exam_id, ease_factor, interval_days, repetitions,
       next_review_date, last_review_date, status, total_reviews, total_correct,
       consecutive_failures, is_difficult, created_at, updated_at
     ) VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, NULL, 'new', 0, 0, 0, 0, ?6, ?6)`,
    [id, questionId, examId, initialEaseFactor, today, now],
  ));
  const plan = getPlan(db, id);
  if (plan === null) throw new ReviewPlanNotFoundError(id);
  return plan;
}

export interface UpdatePlanFields {
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review_date: string;
  last_review_date: string;
  status: ReviewPlanStatus;
  total_reviews: number;
  total_correct: number;
  consecutive_failures: number;
  is_difficult: boolean;
  expected_updated_at: string;
}

export function updatePlan(db: SqlExecutor, planId: string, fields: UpdatePlanFields): ReviewPlan {
  const now = utcNowRfc();
  const affected = query(() => db.run(
    `UPDATE review_plans SET
       ease_factor = ?1, interval_days = ?2, repetitions = ?3,
       next_review_date = ?4, last_review_date = ?5, status = ?6,
       total_reviews = ?7, total_correct = ?8, consecutive_failures = ?9,
       is_difficult = ?10, updated_at = ?11
     WHERE id = ?12 AND updated_at = ?13`,
    [
      fields.ease_factor, fields.interval_days, fields.repetitions,
      fields.next_review_date, fields.last_review_date, fields.status,
      fields.total_reviews, fields.total_correct, fields.consecutive_failures,
      fields.is_difficult ? 1 : 0, now, planId, fields.expected_updated_at,
    ],
  ).changes);
  if (affected === 0) throw new ReviewPlanConflictError(planId, fields.expected_updated_at);
  const plan = getPlan(db, planId);
  if (plan === null) throw new ReviewPlanNotFoundError(planId);
  return plan;
}

function resumedStatus(plan: ReviewPlan): ReviewPlanStatus {
  if (plan.repetitions === 0) return 'new';
  if (plan.repetitions < 2) return 'learning';
  if (plan.interval_days >= 21 && plan.repetitions >= 3) return 'graduated';
  return 'reviewing';
}

export function suspendPlan(db: SqlExecutor, planId: string): ReviewPlan {
  const now = utcNowRfc();
  const affected = query(() => db.run(
    "UPDATE review_plans SET status = 'suspended', updated_at = ?1 WHERE id = ?2", [now, planId],
  ).changes);
  if (affected === 0) throw new ReviewPlanNotFoundError(planId);
  const plan = getPlan(db, planId);
  if (plan === null) throw new ReviewPlanNotFoundError(planId);
  return plan;
}

export function suspendPlanIfUnchanged(
  db: SqlExecutor, planId: string, expectedUpdatedAt: string,
): ReviewPlan {
  const now = utcNowRfc();
  const affected = query(() => db.run(
    "UPDATE review_plans SET status = 'suspended', updated_at = ?1 WHERE id = ?2 AND updated_at = ?3",
    [now, planId, expectedUpdatedAt],
  ).changes);
  if (affected === 0) throw new ReviewPlanConflictError(planId, expectedUpdatedAt);
  const plan = getPlan(db, planId);
  if (plan === null) throw new ReviewPlanNotFoundError(planId);
  return plan;
}

export function resumePlan(db: SqlExecutor, planId: string): ReviewPlan {
  const plan = getPlan(db, planId);
  if (plan === null) throw new ReviewPlanNotFoundError(planId);
  const now = utcNowRfc();
  const today = localDateKey();
  query(() => db.run(
    'UPDATE review_plans SET status = ?1, next_review_date = ?2, updated_at = ?3 WHERE id = ?4',
    [resumedStatus(plan), today, now, planId],
  ));
  const updated = getPlan(db, planId);
  if (updated === null) throw new ReviewPlanNotFoundError(planId);
  return updated;
}

export function resumePlanIfUnchanged(
  db: SqlExecutor, planId: string, expectedUpdatedAt: string,
): ReviewPlan {
  const plan = getPlan(db, planId);
  if (plan === null) throw new ReviewPlanNotFoundError(planId);
  const now = utcNowRfc();
  const today = localDateKey();
  const affected = query(() => db.run(
    `UPDATE review_plans SET status = ?1, next_review_date = ?2, updated_at = ?3
     WHERE id = ?4 AND updated_at = ?5`,
    [resumedStatus(plan), today, now, planId, expectedUpdatedAt],
  ).changes);
  if (affected === 0) throw new ReviewPlanConflictError(planId, expectedUpdatedAt);
  const updated = getPlan(db, planId);
  if (updated === null) throw new ReviewPlanNotFoundError(planId);
  return updated;
}

export function deletePlan(db: SqlExecutor, planId: string): void {
  const affected = query(() => db.run('DELETE FROM review_plans WHERE id = ?1', [planId]).changes);
  if (affected === 0) throw new ReviewPlanNotFoundError(planId);
}

export function deletePlanIfUnchanged(
  db: SqlExecutor, planId: string, expectedUpdatedAt: string,
): void {
  const affected = query(() => db.run(
    'DELETE FROM review_plans WHERE id = ?1 AND updated_at = ?2', [planId, expectedUpdatedAt],
  ).changes);
  if (affected === 0) throw new ReviewPlanConflictError(planId, expectedUpdatedAt);
}

export interface RecordHistoryFields {
  plan_id: string;
  question_id: string;
  quality: number;
  passed: boolean;
  ease_factor_before: number;
  ease_factor_after: number;
  interval_before: number;
  interval_after: number;
  repetitions_before: number;
  repetitions_after: number;
  user_answer: string | null;
  time_spent_seconds: number | null;
}

export function recordHistory(db: SqlExecutor, fields: RecordHistoryFields): ReviewHistory {
  const id = `rh_${nanoid(10)}`;
  const now = utcNowRfc();
  query(() => db.run(
    `INSERT INTO review_history (
       id, plan_id, question_id, quality, passed,
       ease_factor_before, ease_factor_after, interval_before, interval_after,
       repetitions_before, repetitions_after, reviewed_at, user_answer, time_spent_seconds
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    [
      id, fields.plan_id, fields.question_id, fields.quality, fields.passed ? 1 : 0,
      fields.ease_factor_before, fields.ease_factor_after,
      fields.interval_before, fields.interval_after,
      fields.repetitions_before, fields.repetitions_after,
      now, fields.user_answer, fields.time_spent_seconds,
    ],
  ));
  return {
    id,
    plan_id: fields.plan_id,
    question_id: fields.question_id,
    quality: fields.quality,
    passed: fields.passed,
    ease_factor_before: fields.ease_factor_before,
    ease_factor_after: fields.ease_factor_after,
    interval_before: fields.interval_before,
    interval_after: fields.interval_after,
    repetitions_before: fields.repetitions_before,
    repetitions_after: fields.repetitions_after,
    reviewed_at: now,
    user_answer: fields.user_answer,
    time_spent_seconds: fields.time_spent_seconds,
  };
}

export function getHistory(db: SqlExecutor, planId: string, limit: number | null): ReviewHistory[] {
  return query(() => db.all<Record<string, unknown>>(
    `SELECT id, plan_id, question_id, quality, passed,
       ease_factor_before, ease_factor_after, interval_before, interval_after,
       repetitions_before, repetitions_after, reviewed_at, user_answer, time_spent_seconds
     FROM review_history WHERE plan_id = ?1 ORDER BY reviewed_at DESC LIMIT ?2`,
    [planId, limit ?? 100],
  ).map(mapHistory));
}

// ------------------------------------------------------------------ lists

export function listDueReviews(db: SqlExecutor, filter: DueReviewsFilter): DueReviewsResult {
  const untilDate = filter.until_date ?? localDateKey();
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  const conditions = ['next_review_date <= ?', "status != 'suspended'"];
  const params: SqlParam[] = [untilDate];
  if (filter.exam_id !== null && filter.exam_id !== undefined) {
    conditions.push('exam_id = ?');
    params.push(filter.exam_id);
  }
  if (filter.status !== null && filter.status !== undefined && filter.status.length > 0) {
    conditions.push(`status IN (${filter.status.map(() => '?').join(', ')})`);
    params.push(...filter.status);
  }
  if (filter.difficult_only === true) conditions.push('is_difficult = 1');
  const where = conditions.join(' AND ');
  const total = query(() => Number(db.pluck<number>(
    `SELECT COUNT(*) FROM review_plans WHERE ${where}`, params,
  ) ?? 0));
  const plans = query(() => db.all<Record<string, unknown>>(
    `SELECT ${PLAN_COLUMNS} FROM review_plans WHERE ${where}
     ORDER BY next_review_date ASC, is_difficult DESC, consecutive_failures DESC
     LIMIT ? OFFSET ?`, [...params, limit, offset],
  ).map(mapPlan));
  return { plans, total, has_more: offset + limit < total };
}

export function listPlansByExam(
  db: SqlExecutor, examId: string, limit: number | null, offset: number | null,
): DueReviewsResult {
  const size = limit ?? 100;
  const start = offset ?? 0;
  const total = query(() => Number(db.pluck<number>(
    'SELECT COUNT(*) FROM review_plans WHERE exam_id = ?1', [examId],
  ) ?? 0));
  const plans = query(() => db.all<Record<string, unknown>>(
    `SELECT ${PLAN_COLUMNS} FROM review_plans WHERE exam_id = ?1
     ORDER BY next_review_date ASC LIMIT ?2 OFFSET ?3`, [examId, size, start],
  ).map(mapPlan));
  return { plans, total, has_more: start + size < total };
}

// ------------------------------------------------------------------ stats

export function getStats(db: SqlExecutor, examId: string | null): ReviewStats {
  const today = localDateKey();
  const now = utcNowRfc();
  const where = examId === null ? '' : 'WHERE exam_id = ?1';
  const params: SqlParam[] = examId === null ? [today] : [examId, today];
  const sql = `SELECT
      COUNT(*) AS total_plans,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_count,
      SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END) AS learning_count,
      SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) AS reviewing_count,
      SUM(CASE WHEN status = 'graduated' THEN 1 ELSE 0 END) AS graduated_count,
      SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended_count,
      SUM(CASE WHEN next_review_date <= ?${examId === null ? 1 : 2} AND status != 'suspended' THEN 1 ELSE 0 END) AS due_today,
      SUM(CASE WHEN next_review_date < ?${examId === null ? 1 : 2} AND status != 'suspended' THEN 1 ELSE 0 END) AS overdue_count,
      SUM(CASE WHEN is_difficult = 1 THEN 1 ELSE 0 END) AS difficult_count,
      SUM(total_reviews) AS total_reviews,
      SUM(total_correct) AS total_correct,
      AVG(ease_factor) AS avg_ease_factor
    FROM review_plans ${where}`;
  const row = query(() => db.one<Record<string, unknown>>(sql, params));
  const num = (value: unknown): number => value === null || value === undefined ? 0 : Number(value);
  const totalReviews = num(row.total_reviews);
  const totalCorrect = num(row.total_correct);
  return {
    exam_id: examId,
    total_plans: num(row.total_plans),
    new_count: num(row.new_count),
    learning_count: num(row.learning_count),
    reviewing_count: num(row.reviewing_count),
    graduated_count: num(row.graduated_count),
    suspended_count: num(row.suspended_count),
    due_today: num(row.due_today),
    overdue_count: num(row.overdue_count),
    difficult_count: num(row.difficult_count),
    total_reviews: totalReviews,
    total_correct: totalCorrect,
    avg_correct_rate: totalReviews > 0 ? totalCorrect / totalReviews : 0,
    avg_ease_factor: row.avg_ease_factor === null || row.avg_ease_factor === undefined
      ? 2.5 : Number(row.avg_ease_factor),
    updated_at: now,
  };
}

export function refreshStats(db: SqlExecutor, examId: string | null): ReviewStats {
  const stats = getStats(db, examId);
  query(() => db.run(
    `INSERT INTO review_stats (
       exam_id, total_plans, new_count, learning_count, reviewing_count,
       graduated_count, suspended_count, due_today, overdue_count, difficult_count,
       total_reviews, total_correct, avg_correct_rate, avg_ease_factor, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT(exam_id) DO UPDATE SET
       total_plans = excluded.total_plans,
       new_count = excluded.new_count,
       learning_count = excluded.learning_count,
       reviewing_count = excluded.reviewing_count,
       graduated_count = excluded.graduated_count,
       suspended_count = excluded.suspended_count,
       due_today = excluded.due_today,
       overdue_count = excluded.overdue_count,
       difficult_count = excluded.difficult_count,
       total_reviews = excluded.total_reviews,
       total_correct = excluded.total_correct,
       avg_correct_rate = excluded.avg_correct_rate,
       avg_ease_factor = excluded.avg_ease_factor,
       updated_at = excluded.updated_at`,
    [
      stats.exam_id, stats.total_plans, stats.new_count, stats.learning_count,
      stats.reviewing_count, stats.graduated_count, stats.suspended_count,
      stats.due_today, stats.overdue_count, stats.difficult_count,
      stats.total_reviews, stats.total_correct, stats.avg_correct_rate,
      stats.avg_ease_factor, stats.updated_at,
    ],
  ));
  return stats;
}

export function getCalendarData(
  db: SqlExecutor, startDate: string | null, endDate: string | null, examId: string | null,
): CalendarHeatmapData[] {
  const conditions: string[] = [];
  const params: SqlParam[] = [];
  if (startDate !== null) { conditions.push('DATE(rh.reviewed_at) >= ?'); params.push(startDate); }
  if (endDate !== null) { conditions.push('DATE(rh.reviewed_at) <= ?'); params.push(endDate); }
  if (examId !== null) { conditions.push('rp.exam_id = ?'); params.push(examId); }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  return query(() => db.all<Record<string, unknown>>(
    `SELECT DATE(rh.reviewed_at) AS review_date,
       COUNT(*) AS total_count,
       SUM(CASE WHEN rh.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
       SUM(CASE WHEN rh.passed = 0 THEN 1 ELSE 0 END) AS failed_count
     FROM review_history rh INNER JOIN review_plans rp ON rh.plan_id = rp.id
     ${where}
     GROUP BY DATE(rh.reviewed_at) ORDER BY review_date ASC`, params,
  ).map(row => ({
    date: String(row.review_date),
    count: Number(row.total_count),
    passed: Number(row.passed_count ?? 0),
    failed: Number(row.failed_count ?? 0),
  })));
}

// ------------------------------------------------------------------ service double

/** 构造 L11 `vfsRepo` 的测试替身，供 ReviewPlanService 直接使用。 */
export function createReviewPlanStore(): ReviewPlanStore {
  return {
    questions: {
      getQuestion(conn, id) {
        const examId = questionExamId(conn, id);
        if (examId === null) return null;
        return { id, exam_id: examId, tags: questionTags(conn, id) ?? [] } as Question;
      },
      listQuestions(conn, examId, _filters, page, pageSize) {
        const result = listQuestionIdsForExam(conn, examId, page, pageSize);
        return {
          questions: result.ids.map(id => ({ id } as Question)),
          total: result.ids.length,
          page,
          page_size: Math.min(100, Math.max(1, pageSize)),
          has_more: result.hasMore,
        };
      },
    },
    reviewPlans: {
      createPlan(conn, params) {
        return createPlan(conn, params.question_id, params.exam_id, params.initial_ease_factor ?? 2.5);
      },
      getPlan,
      getPlanByQuestion,
      listDueReviews,
      listPlansByExam,
      updatePlan,
      suspendPlan,
      suspendPlanIfUnchanged,
      resumePlan,
      resumePlanIfUnchanged,
      deletePlan,
      deletePlanIfUnchanged,
      deletePlanByQuestion(conn, questionId) {
        query(() => conn.run('DELETE FROM review_plans WHERE question_id = ?1', [questionId]));
      },
      recordHistory(conn, params) {
        return recordHistory(conn, {
          ...params,
          user_answer: params.user_answer ?? null,
          time_spent_seconds: params.time_spent_seconds ?? null,
        });
      },
      getHistory(conn, planId, limit) {
        return getHistory(conn, planId, limit ?? null);
      },
      getStats,
      refreshStats,
      getCalendarData,
    },
  };
}
