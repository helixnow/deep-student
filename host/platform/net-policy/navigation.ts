/**
 * 顶层导航策略（`crates/dstu-browser/src/browser/policy.rs`）与 Agent 私网硬拦截。
 *
 * 纯函数、无 I/O：browser 插件（`host/plugins/browser/src/policy.ts` 原样转出）与 Electron 外壳
 * （`electron/shell/browser-agent-guard.ts`）共用同一份判定，外壳不必依赖插件实现。
 */
import type { IpAddress, Ipv6Address } from './api.ts';
import { isInternalIp, isLoopbackHost, isLoopbackIp, parseIp } from './ip.ts';

export type NavigationDenyReason =
  | { readonly type: 'InvalidUrl' }
  | { readonly type: 'ForbiddenScheme'; readonly scheme: string }
  | { readonly type: 'NonLoopbackHttp' }
  | { readonly type: 'MissingHost' }
  | { readonly type: 'AgentPrivateNetwork' };

export const FORBIDDEN_SCHEMES: readonly string[] = [
  'file', 'javascript', 'data', 'blob', 'tauri', 'asset', 'ipc',
];

/** Test/helper constructor for an IPv6 address with exactly eight groups. */
export function ipv6(segments: readonly number[]): Ipv6Address {
  if (segments.length !== 8) throw new Error(`IPv6 needs 8 segments, got ${segments.length}`);
  return { version: 6, segments: [...segments] as unknown as Ipv6Address['segments'] };
}

type ParsedHost =
  | { readonly kind: 'domain'; readonly value: string }
  | { readonly kind: 'ip'; readonly address: IpAddress };

function parsedHost(url: URL): ParsedHost | null {
  const hostname = url.hostname;
  if (hostname === '') return null;
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const address = parseIp(hostname.slice(1, -1));
    return address === null ? { kind: 'domain', value: hostname } : { kind: 'ip', address };
  }
  const address = parseIp(hostname);
  if (address !== null) return { kind: 'ip', address };
  return { kind: 'domain', value: hostname };
}

function isLoopbackUrlHost(url: URL): boolean {
  const host = parsedHost(url);
  if (host === null) return false;
  if (host.kind === 'domain') return isLoopbackHost(host.value);
  return isLoopbackIp(host.address);
}

/** Agent-side hard block for private/internal targets. No DNS resolution. */
export function isBlockedForAgent(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return true; }
  const host = parsedHost(parsed);
  if (host === null) return true;
  if (host.kind === 'domain') {
    const normalized = host.value.replace(/\.+$/, '').toLowerCase();
    return normalized === 'localhost' || normalized.endsWith('.localhost');
  }
  return isInternalIp(host.address);
}

export function allowNavigation(url: string): NavigationDenyReason | null {
  return allowNavigationWithOptions(url, false);
}

export function allowNavigationWithOptions(url: string, allowInsecureHttp: boolean): NavigationDenyReason | null {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return { type: 'InvalidUrl' }; }
  const scheme = parsed.protocol.endsWith(':') ? parsed.protocol.slice(0, -1).toLowerCase() : parsed.protocol.toLowerCase();
  if (FORBIDDEN_SCHEMES.includes(scheme)) return { type: 'ForbiddenScheme', scheme };
  if (scheme === 'https') {
    if (parsed.hostname === '') return { type: 'MissingHost' };
    return null;
  }
  if (scheme === 'http') {
    if (parsed.hostname === '') return { type: 'MissingHost' };
    if (allowInsecureHttp || isLoopbackUrlHost(parsed)) return null;
    return { type: 'NonLoopbackHttp' };
  }
  return { type: 'ForbiddenScheme', scheme };
}

export function navigationDenyMessage(reason: NavigationDenyReason): string {
  switch (reason.type) {
    case 'InvalidUrl': return 'invalid URL';
    case 'ForbiddenScheme': return `scheme '${reason.scheme}' is not allowed for top-level navigation`;
    case 'NonLoopbackHttp': return 'http navigation is limited to loopback hosts';
    case 'MissingHost': return 'missing host';
    case 'AgentPrivateNetwork': return 'agent navigation to private/internal network is blocked';
  }
}
