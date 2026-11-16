/** Mobile `ctx.log` backed by a bounded redacted ring + OPFS logs & debug-logs when `ctx.files` is available. */
import type { DiagnosticsExportOptions, DiagnosticsExportResult, FrontendLogPayload } from '../../../contracts/ipc/generated/F4-security.ts';
import { CommandError, definePlugin } from '../../kernel/core.ts';
import { AppError } from '../errors/api.ts';
import type { FilesService } from '../files/api.ts';
import type { PathsService } from '../paths/api.ts';
import type { SettingsService } from '../settings/api.ts';
import { chronoRfc3339, civilTime, nowEpochNanos, ymd } from '../time/index.ts';
import { posix } from '../util/path.ts';
import { decodeUtf8Strict, Utf8DecodeError, utf8ByteLength } from '../util/portable.ts';
import { MemoryZipSink, ZipWriter } from '../zip/core/index.ts';
import type { DebugLogsInfo, LogEntry, LogLevel, LogService, StructuredLogger, StructuredLogLevel } from './api.ts';
import {
  AUTO_CLEANUP_THRESHOLD,
  buildDebugLogFilename,
  buildRequestDebugEntry,
  buildResponseDebugEntry,
  DEBUG_LOGS_DIR,
  FLUSH_TIMEOUT_MS,
  formatSize,
  pathStartsWith,
} from './debug-logs-core.ts';
import { sanitizeDiagnosticMessageWithPlatform, sanitizeLogTextWithPlatform } from './diagnostics-sanitize-core.ts';
import { diagnosticRecord, type DiagnosticQuery, type DiagnosticRecord } from './incidents-core.ts';
import { redactSensitiveFields, redactSensitiveText, sanitizeForLevel } from './redact.ts';

const BACKEND_SENTRY_SETTING = 'sentry_error_reporting_enabled';
const MAX_FRONTEND_LINES = 500;
const MAX_FRONTEND_BYTES = 10 * 1024 * 1024;
const MAX_DIAGNOSTICS_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DIAGNOSTICS_BUNDLE_BYTES = 100 * 1024 * 1024;

export interface MobileLogOptions {
  files?: FilesService | (() => FilesService | undefined);
  platform?: string;
}

export interface MobileDebugLogOps {
  ensureDirAsync(logRoot?: string): Promise<string>;
  infoAsync(roots?: readonly string[]): Promise<DebugLogsInfo>;
  clearAllAsync(roots?: readonly string[]): Promise<number>;
  cleanupOldAsync(maxAgeDays: number, roots?: readonly string[]): Promise<number>;
  readFileAsync(path: string, roots?: readonly string[]): Promise<string>;
}

export interface MobileLogService extends LogService {
  entries(): readonly string[];
  readonly debugLogsAsync: MobileDebugLogOps;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveFiles(source?: MobileLogOptions['files']): FilesService | undefined {
  if (source === undefined) return undefined;
  return typeof source === 'function' ? source() : source;
}

function parseDebugFilenameMs(filename: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T-](\d{2})-(\d{2})-(\d{2})(?:\.(\d{1,3}))?/.exec(filename);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  // Debug log filenames are formatted using local civil time (`civilTime(now, true)`).
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function sanitizeJsonDepth(value: unknown, depth: number, redactText: (s: string, cap: number) => string): unknown {
  if (depth >= 4) return '[max depth reached]';
  const clean = redactSensitiveFields(value);
  if (typeof clean === 'string') return redactText(clean, 8000);
  if (Array.isArray(clean)) return clean.slice(0, 20).map(child => sanitizeJsonDepth(child, depth + 1, redactText));
  if (clean !== null && typeof clean === 'object') {
    return Object.fromEntries(Object.entries(clean).slice(0, 40).map(([k, v]) => [k, sanitizeJsonDepth(v, depth + 1, redactText)]));
  }
  return clean;
}

export function createMobileLog(logDir: string, capacity = 500, options: MobileLogOptions = {}): MobileLogService {
  const normalizedLogDir = posix.normalize(logDir);
  const platform = options.platform ?? 'linux';
  const getFiles = (): FilesService | undefined => resolveFiles(options.files);

  const ring: string[] = [];
  const incidents: DiagnosticRecord[] = [];
  let seq = 0;
  let pendingWrites = 0;
  let idleWaiters: Array<() => void> = [];
  let pendingQueue: Promise<void> = Promise.resolve();

  const enqueueOpfsAppend = (filePath: string, line: string): Promise<void> => {
    const files = getFiles();
    if (!files) return Promise.resolve();
    pendingQueue = pendingQueue.then(async () => {
      const existing = await files.readText(filePath).catch(() => '');
      const next = existing ? `${existing}${existing.endsWith('\n') ? '' : '\n'}${line}\n` : `${line}\n`;
      await files.writeAtomic(filePath, next, { createParents: true });
    }).catch(() => undefined);
    return pendingQueue;
  };

  const write = (level: LogLevel, target: string, message: string): void => {
    const entry = redactSensitiveText(`[${level}][${target}] ${message}`);
    ring.push(entry);
    if (ring.length > capacity) ring.shift();
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(entry);
  };

  const trackWrite = (work: () => Promise<void>): void => {
    pendingWrites++;
    void work().finally(() => {
      pendingWrites--;
      if (pendingWrites === 0) for (const resolve of idleWaiters.splice(0)) resolve();
    });
  };

  const autoCleanupDebugDir = async (files: FilesService, dir: string): Promise<void> => {
    const entries = await files.readDir(dir).catch(() => []);
    const jsonFiles = entries
      .filter(e => e.kind === 'file' && e.name.endsWith('.json') && e.name !== '.json')
      .map(e => e.path)
      .sort();
    if (jsonFiles.length <= AUTO_CLEANUP_THRESHOLD) return;
    const toRemove = Math.floor(jsonFiles.length / 10);
    let removed = 0;
    for (const file of jsonFiles.slice(0, toRemove)) {
      try { await files.rm(file); removed++; } catch { continue; }
    }
    if (removed > 0) write('info', 'dstu_platform::debug_log_service', `[DebugLog] Auto-cleanup: removed ${removed} oldest files (total was ${jsonFiles.length})`);
  };

  const writeDebugEntry = (targetDir: string, model: string, tag: string, build: (timestamp: string) => string): string | null => {
    const built = buildDebugLogFilename(model, tag, seq);
    seq = (seq + 1) >>> 0;
    let json: string;
    try { json = build(built.timestamp); }
    catch (error) {
      write('warn', 'dstu_platform::debug_log_service', `[DebugLog] Serialize failed: ${String(error)}`);
      return null;
    }
    const cleanDir = posix.normalize(targetDir);
    const filepath = posix.join(cleanDir, built.filename);
    const files = getFiles();
    if (files) {
      trackWrite(async () => {
        try {
          await files.mkdir(cleanDir, { recursive: true });
          await files.writeAtomic(filepath, json, { createParents: true });
          write('info', 'dstu_platform::debug_log_service', `[DebugLog] Wrote: ${built.filename} (${utf8ByteLength(json)} bytes)`);
        } catch (error) {
          write('warn', 'dstu_platform::debug_log_service', `[DebugLog] Write failed ${built.filename}: ${errorMessage(error)}`);
        }
        if (built.seq % 50 === 0) await autoCleanupDebugDir(files, cleanDir);
      });
    }
    return filepath;
  };

  const flushPending = (): Promise<boolean> => {
    if (pendingWrites === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        write('warn', 'dstu_platform::debug_log_service', `[DebugLog] Timed out waiting for ${pendingWrites} pending writes`);
        resolve(false);
      }, FLUSH_TIMEOUT_MS);
      idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  };

  const listDebugFiles = async (roots: readonly string[]): Promise<string[]> => {
    const files = getFiles();
    if (!files) return [];
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const root of roots) {
      const dir = posix.join(posix.normalize(root), DEBUG_LOGS_DIR);
      const entries = await files.readDir(dir).catch(() => []);
      for (const entry of entries) {
        if (entry.kind === 'file' && entry.name.endsWith('.json') && entry.name !== '.json' && !seen.has(entry.path)) {
          seen.add(entry.path);
          paths.push(entry.path);
        }
      }
    }
    return paths.sort();
  };

  const debugLogsAsync: MobileDebugLogOps = {
    async ensureDirAsync(logRoot = normalizedLogDir): Promise<string> {
      const dir = posix.join(posix.normalize(logRoot), DEBUG_LOGS_DIR);
      const files = getFiles();
      if (files) await files.mkdir(dir, { recursive: true });
      return dir;
    },
    async infoAsync(roots = [normalizedLogDir]): Promise<DebugLogsInfo> {
      const files = getFiles();
      if (!files) return { count: 0, total_size_bytes: 0, total_size_display: '0 B', oldest_file: null, newest_file: null };
      const list = await listDebugFiles(roots);
      let total = 0;
      for (const path of list) {
        const info = await files.stat(path).catch(() => null);
        if (info !== null) total += info.size;
      }
      const name = (p: string | undefined) => (p === undefined ? null : (posix.basename(p) || null));
      return {
        count: list.length,
        total_size_bytes: total,
        total_size_display: formatSize(total),
        oldest_file: name(list[0]),
        newest_file: name(list[list.length - 1]),
      };
    },
    async clearAllAsync(roots = [normalizedLogDir]): Promise<number> {
      const files = getFiles();
      if (!files) return 0;
      const list = await listDebugFiles(roots);
      let removed = 0;
      for (const path of list) {
        try { await files.rm(path); removed++; } catch { continue; }
      }
      write('info', 'dstu_platform::debug_log_service', `[DebugLog] Cleared ${removed} / ${list.length} log files`);
      return removed;
    },
    async cleanupOldAsync(maxAgeDays: number, roots = [normalizedLogDir]): Promise<number> {
      const files = getFiles();
      if (!files) return 0;
      const list = await listDebugFiles(roots);
      const cutoff = Date.now() - maxAgeDays * 86_400_000;
      let removed = 0;
      for (const path of list) {
        const info = await files.stat(path).catch(() => null);
        // Debug log filenames encode creation time directly; fall back to stat modifiedMs for custom files.
        const parsedTs = parseDebugFilenameMs(posix.basename(path));
        const modified = parsedTs ?? (info && info.modifiedMs > 0 ? info.modifiedMs : Date.now());
        if (modified < cutoff) {
          try { await files.rm(path); removed++; } catch { continue; }
        }
      }
      write('info', 'dstu_platform::debug_log_service', `[DebugLog] Cleaned up ${removed} old log files (>${maxAgeDays} days)`);
      return removed;
    },
    async readFileAsync(path: string, roots = [normalizedLogDir]): Promise<string> {
      const files = getFiles();
      if (!files) throw new Error('OPFS 文件系统未就绪');
      if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('非法路径：不在 debug-logs 目录中');
      const normalized = posix.normalize(path);
      if (normalized.split('/').includes('..')) throw new Error('非法路径：不在 debug-logs 目录中');
      const allowed = roots.some(root => pathStartsWith(normalized, posix.join(posix.normalize(root), DEBUG_LOGS_DIR), false));
      if (!allowed) throw new Error('非法路径：不在 debug-logs 目录中');
      if (posix.extname(normalized) !== '.json') throw new Error('非法文件类型：仅允许读取 .json 文件');
      const stat = await files.stat(normalized).catch(err => {
        throw new Error(`路径解析失败: ${errorMessage(err)}`);
      });
      if (stat.kind !== 'file') throw new Error('读取调试日志失败: 目标不是文件');
      try {
        const bytes = await files.readBytes(normalized);
        return decodeUtf8Strict(bytes);
      } catch (error) {
        throw new Error(`读取调试日志失败: ${error instanceof Utf8DecodeError ? 'stream did not contain valid UTF-8' : errorMessage(error)}`);
      }
    },
  };

  const record = async (operation: string, data: unknown): Promise<void> => {
    write('debug', operation, JSON.stringify(redactSensitiveFields(data)));
  };

  const structured: StructuredLogger = {
    async log(level, module, operation, data, _context) {
      const normalized = level.toLowerCase() as LogLevel;
      const lineObj = {
        timestamp: chronoRfc3339(undefined, true),
        level,
        module,
        operation,
        data: redactSensitiveFields(data) ?? null,
      };
      const serialized = JSON.stringify(lineObj);
      write(normalized === 'warn' || normalized === 'error' || normalized === 'info' || normalized === 'trace' ? normalized : 'debug',
        module, `${operation}: ${JSON.stringify(lineObj.data)}`);
      if (operation === 'DIAGNOSTIC' || module === 'FRONTEND') {
        const subdir = module === 'FRONTEND' ? 'frontend' : 'backend';
        const suffix = module === 'FRONTEND' ? 'frontend.log' : 'diagnostic.log';
        const filePath = posix.join(normalizedLogDir, subdir, `${ymd(civilTime(nowEpochNanos(), true))}_${suffix}`);
        await enqueueOpfsAppend(filePath, serialized);
      }
    },
    logDatabaseOperation: (...args) => record('database', args),
    logChatRecordOperation: (...args) => record('chat', args),
    logRagOperation: (...args) => record('rag', args),
    logStreamingOperation: (...args) => record('stream', args),
    logApiCall: (...args) => record('api', args),
    logStateChange: (...args) => record('state', args),
    logLlmUsage: (...args) => record('llm', args),
    async flush() { await pendingQueue; },
    async writeFrontendEntries(entries: LogEntry[]) {
      const files = getFiles();
      const lines: string[] = [];
      let totalBytes = 0;
      for (const entry of entries.slice(0, MAX_FRONTEND_LINES)) {
        const sanitized = redactSensitiveFields(entry);
        const line = JSON.stringify(sanitized);
        const lineBytes = utf8ByteLength(line) + 1;
        if (totalBytes + lineBytes > MAX_FRONTEND_BYTES) break;
        totalBytes += lineBytes;
        lines.push(line);
        write('debug', entry.module || 'frontend', line);
      }
      if (files && lines.length > 0) {
        const filePath = posix.join(normalizedLogDir, 'frontend', `${ymd(civilTime(nowEpochNanos(), true))}_frontend.log`);
        await enqueueOpfsAppend(filePath, lines.join('\n'));
      }
    },
  };

  const service: MobileLogService = {
    async recordError(event) {
      const rec = diagnosticRecord(event, platform);
      incidents.push(rec);
      if (incidents.length > 200) incidents.shift();
      write('error', rec.operation, rec.message);
      await structured.log('ERROR', 'DIAGNOSTIC', rec.operation, rec);
    },
    async queryErrors(query: DiagnosticQuery) {
      await structured.flush();
      const filtered = incidents
        .filter(r => (query.id === undefined || r.id === query.id)
          && (query.operation === undefined || r.operation === query.operation)
          && (query.pluginId === undefined || r.pluginId === query.pluginId))
        .slice()
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return {
        records: filtered.slice(0, 12),
        sourcesWithoutRecords: (['host', 'frontend', 'electron'] as const).filter(s => !filtered.some(r => r.source === s)),
        missing: getFiles() ? [] : ['opfs files service unavailable'],
        truncated: filtered.length > 12,
      };
    },
    logDir: normalizedLogDir,
    mainLogFile: posix.join(normalizedLogDir, 'deep-student.log'),
    write,
    enabled: () => true,
    logger(target) {
      return {
        target,
        error: message => write('error', target, message),
        warn: message => write('warn', target, message),
        info: message => write('info', target, message),
        debug: message => write('debug', target, message),
        trace: message => write('trace', target, message),
      };
    },
    structured,
    debugLogs: {
      ensureDir(logRoot = normalizedLogDir): string {
        const dir = posix.join(posix.normalize(logRoot), DEBUG_LOGS_DIR);
        const files = getFiles();
        if (files) trackWrite(() => files.mkdir(dir, { recursive: true }).catch(() => undefined));
        return dir;
      },
      writeRequestEntry(targetDir, tag, model, url, streamEvent, requestBody) {
        return writeDebugEntry(targetDir, model, tag, ts => buildRequestDebugEntry(ts, tag, model, url, streamEvent, requestBody));
      },
      writeResponseEntry(targetDir, tag, model, streamEvent, rawResponse) {
        return writeDebugEntry(targetDir, model, tag, ts => buildResponseDebugEntry(ts, tag, model, streamEvent, rawResponse));
      },
      flushPending,
      roots: () => [normalizedLogDir],
      info: () => ({ count: 0, total_size_bytes: 0, total_size_display: '0 B', oldest_file: null, newest_file: null }),
      clearAll: () => 0,
      cleanupOld: () => 0,
      readFile() { throw new Error('请使用移动端异步调试日志命令读取文件'); },
    },
    writeCrashLog(error) {
      const msg = sanitizeDiagnosticMessageWithPlatform(errorMessage(error), platform);
      write('error', 'crash', msg);
      const path = posix.join(normalizedLogDir, 'crash', `${ymd(civilTime(nowEpochNanos(), true))}_crash.log`);
      void enqueueOpfsAppend(path, `${chronoRfc3339(undefined, true)} ${msg}`);
      return path;
    },
    redactSensitiveText,
    redactSensitiveFields,
    sanitizeForLevel,
    scrubPii: input => redactSensitiveText(input).split(normalizedLogDir).join('<logs>'),
    entries: () => [...ring],
    debugLogsAsync,
  };
  return service;
}

export default definePlugin({
  meta: {
    id: 'dstu.platform.log',
    provides: ['log'],
    platforms: ['mobile'],
    commands: [
      'ensure_debug_log_dir',
      'write_debug_logs',
      'get_debug_logs_info',
      'read_debug_log_file',
      'clear_debug_logs',
      'cleanup_old_debug_logs',
      'log_debug_message',
      'report_frontend_log',
      'tauri_lab_frontend_log',
      'set_backend_sentry_enabled',
      'export_diagnostics_bundle',
    ],
  },
  inject: ['paths'],
  apply(ctx) {
    const paths = ctx.paths as PathsService;
    const filesGetter = (): FilesService | undefined => ctx.reflect.get('files', false) as FilesService | undefined;
    const log = createMobileLog(paths.appLogDir, 500, { files: filesGetter, platform: ctx.app.platform });
    ctx.reflect.provide('log', log);

    const debug = async <T>(run: () => Promise<T>): Promise<T> => {
      if (!(await log.debugLogs.flushPending())) {
        throw new CommandError(AppError.file_system('等待调试日志写入超时，请稍后重试'));
      }
      try { return await run(); }
      catch (error) { throw new CommandError(AppError.unknown(errorMessage(error))); }
    };

    ctx.commands.register('ensure_debug_log_dir', async () => {
      try { return await log.debugLogsAsync.ensureDirAsync(); }
      catch (error) { throw new CommandError(AppError.file_system(`创建调试日志目录失败: ${errorMessage(error)}`)); }
    });

    ctx.commands.register('get_debug_logs_info', () => debug(() => log.debugLogsAsync.infoAsync(paths.debugLogRoots)));
    ctx.commands.register('clear_debug_logs', () => debug(() => log.debugLogsAsync.clearAllAsync(paths.debugLogRoots)));
    ctx.commands.register<{ maxAgeDays: number }>('cleanup_old_debug_logs', ({ maxAgeDays }) =>
      debug(() => log.debugLogsAsync.cleanupOldAsync(maxAgeDays, paths.debugLogRoots)));
    ctx.commands.register<{ path: string }>('read_debug_log_file', ({ path }) =>
      debug(() => log.debugLogsAsync.readFileAsync(path, paths.debugLogRoots)));

    ctx.commands.register<{ logs: LogEntry[] }>('write_debug_logs', async ({ logs }) => {
      try { await log.structured.writeFrontendEntries(logs); }
      catch (error) { throw new CommandError(errorMessage(error)); }
      return null;
    });

    ctx.commands.register<{ message: string }>('log_debug_message', ({ message }) => {
      log.write('info', 'frontend_debug', String(message ?? ''));
      return null;
    });

    ctx.commands.register<{ payload: FrontendLogPayload }>('report_frontend_log', async ({ payload }) => {
      const p = payload;
      const extra = (p.extra ?? null) as { diagnosticId?: string; operation?: string; pluginId?: string } | null;
      if (!p.level || p.level.toUpperCase() === 'ERROR' || p.kind === 'IPC_FAILURE') {
        await log.recordError({
          source: 'frontend',
          operation: extra?.operation ?? p.kind ?? 'CLIENT_ERROR',
          id: extra?.diagnosticId,
          pluginId: extra?.pluginId,
          error: p.message,
        });
      }
      const text = (s: string, cap: number): string => {
        const chars = [...log.redactSensitiveText(s)];
        return chars.slice(0, cap).join('') + (chars.length > cap ? '…[truncated]' : '');
      };
      const optional = (s: string | null | undefined, cap: number): string | null => s == null ? null : text(s, cap);
      let level = (p.level ?? '').replace(/[a-z]/g, c => c.toUpperCase());
      if (level === 'WARNING') level = 'WARN';
      if (!['DEBUG', 'INFO', 'WARN', 'TRACE'].includes(level)) level = 'ERROR';
      await log.structured.log(level as StructuredLogLevel, 'FRONTEND', text(p.kind ?? 'CLIENT_ERROR', 128), {
        message: text(p.message, 16000),
        stack: optional(p.stack, 64000),
        component: optional(p.component, 256),
        route: optional(p.route, 2000),
        url: p.url == null ? null : text(p.url.split(/[?#]/)[0]!, 2000),
        line: p.line ?? null,
        column: p.column ?? null,
        user_agent: optional(p.user_agent, 1000),
        extra: p.extra == null ? null : sanitizeJsonDepth(p.extra, 0, text),
      }, null);
      return null;
    });

    ctx.commands.register<{ level: string; message: string; stack?: string | null }>('tauri_lab_frontend_log', ({ level, message, stack }) => {
      const lvl = level === 'error' || level === 'warn' || level === 'info' ? level : 'debug';
      const detail = stack ? `${message}\n${stack}` : message;
      log.write(lvl, 'tauri_lab_frontend', detail);
      return null;
    });

    ctx.commands.register<{ enabled: boolean }>('set_backend_sentry_enabled', async ({ enabled }) => {
      const value = Boolean(enabled);
      const settings = ctx.reflect.get('settings', false) as SettingsService | undefined;
      if (settings) {
        try { settings.save(BACKEND_SENTRY_SETTING, String(value)); }
        catch (error) { throw new CommandError(`保存错误报告授权失败: ${errorMessage(error)}`); }
      } else {
        const files = filesGetter();
        if (files) {
          try { await files.writeAtomic(posix.join(paths.appConfigDir, 'sentry-enabled.txt'), String(value), { createParents: true }); }
          catch (error) { throw new CommandError(`保存错误报告授权失败: ${errorMessage(error)}`); }
        }
      }
      log.write('info', 'sentry', `[Sentry] backend error reporting ${value ? 'enabled (no native mobile SDK configured)' : 'disabled'}`);
      return false;
    });

    ctx.commands.register<{ options: DiagnosticsExportOptions }>('export_diagnostics_bundle', async ({ options }) => {
      try {
        await log.structured.flush();
        if (!(await log.debugLogs.flushPending())) {
          throw new Error('等待详细请求日志写入超时，请稍后重试');
        }
        const files = filesGetter();
        if (!files) throw new Error('OPFS 文件系统未就绪');
        const destInput = options?.destination;
        if (typeof destInput !== 'string' || !destInput.startsWith('/')) {
          throw new Error('诊断包保存路径必须是绝对路径');
        }
        const destination = posix.normalize(destInput);
        const existing = await files.stat(destination).catch(() => null);
        if (existing?.kind === 'directory') throw new Error('诊断包保存路径不能是目录');

        const detailed = options?.includeDebugLogs ?? false;
        const collected: Array<{ name: string; text: string }> = [];
        const skipped: string[] = [];
        let total = 0;

        for (const root of paths.debugLogRoots) {
          const logRoot = root === log.logDir ? log.logDir : posix.join(root, 'logs');
          if (!(await files.exists(logRoot).catch(() => false))) continue;
          const labelPrefix = root === log.logDir ? 'current' : `slot_${posix.basename(root)}`;
          for await (const entry of files.walk(logRoot)) {
            if (entry.kind !== 'file' || entry.path === destination) continue;
            if (!detailed && entry.relativePath.split('/').includes(DEBUG_LOGS_DIR)) continue;
            const archiveName = `${labelPrefix}/${entry.relativePath}`;
            const entrySize = (await files.stat(entry.path).catch(() => null))?.size ?? 0;
            if (entrySize > MAX_DIAGNOSTICS_FILE_BYTES) {
              skipped.push(`${archiveName}: file exceeds 20 MB`);
              continue;
            }
            if (total + entrySize > MAX_DIAGNOSTICS_BUNDLE_BYTES) {
              skipped.push(`${archiveName}: bundle exceeds 100 MB`);
              continue;
            }
            try {
              const bytes = await files.readBytes(entry.path);
              const rawText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
              collected.push({ name: archiveName, text: sanitizeLogTextWithPlatform(rawText, detailed, ctx.app.platform) });
              total += entrySize;
            } catch (error) {
              skipped.push(`${archiveName}: ${errorMessage(error)}`);
            }
          }
        }

        const ringSanitized = log.entries().map(line => sanitizeDiagnosticMessageWithPlatform(line, ctx.app.platform));
        const systemInfo = {
          app_version: ctx.app.version,
          platform: ctx.app.platform,
          data_dir: paths.appDataDir,
          log_dir: log.logDir,
          generated_at: chronoRfc3339(),
        };
        const manifest = {
          generated_at: systemInfo.generated_at,
          app_version: ctx.app.version,
          platform: ctx.app.platform,
          include_debug_logs: detailed,
          file_count: collected.length + 2,
          skipped,
          notes: [
            'Absolute user paths and common credential formats were redacted.',
            'Common user-content fields are summarized unless detailed request logs were explicitly included.',
            'The bundle intentionally contains no databases or user documents.',
          ],
        };

        let outBytes: Uint8Array;
        if (destination.toLowerCase().endsWith('.json')) {
          const jsonBundle = JSON.stringify({
            manifest,
            system_info: systemInfo,
            ring_entries: ringSanitized,
            files: collected,
          }, null, 2);
          outBytes = new TextEncoder().encode(jsonBundle);
        } else {
          const sink = new MemoryZipSink();
          const writer = new ZipWriter(sink);
          for (const item of collected) {
            await writer.addBytes(item.name, new TextEncoder().encode(item.text));
          }
          await writer.addBytes('ring_entries.json', new TextEncoder().encode(JSON.stringify(ringSanitized, null, 2)));
          await writer.addBytes('system_info.json', new TextEncoder().encode(JSON.stringify(systemInfo, null, 2)));
          await writer.addBytes('manifest.json', new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
          await writer.finish();
          outBytes = sink.bytes();
        }
        await files.writeAtomic(destination, outBytes, { createParents: true });
        const result: DiagnosticsExportResult = {
          path: destination,
          fileCount: manifest.file_count,
          skippedCount: skipped.length,
          sizeBytes: outBytes.byteLength,
        };
        return result;
      } catch (error) {
        throw new CommandError(errorMessage(error));
      }
    });
  },
});
