/**
 * HTTP/1.1 client used by the WebDAV and S3 transports.
 *
 * Replaces `reqwest` (webdav.rs, s3.rs) with the Host `ctx.http` service (proxy and
 * connect-timeout policy owned by `host/platform/http`). The behaviours the Rust call
 * sites depend on are preserved:
 * - response headers arrive before the body, so callers can inspect status/headers
 *   and then stream the body with a per-chunk stall timeout;
 * - request bodies are either bytes (retryable, since they can be re-sent) or a
 *   factory that produces a fresh stream per attempt (file uploads);
 * - request bodies always carry an explicit `Content-Length`, because sabre-dav
 *   based servers drop chunked PUTs (webdav.rs:1209); bodiless requests carry none,
 *   like reqwest;
 * - redirects follow reqwest 0.11's default policy: at most 10 hops, 301/302/303
 *   turn non-GET/HEAD into GET and drop the body, 307/308 preserve a re-sendable
 *   body but are not followed for streaming bodies, and sensitive headers are
 *   removed on cross-host hops (redirect.rs:234, client.rs:2357).
 */

import type { HttpService } from '../../../platform/http/api.ts';
import { canonicalReason as statusReason, decodeUtf8Lossy } from '../../../platform/util/portable.ts';
import { CloudStorageError } from './errors.ts';

export const HEADER_TIMEOUT_MS = 120_000;
export const BODY_STALL_TIMEOUT_MS = 90_000;
/** reqwest `redirect::Policy::default()` = `limited(10)`. */
export const MAX_REDIRECTS = 10;
/** Largest timer delay; `ctx.http` would otherwise cut every request (body included) at 300 s. */
export const NO_WHOLE_REQUEST_TIMEOUT_MS = 2_147_483_647;

export type HttpFetch = Pick<HttpService, 'fetch'>;

let httpLookup: (() => HttpService | undefined) | null = null;
let directHttp: HttpFetch | undefined;

/** Called by the plugin (`ctx.get('http')`); hosts without the service and bare constructors use plain fetch. */
export function setHttpLookup(lookup: (() => HttpService | undefined) | null): void {
  httpLookup = lookup;
}

export function httpService(): HttpFetch {
  return httpLookup?.() ?? (directHttp ??= {
    // Same wire shape as the desktop transport minus proxies: no content decoding, no whole-request timer.
    fetch: (input, init = {}) => {
      const headers = new Headers(init.headers as HeadersInit | undefined);
      if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
      const body = init.body ?? null;
      return globalThis.fetch(input, {
        method: init.method, headers, body, signal: init.signal, redirect: init.redirect,
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
      } as RequestInit);
    },
  });
}

/** Where node:http `STATUS_CODES` (the former `statusText`) differs from Rust `canonical_reason`. */
const NODE_REASONS: Readonly<Record<number, string>> = {
  203: 'Non-Authoritative Information',
  418: "I'm a Teapot",
  509: 'Bandwidth Limit Exceeded',
};

export function canonicalReason(status: number): string {
  return NODE_REASONS[status] ?? statusReason(status) ?? '';
}

export interface RequestOptions {
  method: string;
  url: URL;
  headers?: Record<string, string>;
  /** Byte bodies are re-sendable across retries and 307/308 redirects. */
  body?: Uint8Array | null;
  /** Fresh stream per attempt (file uploads). Takes precedence over `body`. */
  bodyFactory?: (() => ReadableStream<Uint8Array>) | null;
  bodyLength?: number | null;
  /** Whole-request timeout in ms (covers body upload). Default: headers only. */
  totalTimeoutMs?: number | null;
  /** Aborts the request (sync cancellation). */
  signal?: AbortSignal | null;
  /**
   * reqwest default is 10; `0` reproduces `redirect::Policy::none()` (aws-sdk-s3
   * does not follow HTTP redirects). Invalid `Location` values are never followed.
   */
  maxRedirects?: number;
}

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  contentLength: number | null;
  /** Iterate body chunks with a per-chunk stall timeout; `stallMessage` replaces the generic error text. */
  chunks(stallMs?: number, stallMessage?: string): AsyncGenerator<Uint8Array>;
  /** Read the whole body, refusing to buffer more than `maxBytes`. */
  text(maxBytes?: number, stallMs?: number): Promise<string>;
  bytes(maxBytes?: number, stallMs?: number): Promise<Uint8Array>;
  /** Stop reading and close the connection (used by prefix reads). */
  discard(): void;
}

export function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function effectivePort(url: URL): string {
  return url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80';
}

function crossHost(previous: URL, next: URL): boolean {
  return previous.hostname !== next.hostname || effectivePort(previous) !== effectivePort(next);
}

function removeHeaders(headers: Record<string, string>, names: readonly string[]): void {
  for (const key of Object.keys(headers)) {
    if (names.includes(key.toLowerCase())) delete headers[key];
  }
}

function tooLarge(maxBytes: number): CloudStorageError {
  return new CloudStorageError('Network', `响应体超过上限（${maxBytes} 字节），已中断`);
}

function concatBytes(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Wraps a response whose body was already buffered (S3 retry classification reads
 * the error body to inspect `Code`). Status/headers are preserved byte-for-byte.
 */
export function bufferedResponse(source: HttpResponse, body: Uint8Array): HttpResponse {
  return {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
    contentLength: source.contentLength,
    async *chunks() {
      if (body.byteLength > 0) yield body;
    },
    async text(maxBytes = Number.POSITIVE_INFINITY) {
      if (body.byteLength > maxBytes) throw tooLarge(maxBytes);
      return decodeUtf8Lossy(body);
    },
    async bytes(maxBytes = Number.POSITIVE_INFINITY) {
      if (body.byteLength > maxBytes) throw tooLarge(maxBytes);
      return body;
    },
    discard() {},
  };
}

/** Issue one HTTP request, following redirects with reqwest's default policy. */
export async function send(options: RequestOptions): Promise<HttpResponse> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let url = options.url;
  let method = options.method;
  let body = options.body ?? null;
  let bodyFactory = options.bodyFactory ?? null;
  let bodyLength = options.bodyLength ?? null;
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const history: URL[] = [];

  for (;;) {
    const response = await sendOnce({
      ...options,
      method,
      url,
      headers,
      body,
      bodyFactory,
      bodyLength,
    });
    if (!isRedirectStatus(response.status) || maxRedirects === 0) return response;

    const location = response.headers['location'];
    if (location === undefined) return response;

    // reqwest only follows 307/308 when the body is absent or a reusable buffer;
    // a streaming body (`Body::Some(None)`) is returned to the caller unchanged.
    if ((response.status === 307 || response.status === 308) && bodyFactory !== null) return response;

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      return response; // Invalid Location: reqwest logs and skips the redirect.
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      response.discard();
      throw new CloudStorageError('Network', `重定向目标协议不受支持: ${next.protocol}`);
    }

    history.push(url);
    if (history.length >= maxRedirects) {
      response.discard();
      throw new CloudStorageError('Network',
        `重定向次数超过上限（too many redirects，最多 ${maxRedirects} 次）: ${url.href}`);
    }

    response.discard();
    if (response.status === 301 || response.status === 302 || response.status === 303) {
      // reqwest: drop the body and its framing headers; non-GET/HEAD becomes GET.
      if (method !== 'GET' && method !== 'HEAD') method = 'GET';
      body = null;
      bodyFactory = null;
      bodyLength = null;
      removeHeaders(headers, ['content-length', 'content-encoding', 'content-type', 'transfer-encoding']);
    }
    if (crossHost(url, next)) {
      removeHeaders(headers, ['authorization', 'cookie', 'cookie2', 'proxy-authorization', 'www-authenticate']);
    }
    url = next;
  }
}

export type NetError = Error & { code?: string };

function socketClosed(message: string): NetError {
  return Object.assign(new Error(message), { code: 'ECONNRESET' });
}

/**
 * fetch reports transport failures as `TypeError('fetch failed' | 'terminated', { cause })`.
 * Callers interpolate `error.message`, so surface the socket error itself — the
 * same `connect ECONNREFUSED …` / `getaddrinfo ENOTFOUND …` text `node:http` produced.
 * `closedMessage` is node:http's text for a peer close: `socket hang up` before the
 * response headers, `aborted` while reading the body.
 */
export function transportError(error: unknown, closedMessage: 'socket hang up' | 'aborted'): unknown {
  if (!(error instanceof TypeError) || !(error.cause instanceof Error)) return error;
  const cause = error.cause as NetError;
  return cause.code === 'UND_ERR_SOCKET' ? socketClosed(closedMessage) : cause;
}

/** Issue exactly one HTTP request. Rejects only on transport-level failure. */
async function sendOnce(options: RequestOptions): Promise<HttpResponse> {
  const { url } = options;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CloudStorageError('Configuration', `不支持的协议: ${url.protocol}`);
  }

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const bodyLength = options.bodyFactory ? options.bodyLength ?? null : options.body ? options.body.byteLength : null;
  if (bodyLength !== null && headers['content-length'] === undefined) headers['content-length'] = String(bodyLength);

  const controller = new AbortController();
  let failure: CloudStorageError | null = null;
  // Cancellation also governs the response body; only the timers stop at headers.
  const fail = (error: CloudStorageError): void => {
    if (failure !== null) return;
    failure = error;
    controller.abort(error);
  };
  const onAbort = (): void => { fail(new CloudStorageError('Unknown', '云同步已取消')); };
  if (options.signal?.aborted) throw new CloudStorageError('Unknown', '云同步已取消');

  const headerTimer = setTimeout(() => {
    fail(new CloudStorageError('Network', `等待响应头超时（${Math.round(HEADER_TIMEOUT_MS / 1000)} 秒）`));
  }, HEADER_TIMEOUT_MS);
  unrefTimer(headerTimer);
  const totalTimeoutMs = options.totalTimeoutMs;
  const totalTimer = totalTimeoutMs == null ? null : setTimeout(() => {
    fail(new CloudStorageError('Network', `请求超时（${Math.round(totalTimeoutMs / 1000)} 秒）`));
  }, totalTimeoutMs);
  if (totalTimer !== null) unrefTimer(totalTimer);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  const body = options.bodyFactory ? options.bodyFactory() : options.body ?? null;
  let response: Response;
  try {
    response = await httpService().fetch(url, {
      method: options.method, headers, body, signal: controller.signal, redirect: 'manual', timeoutMs: NO_WHOLE_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    options.signal?.removeEventListener('abort', onAbort);
    if (body instanceof ReadableStream) body.cancel().catch(() => undefined);
    throw failure ?? transportError(error, 'socket hang up');
  } finally {
    clearTimeout(headerTimer);
    if (totalTimer !== null) clearTimeout(totalTimer);
  }
  return streamedResponse(response, controller, () => options.signal?.removeEventListener('abort', onAbort));
}

function streamedResponse(response: Response, controller: AbortController, cleanup: () => void): HttpResponse {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = key in headers ? `${headers[key]}, ${value}` : value; });
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const close = (): void => {
    cleanup();
    controller.abort();
    const pending = reader ? reader.cancel() : response.body?.cancel();
    pending?.catch(() => undefined);
  };
  if (response.body === null) cleanup();

  const self: HttpResponse = {
    status: response.status,
    statusText: canonicalReason(response.status),
    headers,
    contentLength: parseContentLength(headers['content-length']),
    async *chunks(stallMs = BODY_STALL_TIMEOUT_MS, stallMessage?: string) {
      try {
        if (response.body === null) return;
        reader ??= response.body.getReader();
        const current = reader;
        for (;;) {
          if (controller.signal.aborted) throw controller.signal.reason;
          let timer: ReturnType<typeof setTimeout> | null = null;
          let stalled: CloudStorageError | null = null;
          const stall = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              stalled = new CloudStorageError('Network', stallMessage ?? `读取响应体停滞超过 ${Math.round(stallMs / 1000)} 秒，连接可能已断开`);
              reject(stalled);
              close();
            }, stallMs);
            unrefTimer(timer);
          });
          let next: ReadableStreamReadResult<Uint8Array>;
          try {
            next = await Promise.race([current.read(), stall]);
          } catch (error) {
            throw stalled ?? (controller.signal.aborted ? controller.signal.reason : transportError(error, 'aborted'));
          } finally {
            if (timer !== null) clearTimeout(timer);
          }
          if (controller.signal.aborted) throw controller.signal.reason;
          if (next.done) return;
          yield next.value;
        }
      } finally { close(); }
    },
    async text(maxBytes = Number.POSITIVE_INFINITY, stallMs = BODY_STALL_TIMEOUT_MS) {
      return decodeUtf8Lossy(await self.bytes(maxBytes, stallMs));
    },
    async bytes(maxBytes = Number.POSITIVE_INFINITY, stallMs = BODY_STALL_TIMEOUT_MS) {
      const parts: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of self.chunks(stallMs)) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          close();
          throw tooLarge(maxBytes);
        }
        parts.push(chunk);
      }
      return concatBytes(parts, total);
    },
    discard: close,
  };
  return self;
}
