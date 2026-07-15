import { describe, expect, it } from 'vitest';
import {
  allowNavigation,
  BROWSER_SETTING_KEYS,
  isBlockedForAgent,
  isLoopbackHost,
} from '@/features/browser/navigationPolicy';

describe('BROWSER_SETTING_KEYS', () => {
  it('matches desktop.workbenchBrowser* contract', () => {
    expect(BROWSER_SETTING_KEYS).toEqual({
      enabled: 'desktop.workbenchBrowserEnabled',
      networkMode: 'desktop.workbenchBrowserNetworkMode',
      agentControl: 'desktop.workbenchBrowserAgentControl',
      cdpWindows: 'desktop.workbenchBrowserCdpWindows',
    });
  });
});

describe('allowNavigation', () => {
  it('rejects forbidden schemes', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.com/uuid',
      'tauri://localhost',
      'asset://localhost/foo',
      'ipc://localhost',
    ]) {
      const decision = allowNavigation(url);
      expect(decision.ok).toBe(false);
      if (!decision.ok) {
        expect(decision.reason).toBe('forbidden_scheme');
      }
    }
  });

  it('allows https', () => {
    expect(allowNavigation('https://example.com/path')).toEqual({ ok: true });
    expect(allowNavigation('https://127.0.0.1/')).toEqual({ ok: true });
  });

  it('allows manual http navigation and restricts agent http in local_whitelist', () => {
    expect(allowNavigation('http://127.0.0.1:8080/')).toEqual({ ok: true });
    expect(allowNavigation('http://localhost/')).toEqual({ ok: true });
    expect(allowNavigation('http://app.localhost/')).toEqual({ ok: true });
    expect(allowNavigation('http://[::1]/')).toEqual({ ok: true });
    expect(allowNavigation('http://example.com/')).toEqual({ ok: true });

    expect(allowNavigation('http://example.com/', 'local_whitelist', true)).toEqual({
      ok: false,
      reason: 'non_loopback_http',
    });
    expect(allowNavigation('http://192.168.1.1/', 'local_whitelist', true)).toEqual({
      ok: false,
      reason: 'non_loopback_http',
    });
    expect(allowNavigation('http://localhost/', 'local_whitelist', true)).toEqual({
      ok: true,
    });
  });

  it('allows non-loopback http in full mode', () => {
    expect(allowNavigation('http://example.com/', 'full')).toEqual({ ok: true });
    expect(allowNavigation('file:///tmp/x', 'full')).toMatchObject({
      ok: false,
      reason: 'forbidden_scheme',
    });
  });

  it('rejects invalid urls', () => {
    expect(allowNavigation('not a url')).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
  });
});

describe('isLoopbackHost', () => {
  it('covers localhost and 127/8', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('Foo.Localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('192.168.0.1')).toBe(false);
  });
});

describe('isBlockedForAgent', () => {
  it('hard-blocks private and loopback literals', () => {
    expect(isBlockedForAgent('http://127.0.0.1/')).toBe(true);
    expect(isBlockedForAgent('https://localhost/')).toBe(true);
    expect(isBlockedForAgent('http://192.168.1.10/')).toBe(true);
    expect(isBlockedForAgent('http://10.0.0.5/')).toBe(true);
    expect(isBlockedForAgent('http://172.16.0.1/')).toBe(true);
    expect(isBlockedForAgent('http://169.254.169.254/')).toBe(true);
    expect(isBlockedForAgent('https://example.com/')).toBe(false);
    expect(isBlockedForAgent('https://1.1.1.1/')).toBe(false);
  });
});
