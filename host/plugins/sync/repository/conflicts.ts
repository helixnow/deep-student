import { defineQuery, StorageError, type SqlExecutor } from '../../../platform/storage/api.ts';
import type { RecordConflictCountEntry } from '../api.ts';

/** commands_sync.rs:4530-4546. Keep the original separator-based grouping. */
export function countUnresolvedConflicts(db: SqlExecutor): RecordConflictCountEntry {
  const exists = db.pluck<number>("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__sync_conflicts')");
  if (!exists) return { groups: 0, rows: 0 };
  const row = db.one<{ groups: number; rows: number }>(
    `SELECT COUNT(DISTINCT table_name || '\u001f' || record_id) AS groups, COUNT(*) AS rows
     FROM __sync_conflicts WHERE resolved_at IS NULL`,
  );
  return { groups: Math.max(0, row.groups), rows: Math.max(0, row.rows) };
}

export function sqliteTableExists(db: SqlExecutor, table: string): boolean {
  try {
    return Boolean(db.pluck("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table]));
  } catch {
    return false; // commands_sync.rs:4157 unwrap_or(false)
  }
}

export function discardQuarantine(db: SqlExecutor, id: number): boolean {
  return db.run('DELETE FROM __sync_quarantine WHERE id=?1', [id]).changes > 0;
}

export function discardAllQuarantine(db: SqlExecutor): number {
  return db.run('DELETE FROM __sync_quarantine').changes;
}

/** commands_sync.rs:5040-5045. Callers treat SQL errors as zero. */
export function purgeResolvedConflicts(db: SqlExecutor, cutoff: string): number {
  return db.run(
    'DELETE FROM __sync_conflicts WHERE resolved_at IS NOT NULL AND resolved_at < ?1',
    [cutoff],
  ).changes;
}

export interface QuarantineRow {
  id: bigint;
  source_device_id: string;
  source_seq: bigint;
  table_name: string;
  record_id: string;
  operation: string;
  payload_json: string | null;
  error: string;
  attempts: bigint;
  first_seen: string;
  last_attempt: string;
}

/** commands_sync.rs:4192-4216. Errors surface to the caller with command-level context. */
export function listQuarantineRows(db: SqlExecutor): QuarantineRow[] {
  return readList(db,
    `SELECT id, source_device_id, source_seq, table_name, record_id, operation,
            payload_json, error, attempts, first_seen, last_attempt
     FROM __sync_quarantine`, '隔离区', row => ({
    id: integer(row, 'id', 0), source_device_id: text(row, 'source_device_id', 1),
    source_seq: integer(row, 'source_seq', 2), table_name: text(row, 'table_name', 3),
    record_id: text(row, 'record_id', 4), operation: text(row, 'operation', 5),
    payload_json: nullableText(row, 'payload_json', 6), error: text(row, 'error', 7),
    attempts: integer(row, 'attempts', 8), first_seen: text(row, 'first_seen', 9),
    last_attempt: text(row, 'last_attempt', 10),
  }));
}

export interface RecordConflictRow {
  id: bigint;
  table_name: string;
  record_id: string;
  side: string;
  data_json: string;
  winning_device_id: string | null;
  losing_device_id: string | null;
  detected_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

/** commands_sync.rs:4439-4445. */
export function listUnresolvedConflictRows(db: SqlExecutor): RecordConflictRow[] {
  return readList(db,
    `SELECT id, table_name, record_id, side, data_json, winning_device_id,
            losing_device_id, detected_at, resolved_at, resolution
     FROM __sync_conflicts
     WHERE resolved_at IS NULL
     ORDER BY detected_at DESC`, '冲突', row => ({
    id: integer(row, 'id', 0), table_name: text(row, 'table_name', 1),
    record_id: text(row, 'record_id', 2), side: text(row, 'side', 3),
    data_json: text(row, 'data_json', 4), winning_device_id: nullableText(row, 'winning_device_id', 5),
    losing_device_id: nullableText(row, 'losing_device_id', 6), detected_at: text(row, 'detected_at', 7),
    resolved_at: nullableText(row, 'resolved_at', 8), resolution: nullableText(row, 'resolution', 9),
  }));
}

/** commands_sync.rs:4635：读取未解决冲突行的 generation。 */
export function listUnresolvedConflictIds(db: SqlExecutor, tableName: string, recordId: string): bigint[] {
  return db.all(defineQuery<[string, string], { id: bigint }>(
    `SELECT id FROM __sync_conflicts
     WHERE table_name = ?1 AND record_id = ?2 AND resolved_at IS NULL
      ORDER BY id ASC`, { options: { safeIntegers: true } }),
    [tableName, recordId],
  ).map(row => row.id);
}

/** commands_sync.rs:4652：读取某侧最新快照。 */
export function latestConflictSideData(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  side: string,
): string | null {
  return db.pluck<string>(
    `SELECT data_json FROM __sync_conflicts
     WHERE table_name = ?1 AND record_id = ?2 AND side = ?3 AND resolved_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [tableName, recordId, side],
  ) ?? null;
}

/** commands_sync.rs:4885/4958：标记一条冲突已解决，返回受影响行数。 */
export function markConflictResolved(
  db: SqlExecutor,
  conflictId: number | bigint,
  tableName: string,
  recordId: string,
  resolvedAt: string,
  resolution: string,
): number {
  return db.run(
    `UPDATE __sync_conflicts
     SET resolved_at = ?1, resolution = ?2
     WHERE id = ?3 AND table_name = ?4 AND record_id = ?5
       AND resolved_at IS NULL`,
    [resolvedAt, resolution, conflictId, tableName, recordId],
  ).changes;
}

/** commands_sync.rs:4332：按 id 升序列出隔离项。 */
export function listQuarantineIds(db: SqlExecutor): bigint[] {
  return readList(db, 'SELECT id FROM __sync_quarantine ORDER BY id', '批量', row => integer(row, 'id', 0));
}

type RawRow = Record<string, unknown>;
const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** query_map binds first; SQLite stepping and row.get decoding occur during iteration.
 * Quarantine propagates row errors; conflict/retry-all flatten them (including step errors).
 */
function readList<T>(db: SqlExecutor, sql: string, kind: '隔离区' | '冲突' | '批量', decode: (row: RawRow) => T): T[] {
  const result: T[] = [];
  try {
    for (const row of db.iterate(defineQuery<[], RawRow>(sql, { options: { safeIntegers: true } }), [])) {
      try { result.push(decode(row)); }
      catch (error) { if (kind === '隔离区') throw new Error(`读取隔离记录失败: ${detail(error)}`); }
    }
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.phase === 'prepare') throw new Error(`准备${kind}查询失败: ${error.message}`);
      if (error.phase === 'bind') throw new Error(`执行${kind}查询失败: ${error.message}`);
      if (error.phase === 'execute') {
        if (kind === '隔离区') throw new Error(`读取隔离记录失败: ${error.message}`);
        return result;
      }
    }
    throw error;
  }
  return result;
}

function invalidColumn(row: RawRow, name: string, index: number): never {
  const value = row[name];
  const type = value === null ? 'Null' : typeof value === 'string' ? 'Text'
    : typeof value === 'bigint' ? 'Integer' : typeof value === 'number' ? 'Real' : 'Blob';
  throw new Error(`Invalid column type ${type} at index: ${index}, name: ${name}`);
}
function integer(row: RawRow, name: string, index: number): bigint {
  const value = row[name];
  if (typeof value !== 'bigint') return invalidColumn(row, name, index);
  return value;
}
function text(row: RawRow, name: string, index: number): string {
  const value = row[name];
  if (typeof value !== 'string') return invalidColumn(row, name, index);
  return value;
}
function nullableText(row: RawRow, name: string, index: number): string | null {
  return row[name] === null ? null : text(row, name, index);
}
