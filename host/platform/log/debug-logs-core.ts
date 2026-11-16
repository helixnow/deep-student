/**
 * Portable debug-log formatting, naming, redaction, and path confinement helpers.
 * Zero `node:*` dependencies — shared between desktop `debug-logs.ts` and mobile `log/mobile.ts`.
 */
import { redactSensitiveFields, redactSensitiveText } from './redact.ts';
import { chronoRfc3339, chronoStamp, civilTime, nowEpochNanos } from '../time/index.ts';
import { charCount, utf8ByteLength } from '../util/portable.ts';

export const DEBUG_LOGS_DIR = 'debug-logs';
export const MAX_DEBUG_LOG_BYTES = 5 * 1024 * 1024;
export const AUTO_CLEANUP_THRESHOLD = 500;
export const FLUSH_TIMEOUT_MS = 10_000;

/** `safe_model_component`：取最后一个 `/` 段，Unicode 字母数字与 `-_.` 保留，其余 `_`，最多 80 字符。 */
export function safeModelComponent(model: string): string {
  const short = model.split('/').pop() ?? model;
  let out = '';
  let i = 0;
  for (const ch of short) {
    if (i++ >= 80) break;
    out += /^[\p{Alphabetic}\p{N}]$/u.test(ch) || ch === '-' || ch === '_' || ch === '.' ? ch : '_';
  }
  return out;
}

/** `safe_tag_component`：ASCII 字母数字与 `-_`。 */
export function safeTagComponent(tag: string): string {
  let out = '';
  let i = 0;
  for (const ch of tag) {
    if (i++ >= 80) break;
    out += /^[A-Za-z0-9_-]$/.test(ch) ? ch : '_';
  }
  return out;
}

/** `format_size`：f64 除以 2 的幂是精确值，按 Rust `{:.N}`（四舍六入五成双）格式化。 */
export function formatSize(bytes: number): string {
  const fmt = (divisor: bigint, digits: number) => {
    const scale = 10n ** BigInt(digits);
    const num = BigInt(bytes) * scale;
    let q = num / divisor;
    const r = num % divisor;
    if (r * 2n > divisor || (r * 2n === divisor && q % 2n === 1n)) q += 1n;
    const s = q.toString().padStart(digits + 1, '0');
    return `${s.slice(0, -digits)}.${s.slice(-digits)}`;
  };
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${fmt(1024n, 1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${fmt(1024n * 1024n, 1)} MB`;
  return `${fmt(1024n * 1024n * 1024n, 2)} GB`;
}

export function buildDebugLogFilename(model: string, tag: string, rawSeq: number): { filename: string; seq: number; timestamp: string } {
  const now = nowEpochNanos();
  const time = chronoStamp(civilTime(now, true), '-', true);
  const seq = rawSeq % 10000;
  const m = safeModelComponent(model);
  const t = safeTagComponent(tag);
  return {
    filename: `${time}_${String(seq).padStart(4, '0')}_${m === '' ? 'unknown' : m}_${t === '' ? 'unknown' : t}.json`,
    seq,
    timestamp: chronoRfc3339(now, true),
  };
}

export function serializeDebugLogEntry(full: Record<string, unknown>, truncatedKey: string, reason: string): string {
  const json = JSON.stringify(full, null, 2);
  const size = utf8ByteLength(json);
  if (size <= MAX_DEBUG_LOG_BYTES) return json;
  const truncated: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) {
    truncated[k] = k === truncatedKey ? { _truncated: true, _reason: reason, _serialized_bytes: size } : v;
  }
  return JSON.stringify(truncated, null, 2);
}

export function buildRequestDebugEntry(
  timestamp: string,
  tag: string,
  model: string,
  url: string,
  streamEvent: string,
  requestBody: unknown,
): string {
  const entry = {
    version: 1,
    timestamp,
    tag: redactSensitiveText(tag),
    model: redactSensitiveText(model),
    url: redactSensitiveText(url),
    stream_event: redactSensitiveText(streamEvent),
    request_body: redactSensitiveFields(requestBody) ?? null,
  };
  return serializeDebugLogEntry(entry, 'request_body', 'request log exceeded 5 MiB');
}

export function buildResponseDebugEntry(
  timestamp: string,
  tag: string,
  model: string,
  streamEvent: string,
  rawResponse: string,
): string {
  const entry = {
    version: 1,
    timestamp,
    tag: redactSensitiveText(tag),
    model: redactSensitiveText(model),
    stream_event: redactSensitiveText(streamEvent),
    raw_response_chars: charCount(rawResponse),
    raw_response: redactSensitiveText(rawResponse),
  };
  return serializeDebugLogEntry(entry, 'raw_response', 'response log exceeded 5 MiB');
}

/** `Path::starts_with`：按组件比较。 */
export function pathStartsWith(path: string, prefix: string, win32 = false): boolean {
  const separators = win32 ? /[\\/]+/ : /\/+/;
  const a = path.split(separators).filter(Boolean);
  const b = prefix.split(separators).filter(Boolean);
  return b.length <= a.length && b.every((c, i) => a[i] === c);
}
