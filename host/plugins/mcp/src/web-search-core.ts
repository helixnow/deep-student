// Pure types, error mapping, text/URL helpers and inject text for web_search.
import type { JsonValue, RagSourceInfo, SearchInput, SearchResult } from '../api.ts';
import { f32ToJsonNumber, rustTrim } from '../../../platform/util/portable.ts';
import { parseSerdeJson } from './serde-json.ts';

export type { SearchInput };

export const TOOL_NAME = 'web_search';
export const DEFAULT_TOP_K = 5;

export type ErrorCode = 'CONFIG_MISSING' | 'HTTP_CLIENT_ERROR' | 'HTTP_SERVER_ERROR' | 'TIMEOUT'
  | 'RATE_LIMIT' | 'UNREACHABLE' | 'PARSE_ERROR' | 'UNKNOWN';
export interface StandardError { code: ErrorCode; message: string; suggestion: string; trace_id?: string }
export interface SearchItem { title: string; url: string; snippet: string; rank: number; score_hint: number | null }
export interface ProviderResponse { items: SearchItem[]; raw: JsonValue; provider: string }
export interface Usage { elapsed_ms: number; retries?: number; provider_latency_ms?: number; provider?: string }

export type ToolErrorKind = 'http' | 'config' | 'provider' | 'unknown';
export class ToolError extends Error {
  readonly kind: ToolErrorKind;
  readonly status: number | null;
  constructor(kind: ToolErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'ToolError';
    this.kind = kind;
    this.status = status;
  }
  override toString(): string {
    return `${this.kind} error: ${this.message}`;
  }
}

const STATUS_PHRASES: Record<number, string> = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non Authoritative Information', 204: 'No Content',
  205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status', 208: 'Already Reported', 226: 'IM Used',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified',
  305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout',
  409: 'Conflict', 410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed', 413: 'Payload Too Large',
  414: 'URI Too Long', 415: 'Unsupported Media Type', 416: 'Range Not Satisfiable', 417: 'Expectation Failed',
  418: "I'm a teapot", 421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked',
  424: 'Failed Dependency', 425: 'Too Early', 426: 'Upgrade Required', 428: 'Precondition Required',
  429: 'Too Many Requests', 431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not ' + 'Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout', 505: 'HTTP Version Not Supported', 506: 'Variant Also Negotiates',
  507: 'Insufficient Storage', 508: 'Loop Detected', 510: 'Not Extended', 511: 'Network Authentication Required',
};
export function statusDisplay(status: number): string {
  return `${status} ${STATUS_PHRASES[status] ?? '<unknown status code>'}`;
}
export function isSuccess(status: number): boolean { return status >= 200 && status < 300; }
export function isClientError(status: number): boolean { return status >= 400 && status < 500; }

export function objectOf(value: unknown): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, JsonValue> : null;
}
export function arrayOf(value: unknown): JsonValue[] | null { return Array.isArray(value) ? value as JsonValue[] : null; }
export function str(value: unknown): string | null { return typeof value === 'string' ? value : null; }
export function pointer(value: unknown, path: string): JsonValue | undefined {
  let current: unknown = value;
  for (const part of path.split('/').filter(Boolean)) {
    const obj = objectOf(current);
    if (obj === null || !Object.hasOwn(obj, part)) return undefined;
    current = obj[part];
  }
  return current as JsonValue;
}
/** `serde_json::from_str::<Value>(&body).ok()`. */
export function jsonOrNull(text: string): JsonValue | null {
  const decoded = parseSerdeJson(text);
  return decoded.ok ? decoded.value : null;
}
export function textChars(text: string, max: number): string { return [...text].slice(0, max).join(''); }

export function redactUrlSecrets(text: string): string {
  return text.replace(/\b(key|api_key|apikey|api-key|token|access_token|secret)=[^&\s)\]”）；'"\u201D\uFF09]+/giu, '$1=[REDACTED]');
}

export function classifyError(errorMessage: string, traceId: string | null = null): StandardError {
  const lower = errorMessage.toLowerCase();
  let code: ErrorCode;
  let suggestion: string;
  if (lower.includes('api key') || lower.includes('unauthorized') || lower.includes('invalid key')) {
    code = 'CONFIG_MISSING';
    suggestion = 'Please configure the correct API key in Settings / 请到设置页面配置正确的API密钥';
  } else if (lower.includes('timeout') || lower.includes('timed out')) {
    code = 'TIMEOUT';
    suggestion = 'Network timeout, check connection or retry later / 网络超时，请检查网络连接或稍后重试';
  } else if (lower.includes('rate limit') || lower.includes('too many requests')) {
    code = 'RATE_LIMIT';
    suggestion = 'Too many requests, please retry later / 请求频率过高，请稍后重试';
  } else if (lower.includes('connection') || lower.includes('unreachable') || lower.includes('dns')) {
    code = 'UNREACHABLE';
    suggestion = 'Connection failed, check network / 网络连接失败，请检查网络连接';
  } else if (lower.includes('parse') || lower.includes('decode') || lower.includes('invalid json')) {
    code = 'PARSE_ERROR';
    suggestion = 'Failed to parse response / 响应解析失败，可能是服务端问题';
  } else if (lower.includes('4') && (lower.includes('client error') || lower.includes('bad request'))) {
    code = 'HTTP_CLIENT_ERROR';
    suggestion = 'Bad request, check configuration / 请求参数错误，请检查配置';
  } else if (lower.includes('5') && (lower.includes('server error') || lower.includes('internal'))) {
    code = 'HTTP_SERVER_ERROR';
    suggestion = 'Server error, retry later / 服务端错误，请稍后重试';
  } else {
    code = 'UNKNOWN';
    suggestion = 'Unknown error, see details / 未知错误，请查看详细信息';
  }
  const details: StandardError = { code, message: errorMessage, suggestion };
  if (traceId !== null) details.trace_id = traceId;
  return details;
}

export function errorResult(args: SearchInput | null, message: string, elapsedMs: number): SearchResult {
  return {
    name: TOOL_NAME, ok: false, ...(args === null ? {} : { args }),
    error: message, error_details: classifyError(message),
    usage: { elapsed_ms: elapsedMs },
  };
}
export function toolErrorResult(args: SearchInput | null, error: ToolError, elapsedMs: number): SearchResult {
  const message = redactUrlSecrets(error.toString());
  return {
    name: TOOL_NAME, ok: false, ...(args === null ? {} : { args }),
    error: { message }, error_details: classifyError(message),
    usage: { elapsed_ms: elapsedMs },
  };
}

export interface RetryConfig { max_attempts: number; initial_delay_ms: number }
export interface SpecialHandling { handle_429_retry_after: boolean; exponential_backoff_on_5xx: boolean }
export interface ProviderStrategy {
  timeout_ms?: number | null;
  max_retries?: number | null;
  initial_retry_delay_ms?: number | null;
  max_retry_delay_ms?: number | null;
  backoff_multiplier?: number | null;
  max_concurrent_requests?: number | null;
  rate_limit_per_minute?: number | null;
  cache_enabled?: boolean | null;
  cache_ttl_seconds?: number | null;
  cache_max_entries?: number | null;
  special_handling?: SpecialHandling | null;
}
export interface ProviderStrategies {
  default: ProviderStrategy;
  bing_rss?: ProviderStrategy | null;
  google_cse?: ProviderStrategy | null;
  serpapi?: ProviderStrategy | null;
  tavily?: ProviderStrategy | null;
  brave?: ProviderStrategy | null;
  searxng?: ProviderStrategy | null;
  zhipu?: ProviderStrategy | null;
  bocha?: ProviderStrategy | null;
  deepseek?: ProviderStrategy | null;
}


export interface ProviderKeys {
  google_cse: string | null;
  google_cse_cx: string | null;
  serpapi: string | null;
  tavily: string | null;
  brave: string | null;
  searxng_endpoint: string | null;
  searxng: string | null;
  zhipu: string | null;
  bocha: string | null;
  deepseek: string | null;
}

export interface RerankerConfig { enabled: boolean; model_id: string | null; top_k: number | null }
export interface CnWhitelistConfig { enabled: boolean; use_default_list: boolean; custom_sites: string[] | null }
export interface ToolConfig {
  default_engine: string | null;
  timeout_ms: number | null;
  timeout_ms_overridden: boolean;
  retry: RetryConfig | null;
  site_whitelist: string[] | null;
  site_blacklist: string[] | null;
  inject_snippet_max_chars: number | null;
  inject_total_max_chars: number | null;
  reranker: RerankerConfig | null;
  cn_whitelist: CnWhitelistConfig | null;
  provider_strategies: ProviderStrategies | null;
  provider_strategies_overridden: boolean;
  tavily_search_depth: string | null;
  deepseek_need_content: boolean | null;
  keys: ProviderKeys;
}

// =============================
// Pure helpers
// =============================

const STRIP_QUERY_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];

export function normalizeUrl(input: string): string {
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { return input; }
  const rawQuery = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
  if (parsed.search !== '') {
    const pairs: [string, string][] = [];
    for (const [key, value] of new URLSearchParams(rawQuery)) pairs.push([key, value]);
    const kept = pairs.filter(([key]) => !STRIP_QUERY_KEYS.includes(key));
    const query = kept.map(([key, value]) => `${encodeQueryPart(key)}=${encodeQueryPart(value)}`).join('&');
    parsed.search = kept.length ? `?${query}` : '';
  }
  return parsed.toString();
}
function encodeQueryPart(value: string): string {
  if (!/[^A-Za-z0-9\-._~]/u.test(value)) return value;
  return [...Buffer.from(value, 'utf8')].map(byte => {
    const ch = String.fromCharCode(byte);
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}
/** `url::Url::host_str()`: the bare host without its port; `null` when the URL has none. */
export function urlHost(url: string): string | null {
  try { return new URL(url).hostname || null; }
  catch { return null; }
}
export function hostAsFileName(url: string): string {
  return urlHost(url) ?? 'unknown';
}
/** `normalize_score` returns `f32`; the arithmetic is done in f32 too. */
export function normalizeScore(rank: number, topK: number): number {
  if (topK === 0) return 0;
  const r = Math.fround(rank);
  const k = Math.fround(topK);
  return Math.min(Math.max(Math.fround(Math.fround(Math.fround(k + 1) - r) / k), 0), 1);
}
/**
 * An `f32` score as JSON: the shortest round-trip decimal, which is what serde_json prints for `f32`
 * (and for `json!(f32)`, since dstu-mcp enables `arbitrary_precision`). Idempotent.
 */
export function f32ScoreJson(score: number): number {
  return f32ToJsonNumber(score) ?? Math.fround(score);
}
/** `RagSourceInfo` built from a standardized item (web_search.rs:3350-3378, mod.rs:1317-1346). */
export function citationOf(item: SearchItem, index: number): RagSourceInfo {
  const fileName = rustTrim(item.title) === '' ? hostAsFileName(item.url) : item.title;
  const score = Math.min(Math.max(item.score_hint ?? 0, 0), 1);
  const normalized = normalizeUrl(item.url);
  const chunkText = rustTrim(item.snippet) === ''
    ? `${item.title}\n${normalized}` : `${item.title} — ${item.snippet}\n${normalized}`;
  return {
    documentId: normalized, fileName, chunkText, score: f32ScoreJson(score), chunkIndex: index,
    sourceType: 'search',
  };
}
export function truncate(value: string, maxChars: number): [string, boolean] {
  const chars = [...value];
  return chars.length <= maxChars ? [value, false] : [chars.slice(0, maxChars).join(''), true];
}
export function stripHtml(value: string): string { return value.replace(/<[^>]+>/gis, ''); }
export function htmlUnescape(value: string): string {
  return value.trim()
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}
export function xmlUnescape(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return safeCodePoint(code, match);
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return safeCodePoint(code, match);
    }
    return match;
  });
}
function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try { return String.fromCodePoint(code); } catch { return fallback; }
}

function isDateYmd(value: string): boolean {
  return value.length === 10 && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value);
}
export function normalizeCustomDateRange(range: string): string | null {
  const cleaned = range.trim().replace(/ /g, '').toLowerCase();
  const parts = cleaned.split('to');
  if (parts.length >= 2 && isDateYmd(parts[0] ?? '') && isDateYmd(parts.slice(1).join('to'))) {
    return `${parts[0]}to${parts.slice(1).join('to')}`;
  }
  return null;
}
export function normalizeTimeRangeKey(range: string | null): string {
  if (range === null) return '';
  const trimmed = range.trim();
  if (trimmed === '') return '';
  return normalizeCustomDateRange(trimmed) ?? trimmed.toLowerCase();
}

// =============================
// Inject text
// =============================

function deepseekResultsArray(raw: JsonValue): JsonValue[] | null {
  const direct = arrayOf(pointer(raw, 'results'));
  if (direct !== null) return direct;
  return arrayOf(pointer(raw, 'raw/results'));
}
function deepseekContentByUrl(raw: JsonValue): Map<string, string> {
  const contents = new Map<string, string>();
  const results = deepseekResultsArray(raw);
  if (results === null) return contents;
  for (const result of results) {
    const url = str(pointer(result, 'url'));
    const content = str(pointer(result, 'content'));
    if (url === null || content === null) continue;
    const trimmed = rustTrim(content);
    if (rustTrim(url) === '' || trimmed === '') continue;
    const key = normalizeUrl(url);
    if (!contents.has(key)) contents.set(key, trimmed);
  }
  return contents;
}
export function buildInjectText(config: ToolConfig, response: ProviderResponse): string {
  if (response.items.length === 0) return '';
  const snippetMax = config.inject_snippet_max_chars ?? 180;
  const limitChars = config.inject_total_max_chars ?? 1900;
  const isDeepseek = response.provider === 'deepseek' || str(pointer(response.raw, 'provider')) === 'deepseek';
  const contents = isDeepseek ? deepseekContentByUrl(response.raw) : new Map<string, string>();
  const header = '【外部搜索结果】\n';
  let buffer = header;
  let charCount = [...header].length;
  for (let index = 0; index < response.items.length; index += 1) {
    const item = response.items[index]!;
    const title = rustTrim(item.title);
    const found = contents.get(normalizeUrl(item.url));
    const content = found === undefined ? undefined : rustTrim(found);
    const snippet = content !== undefined && content !== ''
      ? truncate(content, snippetMax)[0]
      : truncate(stripHtml(item.snippet), snippetMax)[0];
    const line = `[${index + 1}] ${title} — ${snippet}\nURL: ${item.url}\n\n`;
    charCount += [...line].length;
    buffer += line;
    if (charCount > limitChars) break;
  }
  return truncate(buffer, limitChars)[0];
}

