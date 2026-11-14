/**
 * Index configuration and resource index-state repository.
 *
 * Mirrors `crates/dstu-vfs/src/vfs/repos/embedding_repo.rs`
 * (`VfsIndexingConfigRepo` + `VfsIndexStateRepo`). Resource state and dimension
 * writes require L11's published owner; no standalone SQL fallback is allowed.
 */
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import { now } from '../../../platform/time/index.ts';
import { requireVfsTableOwners } from './owners.ts';

export const INDEX_STATE_PENDING = 'pending';
export const INDEX_STATE_INDEXING = 'indexing';
export const INDEX_STATE_INDEXED = 'indexed';
export const INDEX_STATE_FAILED = 'failed';
export const INDEX_STATE_DISABLED = 'disabled';

export class VfsIndexRepositoryError extends Error {
  readonly code: string;
  readonly param: string | null;
  constructor(code: string, message: string, param: string | null = null) {
    super(message);
    this.name = 'VfsIndexRepositoryError';
    this.code = code;
    this.param = param;
  }
}

function databaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  throw new VfsIndexRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function integer(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fallback;
}

export function nowMs(): number {
  return now().millis;
}

/** Rust `str::parse::<i32>` (sign + ASCII digits, i32 range). */
function parseI32(value: string): number | undefined {
  if (!/^[+-]?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < -2147483648 || parsed > 2147483647) return undefined;
  return parsed;
}

/** Rust `value.parse().unwrap_or(default)` for `i32`. */
function looseI32(value: string, fallback: number): number {
  return parseI32(value) ?? fallback;
}

export interface IndexState {
  state: string;
  hash: string | null;
  error: string | null;
  indexed_at: number | null;
  retry_count: number;
}

function rowToIndexState(row: Row): IndexState {
  return {
    state: nullableText(row['index_state']) ?? INDEX_STATE_PENDING,
    hash: nullableText(row['index_hash']),
    error: nullableText(row['index_error']),
    indexed_at: row['indexed_at'] === null || row['indexed_at'] === undefined
      ? null
      : integer(row['indexed_at']),
    retry_count: integer(row['index_retry_count']),
  };
}

// ------------------------------------------------------------------ config

export function getConfig(db: SqlExecutor, key: string): string | null {
  try {
    const row = db.get('SELECT value FROM vfs_indexing_config WHERE key = ?1', [key]);
    return row === undefined ? null : nullableText(row['value']);
  } catch (error) {
    return databaseError(error);
  }
}

export function getBool(db: SqlExecutor, key: string, fallback: boolean): boolean {
  const value = getConfig(db, key);
  if (value === null) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

export function getI32(db: SqlExecutor, key: string, fallback: number): number {
  const value = getConfig(db, key);
  return value === null ? fallback : looseI32(value, fallback);
}

// ------------------------------------------------------------------ state

export function getIndexState(db: SqlExecutor, resourceId: string): IndexState | null {
  try {
    const row = db.get(
      `SELECT index_state, index_hash, index_error, indexed_at, index_retry_count
       FROM resources WHERE id = ?1`,
      [resourceId],
    );
    return row === undefined ? null : rowToIndexState(row);
  } catch (error) {
    return databaseError(error);
  }
}

export function setIndexState(
  db: SqlExecutor,
  resourceId: string,
  state: string,
  hash: string | null,
  error: string | null,
): void {
  requireVfsTableOwners(db).indexStates.setIndexState(db, resourceId, state, hash, error);
}

export function markPending(db: SqlExecutor, resourceId: string): void {
  setIndexState(db, resourceId, INDEX_STATE_PENDING, null, null);
}

export function markIndexing(db: SqlExecutor, resourceId: string): void {
  setIndexState(db, resourceId, INDEX_STATE_INDEXING, null, null);
}

export function markIndexed(db: SqlExecutor, resourceId: string, hash: string): void {
  setIndexState(db, resourceId, INDEX_STATE_INDEXED, hash, null);
}

export function markFailed(db: SqlExecutor, resourceId: string, error: string): void {
  requireVfsTableOwners(db).indexStates.markFailed(db, resourceId, error);
}

export function markDisabled(db: SqlExecutor, resourceId: string): void {
  setIndexState(db, resourceId, INDEX_STATE_DISABLED, null, null);
}

export function markDisabledWithReason(db: SqlExecutor, resourceId: string, reason: string): void {
  setIndexState(db, resourceId, INDEX_STATE_DISABLED, null, reason);
}

export function getPendingResources(db: SqlExecutor, limit: number, maxRetries: number): string[] {
  try {
    return db.all<Row>(
      `SELECT id FROM resources r
       WHERE (r.index_state = 'pending' OR r.index_state IS NULL)
          OR (r.index_state = 'failed'
              AND COALESCE(r.index_next_retry_at, 0) <= ?1
              AND COALESCE(r.index_retry_count, 0) < ?2)
          OR (r.index_state = 'indexed'
              AND NOT EXISTS (SELECT 1 FROM vfs_index_units WHERE resource_id = r.id))
       ORDER BY r.updated_at DESC
       LIMIT ?3`,
      [nowMs(), maxRetries, limit],
    ).map((row) => text(row['id']));
  } catch (error) {
    return databaseError(error);
  }
}

/** Atomically claim pending resources and flip them to `indexing`. */
export function claimPendingResources(db: SqlExecutor, limit: number, maxRetries: number): string[] {
  return requireVfsTableOwners(db).indexStates.claimPendingResources(db, limit, maxRetries);
}

export function getDisabledResources(db: SqlExecutor, limit: number): string[] {
  try {
    return db.all<Row>(
      `SELECT id FROM resources r
       WHERE r.index_state = 'disabled'
       ORDER BY r.updated_at DESC
       LIMIT ?1`,
      [limit],
    ).map((row) => text(row['id']));
  } catch (error) {
    return databaseError(error);
  }
}

export function getResourcesNeedingReindex(db: SqlExecutor, limit: number): Array<[string, string]> {
  try {
    return db.all<Row>(
      `SELECT id, hash FROM resources
       WHERE index_state = 'indexed' AND index_hash != hash
       ORDER BY updated_at DESC
       LIMIT ?1`,
      [limit],
    ).map((row) => [text(row['id']), text(row['hash'])]);
  } catch (error) {
    return databaseError(error);
  }
}

export function reviveConfigBlocked(db: SqlExecutor): number {
  return requireVfsTableOwners(db).indexStates.reviveConfigBlocked(db);
}

/** One-shot migration: requeue multi-page PDF resources for paged units. */
export function requeuePagedPdfsOnce(db: SqlExecutor): number {
  return requireVfsTableOwners(db).indexStates.requeuePagedPdfsOnce(db);
}

export function getMmIndexState(db: SqlExecutor, resourceId: string): IndexState | null {
  try {
    const row = db.get(
      `SELECT mm_index_state AS index_state, NULL AS index_hash, mm_index_error AS index_error,
              mm_indexed_at AS indexed_at, mm_index_retry_count AS index_retry_count
       FROM resources WHERE id = ?1`,
      [resourceId],
    );
    return row === undefined ? null : rowToIndexState(row);
  } catch (error) {
    return databaseError(error);
  }
}

/** Refresh `vfs_embedding_dims.record_count` from committed segments. */
export function refreshCountsFromSegments(db: SqlExecutor): void {
  requireVfsTableOwners(db).embeddingDims.refreshCountsFromSegments(db);
}
