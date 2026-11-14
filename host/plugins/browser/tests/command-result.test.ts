import { describe, expect, it } from 'vitest';
import {
  ensureBridgeSupported, formatDurationDebug, mapBridgeError, mapBrowserError, stateResult,
  type BrowserError, type BridgeError,
} from '../src/command-result.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { epochNanosFromDate } from '../src/time.ts';
import type { BrowserSessionState } from '../src/session.ts';

function sampleState(): BrowserSessionState {
  return {
    id: 'bs_test',
    label: 'browser-content',
    title: 'Example',
    url: 'https://example.com/',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    alive: true,
    controlMode: 'user',
    historyIndex: 0,
    historyLen: 1,
    chatSessionId: null,
    profilePath: '/tmp/browser',
    createdAt: '2026-07-11T00:00:00+00:00',
    updatedAt: '2026-07-11T00:00:00+00:00',
  };
}

describe('crates/dstu-browser/src/cmd/browser.rs::tests', () => {
  it('state_result_exposes_history_and_platform_capability', () => {
    const result = stateResult(sampleState(), [{
      url: 'https://example.com/', title: 'Example', visitedAt: new Date('2026-07-11T00:00:00.000Z'),
    }], 'darwin');
    const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(json.id).toBe('bs_test');
    expect((json.history as { url: string }[])[0]!.url).toBe('https://example.com/');
    expect(json.agentAutomationSupported).toBe(true);
    expect(stateResult(sampleState(), [], 'win32').agentAutomationSupported).toBe(true);
    expect(stateResult(sampleState(), [], 'linux').agentAutomationSupported).toBe(false);
  });

  it('unsupported_agent_service_error_has_bridge_code', () => {
    const mapped = mapBrowserError({ kind: 'Validation', message: 'browser agent automation unsupported: test' });
    expect(mapped.startsWith('BRIDGE_UNSUPPORTED:')).toBe(true);
  });

  it('user_takeover_service_error_has_control_code', () => {
    const mapped = mapBrowserError({ kind: 'Validation', message: 'user_takeover: user recently took control' });
    expect(mapped.startsWith('USER_TAKEOVER:')).toBe(true);
  });
});

describe('cmd/browser.rs command mapping helpers', () => {
  it('maps every browser error family exactly like the Rust match arms', () => {
    const cases: [BrowserError, string][] = [
      [{ kind: 'NotFound', message: 'session x' }, 'NOT_FOUND: session x'],
      [{ kind: 'Validation', message: 'navigation_blocked: file scheme' }, 'NAVIGATION_BLOCKED: navigation_blocked: file scheme'],
      [{ kind: 'Validation', message: 'browser disabled' }, 'GATES_CLOSED: browser disabled'],
      [{ kind: 'NotOpen' }, 'DB_NOT_OPEN: database not open (call open_session first)'],
      [{ kind: 'Validation', message: 'plain' }, 'Validation error: plain'],
      [{ kind: 'Database', message: 'x' }, 'Database error: x'],
      [{ kind: 'Sqlite', message: 'x' }, 'SQLite error: x'],
      [{ kind: 'Pool', message: 'x' }, 'Connection pool error: x'],
      [{ kind: 'Io', message: 'x' }, 'IO error: x'],
      [{ kind: 'Migration', message: 'x' }, 'Migration error: x'],
      [{ kind: 'DataSpace', message: 'x' }, 'Data space unavailable: x'],
    ];
    for (const [error, expected] of cases) expect(mapBrowserError(error)).toBe(expected);
  });

  it('maps bridge errors with encoded codes and serde_json details', () => {
    const cases: [BridgeError, string][] = [
      [{ kind: 'Unsupported', message: 'x' }, 'BRIDGE_UNSUPPORTED: x'],
      [{ kind: 'WebviewNotFound', label: 'browser-content' }, "BRIDGE_NOT_READY: webview 'browser-content' not found"],
      [{ kind: 'Bridge', code: 'NOT_READY', message: 'no page', details: { a: 1 } }, 'BRIDGE_NOT_READY: no page'],
      [{ kind: 'Bridge', code: 'PASSWORD_FIELD', message: 'blocked', details: null }, 'BRIDGE_PASSWORD_FIELD: blocked'],
      [{ kind: 'Bridge', code: 'EVAL', message: 'boom', details: { a: 1 } }, 'BRIDGE_EVAL: boom ({"a":1})'],
      [{ kind: 'Bridge', code: 'EVAL', message: 'boom', details: null }, 'BRIDGE_EVAL: boom'],
      [{ kind: 'Timeout', milliseconds: 5000 }, 'BRIDGE_TIMEOUT: after 5s'],
      [{ kind: 'Eval', message: 'x' }, 'BRIDGE_ERROR: eval failed: x'],
      [{ kind: 'InvalidJson', message: 'x' }, 'BRIDGE_ERROR: invalid JSON from bridge: x'],
      [{ kind: 'ChannelClosed' }, 'BRIDGE_ERROR: channel closed before result'],
      [{ kind: 'Other', message: 'x' }, 'BRIDGE_ERROR: x'],
    ];
    for (const [error, expected] of cases) expect(mapBridgeError(error)).toBe(expected);
  });

  it('gates native bridge support and formats duration debug values', () => {
    expect(ensureBridgeSupported('darwin')).toBeNull();
    expect(ensureBridgeSupported('win32')).toBeNull();
    expect(ensureBridgeSupported('linux'))
      .toBe('BRIDGE_UNSUPPORTED: browser automation result bridge is available on Windows and macOS only');
    expect(formatDurationDebug(0)).toBe('0ns');
    expect(formatDurationDebug(2000)).toBe('2s');
    expect(formatDurationDebug(1500)).toBe('1.500s');
    expect(formatDurationDebug(0.5)).toBe('500µs');
    expect(formatDurationDebug(1.5)).toBe('1.500ms');
    expect(toRfc3339(epochNanosFromDate(new Date('2026-07-11T00:00:00.000Z')))).toBe('2026-07-11T00:00:00+00:00');
    expect(toRfc3339(epochNanosFromDate(new Date('2026-07-11T00:00:00.123Z')))).toBe('2026-07-11T00:00:00.123+00:00');
  });
});
