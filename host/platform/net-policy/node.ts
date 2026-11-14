/**
 * `net_policy` / `fetch.rs` 中需要 Host 能力（DNS 解析）的部分，仅桌面。
 *
 * 可移植入口是 `./index.ts`（纯 URL/IP 判定）；本文件保留 `isSafeRemoteUrl` 与
 * `fetchBinaryWithCache`。移动端没有 DNS 解析，http 策略层对 `destination: 'public'` 失败关闭。
 */
import { lookup } from 'node:dns/promises';
import { isBlockedInternalIp, parseIp } from './ip.ts';

/**
 * `dstu-util/src/utils/fetch.rs::is_safe_remote_url`。
 *
 * 只允许 http/https；IPv4/IPv6 字面量直接按 `is_blocked_internal_ip` 判定；
 * 域名先解析全部地址，任一地址被封锁即失败关闭（DNS 失败也返回 false）。
 * Rust 的 `to_socket_addrs` 是同步的，Node 侧用 `dns.lookup` 的 Promise API。
 */
export async function isSafeRemoteUrl(url: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // url crate 对 IPv6 host 的序列化带方括号；Node `URL.hostname` 同样保留。
  let host = parsed.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === '') return false;

  const literal = parseIp(host);
  if (literal !== null) return !isBlockedInternalIp(literal);

  const port = parsed.port === ''
    ? (parsed.protocol === 'https:' ? 443 : 80)
    : Number(parsed.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return false;

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true, verbatim: true });
  } catch {
    return false;
  }
  if (resolved.length === 0) return false;
  return resolved.every(entry => !isBlockedInternalIp(entry.address));
}

export interface CachedBinary {
  readonly bytes: Uint8Array;
  readonly mimeType: string | null;
}

const binaryCache = new Map<string, CachedBinary>();

/**
 * `dstu-util/src/utils/fetch.rs::fetch_binary_with_cache`。
 *
 * 先过 SSRF 判定；命中内存缓存直接返回。请求固定 10 秒超时、不跟随重定向，
 * 非 2xx、传输失败或超时都返回 null（Rust 的 `Option::None`）。
 */
export async function fetchBinaryWithCache(url: string): Promise<CachedBinary | null> {
  if (!(await isSafeRemoteUrl(url))) return null;
  const cached = binaryCache.get(url);
  if (cached !== undefined) return cached;
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      // Unlike dropping Rust's Response, returning does not release a fetch body.
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    const result: CachedBinary = {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type'),
    };
    binaryCache.set(url, result);
    return result;
  } catch {
    return null;
  }
}
