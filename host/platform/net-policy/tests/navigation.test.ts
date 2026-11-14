/**
 * 平台层导航策略（browser 插件与 Electron 外壳共用）。完整的 Rust 用例对照在
 * `host/plugins/browser/tests/policy.test.ts`（经插件的原导入路径转出）。
 */
import { describe, expect, it } from 'vitest';
import {
  allowNavigation,
  allowNavigationWithOptions,
  ipv6,
  isBlockedForAgent,
  navigationDenyMessage,
} from '../navigation.ts';

describe('net-policy navigation', () => {
  it('top-level navigation: https anywhere, http only to loopback unless insecure http is allowed, no other schemes', () => {
    expect(allowNavigation('https://example.com/')).toBeNull();
    expect(allowNavigation('http://127.0.0.1:8080/')).toBeNull();
    expect(allowNavigation('http://localhost/')).toBeNull();
    expect(allowNavigation('http://example.com/')).toEqual({ type: 'NonLoopbackHttp' });
    expect(allowNavigationWithOptions('http://example.com/', true)).toBeNull();
    expect(allowNavigation('file:///etc/passwd')).toEqual({ type: 'ForbiddenScheme', scheme: 'file' });
    expect(allowNavigation('ftp://example.com/')).toEqual({ type: 'ForbiddenScheme', scheme: 'ftp' });
    expect(allowNavigation('not a url')).toEqual({ type: 'InvalidUrl' });
  });

  it('agent hard block: localhost names and internal address literals, never public hosts', () => {
    for (const url of ['http://localhost/', 'http://a.localhost./', 'http://10.0.0.1/', 'http://[fd00::1]/', 'http://169.254.169.254/', 'garbage']) {
      expect(isBlockedForAgent(url), url).toBe(true);
    }
    for (const url of ['https://example.com/', 'https://93.184.216.34/']) expect(isBlockedForAgent(url), url).toBe(false);
  });

  it('deny messages match Rust NavigationDenyReason Display', () => {
    expect(navigationDenyMessage({ type: 'NonLoopbackHttp' })).toBe('http navigation is limited to loopback hosts');
    expect(navigationDenyMessage({ type: 'ForbiddenScheme', scheme: 'data' })).toBe("scheme 'data' is not allowed for top-level navigation");
  });

  it('ipv6 helper requires exactly eight groups', () => {
    expect(ipv6([0, 0, 0, 0, 0, 0, 0, 1]).segments).toHaveLength(8);
    expect(() => ipv6([0, 1])).toThrow(/8 segments/);
  });
});
