/**
 * FSRS 状态读取（库页复习状态、APKG 导出进度）与导出回执/内容哈希写入。
 */
import { type SqlExecutor } from '../../../platform/storage/api.ts';
import {
  buildExportProgressValue,
  parseExportSchedulerConfig,
  type ExportCardState,
  type ExportProgressValue,
  type ExportReviewLog,
  type ExportSchedulerConfig,
} from '../src/fsrs-export.ts';
import {
  decodeAgentReviewStateRow,
  LibraryQueryError,
  type AgentReviewStateSnapshot,
  type AgentReviewStateSqlRow,
} from '../src/library.ts';

/** `get_review_states_for_library`（`fsrs_review_service.rs:1717-1846`）的 20 列状态清单。 */
const STATE_COLUMNS_SQL = `s.id AS s_id, s.anki_card_id AS s_anki_card_id, s.deck_id AS s_deck_id,
  s.state AS s_state, s.stability AS s_stability, s.difficulty AS s_difficulty,
  s.elapsed_days AS s_elapsed_days, s.scheduled_days AS s_scheduled_days, s.reps AS s_reps,
  s.lapses AS s_lapses, s.due_ms AS s_due_ms, s.last_review_ms AS s_last_review_ms,
  s.suspended AS s_suspended, s.fsrs_params_version AS s_fsrs_params_version,
  s.desired_retention AS s_desired_retention, s.created_at AS s_created_at, s.updated_at AS s_updated_at,
  COALESCE(s.leech, 0) AS s_leech, s.buried_until_ms AS s_buried_until_ms,
  COALESCE(s.learning_step, 0) AS s_learning_step`;

/**
 * 读取一批卡片的复习快照；未入队的卡片略过，缺失 / 已删除的卡片按 Rust 语义报 not_found。
 */
export function getReviewStatesForLibrary(
  db: SqlExecutor,
  ankiCardIds: readonly string[],
): AgentReviewStateSnapshot[] {
  if (ankiCardIds.length > 100) {
    throw new LibraryQueryError('validation', 'ankiCardIds must contain at most 100 entries');
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of ankiCardIds) {
    const cardId = raw.trim();
    if (cardId === '') {
      throw new LibraryQueryError('validation', 'ankiCardIds must not contain empty IDs');
    }
    if (!seen.has(cardId)) {
      seen.add(cardId);
      normalized.push(cardId);
    }
  }
  if (normalized.length === 0) return [];

  const placeholders = normalized.map(() => '?').join(',');
  const sql = `SELECT
      ${STATE_COLUMNS_SQL},
      CAST(COALESCE(s.local_version, 0) AS TEXT) AS s_local_version,
      typeof(COALESCE(s.local_version, 0)) AS s_local_version_type,
      ac.id AS ac_id, COALESCE(ac.is_error_card, 0) AS ac_is_error_card,
      latest.id AS latest_id, latest.anki_card_id AS latest_anki_card_id,
      latest.rating AS latest_rating, latest.review_ms AS latest_review_ms,
      latest.state_before_json AS latest_state_before_json, latest.updated_at AS latest_updated_at
    FROM anki_cards ac
    INNER JOIN document_tasks dt ON dt.id = ac.task_id
    LEFT JOIN fsrs_card_states s
      ON s.anki_card_id = ac.id AND s.deleted_at IS NULL
    LEFT JOIN fsrs_review_logs latest
      ON latest.id = (
          SELECT log.id
          FROM fsrs_review_logs log
          WHERE log.card_state_id = s.id
            AND log.deleted_at IS NULL
          ORDER BY log.review_ms DESC, log.created_at DESC, log.id DESC
          LIMIT 1
      )
    WHERE ac.id IN (${placeholders})
      AND ac.deleted_at IS NULL
      AND dt.deleted_at IS NULL`;
  const rows = db.all<AgentReviewStateSqlRow>(sql, [...normalized]);

  const loaded = new Map<string, AgentReviewStateSqlRow>();
  for (const row of rows) loaded.set(row.ac_id, row);
  const snapshots: AgentReviewStateSnapshot[] = [];
  for (const cardId of normalized) {
    const row = loaded.get(cardId);
    if (row === undefined) {
      throw new LibraryQueryError('not_found', `anki card not found: ${cardId}`);
    }
    const snapshot = decodeAgentReviewStateRow(row);
    if (snapshot !== null) snapshots.push(snapshot);
  }
  return snapshots;
}

// ------------------------------------------------------------ 导出 FSRS 进度

interface ExportStateRow {
  s_id: string;
  s_anki_card_id: string;
  s_state: number;
  s_stability: number | null;
  s_difficulty: number | null;
  s_scheduled_days: number;
  s_reps: number;
  s_lapses: number;
  s_due_ms: number;
  s_last_review_ms: number | null;
  s_suspended: number;
  s_desired_retention: number | null;
}

interface ExportReviewRow {
  review_ms: number;
  rating: number;
  state_before: number;
  state_after: number;
  scheduled_days: number | null;
  due_after_ms: number | null;
  duration_ms: number | null;
}

/** `load_scheduler_config(conn, DEFAULT_DECK_ID)` 的导出相关子集。 */
export function loadExportSchedulerConfig(db: SqlExecutor): ExportSchedulerConfig {
  const row = db.get<{ config_json: string | null }>(
    'SELECT config_json FROM anki_decks WHERE id = ?1 AND deleted_at IS NULL',
    ['deck_default'],
  );
  return parseExportSchedulerConfig(row?.config_json ?? null);
}

/**
 * `load_export_progress`（`fsrs_review_service.rs:3947-4032`）：
 * 400 个 id 一批读取状态与逐卡复习日志，按 `AnkiFsrs` 元数据形状返回。
 */
export function loadExportProgress(
  db: SqlExecutor,
  ankiCardIds: readonly string[],
): Map<string, ExportProgressValue> {
  const progress = new Map<string, ExportProgressValue>();
  if (ankiCardIds.length === 0) return progress;
  const config = loadExportSchedulerConfig(db);
  const logsSql = `SELECT review_ms, rating, state_before, state_after, scheduled_days,
                          due_after_ms, duration_ms
                   FROM fsrs_review_logs
                   WHERE card_state_id = ?1 AND deleted_at IS NULL
                   ORDER BY review_ms ASC, created_at ASC, id ASC`;
  for (let offset = 0; offset < ankiCardIds.length; offset += 400) {
    const chunk = ankiCardIds.slice(offset, offset + 400);
    const placeholders = chunk.map(() => '?').join(', ');
    const states = db.all<ExportStateRow>(
      `SELECT ${STATE_COLUMNS_SQL}
       FROM fsrs_card_states s
       INNER JOIN anki_cards a ON a.id = s.anki_card_id
       INNER JOIN document_tasks dt ON dt.id = a.task_id
       WHERE s.anki_card_id IN (${placeholders})
         AND s.deleted_at IS NULL
         AND a.deleted_at IS NULL
         AND dt.deleted_at IS NULL`,
      [...chunk],
    );
    for (const row of states) {
      const reviews: ExportReviewLog[] = db
        .all<ExportReviewRow>(logsSql, [row.s_id])
        .map((log) => ({
          reviewMs: log.review_ms,
          rating: log.rating,
          stateBefore: log.state_before,
          stateAfter: log.state_after,
          scheduledDays: log.scheduled_days ?? 0,
          dueAfterMs: log.due_after_ms,
          durationMs: log.duration_ms,
        }));
      const state: ExportCardState = {
        id: row.s_id,
        ankiCardId: row.s_anki_card_id,
        state: row.s_state,
        stability: row.s_stability,
        difficulty: row.s_difficulty,
        scheduledDays: row.s_scheduled_days,
        reps: row.s_reps,
        lapses: row.s_lapses,
        dueMs: row.s_due_ms,
        lastReviewMs: row.s_last_review_ms,
        suspended: row.s_suspended !== 0,
        desiredRetention: row.s_desired_retention,
      };
      progress.set(row.s_anki_card_id, buildExportProgressValue(state, reviews, config));
    }
  }
  return progress;
}

// ------------------------------------------------------------ 导出 receipt

/**
 * `write_anki_export_receipts`（`database/mod.rs:6009-6050`）：
 * 逐卡回写 anki_note_id + export_status='synced'，返回实际命中行数。
 */
export function writeAnkiExportReceipts(
  db: SqlExecutor,
  cardIds: readonly string[],
  noteIds: readonly (number | null)[],
  exportedAt: string,
): number {
  if (cardIds.length === 0 || noteIds.length === 0) return 0;
  const length = Math.min(cardIds.length, noteIds.length);
  let written = 0;
  for (let index = 0; index < length; index += 1) {
    const noteId = noteIds[index];
    if (noteId === null || noteId === undefined) continue;
    const cardId = cardIds[index]!.trim();
    if (cardId === '') continue;
    const affected = db.run(
      `UPDATE anki_cards SET
         anki_note_id = ?1,
         export_status = 'synced',
         last_exported_at = ?2,
         updated_at = ?2
       WHERE id = ?3
         AND deleted_at IS NULL
         AND EXISTS (
           SELECT 1
           FROM document_tasks dt
           WHERE dt.id = anki_cards.task_id
             AND dt.deleted_at IS NULL
         )`,
      [noteId, exportedAt, cardId],
    ).changes;
    if (affected > 0) written += 1;
  }
  return written;
}

/**
 * `write_anki_export_content_hashes`（`cmd/anki_connect.rs:76-112`）：
 * 仅回写已标记 synced 的行。
 */
export function writeAnkiExportContentHashes(
  db: SqlExecutor,
  cardIds: readonly string[],
  contentHashes: readonly string[],
  noteIds: readonly (number | null)[],
): number {
  const length = Math.min(cardIds.length, contentHashes.length, noteIds.length);
  if (length === 0) return 0;
  let written = 0;
  for (let index = 0; index < length; index += 1) {
    if (noteIds[index] === null) continue;
    const cardId = cardIds[index]!.trim();
    if (cardId === '') continue;
    const affected = db.run(
      `UPDATE anki_cards SET content_hash = ?1
       WHERE id = ?2
         AND deleted_at IS NULL
         AND export_status = 'synced'`,
      [contentHashes[index]!, cardId],
    ).changes;
    if (affected > 0) written += 1;
  }
  return written;
}
