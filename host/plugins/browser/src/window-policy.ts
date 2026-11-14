// Port of the pure navigation-policy parts of dstu-browser/src/browser/window.rs.
// Native Webview creation, page-load callbacks and the ready handshake need the F2 shell.

import {
  allowNavigationWithOptions, isBlockedForAgent, isInternalIp, navigationDenyMessage,
  parseIp, type IpAddress,
} from './policy.ts';
import { INIT_SCRIPT } from './bridge.ts';

export const BROWSER_CONTENT_LABEL = 'browser-content';
export const MAIN_WINDOW_LABEL = 'main';
export const SURFACE_HOST_EMBEDDED = 'embedded';
export const SURFACE_HOST_DETACHED = 'detached';
export const SURFACE_HOST_UNSUPPORTED = 'unsupported';
export const PROFILE_ROOT = 'browser-profiles';
export const DEFAULT_PROFILE_ID = 'default';
export const BRIDGE_INIT_SCRIPT_PLACEHOLDER = '/* ds-browser-bridge */';
export const DEFAULT_DATA_STORE_ID: readonly number[] = [
  0x64, 0x73, 0x2d, 0x62, 0x72, 0x6f, 0x77, 0x73,
  0x65, 0x72, 0x2d, 0x64, 0x65, 0x66, 0x61, 0x75,
];
export const MACOS_DESKTOP_SAFARI_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
export const DEFAULT_WIDTH = 960;
export const DEFAULT_HEIGHT = 720;
export const AGENT_DNS_TIMEOUT_MS = 2_000;
export const NATIVE_WEBVIEW_READY_TIMEOUT_MS = 2_000;

/**
 * Host resolution supplied by the native browser integration: resolved addresses, or the
 * `BoundedDnsResolver` failure reason. The Electron shell answers asynchronously.
 */
export type AgentHostResolver = (host: string, port: number) => IpAddress[] | string | Promise<IpAddress[] | string>;

export type NavigationPolicyListener = (policy: { agentPrivateNetworkGuard: boolean; agentAllowInsecureHttp: boolean }) => void;

export interface NavigationPolicyState {
  agentPrivateNetworkGuard: boolean;
  agentAllowInsecureHttp: boolean;
  resolver: AgentHostResolver | null;
  /** Native navigation hooks that mirror the shared state (Rust reads the `Arc` directly). */
  listeners: NavigationPolicyListener[];
}

export class NavigationPolicyHandle {
  private state: NavigationPolicyState;

  constructor(resolver: AgentHostResolver | null = null) {
    this.state = {
      agentPrivateNetworkGuard: false,
      agentAllowInsecureHttp: false,
      resolver,
      listeners: [],
    };
  }

  /** Called after every change (the initial state is off, which is also the native default); returns the disposer. */
  observe(listener: NavigationPolicyListener): () => void {
    this.state.listeners.push(listener);
    return () => {
      const index = this.state.listeners.indexOf(listener);
      if (index >= 0) this.state.listeners.splice(index, 1);
    };
  }

  private snapshot(): { agentPrivateNetworkGuard: boolean; agentAllowInsecureHttp: boolean } {
    return { agentPrivateNetworkGuard: this.state.agentPrivateNetworkGuard, agentAllowInsecureHttp: this.state.agentAllowInsecureHttp };
  }

  private update(key: 'agentPrivateNetworkGuard' | 'agentAllowInsecureHttp', enabled: boolean): void {
    if (this.state[key] === enabled) return;
    this.state[key] = enabled;
    const snapshot = this.snapshot();
    for (const listener of [...this.state.listeners]) listener(snapshot);
  }

  /** Rust `#[derive(Clone)]`: all clones share the same atomic policy state. */
  clone(): NavigationPolicyHandle {
    const copy = new NavigationPolicyHandle();
    copy.state = this.state;
    return copy;
  }

  setAgentPrivateNetworkGuard(enabled: boolean): void {
    this.update('agentPrivateNetworkGuard', enabled);
  }

  agentPrivateNetworkGuardEnabled(): boolean {
    return this.state.agentPrivateNetworkGuard;
  }

  setAgentAllowInsecureHttp(enabled: boolean): void {
    this.update('agentAllowInsecureHttp', enabled);
  }

  agentAllowInsecureHttpEnabled(): boolean {
    return this.state.agentAllowInsecureHttp;
  }

  validateAgentTarget(url: string): string | null | Promise<string | null> {
    if (!this.agentPrivateNetworkGuardEnabled()) return null;
    return this.validateAgentTargetForAgent(url);
  }

  /**
   * Unconditional preflight used before the service transitions to Agent control.
   * Synchronous unless a domain has to go through an asynchronous resolver.
   */
  validateAgentTargetForAgent(url: string): string | null | Promise<string | null> {
    if (isBlockedForAgent(url)) {
      return 'private/internal address literal is blocked for agent navigation';
    }
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { return 'private/internal address literal is blocked for agent navigation'; }
    const hostname = parsed.hostname;
    if (hostname === '') return 'missing host for agent navigation';
    const literal = hostname.startsWith('[') && hostname.endsWith(']')
      ? parseIp(hostname.slice(1, -1))
      : parseIp(hostname);
    if (literal !== null) return ensureResolvedAddressesArePublic([literal]);

    const port = parsed.port !== ''
      ? Number(parsed.port)
      : parsed.protocol === 'http:' ? 80 : parsed.protocol === 'https:' ? 443 : null;
    if (port === null) return 'missing port for agent navigation';
    if (this.state.resolver === null) return 'DNS resolution is unavailable';
    const resolved = this.state.resolver(hostname, port);
    const verdict = (answer: IpAddress[] | string) => (typeof answer === 'string' ? answer : ensureResolvedAddressesArePublic(answer));
    if (!(resolved instanceof Promise)) return verdict(resolved);
    return resolved.then(verdict, (error: unknown) => `DNS resolver unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function formatIp(address: IpAddress): string {
  if (address.version === 4) return address.octets.join('.');
  const groups = [...address.segments];
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const hex = (value: number) => value.toString(16);
  if (bestLength < 2) return groups.map(hex).join(':');
  const left = groups.slice(0, bestStart).map(hex).join(':');
  const right = groups.slice(bestStart + bestLength).map(hex).join(':');
  return `${left}::${right}`;
}

export function ensureResolvedAddressesArePublic(addresses: readonly IpAddress[]): string | null {
  let found = false;
  for (const address of addresses) {
    found = true;
    if (isInternalIp(address)) return `DNS resolved to private/internal address ${formatIp(address)}`;
  }
  return found ? null : 'DNS resolution returned no addresses';
}

export type NavigationBlockedCallback = (url: string, reason: string) => void;

/**
 * `window.rs::navigation_allowed`: canonical policy plus the live agent guard.
 * Not the page-navigation hook: the shell's `browser-agent-guard.ts` judges page navigations and resolves
 * domains at the request layer. Here a domain target under the agent guard fails closed.
 */
export function navigationAllowed(
  url: string, policy: NavigationPolicyHandle, onBlocked: NavigationBlockedCallback | null = null,
): boolean {
  const agentGuard = policy.agentPrivateNetworkGuardEnabled();
  const effectiveAllowInsecureHttp = !agentGuard || policy.agentAllowInsecureHttpEnabled();
  const denial = allowNavigationWithOptions(url, effectiveAllowInsecureHttp);
  let reason: string | null;
  if (denial === null) {
    const verdict = policy.validateAgentTarget(url);
    // wry's `on_navigation` is synchronous; an asynchronous resolver cannot answer it in time.
    reason = verdict instanceof Promise ? 'DNS resolution is unavailable' : verdict;
  } else reason = navigationDenyMessage(denial);
  if (reason === null) return true;
  if (onBlocked !== null) onBlocked(url, reason);
  return false;
}

export function defaultProfileDir(activeDir: string): string {
  return `${activeDir.replace(/\/+$/, '')}/${PROFILE_ROOT}/${DEFAULT_PROFILE_ID}`;
}

export function surfaceHostMode(platform: 'darwin' | 'win32' | 'linux' | string): string {
  if (platform === 'darwin' || platform === 'win32') return SURFACE_HOST_EMBEDDED;
  if (platform === 'linux') return SURFACE_HOST_DETACHED;
  return SURFACE_HOST_UNSUPPORTED;
}

export function bridgeInitScript(): string {
  return INIT_SCRIPT.trim() === '' ? BRIDGE_INIT_SCRIPT_PLACEHOLDER : INIT_SCRIPT;
}

export type NativeWebviewReadyFailure = 'timedout' | 'disconnected';

export class NativeWebviewReadyError extends Error {
  readonly kind: NativeWebviewReadyFailure;

  constructor(kind: NativeWebviewReadyFailure, timeoutMs: number) {
    super(kind === 'timedout'
      ? `native browser-content webview creation acknowledgement timed out after ${timeoutMs} ms`
      : 'native browser-content webview disappeared before creation acknowledgement');
    this.name = 'NativeWebviewReadyError';
    this.kind = kind;
  }
}

/**
 * `window.rs::wait_for_native_webview_ready`: macOS/Windows wait for the native
 * `with_webview` acknowledgement, distinguishing timeout from disconnect.
 * The caller supplies the ack/disconnect registration; F2 closes over its native handle.
 */
export function waitForNativeWebviewReady(
  subscribe: (acknowledge: () => void, disconnect: () => void) => void | (() => void),
  timeoutMs: number = NATIVE_WEBVIEW_READY_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const finish = (error?: NativeWebviewReadyError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(
      () => finish(new NativeWebviewReadyError('timedout', timeoutMs)), timeoutMs,
    );
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
    const disposable = subscribe(
      () => finish(),
      () => finish(new NativeWebviewReadyError('disconnected', timeoutMs)),
    );
    if (settled) {
      if (typeof disposable === 'function') disposable();
    } else if (typeof disposable === 'function') {
      unsubscribe = disposable;
    }
  });
}
