/**
 * `commands.rs:8244 get_learning_heatmap` 的日期分组查询。
 *
 * Rust 的 `query_date_counts` 对准备/执行失败的查询一律 `unwrap_or_default()`（返回空表），
 * 这里保持同样行为：单条统计失败不影响其它数据源。
 */
import type { DatabaseHandle } from '../../../platform/storage/api.ts';

export function queryDateCounts(
  db: DatabaseHandle, sql: string, start: string, end: string,
): Array<[string, number]> {
  try {
    const rows = db.all<{ date: unknown; count: unknown }>(sql, [start, end]);
    const result: Array<[string, number]> = [];
    for (const row of rows) {
      if (typeof row.date === 'string' && typeof row.count === 'number') {
        result.push([row.date, row.count]);
      }
    }
    return result;
  } catch {
    // Rust: `unwrap_or_default()` — a failed aggregate contributes no rows.
    return [];
  }
}

export const CHAT_SESSIONS_SQL =
  `SELECT DATE(created_at) as date, COUNT(*) as count
   FROM chat_v2_sessions
   WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
   GROUP BY DATE(created_at)`;

export const CHAT_MESSAGES_SQL =
  `SELECT DATE(datetime(timestamp/1000, 'unixepoch')) as date, COUNT(*) as count
   FROM chat_v2_messages
   WHERE DATE(datetime(timestamp/1000, 'unixepoch')) >= ?1
     AND DATE(datetime(timestamp/1000, 'unixepoch')) <= ?2
   GROUP BY DATE(datetime(timestamp/1000, 'unixepoch'))`;

export const NOTES_EDITED_SQL =
  `SELECT DATE(updated_at) as date, COUNT(*) as count
   FROM notes
   WHERE deleted_at IS NULL
     AND DATE(updated_at) >= ?1 AND DATE(updated_at) <= ?2
   GROUP BY DATE(updated_at)`;

export const TEXTBOOKS_OPENED_SQL =
  `SELECT DATE(last_opened_at) as date, COUNT(*) as count
   FROM files
   WHERE last_opened_at IS NOT NULL
     AND DATE(last_opened_at) >= ?1 AND DATE(last_opened_at) <= ?2
   GROUP BY DATE(last_opened_at)`;

export const EXAMS_CREATED_SQL =
  `SELECT DATE(created_at) as date, COUNT(*) as count
   FROM exam_sheets
   WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
   GROUP BY DATE(created_at)`;

export const TRANSLATIONS_CREATED_SQL =
  `SELECT DATE(created_at) as date, COUNT(*) as count
   FROM translations
   WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
   GROUP BY DATE(created_at)`;

export const ESSAYS_CREATED_SQL =
  `SELECT DATE(created_at) as date, COUNT(*) as count
   FROM essays
   WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
   GROUP BY DATE(created_at)`;

export const QUESTIONS_ANSWERED_SQL =
  `SELECT DATE(submitted_at) as date, COUNT(*) as count
   FROM answer_submissions
   WHERE DATE(submitted_at) >= ?1 AND DATE(submitted_at) <= ?2
   GROUP BY DATE(submitted_at)`;

export const STUDY_SECONDS_SQL =
  `SELECT date, MIN(seconds, 86400) as count FROM study_time_daily
   WHERE date >= ?1 AND date <= ?2 AND seconds > 0`;

export const ANKI_CARDS_CREATED_SQL =
  `SELECT DATE(created_at) as date, COUNT(*) as count
   FROM anki_cards
   WHERE deleted_at IS NULL
     AND DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
   GROUP BY DATE(created_at)`;
