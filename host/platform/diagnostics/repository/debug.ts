import { defineQuery, type SqlExecutor, type SqlValue } from '../../storage/api.ts';
import { AppError, CommandError } from '../../errors/api.ts';
import type { DebugDatabaseStats, DebugTextbookPageInfo, VfsMigrationDiagnostic } from '../../../../contracts/ipc/generated/F4-security.ts';
import { parseDebugChatHistory, type DebugMessagePresence } from './chat-history.ts';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function query<R>(db: SqlExecutor, sql: string): R[] {
  try { db.all(`EXPLAIN ${sql}`); } catch (error) { throw new CommandError(AppError.database(`准备查询失败: ${message(error)}`)); }
  try { return db.all(defineQuery<void, R>(sql, { options: { safeIntegers: true } })); }
  catch (error) { throw new CommandError(AppError.database(`查询失败: ${message(error)}`)); }
}
function count(db: SqlExecutor, sql: string): number {
  try { const value = db.pluck<number>(sql); return Number.isInteger(value) ? value! : 0; } catch { return 0; }
}

// These diagnostics perform Rust row.get<T> conversions. With safeIntegers,
// INTEGER is bigint and REAL is number even for 1.0; don't conflate the two.
function columnType(value: SqlValue, index: number, name: string): Error {
  const type = value === null ? 'Null' : typeof value === 'string' ? 'Text'
    : typeof value === 'bigint' ? 'Integer' : typeof value === 'number' ? 'Real' : 'Blob';
  return new Error(`Invalid column type ${type} at index: ${index}, name: ${name}`);
}
function sqlString(value: SqlValue, index: number, name: string): string {
  if (typeof value !== 'string') throw columnType(value, index, name);
  return value;
}
function optionalString(value: SqlValue, index: number, name: string): string | null {
  return value === null ? null : sqlString(value, index, name);
}
function sqlInteger(value: SqlValue, index: number, name: string, min: bigint, max: bigint): number {
  if (typeof value !== 'bigint') throw columnType(value, index, name);
  if (value < min || value > max) throw new Error(`Integer ${value} out of range at index ${index}`);
  return Number(value); // All callers are i32/u32, after exact range validation.
}

type TextbookRow = Record<'id' | 'resource_id' | 'file_name' | 'page_count' | 'ocr_pages_json' | 'extracted_text', SqlValue>;
type HistoryRow = Record<'version' | 'name' | 'applied_on' | 'success', SqlValue>;
export function databaseStats(db: SqlExecutor): DebugDatabaseStats {
  const stats: DebugDatabaseStats = {
    total_mistakes: count(db, 'SELECT COUNT(*) FROM mistakes'), // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
    mistakes_with_chat: count(db, 'SELECT COUNT(*) FROM mistakes WHERE json_array_length(chat_history) > 0'), // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
    total_messages: 0, messages_with_images: 0, messages_with_thinking: 0, messages_with_rag_sources: 0,
    messages_with_memory_sources: 0, messages_with_web_sources: 0, messages_with_persistent_id: 0,
  };
  const rows = query<{ chat_history: unknown }>(db, 'SELECT chat_history FROM mistakes WHERE json_array_length(chat_history) > 0'); // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
  for (const row of rows) {
    if (typeof row.chat_history !== 'string') continue;
    let messages: DebugMessagePresence[];
    try { messages = parseDebugChatHistory(row.chat_history); } catch { continue; }
    stats.total_messages += messages.length;
    for (const msg of messages) {
      if (msg.images) stats.messages_with_images++;
      if (msg.thinking) stats.messages_with_thinking++;
      if (msg.rag) stats.messages_with_rag_sources++;
      if (msg.memory) stats.messages_with_memory_sources++;
      if (msg.web) stats.messages_with_web_sources++;
      if (msg.persistent) stats.messages_with_persistent_id++;
    }
  }
  return stats;
}
export function textbookPages(db: SqlExecutor, warn: (message: string) => void): DebugTextbookPageInfo[] {
  const rows = query<TextbookRow>(db, 'SELECT id, resource_id, file_name, page_count, ocr_pages_json, extracted_text FROM files'); // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
  const result: DebugTextbookPageInfo[] = [];
  for (const row of rows) {
    try {
      // Preserve the original closure's order: the two text blobs precede id/resource/page_count.
      const ocr = optionalString(row.ocr_pages_json, 4, 'ocr_pages_json');
      const extracted = optionalString(row.extracted_text, 5, 'extracted_text');
      const id = sqlString(row.id, 0, 'id');
      const resource = optionalString(row.resource_id, 1, 'resource_id');
      const filename = optionalString(row.file_name, 2, 'file_name');
      const pages = row.page_count === null ? null : sqlInteger(row.page_count, 3, 'page_count', -2147483648n, 2147483647n);
      result.push({ textbook_id: id, resource_id: resource, file_name: filename, page_count: pages,
        has_ocr_pages_json: ocr !== null, ocr_pages_json_len: ocr === null ? null : Buffer.byteLength(ocr),
        has_extracted_text: extracted !== null, extracted_text_len: extracted === null ? null : Buffer.byteLength(extracted) });
    } catch (error) {
      warn(`[debug_commands] Row parse error (skipped): ${message(error)}`);
    }
  }
  return result;
}
export function migrationStatus(db: SqlExecutor, warn: (message: string) => void): VfsMigrationDiagnostic {
  let recorded_version = 0;
  try {
    const recorded = db.pluck<SqlValue>(defineQuery('SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history', { options: { safeIntegers: true } })); // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
    if (typeof recorded === 'bigint' && recorded >= 0n && recorded <= 4294967295n) recorded_version = Number(recorded);
  } catch { recorded_version = 0; } // Rust query_row::<u32>(...).unwrap_or(0).
  const history = db.all(defineQuery<void, HistoryRow>('SELECT version, name, applied_on, 1 as success FROM refinery_schema_history ORDER BY version', { options: { safeIntegers: true } })); // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
  const migration_history = history.flatMap(row => {
    try {
      const version = sqlInteger(row.version, 0, 'version', 0n, 4294967295n);
      const name = sqlString(row.name, 1, 'name');
      const applied = sqlString(row.applied_on, 2, 'applied_on');
      const success = sqlInteger(row.success, 3, 'success', -2147483648n, 2147483647n) === 1;
      return [{ version, name, applied_at: applied, success }];
    } catch (error) { warn(`[debug_commands] Row parse error (skipped): ${message(error)}`); return []; }
  });
  const resources_columns = db.all<{ name: string }>("SELECT name FROM pragma_table_info('resources')").flatMap(row => typeof row.name === 'string' ? [row.name] : []); // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
  const missing_index_columns = ['index_state', 'index_hash', 'index_error', 'indexed_at', 'index_retry_count'].filter(key => !resources_columns.includes(key));
  const vfs_index_units_exists = count(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vfs_index_units'") > 0; // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
  const vfs_index_segments_exists = count(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vfs_index_segments'") > 0; // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
  const vfs_indexing_config_exists = count(db, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='vfs_indexing_config'") > 0; // boundary-allow sql-outside-repository: 平台诊断只读统计（repository/）
  const expected_version = 18;
  const [diagnosis, suggested_fix] = recorded_version < expected_version
    ? [`迁移未完成：记录版本 ${recorded_version} < 预期版本 ${expected_version}`, '迁移器应该会自动执行待应用的迁移，请检查启动日志']
    : missing_index_columns.length ? [`版本号正确但列缺失：迁移 ${recorded_version} 已记录但 resources 表缺少列 [${missing_index_columns.map(c => JSON.stringify(c)).join(', ')}]`, '迁移记录存在但实际列未添加，需要删除迁移记录并重新执行']
    : !vfs_index_units_exists || !vfs_index_segments_exists || !vfs_indexing_config_exists ? [`版本号正确但表缺失：vfs_index_units=${vfs_index_units_exists}, vfs_index_segments=${vfs_index_segments_exists}, vfs_indexing_config=${vfs_indexing_config_exists}`, '迁移记录存在但实际表未创建，需要删除迁移记录并重新执行']
    : ['迁移状态正常', '无需修复'];
  return { recorded_version, expected_version, migration_history, resources_columns, missing_index_columns, vfs_index_units_exists, vfs_index_segments_exists, vfs_indexing_config_exists, diagnosis: diagnosis!, suggested_fix: suggested_fix! };
}
