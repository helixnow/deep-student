import { describe, expect, it } from 'vitest';
import {
  isBlockedInternalIp,
  isInternalIp,
  isLoopbackHost,
  isLoopbackIp,
  parseIp,
  type Ipv4Address,
  type Ipv6Address,
} from '../index.ts';

function v4(a: number, b: number, c: number, d: number): Ipv4Address {
  return { version: 4, octets: [a, b, c, d] };
}

function v6(segments: readonly number[]): Ipv6Address {
  const [a, b, c, d, e, f, g, h] = segments;
  if (a === undefined || b === undefined || c === undefined || d === undefined
    || e === undefined || f === undefined || g === undefined || h === undefined) {
    throw new Error('IPv6 地址必须有 8 个分组');
  }
  return { version: 6, segments: [a, b, c, d, e, f, g, h] };
}

describe('net_policy::parse_ip (Rust IpAddr::from_str)', () => {
  it('parses IPv4 and IPv6 literals exactly', () => {
    expect(parseIp('127.0.0.1')).toEqual({ version: 4, octets: [127, 0, 0, 1] });
    expect(parseIp('255.255.255.255')).toEqual({ version: 4, octets: [255, 255, 255, 255] });
    expect(parseIp('127.000.0.1')).toBeNull();
    expect(parseIp('127.1')).toBeNull();
    expect(parseIp('256.0.0.1')).toBeNull();
    expect(parseIp('::1')).toEqual({ version: 6, segments: [0, 0, 0, 0, 0, 0, 0, 1] });
    expect(parseIp('::')).toEqual({ version: 6, segments: [0, 0, 0, 0, 0, 0, 0, 0] });
    expect(parseIp('fc00::1')).toEqual({ version: 6, segments: [0xfc00, 0, 0, 0, 0, 0, 0, 1] });
    expect(parseIp('1:2:3:4:5:6:7:8')).toEqual({ version: 6, segments: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(parseIp('1:2:3:4:5:6:7::')).toEqual({ version: 6, segments: [1, 2, 3, 4, 5, 6, 7, 0] });
    expect(parseIp('::ffff:127.0.0.1')).toEqual({ version: 6, segments: [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1] });
    expect(parseIp('64:ff9b::192.168.1.1')).toEqual({ version: 6, segments: [0x64, 0xff9b, 0, 0, 0, 0, 0xc0a8, 0x0101] });
    expect(parseIp('[::1]')).toBeNull();
    expect(parseIp('fe80::1%en0')).toBeNull();
    expect(parseIp('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIp('1::2::3')).toBeNull();
    expect(parseIp('not-an-ip')).toBeNull();
  });
});

describe('net_policy::is_loopback_*', () => {
  it('matches Rust loopback semantics', () => {
    expect(isLoopbackIp('127.0.0.1')).toBe(true);
    expect(isLoopbackIp('127.255.0.1')).toBe(true);
    expect(isLoopbackIp('10.0.0.1')).toBe(false);
    expect(isLoopbackIp('::1')).toBe(true);
    expect(isLoopbackIp(v6([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(true);
    expect(isLoopbackIp('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackIp('::7f00:1')).toBe(false); // IPv4-compatible 不是 loopback
    expect(isLoopbackIp('not-an-ip')).toBe(false);
  });

  it('normalises hosts like is_loopback_host', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('Foo.Localhost')).toBe(true);
    expect(isLoopbackHost('localhost.')).toBe(true);
    expect(isLoopbackHost('localhost...')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('[::1')).toBe(false);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('192.168.0.1')).toBe(false);
    expect(isLoopbackHost('8.8.8.8')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });
});

describe('net_policy::is_internal_ip', () => {
  it('classifies IPv4 non-global ranges', () => {
    for (const address of [
      v4(0, 0, 0, 0),
      v4(10, 0, 0, 1),
      v4(100, 64, 0, 1),
      v4(100, 127, 255, 255),
      v4(127, 0, 0, 1),
      v4(169, 254, 169, 254),
      v4(172, 16, 0, 1),
      v4(172, 31, 255, 255),
      v4(192, 0, 0, 1),
      v4(192, 0, 2, 1),
      v4(192, 168, 1, 1),
      v4(198, 18, 0, 1),
      v4(198, 19, 255, 255),
      v4(198, 51, 100, 1),
      v4(203, 0, 113, 1),
      v4(224, 0, 0, 1),
      v4(239, 255, 255, 255),
      v4(240, 0, 0, 1),
      v4(255, 255, 255, 255),
    ]) {
      expect(isInternalIp(address), JSON.stringify(address)).toBe(true);
    }
    for (const address of [
      v4(1, 1, 1, 1),
      v4(8, 8, 8, 8),
      v4(100, 63, 255, 255),
      v4(100, 128, 0, 0),
      v4(169, 253, 255, 255),
      v4(172, 15, 255, 255),
      v4(172, 32, 0, 0),
      v4(192, 0, 1, 1),
      v4(198, 17, 255, 255),
      v4(198, 20, 0, 0),
      v4(203, 0, 114, 0),
    ]) {
      expect(isInternalIp(address), JSON.stringify(address)).toBe(false);
    }
  });

  it('classifies IPv6 non-global ranges', () => {
    for (const address of [
      '::',
      '::1',
      'ff02::1',
      'fc00::1',
      'fd00::1',
      'fe80::1',
      'fec0::1',
      '100::1',
      '2001:2::1',
      '2001:10::1',
      '2001:20::1',
      '2001:db8::1',
      '3ff0::1',
      '2002:0a00:1::1',
      '2002:7f00:1::1',
      '2002:c0a8:0101::1',
      '::7f00:1',
      '::ffff:192.168.1.1',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
      '64:ff9b::c0a8:0101',
    ]) {
      expect(isInternalIp(address), address).toBe(true);
    }
    for (const address of [
      '1.1.1.1',
      '8.8.8.8',
      '2002:0808:0808::1',
      '::ffff:8.8.8.8',
      '64:ff9b::0808:0808',
      '2001:4860:4860::8888',
    ]) {
      expect(isInternalIp(address), address).toBe(false);
    }
  });
});

describe('net_policy::is_blocked_internal_ip', () => {
  it('blocks internal addresses but exempts loopback', () => {
    expect(isBlockedInternalIp('127.0.0.1')).toBe(false);
    expect(isBlockedInternalIp('127.1.2.3')).toBe(false);
    expect(isBlockedInternalIp('::1')).toBe(false);
    expect(isBlockedInternalIp('::ffff:127.0.0.1')).toBe(false);
    expect(isBlockedInternalIp('10.0.0.1')).toBe(true);
    expect(isBlockedInternalIp('192.168.1.1')).toBe(true);
    expect(isBlockedInternalIp('169.254.169.254')).toBe(true);
    expect(isBlockedInternalIp('::ffff:192.168.1.1')).toBe(true);
    expect(isBlockedInternalIp('8.8.8.8')).toBe(false);
    expect(isBlockedInternalIp('not-an-ip')).toBe(false);
  });
});
