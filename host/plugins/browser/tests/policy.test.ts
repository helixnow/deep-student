import { describe, expect, it } from 'vitest';
import {
  allowNavigation, allowNavigationWithOptions, ipv6, isBlockedForAgent, isBlockedInternalIp,
  isInternalIp, isLoopbackHost, isLoopbackIp, navigationDenyMessage, parseIp,
  type Ipv4Address, type Ipv6Address,
} from '../src/policy.ts';

function v4(a: number, b: number, c: number, d: number): Ipv4Address {
  return { version: 4, octets: [a, b, c, d] };
}
function v6(segments: readonly number[]): Ipv6Address {
  return ipv6(segments);
}

describe('dstu-browser/src/browser/policy.rs::tests', () => {
  it('rejects_forbidden_schemes', () => {
    for (const raw of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'blob:https://example.com/uuid',
      'tauri://localhost',
      'asset://localhost/foo',
      'ipc://localhost',
    ]) {
      const error = allowNavigation(raw);
      expect(error, `expected ForbiddenScheme for ${raw}`).not.toBeNull();
      expect(error!.type).toBe('ForbiddenScheme');
    }
  });

  it('allows_https', () => {
    expect(allowNavigation('https://example.com/path')).toBeNull();
    expect(allowNavigation('https://127.0.0.1/')).toBeNull();
  });

  it('http_loopback_only_by_default', () => {
    expect(allowNavigation('http://127.0.0.1:8080/')).toBeNull();
    expect(allowNavigation('http://localhost/')).toBeNull();
    expect(allowNavigation('http://app.localhost/')).toBeNull();
    expect(allowNavigation('http://[::1]/')).toBeNull();

    expect(allowNavigation('http://example.com/')).toEqual({ type: 'NonLoopbackHttp' });
    expect(allowNavigation('http://192.168.1.1/')).toEqual({ type: 'NonLoopbackHttp' });
    expect(allowNavigation('http://10.0.0.1/')).toEqual({ type: 'NonLoopbackHttp' });
  });

  it('allow_insecure_http_permits_non_loopback', () => {
    expect(allowNavigationWithOptions('http://example.com/', true)).toBeNull();
    const forbidden = allowNavigationWithOptions('file:///tmp/x', true);
    expect(forbidden!.type).toBe('ForbiddenScheme');
  });

  it('rejects_invalid_and_unknown_schemes', () => {
    expect(allowNavigation('not a url')).toEqual({ type: 'InvalidUrl' });
    const about = allowNavigation('about:blank');
    expect(about!.type).toBe('ForbiddenScheme');
  });

  it('loopback_host_helpers', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('Foo.Localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('192.168.0.1')).toBe(false);
    expect(isLoopbackHost('8.8.8.8')).toBe(false);
  });

  it('agent_blocks_private_and_loopback', () => {
    expect(isBlockedForAgent('http://127.0.0.1/')).toBe(true);
    expect(isBlockedForAgent('https://localhost/')).toBe(true);
    expect(isBlockedForAgent('http://192.168.1.10/')).toBe(true);
    expect(isBlockedForAgent('http://10.0.0.5/')).toBe(true);
    expect(isBlockedForAgent('http://172.16.0.1/')).toBe(true);
    expect(isBlockedForAgent('http://169.254.169.254/')).toBe(true);
    expect(isBlockedForAgent('http://[::1]/')).toBe(true);
    expect(isBlockedForAgent('http://[fc00::1]/')).toBe(true);
    expect(isBlockedForAgent('http://[::ffff:127.0.0.1]/')).toBe(true);

    expect(isBlockedForAgent('https://example.com/')).toBe(false);
    expect(isBlockedForAgent('https://1.1.1.1/')).toBe(false);
  });

  it('internal_ip_ipv4_and_ipv6', () => {
    expect(isInternalIp(v4(0, 0, 0, 0))).toBe(true);
    expect(isInternalIp(v4(127, 0, 0, 1))).toBe(true);
    expect(isInternalIp(v4(10, 0, 0, 1))).toBe(true);
    expect(isInternalIp(v4(192, 168, 1, 1))).toBe(true);
    expect(isInternalIp(v4(100, 64, 0, 1))).toBe(true);
    expect(isInternalIp(v4(198, 18, 0, 1))).toBe(true);
    expect(isInternalIp(v4(224, 0, 0, 1))).toBe(true);
    expect(isInternalIp(v4(255, 255, 255, 255))).toBe(true);
    expect(isInternalIp(v4(8, 8, 8, 8))).toBe(false);

    expect(isInternalIp(v6([0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true);
    expect(isInternalIp(v6([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(true);
    expect(isInternalIp(v6([0xff02, 0, 0, 0, 0, 0, 0, 1]))).toBe(true);
    expect(isInternalIp(v6([0xfc00, 0, 0, 0, 0, 0, 0, 1]))).toBe(true);

    const mappedLoopback = v6([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    expect(isInternalIp(mappedLoopback)).toBe(true);
    const compatibleLoopback = v6([0, 0, 0, 0, 0, 0, 0x7f00, 0x0001]);
    expect(isInternalIp(compatibleLoopback)).toBe(true);
    const nat64Loopback = v6([0x0064, 0xff9b, 0, 0, 0, 0, 0x7f00, 0x0001]);
    expect(isInternalIp(nat64Loopback)).toBe(true);
    const sixToFourPrivate = v6([0x2002, 0x0a00, 0x0001, 0, 0, 0, 0, 1]);
    expect(isInternalIp(sixToFourPrivate)).toBe(true);
    const sixToFourPublic = v6([0x2002, 0x0808, 0x0808, 0, 0, 0, 0, 1]);
    expect(isInternalIp(sixToFourPublic)).toBe(false);
  });
});

describe('dstu-core/src/net_policy.rs helpers', () => {
  it('classifies blocked internal addresses and leaves loopback allowed', () => {
    expect(isBlockedInternalIp(v4(127, 0, 0, 1))).toBe(false);
    expect(isBlockedInternalIp(v4(10, 0, 0, 1))).toBe(true);
    expect(isBlockedInternalIp(v4(8, 8, 8, 8))).toBe(false);
    expect(isLoopbackIp(v6([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]))).toBe(true);
    expect(isLoopbackIp(v6([0, 0, 0, 0, 0, 0, 0x7f00, 0x0001]))).toBe(false);
  });

  it('parses literals like Rust IpAddr and formats deny reasons', () => {
    expect(parseIp('127.0.0.1')).toEqual({ version: 4, octets: [127, 0, 0, 1] });
    expect(parseIp('127.000.0.1')).toBeNull();
    expect(parseIp('::ffff:127.0.0.1')).toEqual({
      version: 6, segments: [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1],
    });
    expect(parseIp('[::1]')).toBeNull();
    expect(navigationDenyMessage({ type: 'ForbiddenScheme', scheme: 'file' }))
      .toBe("scheme 'file' is not allowed for top-level navigation");
    expect(navigationDenyMessage({ type: 'AgentPrivateNetwork' }))
      .toBe('agent navigation to private/internal network is blocked');
  });
});
