/** Port of dstu-vfs review_plan_repo.rs. All functions take the caller's connection. */
import { logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type CalendarHeatmapData,
  type CreateReviewPlanParams,
  type DueReviewsFilter,
  type DueReviewsResult,
  type RecordReviewHistoryParams,
  type ReviewHistory,
  type ReviewPlan,
  type ReviewPlanRepository,
  type ReviewPlanStatus,
  type ReviewStats,
  type UpdateReviewPlanParams,
} from '../api.ts';
import { databaseResult } from './errors.ts';
import { utcNow } from './timestamps.ts';

const DEFAULT_EASE_FACTOR = 2.5;
const PLAN_COLUMNS = `id, question_id, exam_id, ease_factor, interval_days, repetitions,
  next_review_date, last_review_date, status, total_reviews, total_correct,
  consecutive_failures, is_difficult, created_at, updated_at`;

function todayLocal(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
function alreadyExists(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_ALREADY_EXISTS', `${resourceType} already exists: ${id}`, { resourceType, id });
}
function revisionConflict(planId: string, expectedUpdatedAt: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_CONFLICT',
    `CONFLICT(review_plan.updated_at): REVIEW_CONFLICT: review plan ${planId} changed after revision ${expectedUpdatedAt} was read`,
    { key: 'review_plan.updated_at' });
}

function toNumber(value: SqlValue | undefined): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number') throw new VfsRepositoryError('VFS_STORAGE', 'Database error: Invalid column type');
  return number;
}
function optionalNumber(value: SqlValue | undefined): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' ? number : null;
}
function optionalText(value: SqlValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function statusFrom(value: string): ReviewPlanStatus {
  switch (value) {
    case 'new': case 'learning': case 'reviewing': case 'graduated': case 'suspended':
      return value;
    default: return 'new';
  }
}

function rowToPlan(row: Row): ReviewPlan {
  return {
    id: String(row.id),
    question_id: String(row.question_id),
    exam_id: String(row.exam_id),
    ease_factor: toNumber(row.ease_factor),
    interval_days: toNumber(row.interval_days),
    repetitions: toNumber(row.repetitions),
    next_review_date: String(row.next_review_date),
    last_review_date: optionalText(row.last_review_date),
    status: statusFrom(String(row.status)),
    total_reviews: toNumber(row.total_reviews),
    total_correct: toNumber(row.total_correct),
    consecutive_failures: toNumber(row.consecutive_failures),
    is_difficult: toNumber(row.is_difficult) !== 0,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToHistory(row: Row): ReviewHistory {
  return {
    id: String(row.id),
    plan_id: String(row.plan_id),
    question_id: String(row.question_id),
    quality: toNumber(row.quality),
    passed: toNumber(row.passed) !== 0,
    ease_factor_before: toNumber(row.ease_factor_before),
    ease_factor_after: toNumber(row.ease_factor_after),
    interval_before: toNumber(row.interval_before),
    interval_after: toNumber(row.interval_after),
    repetitions_before: toNumber(row.repetitions_before),
    repetitions_after: toNumber(row.repetitions_after),
    reviewed_at: String(row.reviewed_at),
    user_answer: optionalText(row.user_answer),
    time_spent_seconds: optionalNumber(row.time_spent_seconds),
  };
}

function mapRows<T>(rows: readonly Row[], map: (row: Row) => T): T[] {
  const result: T[] = [];
  for (const row of rows) {
    try { result.push(map(row)); }
    catch (error) { logWarn('[VFS::ReviewPlanRepo] Row parse error (skipped):', error); }
  }
  return result;
}

function resumedStatus(plan: ReviewPlan): ReviewPlanStatus {
  if (plan.repetitions === 0) return 'new';
  if (plan.repetitions < 2) return 'learning';
  if (plan.interval_days >= 21 && plan.repetitions >= 3) return 'graduated';
  return 'reviewing';
}

export class ReviewPlanRepo implements ReviewPlanRepository {
  createPlan(conn: SqlExecutor, params: CreateReviewPlanParams): ReviewPlan {
    return databaseResult(() => {
      if (this.getPlanByQuestion(conn, params.question_id) !== null) {
        throw alreadyExists('review_plan', params.question_id);
      }
      const planId = `rp_${nanoid(10)}`;
      const now = utcNow();
      const today = todayLocal();
      const easeFactor = params.initial_ease_factor ?? DEFAULT_EASE_FACTOR;
      conn.run(`INSERT INTO review_plans (
          id, question_id, exam_id, ease_factor, interval_days, repetitions,
          next_review_date, last_review_date, status, total_reviews, total_correct,
          consecutive_failures, is_difficult, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 0, 0, ?5, NULL, 'new', 0, 0, 0, 0, ?6, ?6)`,
      [planId, params.question_id, params.exam_id, easeFactor, today, now]);
      const plan = this.getPlan(conn, planId);
      if (plan === null) throw notFound('review_plan', planId);
      return plan;
    });
  }

  getPlan(conn: SqlExecutor, planId: string): ReviewPlan | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${PLAN_COLUMNS} FROM review_plans WHERE id = ?1`, [planId]);
      return row === undefined ? null : rowToPlan(row);
    });
  }

  getPlanByQuestion(conn: SqlExecutor, questionId: string): ReviewPlan | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${PLAN_COLUMNS} FROM review_plans WHERE question_id = ?1`,
        [questionId]);
      return row === undefined ? null : rowToPlan(row);
    });
  }

  listDueReviews(conn: SqlExecutor, filter: DueReviewsFilter): DueReviewsResult {
    return databaseResult(() => {
      const today = todayLocal();
      const untilDate = filter.until_date ?? today;
      const limit = filter.limit ?? 50;
      const offset = filter.offset ?? 0;

      const conditions = ['next_review_date <= ?1'];
      const params: (string | number)[] = [untilDate];
      let paramIndex = 2;
      conditions.push("status != 'suspended'");

      if (filter.exam_id !== undefined && filter.exam_id !== null) {
        conditions.push(`exam_id = ?${paramIndex}`);
        params.push(filter.exam_id);
        paramIndex += 1;
      }
      if (filter.status !== undefined && filter.status !== null && filter.status.length > 0) {
        const placeholders = filter.status.map((_, index) => `?${paramIndex + index}`);
        conditions.push(`status IN (${placeholders.join(', ')})`);
        for (const status of filter.status) params.push(status);
        paramIndex += filter.status.length;
      }
      if (filter.difficult_only === true) conditions.push('is_difficult = 1');

      const whereClause = conditions.join(' AND ');
      const total = Number(conn.pluck<number>(
        `SELECT COUNT(*) FROM review_plans WHERE ${whereClause}`, params) ?? 0);

      const rows = conn.all<Row>(`
        SELECT ${PLAN_COLUMNS}
        FROM review_plans
        WHERE ${whereClause}
        ORDER BY next_review_date ASC, is_difficult DESC, consecutive_failures DESC
        LIMIT ?${paramIndex} OFFSET ?${paramIndex + 1}`,
      [...params, limit, offset]);
      return {
        plans: mapRows(rows, rowToPlan),
        total,
        has_more: offset + limit < total,
      };
    });
  }

  listPlansByExam(conn: SqlExecutor, examId: string, limit?: number | null,
    offset?: number | null): DueReviewsResult {
    return databaseResult(() => {
      const boundedLimit = limit ?? 100;
      const boundedOffset = offset ?? 0;
      const total = Number(conn.pluck<number>(
        'SELECT COUNT(*) FROM review_plans WHERE exam_id = ?1', [examId]) ?? 0);
      const rows = conn.all<Row>(`
        SELECT ${PLAN_COLUMNS}
        FROM review_plans
        WHERE exam_id = ?1
        ORDER BY next_review_date ASC
        LIMIT ?2 OFFSET ?3`, [examId, boundedLimit, boundedOffset]);
      return {
        plans: mapRows(rows, rowToPlan),
        total,
        has_more: boundedOffset + boundedLimit < total,
      };
    });
  }

  updatePlan(conn: SqlExecutor, planId: string, params: UpdateReviewPlanParams): ReviewPlan {
    return databaseResult(() => {
      const now = utcNow();
      const affected = conn.run(`UPDATE review_plans SET
          ease_factor = ?1,
          interval_days = ?2,
          repetitions = ?3,
          next_review_date = ?4,
          last_review_date = ?5,
          status = ?6,
          total_reviews = ?7,
          total_correct = ?8,
          consecutive_failures = ?9,
          is_difficult = ?10,
          updated_at = ?11
        WHERE id = ?12 AND updated_at = ?13`,
      [params.ease_factor, params.interval_days, params.repetitions,
        params.next_review_date, params.last_review_date, params.status,
        params.total_reviews, params.total_correct, params.consecutive_failures,
        params.is_difficult ? 1 : 0, now, planId, params.expected_updated_at]).changes;
      if (affected === 0) throw revisionConflict(planId, params.expected_updated_at);
      const plan = this.getPlan(conn, planId);
      if (plan === null) throw notFound('review_plan', planId);
      return plan;
    });
  }

  suspendPlan(conn: SqlExecutor, planId: string): ReviewPlan {
    return databaseResult(() => {
      const now = utcNow();
      const affected = conn.run(
        "UPDATE review_plans SET status = 'suspended', updated_at = ?1 WHERE id = ?2",
        [now, planId]).changes;
      if (affected === 0) throw notFound('review_plan', planId);
      const plan = this.getPlan(conn, planId);
      if (plan === null) throw notFound('review_plan', planId);
      return plan;
    });
  }

  suspendPlanIfUnchanged(conn: SqlExecutor, planId: string, expectedUpdatedAt: string): ReviewPlan {
    return databaseResult(() => {
      const now = utcNow();
      const affected = conn.run(
        "UPDATE review_plans SET status = 'suspended', updated_at = ?1 WHERE id = ?2 AND updated_at = ?3",
        [now, planId, expectedUpdatedAt]).changes;
      if (affected === 0) throw revisionConflict(planId, expectedUpdatedAt);
      const plan = this.getPlan(conn, planId);
      if (plan === null) throw notFound('review_plan', planId);
      return plan;
    });
  }

  resumePlan(conn: SqlExecutor, planId: string): ReviewPlan {
    return databaseResult(() => {
      const plan = this.getPlan(conn, planId);
      if (plan === null) throw notFound('review_plan', planId);
      const now = utcNow();
      const today = todayLocal();
      const newStatus = resumedStatus(plan);
      conn.run(
        'UPDATE review_plans SET status = ?1, next_review_date = ?2, updated_at = ?3 WHERE id = ?4',
        [newStatus, today, now, planId]);
      const updated = this.getPlan(conn, planId);
      if (updated === null) throw notFound('review_plan', planId);
      return updated;
    });
  }

  resumePlanIfUnchanged(conn: SqlExecutor, planId: string, expectedUpdatedAt: string): ReviewPlan {
    return databaseResult(() => {
      const plan = this.getPlan(conn, planId);
      if (plan === null) throw notFound('review_plan', planId);
      const now = utcNow();
      const today = todayLocal();
      const newStatus = resumedStatus(plan);
      const affected = conn.run(
        'UPDATE review_plans SET status = ?1, next_review_date = ?2, updated_at = ?3 WHERE id = ?4 AND updated_at = ?5',
        [newStatus, today, now, planId, expectedUpdatedAt]).changes;
      if (affected === 0) throw revisionConflict(planId, expectedUpdatedAt);
      const updated = this.getPlan(conn, planId);
      if (updated === null) throw notFound('review_plan', planId);
      return updated;
    });
  }

  deletePlan(conn: SqlExecutor, planId: string): void {
    databaseResult(() => {
      const affected = conn.run('DELETE FROM review_plans WHERE id = ?1', [planId]).changes;
      if (affected === 0) throw notFound('review_plan', planId);
    });
  }

  deletePlanIfUnchanged(conn: SqlExecutor, planId: string, expectedUpdatedAt: string): void {
    databaseResult(() => {
      const affected = conn.run(
        'DELETE FROM review_plans WHERE id = ?1 AND updated_at = ?2', [planId, expectedUpdatedAt]).changes;
      if (affected === 0) throw revisionConflict(planId, expectedUpdatedAt);
    });
  }

  deletePlanByQuestion(conn: SqlExecutor, questionId: string): void {
    databaseResult(() => {
      conn.run('DELETE FROM review_plans WHERE question_id = ?1', [questionId]);
    });
  }

  recordHistory(conn: SqlExecutor, params: RecordReviewHistoryParams): ReviewHistory {
    return databaseResult(() => {
      const id = `rh_${nanoid(10)}`;
      const now = utcNow();
      conn.run(`INSERT INTO review_history (
          id, plan_id, question_id, quality, passed,
          ease_factor_before, ease_factor_after, interval_before, interval_after,
          repetitions_before, repetitions_after, reviewed_at, user_answer, time_spent_seconds
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      [id, params.plan_id, params.question_id, params.quality, params.passed ? 1 : 0,
        params.ease_factor_before, params.ease_factor_after, params.interval_before,
        params.interval_after, params.repetitions_before, params.repetitions_after,
        now, params.user_answer ?? null, params.time_spent_seconds ?? null]);
      return {
        id,
        plan_id: params.plan_id,
        question_id: params.question_id,
        quality: params.quality,
        passed: params.passed,
        ease_factor_before: params.ease_factor_before,
        ease_factor_after: params.ease_factor_after,
        interval_before: params.interval_before,
        interval_after: params.interval_after,
        repetitions_before: params.repetitions_before,
        repetitions_after: params.repetitions_after,
        reviewed_at: now,
        user_answer: params.user_answer ?? null,
        time_spent_seconds: params.time_spent_seconds ?? null,
      };
    });
  }

  getHistory(conn: SqlExecutor, planId: string, limit?: number | null): ReviewHistory[] {
    return databaseResult(() => {
      const boundedLimit = limit ?? 100;
      const rows = conn.all<Row>(`
        SELECT id, plan_id, question_id, quality, passed,
               ease_factor_before, ease_factor_after, interval_before, interval_after,
               repetitions_before, repetitions_after, reviewed_at, user_answer, time_spent_seconds
        FROM review_history
        WHERE plan_id = ?1
        ORDER BY reviewed_at DESC
        LIMIT ?2`, [planId, boundedLimit]);
      return mapRows(rows, rowToHistory);
    });
  }

  getStats(conn: SqlExecutor, examId: string | null): ReviewStats {
    return databaseResult(() => {
      const today = todayLocal();
      const now = utcNow();
      const whereClause = examId === null ? '' : 'WHERE exam_id = ?1';
      const todayParamIndex = examId === null ? 1 : 2;
      const params: string[] = examId === null ? [today] : [examId, today];
      const sql = `
        SELECT
            COUNT(*) as total_plans,
            SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
            SUM(CASE WHEN status = 'learning' THEN 1 ELSE 0 END) as learning_count,
            SUM(CASE WHEN status = 'reviewing' THEN 1 ELSE 0 END) as reviewing_count,
            SUM(CASE WHEN status = 'graduated' THEN 1 ELSE 0 END) as graduated_count,
            SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) as suspended_count,
            SUM(CASE WHEN next_review_date <= ?${todayParamIndex} AND status != 'suspended' THEN 1 ELSE 0 END) as due_today,
            SUM(CASE WHEN next_review_date < ?${todayParamIndex} AND status != 'suspended' THEN 1 ELSE 0 END) as overdue_count,
            SUM(CASE WHEN is_difficult = 1 THEN 1 ELSE 0 END) as difficult_count,
            SUM(total_reviews) as total_reviews,
            SUM(total_correct) as total_correct,
            AVG(ease_factor) as avg_ease_factor
        FROM review_plans
        ${whereClause}`;
      const row = conn.get<Row>(sql, params);
      if (row === undefined) throw new VfsRepositoryError('VFS_STORAGE', 'Database error: query returned no rows');
      const totalPlans = Number(row.total_plans ?? 0);
      const newCount = Number(row.new_count ?? 0);
      const learningCount = Number(row.learning_count ?? 0);
      const reviewingCount = Number(row.reviewing_count ?? 0);
      const graduatedCount = Number(row.graduated_count ?? 0);
      const suspendedCount = Number(row.suspended_count ?? 0);
      const dueToday = Number(row.due_today ?? 0);
      const overdueCount = Number(row.overdue_count ?? 0);
      const difficultCount = Number(row.difficult_count ?? 0);
      const totalReviews = Number(row.total_reviews ?? 0);
      const totalCorrect = Number(row.total_correct ?? 0);
      const avgEaseFactor = row.avg_ease_factor === null || row.avg_ease_factor === undefined
        ? 2.5 : Number(row.avg_ease_factor);
      return {
        exam_id: examId,
        total_plans: totalPlans,
        new_count: newCount,
        learning_count: learningCount,
        reviewing_count: reviewingCount,
        graduated_count: graduatedCount,
        suspended_count: suspendedCount,
        due_today: dueToday,
        overdue_count: overdueCount,
        difficult_count: difficultCount,
        total_reviews: totalReviews,
        total_correct: totalCorrect,
        avg_correct_rate: totalReviews > 0 ? totalCorrect / totalReviews : 0,
        avg_ease_factor: avgEaseFactor,
        updated_at: now,
      };
    });
  }

  refreshStats(conn: SqlExecutor, examId: string | null): ReviewStats {
    return databaseResult(() => {
      const stats = this.getStats(conn, examId);
      conn.run(`INSERT INTO review_stats (
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
      [stats.exam_id, stats.total_plans, stats.new_count, stats.learning_count,
        stats.reviewing_count, stats.graduated_count, stats.suspended_count,
        stats.due_today, stats.overdue_count, stats.difficult_count,
        stats.total_reviews, stats.total_correct, stats.avg_correct_rate,
        stats.avg_ease_factor, stats.updated_at]);
      return stats;
    });
  }

  getCalendarData(conn: SqlExecutor, startDate: string | null, endDate: string | null,
    examId: string | null): CalendarHeatmapData[] {
    return databaseResult(() => {
      const conditions: string[] = [];
      const params: string[] = [];
      if (startDate !== null) {
        params.push(startDate);
        conditions.push(`DATE(rh.reviewed_at) >= ?${params.length}`);
      }
      if (endDate !== null) {
        params.push(endDate);
        conditions.push(`DATE(rh.reviewed_at) <= ?${params.length}`);
      }
      if (examId !== null) {
        params.push(examId);
        conditions.push(`rp.exam_id = ?${params.length}`);
      }
      const whereClause = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      const rows = conn.all<Row>(`
        SELECT
            DATE(rh.reviewed_at) as review_date,
            COUNT(*) as total_count,
            SUM(CASE WHEN rh.passed = 1 THEN 1 ELSE 0 END) as passed_count,
            SUM(CASE WHEN rh.passed = 0 THEN 1 ELSE 0 END) as failed_count
        FROM review_history rh
        INNER JOIN review_plans rp ON rh.plan_id = rp.id
        ${whereClause}
        GROUP BY DATE(rh.reviewed_at)
        ORDER BY review_date ASC`, params);
      return mapRows(rows, row => ({
        date: String(row.review_date),
        count: Number(row.total_count ?? 0),
        passed: Number(row.passed_count ?? 0),
        failed: Number(row.failed_count ?? 0),
      }));
    });
  }
}
