/**
 * `SyncManager::get_record_data`（`mod.rs:9095-9410`）的等价读取。
 *
 * 与 Rust 相同的语义点：
 * - 主键列来自 `PRAGMA table_info`（`note_document_revisions` 固定为 `version_id`）；
 * - 复合主键的 record_id 解析（JSON 对象 / JSON 数组 / `:` 分隔）；
 * - `is_local_derived_sync_column` 的本地派生列不进入 payload
 *   （`seq` / `edit_bucket` / 关系 `revision` / 索引状态列）；
 * - BLOB 用 `{"$dsblob": base64}` 标记；
 * - SQLite 值按 `typeof()` 区分 INTEGER / REAL / TEXT / BLOB / NULL，
 *   因此 REAL `1.0` 与 INTEGER `1` 不会互相混淆（serde_json 语义）。
 *
 * `ensure_table_allowed_and_exists` 的 RowSync 白名单属 L20 的 apply 入口
 * （本模块由 apply 在已校验的表上调用），这里只保留系统表/内部表/存在性检查。
 */
import type { SqlExecutor, SqlParam } from '../../../platform/storage/api.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import { databaseError } from '../src/errors.ts';
import { fromBase64, toBase64 } from '../../../platform/crypto/encoding.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { Json } from '../src/json.ts';
import { JsonFloat } from '../src/json.ts';
import { primaryKeyColumns, quoteIdentifier, tableColumns, tableExists } from './pragma.ts';

export const LOCAL_DERIVED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  note_document_revisions: ['seq', 'edit_bucket'],
  note_learning_relations: ['revision'],
  resources: [
    'index_state',
    'index_hash',
    'index_error',
    'indexed_at',
    'index_retry_count',
    'index_next_retry_at',
    'index_generation',
    'mm_index_state',
    'mm_index_error',
    'mm_index_retry_count',
    'mm_index_next_retry_at',
    'mm_embedding_dim',
    'mm_indexing_mode',
    'mm_indexed_at',
    'mm_index_generation',
  ],
  files: [
    'mm_index_state',
    'mm_index_error',
    'mm_indexed_pages_json',
    'mm_embedding_dim',
    'mm_indexing_mode',
    'mm_indexed_at',
  ],
  exam_sheets: [
    'mm_index_state',
    'mm_index_error',
    'mm_indexed_pages_json',
    'mm_embedding_dim',
    'mm_indexing_mode',
    'mm_indexed_at',
  ],
  chat_v2_session_groups: ['preferred_project_root_path'],
};

export function isLocalDerivedSyncColumn(tableName: string, column: string): boolean {
  return (LOCAL_DERIVED_COLUMNS[tableName] ?? []).includes(column);
}

function ensureAllowedAndExists(db: SqlExecutor, tableName: string): void {
  const trimmed = rustTrim(tableName);
  if (trimmed.startsWith('sqlite_')) databaseError(`禁止同步到系统表: ${tableName}`);
  if (trimmed.startsWith('__')) databaseError(`禁止同步到内部表: ${tableName}`);
  let exists: boolean;
  try {
    exists = tableExists(db, trimmed);
  } catch (error) {
    databaseError(`检查表是否存在失败: ${errorMessage(error)}`);
  }
  if (!exists) databaseError(`目标表不存在: ${tableName}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `json_value_to_alias_key`：字符串/数字/布尔转成主键文本。 */
function aliasKey(value: Json): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof JsonFloat) return value.value.toString();
  return JSON.stringify(value) ?? '';
}

/** `parse_record_key_values`。 */
export function parseRecordKeyValues(tableName: string, recordId: string, pkColumns: readonly string[]): string[] {
  if (pkColumns.length === 0) databaseError(`表 ${tableName} 没有可用主键列`);
  if (pkColumns.length === 1) return [recordId];

  if (tableName === 'llm_usage_daily') {
    const parsed = parseLlmUsageDailyRecordId(recordId);
    if (parsed !== null) return parsed;
  }

  let value: unknown;
  try {
    value = JSON.parse(recordId);
  } catch {
    value = undefined;
  }
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      if (value.length === pkColumns.length) return value.map(item => aliasKey(item as Json));
    } else {
      const obj = value as Record<string, Json>;
      const values: string[] = [];
      let missing = false;
      for (const column of pkColumns) {
        if (!Object.hasOwn(obj, column)) {
          missing = true;
          break;
        }
        values.push(aliasKey(obj[column] as Json));
      }
      if (!missing) return values;
      databaseError(`复合主键 record_id 缺少字段: ${tableName}.${pkColumns.join(',')} -> ${recordId}`);
    }
  }

  const parts = recordId.split(':');
  if (parts.length === pkColumns.length) return parts;

  return databaseError(`复合主键 record_id 无法解析: ${tableName}.${pkColumns.join(',')} = ${recordId}`);
}

function parseLlmUsageDailyRecordId(recordId: string): string[] | null {
  try {
    const value: unknown = JSON.parse(recordId);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const fields = ['date', 'caller_type', 'model', 'provider'].map(key => obj[key]);
      if (fields.every(item => typeof item === 'string' && item !== '')) return fields as string[];
    }
  } catch { // boundary-allow empty-catch: sync/mod.rs parse_llm_usage_daily_record_id 的 if let Ok JSON 失败后尝试下划线旧格式，无日志。
  }
  const parts = recordId.split('_');
  if (parts.length >= 4) return [parts[0]!, parts[1]!, parts[2]!, parts.slice(3).join('_')];
  return null;
}

const BLOB_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

/** `{"$dsblob": base64}` → 参数。 */
export function blobMarkerParam(value: Json): SqlParam | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof JsonFloat) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== '$dsblob') return null;
  const encoded = value.$dsblob;
  if (typeof encoded !== 'string' || !BLOB_BASE64.test(encoded)) return null;
  return fromBase64(encoded);
}

function valueOf(row: Record<string, unknown>, column: string): Json {
  const kind = row[`__type_${column}`];
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  if (kind === 'real') return new JsonFloat(Number(raw));
  if (kind === 'blob') {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    return { $dsblob: toBase64(bytes) };
  }
  if (typeof raw === 'bigint') {
    return raw >= BigInt(Number.MIN_SAFE_INTEGER) && raw <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(raw)
      : raw;
  }
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'boolean') return raw;
  return String(raw);
}

function selectRow(db: SqlExecutor, sql: string, params: readonly SqlParam[], columns: readonly string[]): Json | null {
  let row: Record<string, unknown> | undefined;
  try {
    row = db.get(defineQuery<readonly SqlParam[], Record<string, unknown>>(
      sql, { options: { safeIntegers: true } },
    ), params);
  } catch (error) {
    databaseError(`查询记录失败: ${errorMessage(error)}`);
  }
  if (row === undefined) return null;
  const out: { [key: string]: Json } = {};
  for (const column of columns) out[column] = valueOf(row, column);
  return out;
}

function selectColumnsSql(columns: readonly string[]): string {
  return columns
    .map(column => `typeof(${quoteIdentifier(column)}) AS ${quoteIdentifier(`__type_${column}`)}, ${quoteIdentifier(column)}`)
    .join(', ');
}

/**
 * `get_record_data`。`_idColumn` 保持签名一致；Rust 同样使用主键列而非该参数。
 */
export function getRecordData(
  db: SqlExecutor,
  tableName: string,
  recordId: string,
  _idColumn: string,
): Json | null {
  ensureAllowedAndExists(db, tableName);
  let columns: string[];
  try {
    columns = tableColumns(db, tableName).filter(column => !isLocalDerivedSyncColumn(tableName, column));
  } catch (error) {
    databaseError(`获取表结构失败: ${errorMessage(error)}`);
  }
  if (columns.length === 0) return null;

  let pkColumns: string[];
  try {
    pkColumns = primaryKeyColumns(db, tableName);
  } catch (error) {
    databaseError(`查询主键列失败: ${errorMessage(error)}`);
  }
  const values = parseRecordKeyValues(tableName, recordId, pkColumns);
  const predicate = pkColumns
    .map((column, index) => `${quoteIdentifier(column)} = ?${index + 1}`)
    .join(' AND ');
  const tableIdent = quoteIdentifier(tableName);
  const result = selectRow(
    db,
    `SELECT ${selectColumnsSql(columns)} FROM ${tableIdent} WHERE ${predicate}`,
    values,
    columns,
  );
  if (result !== null) return result;

  if (tableName === 'questions') {
    let rows: Record<string, unknown>[];
    try {
      rows = db.all(
        defineQuery<[string], Record<string, unknown>>(
          `SELECT ${selectColumnsSql(columns)} FROM ${tableIdent} WHERE exam_id = ?1`,
          { options: { safeIntegers: true } },
        ),
        [recordId],
      );
    } catch (error) {
      databaseError(`查询 questions 兼容记录失败: ${errorMessage(error)}`);
    }
    if (rows.length === 1) {
      const row = rows[0]!;
      const out: { [key: string]: Json } = {};
      for (const column of columns) out[column] = valueOf(row, column);
      return out;
    }
  }
  return null;
}
