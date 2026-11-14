/** Port of dstu-vfs embedding_repo.rs. All functions take the caller's connection. */
import { logWarn } from './logger.ts';
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type EmbeddingDimensionRepository,
  type EmbeddingIndexState,
  type IndexingConfigRepository,
  type IndexStateRepository,
  type VfsEmbeddingDimension,
} from '../api.ts';
import { EmbeddingDimRepo } from './embedding-dims.ts';
import { databaseResult } from './errors.ts';

export const INDEX_STATE_PENDING = 'pending';
export const INDEX_STATE_INDEXING = 'indexing';
export const INDEX_STATE_INDEXED = 'indexed';
export const INDEX_STATE_FAILED = 'failed';
export const INDEX_STATE_DISABLED = 'disabled';
export const MODALITY_TEXT = 'text';
export const MODALITY_MULTIMODAL = 'multimodal';
export const VFS_EMB_TABLE_PREFIX = 'vfs_emb_';

const DIMENSION_COLUMNS = `dimension, modality, record_count, lance_table_name, created_at,
  last_used_at, model_config_id, model_name`;
const CONFIG_BLOCKED_ERROR_SQL = "index_error LIKE '%嵌入模型配置%' OR index_error LIKE '%嵌入配置%' OR index_error LIKE '%未配置默认嵌入维度%'";

function nowMs(): number { return Date.now(); }
function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}
function databaseMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}
function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
function optionalInteger(value: unknown): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value;
  return typeof number === 'number' && Number.isInteger(number) ? number : null;
}
function readText(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== 'string') throw databaseMessage(`Invalid column type at ${name}`);
  return value;
}
function readInteger(row: Row, name: string): number {
  const number = typeof row[name] === 'bigint' ? Number(row[name]) : row[name];
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    throw databaseMessage(`Invalid column type at ${name}`);
  }
  return number;
}

function rowToDimension(row: Row): VfsEmbeddingDimension {
  return {
    dimension: readInteger(row, 'dimension'),
    modality: readText(row, 'modality'),
    recordCount: readInteger(row, 'record_count'),
    lanceTableName: readText(row, 'lance_table_name'),
    createdAt: readInteger(row, 'created_at'),
    lastUsedAt: readInteger(row, 'last_used_at'),
    modelConfigId: optionalText(row.model_config_id),
    modelName: optionalText(row.model_name),
  };
}

function mapDimensions(rows: readonly Row[]): VfsEmbeddingDimension[] {
  const dimensions: VfsEmbeddingDimension[] = [];
  for (const row of rows) {
    try { dimensions.push(rowToDimension(row)); }
    catch (error) { logWarn('Row parse error (embedding_repo):', error); }
  }
  return dimensions;
}

function getConfig(conn: SqlExecutor, key: string): string | null {
  const value = conn.pluck<string | null>(
    'SELECT value FROM vfs_indexing_config WHERE key = ?1', [key]);
  return value ?? null;
}

function parseInt32(key: string, value: string): number {
  // Rust `i32::from_str`: optional sign followed by ASCII digits, no whitespace.
  if (!/^[+-]?\d+$/.test(value)) {
    throw invalidArgument(key, `Expected an integer, got ${JSON.stringify(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -2147483648 || parsed > 2147483647) {
    throw invalidArgument(key, `Expected an integer, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function parseF64(key: string, value: string): number {
  // Rust `f64::from_str` accepts `inf`/`infinity`/`NaN` (case-insensitive) in
  // addition to the decimal grammar. Range validation below rejects non-finite
  // values with the same message as Rust.
  const text = value;
  let parsed: number;
  if (/^[+-]?(?:inf|infinity)$/i.test(text)) {
    parsed = text.startsWith('-') ? -Infinity : Infinity;
  } else if (/^[+-]?nan$/i.test(text)) {
    parsed = NaN;
  } else if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    parsed = Number(text);
  } else {
    throw invalidArgument(key, `Expected a decimal between 0 and 1, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function validateConfig(conn: SqlExecutor, key: string, value: string): void {
  const invalid = (reason: string): VfsRepositoryError => invalidArgument(key, reason);
  switch (key) {
    case 'indexing.enabled':
    case 'search.enable_hybrid':
    case 'search.enable_reranking':
      if (!['true', 'false', '0', '1'].includes(value.toLowerCase())) {
        throw invalid('Expected true, false, 0, or 1');
      }
      break;
    case 'indexing.batch_size': {
      const parsed = parseInt32(key, value);
      if (parsed < 1 || parsed > 1000) throw invalid('Must be between 1 and 1000');
      break;
    }
    case 'indexing.interval_secs':
    case 'indexing.retry_delay_secs': {
      const parsed = parseInt32(key, value);
      if (parsed < 1 || parsed > 86_400) throw invalid('Must be between 1 and 86400 seconds');
      break;
    }
    case 'indexing.max_concurrent': {
      const parsed = parseInt32(key, value);
      if (parsed < 1 || parsed > 32) throw invalid('Must be between 1 and 32');
      break;
    }
    case 'indexing.max_retries': {
      const parsed = parseInt32(key, value);
      if (parsed < 0 || parsed > 20) throw invalid('Must be between 0 and 20');
      break;
    }
    case 'chunking.strategy':
      if (value !== 'fixed_size' && value !== 'semantic') throw invalid('Must be fixed_size or semantic');
      break;
    case 'chunking.chunk_size': {
      const parsed = parseInt32(key, value);
      if (parsed < 16 || parsed > 65_536) throw invalid('Must be between 16 and 65536');
      const overlapRaw = getConfig(conn, 'chunking.chunk_overlap');
      const overlap = overlapRaw !== null && /^-?\d+$/.test(overlapRaw) ? Number(overlapRaw) : 0;
      const minimumRaw = getConfig(conn, 'chunking.min_chunk_size');
      const minimum = minimumRaw !== null && /^-?\d+$/.test(minimumRaw) ? Number(minimumRaw) : 1;
      if (overlap >= parsed) throw invalid(`Must be greater than chunking.chunk_overlap (${overlap})`);
      if (minimum > parsed) throw invalid(`Must be at least chunking.min_chunk_size (${minimum})`);
      break;
    }
    case 'chunking.chunk_overlap': {
      const parsed = parseInt32(key, value);
      const chunkSizeRaw = getConfig(conn, 'chunking.chunk_size');
      const chunkSize = chunkSizeRaw !== null && /^-?\d+$/.test(chunkSizeRaw) ? Number(chunkSizeRaw) : 512;
      if (parsed < 0 || parsed >= chunkSize) {
        throw invalid(`Must be non-negative and less than chunking.chunk_size (${chunkSize})`);
      }
      break;
    }
    case 'chunking.min_chunk_size': {
      const parsed = parseInt32(key, value);
      const chunkSizeRaw = getConfig(conn, 'chunking.chunk_size');
      const chunkSize = chunkSizeRaw !== null && /^-?\d+$/.test(chunkSizeRaw) ? Number(chunkSizeRaw) : 512;
      if (parsed < 1 || parsed > chunkSize) throw invalid(`Must be between 1 and ${chunkSize}`);
      break;
    }
    case 'search.default_top_k': {
      const parsed = parseInt32(key, value);
      if (parsed < 1 || parsed > 500) throw invalid('Must be between 1 and 500');
      break;
    }
    case 'search.fts_weight':
    case 'search.vector_weight': {
      const parsed = parseF64(key, value);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw invalid('Must be a finite value between 0 and 1');
      }
      break;
    }
    default:
      throw invalid('Unknown indexing configuration key');
  }
}

export class EmbeddingDimensionRepo implements EmbeddingDimensionRepository {
  private readonly dims = new EmbeddingDimRepo();

  registerDimension(conn: SqlExecutor, dimension: number, modality: string,
    _modelConfigId: string | null): string {
    return this.registerDimensionWithModel(conn, dimension, modality, null, null);
  }

  registerDimensionWithModel(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string | null, modelName: string | null): string {
    return databaseResult(() => this.dims.registerWithModel(conn, dimension, modality,
      modelConfigId, modelName).lanceTableName);
  }

  getDimension(conn: SqlExecutor, dimension: number, modality: string): VfsEmbeddingDimension | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${DIMENSION_COLUMNS} FROM vfs_embedding_dims
        WHERE dimension = ?1 AND modality = ?2`, [dimension, modality]);
      return row === undefined ? null : rowToDimension(row);
    });
  }

  listDimensions(conn: SqlExecutor): VfsEmbeddingDimension[] {
    return databaseResult(() => mapDimensions(conn.all<Row>(
      `SELECT ${DIMENSION_COLUMNS} FROM vfs_embedding_dims ORDER BY last_used_at DESC`)));
  }

  listDimensionsWithModelBinding(conn: SqlExecutor): VfsEmbeddingDimension[] {
    return databaseResult(() => mapDimensions(conn.all<Row>(
      `SELECT ${DIMENSION_COLUMNS} FROM vfs_embedding_dims
       WHERE model_config_id IS NOT NULL AND record_count > 0
       ORDER BY last_used_at DESC`)));
  }

  updateRecordCount(conn: SqlExecutor, dimension: number, modality: string, count: number): void {
    databaseResult(() => {
      conn.run(`UPDATE vfs_embedding_dims SET record_count = ?1, last_used_at = ?2
        WHERE dimension = ?3 AND modality = ?4`, [count, nowMs(), dimension, modality]);
    });
  }

  incrementRecordCount(conn: SqlExecutor, dimension: number, modality: string, delta: number): void {
    databaseResult(() => {
      conn.run(`UPDATE vfs_embedding_dims SET record_count = record_count + ?1, last_used_at = ?2
        WHERE dimension = ?3 AND modality = ?4`, [delta, nowMs(), dimension, modality]);
    });
  }

  getLanceTableName(dimension: number, modality: string): string {
    return `${VFS_EMB_TABLE_PREFIX}${modality}_${dimension}`;
  }

  updateModelAssignment(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string, modelName: string): boolean {
    return databaseResult(() => this.dims.updateModelBinding(conn, dimension, modality,
      modelConfigId, modelName));
  }
}

export class IndexStateRepo implements IndexStateRepository {
  getIndexState(conn: SqlExecutor, resourceId: string): EmbeddingIndexState | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `SELECT index_state, index_hash, index_error, indexed_at, index_retry_count
         FROM resources WHERE id = ?1`, [resourceId]);
      if (row === undefined) return null;
      return {
        state: optionalText(row.index_state) ?? INDEX_STATE_PENDING,
        hash: optionalText(row.index_hash),
        error: optionalText(row.index_error),
        indexedAt: optionalInteger(row.indexed_at),
        retryCount: optionalInteger(row.index_retry_count) ?? 0,
      };
    });
  }

  setIndexState(conn: SqlExecutor, resourceId: string, state: string,
    hash: string | null, error: string | null): void {
    databaseResult(() => {
      const indexedAt = state === INDEX_STATE_INDEXED ? nowMs() : null;
      conn.run(`UPDATE resources
        SET index_state = ?1, index_hash = ?2, index_error = ?3, indexed_at = ?4,
            index_retry_count = CASE WHEN ?1 IN ('pending', 'indexed', 'disabled') THEN 0 ELSE index_retry_count END,
            index_next_retry_at = CASE WHEN ?1 IN ('pending', 'indexed', 'disabled') THEN 0 ELSE index_next_retry_at END
        WHERE id = ?5`, [state, hash, error, indexedAt, resourceId]);
    });
  }

  markPending(conn: SqlExecutor, resourceId: string): void {
    this.setIndexState(conn, resourceId, INDEX_STATE_PENDING, null, null);
  }

  markIndexing(conn: SqlExecutor, resourceId: string): void {
    this.setIndexState(conn, resourceId, INDEX_STATE_INDEXING, null, null);
  }

  markIndexed(conn: SqlExecutor, resourceId: string, hash: string): void {
    this.setIndexState(conn, resourceId, INDEX_STATE_INDEXED, hash, null);
  }

  markFailed(conn: SqlExecutor, resourceId: string, error: string): void {
    databaseResult(() => {
      const retryCount = Number(conn.pluck<number>(
        'SELECT COALESCE(index_retry_count, 0) FROM resources WHERE id = ?1', [resourceId]) ?? 0);
      const delaySecs = Math.min(5 * (2 ** Math.min(Math.max(retryCount, 0), 10)), 3600);
      const nextRetryAt = nowMs() + delaySecs * 1000;
      conn.run(`UPDATE resources
        SET index_state = ?1, index_error = ?2,
            index_retry_count = COALESCE(index_retry_count, 0) + 1,
            index_next_retry_at = ?3
        WHERE id = ?4`, [INDEX_STATE_FAILED, error, nextRetryAt, resourceId]);
    });
  }

  reviveConfigBlocked(conn: SqlExecutor): number {
    return databaseResult(() => {
      conn.exec('BEGIN');
      try {
        conn.run(`UPDATE vfs_index_units SET text_state = 'pending', text_error = NULL
          WHERE text_state = 'failed'
            AND resource_id IN (SELECT id FROM resources WHERE index_state = ?1 AND (${CONFIG_BLOCKED_ERROR_SQL}))`,
        [INDEX_STATE_FAILED]);
        const revived = conn.run(`UPDATE resources
          SET index_state = ?1, index_error = NULL, index_retry_count = 0, index_next_retry_at = 0
          WHERE index_state = ?2 AND (${CONFIG_BLOCKED_ERROR_SQL})`,
        [INDEX_STATE_PENDING, INDEX_STATE_FAILED]).changes;
        conn.exec('COMMIT');
        return revived;
      } catch (error) {
        try { conn.exec('ROLLBACK'); }
        catch (rollbackError) { logWarn('[VfsIndexStateRepo] Revive rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  requeuePagedPdfsOnce(conn: SqlExecutor): number {
    return databaseResult(() => {
      const key = 'migration.pdf_paged_units_v2';
      if (getConfig(conn, key) !== null) return 0;
      conn.exec('BEGIN');
      try {
        const requeued = conn.run(`UPDATE resources
          SET index_state = ?1, index_error = NULL, index_retry_count = 0, index_next_retry_at = 0
          WHERE deleted_at IS NULL
            AND COALESCE(index_state, 'pending') IN ('indexed', 'failed')
            AND id IN (SELECT resource_id FROM files
                       WHERE deleted_at IS NULL AND COALESCE(page_count, 0) > 1
                         AND resource_id IS NOT NULL)`, [INDEX_STATE_PENDING]).changes;
        conn.run(`INSERT OR REPLACE INTO vfs_indexing_config (key, value, updated_at)
          VALUES (?1, 'done', ?2)`, [key, nowMs()]);
        conn.exec('COMMIT');
        return requeued;
      } catch (error) {
        try { conn.exec('ROLLBACK'); }
        catch (rollbackError) { logWarn('[VfsIndexStateRepo] Requeue rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  markDisabled(conn: SqlExecutor, resourceId: string): void {
    this.setIndexState(conn, resourceId, INDEX_STATE_DISABLED, null, null);
  }

  markDisabledWithReason(conn: SqlExecutor, resourceId: string, reason: string): void {
    this.setIndexState(conn, resourceId, INDEX_STATE_DISABLED, null, reason);
  }

  getPendingResources(conn: SqlExecutor, limit: number, maxRetries: number): string[] {
    return databaseResult(() => mapIds(conn.all<Row>(`SELECT id FROM resources r
      WHERE (r.index_state = 'pending' OR r.index_state IS NULL)
         OR (r.index_state = 'failed'
             AND COALESCE(r.index_next_retry_at, 0) <= ?1
             AND COALESCE(r.index_retry_count, 0) < ?2)
         OR (r.index_state = 'indexed' AND NOT EXISTS (SELECT 1 FROM vfs_index_units WHERE resource_id = r.id))
      ORDER BY r.updated_at DESC LIMIT ?3`, [nowMs(), maxRetries, limit])));
  }

  claimPendingResources(conn: SqlExecutor, limit: number, maxRetries: number): string[] {
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const ids = this.getPendingResources(conn, limit, maxRetries);
        for (const resourceId of ids) {
          conn.run(`UPDATE resources SET index_state = ?1, index_error = NULL WHERE id = ?2`,
            [INDEX_STATE_INDEXING, resourceId]);
        }
        conn.exec('COMMIT');
        return ids;
      } catch (error) {
        try { conn.exec('ROLLBACK'); }
        catch (rollbackError) { logWarn('[VfsIndexStateRepo] Claim rollback failed:', rollbackError); }
        throw error;
      }
    });
  }

  getDisabledResources(conn: SqlExecutor, limit: number): string[] {
    return databaseResult(() => mapIds(conn.all<Row>(`SELECT id FROM resources r
      WHERE r.index_state = 'disabled' ORDER BY r.updated_at DESC LIMIT ?1`, [limit])));
  }

  getResourcesNeedingReindex(conn: SqlExecutor, limit: number): Array<[string, string]> {
    return databaseResult(() => conn.all<Row>(`SELECT id, hash FROM resources
      WHERE index_state = 'indexed' AND index_hash != hash
      ORDER BY updated_at DESC LIMIT ?1`, [limit]).flatMap(row => {
      try { return [[readText(row, 'id'), readText(row, 'hash')] as [string, string]]; }
      catch (error) { logWarn('Row parse error (embedding_repo):', error); return []; }
    }));
  }

  getMmIndexState(conn: SqlExecutor, resourceId: string): EmbeddingIndexState | null {
    return databaseResult(() => {
      const row = conn.get<Row>(
        `SELECT mm_index_state, NULL AS hash, mm_index_error, mm_indexed_at, mm_index_retry_count
         FROM resources WHERE id = ?1`, [resourceId]);
      if (row === undefined) return null;
      return {
        state: optionalText(row.mm_index_state) ?? INDEX_STATE_PENDING,
        hash: null,
        error: optionalText(row.mm_index_error),
        indexedAt: optionalInteger(row.mm_indexed_at),
        retryCount: optionalInteger(row.mm_index_retry_count) ?? 0,
      };
    });
  }

  setMmIndexState(conn: SqlExecutor, resourceId: string, state: string, error: string | null): void {
    databaseResult(() => {
      const indexedAt = state === INDEX_STATE_INDEXED ? nowMs() : null;
      conn.run(`UPDATE resources
        SET mm_index_state = ?1, mm_index_error = ?2,
            mm_indexed_at = COALESCE(?3, mm_indexed_at),
            mm_index_retry_count = CASE WHEN ?1 IN ('pending', 'indexed', 'disabled') THEN 0 ELSE mm_index_retry_count END,
            mm_index_next_retry_at = CASE WHEN ?1 IN ('pending', 'indexed', 'disabled') THEN 0 ELSE mm_index_next_retry_at END
        WHERE id = ?4`, [state, error, indexedAt, resourceId]);
    });
  }

  markMmPending(conn: SqlExecutor, resourceId: string): void {
    this.setMmIndexState(conn, resourceId, INDEX_STATE_PENDING, null);
  }

  markMmIndexing(conn: SqlExecutor, resourceId: string): void {
    this.setMmIndexState(conn, resourceId, INDEX_STATE_INDEXING, null);
  }

  markMmIndexed(conn: SqlExecutor, resourceId: string): void {
    this.setMmIndexState(conn, resourceId, INDEX_STATE_INDEXED, null);
  }

  markMmFailed(conn: SqlExecutor, resourceId: string, error: string): void {
    databaseResult(() => {
      const retryCount = Number(conn.pluck<number>(
        'SELECT COALESCE(mm_index_retry_count, 0) FROM resources WHERE id = ?1', [resourceId]) ?? 0);
      const delaySecs = Math.min(5 * (2 ** Math.min(Math.max(retryCount, 0), 10)), 3600);
      const nextRetryAt = nowMs() + delaySecs * 1000;
      conn.run(`UPDATE resources
        SET mm_index_state = ?1, mm_index_error = ?2,
            mm_index_retry_count = COALESCE(mm_index_retry_count, 0) + 1,
            mm_index_next_retry_at = ?3
        WHERE id = ?4`, [INDEX_STATE_FAILED, error, nextRetryAt, resourceId]);
    });
  }

  markMmDisabled(conn: SqlExecutor, resourceId: string): void {
    this.setMmIndexState(conn, resourceId, INDEX_STATE_DISABLED, null);
  }

  getMmPendingResources(conn: SqlExecutor, limit: number, maxRetries: number): string[] {
    return databaseResult(() => mapIds(conn.all<Row>(`SELECT id FROM resources r
      WHERE r.type IN ('image', 'textbook', 'file', 'exam')
        AND ((r.mm_index_state = 'pending' OR r.mm_index_state IS NULL)
             OR (r.mm_index_state = 'failed'
                 AND COALESCE(r.mm_index_next_retry_at, 0) <= ?1
                 AND COALESCE(r.mm_index_retry_count, 0) < ?2))
      ORDER BY r.updated_at DESC LIMIT ?3`, [nowMs(), maxRetries, limit])));
  }

  claimMmIndexingResources(conn: SqlExecutor, resourceIds: readonly string[], maxRetries: number): string[] {
    if (resourceIds.length === 0) return [];
    return databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const now = nowMs();
        const claimed: string[] = [];
        for (const resourceId of resourceIds) {
          const updated = conn.run(`UPDATE resources
            SET mm_index_state = 'indexing', mm_index_error = NULL
            WHERE id = ?1
              AND COALESCE(mm_index_state, 'pending') <> 'indexing'
              AND (COALESCE(mm_index_state, 'pending') <> 'failed'
                   OR (COALESCE(mm_index_next_retry_at, 0) <= ?2
                       AND COALESCE(mm_index_retry_count, 0) < ?3))`,
          [resourceId, now, maxRetries]).changes;
          if (updated > 0) claimed.push(resourceId);
        }
        conn.exec('COMMIT');
        return claimed;
      } catch (error) {
        try { conn.exec('ROLLBACK'); }
        catch (rollbackError) { logWarn('[VfsIndexStateRepo] MM claim rollback failed:', rollbackError); }
        throw error;
      }
    });
  }
}

function mapIds(rows: readonly Row[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    try { ids.push(readText(row, 'id')); }
    catch (error) { logWarn('Row parse error (embedding_repo):', error); }
  }
  return ids;
}

export class IndexingConfigRepo implements IndexingConfigRepository {
  getConfig(conn: SqlExecutor, key: string): string | null {
    return databaseResult(() => getConfig(conn, key));
  }

  setConfig(conn: SqlExecutor, key: string, value: string): void {
    databaseResult(() => {
      validateConfig(conn, key, value);
      conn.run(`INSERT OR REPLACE INTO vfs_indexing_config (key, value, updated_at)
        VALUES (?1, ?2, ?3)`, [key, value, nowMs()]);
    });
  }

  getBool(conn: SqlExecutor, key: string, defaultValue: boolean): boolean {
    const value = this.getConfig(conn, key);
    return value === null ? defaultValue : value.toLowerCase() === 'true' || value === '1';
  }

  getI32(conn: SqlExecutor, key: string, defaultValue: number): number {
    const value = this.getConfig(conn, key);
    if (value === null) return defaultValue;
    return /^-?\d+$/.test(value) ? Number(value) : defaultValue;
  }

  getF64(conn: SqlExecutor, key: string, defaultValue: number): number {
    const value = this.getConfig(conn, key);
    if (value === null) return defaultValue;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }
}
