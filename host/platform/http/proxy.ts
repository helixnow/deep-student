/**
 * 代理环境变量解析与 HTTP 代理请求（llm_manager/mod.rs
 * create_http_client_with_fallback 的代理语义）。
 *
 * Node 的全局 fetch 不读取 `HTTP_PROXY`；需要显式代理时，这里的绝对形式
 * 请求行与 Rust reqwest 的默认行为一致。环境变量全空时按 reqwest 0.11 读取
 * 系统代理（见 system-proxy.ts）。
 *
 * 由 llm 插件下沉至此（W14）：`plugins/llm/src/http_proxy.ts` 保留原名 re-export，并把创建日志接回 llm 日志出口。
 */
import { isIP } from 'node:net';
import { Agent, Pool, ProxyAgent, type Dispatcher } from 'undici';
import {
  createPlatformProxyReader, resolveSystemProxy, systemProxyBypassed, type PlatformProxyReader, type SystemProxy,
} from './system-proxy.ts';

export const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy',
] as const;

export type ProxyEnvironment = Record<string, string | undefined>;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function splitNoProxy(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => normalizeHost(entry)).filter((entry) => entry !== '');
}

function targetParts(targetUrl: string): URL {
  try {
    return new URL(targetUrl);
  } catch (error) {
    if (error instanceof TypeError) throw new Error(`invalid URL: ${targetUrl}`);
    throw error;
  }
}

function portOf(url: URL): string {
  if (url.port !== '') return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function matchesNoProxy(target: URL, entries: string[]): boolean {
  const host = normalizeHost(target.hostname).replace(/^\[|\]$/g, '');
  const targetPort = portOf(target);
  for (const entry of entries) {
    if (entry === '*') return true;
    // A bare IPv6 address (including ::1) has no port suffix; bracketed
    // addresses only have one when the closing bracket is followed by :port.
    const separator = isIP(entry) === 6 || entry.endsWith(']') ? -1 : entry.lastIndexOf(':');
    const entryHost = (separator > 0 ? entry.slice(0, separator) : entry).replace(/^\[|\]$/g, '');
    const entryPort = separator > 0 ? entry.slice(separator + 1) : null;
    if (entryPort !== null && entryPort !== targetPort) continue;
    if (entryHost.startsWith('.')) {
      if (host.endsWith(entryHost)) return true;
      continue;
    }
    if (host === entryHost || host.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

/** reqwest get_sys_proxies: the platform proxy is consulted only when no proxy variable is set at all. */
export function environmentDefinesProxy(env: ProxyEnvironment): boolean {
  return PROXY_ENV_KEYS.some(key => (env[key] ?? '').trim() !== '');
}

/** 目标 URL 是否应经代理；NO_PROXY 命中时返回 null。环境变量为空时使用系统代理（含系统例外列表）。 */
export function proxyUrlFor(targetUrl: string, env: ProxyEnvironment, system: SystemProxy | null = null): string | null {
  const target = targetParts(targetUrl);
  const noProxy = [
    ...splitNoProxy(env.NO_PROXY),
    ...splitNoProxy(env.no_proxy),
  ];
  if (noProxy.length > 0 && matchesNoProxy(target, noProxy)) return null;

  const candidates = target.protocol === 'https:'
    ? [env.HTTPS_PROXY, env.https_proxy, env.ALL_PROXY, env.all_proxy]
    : [env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy];
  for (const candidate of candidates) {
    const trimmed = (candidate ?? '').trim();
    if (trimmed !== '') return trimmed;
  }
  if (system === null || environmentDefinesProxy(env)) return null;
  const proxy = target.protocol === 'https:' ? system.https : system.http;
  return proxy === null || systemProxyBypassed(target.hostname, system.bypass) ? null : proxy;
}

/**
 * reqwest only has the whole-request `.timeout()` (enforced here through the request signal) and no header or body
 * read timeout, so undici's 300 s `headersTimeout` / `bodyTimeout` defaults are switched off on every dispatcher.
 */
export const NO_READ_TIMEOUTS = { headersTimeout: 0, bodyTimeout: 0 } as const;
const poolWithoutReadTimeouts = (origin: string | URL, options: object): Dispatcher =>
  new Pool(origin, { ...options, ...NO_READ_TIMEOUTS });

export interface ProxyHttpClient { fetch: typeof fetch; close(): Promise<void> }
/**
 * reqwest RequestBuilder::timeout overrides the manager's default timeout. `null` sends without a total timeout, like a
 * reqwest client built without `.timeout()`; the caller's `signal` (e.g. an idle watchdog) still applies.
 */
export interface ProxyRequestInit extends RequestInit { requestTimeoutMs?: number | null }
export interface ProxyClientLogger { info(message: string): void; warn(message: string): void }
export interface ProxyHttpClientOptions {
  /** Platform proxy lookup used when the environment defines no proxy (Windows registry / macOS scutil). */
  platformProxy?: PlatformProxyReader;
  /** Client-construction diagnostics (reqwest builder fallbacks). Defaults to stderr. */
  logger?: ProxyClientLogger;
}

const STDERR_LOGGER: ProxyClientLogger = {
  info: (message) => { process.stderr.write(`[INFO][dstu_http] ${message}\n`); },
  warn: (message) => { process.stderr.write(`[WARN][dstu_http] ${message}\n`); },
};

/** mod.rs:5549. Each manager owns its pool; no global dispatcher mutation. */
export function createProxyHttpClient(environment: ProxyEnvironment = process.env,
  clientOptions: ProxyHttpClientOptions = {}): ProxyHttpClient {
  const log = clientOptions.logger ?? STDERR_LOGGER;
  const env = { ...environment };
  const readPlatformProxy = clientOptions.platformProxy ?? createPlatformProxyReader();
  // reqwest SYS_PROXIES is a Lazy static: the platform is read once, on first use.
  let systemProxy: Promise<SystemProxy | null> | undefined;
  const resolveSystemProxyOnce = (): Promise<SystemProxy | null> => systemProxy ??= environmentDefinesProxy(env)
    ? Promise.resolve(null)
    : readPlatformProxy().then(settings => settings === null ? null : resolveSystemProxy(settings), () => null);
  let direct: Agent | undefined;
  let timeoutMs: number | undefined;
  let identity = true;
  const proxies = new Map<string, ProxyAgent>();
  const attempts = [
    { timeout: 300_000, connect: 30_000, message: '完整配置（超时120s，连接15s，rustls TLS）' },
    { timeout: 300_000, connect: 30_000, message: '简化TLS配置（超时120s，连接15s，系统TLS）' },
    { timeout: 300_000, connect: undefined, message: '仅超时配置（超时120s）' },
    { timeout: 180_000, connect: undefined, message: '最小配置（超时60s）' },
  ];
  let connectTimeout: number | undefined;
  for (const attempt of attempts) {
    try {
      direct = new Agent({ ...NO_READ_TIMEOUTS, connect: { timeout: attempt.connect, rejectUnauthorized: true } });
      timeoutMs = attempt.timeout;
      connectTimeout = attempt.connect;
      log.info(`HTTP客户端创建成功: ${attempt.message}`);
      break;
    } catch { // boundary-allow empty-catch: mod.rs:5561–5596 deliberately ignores build errors until final warnings
    }
  }
  if (direct === undefined) {
    log.warn('所有配置均失败，使用默认HTTP客户端（无超时配置）');
    log.warn('这可能导致网络请求挂起，建议检查系统网络和TLS配置');
    direct = new Agent(NO_READ_TIMEOUTS);
    identity = false;
  }
  const defaultAgent = direct;
  async function dispatcher(url: string): Promise<Dispatcher> {
    const proxy = proxyUrlFor(url, env, await resolveSystemProxyOnce());
    if (proxy === null) return defaultAgent;
    let agent = proxies.get(proxy);
    if (agent === undefined) {
      // `factory` also builds the plain-HTTP forwarding client and `clientFactory` the CONNECT client; undici hands
      // neither of them the agent's own options.
      agent = new ProxyAgent({ uri: proxy, proxyTunnel: false, ...NO_READ_TIMEOUTS,
        factory: poolWithoutReadTimeouts, clientFactory: poolWithoutReadTimeouts,
        connect: { timeout: connectTimeout },
        requestTls: { rejectUnauthorized: true }, proxyTls: { rejectUnauthorized: true } });
      proxies.set(proxy, agent);
    }
    return agent;
  }
  return {
    async fetch(input, init) {
      let url = input instanceof Request ? input.url : String(input);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      if (identity && !headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
      const suppliedSignal = init?.signal ?? (input instanceof Request ? input.signal : null);
      const override = (init as ProxyRequestInit | undefined)?.requestTimeoutMs;
      const requestTimeout = override === null ? undefined : override ?? timeoutMs;
      const signal = requestTimeout === undefined ? suppliedSignal : AbortSignal.any([
        ...(suppliedSignal ? [suppliedSignal] : []), AbortSignal.timeout(requestTimeout),
      ]);
      let method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      let body = init?.body ?? (input instanceof Request ? input.body : undefined);
      const redirect = init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
      for (let redirects = 0; ; redirects++) {
        const options: RequestInit & { dispatcher: Dispatcher; duplex?: 'half' } = {
          ...init, method, body, headers, signal, redirect: 'manual', dispatcher: await dispatcher(url),
          ...(body instanceof ReadableStream ? { duplex: 'half' as const } : {}),
        };
        const response = await globalThis.fetch(url, options);
        if (![301, 302, 303, 307, 308].includes(response.status) || redirect === 'manual') return response;
        const location = response.headers.get('location');
        if (location === null) return response;
        let next: URL;
        try { next = new URL(location, url); }
        catch { return response; } // reqwest returns the response for an invalid Location
        await response.body?.cancel();
        if (redirect === 'error') throw new TypeError('unexpected redirect');
        // reqwest Policy::limited(10) counts the initial URL in previous().
        if (redirects + 1 >= 10) throw new TypeError('too many redirects');
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new TypeError('URL scheme is not allowed');
        const previous = new URL(url);
        if (previous.hostname !== next.hostname || portOf(previous) !== portOf(next)) {
          for (const name of ['authorization', 'cookie', 'cookie2', 'proxy-authorization', 'www-authenticate']) headers.delete(name);
        }
        if ((response.status === 301 || response.status === 302) && method.toUpperCase() === 'POST'
          || response.status === 303 && method.toUpperCase() !== 'HEAD') {
          method = 'GET'; body = undefined;
          for (const name of ['content-length', 'content-type', 'content-encoding', 'transfer-encoding']) headers.delete(name);
        }
        if (!(previous.protocol === 'https:' && next.protocol === 'http:')) {
          previous.username = ''; previous.password = ''; previous.hash = '';
          headers.set('referer', previous.href);
        } else headers.delete('referer');
        url = next.href;
      }
    },
    async close() { await Promise.all([defaultAgent, ...proxies.values()].map(agent => agent.destroy())); },
  };
}
