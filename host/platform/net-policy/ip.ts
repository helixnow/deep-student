/**
 * `crates/dstu-core/src/net_policy.rs` 的纯 IP 判定（可移植：不依赖 Node，移动端与 Worker Host 也能用）。
 * 需要 DNS 的 `isSafeRemoteUrl` 与 `fetchBinaryWithCache` 在 `index.ts`。
 *
 * 语义要点：
 * - `is_loopback_host` 只在 `[` 与 `]` 同时存在时剥括号，去掉**全部**尾部 `.`，
 *   按 ASCII 小写比较；`localhost` / `*.localhost` / 127.0.0.0/8 / ::1 /
 *   IPv4-mapped loopback 放行。
 * - `is_blocked_internal_ip = is_internal_ip && !is_loopback_ip`：
 *   本地服务（MCP 桥、开发服务器）是合法目标；私网、链路本地、云元数据仍封锁。
 * - IPv4 判定使用 Rust `Ipv4Addr::{is_unspecified,is_loopback,is_private,is_link_local,
 *   is_multicast,is_broadcast}` 加 CGNAT/文档网段/保留网段。
 * - IPv6 判定覆盖 ULA、link-local、site-local、discard-only、benchmarking、
 *   ORCHID、文档前缀、6to4、IPv4-compatible、NAT64、IPv4-mapped。
 */
import type { IpAddress, Ipv4Address, Ipv6Address } from './api.ts';

export type { IpAddress, Ipv4Address, Ipv6Address } from './api.ts';

function ipv4(octets: readonly [number, number, number, number]): Ipv4Address {
  return { version: 4, octets };
}

function ipv6(segments: readonly number[]): Ipv6Address {
  const [a, b, c, d, e, f, g, h] = segments;
  if (a === undefined || b === undefined || c === undefined || d === undefined
    || e === undefined || f === undefined || g === undefined || h === undefined) {
    throw new Error('IPv6 地址必须有 8 个分组');
  }
  return { version: 6, segments: [a, b, c, d, e, f, g, h] };
}

function parseIpv4(text: string): Ipv4Address | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (match === null) return null;
  const octets: number[] = [];
  for (const part of match.slice(1)) {
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return ipv4([a, b, c, d]);
}

function parseEmbeddedIpv4(text: string): number[] | null {
  const parsed = parseIpv4(text);
  if (parsed === null) return null;
  const [a, b, c, d] = parsed.octets;
  return [(a << 8) | b, (c << 8) | d];
}

function parseIpv6(text: string): Ipv6Address | null {
  if (text === '' || text.includes('%')) return null;
  let normalized = text;

  // Rust `Ipv6Addr::from_str` 只在末尾接受内嵌 IPv4（最后 32 位）。
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    if (lastColon < 0) return null;
    const embedded = parseEmbeddedIpv4(normalized.slice(lastColon + 1));
    if (embedded === null) return null;
    normalized = `${normalized.slice(0, lastColon + 1)}${embedded[0]!.toString(16)}:${embedded[1]!.toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const left = parseGroups(halves[0]!);
  const right = halves.length === 2 ? parseGroups(halves[1]!) : [];
  if (left === null || right === null) return null;
  const total = left.length + right.length;
  if (halves.length === 2) {
    // `::` 必须至少压缩一个 16 位分组。
    if (total > 7) return null;
    return ipv6([...left, ...new Array<number>(8 - total).fill(0), ...right]);
  }
  if (total !== 8) return null;
  return ipv6([...left, ...right]);
}

/** Rust `IpAddr::from_str`：只接受纯 IPv4/IPv6 字面量（无方括号、无 zone id）。 */
export function parseIp(text: string): IpAddress | null {
  return parseIpv4(text) ?? parseIpv6(text);
}

function ipv4FromSegments(high: number, low: number): Ipv4Address {
  return ipv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]);
}

function isNonGlobalIpv4(address: Ipv4Address): boolean {
  const [a, b, c, d] = address.octets;
  const unspecified = a === 0 && b === 0 && c === 0 && d === 0;
  const loopback = a === 127;
  const privateRange = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  const linkLocal = a === 169 && b === 254;
  const multicast = a >= 224 && a <= 239;
  const broadcast = a === 255 && b === 255 && c === 255 && d === 255;
  return unspecified
    || loopback
    || privateRange
    || linkLocal
    || multicast
    || broadcast
    || a === 0
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function mappedIpv4(address: Ipv6Address): Ipv4Address | null {
  const segments = address.segments;
  if (segments[0] !== 0 || segments[1] !== 0 || segments[2] !== 0 || segments[3] !== 0
    || segments[4] !== 0 || segments[5] !== 0xffff) return null;
  return ipv4FromSegments(segments[6]!, segments[7]!);
}

function asAddress(value: IpAddress | string): IpAddress | null {
  return typeof value === 'string' ? parseIp(value) : value;
}

/** Rust `IpAddr::is_loopback`（含 IPv4-mapped loopback）。 */
export function isLoopbackIp(value: IpAddress | string): boolean {
  const address = asAddress(value);
  if (address === null) return false;
  if (address.version === 4) return address.octets[0] === 127;
  const segments = address.segments;
  if (segments.every((segment, index) => segment === (index === 7 ? 1 : 0))) return true;
  const mapped = mappedIpv4(address);
  return mapped !== null && mapped.octets[0] === 127;
}

/** `is_loopback_host`：localhost、*.localhost、127/8、::1、映射 loopback。 */
export function isLoopbackHost(host: string): boolean {
  let normalized = host;
  if (normalized.startsWith('[') && normalized.endsWith(']')) normalized = normalized.slice(1, -1);
  normalized = normalized.replace(/\.+$/, '').replace(/[A-Z]/g, char => char.toLowerCase());
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;
  const parsed = parseIp(normalized);
  return parsed !== null && isLoopbackIp(parsed);
}

/** Rust `is_internal_ip`：非全局可路由地址（含 loopback）。 */
export function isInternalIp(value: IpAddress | string): boolean {
  const address = asAddress(value);
  if (address === null) return false;
  if (address.version === 4) return isNonGlobalIpv4(address);
  const segments = address.segments;
  const [s0, s1, s2, s3, s4, s5, s6, s7] = segments;
  const unspecified = segments.every(segment => segment === 0);
  const loopback = s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0 && s6 === 0 && s7 === 1;
  const multicast = (s0 & 0xff00) === 0xff00;
  return unspecified
    || loopback
    || multicast
    || (s0 & 0xfe00) === 0xfc00 // ULA fc00::/7
    || (s0 & 0xffc0) === 0xfe80 // link-local fe80::/10
    || (s0 & 0xffc0) === 0xfec0 // site-local fec0::/10
    || (s0 === 0x0100 && s1 === 0 && s2 === 0 && s3 === 0) // 100::/64 discard-only
    || (s0 === 0x2001 && s1 === 0x0002) // 2001:2::/48 benchmarking
    || (s0 === 0x2001 && (s1 & 0xfff0) === 0x0010) // ORCHIDv1
    || (s0 === 0x2001 && (s1 & 0xfff0) === 0x0020) // ORCHIDv2
    || (s0 === 0x2001 && s1 === 0x0db8) // documentation
    || (s0 & 0xfff0) === 0x3ff0
    || (s0 === 0x2002 && isNonGlobalIpv4(ipv4FromSegments(s1, s2))) // 6to4
    || (s0 === 0 && s1 === 0 && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0
      && isNonGlobalIpv4(ipv4FromSegments(s6, s7))) // IPv4-compatible ::a.b.c.d
    || (s0 === 0x0064 && s1 === 0xff9b && s2 === 0 && s3 === 0 && s4 === 0 && s5 === 0
      && isNonGlobalIpv4(ipv4FromSegments(s6, s7))) // NAT64 64:ff9b::/96
    || (mappedIpv4(address) !== null && isNonGlobalIpv4(mappedIpv4(address)!)); // IPv4-mapped
}

/** `is_blocked_internal_ip`：内网且非回环（回环放行本地服务）。 */
export function isBlockedInternalIp(value: IpAddress | string): boolean {
  return isInternalIp(value) && !isLoopbackIp(value);
}
