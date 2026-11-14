/**
 * SQLite side of the chat Lance store (`LanceVectorStore` in
 * `crates/dstu-vfs/src/lance_vector_store.rs`).
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import type { DatabaseHandle, Row, SqlExecutor } from '../../../platform/storage/api.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type { LaneLogger } from '../src/logger.ts';
import type { SettingsWithConn } from '../../../platform/settings/api.ts';

export function ensureBaseRagSchema(db: SqlExecutor, logger?: LaneLogger): void {
  db.run(`CREATE TABLE IF NOT EXISTS rag_sub_libraries (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const defaultExists = Number(db.pluck<number>(
    "SELECT EXISTS(SELECT 1 FROM rag_sub_libraries WHERE id='default')",
  )) !== 0;
  if (!defaultExists) {
    const now = toRfc3339();
    db.run(
      `INSERT OR IGNORE INTO rag_sub_libraries
         (id, name, description, created_at, updated_at)
       VALUES ('default','default','默认知识库',?1,?1)`,
      [now],
    );
  }
  db.run(`CREATE TABLE IF NOT EXISTS rag_documents (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    file_path TEXT,
    file_size INTEGER,
    content_type TEXT,
    total_chunks INTEGER DEFAULT 0,
    sub_library_id TEXT NOT NULL DEFAULT 'default',
    update_state TEXT NOT NULL DEFAULT 'ready',
    desired_hash TEXT,
    update_retry INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (sub_library_id) REFERENCES rag_sub_libraries (id) ON DELETE SET DEFAULT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS rag_document_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  )`);

  for (const sql of [
    "ALTER TABLE rag_document_chunks ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
    'ALTER TABLE rag_document_chunks ADD COLUMN chunk_index INTEGER NOT NULL DEFAULT 0',
  ]) {
    try {
      db.run(sql);
    } catch (error) {
      if (!String(error instanceof Error ? error.message : error).includes('duplicate column name')) {
        throw error;
      }
    }
  }

  db.run('CREATE INDEX IF NOT EXISTS idx_rag_document_chunks_document ON rag_document_chunks(document_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_rag_document_chunks_doc_chunk ON rag_document_chunks(document_id, chunk_index)');

  for (const sql of [
    "ALTER TABLE rag_documents ADD COLUMN sub_library_id TEXT NOT NULL DEFAULT 'default'",
    "ALTER TABLE rag_documents ADD COLUMN update_state TEXT NOT NULL DEFAULT 'ready'",
    'ALTER TABLE rag_documents ADD COLUMN desired_hash TEXT',
    'ALTER TABLE rag_documents ADD COLUMN update_retry INTEGER NOT NULL DEFAULT 0',
    "ALTER TABLE rag_documents ADD COLUMN active_revision TEXT NOT NULL DEFAULT 'A'",
    'CREATE INDEX IF NOT EXISTS idx_rag_documents_sub_library ON rag_documents(sub_library_id)',
    'CREATE INDEX IF NOT EXISTS idx_rag_sub_libraries_name ON rag_sub_libraries(name)',
  ]) {
    try {
      db.run(sql);
    } catch (error) {
      // Rust ignores failures for optional columns/indexes (`let _ =`).
      if (!String(error).includes('duplicate column name')) {
        logger?.debug(`[ChatLanceStore] optional schema step skipped: ${String(error)}`);
      }
    }
  }
}

export function getSetting(db: SqlExecutor, key: string): string | undefined {
  try {
    const value = db.pluck<string>('SELECT value FROM settings WHERE key = ?1', [key]);
    return value === undefined ? undefined : String(value);
  } catch {
    // All Lance callers use Database::get_setting(...).ok().flatten(), without a diagnostic.
    return undefined;
  }
}

export function saveSetting(db: SqlExecutor, key: string, value: string, owner?: SettingsWithConn): void {
  if (owner === undefined) throw new Error('F4 settings owner is not available');
  owner.saveWithConn(db, key, value);
}

const chatMessageIdsByStableId = defineQuery<[string], { id: bigint }>(
  'SELECT id FROM chat_messages WHERE stable_id = ?1 OR persistent_stable_id = ?1',
  { name: 'vfs.chat.messageIdsByStableId', options: { safeIntegers: true } },
);

/** Rust `clear_message_embeddings` reads these ids as `i64`; keep them exact. */
export function findChatMessageIdsByStableIds(
  db: SqlExecutor,
  stableIds: readonly string[],
): bigint[] {
  const ids: bigint[] = [];
  for (const stable of stableIds) {
    const rows = db.all(chatMessageIdsByStableId, [stable]);
    for (const row of rows) ids.push(row.id);
  }
  return ids;
}

export function deleteChatEmbeddingRows(
  db: SqlExecutor,
  ids: readonly (number | bigint)[],
): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.run(`DELETE FROM chat_user_embeddings WHERE message_id IN (${placeholders})`, [...ids]);
}

export function parseBoolFlag(value: string): boolean | undefined {  const trimmed = rustTrim(value);
  const lower = trimmed.toLowerCase();
  if (lower === 'true' || lower === 'yes' || lower === 'on' || trimmed === '1') return true;
  if (lower === 'false' || lower === 'no' || lower === 'off' || trimmed === '0') return false;
  return undefined;
}

export interface RagChunkRow {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  metadata_json: string | null;
}

export function getDocumentSubLibraries(
  db: SqlExecutor,
  documentIds: readonly string[],
): Map<string, string> {
  const result = new Map<string, string>();
  if (documentIds.length === 0) return result;
  const placeholders = documentIds.map(() => '?').join(',');
  for (const row of db.all<Row>(
    `SELECT id, sub_library_id FROM rag_documents WHERE id IN (${placeholders})`,
    [...documentIds],
  )) {
    result.set(String(row['id']), String(row['sub_library_id']));
  }
  return result;
}

export function insertDocumentRecord(
  db: SqlExecutor,
  documentId: string,
  fileName: string,
  filePath: string | null,
  fileSize: number | null,
  subLibraryId: string,
): void {
  const now = toRfc3339();
  db.run(
    `INSERT OR REPLACE INTO rag_documents
       (id, file_name, file_path, file_size, sub_library_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    [documentId, fileName, filePath, fileSize, subLibraryId, now, now],
  );
}

export function replaceDocumentChunks(db: DatabaseHandle, rows: readonly RagChunkRow[]): void {
  if (rows.length === 0) return;
  db.transaction((tx) => {
    for (const row of rows) {
      tx.run(
        `INSERT OR REPLACE INTO rag_document_chunks
           (id, document_id, chunk_index, text, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
        [row.chunk_id, row.document_id, row.chunk_index, row.text, row.metadata_json ?? '{}'],
      );
    }
  }, { behavior: 'immediate' });
}

export function clearRagMetadata(db: DatabaseHandle): void {
  const hasLegacyVectors = Number(db.pluck<number>(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='rag_vectors')",
  )) !== 0;
  db.transaction((tx) => {
    if (hasLegacyVectors) tx.run('DELETE FROM rag_vectors');
    tx.run('DELETE FROM rag_document_chunks');
    tx.run('DELETE FROM rag_documents');
  }, { behavior: 'immediate' });
}
