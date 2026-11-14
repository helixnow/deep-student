import { mkdir, writeFile } from 'node:fs/promises';
import { sep } from 'node:path';
import { CommandError, type Context } from '../../kernel/api.ts';
import { AppError } from '../errors/api.ts';
import { ioMessage, rustJoin } from '../paths/compat.ts';
import { statusLine } from '../util/index.ts';
import type { DatabaseName } from '../storage/api.ts';
import { databaseStats, migrationStatus, textbookPages } from './repository/debug.ts';

/** Rust `Debug` for `VfsMigrationDiagnostic`（`info!("... {:?}", result)`）。 */
function debugMigrationStatus(result: ReturnType<typeof migrationStatus>): string {
  const strings = (values: string[]) => `[${values.map(value => JSON.stringify(value)).join(', ')}]`;
  const records = result.migration_history.map(record =>
    `MigrationRecord { version: ${record.version}, name: ${JSON.stringify(record.name)}, applied_at: ${JSON.stringify(record.applied_at)}, success: ${record.success} }`);
  return `VfsMigrationDiagnostic { recorded_version: ${result.recorded_version}, expected_version: ${result.expected_version}, `
    + `migration_history: [${records.join(', ')}], resources_columns: ${strings(result.resources_columns)}, `
    + `missing_index_columns: ${strings(result.missing_index_columns)}, vfs_index_units_exists: ${result.vfs_index_units_exists}, `
    + `vfs_index_segments_exists: ${result.vfs_index_segments_exists}, vfs_indexing_config_exists: ${result.vfs_indexing_config_exists}, `
    + `diagnosis: ${JSON.stringify(result.diagnosis)}, suggested_fix: ${JSON.stringify(result.suggested_fix)} }`;
}

export function registerDatabaseCommands(ctx: Context) {
  ctx.commands.register('check_test_dependencies', async () => {
    const start = performance.now();
    const metrics = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      let available = false, error: string | null = null;
      let latency = 0;
      try {
        const response = await fetch('http://127.0.0.1:59321/metrics', { signal: controller.signal });
        latency = Math.floor(performance.now() - start);
        available = response.ok;
        if (!available) error = `HTTP ${statusLine(response.status)}`;
        // Rust checks headers then drops Response. Body cleanup is not awaited,
        // cannot change health status/latency and its failure is not a request failure.
        void response.body?.cancel().catch(() => undefined);
      } catch {
        latency = Math.floor(performance.now() - start);
        error = controller.signal.aborted ? 'Timeout' : 'Request failed: error sending request for url (http://127.0.0.1:59321/metrics)';
      }
      finally { clearTimeout(timer); }
      return { service: 'prometheus', available, latency_ms: latency, error };
    })();
    const dbStart = performance.now();
    let dbError: string | null = null;
    try { ctx.storage.database('mistakes'); } catch (error) { dbError = `Database connection failed: ${error instanceof Error ? error.message : String(error)}`; }
    const database = { service: 'database', available: dbError === null, latency_ms: Math.floor(performance.now() - dbStart), error: dbError };
    // health_check.rs:74–83 deliberately treats web search as available without probing.
    const results = [await metrics, database, { service: 'web_search', available: true, latency_ms: null, error: null }];
    return { available: results.every(result => result.available), details: Object.fromEntries(results.map(result => [result.service, result.available])), errors: results.flatMap(result => result.error === null ? [] : [result.error]), results };
  });
  const database = (name: DatabaseName, prefix: string) => {
    try { return ctx.storage.database(name); }
    catch (error) { throw new CommandError(AppError.database(`${prefix}: ${error instanceof Error ? error.message : String(error)}`)); }
  };
  ctx.commands.register('debug_get_database_stats', () => {
    // Rust debug_commands.rs:71 prints before attempting the connection, in release too.
    process.stdout.write('📊 [DEBUG] 收集数据库统计信息\n');
    return databaseStats(database('mistakes', '获取数据库连接失败'));
  });
  ctx.commands.register('debug_vfs_textbook_pages', () => {
    const result = textbookPages(database('vfs', '获取 VFS 数据库连接失败'), message => ctx.logger.warn(message));
    // Preserve println output after the query succeeds (debug_commands.rs:438-456).
    process.stdout.write('\n📚 [DEBUG] Textbook Page Info:\n');
    for (const row of result) {
      const pages = row.page_count == null ? 'None' : `Some(${row.page_count})`;
      const ocr = row.has_ocr_pages_json ? `${row.ocr_pages_json_len ?? 0}chars` : 'null';
      const text = row.has_extracted_text ? `${row.extracted_text_len ?? 0}chars` : 'null';
      process.stdout.write(`  - ${row.textbook_id} (res=${row.resource_id ?? '(none)'}): page_count=${pages}, ocr_pages_json=${ocr}, extracted_text=${text}\n`);
    }
    return result;
  });
  ctx.commands.register('debug_vfs_migration_status', () => {
    // Rust `debug_commands.rs:250,380` 的 info 日志（Debug 格式化保持同名结构）。
    ctx.logger.info('[DEBUG] Diagnosing VFS migration status...');
    try {
      const result = migrationStatus(ctx.storage.database('vfs'), message => ctx.logger.warn(message));
      ctx.logger.info(`[DEBUG] VFS migration diagnosis: ${debugMigrationStatus(result)}`);
      return result;
    } catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
  });
  ctx.commands.register('write_test_report', async ({ filename, content }) => {
    const dir = rustJoin(ctx.storage.locations.baseDir, sep, 'test-reports');
    try { await mkdir(dir, { recursive: true }); } catch (error) { throw new CommandError(AppError.file_system(`创建测试报告目录失败: ${ioMessage(error)}`)); }
    const path = rustJoin(dir, sep, filename as string);
    try { await writeFile(path, content as string); } catch (error) { throw new CommandError(AppError.file_system(`写入测试报告失败: ${ioMessage(error)}`)); }
    // Rust `commands.rs:7457`：写入成功后记录 info。
    ctx.logger.info(`[测试模式] 测试报告已写入: ${JSON.stringify(path)}`);
    return { success: true, path, filename };
  });
}
