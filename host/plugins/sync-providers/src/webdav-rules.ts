/**
 * webdav.rs 的纯辅助规则：路径解码与拼接、重试与限流判定、`Retry-After` / `Content-Range` 解析、
 * 错误体摘要、PROPFIND 响应字段提取。不发请求、不碰文件，`WebDavStorage` 共用。
 */

import { CloudStorageError } from './errors.ts';
import { defaultLogSink } from './logging.ts';
import { documentDescendants, parseXml, type XmlElement } from './xml.ts';

export const MAX_RETRY_WAIT_MS = 30_000;
export const NUTSTORE_REQUESTS_PER_WINDOW = 540;

export function decodePath(path: string): string {
  try { return decodeURIComponent(path); } catch { return path; }
}

/** Rust u64 seconds or HTTP-date; keep unsafe millisecond durations exact until capped. */
export function parseRetryAfter(raw: string): number | bigint | null {
  const trimmed = raw.trim();
  if (/^\+?\d+$/.test(trimmed)) {
    const seconds = BigInt(trimmed);
    if (seconds > 18_446_744_073_709_551_615n) return null;
    const milliseconds = seconds * 1000n;
    return milliseconds <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(milliseconds) : milliseconds;
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  const delta = parsed - Date.now();
  return delta >= 0 ? delta : null;
}

export function backoffDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

/** webdav.rs:454: `Retry-After` capped by the 30 s retry budget. */
export function cappedRetryAfter(res: { headers: Record<string, string> }): number | null {
  const raw = res.headers['retry-after'];
  if (raw === undefined) return null;
  const parsed = parseRetryAfter(raw);
  return parsed === null ? null : parsed > MAX_RETRY_WAIT_MS ? MAX_RETRY_WAIT_MS : Number(parsed);
}

/** webdav.rs:348. Only the two server-side truncation boundaries observed in production. */
export function isSuspiciousResponseCount(count: number): boolean {
  return count === 750 || count === 751 || count === 1000 || count === 1001;
}

/** webdav.rs:355: `bytes <start>-<end>/<total>`; the unsatisfiable `bytes *` form yields null. */
export function parseContentRangeStart(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('bytes')) return null;
  const rest = trimmed.slice(5).replace(/^[ \t]+/, '');
  const dash = rest.indexOf('-');
  if (dash < 0) return null;
  const start = rest.slice(0, dash).trim();
  if (!/^\d+$/.test(start)) return null;
  return Number(start);
}

/** webdav.rs:179: account-level throttling arrives as 503 with the reason in the body. */
export function isRateLimitResponse(status: number, body: string): boolean {
  if (status === 429) return true;
  if (status !== 503) return false;
  const normalized = body.toLowerCase();
  return normalized.includes('blockedtemporarily')
    || normalized.includes('too many requests')
    || normalized.includes('rate limit')
    || normalized.includes('rate-limit')
    || normalized.includes('ratelimit')
    || normalized.includes('throttl');
}

/** webdav.rs:306. */
export function isRetryableStatus(status: number): boolean {
  return status === 423 || status === 500 || status === 502 || status === 503 || status === 504;
}

/** webdav.rs:214: pull a displayable diagnosis out of a WebDAV XML or plain-text body. */
export function summarizeErrorBody(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  let root: XmlElement | null = null;
  try { root = parseXml(trimmed); }
  catch { root = null; } // Not XML: fall through to the whitespace-collapsed body, like roxmltree.
  if (root !== null) {
    const fields: string[] = [];
    for (const node of documentDescendants(root)) {
      const name = localNameOf(node.name).toLowerCase();
      if (name !== 'exception' && name !== 'message' && name !== 'responsedescription' && name !== 'description') continue;
      const text = node.text()?.trim();
      if (text && !fields.includes(text)) fields.push(text);
    }
    if (fields.length) return fields.join(': ');
  }
  const compact = trimmed.split(/\s+/).join(' ');
  return compact || null;
}

function localNameOf(qualified: string): string {
  const colon = qualified.indexOf(':');
  return colon >= 0 ? qualified.slice(colon + 1) : qualified;
}

/** webdav.rs:373. */
export function joinPaths(base: string, child: string): string {
  const baseTrimmed = base.replace(/^\/+|\/+$/g, '');
  const preserveTrailingSlash = child.endsWith('/') && child.replace(/^\/+|\/+$/g, '') !== '';
  const childTrimmed = child.replace(/^\/+|\/+$/g, '');
  if (!baseTrimmed && !childTrimmed) return '';
  if (!baseTrimmed) return preserveTrailingSlash ? `${childTrimmed}/` : childTrimmed;
  if (!childTrimmed) return baseTrimmed;
  return preserveTrailingSlash ? `${baseTrimmed}/${childTrimmed}/` : `${baseTrimmed}/${childTrimmed}`;
}

function parseHttpDate(raw: string): number {
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function resolveRequestsPerWindow(host: string, raw: string | undefined): number {
  const isNutstore = host.includes('jianguoyun') || host.includes('nutstore');
  if (!isNutstore) return 0;
  if (raw === undefined) return NUTSTORE_REQUESTS_PER_WINDOW;
  const parsed = raw.trim();
  if (!/^\d+$/.test(parsed)) {
    defaultLogSink().warn(
      `DEEP_STUDENT_WEBDAV_RATE_LIMIT=${JSON.stringify(raw)} 不是合法整数，回退默认 ${NUTSTORE_REQUESTS_PER_WINDOW}`,
    );
    return NUTSTORE_REQUESTS_PER_WINDOW;
  }
  return Number(parsed);
}

export function parseDocument(xml: string): XmlElement {
  try { return parseXml(xml); }
  catch (error) { throw new CloudStorageError('Network', `WebDAV PROPFIND XML 解析失败: ${error instanceof Error ? error.message : String(error)}`); }
}

export function findHref(response: XmlElement): string | null {
  for (const node of response.descendants()) {
    if (!node.isElement('href', 'DAV:')) continue;
    const text = node.text();
    if (text !== null && text.trim()) return text;
  }
  return null;
}

export function findNumber(response: XmlElement, name: string): number {
  for (const node of response.descendants()) {
    if (!node.isElement(name, 'DAV:')) continue;
    const text = node.text()?.trim();
    if (text && /^\d+$/.test(text)) return Number(text);
    return 0;
  }
  return 0;
}

export function findLastModified(response: XmlElement): number {
  for (const node of response.descendants()) {
    if (!node.isElement('getlastmodified', 'DAV:')) continue;
    const text = node.text();
    return text === null ? 0 : parseHttpDate(text);
  }
  return 0;
}

export function canonicalReasonOf(status: number): string {
  // Kept local to avoid importing the HTTP module's table into hot paths twice.
  return status === 403 ? 'Forbidden' : status === 507 ? 'Insufficient Storage' : '';
}
