import { appendFileSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { CommandError, type Context } from '../../kernel/api.ts';
import { AppError } from '../errors/api.ts';
import { chronoRfc3339 } from '../time/index.ts';
import { ioMessage, rustJoin } from '../paths/compat.ts';
import type { DiagnosticsExportOptions, FrontendLogPayload } from '../../../contracts/ipc/generated/F4-security.ts';
import type { LogEntry, StructuredLogLevel } from './api.ts';
import { exportDiagnosticsBundle } from './diagnostics.ts';

function subdir(type: string): string {
  if (type === 'debug') return 'debug-logs';
  if (['frontend', 'backend', 'crash'].includes(type)) return type;
  throw new CommandError(AppError.validation('不支持的日志类型'));
}
function openPath(path: string, folder: boolean, platform: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(platform === 'win32' ? (folder ? 'explorer' : 'notepad') : platform === 'darwin' ? 'open' : 'xdg-open', [path], { windowsHide: !folder, stdio: 'inherit' });
    child.once('spawn', () => { child.unref(); resolve(); });
    child.once('error', error => reject(new CommandError(AppError.file_system(`${folder ? '打开日志文件夹失败' : '打开日志文件失败'}: ${ioMessage(error)}`))));
  });
}
export function registerLogCommands(ctx: Context) {
  const log = ctx.log;
  ctx.commands.register('export_diagnostics_bundle', async ({ options }) => {
    try { return await exportDiagnosticsBundle(ctx, options as DiagnosticsExportOptions); }
    catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
  });
  const join = (...parts: string[]) => rustJoin(log.logDir, sep, ...parts);
  const debug = async <T>(run: () => T): Promise<T> => {
    if (!await log.debugLogs.flushPending()) throw new CommandError(AppError.file_system('等待调试日志写入超时，请稍后重试'));
    try { return run(); } catch (error) { throw new CommandError(AppError.unknown(error instanceof Error ? error.message : String(error))); }
  };
  ctx.commands.register('get_debug_logs_info', () => debug(() => log.debugLogs.info()));
  ctx.commands.register('clear_debug_logs', () => debug(() => log.debugLogs.clearAll()));
  ctx.commands.register('cleanup_old_debug_logs', ({ maxAgeDays }) => debug(() => log.debugLogs.cleanupOld(maxAgeDays as number)));
  ctx.commands.register('read_debug_log_file', ({ path }) => debug(() => log.debugLogs.readFile(path as string)));
  ctx.commands.register('ensure_debug_log_dir', () => log.debugLogs.ensureDir());
  ctx.commands.register('save_test_log', async ({ fileName, content, logType }) => {
    const name = fileName as string;
    if (name === '' || name === '.' || name === '..' || basename(name) !== name) throw new CommandError(AppError.validation('非法的日志文件名'));
    const dir = join(subdir(logType as string));
    const path = rustJoin(dir, sep, name);
    try { await mkdir(dir, { recursive: true }); } catch (error) { throw new CommandError(AppError.file_system(`创建日志目录失败: ${ioMessage(error)}`)); }
    try { await writeFile(path, content as string); } catch (error) { throw new CommandError(AppError.file_system(`写入日志文件失败: ${ioMessage(error)}`)); }
    ctx.logger.debug(`测试日志已保存: ${JSON.stringify(path)}`);
  });
  ctx.commands.register('get_test_logs', ({ logType }) => {
    const directory = subdir(logType as string);
    let entries: string[];
    try { entries = readdirSync(join(directory)); } catch { return []; }
    const files: { path: string; time: number }[] = [];
    for (const name of entries) {
      if (extname(name) !== '.log') continue;
      try {
        const info = statSync(join(directory, name));
        if (info.isFile()) files.push({ path: `${directory}/${name}`, time: info.mtimeMs });
      } catch { continue; }
    }
    return files.sort((a, b) => b.time - a.time).map(file => file.path);
  });
  ctx.commands.register('open_log_file', async ({ logPath }) => {
    const path = logPath as string;
    if (path.includes('..') || path.startsWith('/') || path.startsWith('\\')) throw new CommandError(AppError.validation('非法的文件路径'));
    let canonical: string;
    try { canonical = realpathSync(join(path)); } catch { throw new CommandError(AppError.not_found(`日志文件不存在: ${path}`)); }
    let root = log.logDir;
    try { root = realpathSync(root); } catch { root = log.logDir; }
    const rel = relative(root, canonical);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new CommandError(AppError.validation('非法的文件路径访问'));
    await openPath(canonical, false, ctx.app.platform);
  });
  ctx.commands.register('open_logs_folder', async ({ logType }) => {
    const type = logType as string;
    const dir = type === 'all' || type === 'backend' ? log.logDir : join(subdir(type));
    try { mkdirSync(dir, { recursive: true }); } catch (error) { throw new CommandError(AppError.file_system(`创建日志目录失败: ${ioMessage(error)}`)); }
    await openPath(dir, true, ctx.app.platform);
  });
  ctx.commands.register('write_debug_logs', async ({ logs }) => {
    try { await log.structured.writeFrontendEntries(logs as LogEntry[]); }
    catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
  });
  ctx.commands.register('report_frontend_log', async ({ payload }) => {
    const p = payload as FrontendLogPayload;
    const extra = p.extra as { diagnosticId?: string; operation?: string; pluginId?: string } | null;
    if (!p.level || p.level.toUpperCase() === 'ERROR' || p.kind === 'IPC_FAILURE') {
      await log.recordError({ source: 'frontend', operation: extra?.operation ?? p.kind ?? 'CLIENT_ERROR',
        id: extra?.diagnosticId, pluginId: extra?.pluginId, error: p.message });
    }
    const text = (s: string, cap: number) => {
      const chars = [...log.redactSensitiveText(s)];
      return chars.slice(0, cap).join('') + (chars.length > cap ? '…[truncated]' : '');
    };
    const optional = (s: string | null | undefined, cap: number) => s == null ? null : text(s, cap);
    const json = (value: unknown, depth: number): unknown => {
      if (depth >= 4) return '[max depth reached]';
      const clean = log.redactSensitiveFields(value);
      if (typeof clean === 'string') return text(clean, 8000);
      if (Array.isArray(clean)) return clean.slice(0, 20).map(child => json(child, depth + 1));
      if (clean !== null && typeof clean === 'object') return Object.fromEntries(Object.entries(clean).slice(0, 40).map(([key, child]) => [key, json(child, depth + 1)]));
      return clean;
    };
    let level = (p.level ?? '').replace(/[a-z]/g, c => c.toUpperCase());
    if (level === 'WARNING') level = 'WARN';
    if (!['DEBUG', 'INFO', 'WARN', 'TRACE'].includes(level)) level = 'ERROR';
    await log.structured.log(level as StructuredLogLevel, 'FRONTEND', text(p.kind ?? 'CLIENT_ERROR', 128), {
      message: text(p.message, 16000), stack: optional(p.stack, 64000), component: optional(p.component, 256), route: optional(p.route, 2000),
      url: p.url == null ? null : text(p.url.split(/[?#]/)[0]!, 2000), line: p.line ?? null, column: p.column ?? null,
      user_agent: optional(p.user_agent, 1000), extra: p.extra == null ? null : json(p.extra, 0),
    }, null);
  });
  ctx.commands.register('log_debug_message', ({ message }) => {
    log.write('info', 'frontend_debug', message as string);
    process.stdout.write(`🔍 [FRONTEND] ${message}\n`);
  });
  ctx.commands.register('tauri_lab_frontend_log', ({ level, message, stack }) => {
    const instance_id = process.env.TAURI_LAB_INSTANCE_ID ?? null;
    const path = process.env.TAURI_LAB_FRONTEND_LOG;
    if (instance_id === null && path === undefined) return;
    const entry = { ts: chronoRfc3339(), instance_id, level, message, stack };
    if (path !== undefined) {
      try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(entry)}\n`); }
      catch (error) { throw new CommandError(ioMessage(error)); }
    }
    log.write(level === 'error' || level === 'warn' || level === 'info' ? level : 'debug', 'tauri_lab_frontend', message as string);
  });
}
