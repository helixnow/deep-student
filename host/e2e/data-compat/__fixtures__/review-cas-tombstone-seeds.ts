/** l15-review-cas-tombstone-w0: SQL-constructed review CAS / soft-delete inputs on SQL-replayed slot DBs; not an A artifact. */
// boundary-allow native-import: X3 按 Rust 原测试夹具 SQL 在迁移重放出的 mistakes.db 上构造 L15/L24 输入；仅隔离 E2E 夹具，不写用户或业务库。
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { buildDatabase, DATABASES, dbPath } from './fixtures.ts';

// Rust fixtures leave these to DEFAULT strftime('%Y-%m-%dT%H:%M:%fZ','now'); fixed here (same format) so card CAS tokens are literals.
const ROW_TIME = '2026-07-13T00:00:00.000Z';
// insert_state_in_tx writes Utc::now().to_rfc3339() and due_ms = now_ms (FsrsImportedSchedule::new_card).
const STATE_TIME = '2026-07-13T00:00:00+00:00';
const STATE_MS = 1783900800000;

/** fsrs_card_states.local_version values; read back as reviewVersion via COALESCE(local_version, 0). */
const REVIEW_VERSIONS = [9007199254740992n, 9007199254740993n, 9223372036854774784n, 9223372036854774785n,
  9223372036854775806n, 9223372036854775807n] as const;

// src-tauri/crates/dstu-anki/src/fsrs_review_service.rs, test helpers and enqueue; SQL text kept, plus fixed timestamps.
const INSERT_TASK = `INSERT INTO document_tasks (
                id, document_id, original_document_name, segment_index,
                content_segment, status, anki_generation_options_json, created_at, updated_at
             ) VALUES (?1, ?2, 'test.md', 0, 'segment', 'Completed', '{}', ?3, ?3)`; // :6037-6046
const INSERT_CARD = `INSERT INTO anki_cards (
                id, task_id, front, back, source_type, source_id, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, 'document', ?5, ?6, ?6)`; // :6047-6059, :6101-6116
const SET_OWNER = 'UPDATE document_tasks SET source_session_id = ?1 WHERE id = ?2'; // :6118-6127
const INSERT_STATE = `INSERT INTO fsrs_card_states (
                id, anki_card_id, deck_id, state, stability, difficulty,
                elapsed_days, scheduled_days, reps, lapses, due_ms, last_review_ms,
                suspended, fsrs_params_version, desired_retention, created_at, updated_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?16
             )`; // :1424-1452
const SET_VERSION = 'UPDATE fsrs_card_states SET local_version = ?1 WHERE id = ?2'; // style of :7720-7733
const CARD_TOMBSTONE = `UPDATE anki_cards
                 SET deleted_at = ?1, card_order_in_task = 99
                 WHERE id = 'card-tombstone'`; // :7179-7189
const TASK_TOMBSTONE = `UPDATE document_tasks
                 SET status = 'Processing', updated_at = ?1, deleted_at = ?2
                 WHERE id = 'task-tombstone'`; // :7366-7376

const numbered = (values: unknown[]) => Object.fromEntries(values.map((v, i) => [i + 1, v]));

function build(conn: Database.Database): void {
  const run = (sql: string, ...values: unknown[]) => conn.prepare(sql).run(numbered(values));
  const task = (doc: string, id: string) => run(INSERT_TASK, id, doc, ROW_TIME);
  const card = (doc: string, taskId: string, id: string) => run(INSERT_CARD, id, taskId, `front-${id}`, `back-${id}`, doc, ROW_TIME);
  // FsrsImportedSchedule::new_card + DEFAULT_DECK_ID / FSRS_PARAMS_VERSION / deck desired_retention 0.9.
  const state = (cardId: string) => run(INSERT_STATE, `fsrs-state-${cardId}`, cardId, 'deck_default', 0, null, null,
    0, 0, 0, 0, STATE_MS, null, 0, 'fsrs-rs-6.6', 0.9, STATE_TIME);

  // CAS group: one live card/state per exact reviewVersion, owned by its own session.
  task('doc-review-cas', 'task-review-cas');
  for (const version of REVIEW_VERSIONS) card('doc-review-cas', 'task-review-cas', `card-rv-${version}`);
  run(SET_OWNER, 'session-review-cas', 'task-review-cas');
  for (const version of REVIEW_VERSIONS) {
    state(`card-rv-${version}`);
    run(SET_VERSION, version, `fsrs-state-card-rv-${version}`);
  }

  // soft_deleted_card_is_hidden_from_agent_crud_and_fsrs (:7150-7188): live sibling stays, state of the tombstone stays.
  task('doc-card-tombstone', 'task-card-tombstone');
  card('doc-card-tombstone', 'task-card-tombstone', 'card-tombstone');
  card('doc-card-tombstone', 'task-card-tombstone', 'card-still-live');
  run(SET_OWNER, 'session-owner', 'task-card-tombstone');
  state('card-tombstone');
  run(CARD_TOMBSTONE, '2026-07-14T01:00:00Z');

  // soft_deleted_document_task_is_hidden_and_cannot_be_recovered_or_mutated (:7327-7375): live child + its state stay.
  task('doc-task-tombstone', 'task-tombstone');
  card('doc-task-tombstone', 'task-tombstone', 'card-live-child');
  run(SET_OWNER, 'session-owner', 'task-tombstone');
  state('card-live-child');
  run(TASK_TOMBSTONE, '2000-01-01T00:00:00Z', '2026-07-14T02:00:00Z');
}

/** Five refinery DBs at the current migrations, then the review CAS / tombstone rows on mistakes.db. */
export function writeReviewCasTombstoneSeed(dataDir: string): void {
  const active = join(dataDir, 'slots', 'slotA');
  for (const db of DATABASES) buildDatabase(active, db, false, {});
  const conn = new Database(dbPath(active, 'mistakes'));
  try {
    conn.pragma('foreign_keys = ON');
    conn.transaction(() => build(conn))();
    if (conn.prepare('PRAGMA foreign_key_check').all().length) throw new Error('l15-review-cas-tombstone-w0: foreign keys invalid');
    if (conn.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('l15-review-cas-tombstone-w0: integrity invalid');
  } finally { conn.close(); }
}
