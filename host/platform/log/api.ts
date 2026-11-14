/**
 * `ctx.log`：应用日志、结构化调试日志、LLM 请求体调试日志与崩溃日志（F4）。
 *
 * 文件位置、文件名、行格式、轮转与 Rust 版一致（前端调试日志命令与用户反馈流程读这些文件）：
 * - 主日志（tauri-plugin-log 2.8.0，`src-tauri/src/lib.rs` 788–807）：
 *   `<appLogDir>/deep-student.log`，行格式 `[YYYY-MM-DD][HH:MM:SS][LEVEL][target] message\n`（本地时区），
 *   10 MiB 轮转为 `deep-student_YYYY-MM-DD_HH-MM-SS.log`，保留 5 份归档 + 当前活跃文件。
 * - 结构化日志（`dstu-platform/src/debug_logger.rs`）：`<appLogDir>/{frontend,backend,debug}/`，
 *   JSON Lines，`<UTC日期>_<module>.log`，10 MiB 时 `.1`…`.5` 轮转，7 天过期清理。
 * - LLM 调试日志（`dstu-platform/src/debug_log_service.rs`）：`<appLogDir>/debug-logs/*.json`。
 * - 崩溃日志（`src-tauri/src/crash_logger.rs`）：`<appLogDir>/crash/crash-<UTC>-pid<pid>.log`，保留 20 份。
 */

/** log crate 的级别（Display 为大写：ERROR/WARN/INFO/DEBUG/TRACE）。 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** 绑定 target 的记录器（target 对应 Rust `module_path!()`，例如 `dstu_storage::database`）。 */
export interface Logger {
  readonly target: string;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  trace(message: string): void;
}

// ------------------------------------------------------------------ 结构化调试日志（DebugLogger）

/** `debug_logger::LogLevel`（serde 为变体名本身，大写）。 */
export type StructuredLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'TRACE';

/** `LogContext`，camelCase；字段缺省按 `null` 序列化（Option 无 skip）。 */
export interface LogContext {
  userId?: string | null;
  sessionId?: string | null;
  mistakeId?: string | null;
  streamId?: string | null;
  businessId?: string | null;
}

/** `LogEntry`（前端 `write_debug_logs` 传入的形状，camelCase）。 */
export interface LogEntry {
  timestamp: string;
  level: StructuredLogLevel;
  module: string;
  operation: string;
  data: unknown;
  context?: LogContext | null;
  stackTrace?: string | null;
}

export interface StructuredLogger {
  /** `DebugLogger::log`：入队；ERROR 级在返回前落盘。 */
  log(level: StructuredLogLevel, module: string, operation: string, data: unknown, context?: LogContext | null): Promise<void>;
  logDatabaseOperation(
    operation: string,
    table: string,
    query: string,
    params?: unknown,
    result?: unknown,
    error?: string | null,
    durationMs?: number | null,
  ): Promise<void>;
  logChatRecordOperation(
    operation: string,
    mistakeId: string,
    chatHistory?: unknown,
    expectedVsActual?: readonly [number, number] | null,
    error?: string | null,
  ): Promise<void>;
  logRagOperation(
    operation: string,
    query?: string | null,
    topK?: number | null,
    sourcesFound?: number | null,
    sourcesReturned?: number | null,
    error?: string | null,
    durationMs?: number | null,
  ): Promise<void>;
  logStreamingOperation(operation: string, streamId: string, eventType: string, payloadSize?: number | null, error?: string | null): Promise<void>;
  logApiCall(
    operation: string,
    method: string,
    url: string,
    requestBody?: unknown,
    responseBody?: unknown,
    statusCode?: number | null,
    error?: string | null,
    durationMs?: number | null,
  ): Promise<void>;
  logStateChange(component: string, operation: string, oldState?: unknown, newState?: unknown, trigger?: string | null): Promise<void>;
  logLlmUsage(
    stage: string,
    provider: string,
    model: string,
    adapter: string,
    requestBytes: number,
    responseBytes: number,
    approxTokensIn: number,
    approxTokensOut: number,
    durationMs?: number | null,
    extra?: unknown,
  ): Promise<void>;
  /** 把队列按 `(日期, module)` 分组写盘。 */
  flush(): Promise<void>;
  /** `write_debug_logs` 命令的实现：最多 500 条/10 MiB，写入 `frontend/<UTC日期>_frontend.log`。 */
  writeFrontendEntries(entries: LogEntry[]): Promise<void>;
}

// ------------------------------------------------------------------ LLM 调试日志（debug-logs）

export type DebugFilterLevel = 'full' | 'standard' | 'compact';

/** `get_debug_logs_info` 的返回值（snake_case，与 Rust 一致）。 */
export interface DebugLogsInfo {
  count: number;
  total_size_bytes: number;
  total_size_display: string;
  oldest_file: string | null;
  newest_file: string | null;
}

export interface DebugLogFiles {
  /** `<logRoot>/debug-logs`（不存在则创建），默认 logRoot = appLogDir。 */
  ensureDir(logRoot?: string): string;
  /** 返回预期文件路径；实际写入异步完成（tmp + rename）。序列化失败返回 null。 */
  writeRequestEntry(logDir: string, tag: string, model: string, url: string, streamEvent: string, requestBody: unknown): string | null;
  writeResponseEntry(logDir: string, tag: string, model: string, streamEvent: string, rawResponse: string): string | null;
  /** 等待已排队的写入完成；10 秒超时返回 false。 */
  flushPending(): Promise<boolean>;
  /** 读写命令使用的根目录集合（当前日志目录 + 旧版数据目录与 slotA/slotB，排序去重）。 */
  roots(): string[];
  info(roots?: string[]): DebugLogsInfo;
  clearAll(roots?: string[]): number;
  cleanupOld(maxAgeDays: number, roots?: string[]): number;
  /** 只允许读取 roots 下 `debug-logs/` 中的 `.json`；违规时以 Rust 的错误文案 reject。 */
  readFile(path: string, roots?: string[]): string;
}

// ------------------------------------------------------------------ 服务

import type { DiagnosticError, DiagnosticQuery, queryDiagnosticErrors } from './incidents.ts';

export interface LogService {
  recordError(event: DiagnosticError): Promise<void>;
  queryErrors(query: DiagnosticQuery): ReturnType<typeof queryDiagnosticErrors>;
  readonly logDir: string;
  /** `<logDir>/deep-student.log`。 */
  readonly mainLogFile: string;
  /** 写一条主日志记录（按级别过滤后同步写入，轮转规则同 tauri-plugin-log）。 */
  write(level: LogLevel, target: string, message: string): void;
  /** 创建绑定 target 的记录器。 */
  logger(target: string): Logger;
  /** target 级别是否启用（全局 Info；lance/lance_encoding/lance_io、h2/hyper/rustls/reqwest/tracing 为 Warn）。 */
  enabled(level: LogLevel, target: string): boolean;

  readonly structured: StructuredLogger;
  readonly debugLogs: DebugLogFiles;

  /** 写崩溃日志（对应 panic hook），返回文件路径。 */
  writeCrashLog(error: unknown): string;

  /** 文本凭据脱敏（`redact_sensitive_text`）。 */
  redactSensitiveText(input: string): string;
  /** JSON 字段级凭据脱敏（`redact_sensitive_fields`）。 */
  redactSensitiveFields(value: unknown): unknown;
  /** 按过滤级别脱敏请求体（`sanitize_for_level`）。 */
  sanitizeForLevel(body: unknown, level: DebugFilterLevel): unknown;
  /** 崩溃/上报用：凭据脱敏 + 用户目录脱敏（`scrub_pii`）。 */
  scrubPii(input: string): string;
}

// 必须引入 Context 才能合并到 cordis 重导出的 Context（而不是新建同名接口）。
import type { Context } from '@deepseek-ai/cordis';
export type { Context };

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** F4：日志。 */
    log: LogService;
  }
}
