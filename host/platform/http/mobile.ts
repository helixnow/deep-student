/**
 * Worker fetch with Android native transport for CORS fallback and DNS-pinned requests.
 *
 * Requests made from the Host Worker are subject to the WebView Worker's CORS policy: providers
 * without permissive CORS headers (some LLM endpoints), LAN services (Ollama, AnkiConnect, WebDAV)
 * and native-only destinations fail with an opaque `TypeError`. When the shell can answer
 * native HTTP, Android retries with its streaming bridge. Other shells may use the older buffered
 * Capacitor fallback. Worker-supported requests stay on the Worker transport.
 */
import { definePlugin } from '../../kernel/core.ts';
import { parseIp } from '../net-policy/ip.ts';
import { HttpError, type HttpBody, type HttpHeaders, type HttpRequestInit, type HttpService } from './api.ts';
import { publicPinnedUnsupported, resolvePinnedAddress } from './pinned-policy.ts';

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
type ShellHttpHead = Omit<ShellHttpResponse, 'body'>;
type NativeChunk = { done: true } | { done: false; bytes: Uint8Array };
const redirects = new Set([301, 302, 303, 307, 308]);
const credentials = ['authorization', 'cookie', 'cookie2', 'proxy-authorization', 'www-authenticate', 'x-api-key', 'api-key', 'x-goog-api-key'];

function addressBytes(address: string): Uint8Array {
  const parsed = parseIp(address);
  if (parsed === null) throw new TypeError('Invalid pinned IP address');
  return parsed.version === 4 ? Uint8Array.from(parsed.octets)
    : Uint8Array.from(parsed.segments.flatMap(value => [value >>> 8, value & 255]));
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
async function serializeBody(body: HttpBody | null | undefined): Promise<{ value: unknown; contentType?: string } | null> {
  if (body === undefined || body === null) return { value: undefined };
  if (typeof body === 'string') return { value: body, contentType: 'text/plain;charset=UTF-8' };
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return { value: body, contentType: 'application/octet-stream' };
  if (body instanceof URLSearchParams) return { value: body.toString(), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  if (body instanceof Blob || body instanceof FormData) {
    // FormData is not structured-cloneable. Let WebView encode it, including its generated boundary.
    const encoded = new Response(body);
    return { value: new Uint8Array(await encoded.arrayBuffer()), contentType: encoded.headers.get('content-type') ?? 'application/octet-stream' };
  }
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
  const result = new Response(payload, {
    status: safeStatus,
    ...(response.statusText ? { statusText: response.statusText } : {}),
    headers: response.headers ?? {},
  });
  Object.defineProperty(result, 'url', { value: response.url });
  return result;
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
  let androidAvailable: Promise<boolean> | undefined;
  const hasAndroid = (): Promise<boolean> => androidAvailable ??= shell?.request<boolean>('http.android.available')
    .then(value => value === true, () => false) ?? Promise.resolve(false);
  const resolveAndroid = async (host: string) => {
    const result = await shell!.request<{ addresses: string[] }>('http.android.resolve', { host });
    return result.addresses.map(address => ({ address }));
  };

  async function androidHop(url: string, init: HttpRequestInit, address?: string): Promise<Response> {
    const bridge = shell!;
    const signal = init.signal;
    signal?.throwIfAborted();
    const upload = init.body instanceof ReadableStream ? init.body.getReader() : null;
    const payload = upload ? null : await serializeBody(init.body);
    if (upload === null && payload === null) throw new TypeError('Unsupported HTTP request body');
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    const headers = normalizeHeaders(init.headers) ?? {};
    if (payload?.contentType && !headers['content-type']) headers['content-type'] = payload.contentType;
    const networkError = (cause: unknown): unknown => signal?.aborted ? signal.reason
      : new TypeError(cause instanceof Error ? cause.message : String(cause), { cause });
    let closed = false;
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const close = (): void => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener('abort', onAbort);
      void bridge.request('http.android.cancel', { id }).catch(() => undefined);
    };
    const onAbort = (): void => {
      bodyController?.error(signal?.reason);
      void upload?.cancel(signal?.reason).catch(() => undefined);
      close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const opening = bridge.request<ShellHttpHead>('http.android.open', {
      id, url, method: init.method ?? 'GET', headers, timeoutMs: init.timeoutMs ?? null,
      ...(address === undefined ? {} : { address: addressBytes(address) }),
      ...(payload?.value === undefined ? {} : { body: payload.value }),
      ...(upload === null ? {} : { uploadStream: true }),
    });
    const sending = (async () => {
      if (upload === null) return;
      try {
        for (;;) {
          const next = await upload.read();
          if (next.done) break;
          for (let offset = 0; offset < next.value.length; offset += 64 * 1024) {
            await bridge.request('http.android.write', { id, bytes: next.value.subarray(offset, offset + 64 * 1024) });
          }
        }
        signal?.throwIfAborted();
        await bridge.request('http.android.write', { id });
      } finally { upload.releaseLock(); }
    })();
    let head: ShellHttpHead;
    try {
      const ready = Promise.all([opening, sending]);
      [head] = signal ? await raceAbort(ready, signal) : await ready;
    } catch (error) { void upload?.cancel(error).catch(() => undefined); close(); throw networkError(error); }
    const empty = init.method === 'HEAD' || head.status === 204 || head.status === 205 || head.status === 304;
    if (empty) close();
    const body = empty ? null : new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; },
      async pull(controller) {
        try {
          const chunk = await bridge.request<NativeChunk>('http.android.read', { id });
          if (closed) return;
          if (chunk.done) { controller.close(); close(); }
          else controller.enqueue(chunk.bytes);
        } catch (error) { if (!closed) { controller.error(networkError(error)); close(); } }
      },
      cancel() { close(); },
    }, { highWaterMark: 0 });
    try {
      const response = new Response(body, { status: head.status, statusText: head.statusText, headers: head.headers });
      Object.defineProperty(response, 'url', { value: head.url });
      return response;
    } catch (error) { close(); throw error; }
  }

  async function androidFetch(url: URL, init: HttpRequestInit): Promise<Response> {
    const policy = init.destination !== undefined && init.destination !== 'any';
    const redirect = init.redirect ?? 'follow';
    const headers = normalizeHeaders(init.headers) ?? {};
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    let current = url;
    for (let hops = 0; ; hops++) {
      if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new HttpError('RedirectBlocked', current.href, 'redirect to unsupported scheme');
      if (current.username || current.password) throw new HttpError('InvalidUrl', current.origin, 'HTTP URLs cannot contain credentials');
      const resolution = policy ? resolvePinnedAddress(current.href, init.allowLoopback ?? (init.destination === 'public'), resolveAndroid) : undefined;
      const address = resolution === undefined ? undefined : init.signal ? await raceAbort(resolution, init.signal) : await resolution;
      const response = await androidHop(current.href, { ...init, headers, body, method }, address);
      const location = response.headers.get('location');
      if (redirect === 'manual' || !redirects.has(response.status) || location === null) return response;
      let next: URL;
      try { next = new URL(location, current); }
      catch { return response; }
      await response.body?.cancel();
      if (redirect === 'error') throw new TypeError('unexpected redirect');
      if (hops >= 9 || (policy && method !== 'GET' && method !== 'HEAD')) {
        throw new HttpError('RedirectBlocked', current.href, 'refusing to follow this redirect');
      }
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        if (method !== 'HEAD') method = 'GET';
        body = null;
        for (const name of ['content-type', 'content-length', 'content-encoding', 'transfer-encoding']) Reflect.deleteProperty(headers, name);
      } else if (body instanceof ReadableStream) {
        throw new HttpError('RedirectBlocked', current.href, 'Cannot replay a streaming upload on redirect');
      }
      if (next.origin !== current.origin) for (const name of credentials) Reflect.deleteProperty(headers, name);
      current = next;
    }
  }

  /** 外部 http/https 请求在 Worker 里失败时，改由主线程发。 */
  const fetchViaShell = async (url: string, init: HttpRequestInit, timeout: number | null): Promise<Response> => {
    if (!shell) throw new Error('no shell transport');
    if (init.signal?.aborted) throw init.signal.reason;
    const serialized = await serializeBody(init.body);
    if (serialized === null) throw new HttpError('UnsupportedOnPlatform', url,
      'UNSUPPORTED_ON_PLATFORM: streaming request bodies cannot be replayed on the mobile main thread',
      { capability: 'http.request.stream.body', platform: 'mobile' });
    if (init.signal?.aborted) throw init.signal.reason;
    const headers = normalizeHeaders(init.headers) ?? {};
    if (serialized.contentType && !headers['content-type']) headers['content-type'] = serialized.contentType;
    const pending = shell.request<ShellHttpResponse>('http.fetch', {
      url,
      method: init.method ?? 'GET',
      headers,
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
    const timeout = init.timeoutMs === undefined ? 300_000 : init.timeoutMs;
    if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) throw new RangeError('timeoutMs must be positive or null');
    const signal = timeout === null ? init.signal
      : AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeout)]);
    if (init.destination !== undefined && init.destination !== 'any') {
      if (!(await hasAndroid())) throw publicPinnedUnsupported(url.href, 'mobile');
      return androidFetch(url, { ...init, signal, timeoutMs: timeout });
    }
    // Browser manual redirects are opaque, and a streaming upload cannot be retried once consumed.
    if ((init.redirect === 'manual' || init.body instanceof ReadableStream) && await hasAndroid()) {
      return androidFetch(url, { ...init, signal, timeoutMs: timeout });
    }
    const requestInit = {
      method: init.method, headers: init.headers as HeadersInit | undefined,
      body: init.body as BodyInit | null | undefined, signal, redirect: init.redirect,
      ...(init.body instanceof ReadableStream ? { duplex: 'half' } : {}),
    };
    try {
      return await transport(url, requestInit);
    } catch (error) {
      if (shell === undefined || !isNetworkFailure(error) || signal?.aborted) throw error;
      // 主线程会用同一 URL/头/体重发，Worker 侧 CORS 限制因此不再影响这些端点。
      return await hasAndroid() ? androidFetch(url, { ...init, signal, timeoutMs: timeout })
        : fetchViaShell(url.href, { ...init, signal }, timeout);
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
    async isPublicUrl(input) {
      try {
        const url = new URL(input);
        if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !await hasAndroid()) return false;
        await resolvePinnedAddress(url.href, true, resolveAndroid);
        return true;
      } catch { return false; }
    },
    async checkPublicPinned(input, options = {}) {
      if (!await hasAndroid()) throw publicPinnedUnsupported(String(input), 'mobile');
      let url: URL;
      try { url = new URL(input); }
      catch { throw new HttpError('InvalidUrl', String(input), 'invalid HTTP URL'); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError('InvalidUrl', url.href, 'invalid HTTP scheme');
      return { address: await resolvePinnedAddress(url.href, options.allowLoopback ?? false, resolveAndroid) };
    },
  };
}

export default definePlugin({
  meta: { id: 'dstu.platform.http', provides: ['http'], platforms: ['mobile'] },
  apply(ctx) { ctx.reflect.provide('http', createMobileHttp({ shell: ctx.shell })); },
});
