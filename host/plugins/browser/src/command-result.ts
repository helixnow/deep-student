// Port of dstu-browser/src/cmd/browser.rs pure result/error mapping helpers.
// The commands themselves need a native webview bridge and stay unregistered.

import type { BrowserSessionState, HistoryEntry } from './session.ts';
import { formatTimestamp } from './time.ts';

export type BrowserError =
  | { kind: 'Database'; message: string }
  | { kind: 'Sqlite'; message: string }
  | { kind: 'Pool'; message: string }
  | { kind: 'Io'; message: string }
  | { kind: 'Migration'; message: string }
  | { kind: 'NotFound'; message: string }
  | { kind: 'Validation'; message: string }
  | { kind: 'DataSpace'; message: string }
  | { kind: 'NotOpen' };

export function browserErrorMessage(error: BrowserError): string {
  switch (error.kind) {
    case 'Database': return `Database error: ${error.message}`;
    case 'Sqlite': return `SQLite error: ${error.message}`;
    case 'Pool': return `Connection pool error: ${error.message}`;
    case 'Io': return `IO error: ${error.message}`;
    case 'Migration': return `Migration error: ${error.message}`;
    case 'NotFound': return `Not found: ${error.message}`;
    case 'Validation': return `Validation error: ${error.message}`;
    case 'DataSpace': return `Data space unavailable: ${error.message}`;
    case 'NotOpen': return 'Database not open (call ensure_open first)';
  }
}

/** `cmd/browser.rs::map_err`: structured prefixes consumed by the frontend and agent. */
export function mapBrowserError(error: BrowserError): string {
  switch (error.kind) {
    case 'NotFound':
      return `NOT_FOUND: ${error.message}`;
    case 'Validation':
      if (error.message.startsWith('navigation_blocked')) return `NAVIGATION_BLOCKED: ${error.message}`;
      if (error.message.includes('disabled')) return `GATES_CLOSED: ${error.message}`;
      if (error.message.includes('agent automation unsupported')) return `BRIDGE_UNSUPPORTED: ${error.message}`;
      if (error.message.startsWith('user_takeover')) return `USER_TAKEOVER: ${error.message}`;
      return browserErrorMessage(error);
    case 'NotOpen':
      return 'DB_NOT_OPEN: database not open (call open_session first)';
    default:
      return browserErrorMessage(error);
  }
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type BridgeError =
  | { kind: 'Unsupported'; message: string }
  | { kind: 'WebviewNotFound'; label: string }
  | { kind: 'Eval'; message: string }
  | { kind: 'Timeout'; milliseconds: number }
  | { kind: 'InvalidJson'; message: string }
  | { kind: 'Bridge'; code: string; message: string; details: JsonValue | null }
  | { kind: 'ChannelClosed' }
  | { kind: 'Other'; message: string };

/** Debug formatting for a millisecond duration, matching `std::time::Duration`'s `{:?}`. */
export function formatDurationDebug(milliseconds: number): string {
  const totalNanos = Math.round(milliseconds * 1_000_000);
  if (totalNanos === 0) return '0ns';
  if (totalNanos % 1_000_000_000 === 0) return `${totalNanos / 1_000_000_000}s`;
  const seconds = Math.floor(totalNanos / 1_000_000_000);
  const nanos = totalNanos % 1_000_000_000;
  if (seconds > 0) {
    if (nanos % 1_000_000 === 0) return `${seconds}.${String(nanos / 1_000_000).padStart(3, '0')}s`;
    if (nanos % 1_000 === 0) return `${seconds}.${String(nanos / 1_000).padStart(6, '0')}s`;
    return `${seconds}.${String(nanos).padStart(9, '0')}s`;
  }
  if (nanos >= 1_000_000) {
    const whole = Math.floor(nanos / 1_000_000);
    const remainder = nanos % 1_000_000;
    if (remainder === 0) return `${whole}ms`;
    return `${whole}.${String(remainder / 1_000).padStart(3, '0')}ms`;
  }
  if (nanos >= 1_000) {
    const whole = Math.floor(nanos / 1_000);
    const remainder = nanos % 1_000;
    if (remainder === 0) return `${whole}µs`;
    return `${whole}.${String(remainder).padStart(3, '0')}µs`;
  }
  return `${nanos}ns`;
}

export function bridgeErrorMessage(error: BridgeError): string {
  switch (error.kind) {
    case 'Unsupported': return `bridge unsupported on this platform: ${error.message}`;
    case 'WebviewNotFound': return `webview not found: ${error.label}`;
    case 'Eval': return `eval failed: ${error.message}`;
    case 'Timeout': return `bridge call timed out after ${formatDurationDebug(error.milliseconds)}`;
    case 'InvalidJson': return `invalid JSON from bridge: ${error.message}`;
    case 'Bridge': return `bridge error ${error.code}: ${error.message}`;
    case 'ChannelClosed': return 'channel closed before result';
    case 'Other': return error.message;
  }
}

/** `cmd/browser.rs::map_bridge_err`. */
export function mapBridgeError(error: BridgeError): string {
  switch (error.kind) {
    case 'Unsupported':
      return `BRIDGE_UNSUPPORTED: ${error.message}`;
    case 'WebviewNotFound':
      return `BRIDGE_NOT_READY: webview '${error.label}' not found`;
    case 'Bridge':
      if (error.code === 'NOT_READY' || error.code === 'PASSWORD_FIELD') {
        return `BRIDGE_${error.code}: ${error.message}`;
      }
      if (error.details !== null) return `BRIDGE_${error.code}: ${error.message} (${JSON.stringify(error.details)})`;
      return `BRIDGE_${error.code}: ${error.message}`;
    case 'Timeout':
      return `BRIDGE_TIMEOUT: after ${formatDurationDebug(error.milliseconds)}`;
    default:
      return `BRIDGE_ERROR: ${bridgeErrorMessage(error)}`;
  }
}

export type AppPlatform = 'darwin' | 'win32' | 'linux';

/** Rust `cfg!(any(target_os = "windows", target_os = "macos"))`. */
export function agentAutomationSupported(platform: AppPlatform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

/** `cmd/browser.rs::ensure_bridge_supported`. */
export function ensureBridgeSupported(platform: AppPlatform): string | null {
  return agentAutomationSupported(platform)
    ? null
    : 'BRIDGE_UNSUPPORTED: browser automation result bridge is available on Windows and macOS only';
}

export interface BrowserHistoryWireEntry {
  url: string;
  title: string;
  visitedAt: string;
}
export type BrowserStateResult = BrowserSessionState & {
  history: BrowserHistoryWireEntry[];
  agentAutomationSupported: boolean;
};

/** `cmd/browser.rs::state_result`: flatten state, append history and platform capability. */
export function stateResult(
  state: BrowserSessionState, history: readonly HistoryEntry[], platform: AppPlatform,
): BrowserStateResult {
  return {
    ...state,
    history: history.map(entry => ({
      url: entry.url,
      title: entry.title,
      visitedAt: formatTimestamp(entry.visitedAt),
    })),
    agentAutomationSupported: agentAutomationSupported(platform),
  };
}
