/**
 * 凭据脱敏与调试日志过滤（`dstu-platform/src/debug_log_service.rs` 18–300、`crash_logger.rs::scrub_pii`）。
 *
 * 正则逐条翻译自 Rust `regex`：Rust 的 `\b` 是 Unicode 词边界，JS 为 ASCII 词边界；
 * 只在凭据紧贴非 ASCII 字母时出现差异（见 TESTMAP.md 风险）。
 */
import type { DebugFilterLevel } from './api.ts';
import { charCount, rustTrim, utf8ByteLength } from '../util/portable.ts';

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /([?&](?:key|api_key|token|access_token)=)[^&\s]+/giu,
  /https?:\/\/[^/@\s:]+:[^/@\s]+@/giu,
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----.*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gisu,
  /(?:api[-_ ]?key|x[-_ ]?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|authorization|cookie|password|passwd|client[-_ ]?secret|private[-_ ]?key)\s*[:=]\s*["']?[^"',\s}\]]{4,}/giu,
];

/** `redact_sensitive_text`：依次替换为 `[REDACTED]`（整段匹配，含捕获组）。 */
export function redactSensitiveText(input: string): string {
  let output = input;
  for (const pattern of SECRET_VALUE_PATTERNS) output = output.replace(pattern, '[REDACTED]');
  return output;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Rust `to_ascii_lowercase().replace(['-', '_'], "")`。 */
function normalizeKey(key: string): string {
  return key.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[-_]/g, '');
}

const SECRET_KEYS = new Set([
  'apikey',
  'authorization',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'cookie',
  'setcookie',
  'credential',
  'credentials',
  'password',
  'passwd',
  'secret',
  'secretkey',
  'clientsecret',
  'privatekey',
]);

function isSecretKey(normalized: string): boolean {
  return (
    SECRET_KEYS.has(normalized) ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('token') ||
    normalized.endsWith('password') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('cookie')
  );
}

/** `redact_sensitive_fields`：任何级别都不落盘的凭据字段与文本。 */
export function redactSensitiveFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveFields);
  if (isObject(value)) {
    // serde_json::Map::insert keeps every key as data, including __proto__.
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key, isSecretKey(normalizeKey(key)) ? '[REDACTED]' : redactSensitiveFields(child),
    ]));
  }
  if (typeof value === 'string') return redactSensitiveText(value);
  return value;
}

function redactEmbeddedBinaryValues(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) redactEmbeddedBinaryValues(item);
    return;
  }
  if (!isObject(value)) return;
  for (const key of Object.keys(value)) {
    const child = value[key];
    const normalized = normalizeKey(key);
    const binaryField = ['data', 'url', 'image', 'imageurl', 'inlineimage'].includes(normalized);
    if (binaryField && typeof child === 'string') {
      const trimmed = rustTrim(child);
      const likelyBase64 = trimmed.startsWith('data:') || (utf8ByteLength(trimmed) > 4096 && /^[A-Za-z0-9+/=_-]*$/u.test(trimmed));
      if (likelyBase64) {
        value[key] = { _redacted: true, _type: 'embedded_binary', _original_chars: charCount(child) };
        continue;
      }
    }
    redactEmbeddedBinaryValues(child);
  }
}

function deepClone<T>(value: T): T {
  return structuredClone(value);
}

function sanitizeStandard(body: unknown): unknown {
  const s = deepClone(body);
  redactEmbeddedBinaryValues(s);
  if (isObject(s)) {
    const messages = s.messages;
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (!isObject(message) || !Array.isArray(message.content)) continue;
        for (const part of message.content) {
          if (!isObject(part) || part.type !== 'image_url' || !isObject(part.image_url)) continue;
          const url = part.image_url.url;
          if (typeof url !== 'string' || !url.startsWith('data:')) continue;
          const totalLen = utf8ByteLength(url);
          const comma = url.indexOf(',');
          const base64Len = comma >= 0 ? totalLen - utf8ByteLength(url.slice(0, comma)) - 1 : totalLen;
          const approxBytes = Math.floor((base64Len * 3) / 4);
          part.image_url.url = `[base64 image: ~${Math.floor(approxBytes / 1024)}KB, ${base64Len} chars]`;
        }
      }
    }
    if (Array.isArray(s.tools)) {
      const tools = s.tools;
      const names = tools
        .map((t) => (isObject(t) && isObject(t.function) && typeof t.function.name === 'string' ? t.function.name : null))
        .filter((n): n is string => n !== null);
      s.tools = [{ _summary: `${tools.length} tools: [${names.join(', ')}]` }];
    }
  }
  return s;
}

function sanitizeCompact(body: unknown): unknown {
  const obj: Record<string, unknown> = {};
  if (!isObject(body)) return obj;
  if ('model' in body) obj.model = body.model;
  if ('stream' in body) obj.stream = body.stream;
  if (Array.isArray(body.messages)) {
    obj.messages_summary = body.messages.map((msg) => {
      const m = isObject(msg) ? msg : {};
      const role = typeof m.role === 'string' ? m.role : '?';
      const content = m.content;
      return {
        role,
        content_type: Array.isArray(content) ? 'multimodal' : 'text',
        content_size: typeof content === 'string' ? utf8ByteLength(content) : Array.isArray(content) ? content.length : 0,
      };
    });
  }
  if (Array.isArray(body.tools)) {
    obj.tool_names = body.tools
      .map((t) => (isObject(t) && isObject(t.function) && typeof t.function.name === 'string' ? t.function.name : null))
      .filter((n): n is string => n !== null);
  }
  for (const key of ['temperature', 'max_tokens', 'max_completion_tokens', 'enable_thinking', 'thinking_budget', 'tool_choice']) {
    if (key in body) obj[key] = body[key];
  }
  if ('thinking' in body) obj.thinking = body.thinking;
  return obj;
}

/** `DebugFilterLevel::from_str_lossy`。 */
export function filterLevelFromStrLossy(s: string): DebugFilterLevel {
  const v = s.trim().toLowerCase();
  return v === 'full' ? 'full' : v === 'compact' ? 'compact' : 'standard';
}

/** `sanitize_for_level`。 */
export function sanitizeForLevel(body: unknown, level: DebugFilterLevel): unknown {
  const redacted = redactSensitiveFields(body);
  if (level === 'full') return redacted;
  if (level === 'standard') return sanitizeStandard(redacted);
  return sanitizeCompact(redacted);
}

/**
 * `crash_logger::scrub_pii`：凭据脱敏 + 用户目录名脱敏。`platform` 对应 Rust 的 `cfg!(windows)`
 * （`'win32'` 用 Windows 路径规则，其余用 Unix 规则），由调用方的平台入口给出。
 */
export function scrubPii(input: string, platform: string): string {
  const result = redactSensitiveText(input);
  if (platform === 'win32') return result.replace(/[A-Z]:\\Users\\[^\\]+\\/giu, 'C:\\Users\\<REDACTED>\\');
  return result.replace(/\/(?:home|Users)\/[^/]+\//gu, '/<REDACTED>/');
}

export type { Json };
