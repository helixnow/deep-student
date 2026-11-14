/**
 * 结构化调试日志（`dstu-platform/src/debug_logger.rs`）。
 *
 * - 目录：`<logDir>/{frontend,backend,debug}`；构造时创建并清理 7 天以上的文件。
 * - 记录：`LogEntry` 的 serde JSON（camelCase）一行一条。
 * - 分组：`<UTC 日期>_<safe(module)>`；module 以 `frontend` 开头进 frontend/，否则 backend/。
 * - 轮转：写入后超过 10 MiB 时 `.log` → `.log.1` … `.log.5`。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LogContext, LogEntry, StructuredLogLevel, StructuredLogger } from './api.ts';
import { redactSensitiveFields, redactSensitiveText } from './redact.ts';
import { takeChars } from '../util/index.ts';
import { chronoRfc3339, civilTime, nowEpochNanos, ymd } from '../time/index.ts';

const MAX_LOG_AGE_SECS = 7 * 86400;
const MAX_LOG_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const MAX_ROTATED_FILES = 5;
const MAX_ENTRY_DATA_BYTES = 256 * 1024;
const FRONTEND_BATCH_LIMIT_BYTES = 10 * 1024 * 1024;

export interface StructuredLoggerOptions {
  logDir: string;
  /** 内部错误输出（对应 Rust `tracing::error!`），写入主日志。 */
  report: (level: 'error' | 'info' | 'warn', message: string) => void;
  /** `DSTU_CONSOLE_LOG` 为 1/true/yes 时把条目同时写主日志。 */
  consoleLogging?: boolean;
  unix?: boolean;
}

function boundedText(value: string, maxChars: number): string {
  return takeChars(redactSensitiveText(value), maxChars);
}

function safeFileComponent(value: string): string {
  let out = '';
  let i = 0;
  for (const ch of value) {
    if (i++ >= 80) break;
    out += /^[A-Za-z0-9_-]$/.test(ch) ? ch.toLowerCase() : '_';
  }
  return out === '' ? 'unknown' : out;
}

function boundedContext(context: LogContext | null | undefined): LogContext | null {
  if (context === null || context === undefined) return null;
  const b = (v: string | null | undefined) => (v === null || v === undefined ? null : boundedText(v, 256));
  return {
    userId: b(context.userId),
    sessionId: b(context.sessionId),
    mistakeId: b(context.mistakeId),
    streamId: b(context.streamId),
    businessId: b(context.businessId),
  };
}

/** serde 字段顺序：timestamp, level, module, operation, data, context, stackTrace。 */
function serializeEntry(entry: LogEntry): string {
  const ctx = entry.context === null || entry.context === undefined ? null : boundedOrder(entry.context);
  return JSON.stringify({
    timestamp: entry.timestamp,
    level: entry.level,
    module: entry.module,
    operation: entry.operation,
    data: entry.data === undefined ? null : entry.data,
    context: ctx,
    stackTrace: entry.stackTrace ?? null,
  });
}

function boundedOrder(c: LogContext): LogContext {
  return {
    userId: c.userId ?? null,
    sessionId: c.sessionId ?? null,
    mistakeId: c.mistakeId ?? null,
    streamId: c.streamId ?? null,
    businessId: c.businessId ?? null,
  };
}

function boundData(data: unknown): unknown {
  const redacted = redactSensitiveFields(data);
  return Buffer.byteLength(JSON.stringify(redacted ?? null), 'utf8') > MAX_ENTRY_DATA_BYTES
    ? { _truncated: true, _reason: 'entry exceeded 256 KiB' }
    : redacted;
}

function rotatedPath(filePath: string, index: number): string {
  return `${filePath}.${index}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    // serde_json::Value 的对象相等不看键序。
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && jsonEqual(a[k], b[k]));
  }
  return false;
}

export class DebugLogger implements StructuredLogger {
  private queue: LogEntry[] = [];
  private writing: Promise<void> = Promise.resolve();
  private readonly unix: boolean;

  private readonly options: StructuredLoggerOptions;

  constructor(options: StructuredLoggerOptions) {
    this.options = options;
    this.unix = options.unix ?? process.platform !== 'win32';
    for (const sub of ['frontend', 'backend', 'debug']) {
      try {
        mkdirSync(join(options.logDir, sub), { recursive: true });
      } catch (error) {
        options.report('error', `Failed to create ${sub} log directory: ${String(error)}`);
      }
    }
    this.cleanupOldLogs();
  }

  private cleanupOldLogs(): void {
    let removedCount = 0;
    let removedBytes = 0;
    const now = Date.now();
    for (const sub of ['frontend', 'backend', 'debug']) {
      const dir = join(this.options.logDir, sub);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        // Rust `read_dir` 失败时 `continue`。
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        let st;
        try {
          st = statSync(path);
        } catch {
          // metadata 失败 → should_remove = false。
          continue;
        }
        if (!st.isFile()) continue;
        if ((now - st.mtimeMs) / 1000 > MAX_LOG_AGE_SECS) {
          removedBytes += st.size;
          try {
            unlinkSync(path);
            removedCount++;
          } catch (error) {
            this.options.report('warn', `[DebugLogger] remove ${path} failed: ${String(error)}`);
          }
        }
      }
    }
    if (removedCount > 0) {
      this.options.report('info', `[DebugLogger] Cleaned up ${removedCount} old log files (${(removedBytes / (1024 * 1024)).toFixed(1)} MB)`);
    }
  }

  async log(level: StructuredLogLevel, module: string, operation: string, data: unknown, context?: LogContext | null): Promise<void> {
    const entry: LogEntry = {
      timestamp: chronoRfc3339(),
      level,
      module: boundedText(module, 128),
      operation: boundedText(operation, 256),
      data: boundData(data),
      context: boundedContext(context),
      stackTrace: null,
    };
    this.queue.push(entry);
    if (level === 'ERROR') await this.flush();
    if (this.options.consoleLogging) {
      const mapped = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'info';
      this.options.report(mapped, `[${module}] [${operation}] ${entry.timestamp}: ${JSON.stringify(entry.data)}`);
    }
  }

  logDatabaseOperation(operation: string, table: string, query: string, params?: unknown, result?: unknown, error?: string | null, durationMs?: number | null) {
    const data = {
      table,
      query,
      params: params ?? null,
      result: sanitizeDatabaseResult(result),
      error: error ?? null,
      duration_ms: durationMs ?? null,
    };
    return this.log(error != null ? 'ERROR' : 'DEBUG', 'DATABASE', operation, data, null);
  }

  logChatRecordOperation(operation: string, mistakeId: string, chatHistory?: unknown, expectedVsActual?: readonly [number, number] | null, error?: string | null) {
    const data = {
      mistake_id: mistakeId,
      chat_history_length: Array.isArray(chatHistory) ? chatHistory.length : null,
      chat_history: sanitizeChatHistory(chatHistory),
      expected_vs_actual: expectedVsActual ? [expectedVsActual[0], expectedVsActual[1]] : null,
      error: error ?? null,
      timestamp: chronoRfc3339(),
    };
    const context: LogContext = { userId: null, sessionId: null, mistakeId, streamId: null, businessId: mistakeId };
    return this.log(error != null ? 'ERROR' : 'INFO', 'CHAT_RECORD', operation, data, context);
  }

  logRagOperation(operation: string, query?: string | null, topK?: number | null, sourcesFound?: number | null, sourcesReturned?: number | null, error?: string | null, durationMs?: number | null) {
    const data = {
      query_length: query == null ? null : [...query].length,
      top_k: topK ?? null,
      sources_found: sourcesFound ?? null,
      sources_returned: sourcesReturned ?? null,
      error: error ?? null,
      duration_ms: durationMs ?? null,
      sources_missing: sourcesFound != null && sourcesReturned != null ? Math.max(0, sourcesFound - sourcesReturned) : null,
    };
    return this.log(error != null ? 'ERROR' : 'INFO', 'RAG', operation, data, null);
  }

  logStreamingOperation(operation: string, streamId: string, eventType: string, payloadSize?: number | null, error?: string | null) {
    const data = { stream_id: streamId, event_type: eventType, payload_size: payloadSize ?? null, error: error ?? null, timestamp: chronoRfc3339() };
    const context: LogContext = { userId: null, sessionId: null, mistakeId: null, streamId, businessId: null };
    return this.log(error != null ? 'ERROR' : 'DEBUG', 'STREAMING', operation, data, context);
  }

  logApiCall(operation: string, method: string, url: string, requestBody?: unknown, responseBody?: unknown, statusCode?: number | null, error?: string | null, durationMs?: number | null) {
    const level: StructuredLogLevel = error != null || (statusCode != null && statusCode >= 400) ? 'ERROR' : 'INFO';
    const data = {
      method,
      url: sanitizeApiUrl(url),
      request_body: sanitizeApiBody(requestBody),
      response_body: sanitizeApiBody(responseBody),
      status_code: statusCode ?? null,
      error: error ?? null,
      duration_ms: durationMs ?? null,
    };
    return this.log(level, 'API', operation, data, null);
  }

  logStateChange(component: string, operation: string, oldState?: unknown, newState?: unknown, trigger?: string | null) {
    const data = {
      component,
      old_state: sanitizeState(oldState),
      new_state: sanitizeState(newState),
      state_diff: calculateStateDiff(oldState, newState),
      trigger: trigger ?? null,
    };
    return this.log('TRACE', 'STATE_CHANGE', operation, data, null);
  }

  logLlmUsage(stage: string, provider: string, model: string, adapter: string, requestBytes: number, responseBytes: number, approxTokensIn: number, approxTokensOut: number, durationMs?: number | null, extra?: unknown) {
    const data = {
      stage,
      provider,
      model,
      adapter,
      request_bytes: requestBytes,
      response_bytes: responseBytes,
      approx_tokens_in: approxTokensIn,
      approx_tokens_out: approxTokensOut,
      duration_ms: durationMs ?? null,
      extra: extra ?? null,
    };
    return this.log('INFO', 'LLM_USAGE', 'usage', data, null);
  }

  /** 写盘串行化（对应 `write_lock`）。 */
  private serialized<T>(fn: () => T): Promise<T> {
    const run = this.writing.then(fn);
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  flush(): Promise<void> {
    return this.serialized(() => this.flushSync());
  }

  private flushSync(): void {
    if (this.queue.length === 0) return;
    const logs = this.queue;
    this.queue = [];
    const grouped = new Map<string, { dir: string; key: string; logs: LogEntry[] }>();
    for (const log of logs) {
      const date = log.timestamp.split('T')[0] ?? 'unknown';
      const moduleKey = safeFileComponent(log.module);
      const dir = moduleKey.startsWith('frontend') ? 'frontend' : 'backend';
      const key = `${date}_${moduleKey}`;
      const id = `${dir}\u0000${key}`;
      let group = grouped.get(id);
      if (!group) grouped.set(id, (group = { dir, key, logs: [] }));
      group.logs.push(log);
    }
    for (const group of grouped.values()) {
      const filePath = join(this.options.logDir, group.dir, `${group.key}.log`);
      try {
        this.writeLogsToFile(filePath, group.logs);
      } catch (error) {
        this.options.report('error', `Failed to write logs to ${filePath}: ${String(error)}`);
        this.queue.push(...group.logs);
      }
    }
  }

  writeFrontendEntries(entries: LogEntry[]): Promise<void> {
    return this.serialized(() => {
      const normalized: LogEntry[] = [];
      let accepted = 0;
      const offered = entries.length;
      for (const raw of entries.slice().reverse().slice(0, 500)) {
        const log: LogEntry = {
          timestamp: boundedText(raw.timestamp, 64),
          level: raw.level,
          module: boundedText(raw.module, 128),
          operation: boundedText(raw.operation, 256),
          data: boundData(raw.data),
          context: boundedContext(raw.context),
          stackTrace: raw.stackTrace === null || raw.stackTrace === undefined ? null : boundedText(raw.stackTrace, 64_000),
        };
        const bytes = Buffer.byteLength(serializeEntry(log), 'utf8');
        if (accepted + bytes > FRONTEND_BATCH_LIMIT_BYTES) break;
        accepted += bytes;
        normalized.push(log);
      }
      normalized.reverse();
      if (normalized.length < offered) {
        normalized.unshift({
          timestamp: chronoRfc3339(),
          level: 'WARN',
          module: 'FRONTEND',
          operation: 'LOG_BATCH_TRUNCATED',
          data: { offered_count: offered, persisted_count: normalized.length, limit_bytes: FRONTEND_BATCH_LIMIT_BYTES },
          context: null,
          stackTrace: null,
        });
      }
      if (normalized.length === 0) return;
      const date = ymd(civilTime(nowEpochNanos(), false));
      this.writeLogsToFile(join(this.options.logDir, 'frontend', `${date}_frontend.log`), normalized);
    });
  }

  private writeLogsToFile(filePath: string, logs: LogEntry[]): void {
    mkdirSync(dirname(filePath), { recursive: true });
    let payload = '';
    for (const log of logs) payload += serializeEntry(log) + '\n';
    this.rotateIfNeeded(filePath, Buffer.byteLength(payload, 'utf8'));
    appendFileSync(filePath, payload, { mode: 0o600, flush: true });
    if (this.unix) chmodSync(filePath, 0o600);
  }

  private rotateIfNeeded(filePath: string, incoming: number): void {
    let current = 0;
    try {
      current = statSync(filePath).size;
    } catch {
      // `fs::metadata(..).unwrap_or(0)`：文件不存在按 0 处理。
      current = 0;
    }
    if (current === 0 || current + incoming <= MAX_LOG_FILE_SIZE_BYTES) return;
    for (let index = MAX_ROTATED_FILES; index >= 1; index--) {
      const source = index === 1 ? filePath : rotatedPath(filePath, index - 1);
      const destination = rotatedPath(filePath, index);
      if (!existsSync(source)) continue;
      if (existsSync(destination)) rmSync(destination);
      renameSync(source, destination);
    }
  }
}

function sanitizeDatabaseResult(result: unknown): unknown {
  if (result === undefined || result === null) return null;
  if (Array.isArray(result) && result.length > 10) return { _truncated: true, _count: result.length, _preview: result.slice(0, 5) };
  return result;
}

function sanitizeChatHistory(chatHistory: unknown): unknown {
  if (!Array.isArray(chatHistory)) return null;
  return {
    _redacted: true,
    _count: chatHistory.length,
    messages: chatHistory.map((message) => {
      const m = isObject(message) ? message : {};
      return {
        role: typeof m.role === 'string' ? m.role : 'unknown',
        content_size: 'content' in m ? [...JSON.stringify(m.content ?? null)].length : 0,
        has_tool_calls: 'tool_calls' in m,
        has_tool_result: 'tool_result' in m,
      };
    }),
  };
}

/** `sanitize_api_url`（url crate 的 WHATWG 解析与 `form_urlencoded` 重编码）。 */
export function sanitizeApiUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return '[unparseable URL redacted]';
  }
  parsed.username = '';
  parsed.password = '';
  const pairs = [...parsed.searchParams.entries()];
  if (pairs.length > 0) {
    const sp = new URLSearchParams();
    for (const [name, value] of pairs) {
      const n = name.toLowerCase();
      const sensitive =
        n.includes('key') || n.includes('token') || n.includes('secret') || n.includes('signature') || n.includes('credential') || n.includes('auth') || n === 'code' || n === 'sig';
      sp.append(name, sensitive ? '[REDACTED]' : value);
    }
    parsed.search = sp.toString();
  }
  return parsed.toString();
}

function sanitizeApiBody(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  const size = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (!isObject(body)) return { _redacted: true, _type: Array.isArray(body) ? 'array' : 'scalar', _size: size };
  const summary: Record<string, unknown> = { _redacted: true, _size: size, _keys: Object.keys(body) };
  for (const key of ['model', 'stream', 'max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    if (key in body) summary[key] = body[key];
  }
  for (const key of ['messages', 'input', 'contents', 'tools', 'output']) {
    if (!(key in body)) continue;
    const content = body[key];
    summary[`${key}_count`] = Array.isArray(content) ? content.length : isObject(content) ? Object.keys(content).length : 1;
  }
  if (isObject(body.error)) {
    const error = body.error;
    summary.error_type = 'type' in error ? error.type : 'code' in error ? error.code : null;
  }
  return summary;
}

function sanitizeState(state: unknown): unknown {
  if (state === undefined || state === null) return null;
  if (!isObject(state)) return state;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key === 'chatHistory' || key === 'thinkingContent') {
      out[key] = Array.isArray(value) ? { _type: 'array', _length: value.length } : { _type: 'object', _size: Buffer.byteLength(JSON.stringify(value), 'utf8') };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function calculateStateDiff(oldState: unknown, newState: unknown): unknown {
  const o = oldState ?? null;
  const n = newState ?? null;
  if (o !== null && n !== null) {
    if (isObject(o) && isObject(n)) {
      const diff: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(o), ...Object.keys(n)])) {
        const a = key in o ? o[key] : undefined;
        const b = key in n ? n[key] : undefined;
        const same = a === undefined || b === undefined ? a === b : jsonEqual(a, b);
        if (!same) diff[key] = { from: a ?? null, to: b ?? null };
      }
      return diff;
    }
    return { changed: !jsonEqual(o, n), from: o, to: n };
  }
  return { from: o, to: n };
}
