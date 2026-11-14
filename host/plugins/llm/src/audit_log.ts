/**
 * 审计日志与调试日志持久化（model2_pipeline.rs log_and_emit_llm_request /
 * log_llm_request_audit + dstu-platform debug_log_service）。
 *
 * 请求体在任何路径都只读取副本：脱敏后的快照用于日志/落盘/前端事件，
 * 原始请求体字节保持不变。
 */
import { join } from '../../../platform/util/path.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';
import type { StreamEventSink } from '../api.ts';
import {
  redactSensitiveText, sanitizeRequestBodyForAudit, sanitizeUrlForLog,
} from './audit.ts';
import { logDebug, logWarn } from './logging.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';

export interface DebugPersistConfig {
  log_dir: string;
}

/** 调试日志落盘用到的 `ctx.files` 操作（移动端同一套接口）。 */
export type DebugLogFiles = Pick<FilesService, 'mkdir' | 'writeAtomic'>;

let debugLogFiles: (() => DebugLogFiles | undefined) | null = null;

/**
 * 插件入口注入 `ctx.files` 查找器。日志写入是尽力而为的后台动作：服务缺席
 * （或移动端没有该能力）时只记警告，不影响业务请求。
 */
export function setDebugLogFiles(lookup: (() => DebugLogFiles | undefined) | null): void {
  debugLogFiles = lookup;
}

function filesOrNull(): DebugLogFiles | null {
  try { return debugLogFiles?.() ?? null; } catch { return null; } // boundary-allow empty-catch: 缺少服务等价于不可落盘。
}

/** 在已登记的写入集合中跟踪一个后台动作，`flushPendingDebugLogWrites` 会等待它。 */
function track(promise: Promise<unknown>): Promise<void> {
  const tracked = promise.then(() => undefined, () => undefined) as Promise<void>;
  pendingWrites.add(tracked);
  void tracked.finally(() => { pendingWrites.delete(tracked); });
  return tracked;
}

/** Rust LLMManager::build_debug_persist_config (model2_pipeline.rs:5095): enabled only when the
 * `debug.persist_logs` setting is exactly "true"; read errors count as disabled. */
export function buildDebugPersistConfig(settings: { get(key: string): string | null },
  log: { debugLogs: { ensureDir(): string } } | undefined, dataDir: string): DebugPersistConfig | null {
  let enabled = false;
  try { enabled = settings.get('debug.persist_logs') === 'true'; } catch { enabled = false; } // boundary-allow empty-catch: Rust `.ok().flatten()`
  if (!enabled) return null;
  if (log !== undefined) return { log_dir: log.debugLogs.ensureDir() };
  // ensure_debug_log_dir(app_data_dir/logs): create_dir_all failure is ignored.
  const dir = join(dataDir, 'logs', 'debug-logs');
  const files = filesOrNull();
  if (files !== null) track(files.mkdir(dir, { recursive: true }));
  return { log_dir: dir };
}

const MAX_DEBUG_LOG_BYTES = 5 * 1024 * 1024;
const FLUSH_TIMEOUT_MS = 10_000;
const pendingWrites = new Set<Promise<void>>();
let sequenceCounter = 0;

function safeComponent(value: string, limit: number): string {
  const replaced = value.replace(/[^A-Za-z0-9._-]/g, '_');
  return [...replaced].slice(0, limit).join('');
}

function safeModelComponent(model: string): string {
  const segments = model.split('/');
  return safeComponent(segments.at(-1) ?? model, 48);
}

function safeTagComponent(tag: string): string {
  return safeComponent(tag, 48);
}

function localTimestamp(date: Date): string {
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  const milliseconds = pad(date.getMilliseconds(), 3);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`
    + `T${pad(date.getHours(), 2)}-${pad(date.getMinutes(), 2)}-${pad(date.getSeconds(), 2)}.${milliseconds}`;
}

function buildEntryFilename(date: Date, model: string, tag: string): [string, number] {
  const sequence = sequenceCounter % 10_000;
  sequenceCounter += 1;
  const modelSafe = safeModelComponent(model);
  const tagSafe = safeTagComponent(tag);
  const filename = `${localTimestamp(date)}_${String(sequence).padStart(4, '0')}_`
    + `${modelSafe === '' ? 'unknown' : modelSafe}_${tagSafe === '' ? 'unknown' : tagSafe}.json`;
  return [filename, sequence];
}

function truncateEntry(entry: Record<string, JsonValue>, serialized: string): string {
  const shortened: Record<string, JsonValue> = {
    ...entry,
    request_body: {
      _truncated: true,
      _original_bytes: utf8ByteLength(serialized),
      _limit_bytes: MAX_DEBUG_LOG_BYTES,
    },
  };
  return JSON.stringify(shortened, null, 2);
}

/**
 * 异步原子写入一条调试日志（tmp + rename），返回预期文件路径。
 * 写入句柄登记到 pending，`flushPendingDebugLogWrites` 可等待落盘完成。
 */
export function writeDebugLogEntry(
  logDir: string,
  tag: string,
  model: string,
  url: string,
  streamEvent: string,
  requestBody: JsonValue,
): string {
  const timestamp = new Date();
  const [filename] = buildEntryFilename(timestamp, model, tag);
  const filePath = join(logDir, filename);
  const entry: Record<string, JsonValue> = {
    version: 1,
    timestamp: toRfc3339(BigInt(timestamp.getTime()) * 1_000_000n, { local: true }),
    tag: redactSensitiveText(tag),
    model: redactSensitiveText(model),
    url: redactSensitiveText(url),
    stream_event: redactSensitiveText(streamEvent),
    request_body: structuredClone(requestBody),
  };
  let json = JSON.stringify(entry, null, 2);
  if (utf8ByteLength(json) > MAX_DEBUG_LOG_BYTES) {
    json = truncateEntry(entry, json);
  }
  const files = filesOrNull();
  if (files === null) {
    logWarn(`[DebugLog] Write skipped (files service unavailable) ${filePath}`);
    return filePath;
  }
  const write = track((async (): Promise<void> => {
    await files.mkdir(logDir, { recursive: true });
    await files.writeAtomic(filePath, json);
  })().catch((error: unknown) => {
    // 写入失败只影响调试日志本身，不影响业务请求（Rust `warn!("[DebugLog] Write failed …")`）。
    logWarn(`[DebugLog] Write failed ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }));
  void write;
  return filePath;
}

/** 等待所有已登记的调试日志写入完成；超时返回 false（Rust 10s 上限）。 */
export async function flushPendingDebugLogWrites(): Promise<boolean> {
  const started = Date.now();
  while (pendingWrites.size > 0) {
    if (Date.now() - started >= FLUSH_TIMEOUT_MS) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return true;
}

/** Rust log_llm_request_audit (model2_pipeline.rs:3897): sanitized audit log plus optional persistence, no event. */
export function logLlmRequestAudit(tag: string, url: string, model: string, body: JsonValue,
  persist: DebugPersistConfig | null): void {
  const sanitized = sanitizeRequestBodyForAudit(body);
  const sanitizedUrl = sanitizeUrlForLog(url);
  logDebug(`[LLM_AUDIT:${tag}] model=${model} url=${sanitizedUrl}\n${JSON.stringify(sanitized, null, 2)}`);
  if (persist !== null) writeDebugLogEntry(persist.log_dir, tag, model, sanitizedUrl, '', sanitized);
}

/** 无窗口 runtime 的空 sink：事件被丢弃，仅保持调用方签名一致。 */
export class NoopStreamSink implements StreamEventSink {
  emit(_channel: string, _payload: unknown): void {
    void _channel;
    void _payload;
  }
}

/**
 * 输出审计日志 + 可选文件持久化，并把 Chat V2 请求体事件推送给前端。
 * 返回落盘路径（未启用持久化时为 null）。
 */
export function logAndEmitLlmRequest(
  tag: string,
  sink: StreamEventSink,
  streamEvent: string,
  messageId: string | null,
  model: string,
  url: string,
  body: JsonValue,
  persistConfig: DebugPersistConfig | null,
): string | null {
  const sanitized = sanitizeRequestBodyForAudit(body);
  const sanitizedUrl = sanitizeUrlForLog(url);
  logDebug(`[LLM_AUDIT:${tag}] model=${model} url=${sanitizedUrl}\n${JSON.stringify(sanitized, null, 2)}`);
  const logFilePath = persistConfig === null
    ? null
    : writeDebugLogEntry(
      persistConfig.log_dir, tag, model, sanitizedUrl, streamEvent, sanitized,
    );

  if (!streamEvent.startsWith('chat_v2_event_')) return logFilePath;

  const payload = {
    streamEvent,
    messageId,
    model,
    url: sanitizedUrl,
    requestBody: sanitized,
    logFilePath,
  };
  try { sink.emit('chat_v2_llm_request_body', payload); }
  catch (error) { logWarn(`[LLM_AUDIT] Failed to emit llm_request_body event: ${error instanceof Error ? error.message : String(error)}`); }
  return logFilePath;
}
