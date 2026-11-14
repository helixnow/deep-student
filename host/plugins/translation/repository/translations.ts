/**
 * Translation persistence used by the Chat V2 translation tools
 * (`VfsTranslationRepo::create_translation_in_folder_with_conn` /
 * `persist_translation_metadata` in translation_executor.rs).
 *
 * The published `vfs@1` surface exposes `VfsDatabase`/`DatabaseHandle` plus
 * `VfsError` and `translationToDstuNode`, but not the translation repository
 * functions. The tools therefore keep their SQL here, against the shared
 * handle, exactly like the Rust executor does through `VfsTranslationRepo`.
 */
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsTranslation } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import { VfsError } from '../../vfs/portable.ts';
import { nowEpochNanos, toRfc3339Opts } from '../../../platform/time/index.ts';

export interface CreateTranslationParams {
  title?: string | null;
  source: string;
  translated: string;
  srcLang: string;
  tgtLang: string;
  engine?: string | null;
  model?: string | null;
}

/** `nanoid(10)` shape used by the Rust repository (10 URL-safe characters). */
function shortId(): string {
  return globalThis.crypto.randomUUID().replaceAll('-', '').slice(0, 10);
}

function database<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw error instanceof VfsError ? error : new VfsError('Database', error instanceof Error ? error.message : String(error));
  }
}

function withSavepoint<T>(conn: SqlExecutor, name: string, operation: () => T): T {
  conn.exec(`SAVEPOINT ${name}`);
  try {
    const value = operation();
    conn.exec(`RELEASE SAVEPOINT ${name}`);
    return value;
  } catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`); }
    catch (rollbackError) {
      // Rust ignores rollback failures and returns the original error.
      Object.defineProperty(error, 'rollbackError', { value: rollbackError, configurable: true });
    }
    throw error;
  }
}

/** `VfsResourceRepo::compute_hash_with_salt` (resource_repo.rs:850-857). */
function computeHashWithSalt(data: string, salt: string): string {
  return createHasherSync('SHA-256').update(salt).update(':').update(data).digestHex();
}

/** `current_device_id`; L02 does not own F4 device identity, so it stays absent. */
function currentDeviceId(): string | null {
  // Read live: F4 `persistDeviceIdAfterRestore` rewrites DEVICE_ID at runtime. Hosts without `process` (mobile Worker) have none.
  const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.DEVICE_ID;
  return value === undefined || value === '' ? null : value;
}

function folderExists(conn: SqlExecutor, folderId: string): boolean {
  return (conn.pluck<number>('SELECT COUNT(*) FROM folders WHERE id = ?1 AND deleted_at IS NULL', [folderId]) ?? 0) > 0;
}

/** `VfsResourceRepo::create_or_reuse_with_conn` (resource_repo.rs:118-190). */
function createOrReuseResource(
  conn: SqlExecutor,
  resourceType: string,
  data: string,
  hash: string,
  sourceId: string,
  sourceTable: string,
): string {
  return database(() => {
    const resourceId = `res_${shortId()}`;
    const now = Date.now();
    const changes = conn.run(
      `INSERT OR IGNORE INTO resources
         (id, hash, type, source_id, source_table, storage_mode, data, metadata_json, ref_count, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'inline', ?6, NULL, 0, ?7, ?8)`,
      [resourceId, hash, resourceType, sourceId, sourceTable, data, now, now],
    ).changes;
    if (changes > 0) return resourceId;
    const existing = conn.pluck<string>('SELECT id FROM resources WHERE hash = ?1', [hash]);
    if (existing === undefined) {
      throw new VfsError('NotFound', {
        resource_type: 'Resource',
        id: `hash=${hash} (race condition edge case: should exist but not found)`,
      });
    }
    return existing;
  });
}

function rowToTranslation(row: Record<string, unknown>): VfsTranslation {
  const rawContent = row.content_json;
  let sourceText: string | undefined;
  let translatedText: string | undefined;
  if (typeof rawContent === 'string') {
    try {
      const content = JSON.parse(rawContent) as Record<string, unknown>;
      if (typeof content.source === 'string') sourceText = content.source;
      if (typeof content.translated === 'string') translatedText = content.translated;
    } catch {
      // Rust `serde_json::from_str(...).ok()` treats malformed content as absent.
      sourceText = undefined;
      translatedText = undefined;
    }
  }
  let metadata: unknown = undefined;
  if (typeof row.metadata_json === 'string') {
    try { metadata = JSON.parse(row.metadata_json) as unknown; }
    catch { metadata = undefined; }
  }
  return {
    id: String(row.id),
    resourceId: String(row.resource_id),
    title: row.title === null || row.title === undefined ? null : String(row.title),
    srcLang: String(row.src_lang),
    tgtLang: String(row.tgt_lang),
    engine: row.engine === null || row.engine === undefined ? null : String(row.engine),
    model: row.model === null || row.model === undefined ? null : String(row.model),
    isFavorite: Number(row.is_favorite ?? 0) !== 0,
    qualityRating: row.quality_rating === null || row.quality_rating === undefined ? null : Number(row.quality_rating),
    createdAt: String(row.created_at),
    updatedAt: row.updated_at === null || row.updated_at === undefined ? null : String(row.updated_at),
    metadata,
    sourceText,
    translatedText,
  };
}

/** `VfsTranslationRepo::create_translation_with_conn` (translation_repo.rs:380-460). */
export function createTranslation(conn: SqlExecutor, params: CreateTranslationParams): VfsTranslation {
  return database(() => {
    const content = JSON.stringify({ source: params.source, translated: params.translated });
    return withSavepoint(conn, 'create_translation', () => {
      const translationId = `tr_${shortId()}`;
      const hash = computeHashWithSalt(content, translationId);
      const resourceId = createOrReuseResource(conn, 'translation', content, hash, translationId, 'translations');
      const now = toRfc3339Opts(nowEpochNanos(), 'Millis', true);
      conn.run(
        `INSERT INTO translations
           (id, resource_id, title, src_lang, tgt_lang, engine, model, is_favorite,
            quality_rating, created_at, updated_at, metadata_json, device_id, local_version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, NULL, ?8, ?9, NULL, ?10, 1)`,
        [
          translationId, resourceId, params.title ?? null, params.srcLang, params.tgtLang,
          params.engine ?? null, params.model ?? null, now, now, currentDeviceId(),
        ],
      );
      return {
        id: translationId,
        resourceId,
        title: params.title ?? null,
        srcLang: params.srcLang,
        tgtLang: params.tgtLang,
        engine: params.engine ?? null,
        model: params.model ?? null,
        isFavorite: false,
        qualityRating: null,
        createdAt: now,
        updatedAt: now,
        metadata: null,
        sourceText: params.source,
        translatedText: params.translated,
      } satisfies VfsTranslation;
    });
  });
}

/** `VfsTranslationRepo::create_translation_in_folder_with_conn` (translation_repo.rs:1088-1122). */
export function createTranslationInFolder(
  conn: SqlExecutor,
  params: CreateTranslationParams,
  folderId?: string,
): VfsTranslation {
  return withSavepoint(conn, 'create_translation_in_folder', () => {
    if (folderId !== undefined && !folderExists(conn, folderId)) {
      throw new VfsError('NotFound', { resource_type: 'Folder', id: folderId });
    }
    const translation = createTranslation(conn, params);
    const itemId = `fi_${shortId()}`;
    conn.run(
      `INSERT OR REPLACE INTO folder_items (id, folder_id, item_type, item_id, sort_order, created_at, cached_path)
       VALUES (?1, ?2, 'translation', ?3, 0, ?4, NULL)`,
      [itemId, folderId ?? null, translation.id, Date.now()],
    );
    return translation;
  });
}

/** `VfsTranslationRepo::get_translation_with_conn` (translation_repo.rs). */
export function getTranslation(conn: SqlExecutor, translationId: string): VfsTranslation | undefined {
  return database(() => {
    const row = conn.get<Record<string, unknown>>(
      `SELECT t.id, t.resource_id, t.title, t.src_lang, t.tgt_lang, t.engine, t.model,
              t.is_favorite, t.quality_rating, t.created_at, t.updated_at, t.metadata_json,
              r.data AS content_json
         FROM translations t
         LEFT JOIN resources r ON t.resource_id = r.id
        WHERE t.id = ?1 AND t.deleted_at IS NULL`,
      [translationId],
    );
    return row === undefined ? undefined : rowToTranslation(row);
  });
}

/** `persist_translation_metadata` (translation_executor.rs:1293-1311). */
export function updateTranslationMetadata(conn: SqlExecutor, translationId: string, metadata: unknown): void {
  database(() => {
    const updated = conn.run('UPDATE translations SET metadata_json = ?1 WHERE id = ?2', [
      JSON.stringify(metadata),
      translationId,
    ]).changes;
    if (updated === 0) throw new Error(`translation row ${translationId} not found for metadata update`);
  });
}
