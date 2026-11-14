/**
 * `ChatV2Database` metadata queries. Rust source: `chat_v2/database.rs:225-370`.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** `dstu_storage::migration::chat_v2::CHAT_V2_SCHEMA_VERSION` (database.rs:23). */
export const CHAT_V2_CURRENT_SCHEMA_VERSION = 20261111;

/** `get_schema_version` (database.rs:227-238): missing history reads as 0. */
export function readSchemaVersion(db: SqlExecutor): number {
  try {
    return db.pluck<number>(
      'SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history') ?? 0;
  } catch { return 0; }
}

export interface ChatV2Statistics {
  session_count: number;
  message_count: number;
  block_count: number;
  attachment_count: number;
  schema_version: number;
}

function count(db: SqlExecutor, table: string): number {
  try { return db.pluck<number>(`SELECT COUNT(*) FROM ${table}`) ?? 0; }
  catch { return 0; }
}

/** `get_statistics` (database.rs:331-369): failing counts read as 0. */
export function readStatistics(db: SqlExecutor): ChatV2Statistics {
  return {
    session_count: count(db, 'chat_v2_sessions'),
    message_count: count(db, 'chat_v2_messages'),
    block_count: count(db, 'chat_v2_blocks'),
    attachment_count: count(db, 'chat_v2_attachments'),
    schema_version: CHAT_V2_CURRENT_SCHEMA_VERSION,
  };
}
