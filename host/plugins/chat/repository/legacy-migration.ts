/**
 * Legacy `chat_messages` migration persistence.
 * Rust source: `chat_v2/migration/legacy_migration.rs` (queries + raw inserts).
 *
 * Reads the F4 `mistakes` database and writes `chat_v2`. Only this repository
 * owns SQL; the executor in `src/legacy-migration.ts` keeps the Rust control
 * flow (per-session BEGIN IMMEDIATE / COMMIT / ROLLBACK).
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { MigrationCheckResult } from '../api.ts';
import { ChatV2Error } from '../src/error.ts';
import { databaseOperation } from './errors.ts';

export interface LegacyMessageRow {
  id: number;
  mistake_id: string;
  role: string;
  content: string;
  timestamp: string;
  thinking_content: string | null;
  rag_sources: string | null;
  memory_sources: string | null;
  graph_sources: string | null;
  web_search_sources: string | null;
  image_paths: string | null;
  image_base64: string | null;
  doc_attachments: string | null;
  tool_call: string | null;
  tool_result: string | null;
  stable_id: string | null;
  metadata: string | null;
}

export interface LegacyMistakeInfo {
  ocrText: string | null;
  userQuestion: string | null;
  chatMetadata: string | null;
}

export interface LegacySessionInsert {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  metadataJson: string;
}

export interface LegacyMessageInsert {
  id: string;
  sessionId: string;
  role: string;
  timestamp: number;
  stableId: string | null;
  metaJson: string;
  attachmentsJson: string | null;
}

export interface LegacyBlockInsert {
  id: string;
  messageId: string;
  blockType: string;
  status: string;
  blockIndex: number;
  content: string | null;
  citationsJson: string | null;
  toolName: string | null;
  toolInputJson: string | null;
  toolOutputJson: string | null;
  now: number;
}

function failure(prefix: string, error: unknown): ChatV2Error {
  return new ChatV2Error('Database', `${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}

/** `SELECT COUNT(*)` with the Rust `.unwrap_or(0)` fallback. */
function countOrZero(db: SqlExecutor, sql: string, params?: readonly unknown[]): number {
  try {
    const row = db.get<{ count: number }>(sql, params as never);
    return row === undefined ? 0 : Number(row.count);
  } catch {
    return 0;
  }
}

/** `sqlite_master` existence probe (`unwrap_or(false)`). */
export function chatMessagesTableExists(dataDb: SqlExecutor): boolean {
  return countOrZero(dataDb,
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'chat_messages'") > 0;
}

/** `pragma_table_info('chat_messages')` probe (`unwrap_or(0) > 0`). */
export function hasMigratedColumn(dataDb: SqlExecutor): boolean {
  return countOrZero(dataDb,
    "SELECT COUNT(*) AS count FROM pragma_table_info('chat_messages') WHERE name = 'migrated_to_v2'") > 0;
}

/**
 * Migration markers live outside `chat_messages`: that table is migration-managed, so
 * adding columns to it drifts the mistakes schema fingerprint and blocks the next startup.
 * Not created by a migration, so it stays outside the fingerprint scope.
 */
const MIGRATION_MAP_TABLE = 'legacy_chat_migration_map';

function migrationMapExists(dataDb: SqlExecutor): boolean {
  return countOrZero(dataDb,
    'SELECT COUNT(*) AS count FROM sqlite_master WHERE type = \'table\' AND name = ?1', [MIGRATION_MAP_TABLE]) > 0;
}

/** Pending / migrated predicates over both marker stores; null when neither exists yet. */
function migrationPredicates(dataDb: SqlExecutor): { pending: string; migrated: string } | null {
  const column = hasMigratedColumn(dataDb);
  const map = migrationMapExists(dataDb);
  if (!column && !map) return null;
  const pending: string[] = [];
  const migrated: string[] = [];
  if (column) {
    pending.push('(migrated_to_v2 = 0 OR migrated_to_v2 IS NULL)');
    migrated.push('migrated_to_v2 = 1');
  }
  if (map) {
    pending.push(`id NOT IN (SELECT legacy_id FROM ${MIGRATION_MAP_TABLE})`);
    migrated.push(`id IN (SELECT legacy_id FROM ${MIGRATION_MAP_TABLE})`);
  }
  return { pending: pending.join(' AND '), migrated: migrated.join(' OR ') };
}

/** `check_migration_status` (legacy_migration.rs:819-919). */
export function migrationStatus(dataDb: SqlExecutor, chatDb: SqlExecutor): MigrationCheckResult {
  const result: MigrationCheckResult = {
    needsMigration: false, pendingMessages: 0, pendingSessions: 0,
    migratedMessages: 0, canRollback: false, lastMigrationAt: null,
  };
  if (!chatMessagesTableExists(dataDb)) return result;

  const predicates = migrationPredicates(dataDb);
  if (predicates !== null) {
    result.pendingMessages = countOrZero(dataDb,
      `SELECT COUNT(*) AS count FROM chat_messages WHERE ${predicates.pending}`);
    result.migratedMessages = countOrZero(dataDb,
      `SELECT COUNT(*) AS count FROM chat_messages WHERE ${predicates.migrated}`);
    result.pendingSessions = countOrZero(dataDb,
      `SELECT COUNT(DISTINCT mistake_id) AS count FROM chat_messages WHERE ${predicates.pending}`);
  } else {
    result.pendingMessages = countOrZero(dataDb, 'SELECT COUNT(*) AS count FROM chat_messages');
    result.pendingSessions = countOrZero(dataDb,
      'SELECT COUNT(DISTINCT mistake_id) AS count FROM chat_messages');
  }
  result.needsMigration = result.pendingMessages > 0;

  const migratedSessionsInV2 = countOrZero(chatDb,
    "SELECT COUNT(*) AS count FROM chat_v2_sessions WHERE json_extract(metadata_json, '$.migratedFrom') = 'chat_messages'");
  result.canRollback = result.migratedMessages > 0 && migratedSessionsInV2 > 0;

  try {
    const row = chatDb.get<{ migrated_at: unknown }>(
      `SELECT json_extract(metadata_json, '$.migratedAt') AS migrated_at FROM chat_v2_sessions
       WHERE json_extract(metadata_json, '$.migratedFrom') = 'chat_messages'
       ORDER BY created_at DESC LIMIT 1`);
    // rusqlite `row.get::<Option<i64>>` rejects non-integer JSON values.
    result.lastMigrationAt = row !== undefined && typeof row.migrated_at === 'number'
      && Number.isInteger(row.migrated_at) ? row.migrated_at : null;
  } catch {
    result.lastMigrationAt = null;
  }
  return result;
}

/** `load_legacy_messages` (legacy_migration.rs:241-299). */
export function loadLegacyMessages(dataDb: SqlExecutor): LegacyMessageRow[] {
  const columns = `id, mistake_id, role, content, timestamp, thinking_content,
    rag_sources, memory_sources, graph_sources, web_search_sources,
    image_paths, image_base64, doc_attachments, tool_call, tool_result,
    stable_id, metadata`;
  const predicates = migrationPredicates(dataDb);
  const where = predicates === null ? '' : `WHERE ${predicates.pending}`;
  return databaseOperation(() => {
    try {
      return dataDb.all<LegacyMessageRow>(
        `SELECT ${columns} FROM chat_messages ${where} ORDER BY mistake_id, timestamp`);
    } catch (error) {
      throw failure('准备查询失败', error);
    }
  });
}

/** `get_session_title` mistake lookup (legacy_migration.rs:325-337). */
export function legacyMistakeInfo(dataDb: SqlExecutor, mistakeId: string): LegacyMistakeInfo | null {
  try {
    const row = dataDb.get<{ ocr_text: string | null; user_question: string | null; chat_metadata: string | null }>(
      'SELECT ocr_text, user_question, chat_metadata FROM mistakes WHERE id = ?1', [mistakeId]);
    if (row === undefined) return null;
    return { ocrText: row.ocr_text, userQuestion: row.user_question, chatMetadata: row.chat_metadata };
  } catch {
    return null;
  }
}

/** `create_session` (legacy_migration.rs:396-430). */
export function insertLegacySession(db: SqlExecutor, session: LegacySessionInsert): void {
  databaseOperation(() => {
    try {
      db.run(`INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at, metadata_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`, [
        session.id, 'analysis', session.title, 'active',
        session.createdAt, session.updatedAt, session.metadataJson,
      ]);
    } catch (error) {
      throw failure('创建会话失败', error);
    }
  });
}

/** Message insert before blocks (legacy_migration.rs:453-468). */
export function insertLegacyMessage(db: SqlExecutor, message: LegacyMessageInsert): void {
  databaseOperation(() => {
    try {
      db.run(`INSERT INTO chat_v2_messages
        (id, session_id, role, block_ids_json, timestamp, persistent_stable_id, meta_json, attachments_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`, [
        message.id, message.sessionId, message.role, '[]', message.timestamp,
        message.stableId, message.metaJson, message.attachmentsJson,
      ]);
    } catch (error) {
      throw failure('插入消息失败', error);
    }
  });
}

/** `create_block` content/citation variant (legacy_migration.rs:597-627). */
export function insertLegacyContentBlock(db: SqlExecutor, block: LegacyBlockInsert): void {
  databaseOperation(() => {
    try {
      db.run(`INSERT INTO chat_v2_blocks
        (id, message_id, block_type, status, block_index, content, citations_json, started_at, ended_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`, [
        block.id, block.messageId, block.blockType, block.status, block.blockIndex,
        block.content, block.citationsJson, block.now, block.now,
      ]);
    } catch (error) {
      throw failure('创建块失败', error);
    }
  });
}

/** `create_tool_block` (legacy_migration.rs:630-669). */
export function insertLegacyToolBlock(db: SqlExecutor, block: LegacyBlockInsert): void {
  databaseOperation(() => {
    try {
      db.run(`INSERT INTO chat_v2_blocks
        (id, message_id, block_type, status, block_index, tool_name, tool_input_json, tool_output_json, started_at, ended_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`, [
        block.id, block.messageId, block.blockType, block.status, block.blockIndex,
        block.toolName, block.toolInputJson, block.toolOutputJson, block.now, block.now,
      ]);
    } catch (error) {
      throw failure('创建工具块失败', error);
    }
  });
}

/** `UPDATE chat_v2_messages SET block_ids_json` (legacy_migration.rs:583-590). */
export function updateLegacyMessageBlockIds(db: SqlExecutor, messageId: string, blockIdsJson: string): void {
  databaseOperation(() => {
    try {
      db.run('UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2', [blockIdsJson, messageId]);
    } catch (error) {
      throw failure('更新消息块ID失败', error);
    }
  });
}

/** `mark_message_migrated` (legacy_migration.rs:774-811). */
export function markMessageMigrated(dataDb: SqlExecutor, legacyId: number, sessionId: string): void {
  databaseOperation(() => {
    // RUST-FIX(RF-W10-legacy-chat-migration-marker-table): Rust ALTERs the managed chat_messages table here.
    try {
      dataDb.run(`CREATE TABLE IF NOT EXISTS ${MIGRATION_MAP_TABLE} (
        legacy_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL)`);
      dataDb.run(`INSERT OR REPLACE INTO ${MIGRATION_MAP_TABLE} (legacy_id, session_id) VALUES (?1, ?2)`,
        [legacyId, sessionId]);
    } catch (error) {
      throw failure('标记迁移失败', error);
    }
  });
}

/** `BEGIN IMMEDIATE` (legacy_migration.rs:162-164). */
export function beginMigrationTransaction(chatDb: SqlExecutor): void {
  databaseOperation(() => {
    try {
      chatDb.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw failure('迁移事务开始失败', error);
    }
  });
}

/** `COMMIT` (legacy_migration.rs:198-200). */
export function commitMigrationTransaction(chatDb: SqlExecutor): void {
  databaseOperation(() => {
    try {
      chatDb.exec('COMMIT');
    } catch (error) {
      throw failure('迁移事务提交失败', error);
    }
  });
}

/** `ROLLBACK` (legacy_migration.rs:217); the caller only logs failures. */
export function rollbackMigrationTransaction(chatDb: SqlExecutor): void {
  chatDb.exec('ROLLBACK');
}

/** Migrated session ids for rollback (legacy_migration.rs:955-963). Bad rows are skipped. */
export function migratedSessionIds(chatDb: SqlExecutor): string[] {
  try {
    const rows = chatDb.all<{ id: unknown }>(
      "SELECT id FROM chat_v2_sessions WHERE json_extract(metadata_json, '$.migratedFrom') = 'chat_messages'");
    return rows.filter((row): row is { id: string } => typeof row.id === 'string').map(row => row.id);
  } catch {
    return [];
  }
}

/**
 * Rollback step 2: reset every migration marker (legacy_migration.rs:967-972). With neither
 * marker store present the Rust UPDATE still runs and fails with `no such column`.
 */
export function resetMigrationMarkers(dataDb: SqlExecutor): number {
  return databaseOperation(() => {
    try {
      const predicates = migrationPredicates(dataDb);
      const resetColumn = (): number => dataDb.run(
        'UPDATE chat_messages SET migrated_to_v2 = 0, migrated_session_id = NULL WHERE migrated_to_v2 = 1').changes;
      if (predicates === null) return resetColumn();
      const migrated = Number(dataDb.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM chat_messages WHERE ${predicates.migrated}`)?.count ?? 0);
      if (hasMigratedColumn(dataDb)) resetColumn();
      if (migrationMapExists(dataDb)) dataDb.run(`DELETE FROM ${MIGRATION_MAP_TABLE}`);
      return migrated;
    } catch (error) {
      throw failure('重置迁移标记失败', error);
    }
  });
}

/** Rollback step 3: delete one migrated session (cascades messages/blocks). */
export function deleteMigratedSession(chatDb: SqlExecutor, sessionId: string): void {
  chatDb.run('DELETE FROM chat_v2_sessions WHERE id = ?1', [sessionId]);
}
