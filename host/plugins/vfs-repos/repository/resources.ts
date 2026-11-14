/** Port of dstu-vfs resource_repo.rs. All functions take the caller's connection. */
import { logDebug, logInfo, logWarn } from './logger.ts';
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type ResourceRepository,
  type StorageMode,
  type VfsCreateResourceResult,
  type VfsResource,
  type VfsResourceMetadata,
  type VfsResourceType,
} from '../api.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { databaseResult } from './errors.ts';

const RESOURCE_COLUMNS = `id, hash, type, source_id, source_table, storage_mode, data,
  external_hash, metadata_json, ref_count, created_at, updated_at`;

const KNOWN_TYPES = new Set([
  'note', 'textbook', 'exam', 'translation', 'essay', 'image', 'file', 'retrieval', 'mindmap',
]);

function notFoundResource(id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `Resource not found: ${id}`, { resourceType: 'Resource', id });
}
function databaseMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}
function serializationMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Serialization error: ${message}`);
}

function valueKind(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'string') return 'Text';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'bigint') return 'Integer';
  return 'Blob';
}
function columnError(index: number, name: string, value: SqlValue | undefined): VfsRepositoryError {
  return databaseMessage(`Invalid column type ${valueKind(value)} at index: ${index}, name: ${name}`);
}
function readText(row: Row, name: string, index: number): string {
  const value = row[name];
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
function readOptionalText(row: Row, name: string, index: number): string | null {
  const value = row[name];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
function readInteger(row: Row, name: string, index: number): number {
  const value = row[name];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) throw columnError(index, name, value);
  return number;
}
function readTimestamp(row: Row, name: string, index: number): number {
  const value = row[name];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') return parseRfc3339(value)?.millis ?? 0;
  return 0;
}

/** Rust `VfsResourceType::from_str` + serde lowercase output. */
export function parseResourceType(raw: string): VfsResourceType {
  const lower = raw.toLowerCase();
  if (lower === 'insight_card' || lower === 'insightcard') return 'insightcard';
  if (KNOWN_TYPES.has(lower)) return lower as VfsResourceType;
  return 'file';
}
/** Rust Display for VfsResourceType (stored in resources.type). */
export function displayResourceType(type: VfsResourceType): string {
  return type === 'insightcard' ? 'insight_card' : type;
}
function parseStorageMode(raw: string): StorageMode {
  return raw.toLowerCase() === 'external' ? 'external' : 'inline';
}
function parseMetadata(raw: string | null): VfsResourceMetadata | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as VfsResourceMetadata;
    }
  } catch (error) {
    logWarn('[VFS::ResourceRepo] Failed to parse metadata_json:', error);
  }
  return undefined;
}

function rowToResource(row: Row): VfsResource {
  const resource: VfsResource = {
    id: readText(row, 'id', 0),
    hash: readText(row, 'hash', 1),
    type: parseResourceType(readText(row, 'type', 2)),
    storageMode: parseStorageMode(readText(row, 'storage_mode', 5)),
    refCount: readInteger(row, 'ref_count', 9),
    createdAt: readTimestamp(row, 'created_at', 10),
    updatedAt: readTimestamp(row, 'updated_at', 11),
  };
  const sourceId = readOptionalText(row, 'source_id', 3);
  if (sourceId !== null) resource.sourceId = sourceId;
  const sourceTable = readOptionalText(row, 'source_table', 4);
  if (sourceTable !== null) resource.sourceTable = sourceTable;
  const data = readOptionalText(row, 'data', 6);
  if (data !== null) resource.data = data;
  const externalHash = readOptionalText(row, 'external_hash', 7);
  if (externalHash !== null) resource.externalHash = externalHash;
  const metadata = parseMetadata(readOptionalText(row, 'metadata_json', 8));
  if (metadata !== undefined) resource.metadata = metadata;
  return resource;
}

function mapRows(rows: readonly Row[]): VfsResource[] {
  const resources: VfsResource[] = [];
  for (const row of rows) {
    try { resources.push(rowToResource(row)); }
    catch (error) { logWarn('[VFS::ResourceRepo] Row parse error (skipped):', error); }
  }
  return resources;
}

function metadataJson(metadata: VfsResourceMetadata | null): string | null {
  if (metadata === null) return null;
  try { return JSON.stringify(metadata); }
  catch (error) {
    throw serializationMessage(error instanceof Error ? error.message : String(error));
  }
}

function escapeLikePattern(query: string): string {
  return query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function refCountAfterUpdate(conn: SqlExecutor, resourceId: string): number {
  const value = conn.pluck<number>('SELECT ref_count FROM resources WHERE id = ?1', [resourceId]);
  if (value === undefined) throw databaseMessage('Query returned no rows');
  return Number(value);
}

export function computeResourceHash(data: string): string {
  return sha256HexSync(data);
}
export function computeResourceHashWithSalt(data: string, salt: string): string {
  return sha256HexSync(`${salt}:${data}`);
}

export class ResourceRepo implements ResourceRepository {
  createOrReuse(conn: SqlExecutor, resourceType: VfsResourceType, data: string,
    sourceId: string | null, sourceTable: string | null, metadata: VfsResourceMetadata | null): VfsCreateResourceResult {
    return this.createOrReuseWithHash(conn, resourceType, data, this.computeHash(data),
      sourceId, sourceTable, metadata);
  }

  createOrReuseWithHash(conn: SqlExecutor, resourceType: VfsResourceType, data: string, hash: string,
    sourceId: string | null, sourceTable: string | null, metadata: VfsResourceMetadata | null): VfsCreateResourceResult {
    return databaseResult(() => {
      logDebug(`[VFS::ResourceRepo] Content hash: ${hash}`);
      const resourceId = `res_${nanoid(10)}`;
      const now = Date.now();
      const typeStr = displayResourceType(resourceType);
      const metadataText = metadataJson(metadata);

      const affected = conn.run(`INSERT OR IGNORE INTO resources
          (id, hash, type, source_id, source_table, storage_mode, data, metadata_json, ref_count, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'inline', ?6, ?7, 0, ?8, ?9)`,
      [resourceId, hash, typeStr, sourceId, sourceTable, data, metadataText, now, now]).changes;

      if (affected > 0) {
        logInfo(`[VFS::ResourceRepo] Created new resource: ${resourceId} (type: ${typeStr})`);
        return { resourceId, hash, isNew: true };
      }

      logDebug(`[VFS::ResourceRepo] Hash collision detected, querying existing resource for hash: ${hash}`);
      const existing = this.getByHash(conn, hash);
      if (existing === null) {
        throw notFoundResource(`hash=${hash} (race condition edge case: should exist but not found)`);
      }
      logDebug(`[VFS::ResourceRepo] Reusing existing resource: ${existing.id}`);
      return { resourceId: existing.id, hash, isNew: false };
    });
  }

  createOrReuseExternal(conn: SqlExecutor, resourceType: VfsResourceType, contentHash: string,
    externalHash: string, sourceId: string | null, sourceTable: string | null,
    metadata: VfsResourceMetadata | null): VfsCreateResourceResult {
    return databaseResult(() => {
      const resourceId = `res_${nanoid(10)}`;
      const now = Date.now();
      const typeStr = displayResourceType(resourceType);
      const metadataText = metadataJson(metadata);

      const affected = conn.run(`INSERT OR IGNORE INTO resources
          (id, hash, type, source_id, source_table, storage_mode, data, external_hash, metadata_json, ref_count, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, 'external', NULL, ?6, ?7, 0, ?8, ?9)`,
      [resourceId, contentHash, typeStr, sourceId, sourceTable, externalHash, metadataText, now, now]).changes;

      if (affected > 0) {
        logInfo(`[VFS::ResourceRepo] Created external resource: ${resourceId} (type: ${typeStr})`);
        return { resourceId, hash: contentHash, isNew: true };
      }

      const existing = this.getByHash(conn, contentHash);
      if (existing === null) {
        throw notFoundResource(`hash=${contentHash} (race condition edge case: should exist but not found)`);
      }
      logDebug(`[VFS::ResourceRepo] Reusing existing external resource: ${existing.id}`);
      return { resourceId: existing.id, hash: contentHash, isNew: false };
    });
  }

  getResource(conn: SqlExecutor, resourceId: string): VfsResource | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${RESOURCE_COLUMNS} FROM resources WHERE id = ?1`, [resourceId]);
      return row === undefined ? null : rowToResource(row);
    });
  }

  /** Rust `chatanki_executor.rs:10642-10653`: live-only read, same DTO as getResource. */
  getLiveResource(conn: SqlExecutor, resourceId: string): VfsResource | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${RESOURCE_COLUMNS} FROM resources
        WHERE id = ?1 AND deleted_at IS NULL`, [resourceId]);
      return row === undefined ? null : rowToResource(row);
    });
  }

  getByHash(conn: SqlExecutor, hash: string): VfsResource | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${RESOURCE_COLUMNS} FROM resources WHERE hash = ?1`, [hash]);
      return row === undefined ? null : rowToResource(row);
    });
  }

  exists(conn: SqlExecutor, resourceId: string): boolean {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM resources WHERE id = ?1', [resourceId]) ?? 0) > 0);
  }

  incrementRef(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => {
      conn.run('UPDATE resources SET ref_count = ref_count + 1, updated_at = ?2 WHERE id = ?1',
        [resourceId, Date.now()]);
      const newCount = refCountAfterUpdate(conn, resourceId);
      logDebug(`[VFS::ResourceRepo] Incremented ref_count for ${resourceId}: ${newCount}`);
      return newCount;
    });
  }

  decrementRef(conn: SqlExecutor, resourceId: string): number {
    return databaseResult(() => {
      conn.run('UPDATE resources SET ref_count = MAX(0, ref_count - 1), updated_at = ?2 WHERE id = ?1',
        [resourceId, Date.now()]);
      const newCount = refCountAfterUpdate(conn, resourceId);
      logDebug(`[VFS::ResourceRepo] Decremented ref_count for ${resourceId}: ${newCount}`);
      return newCount;
    });
  }

  decrementRefs(conn: SqlExecutor, resourceIds: readonly string[]): void {
    databaseResult(() => {
      for (const resourceId of resourceIds) {
        try { this.decrementRef(conn, resourceId); }
        catch (error) { logWarn(`[VFS::ResourceRepo] Failed to decrement ref for ${resourceId}:`, error); }
      }
    });
  }

  cleanupUnreferencedRetrievals(conn: SqlExecutor, gracePeriodMs: number): number {
    return databaseResult(() => {
      const cutoff = Date.now() - gracePeriodMs;
      conn.run(`INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
         SELECT s.lance_row_id, u.resource_id
         FROM vfs_index_segments s
         JOIN vfs_index_units u ON s.unit_id = u.id
         WHERE u.resource_id IN (
             SELECT id FROM resources
             WHERE type = 'retrieval' AND ref_count = 0 AND updated_at < ?1
         )
         ON CONFLICT(lance_row_id) DO UPDATE SET
             resource_id = excluded.resource_id,
             enqueued_at = excluded.enqueued_at,
             next_retry_at = 0,
             last_error = NULL`, [cutoff]);
      conn.run(`DELETE FROM vfs_index_units
         WHERE resource_id IN (
             SELECT id FROM resources
             WHERE type = 'retrieval' AND ref_count = 0 AND updated_at < ?1
         )`, [cutoff]);
      const deleted = conn.run(
        "DELETE FROM resources WHERE type = 'retrieval' AND ref_count = 0 AND updated_at < ?1",
        [cutoff]).changes;
      if (deleted > 0) logInfo(`[VFS::ResourceRepo] Swept ${deleted} unreferenced retrieval resources`);
      return deleted;
    });
  }

  cleanupOrphanNoteMindmapResources(conn: SqlExecutor, gracePeriodMs: number): number {
    return databaseResult(() => {
      const cutoff = Date.now() - gracePeriodMs;
      const noteFilter = `type = 'note'
        AND updated_at < ?1
        AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.resource_id = resources.id)`;
      const mindmapFilter = `type = 'mindmap'
        AND updated_at < ?1
        AND NOT EXISTS (SELECT 1 FROM mindmaps m WHERE m.resource_id = resources.id)
        AND NOT EXISTS (SELECT 1 FROM mindmap_versions mv WHERE mv.resource_id = resources.id)`;
      let total = 0;
      for (const filter of [noteFilter, mindmapFilter]) {
        conn.run(`INSERT INTO __lance_orphan_queue (lance_row_id, resource_id)
           SELECT s.lance_row_id, u.resource_id
           FROM vfs_index_segments s
           JOIN vfs_index_units u ON s.unit_id = u.id
           WHERE u.resource_id IN (SELECT id FROM resources WHERE ${filter})
           ON CONFLICT(lance_row_id) DO UPDATE SET
               resource_id = excluded.resource_id,
               enqueued_at = excluded.enqueued_at,
               next_retry_at = 0,
               last_error = NULL`, [cutoff]);
        conn.run(`DELETE FROM vfs_index_units WHERE resource_id IN (SELECT id FROM resources WHERE ${filter})`,
          [cutoff]);
        total += conn.run(`DELETE FROM resources WHERE ${filter}`, [cutoff]).changes;
      }
      if (total > 0) logInfo(`[VFS::ResourceRepo] Swept ${total} orphan note/mindmap resources`);
      return total;
    });
  }

  getBySourceId(conn: SqlExecutor, sourceId: string): VfsResource | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${RESOURCE_COLUMNS} FROM resources
        WHERE source_id = ?1 ORDER BY created_at DESC LIMIT 1`, [sourceId]);
      return row === undefined ? null : rowToResource(row);
    });
  }

  listByType(conn: SqlExecutor, resourceType: VfsResourceType | null, limit: number, offset: number): VfsResource[] {
    return databaseResult(() => {
      const sql = resourceType === null
        ? `SELECT ${RESOURCE_COLUMNS} FROM resources WHERE 1=1
           ORDER BY created_at DESC LIMIT ?1 OFFSET ?2`
        : `SELECT ${RESOURCE_COLUMNS} FROM resources WHERE 1=1 AND type = ?1
           ORDER BY created_at DESC LIMIT ?2 OFFSET ?3`;
      const rows = resourceType === null
        ? conn.all(sql, [limit, offset])
        : conn.all(sql, [displayResourceType(resourceType), limit, offset]);
      return mapRows(rows);
    });
  }

  search(conn: SqlExecutor, query: string, types: readonly VfsResourceType[] | null,
    limit: number, offset: number): VfsResource[] {
    return databaseResult(() => {
      const params: (string | number)[] = [`%${escapeLikePattern(query)}%`];
      let sql = `SELECT ${RESOURCE_COLUMNS} FROM resources WHERE data LIKE ?1 ESCAPE '\\'`;
      if (types !== null && types.length > 0) {
        const placeholders = types.map((_, index) => `?${params.length + index + 1}`);
        sql += ` AND type IN (${placeholders.join(',')})`;
        for (const type of types) params.push(displayResourceType(type));
      }
      sql += ` ORDER BY created_at DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`;
      params.push(limit, offset);
      return mapRows(conn.all(sql, params));
    });
  }

  updateResourceData(conn: SqlExecutor, resourceId: string, newData: string): boolean {
    return databaseResult(() => {
      let newHash = this.computeHash(newData);
      const current = this.getResource(conn, resourceId);
      if (current === null) throw notFoundResource(resourceId);

      const saltedCurrent = this.computeHashWithSalt(newData, resourceId);
      if (newHash === current.hash || saltedCurrent === current.hash) {
        logDebug(`[VFS::ResourceRepo] Resource ${resourceId} data unchanged (hash: ${newHash})`);
        return false;
      }

      const hashTaken = conn.get('SELECT 1 FROM resources WHERE hash = ?1 AND id != ?2',
        [newHash, resourceId]) !== undefined;
      if (hashTaken) newHash = saltedCurrent;

      conn.run(`UPDATE resources SET data = ?1, hash = ?2, updated_at = ?3,
          index_state = 'pending', index_error = NULL,
          index_retry_count = 0, index_next_retry_at = 0
        WHERE id = ?4`, [newData, newHash, Date.now(), resourceId]);
      logInfo(`[VFS::ResourceRepo] Updated resource ${resourceId} data (old_hash: ${current.hash}, new_hash: ${newHash})`);
      return true;
    });
  }

  computeHash(data: string): string {
    return computeResourceHash(data);
  }

  computeHashWithSalt(data: string, salt: string): string {
    return computeResourceHashWithSalt(data, salt);
  }

  saveOcrText(conn: SqlExecutor, resourceId: string, ocrText: string): void {
    databaseResult(() => {
      conn.run('UPDATE resources SET ocr_text = ?1, updated_at = ?2 WHERE id = ?3',
        [ocrText, Date.now(), resourceId]);
      logDebug(`[VFS::ResourceRepo] Saved OCR for resource ${resourceId}`);
    });
  }

  saveOcrTextForFile(conn: SqlExecutor, fileId: string, ocrText: string): number {
    return databaseResult(() => conn.run(
      `UPDATE resources SET ocr_text = ?1, updated_at = datetime('now')
       WHERE id = (SELECT resource_id FROM files WHERE id = ?2)`,
      [ocrText, fileId]).changes);
  }

  /** indexing.rs:1082/3485; the caller owns the best-effort cache warning. */
  saveOcrTextIfEmptyWithConn(conn: SqlExecutor, resourceId: string, ocrText: string): void {
    conn.run(`UPDATE resources SET ocr_text = ?1 WHERE id = ?2 AND (ocr_text IS NULL OR ocr_text = '')`,
      [ocrText, resourceId]);
  }

  /** indexing.rs:3354/3949; unlike saveOcrText, this does not change updated_at. */
  saveOcrTextWithoutTimestampWithConn(conn: SqlExecutor, resourceId: string, ocrText: string): void {
    conn.run('UPDATE resources SET ocr_text = ?1 WHERE id = ?2', [ocrText, resourceId]);
  }

  /** indexing.rs:3777-3785; the caller owns the best-effort cache warning. */
  saveOcrTextWithSqlTimestampWithConn(conn: SqlExecutor, resourceId: string, ocrText: string): void {
    conn.run("UPDATE resources SET ocr_text = ?1, updated_at = datetime('now') WHERE id = ?2",
      [ocrText, resourceId]);
  }

  /** index_webpage_executor.rs:722-729; the caller serializes and wraps errors. */
  updateResourceMetadataWithConn(conn: SqlExecutor, resourceId: string, metadataJson: string,
    updatedAtMs: number): void {
    conn.run('UPDATE resources SET metadata_json = ?1, updated_at = ?2 WHERE id = ?3',
      [metadataJson, updatedAtMs, resourceId]);
  }

  getOcrText(conn: SqlExecutor, resourceId: string): string | null {
    return databaseResult(() => conn.pluck<string | null>(
      'SELECT ocr_text FROM resources WHERE id = ?1', [resourceId]) ?? null);
  }

  hasOcrText(conn: SqlExecutor, resourceId: string): boolean {
    return this.getOcrText(conn, resourceId) !== null;
  }

  getOcrTextBySource(conn: SqlExecutor, sourceId: string, sourceTable: string): string | null {
    return databaseResult(() => conn.pluck<string | null>(
      'SELECT ocr_text FROM resources WHERE source_id = ?1 AND source_table = ?2',
      [sourceId, sourceTable]) ?? null);
  }
}
