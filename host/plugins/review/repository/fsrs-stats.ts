/** FSRS 统计与记忆曲线读取（`fsrs_card_states` / `fsrs_review_logs` 只读 SQL）。 */
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import { appError, errorText } from '../src/errors.ts';
import type { FsrsMemoryCard } from '../src/fsrs-types.ts';
import { parseJsonObject } from './fsrs-json.ts';

export interface FsrsStatsCounts {
  total: number; newCount: number; learning: number; review: number; relearning: number;
  suspended: number; buried: number; leech: number; learningDue: number; reviewDue: number; newDue: number;
}
export function statsCounts(db: SqlExecutor, nowMs: number, nextDayStart: number): FsrsStatsCounts {
  try {
    const row = db.one<FsrsStatsCounts>(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN s.state = 0 AND s.suspended = 0 THEN 1 ELSE 0 END), 0) AS newCount,
      COALESCE(SUM(CASE WHEN s.state = 1 AND s.suspended = 0 THEN 1 ELSE 0 END), 0) AS learning,
      COALESCE(SUM(CASE WHEN s.state = 2 AND s.suspended = 0 THEN 1 ELSE 0 END), 0) AS review,
      COALESCE(SUM(CASE WHEN s.state = 3 AND s.suspended = 0 THEN 1 ELSE 0 END), 0) AS relearning,
      COALESCE(SUM(CASE WHEN s.suspended = 1 THEN 1 ELSE 0 END), 0) AS suspended,
      COALESCE(SUM(CASE WHEN s.suspended = 0 AND COALESCE(s.buried_until_ms, 0) > ?1 THEN 1 ELSE 0 END), 0) AS buried,
      COALESCE(SUM(CASE WHEN COALESCE(s.leech, 0) = 1 THEN 1 ELSE 0 END), 0) AS leech,
      COALESCE(SUM(CASE WHEN s.suspended = 0 AND (s.buried_until_ms IS NULL OR s.buried_until_ms <= ?1)
        AND s.state IN (1, 3) AND s.due_ms <= ?1 THEN 1 ELSE 0 END), 0) AS learningDue,
      COALESCE(SUM(CASE WHEN s.suspended = 0 AND (s.buried_until_ms IS NULL OR s.buried_until_ms <= ?1)
        AND s.state = 2 AND s.due_ms < ?2 THEN 1 ELSE 0 END), 0) AS reviewDue,
      COALESCE(SUM(CASE WHEN s.suspended = 0 AND (s.buried_until_ms IS NULL OR s.buried_until_ms <= ?1)
        AND s.state = 0 AND s.due_ms <= ?1 THEN 1 ELSE 0 END), 0) AS newDue
      FROM fsrs_card_states s
      INNER JOIN anki_cards a ON a.id = s.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
        AND COALESCE(a.is_error_card, 0) = 0`, [nowMs, nextDayStart]);
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) as unknown as FsrsStatsCounts;
  } catch (e) { throw appError('Database', errorText(e)); }
}

export function reviewsTodayCount(db: SqlExecutor, dayStart: number, nextDayStart: number): number {
  try {
    return Number(db.pluck<number>(`SELECT COUNT(*) FROM fsrs_review_logs l
      INNER JOIN fsrs_card_states s ON s.id = l.card_state_id
      INNER JOIN anki_cards a ON a.id = l.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE l.deleted_at IS NULL AND s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
        AND COALESCE(a.is_error_card, 0) = 0 AND l.review_ms >= ?1 AND l.review_ms < ?2`, [dayStart, nextDayStart]) ?? 0);
  } catch (e) { throw appError('Database', errorText(e)); }
}

export interface ReviewLogStatRow {
  reviewMs: number; rating: number; stateBefore: number | null; stabilityBefore: number | null;
  cardStateId: string; durationMs: number | null; scheduledDaysBefore: number | null;
}
export function reviewLogsForStats(db: SqlExecutor, windowStart: number, trialV7 = false): ReviewLogStatRow[] {
  try {
    return db.all<ReviewLogStatRow>(`SELECT l.review_ms AS reviewMs, l.rating AS rating,
      l.state_before AS stateBefore, l.stability_before AS stabilityBefore,
      l.card_state_id AS cardStateId, l.duration_ms AS durationMs,
      ${trialV7 ? "json_extract(l.state_before_json, '$.scheduledDays')" : 'NULL'} AS scheduledDaysBefore
      FROM fsrs_review_logs l
      INNER JOIN fsrs_card_states s ON s.id = l.card_state_id
      INNER JOIN anki_cards a ON a.id = l.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE l.deleted_at IS NULL AND s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
        AND COALESCE(a.is_error_card, 0) = 0 AND l.review_ms >= ?1
      ORDER BY l.review_ms ASC`, [windowStart]).map(row => ({
      reviewMs: Number(row.reviewMs), rating: Number(row.rating),
      stateBefore: row.stateBefore === null ? null : Number(row.stateBefore),
      stabilityBefore: row.stabilityBefore === null ? null : Number(row.stabilityBefore),
      cardStateId: String(row.cardStateId),
      durationMs: row.durationMs === null ? null : Number(row.durationMs),
      scheduledDaysBefore: row.scheduledDaysBefore,
    }));
  } catch (e) { throw appError('Database', `查询复习日志统计失败: ${errorText(e)}`); }
}

export function stateBreakdown(db: SqlExecutor, nowMs: number): { total: number; newCount: number; learning: number; review: number; relearning: number; suspended: number; buried: number; leech: number } {
  try {
    const row = db.one<Record<string, number>>(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN s.state = 0 AND s.suspended = 0 THEN 1 ELSE 0 END), 0) AS newCount,
      COALESCE(SUM(CASE WHEN s.state = 1 AND s.suspended = 0 THEN 1 ELSE 0 END), 0) AS learning,
      COALESCE(SUM(CASE WHEN s.state = 2 AND s.suspended = 0 THEN 1 ELSE 0 END), 0) AS review,
      COALESCE(SUM(CASE WHEN s.state = 3 AND s.suspended = 0 THEN 1 ELSE 0 END), 0) AS relearning,
      COALESCE(SUM(CASE WHEN s.suspended = 1 THEN 1 ELSE 0 END), 0) AS suspended,
      COALESCE(SUM(CASE WHEN s.suspended = 0 AND COALESCE(s.buried_until_ms, 0) > ?1 THEN 1 ELSE 0 END), 0) AS buried,
      COALESCE(SUM(CASE WHEN COALESCE(s.leech, 0) = 1 THEN 1 ELSE 0 END), 0) AS leech
      FROM fsrs_card_states s
      INNER JOIN anki_cards a ON a.id = s.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
        AND COALESCE(a.is_error_card, 0) = 0`, [nowMs]);
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) as unknown as ReturnType<typeof stateBreakdown>;
  } catch (e) { throw appError('Database', `查询状态构成失败: ${errorText(e)}`); }
}

export function forecastDueRows(db: SqlExecutor, horizonMs: number): number[] {
  try {
    return db.all<{ dueMs: number }>(`SELECT s.due_ms AS dueMs FROM fsrs_card_states s
      INNER JOIN anki_cards a ON a.id = s.anki_card_id
      INNER JOIN document_tasks dt ON dt.id = a.task_id
      WHERE s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
        AND COALESCE(a.is_error_card, 0) = 0 AND s.suspended = 0 AND s.state IN (1, 2, 3) AND s.due_ms < ?1`, [horizonMs])
      .map(row => Number(row.dueMs));
  } catch (e) { throw appError('Database', `查询到期预测失败: ${errorText(e)}`); }
}

const FAST_MEMORY = `(SELECT m.stability_fast FROM fsrs_review_logs l
  LEFT JOIN fsrs7_log_memory m ON m.log_id = l.id
  WHERE l.card_state_id = s.id AND l.deleted_at IS NULL AND l.review_ms = s.last_review_ms
  ORDER BY l.rowid DESC LIMIT 1)`;

/** Created only by the trial plugin, after the standard storage migrations. */
export function ensureFsrs7LogMemoryTable(db: SqlExecutor): void {
  db.exec(`CREATE TABLE IF NOT EXISTS fsrs7_log_memory (
    log_id TEXT PRIMARY KEY REFERENCES fsrs_review_logs(id) ON DELETE CASCADE,
    stability_fast REAL NOT NULL CHECK (stability_fast > 0)
  )`);
}

export function currentFastStability(db: SqlExecutor, id: string): number | null {
  return db.pluck<number | null>(`SELECT ${FAST_MEMORY} FROM fsrs_card_states s WHERE s.id = ?1`, [id]) ?? null;
}

export function memorizedRows(db: SqlExecutor, trialV7 = false): { deckId: string | null; stability: number; difficulty: number | null; lastReviewMs: number; stabilityFast: number | null }[] {
  try {
    return db.all<{ deckId: string | null; stability: number; difficulty: number | null; lastReviewMs: number; stabilityFast: number | null }>(
      `SELECT s.deck_id AS deckId, s.stability AS stability, s.difficulty AS difficulty, s.last_review_ms AS lastReviewMs,
       ${trialV7 ? FAST_MEMORY : 'NULL'} AS stabilityFast
       FROM fsrs_card_states s
       INNER JOIN anki_cards a ON a.id = s.anki_card_id
       INNER JOIN document_tasks dt ON dt.id = a.task_id
       WHERE s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
         AND COALESCE(a.is_error_card, 0) = 0 AND ${MEMORIZED_CONDITION}`)
      .map(row => ({ deckId: row.deckId, stability: Number(row.stability), difficulty: row.difficulty === null ? null : Number(row.difficulty), lastReviewMs: Number(row.lastReviewMs), stabilityFast: row.stabilityFast }));
  } catch (e) { throw appError('Database', `查询记忆分布失败: ${errorText(e)}`); }
}

const MEMORIZED_CONDITION = `s.suspended = 0 AND s.state != 0 AND s.stability > 0 AND s.last_review_ms IS NOT NULL`;

const memoryCardSelect = (trialV7: boolean) => `SELECT s.id AS cardStateId, s.anki_card_id AS ankiCardId, s.deck_id AS deckId,
  COALESCE(a.front, '') AS front, a.text AS text, COALESCE(a.extra_fields_json, '{}') AS extraFieldsJson,
  s.state AS state, s.stability AS stability, s.difficulty AS difficulty,
  s.last_review_ms AS lastReviewMs, s.due_ms AS dueMs, s.reps AS reps, s.lapses AS lapses,
  (SELECT l.rating FROM fsrs_review_logs l WHERE l.card_state_id = s.id AND l.deleted_at IS NULL
    ORDER BY l.review_ms DESC, l.created_at DESC, ${trialV7 ? 'l.rowid' : 'l.id'} DESC LIMIT 1) AS lastRating
  FROM fsrs_card_states s
  INNER JOIN anki_cards a ON a.id = s.anki_card_id
  INNER JOIN document_tasks dt ON dt.id = a.task_id
  WHERE s.deleted_at IS NULL AND a.deleted_at IS NULL AND dt.deleted_at IS NULL
    AND COALESCE(a.is_error_card, 0) = 0`;

function mapMemoryCard(row: Row): FsrsMemoryCard {
  const rating = row.lastRating === null || row.lastRating === undefined ? null : Number(row.lastRating);
  return {
    cardStateId: String(row.cardStateId), ankiCardId: String(row.ankiCardId),
    deckId: row.deckId === null ? null : String(row.deckId),
    front: row.front === null ? '' : String(row.front),
    ...(row.text === null || row.text === undefined ? {} : { text: String(row.text) }),
    extraFields: parseJsonObject(row.extraFieldsJson === null ? null : String(row.extraFieldsJson)),
    state: Number(row.state),
    stability: row.stability === null ? null : Number(row.stability),
    difficulty: row.difficulty === null ? null : Number(row.difficulty),
    lastReviewMs: row.lastReviewMs === null ? null : Number(row.lastReviewMs),
    dueMs: Number(row.dueMs), reps: Number(row.reps), lapses: Number(row.lapses),
    lastRating: rating !== null && rating >= 1 && rating <= 4 ? rating : null,
  };
}

export function memoryRecent(db: SqlExecutor, limit: number, trialV7 = false): FsrsMemoryCard[] {
  try {
    return db.all<Row>(`${memoryCardSelect(trialV7)} AND ${MEMORIZED_CONDITION}
      ORDER BY s.last_review_ms DESC, s.id ASC LIMIT ?1`, [limit]).map(mapMemoryCard);
  } catch (e) { throw appError('Database', `查询记忆曲线失败: ${errorText(e)}`); }
}

export function memoryCard(db: SqlExecutor, stateId: string, trialV7 = false): FsrsMemoryCard | null {
  try {
    const row = db.get<Row>(`${memoryCardSelect(trialV7)} AND s.id = ?1`, [stateId]);
    return row ? mapMemoryCard(row) : null;
  } catch (e) { throw appError('Database', `查询记忆曲线卡片失败: ${errorText(e)}`); }
}

export function memoryReviews(db: SqlExecutor, stateId: string, limit: number, trialV7 = false): FsrsMemoryReviewRow[] {
  try {
    return db.all<FsrsMemoryReviewRow>(`SELECT l.id AS logId, l.review_ms AS reviewMs, l.rating,
      l.state_before AS stateBefore, l.state_after AS stateAfter,
      l.stability_after AS stabilityAfter, l.difficulty_after AS difficultyAfter, l.due_after_ms AS dueAfterMs,
      ${trialV7 ? 'm.stability_fast' : 'NULL'} AS stabilityFast
      FROM fsrs_review_logs l ${trialV7 ? 'LEFT JOIN fsrs7_log_memory m ON m.log_id = l.id' : ''}
      WHERE l.card_state_id = ?1 AND l.deleted_at IS NULL AND l.rating BETWEEN 1 AND 4
      ORDER BY l.review_ms ASC, l.created_at ASC, ${trialV7 ? 'l.rowid' : 'l.id'} ASC LIMIT ?2`, [stateId, limit]).map(row => ({
      logId: String(row.logId), reviewMs: Number(row.reviewMs), rating: Number(row.rating),
      stateBefore: Number(row.stateBefore), stateAfter: Number(row.stateAfter),
      stabilityAfter: row.stabilityAfter === null ? null : Number(row.stabilityAfter),
      difficultyAfter: row.difficultyAfter === null ? null : Number(row.difficultyAfter),
      dueAfterMs: row.dueAfterMs === null ? null : Number(row.dueAfterMs),
      stabilityFast: row.stabilityFast,
    }));
  } catch (e) { throw appError('Database', `查询复习历史失败: ${errorText(e)}`); }
}
export interface FsrsMemoryReviewRow {
  logId: string; reviewMs: number; rating: number; stateBefore: number; stateAfter: number;
  stabilityAfter: number | null; difficultyAfter: number | null; dueAfterMs: number | null; stabilityFast: number | null;
}
