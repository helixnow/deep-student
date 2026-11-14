/**
 * `destination: 'public-pinned'` 的桌面传输：解析主机名 → `pickPinnedAddress` 校验并选定地址 → 用只认该地址的
 * `lookup` 直连。每个请求一个 undici `Agent`，不复用连接池（池里的连接可能连着上一次解析的地址），也不经过任何
 * 代理（显式 dispatcher，环境变量与系统代理都不参与）。TLS 的 SNI 与证书校验、`Host` 头都来自 URL 主机名。
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import type { HttpTransportInit } from './index.ts';
import { resolvePinnedAddress, type ResolveHost } from './pinned-policy.ts';
import { NO_READ_TIMEOUTS } from './proxy.ts';

export type { ResolveHost };

/** 系统解析：与 net-policy `isSafeRemoteUrl` 相同的 `dns.lookup(all, verbatim)`。 */
export const systemResolveHost: ResolveHost = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface PinnedTransportInit extends HttpTransportInit {
  readonly allowLoopback: boolean;
}

export type PinnedTransport = (url: string, init: PinnedTransportInit) => Promise<Response>;

export interface PinnedTransportOptions {
  /** 默认 `dns.lookup(host, { all: true, verbatim: true })`（与 `isSafeRemoteUrl` 相同的系统解析）。 */
  readonly resolve?: ResolveHost;
  /** 追加信任的 CA（PEM），替代系统根证书；默认使用系统根证书。 */
  readonly ca?: string | readonly string[];
}

/** 与代理传输一致：请求默认 300 s、连接 30 s，没有响应头 / 响应体读超时。 */
const DEFAULT_TIMEOUT_MS = 300_000;
const CONNECT_TIMEOUT_MS = 30_000;

export function createPinnedTransport(options: PinnedTransportOptions = {}): PinnedTransport {
  const resolve = options.resolve ?? systemResolveHost;
  return async (url, init) => {
    const address = await resolvePinnedAddress(url, init.allowLoopback, resolve);
    const family = address.includes(':') ? 6 : 4;
    const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) (callback as (error: null, all: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
      else callback(null, address, family);
    };
    const agent = new Agent({
      ...NO_READ_TIMEOUTS,
      connect: { timeout: CONNECT_TIMEOUT_MS, rejectUnauthorized: true, lookup, ...(options.ca !== undefined ? { ca: options.ca as string | string[] } : {}) },
    });
    const headers = new Headers(init.headers);
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
    const signal = init.requestTimeoutMs === null ? init.signal
      : AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(init.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS)]);
    const body = init.body ?? undefined;
    try {
      const response = await globalThis.fetch(url, {
        method: init.method,
        headers,
        signal,
        redirect: 'manual',
        ...(body !== undefined ? { body: body as RequestInit['body'] } : {}),
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
        dispatcher: agent,
      } as RequestInit);
      // 等响应体读完或取消后关闭；之后的请求不会复用这条连接。
      void agent.close();
      return response;
    } catch (error) {
      void agent.destroy();
      throw error;
    }
  };
}
