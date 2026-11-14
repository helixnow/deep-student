/**
 * `ctx.http` 桌面实现与 Cordis 插件。接口见 ./api.ts，移动端方案见 ../API.md「http」。
 *
 * 分两层：
 * - 传输层：`createProxyHttpClient`（`proxy.ts` / `system-proxy.ts`，由 llm 插件下沉）——环境变量/系统代理、
 *   NO_PROXY 与系统例外、reqwest 风格的重定向与默认超时。llm 原路径保留 re-export。
 * - 策略层（本文件）：只接受 http/https、`timeoutMs` 覆盖整条重定向链、`destination: 'public'` 的逐跳
 *   SSRF 判定（net-policy `isSafeRemoteUrl`，`allowLoopback: false` 时再拒回环）、`public-pinned` 的逐跳重新钉住、
 *   `checkPublicPinned`、`fetchBytes` 的体积上限。
 * - 钉住 IP 的传输：`pinned.ts`（不走代理，见 PINNED.md）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { definePlugin } from '../../kernel/api.ts';
import { createProxyHttpClient, type ProxyClientLogger, type ProxyEnvironment, type ProxyHttpClient, type ProxyHttpClientOptions } from './proxy.ts';
import { isLoopbackHost } from '../net-policy/index.ts';
import { isSafeRemoteUrl } from '../net-policy/node.ts';
import { HttpError, type HttpBody, type HttpHeaders, type HttpRequestInit, type HttpService } from './api.ts';
import { createPinnedTransport, systemResolveHost, type PinnedTransport, type PinnedTransportOptions } from './pinned.ts';
import { bareHostname, publicPinnedUnsupported, resolvePinnedAddress, type ResolveHost } from './pinned-policy.ts';

export type * from './api.ts';
export { HttpError } from './api.ts';
export { postAllowlistedDirect, validateWebhookEndpoint } from './allowlisted-direct.ts';
export { createPinnedTransport, systemResolveHost, type PinnedTransport, type PinnedTransportInit, type PinnedTransportOptions, type ResolveHost } from './pinned.ts';
export { PUBLIC_PINNED_CAPABILITY, pickPinnedAddress, resolvePinnedAddress } from './pinned-policy.ts';

/** 传输层收到的请求；`requestTimeoutMs` 覆盖传输层默认超时，`null` 表示不设总超时。 */
export interface HttpTransportInit {
  readonly method: string;
  readonly headers: Headers;
  readonly body?: HttpBody | null;
  readonly signal?: AbortSignal;
  readonly redirect: 'follow' | 'manual' | 'error';
  readonly requestTimeoutMs?: number | null;
}

export type HttpTransport = (url: string, init: HttpTransportInit) => Promise<Response>;

export interface HttpServiceOptions {
  readonly transport: HttpTransport;
  /** 默认 net-policy `isSafeRemoteUrl`。 */
  readonly isPublicUrl?: (url: string) => Promise<boolean>;
  /** `destination: 'public-pinned'` 的传输；缺省时这类请求以 `UnsupportedOnPlatform` 拒绝。 */
  readonly pinnedTransport?: PinnedTransport;
  /**
   * 主机名解析，应与钉住传输用同一个。`checkPublicPinned` 需要它（与 `pinnedTransport` 缺一即 `UnsupportedOnPlatform`）；
   * `public` + `allowLoopback: false` 用它拒绝解析到回环的主机名，缺省时只判断 IP 字面量与 `localhost` 名。
   */
  readonly resolveHost?: ResolveHost;
  /** `UnsupportedOnPlatform` 错误里的平台名，默认 `this platform`。 */
  readonly platform?: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** reqwest `Policy::limited(10)`，与传输层一致。 */
const MAX_REDIRECTS = 10;
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'cookie2', 'proxy-authorization', 'www-authenticate'];

function parseHttpUrl(input: string | URL): URL {
  const text = String(input);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError('InvalidUrl', text, `invalid URL: ${text}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError('InvalidUrl', text, `only http and https URLs are supported, got ${url.protocol}`);
  }
  return url;
}

function toHeaders(headers: HttpHeaders | undefined): Headers {
  const out = new Headers();
  if (headers === undefined) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, name) => out.append(name, value));
  } else if (Array.isArray(headers)) {
    for (const [name, value] of headers as ReadonlyArray<readonly [string, string]>) out.append(name, value);
  } else {
    for (const [name, value] of Object.entries(headers as Readonly<Record<string, string>>)) out.append(name, value);
  }
  return out;
}

function headerRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((_value, name) => {
    out[name] = headers.get(name) ?? '';
  });
  return out;
}

export function createHttpService(options: HttpServiceOptions): HttpService {
  const transport = options.transport;
  const isPublicUrl = options.isPublicUrl ?? isSafeRemoteUrl;

  async function assertPublic(url: string, allowLoopback: boolean): Promise<void> {
    if (!(await isPublicUrl(url))) {
      throw new HttpError('BlockedDestination', url, 'destination is not a public address (private, link-local, metadata or unresolvable)');
    }
    if (allowLoopback) return;
    if (options.resolveHost !== undefined) {
      await resolvePinnedAddress(url, false, options.resolveHost);
      return;
    }
    const host = bareHostname(new URL(url));
    if (isLoopbackHost(host)) {
      throw new HttpError('BlockedDestination', url, `destination resolves to a non-public address ${host}`, { reason: 'blocked-address', address: host });
    }
  }

  async function fetchWithPolicy(input: string | URL, init: HttpRequestInit): Promise<Response> {
    const url = parseHttpUrl(input);
    const timeoutMs = init.timeoutMs;
    if (timeoutMs !== undefined && timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new RangeError(`timeoutMs must be a positive number or null, got ${timeoutMs}`);
    }
    const signal = timeoutMs === undefined || timeoutMs === null
      ? init.signal
      : AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(timeoutMs)]);
    const method = (init.method ?? 'GET').toUpperCase();
    const redirect = init.redirect ?? 'follow';
    const base = {
      method,
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(signal ? { signal } : {}),
      ...(timeoutMs !== undefined ? { requestTimeoutMs: timeoutMs } : {}),
    };
    const headers = toHeaders(init.headers);
    const destination = init.destination ?? 'any';
    if (destination === 'any') return transport(url.href, { ...base, headers, redirect });

    let send: (href: string) => Promise<Response>;
    const allowLoopback = init.allowLoopback ?? destination === 'public';
    if (destination === 'public-pinned') {
      const pinned = options.pinnedTransport;
      if (pinned === undefined) throw publicPinnedUnsupported(url.href, options.platform ?? 'this platform');
      send = (href) => pinned(href, { ...base, headers, redirect: 'manual', allowLoopback });
      if (redirect === 'manual') return send(url.href);
      if (redirect === 'error') {
        const response = await send(url.href);
        if (REDIRECT_STATUSES.has(response.status) && response.headers.has('location')) {
          await response.body?.cancel();
          throw new TypeError('unexpected redirect');
        }
        return response;
      }
    } else {
      await assertPublic(url.href, allowLoopback);
      if (redirect !== 'follow') return transport(url.href, { ...base, headers, redirect });
      send = (href) => transport(href, { ...base, headers, redirect: 'manual' });
    }
    let current = url;
    for (let hop = 0; ; hop++) {
      const response = await send(current.href);
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers.get('location');
      if (location === null) return response;
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        // reqwest 遇到无法解析的 Location 原样返回该响应。
        return response;
      }
      await response.body?.cancel();
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HttpError('RedirectBlocked', current.href, `refusing to follow a ${response.status} redirect for ${method} with destination "${destination}"`);
      }
      if (hop + 1 >= MAX_REDIRECTS) throw new HttpError('RedirectBlocked', current.href, 'too many redirects');
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new HttpError('RedirectBlocked', next.href, `redirect to unsupported scheme ${next.protocol}`);
      }
      if (destination === 'public') await assertPublic(next.href, allowLoopback);
      if (next.origin !== current.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
      current = next;
    }
  }

  const service: HttpService = {
    fetch: (input, init = {}) => fetchWithPolicy(input, init),

    async fetchBytes(input, init = {}) {
      const maxBytes = init.maxBytes;
      if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
        throw new RangeError(`maxBytes must be a non-negative safe integer, got ${maxBytes}`);
      }
      const response = await fetchWithPolicy(input, init);
      const finalUrl = response.url || String(input);
      const tooLarge = () => new HttpError('TooLarge', finalUrl, `response body exceeds ${maxBytes} bytes`);
      const declared = response.headers.get('content-length');
      if (maxBytes !== undefined && declared !== null && Number(declared) > maxBytes) {
        await response.body?.cancel();
        throw tooLarge();
      }
      const parts: Uint8Array[] = [];
      let total = 0;
      if (response.body !== null) {
        const reader = response.body.getReader();
        for (let next = await reader.read(); !next.done; next = await reader.read()) {
          total += next.value.length;
          if (maxBytes !== undefined && total > maxBytes) {
            await reader.cancel();
            throw tooLarge();
          }
          parts.push(next.value);
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
      }
      return { url: finalUrl, status: response.status, ok: response.ok, headers: headerRecord(response.headers), bytes };
    },

    isPublicUrl: (url) => isPublicUrl(url),

    async checkPublicPinned(input, checkOptions = {}) {
      const url = parseHttpUrl(input);
      if (options.pinnedTransport === undefined || options.resolveHost === undefined) {
        throw publicPinnedUnsupported(url.href, options.platform ?? 'this platform');
      }
      return { address: await resolvePinnedAddress(url.href, checkOptions.allowLoopback ?? false, options.resolveHost) };
    },
  };
  return service;
}

export interface DesktopHttpOptions {
  /** 代理环境变量，默认 `process.env`（首次请求时读取）。 */
  readonly env?: ProxyEnvironment;
  /** 系统代理读取器（macOS scutil / Windows 注册表），默认由 `system-proxy.ts` 提供。 */
  readonly platformProxy?: ProxyHttpClientOptions['platformProxy'];
  /** 传输层创建日志，默认写 stderr。 */
  readonly logger?: ProxyClientLogger;
  /** `public-pinned` 传输的解析器与 CA（测试注入用；默认系统解析与系统根证书）。 */
  readonly pinned?: PinnedTransportOptions;
}

/** 桌面 `ctx.http`：传输层在首次请求时创建（连接池随 `close()` 释放）。 */
export function createDesktopHttp(options: DesktopHttpOptions = {}): HttpService & { close(): Promise<void> } {
  let client: ProxyHttpClient | undefined;
  const connect = (): ProxyHttpClient => client ??= createProxyHttpClient(options.env ?? process.env, {
    ...(options.platformProxy ? { platformProxy: options.platformProxy } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const transport: HttpTransport = (url, init) => connect().fetch(url, {
    method: init.method,
    headers: init.headers,
    redirect: init.redirect,
    ...(init.body !== undefined && init.body !== null ? { body: init.body as RequestInit['body'] } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
    ...(init.requestTimeoutMs !== undefined ? { requestTimeoutMs: init.requestTimeoutMs } : {}),
  } as RequestInit);
  const resolveHost = options.pinned?.resolve ?? systemResolveHost;
  return {
    ...createHttpService({ transport, pinnedTransport: createPinnedTransport({ ...options.pinned, resolve: resolveHost }), resolveHost }),
    async close() {
      const current = client;
      client = undefined;
      await current?.close();
    },
  };
}

/** Cordis 插件：`ctx.http`（桌面）。无依赖；卸载时释放连接池。 */
export default definePlugin({
  meta: { id: 'dstu.platform.http', lane: 'W14-portable', provides: ['http'], platforms: ['desktop'] },
  apply(ctx: Context) {
    const log = ctx.logger('dstu_http::proxy');
    const service = createDesktopHttp({ logger: { info: (message) => log.info(message), warn: (message) => log.warn(message) } });
    ctx.effect(() => () => service.close());
    ctx.reflect.provide('http', {
      fetch: service.fetch,
      fetchBytes: service.fetchBytes,
      isPublicUrl: service.isPublicUrl,
      checkPublicPinned: service.checkPublicPinned,
    } satisfies HttpService);
  },
});
