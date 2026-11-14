import { describe, expect, it } from 'vitest';
import { isSafeRemoteUrl } from '../node.ts';

/**
 * `crates/dstu-util/src/utils/fetch.rs::tests` 的逐条移植。
 * Rust 测试直接调用 `is_safe_remote_url`；这里调用同名生产函数（async 仅因 Node DNS）。
 */
describe('dstu-util fetch.rs::is_safe_remote_url', () => {
  it('blocks_non_http_schemes', async () => {
    expect(await isSafeRemoteUrl('file:///etc/passwd')).toBe(false);
    expect(await isSafeRemoteUrl('ftp://example.com/file.png')).toBe(false);
    expect(await isSafeRemoteUrl('data:image/png;base64,AAAA')).toBe(false);
  });

  it('allows_loopback_hosts', async () => {
    // 本地图片/插件服务（ComfyUI、本地桥接等）是合法来源
    expect(await isSafeRemoteUrl('http://localhost/image.png')).toBe(true);
    // Rust 的 `(host, port).to_socket_addrs()` 与 Node `dns.lookup` 都走 getaddrinfo：
    // glibc 不解析带尾点的 `localhost.` 和 `*.localhost`（ENOTFOUND → false），
    // 而 macOS 解析为回环地址。Rust 原测试在 macOS 上通过，这两个断言只在同一条件下执行。
    if (process.platform === 'darwin') {
      expect(await isSafeRemoteUrl('http://localhost./image.png')).toBe(true);
      expect(await isSafeRemoteUrl('https://api.localhost/image.png')).toBe(true);
    }
    expect(await isSafeRemoteUrl('http://127.0.0.1/image.png')).toBe(true);
    expect(await isSafeRemoteUrl('http://[::1]/image.png')).toBe(true);
  });

  it('blocks_private_and_link_local_ipv4', async () => {
    expect(await isSafeRemoteUrl('http://10.0.0.8/image.png')).toBe(false);
    expect(await isSafeRemoteUrl('http://172.16.5.1/image.png')).toBe(false);
    expect(await isSafeRemoteUrl('http://192.168.1.2/image.png')).toBe(false);
    expect(await isSafeRemoteUrl('http://169.254.169.254/image.png')).toBe(false);
  });

  it('blocks_local_ipv6_ranges', async () => {
    expect(await isSafeRemoteUrl('http://[fc00::1]/image.png')).toBe(false);
    expect(await isSafeRemoteUrl('http://[fe80::1]/image.png')).toBe(false);
  });

  it('allows_public_ip_literal', async () => {
    expect(await isSafeRemoteUrl('https://1.1.1.1/image.png')).toBe(true);
  });
});
