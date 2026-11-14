/**
 * SQLite ↔ JSON 转换与复合主键工具（`mod.rs` 对应函数移植）。
 *
 * 读取一律带 `typeof(col)` 并启用 `safeIntegers`，以保留：
 * - INTEGER 与 REAL 的区别（`1` / JsonFloat(1)）；
 * - 超出 2^53 的 INTEGER（`bigint`）；
 * - BLOB 的 `{"$dsblob": base64}` 标记。
 */
import { defineQuery, type Query, type Row, type SqlExecutor, type SqlParam, type SqlValue } from '../../../platform/storage/api.ts';
import { SyncError } from '../src/errors.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { JsonFloat, parseJsonLossless, stringifyJsonLossless, type DbJson } from '../../../platform/util/lossless-json.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function databaseError(detail: string): never {
  throw new SyncError(`Database error: ${detail}`);
}

/** 使用 safeIntegers 的命名查询（动态 SQL）。 */
export function safeQuery(sql: string, safeIntegers = true): Query<any, any> {
  return defineQuery(sql, { options: { safeIntegers } });
}

export function allSafe(db: SqlExecutor, sql: string, params?: readonly SqlParam[]): Row[] {
  return db.all(safeQuery(sql) as Query<any, any>, params as any);
}

export function getSafe(db: SqlExecutor, sql: string, params?: readonly SqlParam[]): Row | undefined {
  return db.get(safeQuery(sql) as Query<any, any>, params as any);
}

export function pluckSafe<T = SqlValue>(db: SqlExecutor, sql: string, params?: readonly SqlParam[]): T | undefined {
  return db.pluck<T>(safeQuery(sql) as Query<any, any>, params as any);
}

/** `quote_identifier`（mod.rs:5427）。 */
export function quoteIdentifier(identifier: string): string {
  const ident = rustTrim(identifier);
  if (ident.length === 0) throw new SyncError('Database error: SQL 标识符不能为空');
  if (ident.includes('\0')) throw new SyncError('Database error: SQL 标识符包含非法字符');
  return `"${ident.replaceAll('"', '""')}"`;
}

export interface TableColumn {
  name: string;
  declaredType: string;
  notNull: boolean;
  pkOrder: number;
}

/**
 * Transaction-scoped schema metadata reuse.
 *
 * `PRAGMA table_info` / `sqlite_master` are schema reads, not data reads. Inside one
 * `DatabaseHandle.transaction` the schema cannot change through another connection
 * (the writer is held), and this module only issues CREATE TABLE IF NOT EXISTS for
 * its own support tables. Repeating the same pragma for every row of a large apply
 * batch is pure overhead: W.69 issues ~12 schema reads per record. The cache is
 * keyed by the transaction scope object (one per transaction) and is discarded with
 * it, so a later transaction always observes the current schema. Only positive
 * results are cached, so a table created later in the same transaction is still
 * re-read instead of inheriting an earlier "missing" answer.
 */
const transactionTableInfo = new WeakMap<object, Map<string, TableColumn[]>>();
const transactionTableExists = new WeakMap<object, Set<string>>();

/**
 * Only a per-transaction `TransactionScope` may own the cache. F3's long-lived
 * `DatabaseHandle` also reports `inTransaction === true` while any transaction is
 * open on its connection (database.ts:382-384), so keying on it would keep one
 * entry across *different* transactions. `TransactionScope` is the only executor
 * that exposes `savepoint` (api.ts:240-251); a root handle does not.
 */
function cacheableTransactionScope(db: SqlExecutor): boolean {
  return db.inTransaction === true
    && typeof (db as { savepoint?: unknown }).savepoint === 'function';
}

function transactionCache<T>(store: WeakMap<object, Map<string, T>>, db: SqlExecutor): Map<string, T> | null {
  if (!cacheableTransactionScope(db) || typeof db !== 'object' || db === null) return null;
  let cache = store.get(db);
  if (cache === undefined) {
    cache = new Map<string, T>();
    store.set(db, cache);
  }
  return cache;
}

function transactionSetCache(store: WeakMap<object, Set<string>>, db: SqlExecutor): Set<string> | null {
  if (!cacheableTransactionScope(db) || typeof db !== 'object' || db === null) return null;
  let cache = store.get(db);
  if (cache === undefined) {
    cache = new Set<string>();
    store.set(db, cache);
  }
  return cache;
}

/** `PRAGMA table_info`。 */
export function tableInfo(db: SqlExecutor, tableName: string): TableColumn[] {
  const cache = transactionCache(transactionTableInfo, db);
  const cached = cache?.get(tableName);
  if (cached !== undefined) return cached;
  const ident = quoteIdentifier(tableName);
  const rows = allSafe(db, `PRAGMA table_info(${ident})`);
  const columns = rows.map(row => ({
    name: String(row.name),
    declaredType: String(row.type ?? ''),
    notNull: Number(row.notnull ?? 0) !== 0,
    pkOrder: Number(row.pk ?? 0),
  }));
  if (columns.length > 0) cache?.set(tableName, columns);
  return columns;
}

/** `table_column_names`（mod.rs:9576）。 */
export function tableColumnNames(db: SqlExecutor, tableName: string): string[] {
  try {
    return tableInfo(db, tableName).map(column => column.name);
  } catch (error) {
    databaseError(`查询表列失败 ${tableName}: ${message(error)}`);
  }
}

export function tableExists(db: SqlExecutor, tableName: string): boolean {
  const cache = transactionSetCache(transactionTableExists, db);
  if (cache?.has(tableName) === true) return true;
  const value = pluckSafe<number | bigint>(
    db,
    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
    [tableName],
  );
  const exists = Number(value ?? 0) !== 0;
  if (exists) cache?.add(tableName);
  return exists;
}

export function tableHasColumn(db: SqlExecutor, tableName: string, columnName: string): boolean {
  try {
    return tableInfo(db, tableName).some(column => column.name === columnName);
  } catch (_error) {
    return false;
  }
}

export function columnDeclaredType(db: SqlExecutor, tableName: string, columnName: string): string | null {
  try {
    return tableInfo(db, tableName).find(column => column.name === columnName)?.declaredType ?? null;
  } catch (_error) {
    return null;
  }
}

/**
 * `is_local_derived_sync_column`（mod.rs:9183）：本机派生的索引生命周期字段
 * 不参与同步（出站剔除、入站剥离）。
 */
export function isLocalDerivedSyncColumn(tableName: string, column: string): boolean {
  if (tableName === 'note_document_revisions') return column === 'seq' || column === 'edit_bucket';
  if (tableName === 'note_learning_relations') return column === 'revision';
  if (tableName === 'resources') {
    return [
      'index_state', 'index_hash', 'index_error', 'indexed_at', 'index_retry_count',
      'index_next_retry_at', 'index_generation', 'mm_index_state', 'mm_index_error',
      'mm_index_retry_count', 'mm_index_next_retry_at', 'mm_embedding_dim', 'mm_indexing_mode',
      'mm_indexed_at', 'mm_index_generation',
    ].includes(column);
  }
  if (tableName === 'files' || tableName === 'exam_sheets') {
    return [
      'mm_index_state', 'mm_index_error', 'mm_indexed_pages_json', 'mm_embedding_dim',
      'mm_indexing_mode', 'mm_indexed_at',
    ].includes(column);
  }
  if (tableName === 'chat_v2_session_groups') return column === 'preferred_project_root_path';
  return false;
}

/** `ensure_table_allowed_and_exists`（mod.rs:5443）。 */
export function ensureTableAllowedAndExists(db: SqlExecutor, tableName: string): void {
  const table = rustTrim(tableName);
  if (table.startsWith('sqlite_')) throw new SyncError(`Database error: 禁止同步到系统表: ${tableName}`);
  if (table.startsWith('__')) throw new SyncError(`Database error: 禁止同步到内部元数据表: ${tableName}`);
  if (!tableExists(db, table)) throw new SyncError(`Database error: 目标表不存在: ${tableName}`);
}

/** `get_table_columns`（mod.rs:9233）：剔除本机派生列。 */
export function getTableColumns(db: SqlExecutor, tableName: string): string[] {
  ensureTableAllowedAndExists(db, tableName);
  return tableInfo(db, tableName)
    .map(column => column.name)
    .filter(column => !isLocalDerivedSyncColumn(tableName, column));
}

/** `primary_key_columns`（mod.rs:5734）。 */
export function primaryKeyColumns(db: SqlExecutor, tableName: string): string[] {
  ensureTableAllowedAndExists(db, tableName);
  if (tableName === 'note_document_revisions') return ['version_id'];
  return tableInfo(db, tableName)
    .filter(column => column.pkOrder > 0)
    .sort((left, right) => left.pkOrder - right.pkOrder)
    .map(column => column.name);
}

function base64Encode(bytes: Uint8Array): string {
  return toBase64(bytes);
}

const BASE64_VALUES = (() => {
  const table = new Int8Array(128).fill(-1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let index = 0; index < alphabet.length; index += 1) table[alphabet.charCodeAt(index)] = index;
  table[0x2d] = 62;
  table[0x5f] = 63;
  return table;
})();

/** `Buffer.from(text, 'base64')`：跳过非字母表字符，遇 `=` 结束，标准与 URL 安全字母表都接受。 */
function decodeBase64Lenient(text: string): Uint8Array {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x3d) break;
    const value = code < 128 ? BASE64_VALUES[code]! : -1;
    if (value < 0) continue;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** `sqlite_value_to_json`（mod.rs:9378）。 */
export function sqliteValueToJson(storageType: string, value: SqlValue | undefined): DbJson {
  switch (storageType) {
    case 'integer': {
      if (value === null || value === undefined) return null;
      if (typeof value === 'bigint') {
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value;
      }
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError('SQLite INTEGER must be read with safeIntegers before lossless JSON conversion');
      }
      return value;
    }
    case 'real':
      return Number.isFinite(Number(value)) ? new JsonFloat(Number(value)) : null;
    case 'text':
      return String(value);
    case 'blob':
      if (value instanceof Uint8Array) return { $dsblob: base64Encode(value) };
      if (typeof value === 'string') return { $dsblob: value };
      return { $dsblob: '' };
    default:
      return null;
  }
}

/** 构造带 `typeof()` 的 SELECT 列清单。 */
export function selectWithTypes(columns: readonly string[]): string {
  const values = columns.map(column => quoteIdentifier(column));
  const types = columns.map((_, index) => `typeof(${quoteIdentifier(columns[index] as string)}) AS "__t${index}"`);
  return [...values, ...types].join(', ');
}

/** 把 `selectWithTypes` 结果的一行转成 `{column: DbJson}`（保持列顺序）。 */
export function rowToJson(row: Row, columns: readonly string[]): { [key: string]: DbJson } {
  const out: { [key: string]: DbJson } = {};
  columns.forEach((column, index) => {
    const storageType = String(row[`__t${index}`] ?? 'null');
    out[column] = sqliteValueToJson(storageType, row[column] as SqlValue | undefined);
  });
  return out;
}

/** `json_value_to_sql_param`（mod.rs:5770）。 */
export function jsonValueToSqlParam(value: DbJson): SqlParam | undefined {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') {
    if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) return undefined;
    return value;
  }
  if (typeof value === 'number') return value;
  if (value instanceof JsonFloat) return value.value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return stringifyJsonLossless(value);
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && typeof value.$dsblob === 'string') {
      try {
        return decodeBase64Lenient(value.$dsblob);
      } catch (_error) {
        return undefined;
      }
    }
    return stringifyJsonLossless(value);
  }
  return undefined;
}

/** `json_value_to_alias_key`（mod.rs:5761）。 */
export function jsonValueToAliasKey(value: DbJson): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : stringifyJsonLossless(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return String(value);
  if (value instanceof JsonFloat) return stringifyJsonLossless(value);
  return null;
}

function rustValueToString(value: DbJson): string {
  return jsonValueToAliasKey(value) ?? stringifyJsonLossless(value);
}

/** `parse_llm_usage_daily_record_id`（mod.rs:9270）。 */
export function parseLlmUsageDailyRecordId(recordId: string): [string, string, string, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordId);
  } catch (_error) {
    parsed = null;
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    const date = typeof obj.date === 'string' ? obj.date : '';
    const callerType = typeof obj.caller_type === 'string' ? obj.caller_type : '';
    const model = typeof obj.model === 'string' ? obj.model : '';
    const provider = typeof obj.provider === 'string' ? obj.provider : '';
    if (date && callerType && model && provider) return [date, callerType, model, provider];
  }
  const parts = recordId.split('_');
  if (parts.length >= 4) {
    const [date, callerType, model] = parts;
    const provider = parts.slice(3).join('_');
    return [date as string, callerType as string, model as string, provider];
  }
  throw new SyncError(`Database error: llm_usage_daily 记录ID格式无效: ${recordId}`);
}

/** `parse_record_key_values`（mod.rs:9304）。 */
export function parseRecordKeyValues(tableName: string, recordId: string, pkColumns: readonly string[]): string[] {
  if (pkColumns.length === 0) throw new SyncError(`Database error: 表 ${tableName} 没有可用主键列`);
  if (pkColumns.length === 1) return [recordId];
  if (tableName === 'llm_usage_daily') {
    try {
      return parseLlmUsageDailyRecordId(recordId);
    } catch (_error) { // boundary-allow empty-catch: Rust 对 llm_usage_daily 专用解析失败返回 None 后继续通用解析，无日志。
    }
  }

  let parsed: unknown;
  try {
    parsed = parseJsonLossless(recordId);
  } catch (_error) {
    parsed = undefined;
  }
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, DbJson>;
    const values: string[] = [];
    for (const column of pkColumns) {
      if (!Object.hasOwn(obj, column)) {
        throw new SyncError(`Database error: 复合主键 record_id 缺少字段: ${tableName}.${column} -> ${recordId}`);
      }
      const raw = obj[column] as DbJson;
      values.push(jsonValueToAliasKey(raw) ?? rustValueToString(raw));
    }
    return values;
  }
  if (Array.isArray(parsed) && parsed.length === pkColumns.length) {
    return (parsed as DbJson[]).map(raw => jsonValueToAliasKey(raw) ?? rustValueToString(raw));
  }

  const parts = recordId.split(':');
  if (parts.length === pkColumns.length) return parts;
  throw new SyncError(
    `Database error: 复合主键 record_id 无法解析: ${tableName}.${pkColumns.join(',')} = ${recordId}`,
  );
}

/** `build_primary_key_predicate_from`（mod.rs:9354）。 */
export function buildPrimaryKeyPredicate(pkColumns: readonly string[], firstIndex = 1): string {
  return pkColumns
    .map((column, index) => `${quoteIdentifier(column)} = ?${firstIndex + index}`)
    .join(' AND ');
}

/** `normalize_version_to_seconds`（mod.rs:3223）。 */
export function normalizeVersionToSeconds(version: bigint): bigint {
  const MILLIS_THRESHOLD = 100_000_000_000n;
  return version > MILLIS_THRESHOLD ? version / 1000n : version;
}
