/** `PRAGMA table_info` 查询（`mod.rs:8147-8166`、`9222-9240`、`5734-5759`）。 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { defineQuery } from '../../../platform/storage/query.ts';
import { rustTrim } from '../../../platform/util/portable.ts';

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** `quote_identifier`：双引号引用并转义内部引号；空/含 NUL 抛错（调用方转 Database 错误）。 */
export function quoteIdentifier(identifier: string): string {
  const ident = rustTrim(identifier);
  if (ident === '') throw new Error('SQL 标识符不能为空');
  if (ident.includes('\u0000')) throw new Error('SQL 标识符包含非法字符');
  return `"${ident.replaceAll('"', '""')}"`;
}

/** 表形状查询（每次调用都读 PRAGMA，与 Rust 一致；表名来自同步批次，不是热路径）。 */
export function tableInfo(db: SqlExecutor, tableName: string): TableInfoRow[] {
  const rows = db.all<TableInfoRow>(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
  return rows;
}

/** `table_has_column`：PRAGMA 失败或列不存在返回 false。 */
export function tableHasColumn(db: SqlExecutor, tableName: string, columnName: string): boolean {
  let ident: string;
  try {
    ident = quoteIdentifier(tableName);
  } catch {
    return false;
  }
  try {
    return db.all<TableInfoRow>(`PRAGMA table_info(${ident})`).some(row => row.name === columnName);
  } catch {
    return false;
  }
}

/** `get_table_columns`。 */
export function tableColumns(db: SqlExecutor, tableName: string): string[] {
  return tableInfo(db, tableName).map(row => row.name);
}

/**
 * `primary_key_columns`：`note_document_revisions` 的主键是 `version_id`
 * （`seq` 是设备本地时间线游标，永不作为传输身份）。
 */
export function primaryKeyColumns(db: SqlExecutor, tableName: string): string[] {
  if (tableName === 'note_document_revisions') return ['version_id'];
  return tableInfo(db, tableName)
    .filter(row => Number(row.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map(row => row.name);
}

/** 判断表是否存在（`ensure_table_allowed_and_exists` 的存在性部分）。 */
export function tableExists(db: SqlExecutor, tableName: string): boolean {
  const row = db.get<{ name: string }>(
    'SELECT name FROM sqlite_master WHERE type=?1 AND name=?2',
    ['table', tableName],
  );
  return row !== undefined;
}

/** `pragma_table_info('<table>')` 的行数（`ensure_conflict_table` 的列探测）。 */
export const tableInfoCount = defineQuery<[string], { count: number }>(
  "SELECT COUNT(*) AS count FROM pragma_table_info('__sync_conflicts') WHERE name = ?1",
  { name: 'syncSupport.conflicts.columnExists' },
);
