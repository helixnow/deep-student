import { defineQuery, type DatabaseHandle, type SqlExecutor } from '../../../platform/storage/api.ts';
import { parseJsonLossless, type DbJson as JsonValue } from '../../../platform/util/lossless-json.ts';
import {
  changeOperationFromStr,
  pendingChangesFromEntries,
  type ChangeLogEntry,
  type ChangeLogStats,
  type PendingChanges,
} from '../src/change-log.ts';
import { SyncError } from '../src/errors.ts';

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

function databaseError(detail: string): never {
  throw new SyncError(`Database error: ${detail}`);
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** sync/mod.rs:8147-8160. */
export function tableHasColumn(db: SqlExecutor, tableName: string, columnName: string): boolean {
  try {
    const rows = db.all<{ name: string }>(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    return rows.some(row => row.name === columnName);
  } catch {
    return false;
  }
}

interface RawChangeLogRow {
  id: bigint;
  table_name: string;
  record_id: string;
  operation: string;
  changed_at: string;
  sync_version: bigint;
  field_deltas_json?: string | null;
}

function parseEntry(row: RawChangeLogRow, hasFieldDeltas: boolean): ChangeLogEntry {
  let fieldDeltas: JsonValue | undefined;
  if (hasFieldDeltas && row.field_deltas_json !== null && row.field_deltas_json !== undefined) {
    try {
      fieldDeltas = parseJsonLossless(row.field_deltas_json);
    } catch (error) {
      databaseError(`解析结果失败: ${message(error)}`);
    }
  }
  const entry: ChangeLogEntry = {
    id: exactInteger(row.id),
    table_name: row.table_name,
    record_id: row.record_id,
    operation: changeOperationFromStr(row.operation) ?? 'Update',
    changed_at: row.changed_at,
    sync_version: exactInteger(row.sync_version),
  };
  if (fieldDeltas !== undefined) entry.field_deltas_json = fieldDeltas;
  return entry;
}

/** Keep established small-integer API values without rounding full-width SQLite IDs. */
function exactInteger(value: bigint): number | bigint {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/** commands_sync.rs:1050-1054: unlike the tolerant helper, query errors must surface. */
export function changeLogTableExists(db: SqlExecutor): boolean {
  return Boolean(db.pluck(
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
  ));
}

/** sync/mod.rs:4205-4255. */
export function getPendingChanges(db: SqlExecutor, tableFilter?: string | null, limit?: number | null): PendingChanges {
  const hasFieldDeltas = tableHasColumn(db, '__change_log', 'field_deltas_json');
  let sql = 'SELECT id, table_name, record_id, operation, changed_at, sync_version';
  if (hasFieldDeltas) sql += ', field_deltas_json';
  sql += ' FROM __change_log WHERE sync_version = 0';
  if (tableFilter !== null && tableFilter !== undefined) sql += ' AND table_name = ?1';
  sql += ' ORDER BY changed_at ASC';
  if (limit !== null && limit !== undefined) sql += ` LIMIT ${Math.trunc(limit)}`;

  let rows: RawChangeLogRow[];
  try {
    const query = defineQuery<string[], RawChangeLogRow>(sql, { options: { safeIntegers: true } });
    rows = db.all(query, tableFilter !== null && tableFilter !== undefined ? [tableFilter] : []);
  } catch (error) {
    databaseError(`执行查询失败: ${message(error)}`);
  }
  return pendingChangesFromEntries(rows.map(row => parseEntry(row, hasFieldDeltas)));
}

/** sync/mod.rs:9637-9663. */
export function getChangeLogStats(db: SqlExecutor): ChangeLogStats {
  let total: number;
  try {
    total = db.pluck<number>('SELECT COUNT(*) FROM __change_log') ?? 0;
  } catch (error) {
    databaseError(`查询变更日志总数失败: ${message(error)}`);
  }
  let pending: number;
  try {
    pending = db.pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version = 0') ?? 0;
  } catch (error) {
    databaseError(`查询待同步数量失败: ${message(error)}`);
  }
  let synced: number;
  try {
    synced = db.pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version > 0') ?? 0;
  } catch (error) {
    databaseError(`查询已同步数量失败: ${message(error)}`);
  }
  return { total_count: total, pending_count: pending, synced_count: synced };
}

class UpdateSyncVersionFailure extends Error {
  readonly detail: string;

  constructor(detail: string) { super(detail);
    this.detail = detail; this.name = 'UpdateSyncVersionFailure'; }
}

/** sync/mod.rs:4293-4339. Batches of 500 keep bind parameters below SQLite limits. */
export function markSynced(db: DatabaseHandle, changeIds: readonly (number | bigint)[], syncVersion: number): number {
  if (changeIds.length === 0) return 0;
  const batchSize = 500;
  let entered = false;
  try {
    return db.transaction(tx => {
      entered = true;
      let updated = 0;
      for (let offset = 0; offset < changeIds.length; offset += batchSize) {
        const chunk = changeIds.slice(offset, offset + batchSize);
        const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ');
        try {
          updated += tx.run(
            `UPDATE __change_log SET sync_version = ?1 WHERE id IN (${placeholders})`,
            [syncVersion, ...chunk],
          ).changes;
        } catch (error) {
          throw new UpdateSyncVersionFailure(message(error));
        }
      }
      return updated;
    });
  } catch (error) {
    if (error instanceof UpdateSyncVersionFailure) databaseError(`更新同步版本失败: ${error.detail}`);
    databaseError(`${entered ? '提交标记事务失败' : '开启标记事务失败'}: ${message(error)}`);
  }
}

/** sync/mod.rs:4366-4380. Non-fatal in Rust; returns whether normalization ran. */
function normalizeExistingMillisSyncVersions(db: SqlExecutor): boolean {
  try {
    db.run('UPDATE __change_log SET sync_version = sync_version / 1000 WHERE sync_version > ?1', [100_000_000_000]);
    return true;
  } catch {
    return false;
  }
}

/** sync/mod.rs:4349-4360. */
export function markSyncedWithTimestamp(db: DatabaseHandle, changeIds: readonly (number | bigint)[]): number {
  const syncVersion = Math.floor(Date.now() / 1000);
  normalizeExistingMillisSyncVersions(db);
  return markSynced(db, changeIds, syncVersion);
}

/** commands_sync.rs:1080-1085. */
export function getLastSyncedChangeAt(db: SqlExecutor): string | null {
  return db.pluck<string | null>('SELECT MAX(changed_at) FROM __change_log WHERE sync_version > 0') ?? null;
}

/** sync/mod.rs:4393-4408. */
export function cleanupSyncedChanges(db: SqlExecutor, olderThan: string): number {
  try {
    return db.run(
      'DELETE FROM __change_log WHERE sync_version > 0 AND datetime(changed_at) < datetime(?1)',
      [olderThan],
    ).changes;
  } catch (error) {
    databaseError(`清理变更日志失败: ${message(error)}`);
  }
}

const BUSINESS_TABLES_SQL = String.raw`SELECT name FROM sqlite_master
 WHERE type='table'
   AND name NOT LIKE 'sqlite_%'
   AND name NOT LIKE '\_\_%' ESCAPE '\'`;

function ignoreOptionalTable(db: SqlExecutor, sql: string): boolean {
  try {
    db.run(sql);
    return true;
  } catch {
    return false;
  }
}

/** sync/mod.rs:4432-4520. */
export function resetSyncBaselineAfterRestore(db: SqlExecutor): [number, number] {
  let tableNames: string[];
  try {
    tableNames = db.all<{ name: string }>(BUSINESS_TABLES_SQL).map(row => row.name);
  } catch (error) {
    databaseError(`扫描业务表失败: ${message(error)}`);
  }

  let resetCount = 0;
  for (const table of tableNames) {
    if (![...table].every(char => /[A-Za-z0-9_]/u.test(char))) continue;
    try {
      resetCount += db.run(
        `UPDATE ${quoteIdentifier(table)} SET sync_version = local_version ` +
        'WHERE local_version IS NOT NULL AND (sync_version IS NULL OR sync_version != local_version)',
      ).changes;
    } catch {
      // sync/mod.rs:4494-4499: a table without sync columns is non-fatal.
      continue;
    }
  }

  let truncated: number;
  try {
    truncated = db.run('DELETE FROM __change_log').changes;
  } catch (error) {
    databaseError(`清理变更日志失败: ${message(error)}`);
  }

  ignoreOptionalTable(db, 'DELETE FROM __sync_conflicts');
  ignoreOptionalTable(db, 'DELETE FROM __sync_id_aliases');

  return [truncated, resetCount];
}
