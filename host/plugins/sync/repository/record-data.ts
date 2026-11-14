/**
 * 记录快照、变更补全与数据库同步状态（`sync/mod.rs` 相关函数移植）。
 */
import { rustTrim } from '../../../platform/util/index.ts';
import { readUnknownFields, rehydrateUnknownFieldsIfColumnsExist } from './unknown-fields.ts';
import type { SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import type { ChangeLogEntry } from '../src/change-log.ts';
import type { EngineChange as SyncChangeWithData } from '../api.ts';
import { checksumTables, type TableClassification } from '../src/classification.ts';
import { SyncError } from '../src/errors.ts';
import {
  cloneDbJson,
  dbJsonEquals,
  isJsonFloat,
  parseJsonLossless,
  stringifyJsonLossless,
  type DbJson,
} from '../../../platform/util/lossless-json.ts';
import {
  allSafe,
  buildPrimaryKeyPredicate,
  getSafe,
  getTableColumns,
  isLocalDerivedSyncColumn,
  normalizeVersionToSeconds,
  parseRecordKeyValues,
  pluckSafe,
  primaryKeyColumns,
  quoteIdentifier,
  rowToJson,
  selectWithTypes,
  tableColumnNames,
  tableExists,
  tableHasColumn,
} from './sqlite-values.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import { toHex } from '../../../platform/crypto/encoding.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function databaseError(detail: string): never {
  throw new SyncError(`Database error: ${detail}`);
}

/** `SYNC_FIELD_DELTAS_KEY`（mod.rs:9978）。 */
export const SYNC_FIELD_DELTAS_KEY = '__sync_field_deltas';

/** 同步比较时忽略的元字段（mod.rs:9039）。 */
const STRIP_KEYS = new Set([
  'sync_version',
  'local_version',
  'updated_at',
  'last_synced_at',
  'last_attempt_at',
  'indexed_at',
  'mm_indexed_at',
  'remote_version',
  'remote_id',
  'sync_status',
  'content_hash',
]);

/** `canonicalize_sync_value_for_compare`（mod.rs:9045）。 */
export function canonicalizeSyncValueForCompare(value: DbJson): DbJson {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      const trimmed = value.trimStart();
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          return canonicalizeSyncValueForCompare(parseJsonValue(trimmed));
        } catch {
          return value;
        }
      }
    }
    return value;
  }
  if (isJsonFloat(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonicalizeSyncValueForCompare(item));
  const sorted = Object.entries(value)
    .filter(([key]) => !STRIP_KEYS.has(key))
    .map(([key, item]) => [key, canonicalizeSyncValueForCompare(item)] as const)
    .sort((left, right) => compareUtf8(left[0], right[0]));
  const out: { [key: string]: DbJson } = {};
  for (const [key, item] of sorted) out[key] = item;
  return out;
}

function parseJsonValue(text: string): DbJson {
  // 延迟引入避免 record-data 与 json 模块循环依赖（当前无循环，保持显式）。
  return parseJsonLossless(text);
}

/**
 * `records_semantically_equal_for_sync`（mod.rs:9012）：以云端字段集为基准，
 * 忽略同步元字段与 JSON 字符串/数组的结构差异。
 */
export function recordsSemanticallyEqualForSync(local: DbJson, cloud: DbJson): boolean {
  let localSubset: DbJson = local;
  if (cloud !== null && typeof cloud === 'object' && !Array.isArray(cloud) && !isJsonFloat(cloud)) {
    const cloudKeys = new Set(Object.keys(cloud));
    if (local !== null && typeof local === 'object' && !Array.isArray(local) && !isJsonFloat(local)) {
      const filtered: { [key: string]: DbJson } = {};
      for (const [key, item] of Object.entries(local)) {
        if (cloudKeys.has(key)) filtered[key] = item;
      }
      localSubset = filtered;
    }
  }
  return dbJsonEquals(canonicalizeSyncValueForCompare(localSubset), canonicalizeSyncValueForCompare(cloud));
}

/** `differs_semantically`（conflict_resolver.rs:267）。 */
export function differsSemantically(local: DbJson, cloud: DbJson): boolean {
  return !recordsSemanticallyEqualForSync(local, cloud);
}

/** `get_record_data_with_columns`（mod.rs:9109）。 */
export function getRecordDataWithColumns(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  columns: readonly string[],
): DbJson | null {
  const tableIdent = quoteIdentifier(tableName);
  const pkColumns = primaryKeyColumns(db, tableName);
  const values = parseRecordKeyValues(tableName, recordId, pkColumns);
  const predicate = buildPrimaryKeyPredicate(pkColumns);
  const sql = `SELECT ${selectWithTypes(columns)} FROM ${tableIdent} WHERE ${predicate}`;
  let row;
  try {
    row = getSafe(db, sql, values as SqlParam[]);
  } catch (error) {
    databaseError(`查询记录失败: ${message(error)}`);
  }
  let result: DbJson | null = row === undefined ? null : rowToJson(row, columns);

  if (result === null && tableName === 'questions') {
    const fallbackSql = `SELECT ${selectWithTypes(columns)} FROM ${tableIdent} WHERE exam_id = ?1`;
    let rows;
    try {
      rows = allSafe(db, fallbackSql, [recordId]);
    } catch (error) {
      databaseError(`查询 questions 兼容记录失败: ${message(error)}`);
    }
    if (rows.length === 1) result = rowToJson(rows[0]!, columns);
  }
  if (result !== null && typeof result === 'object' && !Array.isArray(result) && !isJsonFloat(result)) {
    result = { ...readUnknownFields(db, tableName, recordId), ...result };
  }
  return result;
}

/** `get_record_data`（mod.rs:9095）。 */
export function getRecordData(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  _idColumn: string,
): DbJson | null {
  const columns = getTableColumns(db, tableName);
  if (columns.length === 0) return null;
  return getRecordDataWithColumns(db, tableName, recordId, columns);
}

/** `note_history::include_note_dependencies`（note_history.rs:16）。 */
export function includeNoteDependencies(db: SqlExecutor, changes: SyncChangeWithData[]): void {
  if (!tableHasColumn(db, 'note_document_revisions', 'version_id')) return;
  const seen = new Set<string>();
  const keyOf = (table: string, id: string): string => `${table}\u001f${id}`;
  for (const change of changes) seen.add(keyOf(change.table_name, change.record_id));

  const notes = changes.filter(
    change => change.table_name === 'notes' && change.operation !== 'Delete' && change.data !== null && change.data !== undefined,
  );
  for (const note of notes) {
    for (const [table, key] of [
      ['note_document_formats', 'note_id'],
      ['note_document_revisions', 'version_id'],
      ['note_learning_relations', 'id'],
    ] as const) {
      if (!tableHasColumn(db, table, key)) continue;
      const order = table === 'note_document_revisions' ? 'seq' : 'note_id';
      const sql = `SELECT ${quoteIdentifier(key)} FROM ${quoteIdentifier(table)} WHERE note_id=?1 ORDER BY ${order}`;
      let rows;
      try {
        rows = allSafe(db, sql, [note.record_id]);
      } catch (error) {
        databaseError(message(error));
      }
      for (const row of rows) {
        const id = String(row[key]);
        if (!seen.add(keyOf(table, id))) continue;
        const data = getRecordData(db, table, id, key);
        changes.push({
          ...note,
          table_name: table,
          record_id: id,
          operation: 'Insert',
          data: data === null ? null : (data as SyncChangeWithData['data']),
        });
      }
    }
  }
}

/** `enrich_changes_with_data`（mod.rs:9412）。 */
export function enrichChangesWithData(
  db: SqlExecutor,
  entries: readonly ChangeLogEntry[],
  idColumnMap?: ReadonlyMap<string, string> | null,
): SyncChangeWithData[] {
  const result: SyncChangeWithData[] = [];
  const columnsCache = new Map<string, string[]>();
  for (const entry of entries) {
    const idColumn = idColumnMap?.get(entry.table_name) ?? 'id';
    let data: DbJson | null;
    if (entry.operation === 'Delete') {
      data = null;
    } else {
      let columns = columnsCache.get(entry.table_name);
      if (columns === undefined) {
        rehydrateUnknownFieldsIfColumnsExist(db, entry.table_name);
        columns = getTableColumns(db, entry.table_name);
        columnsCache.set(entry.table_name, columns);
      }
      data = columns.length === 0 ? null : getRecordDataWithColumns(db, entry.table_name, entry.record_id, columns);
    }

    if (data !== null && data !== undefined && typeof data === 'object' && !Array.isArray(data) && !isJsonFloat(data)) {
      if (entry.field_deltas_json !== undefined && entry.field_deltas_json !== null) {
        const previous = (data as { [key: string]: DbJson })[SYNC_FIELD_DELTAS_KEY];
        const incoming = cloneDbJson(entry.field_deltas_json as DbJson);
        (data as { [key: string]: DbJson })[SYNC_FIELD_DELTAS_KEY] = previous && typeof previous === 'object' && !Array.isArray(previous) && !isJsonFloat(previous)
          && incoming && typeof incoming === 'object' && !Array.isArray(incoming) && !isJsonFloat(incoming) ? { ...previous, ...incoming } : incoming;
      }
    }

    result.push({
      table_name: entry.table_name,
      record_id: entry.record_id,
      operation: entry.operation,
      data: data as SyncChangeWithData['data'],
      changed_at: entry.changed_at,
      change_log_id: entry.id,
      database_name: null,
      suppress_change_log: null,
      source_device_id: null,
      source_seq: null,
    });
  }
  includeNoteDependencies(db, result);
  return result;
}

/** `get_database_sync_state`（mod.rs:9469）。 */
export interface DatabaseSyncStateSnapshot {
  schema_version: number;
  data_version: bigint;
  checksum: string;
  last_updated_at: string | null;
}

export function getDatabaseSyncState(db: SqlExecutor, databaseName: string): DatabaseSyncStateSnapshot {
  const schemaVersion = Number(
    pluckSafe<number | bigint>(db, 'SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history') ?? 0,
  );

  let rawDataVersion = 0n;
  try {
    const value = pluckSafe<number | bigint>(db, 'SELECT COALESCE(MAX(sync_version), 0) FROM __change_log');
    rawDataVersion = BigInt(value ?? 0);
    if (rawDataVersion < 0n) rawDataVersion = 0n;
  } catch {
    rawDataVersion = 0n;
  }
  const dataVersion = normalizeVersionToSeconds(rawDataVersion);

  let lastUpdatedAt: string | null = null;
  try {
    lastUpdatedAt = db.pluck<string | null>('SELECT MAX(changed_at) FROM __change_log') ?? null;
  } catch {
    lastUpdatedAt = null;
  }

  return {
    schema_version: schemaVersion,
    data_version: dataVersion,
    checksum: calculateDriftChecksumV2(db, databaseName),
    last_updated_at: lastUpdatedAt,
  };
}

/** `checksum_order_columns`（mod.rs:9603）。 */
function checksumOrderColumns(primaryKey: string, columns: readonly string[]): string[] {
  return primaryKey
    .split(',')
    .map(rustTrim)
    .filter(part => part.length > 0 && !part.startsWith('('))
    .filter(column => columns.includes(column));
}

/** `calculate_drift_checksum_v2`（mod.rs:9518）。 */
export function calculateDriftChecksumV2(db: SqlExecutor, databaseName: string): string {
  const hasher = createHasherSync('SHA-256');
  hasher.update(databaseName);
  hasher.update('\n');

  const tables: TableClassification[] = [...checksumTables(databaseName)].sort((left, right) =>
    compareUtf8(left.table_name, right.table_name),
  );

  for (const table of tables) {
    if (table.table_name === 'note_document_revisions') continue;
    let columns: string[];
    try {
      columns = tableColumnNames(db, table.table_name).filter(
        column => !(table.table_name === 'note_learning_relations' && column === 'revision'),
      );
    } catch (error) {
      databaseError(message(error));
    }
    if (columns.length === 0) continue;

    const tableIdent = quoteIdentifier(table.table_name);
    const orderColumns = checksumOrderColumns(table.primary_key, columns);
    // rusqlite reads expressions by position; F3 returns named row objects.
    // Alias each expression so the loop below reads its quoted value, not undefined.
    const selectExprs = columns.map(column => `quote(${quoteIdentifier(column)}) AS ${quoteIdentifier(column)}`);
    const orderExpr = orderColumns.length === 0 ? 'rowid' : orderColumns.map(quoteIdentifier).join(', ');
    const sql = `SELECT ${selectExprs.join(', ')} FROM ${tableIdent} ORDER BY ${orderExpr}`;

    hasher.update(`table:${table.table_name}\ncolumns:${columns.join(',')}\n`);

    let rows;
    try {
      rows = db.all(sql);
    } catch (error) {
      databaseError(`执行 checksum 查询失败 ${table.table_name}: ${message(error)}`);
    }
    for (const row of rows) {
      hasher.update('row');
      for (let index = 0; index < columns.length; index += 1) {
        const value = row[columns[index] as string];
        hasher.update('\x1f');
        hasher.update(value === null || value === undefined ? 'NULL' : String(value));
      }
      hasher.update('\n');
    }
  }
  return toHex(hasher.digest().subarray(0, 16));
}

/** 表是否拥有指定列（供 apply/checksum 复用）。 */
export function hasColumn(db: SqlExecutor, tableName: string, columnName: string): boolean {
  return tableHasColumn(db, tableName, columnName);
}

/** `timestamp_value_to_lww_string` 的云端字段版本（数字 → 十进制字符串）。 */
export function timestampValueString(value: DbJson | undefined): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (isJsonFloat(value)) return String(value.value);
  return null;
}

/** 排序辅助：与 Rust `String` 一致的 UTF-8 顺序。 */
export function compareStringsUtf8(left: string, right: string): number {
  return compareUtf8(left, right);
}

export interface DownloadChangeLike {
  table_name: string;
  record_id: string;
  operation: string;
  data: unknown;
  database_name?: string | null;
}

/** `download_change_dedupe_key`（mod.rs:3198）：内容指纹，忽略 changed_at/change_log_id/source。 */
export function downloadChangeDedupeKey(change: DownloadChangeLike): string {
  const data = change.data === null || change.data === undefined
    ? null
    : canonicalizeSyncValueForCompare(change.data as DbJson);
  const raw: DbJson = {
    database: change.database_name ?? null,
    table: change.table_name,
    record: change.record_id,
    operation: change.operation.toUpperCase(),
    data,
  };
  return createHasherSync('SHA-256')
    .update(stringifyJsonLossless(raw))
    .digestHex()
    .slice(0, 32);
}

/** `dedupe_downloaded_changes`（mod.rs:3155）：keep-last，保持输入顺序。 */
export function dedupeDownloadedChanges<T extends DownloadChangeLike>(changes: readonly T[]): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index] as T;
    const key = downloadChangeDedupeKey(change);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(change);
  }
  return kept.reverse();
}
