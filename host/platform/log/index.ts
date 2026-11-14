/**
 * `ctx.log` 实现。文件位置与格式见 ./api.ts。
 */
import { chmodSync, mkdirSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../kernel/api.ts';
import type { PathsService } from '../paths/api.ts';
import type { DebugFilterLevel, Logger, LogLevel, LogService } from './api.ts';
import { civilTime, nowEpochNanos } from '../time/index.ts';
import { setSseBufferLogger } from '../util/sse-buffer.ts';
import { cleanupOldCrashLogs, writeCrashLog, type CrashInfo } from './crash.ts';
import { DebugLogFileService } from './debug-logs.ts';
import { formatLine, levelEnabled, MAIN_LOG_FILE_NAME, MAIN_LOG_KEEP, MAIN_LOG_MAX_SIZE, RotatingFile } from './main-log.ts';
import { redactSensitiveFields, redactSensitiveText, sanitizeForLevel, scrubPii } from './redact.ts';
import { DebugLogger } from './structured.ts';
import type {} from '../../plugins/agent-skills/api.ts';
import { diagnosticQuery, diagnosticTool } from './agent-executor.ts';
import { diagnosticRecord, queryDiagnosticErrors } from './incidents.ts';
import { registerLogCommands } from './commands.ts';
import { bridgeCordisLogger, type CordisLogSink } from './cordis-bridge.ts';

export type * from './api.ts';
export { filterLevelFromStrLossy, redactSensitiveFields, redactSensitiveText, sanitizeForLevel, scrubPii } from './redact.ts';

export interface LogServiceOptions {
  paths: PathsService;
  /** `cfg!(debug_assertions)`：debug 构建同时写 stdout。 */
  debug: boolean;
  version: string;
  buildNumber?: string;
  gitHash?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** 测试注入时钟。 */
  now?: () => bigint;
}

export interface LogServiceHandle extends LogService, CordisLogSink {
  /** 启动 5 秒周期刷盘（`start_periodic_flush`）；返回停止函数。 */
  startPeriodicFlush(): () => void;
  close(): Promise<void>;
}

export function createLogService(options: LogServiceOptions): LogServiceHandle {
  const { paths } = options;
  const env = options.env ?? process.env;
  const now = options.now ?? nowEpochNanos;
  const logDir = paths.appLogDir;
  mkdirSync(logDir, { recursive: true });
  if (process.platform !== 'win32') chmodSync(logDir, 0o700);

  const file = new RotatingFile({ dir: logDir, fileName: MAIN_LOG_FILE_NAME, maxSize: MAIN_LOG_MAX_SIZE, keepCount: MAIN_LOG_KEEP, local: true, now });

  let closed = false;
  const writeLine = (level: LogLevel, target: string, message: string, at: bigint, echo: boolean): void => {
    if (!levelEnabled(level, target)) return;
    const line = formatLine(civilTime(at, true), level, target, message);
    file.write(line);
    if (echo && options.debug) process.stdout.write(`${line}\n`);
  };
  const write = (level: LogLevel, target: string, message: string): void => writeLine(level, target, message, now(), true);
  const logger = (target: string): Logger => ({
    target,
    error: (m) => write('error', target, m),
    warn: (m) => write('warn', target, m),
    info: (m) => write('info', target, m),
    debug: (m) => write('debug', target, m),
    trace: (m) => write('trace', target, m),
  });

  const consoleLogging = ['1', 'true', 'yes'].includes((env.DSTU_CONSOLE_LOG ?? '').toLowerCase());
  const structuredLog = logger('dstu_platform::debug_logger');
  const structured = new DebugLogger({ logDir, consoleLogging, report: (level, m) => structuredLog[level](m) });
  const debugLog = logger('dstu_platform::debug_log_service');
  const debugLogs = new DebugLogFileService({ logDir, roots: paths.debugLogRoots, report: (level, m) => debugLog[level](m) });

  const crashDir = paths.crashLogDir;
  mkdirSync(crashDir, { recursive: true });
  cleanupOldCrashLogs(crashDir);
  const crashInfo: CrashInfo = { version: options.version, buildNumber: options.buildNumber ?? 'unknown', gitHash: options.gitHash ?? 'unknown' };

  let timer: NodeJS.Timeout | null = null;
  const service: LogServiceHandle = {
    logDir,
    async recordError(event) {
      const record = diagnosticRecord(event);
      await structured.log('ERROR', 'DIAGNOSTIC', record.operation, record);
    },
    queryErrors: (query) => queryDiagnosticErrors(service, query),
    mainLogFile: file.path,
    write,
    writeAt(level, target, message, epochMs) {
      // close() 之后不能让桥接记录重新打开已关闭的主日志。
      if (closed) return;
      writeLine(level, target, message, BigInt(Math.trunc(epochMs)) * 1_000_000n, false);
    },
    logger,
    enabled: (level, target) => levelEnabled(level, target),
    structured,
    debugLogs,
    writeCrashLog: (error) => writeCrashLog(crashDir, error, crashInfo),
    redactSensitiveText,
    redactSensitiveFields,
    sanitizeForLevel: (body: unknown, level: DebugFilterLevel) => sanitizeForLevel(body, level),
    scrubPii: (input) => scrubPii(input, process.platform),
    startPeriodicFlush() {
      if (timer === null) {
        timer = setInterval(() => {
          structured.flush().catch((error) => structuredLog.error(`[DebugLogger] flush task failed: ${String(error)}`));
        }, 5000);
        timer.unref();
      }
      return () => {
        if (timer !== null) clearInterval(timer);
        timer = null;
      };
    },
    async close() {
      closed = true;
      if (timer !== null) clearInterval(timer);
      timer = null;
      await structured.flush();
      await debugLogs.flushPending();
      file.close();
    },
  };
  return service;
}

/** Cordis 插件：`ctx.log`。注册崩溃钩子、周期刷盘与 Cordis logger → 主日志桥接，卸载时撤销。 */
export default definePlugin({
  meta: { id: 'dstu.platform.log', lane: 'F4-security', provides: ['log'], commands: [
    'get_debug_logs_info', 'clear_debug_logs', 'cleanup_old_debug_logs', 'read_debug_log_file', 'ensure_debug_log_dir',
    'save_test_log', 'get_test_logs', 'open_log_file', 'open_logs_folder', 'write_debug_logs', 'report_frontend_log',
    'log_debug_message', 'tauri_lab_frontend_log',
    'export_diagnostics_bundle',
  ] },
  inject: ['paths'],
  apply(ctx: Context) {
    const service = createLogService({ paths: ctx.paths, debug: ctx.app.debug, version: ctx.app.version });
    // F4 SSE/UTF-8 单一实现的日志默认接线：L01/L02 改用平台入口后无需各自注入。
    // 与 Rust tracing 全局 subscriber 同范围（一个 Host 进程一个 logger）；disposer
    // 只清自己的绑定，避免多 Host/测试宿主卸载时误清另一个消费者。
    const unbindSse = setSseBufferLogger(
      (level, message) => service.logger('dstu_util::utils::sse_buffer')[level](message),
    );
    ctx.effect(() => () => unbindSse());
    const stopFlush = service.startPeriodicFlush();
    const onCrash = (error: unknown) => {
      service.writeCrashLog(error);
    };
    const onRejection = (error: unknown) => {
      void service.recordError({ source: 'host', operation: 'host.unhandledRejection', error }).catch(() => {}); // boundary-allow empty-catch: unhandledRejection logger must not cascade rejections
    };
    process.on('unhandledRejection', onRejection);
    process.on('uncaughtExceptionMonitor', onCrash);
    ctx.reflect.provide('log', service);
    registerLogCommands(ctx);
    ctx.inject(['agentTools'], (scope) => {
      if (typeof scope.agentTools?.registerToolExecutors !== 'function') return;
      const registration = scope.agentTools.registerToolExecutors([diagnosticTool('app_diagnostics_query', 'low',
        async args => service.queryErrors(diagnosticQuery(args)))]);
      scope.effect(() => () => registration.dispose());
    });
    ctx.effect(() => async () => {
      process.off('uncaughtExceptionMonitor', onCrash);
      process.off('unhandledRejection', onRejection);
      stopFlush();
      await service.close();
    });
    bridgeCordisLogger(ctx, service);
  },
});
