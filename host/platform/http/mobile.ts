/**
 * Browser transport. Public/pinned destinations require DNS policy unavailable to a Web Worker.
 *
 * Requests made from the Host Worker are subject to the WebView Worker's CORS policy: providers
 * without permissive CORS headers (some LLM endpoints), LAN services (Ollama, AnkiConnect, WebDAV)
 * and native-only destinations fail with an opaque `TypeError`. When the shell can answer
 * `http.fetch`, those failures are retried on the main thread, where CapacitorHttp (or the
 * `CapacitorHttp.enabled`-patched `fetch`) bypasses CORS entirely. Streaming responses that the
 * Worker can read directly stay on the Worker transport, so ordinary chat streaming is unchanged.
 */
import { definePlugin } from '../../kernel/core.ts';
import { HttpError, type HttpBody, type HttpHeaders, type HttpRequestInit, type HttpService } from './api.ts';

function unsupported(url: string): never {
  throw new HttpError('UnsupportedOnPlatform', url,
    'UNSUPPORTED_ON_PLATFORM: http.destination.publicPolicy is not available on mobile',
    { capability: 'http.destination.publicPolicy', platform: 'mobile' });
}

/** `ctx.shell` 的 HTTP 子集；只依赖 `request`，测试可以传一个假实现。 */
export interface MobileHttpShell {
  request<R = unknown>(op: string, args?: unknown): Promise<R>;
}

export interface MobileHttpOptions {
  /** Worker 内的 fetch（默认全局 fetch）；测试注入假实现。 */
  readonly transport?: typeof globalThis.fetch;
  /** 有主线程代办能力时，CORS/网络失败会经 `http.fetch` 重试。 */
  readonly shell?: MobileHttpShell;
}

/** 主线程 `onShellRequest('http.fetch')` 的回复（`mobile/src/main.ts`）。 */
interface ShellHttpResponse {
  readonly url: string;
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: Record<string, string>;
  readonly body: Uint8Array;
}

function normalizeHeaders(headers: HttpHeaders | undefined): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  new Headers(headers as HeadersInit).forEach((value, name) => { out[name] = value; });
  return out;
}

/**
 * 把请求体转成可经 shell 传输的形态。`ReadableStream` 只能消费一次，Worker 端发不出去时
 * 无法重放，直接保留给调用方决定（返回 `null`）。
 */
async function serializeBody(body: HttpBody | null | undefined): Promise<{ value: unknown } | null> {
  if (body === undefined || body === null) return { value: undefined };
  if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) return { value: body };
  if (typeof Blob !== 'undefined' && body instanceof Blob) return { value: new Uint8Array(await body.arrayBuffer()) };
  if (body instanceof URLSearchParams) return { value: body.toString() };
  if (typeof FormData !== 'undefined' && body instanceof FormData) return { value: body };
  return null;
}

function isNetworkFailure(error: unknown): boolean {
  // Worker fetch 对 CORS / DNS / 连接失败统一抛 TypeError（`Failed to fetch`）。
  return error instanceof TypeError && (error as { name?: string }).name !== 'HttpError';
}

function shellResponse(response: ShellHttpResponse): Response {
  const status = response.status;
  const nullBody = status === 101 || status === 204 || status === 205 || status === 304;
  // Response 不接受 0（不透明响应）和 null-body 状态码带体。
  const safeStatus = status >= 200 && status <= 599 ? status : 599;
  const body = nullBody || status < 200 ? null : response.body;
  // TS 5.7+ 的 BodyInit 只接受普通 ArrayBuffer 上的视图；这里转发同一份响应字节，不复制。
  const payload = body === null ? null : new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength);
  return new Response(payload, {
    status: safeStatus,
    ...(response.statusText ? { statusText: response.statusText } : {}),
    headers: response.headers ?? {},
  });
}

/** 等 `pending`，但 `signal` 中止时立刻以 `signal.reason` 拒绝。 */
function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

export function createMobileHttp(options: MobileHttpOptions | typeof globalThis.fetch = {}): HttpService {
  const config: MobileHttpOptions = typeof options === 'function' ? { transport: options } : options;
  const transport = config.transport ?? globalThis.fetch.bind(globalThis);
  const shell = config.shell;

  /** 外部 http/https 请求在 Worker 里失败时，改由主线程发。 */
  const fetchViaShell = async (url: string, init: HttpRequestInit, timeout: number | null): Promise<Response> => {
    if (!shell) throw new Error('no shell transport');
    if (init.signal?.aborted) throw init.signal.reason;
    const serialized = await serializeBody(init.body);
    if (serialized === null) throw new HttpError('UnsupportedOnPlatform', url,
      'UNSUPPORTED_ON_PLATFORM: streaming request bodies cannot be replayed on the mobile main thread',
      { capability: 'http.request.stream.body', platform: 'mobile' });
    const pending = shell.request<ShellHttpResponse>('http.fetch', {
      url,
      method: init.method ?? 'GET',
      headers: normalizeHeaders(init.headers) ?? {},
      ...(serialized.value === undefined ? {} : { body: serialized.value }),
      timeoutMs: timeout,
      redirect: init.redirect ?? 'follow',
    });
    // 主线程的请求不能取消；调用方中止时至少让 Worker 侧立即结束等待（停止生成/切换会话）。
    const answer = init.signal === undefined ? await pending : await raceAbort(pending, init.signal);
    return shellResponse(answer);
  };

  const fetch: HttpService['fetch'] = async (input, init: HttpRequestInit = {}) => {
    let url: URL;
    try { url = new URL(input); }
    catch { throw new HttpError('InvalidUrl', String(input), 'invalid HTTP URL'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new HttpError('InvalidUrl', url.href, `unsupported scheme ${url.protocol}`);
    }
    if (init.destination !== undefined && init.destination !== 'any') unsupported(url.href);
    const timeout = init.timeoutMs === undefined ? 300_000 : init.timeoutMs;
    if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) throw new RangeError('timeoutMs must be positive or null');
    const signal = timeout === null ? init.signal
      : AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeout)]);
    const requestInit = {
      method: init.method, headers: init.headers as HeadersInit | undefined,
      body: init.body as BodyInit | null | undefined, signal, redirect: init.redirect,
    };
    try {
      return await transport(url, requestInit);
    } catch (error) {
      if (shell === undefined || !isNetworkFailure(error) || signal?.aborted) throw error;
      // 主线程会用同一 URL/头/体重发，Worker 侧 CORS 限制因此不再影响这些端点。
      return fetchViaShell(url.href, init, timeout);
    }
  };

  return {
    fetch,
    async fetchBytes(input, init = {}) {
      const limit = init.maxBytes;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('maxBytes must be a non-negative safe integer');
      const response = await fetch(input, init);
      const tooLarge = () => new HttpError('TooLarge', String(input), `response body exceeds ${limit} bytes`);
      if (limit !== undefined && Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw tooLarge();
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        if (reader) for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (limit !== undefined && size > limit) { await reader.cancel(); throw tooLarge(); }
          chunks.push(next.value);
        }
      } finally { reader?.releaseLock(); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return { url: response.url || String(input), status: response.status, ok: response.ok,
        headers: Object.fromEntries(response.headers), bytes };
    },
    async isPublicUrl() { return false; },
    async checkPublicPinned(input) { return unsupported(String(input)); },
  };
}

export default definePlugin({
  meta: { id: 'dstu.platform.http', provides: ['http'], platforms: ['mobile'] },
  apply(ctx) { ctx.reflect.provide('http', createMobileHttp({ shell: ctx.shell })); },
});
