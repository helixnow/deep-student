/** Read-only aggregate SQL for question_bank_service.rs statistics. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface DailyActivityRow { date: string; count: number; correct_count: number }

const activityUnion = (condition: string, startIndex: number, endIndex: number,
  endOperator: '<=' | '<'): string => `
  SELECT date, COUNT(*) AS count, SUM(correct) AS correct_count FROM (
    SELECT DATE(s.submitted_at, 'localtime') AS date, s.question_id,
      MAX(CASE WHEN s.is_correct = 1 THEN 1 ELSE 0 END) AS correct
    FROM answer_submissions s
    INNER JOIN questions q ON q.id = s.question_id
    WHERE ${condition}
    GROUP BY DATE(s.submitted_at, 'localtime'), s.question_id
    UNION ALL
    SELECT DATE(q.last_attempt_at, 'localtime') AS date, q.id,
      CASE WHEN q.is_correct = 1 THEN 1 ELSE 0 END AS correct
    FROM questions q
    WHERE ${condition}
      AND q.last_attempt_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM answer_submissions s2 WHERE s2.question_id = q.id)
  )
  WHERE date >= ?${startIndex} AND date ${endOperator} ?${endIndex}
  GROUP BY date ORDER BY date ASC`;

export function activityBetween(db: SqlExecutor, examId: string | null, start: string, end: string): DailyActivityRow[] {
  const condition = examId === null ? 'q.deleted_at IS NULL' : 'q.exam_id = ?1 AND q.deleted_at IS NULL';
  return examId === null
    ? db.all<DailyActivityRow>(activityUnion(condition, 1, 2, '<='), [start, end])
    : db.all<DailyActivityRow>(activityUnion(condition, 2, 3, '<='), [examId, start, end]);
}

export interface KnowledgeRow {
  tag: string; total: number; mastered: number; in_progress: number; review: number;
  new_count: number; total_attempts: number; total_correct: number;
}

export function knowledgeRows(db: SqlExecutor, examId: string | null): KnowledgeRow[] {
  const condition = examId === null ? 'questions.deleted_at IS NULL' : 'questions.exam_id = ?1 AND questions.deleted_at IS NULL';
  return db.all<KnowledgeRow>(`SELECT json_each.value AS tag, COUNT(*) AS total,
      SUM(CASE WHEN questions.status = 'mastered' THEN 1 ELSE 0 END) AS mastered,
      SUM(CASE WHEN questions.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN questions.status = 'review' THEN 1 ELSE 0 END) AS review,
      SUM(CASE WHEN questions.status = 'new' THEN 1 ELSE 0 END) AS new_count,
      SUM(questions.attempt_count) AS total_attempts,
      SUM(questions.correct_count) AS total_correct
    FROM questions, json_each(questions.tags)
    WHERE ${condition}
    GROUP BY json_each.value HAVING total >= 1 ORDER BY total DESC LIMIT 10`,
  examId === null ? [] : [examId]);
}

export interface TrendRow { date: string; attempt_count: number; correct_count: number }

export function trendBetween(db: SqlExecutor, examId: string | null, start: string, end: string): TrendRow[] {
  const condition = examId === null ? 'q.deleted_at IS NULL' : 'q.exam_id = ? AND q.deleted_at IS NULL';
  const params = examId === null ? [start, end] : [examId, start, end];
  return db.all<TrendRow>(`SELECT DATE(s.submitted_at, 'localtime') AS date,
      COUNT(*) AS attempt_count,
      SUM(CASE WHEN s.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
    FROM answer_submissions s
    INNER JOIN questions q ON s.question_id = q.id
    WHERE ${condition} AND s.submitted_at IS NOT NULL
      AND DATE(s.submitted_at, 'localtime') >= ? AND DATE(s.submitted_at, 'localtime') <= ?
    GROUP BY DATE(s.submitted_at, 'localtime') ORDER BY date ASC`, params);
}

export function streakDates(db: SqlExecutor, examId: string | null, today: string): string[] {
  const condition = examId === null ? 'q.deleted_at IS NULL' : 'q.exam_id = ?1 AND q.deleted_at IS NULL';
  const dateIndex = examId === null ? 1 : 2;
  return db.all<{ date: string }>(`SELECT DISTINCT date FROM (
      SELECT DATE(s.submitted_at, 'localtime') AS date
      FROM answer_submissions s
      INNER JOIN questions q ON q.id = s.question_id
      WHERE ${condition}
      UNION
      SELECT DATE(q.last_attempt_at, 'localtime') AS date
      FROM questions q
      WHERE ${condition} AND q.last_attempt_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM answer_submissions s2 WHERE s2.question_id = q.id)
    )
    WHERE date IS NOT NULL AND date <= ?${dateIndex}
    ORDER BY date DESC LIMIT 3700`,
  examId === null ? [today] : [examId, today]).map(row => row.date);
}

export function checkInRows(db: SqlExecutor, examId: string | null, start: string, endExclusive: string): DailyActivityRow[] {
  const condition = examId === null ? 'q.deleted_at IS NULL' : 'q.exam_id = ?1 AND q.deleted_at IS NULL';
  return examId === null
    ? db.all<DailyActivityRow>(activityUnion(condition, 1, 2, '<'), [start, endExclusive])
    : db.all<DailyActivityRow>(activityUnion(condition, 2, 3, '<'), [examId, start, endExclusive]);
}

export function focusSecondsByLocalDate(db: SqlExecutor, start: string, endExclusive: string,
  log?: import('../src/ports.ts').QbankLogger): Map<string, number> {
  let rows: { date: string; seconds: number }[];
  try {
    rows = db.all<{ date: string; seconds: number }>(`SELECT DATE(created_at, 'localtime') AS date,
        SUM(actual_duration) AS seconds
      FROM pomodoro_records
      WHERE type = 'work' AND status IN ('completed', 'interrupted')
        AND DATE(created_at, 'localtime') >= ?1 AND DATE(created_at, 'localtime') < ?2
        AND deleted_at IS NULL
      GROUP BY DATE(created_at, 'localtime')`, [start, endExclusive]);
  } catch (error) {
    // question_bank_service.rs:3054：番茄专注读取失败不影响打卡日历
    log?.warn(`[QuestionBankService] pomodoro focus lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
  return new Map(rows.map(row => [row.date, Math.max(0, row.seconds)]));
}
