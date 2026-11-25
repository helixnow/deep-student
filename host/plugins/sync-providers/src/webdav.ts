/**
 * WebDAV transport (webdav.rs).
 *
 * Request/retry/rate-limit/truncation semantics follow the Rust implementation line for
 * line; the only substitution is `reqwest` -> `ctx.http` (see http.ts).
 */

import { sha256Hasher, sha256Hex } from './hashing.ts';
import { decodeUtf8Lossy } from '../../../platform/util/portable.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { createDirAll, openFile, randomTempName, renameOver, statFile } from './fsutil.ts';
import type { FileInfo, ListOutcome, UploadProgressCallback, DownloadProgressCallback, WebDavConfig } from '../api.ts';
import { concatBytes, utf8Encode } from './bytes.ts';
import { CloudStorageError, ioError } from './errors.ts';
import { fs } from './local-fs.ts';
import { defaultLogSink } from './logging.ts';
import { chronoAutoSiZ } from './time.ts';
import { BODY_STALL_TIMEOUT_MS, CONTROL_PLANE_HEADER_TIMEOUT_MS, HEADER_TIMEOUT_MS, send, type HttpResponse } from './http.ts';
import { calculateFileHash } from './resume.ts';
import { BoundedMemoryBody, CloudStorageBase, MEMORY_GET_DEFAULT_BUDGET_BYTES, MEMORY_GET_STALL_SECS, cancellableSleep, ensureDeclaredLenWithinBudget, ensureMemoryGetMatchesDeclaredLen, reportStatus, syncCancelSignal } from './traits.ts';
import { documentDescendants } from './xml.ts';
import { CLOUD_RATE_LIMITED_CODE, isCloudRateLimited } from './mod.ts';
import {
  MAX_RETRY_WAIT_MS, WEBDAV_CONSECUTIVE_503_TRIP_THRESHOLD, WEBDAV_CONTROL_PLANE_MAX_BODY_BYTES, WEBDAV_MAX_503_PER_SYNC,
  WEBDAV_RETRY_BUDGET_MS, backoffDelayMs, canonicalReasonOf, cappedRetryAfter, decodePath, findHref, findLastModified, findNumber,
  isRateLimitResponse, isRetryableStatus, isSuspiciousResponseCount, joinPaths, parseContentRangeStart, parseDocument,
  resolveRequestsPerWindow, summarizeErrorBody,
} from './webdav-rules.ts';

export {
  MAX_RETRY_WAIT_MS, NUTSTORE_REQUESTS_PER_WINDOW, WEBDAV_CONSECUTIVE_503_TRIP_THRESHOLD, WEBDAV_CONTROL_PLANE_MAX_BODY_BYTES,
  WEBDAV_MAX_503_PER_SYNC, WEBDAV_RETRY_BUDGET_MS, backoffDelayMs, cappedRetryAfter, decodePath, isRateLimitResponse,
  isRetryableStatus, isSuspiciousResponseCount, joinPaths, parseContentRangeStart, parseRetryAfter, summarizeErrorBody,
} from './webdav-rules.ts';

export const MAX_ERROR_BODY_BYTES = 16 * 1024;
export const ERROR_BODY_READ_TIMEOUT_MS = 3_000;
export const RATE_WINDOW_MS = 30 * 60_000;
const MAX_RETRIES = 3;
const PROPFIND_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getlastmodified/><d:getcontentlength/></d:prop></d:propfind>';

const providerRequestWindows = new Map<string, number[]>();

/** Opened on the first read, so an attempt that never connects leaves no descriptor behind. */
function fileUploadStream(localPath: string, onChunk: (length: number) => void): ReadableStream<Uint8Array> {
  let source: AsyncIterator<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      source ??= fs.readChunks(localPath, 64 * 1024)[Symbol.asyncIterator]();
      const next = await source.next();
      if (next.done) { controller.close(); return; }
      onChunk(next.value.byteLength);
      controller.enqueue(next.value);
    },
    async cancel() { await source?.return?.(); },
  }, { highWaterMark: 0 });
}

/** reqwest encodes path segments with the `PATH_SEGMENT` ASCII set; non-ASCII is always encoded. */
export function encodePathSegment(segment: string): string {
  const bytes = utf8Encode(segment);
  let out = '';
  for (const byte of bytes) {
    const special = byte >= 0x80 || byte < 0x20 || byte === 0x7f
      || byte === 0x20 || byte === 0x22 || byte === 0x23 || byte === 0x3c || byte === 0x3e
      || byte === 0x60 || byte === 0x3f || byte === 0x7b || byte === 0x7d || byte === 0x2f || byte === 0x25;
    out += special ? `%${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte);
  }
  return out;
}

export interface WebDavStorageOptions {
  /** Mobile native HTTP bridges require a replayable byte body. */
  bufferedUploads?: boolean;
  /**
   * Rust `DEEP_STUDENT_WEBDAV_RATE_LIMIT` (webdav.rs:107-125): plugin config `webdavRateLimit`,
   * filled from the environment by the desktop composition root. Absent = Nutstore default.
   */
  rateLimitEnv?: string | undefined;
  /** Disable the 30-minute sliding window (tests that assert request counts). */
  requestWindowKey?: string;
  /** Override control-plane response header timeout (defaults to `CONTROL_PLANE_HEADER_TIMEOUT_MS`). */
  controlPlaneHeaderTimeoutMs?: number;
  /** Override per-instance cumulative retry time budget (defaults to `WEBDAV_RETRY_BUDGET_MS`). */
  retryBudgetMs?: number;
  /** Override consecutive HTTP 503 circuit-breaker threshold (defaults to `WEBDAV_CONSECUTIVE_503_TRIP_THRESHOLD`). */
  consecutive503Threshold?: number;
  /** Override cumulative HTTP 503 ceiling per storage instance (defaults to `WEBDAV_MAX_503_PER_SYNC`). */
  maxTotal503s?: number;
}

export class WebDavStorage extends CloudStorageBase {
  private readonly bufferedUploads: boolean;
  private readonly baseUrl: URL;
  private readonly username: string;
  private readonly password: string;
  private readonly root: string;
  private readonly createdDirs = new Set<string>();
  private readonly requestWindow: number[];
  private readonly requestsPerWindow: number;
  private readonly controlPlaneHeaderTimeoutMs: number;
  private readonly retryBudgetMs: number;
  private readonly consecutive503Threshold: number;
  private readonly maxTotal503s: number;
  private consecutive503Count = 0;
  private total503Count = 0;
  private retryBudgetUsedMs = 0;
  private circuitOpenReason: string | null = null;

  constructor(config: WebDavConfig, root: string, options: WebDavStorageOptions = {}) {
    super();
    this.bufferedUploads = options.bufferedUploads === true;
    if (!config.endpoint.trim()) throw new CloudStorageError('Validation', 'WebDAV endpoint 不能为空');
    let url: URL;
    try { url = new URL(config.endpoint.trim()); }
    catch (error) { throw new CloudStorageError('Configuration', `无效的 WebDAV endpoint: ${error instanceof Error ? error.message : String(error)}`); }
    this.baseUrl = url;
    this.username = config.username;
    this.password = config.password;
    this.root = root.replace(/^\/+|\/+$/g, '');
    const host = url.hostname.toLowerCase();
    this.requestsPerWindow = resolveRequestsPerWindow(host, options.rateLimitEnv);
    const key = options.requestWindowKey ?? `${host}|${config.username}`;
    let window = providerRequestWindows.get(key);
    if (!window) { window = []; providerRequestWindows.set(key, window); }
    this.requestWindow = window;
    this.controlPlaneHeaderTimeoutMs = options.controlPlaneHeaderTimeoutMs ?? CONTROL_PLANE_HEADER_TIMEOUT_MS;
    this.retryBudgetMs = options.retryBudgetMs ?? WEBDAV_RETRY_BUDGET_MS;
    this.consecutive503Threshold = options.consecutive503Threshold ?? WEBDAV_CONSECUTIVE_503_TRIP_THRESHOLD;
    this.maxTotal503s = options.maxTotal503s ?? WEBDAV_MAX_503_PER_SYNC;
  }

  providerName(): string { return 'WebDAV'; }

  override instanceBindingHint(): string {
    return `webdav|endpoint=${this.baseUrl.href.replace(/\/+$/, '')}|user=${this.username}|root=${this.root}`;
  }

  /** webdav.rs:132: sliding-window limiter; waits are cancellable. */
  private async acquireRequestSlot(): Promise<void> {
    if (this.requestsPerWindow === 0) return;
    for (;;) {
      const now = performance.now();
      while (this.requestWindow.length && now - this.requestWindow[0]! >= RATE_WINDOW_MS) this.requestWindow.shift();
      if (this.requestWindow.length < this.requestsPerWindow) {
        this.requestWindow.push(now);
        return;
      }
      const delay = Math.max(0, RATE_WINDOW_MS - (now - this.requestWindow[0]!));
      if (delay >= 2000) reportStatus(`云端限流保护，约 ${Math.floor(delay / 1000)} 秒后自动继续…`);
      await cancellableSleep(Math.min(delay, 60_000));
    }
  }

  private authHeader(): string {
    return `Basic ${toBase64(utf8Encode(`${this.username}:${this.password}`))}`;
  }

  private remotePath(key: string): string {
    return joinPaths(this.root, key);
  }

  /** webdav.rs:399: base segments are decoded then re-encoded exactly once. */
  buildPathUrl(path: string): URL {
    const url = new URL(this.baseUrl.href);
    const baseSegments = url.pathname.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean).map(decodePath);
    const remoteSegments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    const preserveTrailingSlash = path.endsWith('/') && remoteSegments.length > 0;
    const segments = [...baseSegments, ...remoteSegments];
    const encoded = segments.map(encodePathSegment).join('/');
    url.pathname = `/${encoded}${preserveTrailingSlash && encoded ? '/' : ''}`;
    return url;
  }

  buildUrl(key: string): URL { return this.buildPathUrl(this.remotePath(key)); }

  private formatHttpError(operation: string, res: { status: number; statusText: string; headers: Record<string, string> }, body: string): string {
    let message = `${operation} 失败: HTTP ${res.status} ${res.statusText}`;
    const retryAfter = res.headers['retry-after']?.trim();
    if (retryAfter) message += `，服务器 Retry-After=${retryAfter}`;
    const detail = summarizeErrorBody(body);
    if (detail) message += `；服务器详情: ${detail}`;
    return message;
  }

  private formatRateLimitError(operation: string, res: { status: number; statusText: string; headers: Record<string, string> }, body: string): string {
    return `[${CLOUD_RATE_LIMITED_CODE}] WebDAV 服务端限流，未重试；${this.formatHttpError(operation, res, body)}`;
  }

  private assertCircuitHealthy(operation: string): void {
    if (this.circuitOpenReason !== null) {
      throw new CloudStorageError(
        'Network',
        `WebDAV 服务持续返回 HTTP 503，已触发熔断停止后续请求（${operation}）；原因：${this.circuitOpenReason}。请检查网络或 WebDAV 服务状态后稍后重试`,
      );
    }
  }

  private recordHealthyResponse(status: number): void {
    if (status < 500 && status !== 429) {
      this.consecutive503Count = 0;
    }
  }

  private record503(detail: string): boolean {
    this.consecutive503Count += 1;
    this.total503Count += 1;
    if (this.consecutive503Count >= this.consecutive503Threshold || this.total503Count >= this.maxTotal503s) {
      this.circuitOpenReason = detail;
      return true;
    }
    return false;
  }

  private recordRetryableAttemptElapsed(attemptStartedAt: number, errorMessage?: string | null, headerTimeoutMs?: number): void {
    const wallElapsed = Math.max(0, performance.now() - attemptStartedAt);
    const timeoutFloor = errorMessage && headerTimeoutMs && errorMessage.includes('等待响应头超时') ? headerTimeoutMs : 0;
    this.retryBudgetUsedMs += Math.max(wallElapsed, timeoutFloor);
  }

  private consumeRetryWait(delayMs: number, operation: string, attemptsSoFar: number, lastError: string | null): number {
    this.assertCircuitHealthy(operation);
    const boundedDelay = Math.min(Math.max(0, delayMs), MAX_RETRY_WAIT_MS);
    if (this.retryBudgetUsedMs >= this.retryBudgetMs || this.retryBudgetUsedMs + boundedDelay > this.retryBudgetMs) {
      const detail = lastError ? `: ${lastError}` : '';
      throw new CloudStorageError(
        'Network',
        `${operation} 失败（已重试 ${attemptsSoFar} 次，超出本次同步重试时间上限）${detail}`,
      );
    }
    this.retryBudgetUsedMs += boundedDelay;
    return boundedDelay;
  }

  private headerTimeoutFor(method: string, bodyLength: number | null, overrideMs?: number): number {
    if (overrideMs !== undefined) return overrideMs;
    if (method === 'PUT' && bodyLength !== null && bodyLength > WEBDAV_CONTROL_PLANE_MAX_BODY_BYTES) {
      return HEADER_TIMEOUT_MS;
    }
    return this.controlPlaneHeaderTimeoutMs;
  }

  private static async readErrorBody(res: HttpResponse): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ERROR_BODY_READ_TIMEOUT_MS);
        (timer as { unref?: () => void }).unref?.();
      });
      const body = await Promise.race([res.bytes(MAX_ERROR_BODY_BYTES, ERROR_BODY_READ_TIMEOUT_MS), deadline]);
      return decodeUtf8Lossy(body);
    } catch {
      return '';
    } finally {
      if (timer !== null) clearTimeout(timer);
      res.discard();
    }
  }

  private async responseError(operation: string, res: HttpResponse): Promise<CloudStorageError> {
    const body = await WebDavStorage.readErrorBody(res);
    if (isRateLimitResponse(res.status, body)) {
      return new CloudStorageError('Network', this.formatRateLimitError(operation, res, body));
    }
    const message = this.formatHttpError(operation, res, body);
    if (res.status === 503) this.record503(message);
    return new CloudStorageError('Network', message);
  }

  /** webdav.rs:454: bounded retries with Retry-After support; 429/rate-limited 503 return immediately. */
  private async requestWithPath(
    method: string,
    path: string,
    body: Uint8Array | null,
    headers: Record<string, string> = {},
    headerTimeoutMsOverride?: number,
  ): Promise<HttpResponse> {
    const url = this.buildPathUrl(path);
    const operation = `WebDAV ${method} ${path}`;
    this.assertCircuitHealthy(operation);
    const headerTimeoutMs = this.headerTimeoutFor(method, body?.byteLength ?? null, headerTimeoutMsOverride);
    let lastError: string | null = null;
    let pendingDelay: number | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = this.consumeRetryWait(pendingDelay ?? backoffDelayMs(attempt), operation, attempt, lastError);
        if (delay > 0) {
          reportStatus(`云端请求暂不可用，${Math.ceil(delay / 1000)} 秒后自动重试（第 ${attempt + 1}/${MAX_RETRIES} 次）…`);
          await cancellableSleep(delay);
        }
        reportStatus(`正在重试（第 ${attempt + 1}/${MAX_RETRIES} 次）…`);
      }
      this.assertCircuitHealthy(operation);
      await this.acquireRequestSlot();
      const attemptStartedAt = performance.now();
      let res: HttpResponse;
      try {
        res = await send({
          method,
          url,
          headers: { ...headers, authorization: this.authHeader() },
          body,
          headerTimeoutMs,
          signal: syncCancelSignal(),
        });
      } catch (error) {
        if (syncCancelSignal()?.aborted) throw error;
        lastError = error instanceof CloudStorageError ? error.message : String(error);
        this.recordRetryableAttemptElapsed(attemptStartedAt, lastError, headerTimeoutMs);
        pendingDelay = null;
        if (attempt === MAX_RETRIES - 1) break;
        continue;
      }

      if (res.status === 429) {
        const errorBody = await WebDavStorage.readErrorBody(res);
        throw new CloudStorageError('Network', this.formatRateLimitError(operation, res, errorBody));
      }
      if (res.status === 503) {
        const errorBody = await WebDavStorage.readErrorBody(res);
        if (isRateLimitResponse(res.status, errorBody)) {
          throw new CloudStorageError('Network', this.formatRateLimitError(operation, res, errorBody));
        }
        const detail = this.formatHttpError(operation, res, errorBody);
        const tripped = this.record503(detail);
        this.recordRetryableAttemptElapsed(attemptStartedAt);
        if (attempt === MAX_RETRIES - 1) {
          if (method === 'MKCOL') return res;
          throw new CloudStorageError('Network', detail);
        }
        if (tripped) {
          throw new CloudStorageError('Network', detail);
        }
        pendingDelay = cappedRetryAfter(res);
        lastError = detail;
        continue;
      }
      if (isRetryableStatus(res.status) && attempt < MAX_RETRIES - 1) {
        this.recordRetryableAttemptElapsed(attemptStartedAt);
        pendingDelay = cappedRetryAfter(res);
        lastError = `HTTP ${res.status}`;
        res.discard();
        continue;
      }
      this.recordHealthyResponse(res.status);
      return res;
    }

    throw new CloudStorageError('Network', `WebDAV ${method} 请求失败（已重试 ${MAX_RETRIES} 次）: ${lastError ?? ''}`);
  }

  private request(method: string, key: string, body: Uint8Array | null, headerTimeoutMsOverride?: number): Promise<HttpResponse> {
    return this.requestWithPath(method, this.remotePath(key), body, {}, headerTimeoutMsOverride);
  }

  /** webdav.rs:578. */
  private async propfindWithRetry(url: URL, depth: string, context: string): Promise<string | null> {
    const operation = `WebDAV PROPFIND ${context}`;
    this.assertCircuitHealthy(operation);
    let lastError: string | null = null;
    let pendingDelay: number | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = this.consumeRetryWait(pendingDelay ?? backoffDelayMs(attempt), operation, attempt, lastError);
        if (delay > 0) {
          reportStatus(`云端目录查询暂不可用，${Math.ceil(delay / 1000)} 秒后自动重试（第 ${attempt + 1}/${MAX_RETRIES} 次）…`);
          await cancellableSleep(delay);
        }
        reportStatus(`正在重试（第 ${attempt + 1}/${MAX_RETRIES} 次）…`);
      }
      this.assertCircuitHealthy(operation);
      await this.acquireRequestSlot();

      const attemptStartedAt = performance.now();
      let res: HttpResponse;
      try {
        res = await send({
          method: 'PROPFIND',
          url,
          headers: { authorization: this.authHeader(), depth, 'content-type': 'application/xml' },
          body: utf8Encode(PROPFIND_BODY),
          headerTimeoutMs: this.controlPlaneHeaderTimeoutMs,
          signal: syncCancelSignal(),
        });
      } catch (error) {
        if (syncCancelSignal()?.aborted) throw error;
        lastError = error instanceof CloudStorageError ? error.message : String(error);
        this.recordRetryableAttemptElapsed(attemptStartedAt, lastError, this.controlPlaneHeaderTimeoutMs);
        pendingDelay = null;
        if (attempt === MAX_RETRIES - 1) break;
        continue;
      }

      if (res.status === 404) { this.recordHealthyResponse(res.status); res.discard(); return null; }
      if (res.status === 429) {
        const errorBody = await WebDavStorage.readErrorBody(res);
        throw new CloudStorageError('Network', this.formatRateLimitError(operation, res, errorBody));
      }
      if (res.status === 503) {
        const errorBody = await WebDavStorage.readErrorBody(res);
        if (isRateLimitResponse(res.status, errorBody)) {
          throw new CloudStorageError('Network', this.formatRateLimitError(operation, res, errorBody));
        }
        pendingDelay = cappedRetryAfter(res);
        lastError = this.formatHttpError(operation, res, errorBody);
        const tripped = this.record503(lastError);
        this.recordRetryableAttemptElapsed(attemptStartedAt);
        if (attempt === MAX_RETRIES - 1 || tripped) throw new CloudStorageError('Network', lastError);
        continue;
      }
      if (isRetryableStatus(res.status)) {
        this.recordRetryableAttemptElapsed(attemptStartedAt);
        pendingDelay = cappedRetryAfter(res);
        lastError = `HTTP ${res.status} ${res.statusText}`;
        res.discard();
        if (attempt === MAX_RETRIES - 1) break;
        continue;
      }
      if (res.status < 200 || res.status >= 300) {
        this.recordHealthyResponse(res.status);
        res.discard();
        throw new CloudStorageError('Network', `WebDAV PROPFIND 失败: ${res.status} ${res.statusText}`);
      }
      this.recordHealthyResponse(res.status);
      try {
        return await res.text(MAX_ERROR_BODY_BYTES * 4096);
      } catch (error) {
        if (syncCancelSignal()?.aborted) throw error;
        this.recordRetryableAttemptElapsed(attemptStartedAt);
        pendingDelay = null;
        lastError = `读取 PROPFIND 响应失败: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    throw new CloudStorageError('Network', `WebDAV PROPFIND ${context} 失败（已重试 ${MAX_RETRIES} 次）: ${lastError ?? ''}`);
  }

  async ensureDirectory(path: string): Promise<void> {
    await this.ensureDirectoryTracked(path);
  }

  /** webdav.rs:740: returns the last still-unrecovered MKCOL failure status, if any. */
  async ensureDirectoryTracked(path: string): Promise<number | null> {
    const parts = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    let mkcolFailure: number | null = null;
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (this.createdDirs.has(current)) continue;
      const res = await this.requestWithPath('MKCOL', `${current}/`, null);
      if (res.status === 200 || res.status === 201 || res.status === 405) {
        this.createdDirs.add(current);
        mkcolFailure = null;
      } else if (res.status === 409) {
        mkcolFailure = 409;
      } else if (res.status >= 400 && res.status < 600) {
        mkcolFailure = res.status;
        defaultLogSink().warn(`WebDAV MKCOL ${current} 失败: ${res.status} ${res.statusText}`);
      }
      res.discard();
    }
    return mkcolFailure;
  }

  /** webdav.rs:806. */
  private static rootUnavailableError(mkcolStatus: number): CloudStorageError {
    if (mkcolStatus === 423) {
      return new CloudStorageError('Network', 'WebDAV 同步目录不存在，且服务器暂时锁定资源（423 Locked）：可能有其他客户端正在操作，请稍后重试');
    }
    if (mkcolStatus === 429) {
      return new CloudStorageError('Network', 'WebDAV 同步目录不存在，且服务器正在限流（429 Too Many Requests）：请稍后重试');
    }
    if (mkcolStatus === 409) {
      return new CloudStorageError('Network', 'WebDAV 同步目录不存在且无法创建：MKCOL 全链返回 409 Conflict（父目录缺失或路径被占用），PROPFIND 返回 404');
    }
    return new CloudStorageError('Network', `WebDAV 同步目录不存在且无法创建：MKCOL 返回 ${mkcolStatus} ${canonicalReasonOf(mkcolStatus)}，PROPFIND 返回 404`);
  }

  /** webdav.rs:910. */
  extractRelativeKey(href: string, prefix: string): string {
    let rawPath: string;
    try { rawPath = new URL(href).pathname; }
    catch { rawPath = href.split(/[?#]/)[0] ?? href; }
    const hrefPath = decodePath(rawPath);

    const basePath = decodePath(this.baseUrl.pathname).replace(/\/+$/, '');
    const root = this.root.replace(/^\/+|\/+$/g, '');
    const rootPath = !basePath && !root ? '' : !basePath ? `/${root}` : !root ? basePath : `${basePath}/${root}`;

    let relative: string;
    if (!rootPath) relative = hrefPath.replace(/^\/+/, '');
    else if (hrefPath === rootPath || hrefPath === `${rootPath}/`) relative = '';
    else {
      const prefixWithSlash = `${rootPath}/`;
      relative = hrefPath.startsWith(prefixWithSlash) ? hrefPath.slice(prefixWithSlash.length) : '';
    }

    if (!relative) return '';
    if (!prefix) return relative;
    const normalized = prefix.replace(/^\/+|\/+$/g, '');
    if (relative === normalized || relative.startsWith(`${normalized}/`)) return relative;
    return '';
  }

  /** webdav.rs:832: flat listing used by `stat`. */
  parsePropfindResponse(xml: string, prefix: string): FileInfo[] {
    const root = parseDocument(xml);
    const responses = [...documentDescendants(root)].filter(node => node.isElement('response', 'DAV:'));
    if (!responses.length) {
      throw new CloudStorageError('Network', 'WebDAV PROPFIND 响应缺少 DAV:response，无法确认列表完整性');
    }
    const files: FileInfo[] = [];
    for (const response of responses) {
      const href = findHref(response);
      if (href === null) throw new CloudStorageError('Network', 'WebDAV PROPFIND 的 DAV:response 缺少有效 href');
      const isCollection = [...response.descendants()].some(node => node.isElement('collection', 'DAV:'));
      if (isCollection || href.endsWith('/')) continue;
      const key = this.extractRelativeKey(href, prefix);
      if (!key) continue;
      files.push({
        key,
        size: findNumber(response, 'getcontentlength'),
        lastModified: chronoAutoSiZ(findLastModified(response)),
      });
    }
    files.sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified));
    return files;
  }

  /** webdav.rs:968. */
  parsePropfindEntries(xml: string, prefix: string, requestDir: string): { files: FileInfo[]; subdirs: string[]; responseCount: number } {
    const root = parseDocument(xml);
    const responses = [...documentDescendants(root)].filter(node => node.isElement('response', 'DAV:'));
    if (!responses.length) {
      throw new CloudStorageError('Network', 'WebDAV PROPFIND 响应缺少 DAV:response，无法确认列表完整性');
    }
    const files: FileInfo[] = [];
    const subdirs: string[] = [];
    const requestDirNormalized = requestDir.replace(/^\/+|\/+$/g, '');
    const prefixNormalized = prefix.replace(/^\/+|\/+$/g, '');

    for (const response of responses) {
      const href = findHref(response);
      if (href === null) throw new CloudStorageError('Network', 'WebDAV PROPFIND 的 DAV:response 缺少有效 href');
      const isCollection = [...response.descendants()].some(node => node.isElement('collection', 'DAV:'));
      if (isCollection || href.endsWith('/')) {
        const dirPath = this.extractRelativeKey(href, '').replace(/^\/+|\/+$/g, '');
        if (dirPath === requestDirNormalized || !dirPath) continue;
        if (prefixNormalized && !dirPath.startsWith(prefixNormalized)) continue;
        subdirs.push(dirPath);
        continue;
      }
      const key = this.extractRelativeKey(href, prefix);
      if (!key) continue;
      files.push({
        key,
        size: findNumber(response, 'getcontentlength'),
        lastModified: chronoAutoSiZ(findLastModified(response)),
      });
    }
    return { files, subdirs, responseCount: responses.length };
  }

  async checkConnection(): Promise<void> {
    const mkcolFailure = await this.ensureDirectoryTracked(this.root);
    if (mkcolFailure === 502 || mkcolFailure === 503 || mkcolFailure === 504) {
      throw new CloudStorageError('Network', `WebDAV 服务暂不可用（HTTP ${mkcolFailure} ${canonicalReasonOf(mkcolFailure)}），请稍后重试`);
    }
    const rootPath = this.root ? `${this.root}/` : '';
    const url = this.buildPathUrl(rootPath);
    try {
      const xml = await this.propfindWithRetry(url, '0', 'check_connection');
      if (xml !== null) return;
      if (mkcolFailure === null) return;
      throw WebDavStorage.rootUnavailableError(mkcolFailure);
    } catch (error) {
      if (syncCancelSignal()?.aborted) throw error;
      if (error instanceof CloudStorageError && isCloudRateLimited(error.message)) throw error;
      if (
        error instanceof CloudStorageError
        && /(?:HTTP\s*(?:401|403|500|502|503|504)\b|已重试\s*\d+\s*次)/i.test(error.message)
      ) {
        throw error;
      }
      // Rare partial implementations reject PROPFIND; fall back to GET on the root.
      const res = await this.request('GET', '', null);
      try {
        if (res.status >= 200 && res.status < 300) return;
        if (res.status === 404) {
          if (mkcolFailure === null) return;
          throw WebDavStorage.rootUnavailableError(mkcolFailure);
        }
        throw error;
      } finally { res.discard(); }
    }
  }

  override async putFile(key: string, localPath: string, progress?: UploadProgressCallback | null): Promise<string> {
    if (this.bufferedUploads) {
      const bytes = await fs.readFile(localPath);
      await this.put(key, bytes);
      progress?.(bytes.length, bytes.length);
      return sha256Hex(bytes);
    }
    await this.ensureDirectory(this.root);
    const slash = key.lastIndexOf('/');
    if (slash >= 0) {
      const parentPath = key.slice(0, slash);
      if (parentPath) await this.ensureDirectory(this.remotePath(parentPath));
    }

    let fileSize: number;
    try { fileSize = (await statFile(localPath)).size; }
    catch (error) { throw new CloudStorageError('FileSystem', `读取文件元信息失败: ${ioError(error)}`); }
    progress?.(0, fileSize);
    const checksum = await calculateFileHash(localPath);

    const url = this.buildUrl(key);
    const operation = `WebDAV 上传 ${key}`;
    this.assertCircuitHealthy(operation);
    const uploadTimeoutMs = Math.max((120 + Math.floor(fileSize / (64 * 1024))) * 1000, 300_000);
    const headerTimeoutMs = fileSize > WEBDAV_CONTROL_PLANE_MAX_BODY_BYTES ? HEADER_TIMEOUT_MS : this.controlPlaneHeaderTimeoutMs;
    let lastError: CloudStorageError | null = null;
    let pendingDelay: number | null = null;
    let reportedMax = 0;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = this.consumeRetryWait(pendingDelay ?? backoffDelayMs(attempt), operation, attempt, lastError?.message ?? null);
        if (delay > 0) {
          reportStatus(`云端上传暂不可用，${Math.ceil(delay / 1000)} 秒后自动重试（第 ${attempt + 1}/${MAX_RETRIES} 次）…`);
          await cancellableSleep(delay);
        }
        reportStatus(`正在重试（第 ${attempt + 1}/${MAX_RETRIES} 次）…`);
      }

      this.assertCircuitHealthy(operation);
      let uploaded = 0;
      await this.acquireRequestSlot();
      const attemptStartedAt = performance.now();
      let res: HttpResponse;
      try {
        res = await send({
          method: 'PUT',
          url,
          headers: { authorization: this.authHeader(), 'content-length': String(fileSize) },
          bodyFactory: () => fileUploadStream(localPath, (length) => {
            uploaded += length;
            if (uploaded > reportedMax) { reportedMax = uploaded; progress?.(uploaded, fileSize); }
          }),
          bodyLength: fileSize,
          headerTimeoutMs,
          totalTimeoutMs: uploadTimeoutMs,
          signal: syncCancelSignal(),
        });
      } catch (error) {
        if (syncCancelSignal()?.aborted) throw error;
        const text = error instanceof Error ? error.message : String(error);
        lastError = new CloudStorageError('Network', `WebDAV 上传失败: ${text}`);
        this.recordRetryableAttemptElapsed(attemptStartedAt, text, headerTimeoutMs);
        pendingDelay = null;
        if (attempt === MAX_RETRIES - 1) break;
        continue;
      }

      if (res.status >= 200 && res.status < 300) {
        this.recordHealthyResponse(res.status);
        res.discard();
        progress?.(fileSize, fileSize);
        await this.verifyRemoteObjectSize(key, fileSize);
        return checksum;
      }

      const errorBody = res.status === 429 || res.status === 503 ? await WebDavStorage.readErrorBody(res) : '';
      if (isRateLimitResponse(res.status, errorBody)) {
        throw new CloudStorageError('Network', this.formatRateLimitError(operation, res, errorBody));
      }
      if (!isRetryableStatus(res.status)) {
        this.recordHealthyResponse(res.status);
        res.discard();
        throw new CloudStorageError('Network', this.formatHttpError(operation, res, errorBody));
      }
      const detail = this.formatHttpError(operation, res, errorBody);
      lastError = new CloudStorageError('Network', detail);
      this.recordRetryableAttemptElapsed(attemptStartedAt);
      if (res.status === 503 && this.record503(detail)) {
        res.discard();
        throw lastError;
      }
      pendingDelay = cappedRetryAfter(res);
      res.discard();
    }

    throw lastError ?? new CloudStorageError('Network', `WebDAV 上传失败（已重试 ${MAX_RETRIES} 次）`);
  }

  override async getFile(key: string, localPath: string, expectedChecksum?: string | null, progress?: DownloadProgressCallback | null): Promise<string> {
    const info = await this.stat(key);
    if (info === null) throw new CloudStorageError('NotFound', '云端文件不存在');
    const totalSize = info.size;
    progress?.(0, totalSize);

    const headerTimeoutMs = totalSize > WEBDAV_CONTROL_PLANE_MAX_BODY_BYTES ? HEADER_TIMEOUT_MS : this.controlPlaneHeaderTimeoutMs;
    const res = await this.request('GET', key, null, headerTimeoutMs);
    if (res.status === 404) { res.discard(); throw new CloudStorageError('NotFound', '云端文件不存在'); }
    if (res.status < 200 || res.status >= 300) throw await this.responseError('WebDAV 下载', res);

    const tempPath = await randomTempName(localPath, '.download-', '');
    const handle = await openFile(tempPath, 'w');
    const hasher = sha256Hasher();
    let downloaded = 0;
    try {
      for await (const chunk of res.chunks(BODY_STALL_TIMEOUT_MS, 'WebDAV 下载停滞超过 90 秒，连接可能已断开')) {
        await handle.write(chunk);
        hasher.update(chunk);
        downloaded += chunk.byteLength;
        progress?.(downloaded, totalSize);
      }
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await handle.remove().catch(() => undefined);
      throw error;
    }
    await handle.close();
    if (downloaded !== totalSize) {
      await handle.remove().catch(() => undefined);
      throw new CloudStorageError('Network', `WebDAV 下载不完整或对象已变更：声明 ${totalSize} 字节，实际收到 ${downloaded} 字节，已拒绝保存（请重试）`);
    }
    const checksum = hasher.digestHex();
    if (expectedChecksum != null && expectedChecksum !== checksum) {
      await handle.remove().catch(() => undefined);
      throw new CloudStorageError('Validation', `校验失败：期望 ${expectedChecksum}, 实际 ${checksum}`);
    }
    await renameOver(tempPath, localPath);
    return checksum;
  }

  override supportsResumableDownload(): boolean { return true; }

  override async getFileResumable(key: string, dest: string, resumeFrom: number, progress?: DownloadProgressCallback | null): Promise<number> {
    const info = await this.stat(key);
    if (info === null) throw new CloudStorageError('NotFound', '云端文件不存在');
    const totalSize = info.size;
    if (resumeFrom > totalSize) {
      throw new CloudStorageError('Validation', `本地断点（${resumeFrom} 字节）大于云端对象（${totalSize} 字节），断点无效，请删除断点文件后整包重新下载`);
    }
    progress?.(resumeFrom, totalSize);
    if (resumeFrom === totalSize) return resumeFrom;

    const url = this.buildUrl(key);
    this.assertCircuitHealthy(`WebDAV 续传下载 ${key}`);
    await this.acquireRequestSlot();
    const headers: Record<string, string> = { authorization: this.authHeader() };
    if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;
    const headerTimeoutMs = totalSize > WEBDAV_CONTROL_PLANE_MAX_BODY_BYTES ? HEADER_TIMEOUT_MS : this.controlPlaneHeaderTimeoutMs;
    let res: HttpResponse;
    try { res = await send({ method: 'GET', url, headers, headerTimeoutMs, signal: syncCancelSignal() }); }
    catch (error) { throw new CloudStorageError('Network', `WebDAV 续传下载请求失败: ${error instanceof Error ? error.message : String(error)}`); }

    if (res.status === 404) { this.recordHealthyResponse(res.status); res.discard(); throw new CloudStorageError('NotFound', '云端文件不存在'); }
    let actualStart: number;
    if (res.status === 206) {
      this.recordHealthyResponse(res.status);
      const contentRange = res.headers['content-range'] ?? null;
      const servedStart = contentRange === null ? null : parseContentRangeStart(contentRange);
      if (servedStart !== resumeFrom) {
        res.discard();
        throw new CloudStorageError('Network', `WebDAV 服务端返回的续传起点与请求不一致（fail-closed，拒绝错位追加）：请求 bytes=${resumeFrom}-，Content-Range=${contentRange === null ? 'None' : `Some("${contentRange}")`}`);
      }
      actualStart = resumeFrom;
    } else if (res.status === 200) {
      this.recordHealthyResponse(res.status);
      actualStart = 0;
    } else {
      throw await this.responseError('WebDAV 续传下载', res);
    }
    if (actualStart === 0 && resumeFrom > 0) {
      defaultLogSink().warn(
        `WebDAV 服务端未按 Range 续传（HTTP 200），已丢弃本地断点从零重下: ${key}`,
      );
    }

    const handle = await openFile(dest, actualStart > 0 ? 'a' : 'w');
    if (actualStart > 0) {
      const existing = await handle.stat();
      if (existing.size !== actualStart) {
        await handle.close();
        throw new CloudStorageError('FileSystem', `断点文件大小（${existing.size} 字节）与续传起点（${actualStart} 字节）不一致，拒绝错位追加`);
      }
    }
    let written = actualStart;
    try {
      for await (const chunk of res.chunks(BODY_STALL_TIMEOUT_MS, 'WebDAV 续传下载停滞超过 90 秒，连接可能已断开（已写入的断点保留，可重试续传）')) {
        if (written + chunk.byteLength > totalSize) {
          throw new CloudStorageError('Validation', `云端对象返回超过声明大小（${totalSize} 字节）的数据，拒绝写入（对象可能已被并发修改）`);
        }
        await handle.write(chunk);
        written += chunk.byteLength;
        progress?.(written, totalSize);
      }
      await handle.sync();
    } catch (error) {
      // webdav.rs:1511: transport errors surface as "读取响应体失败"; our own
      // stall/oversize errors already carry their stable text.
      if (error instanceof CloudStorageError) throw error;
      throw new CloudStorageError('Network', `读取响应体失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally { await handle.close(); }

    if (written !== totalSize) {
      throw new CloudStorageError('Network', `WebDAV 下载在 ${written}/${totalSize} 字节处中断（已写入的断点保留，可重试续传）`);
    }
    return actualStart;
  }

  override supportsPrefixRead(): boolean { return true; }

  override async getPrefix(key: string, prefixLen: number): Promise<Uint8Array | null> {
    if (prefixLen === 0) return new Uint8Array();
    const url = this.buildUrl(key);
    this.assertCircuitHealthy(`WebDAV 前缀读取 ${key}`);
    let res: HttpResponse;
    try {
      res = await send({
        method: 'GET',
        url,
        headers: { authorization: this.authHeader(), range: `bytes=0-${prefixLen - 1}` },
        headerTimeoutMs: this.controlPlaneHeaderTimeoutMs,
        signal: syncCancelSignal(),
      });
    } catch (error) {
      throw new CloudStorageError('Network', `WebDAV 前缀读取请求失败: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (res.status === 404) { this.recordHealthyResponse(res.status); res.discard(); return null; }
    if (res.status === 416) { this.recordHealthyResponse(res.status); res.discard(); return new Uint8Array(); }
    if (res.status === 206) {
      this.recordHealthyResponse(res.status);
      const contentRange = res.headers['content-range'] ?? null;
      const servedStart = contentRange === null ? null : parseContentRangeStart(contentRange);
      if (servedStart !== 0) {
        res.discard();
        throw new CloudStorageError('Network', `WebDAV 服务端返回的前缀起点不是 0（fail-closed，拒绝错位字节）：请求 bytes=0-，Content-Range=${contentRange === null ? 'None' : `Some("${contentRange}")`}`);
      }
    } else if (res.status !== 200) {
      throw await this.responseError('WebDAV 前缀读取', res);
    } else {
      this.recordHealthyResponse(res.status);
    }

    const parts: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of res.chunks(BODY_STALL_TIMEOUT_MS, 'WebDAV 前缀读取停滞超过 90 秒，连接可能已断开')) {
      const need = Math.min(prefixLen - length, chunk.byteLength);
      parts.push(chunk.subarray(0, need));
      length += need;
      if (length >= prefixLen) break;
    }
    res.discard();
    return concatBytes(parts, length);
  }

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.ensureDirectory(this.root);
    const slash = key.lastIndexOf('/');
    if (slash >= 0) {
      const parentPath = key.slice(0, slash);
      if (parentPath) await this.ensureDirectory(this.remotePath(parentPath));
    }
    const res = await this.request('PUT', key, data);
    try {
      if (res.status >= 200 && res.status < 300) return;
      throw new CloudStorageError('Network', `WebDAV 上传失败: ${res.status} ${res.statusText}`);
    } finally { res.discard(); }
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.getBounded(key, MEMORY_GET_DEFAULT_BUDGET_BYTES);
  }

  override async getRange(key: string, offset: number, length: number): Promise<Uint8Array> {
    this.validateRange(offset, length);
    if (length === 0) return new Uint8Array(0);
    const end = offset + length - 1;
    const res = await this.requestWithPath('GET', this.remotePath(key), null, { range: `bytes=${offset}-${end}` });
    try {
      if (res.status === 404) throw new CloudStorageError('NotFound', '云端文件不存在');
      if (res.status === 416) throw new CloudStorageError('Configuration', 'WebDAV Range 越界（HTTP 416）');
      if (res.status !== 200 && res.status !== 206) throw await this.responseError('WebDAV Range 读取', res);
      const contentRange = res.headers['content-range'];
      if (res.status === 206) {
        const match = contentRange === undefined ? null : /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
        if (!match || Number(match[1]) !== offset || Number(match[2]) !== end
          || (match[3] !== '*' && Number(match[3]) <= end)) {
          throw new CloudStorageError('Network', `WebDAV Range 响应区间不匹配或越界: ${contentRange}`);
        }
      }
      const budget = res.status === 206 ? length : MEMORY_GET_DEFAULT_BUDGET_BYTES;
      ensureDeclaredLenWithinBudget('WebDAV', key, res.contentLength, budget);
      const body = new BoundedMemoryBody('WebDAV', key, budget);
      for await (const chunk of res.chunks(BODY_STALL_TIMEOUT_MS, 'WebDAV Range 读取停滞')) body.push(chunk);
      ensureMemoryGetMatchesDeclaredLen('WebDAV', key, body.len(), res.contentLength);
      if ((res.status === 206 && body.len() !== length) || body.len() < (res.status === 206 ? length : offset + length)) {
        throw new CloudStorageError('Network', 'WebDAV Range 返回长度不匹配或请求越界');
      }
      const bytes = body.intoBytes();
      return res.status === 206 ? bytes : bytes.slice(offset, offset + length);
    } finally { res.discard(); }
  }

  override async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> {
    const res = await this.request('GET', key, null);
    if (res.status === 404) { res.discard(); return null; }
    if (res.status < 200 || res.status >= 300) {
      try { throw new CloudStorageError('Network', `WebDAV 下载失败: ${res.status} ${res.statusText}`); }
      finally { res.discard(); }
    }
    const declared = res.contentLength;
    try {
      ensureDeclaredLenWithinBudget('WebDAV', key, declared, maxBytes);
      const body = new BoundedMemoryBody('WebDAV', key, maxBytes);
      for await (const chunk of res.chunks(MEMORY_GET_STALL_SECS * 1000, 'WebDAV 内存对象下载停滞超过 90 秒，连接可能已断开')) body.push(chunk);
      ensureMemoryGetMatchesDeclaredLen('WebDAV', key, body.len(), declared);
      return body.intoBytes();
    } finally { res.discard(); }
  }

  async list(prefix: string): Promise<FileInfo[]> {
    return (await this.listOutcome(prefix)).files;
  }

  override async listOutcome(prefix: string): Promise<ListOutcome> {
    const startPath = prefix ? prefix.replace(/^\/+|\/+$/g, '') : '';
    const allFiles: FileInfo[] = [];
    const dirsToVisit: string[] = [startPath];
    const MAX_DIRS = 200;
    let visited = 0;
    let truncated = false;

    while (dirsToVisit.length) {
      const dir = dirsToVisit.pop()!;
      visited += 1;
      if (visited > MAX_DIRS) {
        defaultLogSink().warn(`[WebDAV] 递归列举已访问 ${MAX_DIRS} 个目录，停止遍历以防异常`);
        truncated = true;
        break;
      }
      const dirWithSlash = !dir || dir.endsWith('/') ? dir : `${dir}/`;
      const url = this.buildUrl(dirWithSlash);
      const xml = await this.propfindWithRetry(url, '1', dirWithSlash);
      if (xml === null) continue;
      const { files, subdirs, responseCount } = this.parsePropfindEntries(xml, prefix, dir);
      if (isSuspiciousResponseCount(responseCount)) {
        defaultLogSink().error(
          `[WebDAV] PROPFIND 返回 ${responseCount} 个 response（疑似服务端分页上限），目录 '${dir}' 下可能有未列出的文件`,
        );
        truncated = true;
      }
      allFiles.push(...files);
      dirsToVisit.push(...subdirs);
    }

    allFiles.sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified));
    return { files: allFiles, truncated };
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key, null);
    try {
      if (res.status >= 200 && res.status < 300) return;
      if (res.status === 404) return;
      throw new CloudStorageError('Network', `WebDAV 删除失败: ${res.status} ${res.statusText}`);
    } finally { res.discard(); }
  }

  async stat(key: string): Promise<FileInfo | null> {
    const url = this.buildUrl(key);
    const xml = await this.propfindWithRetry(url, '0', key);
    if (xml === null) return null;
    return this.parsePropfindResponse(xml, '')[0] ?? null;
  }
}
