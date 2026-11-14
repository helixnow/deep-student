/**
 * `destination: 'public-pinned'` 的可移植部分：钉住哪个地址、拒绝哪些地址，以及其他平台的“不支持”错误。
 * 解析与连接在各平台的传输层里（桌面见 `pinned.ts`），它们都必须用这里的判定。
 * 只用 net-policy 的纯 IP 判定（`net-policy/ip.ts`），运行时闭包不含 Node 专有依赖。
 */
import { unsupportedOnPlatformMessage } from '../errors/unsupported-on-platform.ts';
import { isBlockedInternalIp, isLoopbackIp, parseIp } from '../net-policy/ip.ts';
import { HttpError } from './api.ts';

/** 平台能力清单中的 id。 */
export const PUBLIC_PINNED_CAPABILITY = 'http.destination.publicPinned';

/** 主机名解析（全部地址）。桌面为 `dns.lookup(host, { all: true, verbatim: true })`。 */
export type ResolveHost = (host: string) => Promise<ReadonlyArray<{ readonly address: string }>>;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** URL 主机名去掉 IPv6 方括号。 */
export function bareHostname(url: URL): string {
  const host = url.hostname;
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/** 主机名是 IP 字面量时直接返回它（不做解析）。 */
export function ipLiteral(host: string): string | null {
  return parseIp(host) === null ? null : host;
}

/**
 * 全部地址都必须允许连接（任一不允许即失败关闭，同 `isSafeRemoteUrl`），然后钉住第一个。
 * 不允许：私网、链路本地、元数据等非全局地址；回环除非 `allowLoopback`。
 */
export function pickPinnedAddress(url: string, addresses: readonly string[], allowLoopback: boolean): string {
  if (addresses.length === 0) {
    throw new HttpError('BlockedDestination', url, `DNS resolution returned no addresses for '${bareHostname(new URL(url))}'`, { reason: 'no-address' });
  }
  for (const address of addresses) {
    if (isBlockedInternalIp(address) || (!allowLoopback && isLoopbackIp(address)) || parseIp(address) === null) {
      throw new HttpError('BlockedDestination', url, `destination resolves to a non-public address ${address}`, { reason: 'blocked-address', address });
    }
  }
  return addresses[0]!;
}

/**
 * 解析 URL 主机并按 `pickPinnedAddress` 校验，返回要钉住的地址；IP 字面量不解析。钉住传输、`checkPublicPinned`
 * 与 `public` + `allowLoopback: false` 共用，错误相同（`BlockedDestination` + `dns-failed` / `no-address` / `blocked-address`）。
 */
export async function resolvePinnedAddress(url: string, allowLoopback: boolean, resolve: ResolveHost): Promise<string> {
  const host = bareHostname(new URL(url));
  const literal = ipLiteral(host);
  if (literal !== null) return pickPinnedAddress(url, [literal], allowLoopback);
  let addresses: string[];
  try {
    addresses = (await resolve(host)).map((entry) => entry.address);
  } catch (error) {
    throw new HttpError('BlockedDestination', url, `DNS resolution failed for '${host}': ${errorText(error)}`, { reason: 'dns-failed', cause: error });
  }
  return pickPinnedAddress(url, addresses, allowLoopback);
}

export function publicPinnedUnsupported(url: string, platform: string): HttpError {
  return new HttpError(
    'UnsupportedOnPlatform',
    url,
    unsupportedOnPlatformMessage(PUBLIC_PINNED_CAPABILITY, platform, 'connecting to a pre-validated IP needs a native transport'),
    { capability: PUBLIC_PINNED_CAPABILITY, platform },
  );
}
