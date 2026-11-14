/** reqwest 0.11.27 src/proxy.rs: env proxies first, platform proxy (Windows registry / macOS SCDynamicStore) when env is empty. */
import { describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLlmHttpClient, proxyUrlFor } from '../src/http_proxy.ts';
import {
  WINDOWS_INTERNET_SETTINGS_KEY, createPlatformProxyReader, parsePlatformProxyValues, parseRegProxy, parseScutilProxy,
  resolveSystemProxy, systemProxyBypassed, type PlatformProxyReader,
} from '../src/system_proxy.ts';

const SCUTIL = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : 169.254/16
    2 : *.local
  }
  ExcludeSimpleHostnames : 1
  FTPPassive : 1
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7898
  HTTPSProxy : proxy.lan
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7899
  SOCKSProxy : 127.0.0.1
}
`;
const REG = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    CertificateRevocation    REG_DWORD    0x1
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080
    ProxyOverride    REG_SZ    localhost;127.*;192.168.*.*;*.corp;<local>

HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\5.0
`;

describe('system proxy discovery (reqwest get_from_platform)', () => {
  it('parses scutil --proxy like parse_setting_from_dynamic_store: HTTP/HTTPS only, port optional', () => {
    expect(parseScutilProxy(SCUTIL)).toEqual({ server: 'http=127.0.0.1:7897;https=proxy.lan:7898',
      bypass: ['127.0.0.1', '169.254/16', '*.local', '<local>'] });
    expect(parseScutilProxy('<dictionary> {\n  HTTPEnable : 0\n  HTTPProxy : a\n  HTTPSEnable : 1\n  HTTPSProxy : b\n}\n'))
      .toEqual({ server: 'https=b', bypass: [] });
    expect(parseScutilProxy('<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 8080\n  SOCKSEnable : 1\n  SOCKSProxy : s\n}\n')).toBeNull();
    expect(parseScutilProxy('<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n  }\n  FTPPassive : 1\n}\n')).toBeNull();
  });

  it('parses reg query Internet Settings like get_from_platform_impl: ProxyEnable must be 1', () => {
    expect(parseRegProxy(REG)).toEqual({ server: 'http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:1080',
      bypass: ['localhost', '127.*', '192.168.*.*', '*.corp', '<local>'] });
    expect(parseRegProxy(REG.replace('0x1\n    ProxyServer', '0x0\n    ProxyServer'))).toBeNull();
    expect(parseRegProxy(REG.replace(/^ {4}ProxyServer.*$/m, ''))).toBeNull();
    expect(parseRegProxy(REG.replace(/^ {4}ProxyEnable.*$/m, ''))).toBeNull();
    expect(parseRegProxy('\n    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    10.0.0.1:3128\n'))
      .toEqual({ server: '10.0.0.1:3128', bypass: [] });
  });

  it('parse_platform_values: bare address serves both schemes, per-protocol lists, explicit schemes, malformed lists', () => {
    expect([...parsePlatformProxyValues('127.0.0.1:7890')]).toEqual([['http', 'http://127.0.0.1:7890'], ['https', 'http://127.0.0.1:7890']]);
    expect([...parsePlatformProxyValues('http=a:1;https=https://b:2;socks=c:3')])
      .toEqual([['http', 'http://a:1'], ['https', 'https://b:2'], ['socks', 'http://c:3']]);
    expect([...parsePlatformProxyValues('https://p:3128')]).toEqual([['https', 'https://p:3128']]);
    expect([...parsePlatformProxyValues('http=a:1;garbage')]).toEqual([]);
    expect([...parsePlatformProxyValues('http=a=b')]).toEqual([]);
    expect([...parsePlatformProxyValues('')]).toEqual([]);
    expect(resolveSystemProxy({ server: 'https=b:2', bypass: ['x'] })).toEqual({ http: null, https: 'http://b:2', bypass: ['x'] });
  });

  it('reads the platform through an injectable command runner and ignores discovery errors', async () => {
    const run = vi.fn(async (file: string) => file === 'scutil' ? SCUTIL : REG);
    expect(await createPlatformProxyReader('darwin', run)()).toMatchObject({ server: 'http=127.0.0.1:7897;https=proxy.lan:7898' });
    expect(run).toHaveBeenLastCalledWith('scutil', ['--proxy']);
    expect(await createPlatformProxyReader('win32', run)()).toMatchObject({ server: expect.stringContaining('http=127.0.0.1:7890') });
    expect(run).toHaveBeenLastCalledWith('reg', ['query', WINDOWS_INTERNET_SETTINGS_KEY]);
    run.mockClear();
    expect(await createPlatformProxyReader('linux', run)()).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(await createPlatformProxyReader('darwin', async () => { throw new Error('scutil missing'); })()).toBeNull();
  });

  it('RF-W05-system-proxy-bypass-list: honours the OS bypass list (intentional deviation from reqwest 0.11, as hyper-util does for ProxyOverride)', () => {
    const windows = ['localhost', '127.*', '192.168.*.*', '*.corp', '<local>'];
    expect(systemProxyBypassed('localhost', windows)).toBe(true);
    expect(systemProxyBypassed('127.0.0.1', windows)).toBe(true);
    expect(systemProxyBypassed('192.168.3.4', windows)).toBe(true);
    expect(systemProxyBypassed('192.169.3.4', windows)).toBe(false);
    expect(systemProxyBypassed('git.corp', windows)).toBe(true);
    expect(systemProxyBypassed('intranet', windows)).toBe(true);
    expect(systemProxyBypassed('api.openai.com', windows)).toBe(false);
    const mac = ['127.0.0.1', '169.254/16', '*.local', '10.0.0.0/8', '::1', 'example.com'];
    expect(systemProxyBypassed('169.254.10.1', mac)).toBe(true);
    expect(systemProxyBypassed('printer.local', mac)).toBe(true);
    expect(systemProxyBypassed('10.2.3.4', mac)).toBe(true);
    expect(systemProxyBypassed('[::1]', mac)).toBe(true);
    expect(systemProxyBypassed('api.example.com', mac)).toBe(true);
    expect(systemProxyBypassed('notexample.com', mac)).toBe(false);
    expect(systemProxyBypassed('intranet', mac)).toBe(false);
    expect(systemProxyBypassed('anything', ['*'])).toBe(true);
    expect(systemProxyBypassed('1.2.3.4', ['1.2.3.*.*'])).toBe(true);
    expect(systemProxyBypassed('1.2.3.4', ['1.2.*.4', 'bogus/99', '300.*', '1.2.3.4/40'])).toBe(false);
  });

  it('platform proxy applies only when no proxy env var is set; env NO_PROXY still applies to it', () => {
    const system = { http: 'http://sys:1', https: 'http://sys:2', bypass: ['*.local'] };
    expect(proxyUrlFor('http://api.example/v1', {}, system)).toBe('http://sys:1');
    expect(proxyUrlFor('https://api.example/v1', {}, system)).toBe('http://sys:2');
    expect(proxyUrlFor('http://nas.local/v1', {}, system)).toBeNull();
    expect(proxyUrlFor('http://api.example/v1', { NO_PROXY: 'api.example' }, system)).toBeNull();
    // get_sys_proxies: any env proxy (even for the other scheme) disables the platform fallback.
    expect(proxyUrlFor('http://api.example/v1', { HTTPS_PROXY: 'http://env:3' }, system)).toBeNull();
    expect(proxyUrlFor('https://api.example/v1', { HTTPS_PROXY: 'http://env:3' }, system)).toBe('http://env:3');
    expect(proxyUrlFor('http://api.example/v1', { HTTP_PROXY: '  ' }, system)).toBe('http://sys:1');
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: Server) => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });

describe('createLlmHttpClient with the platform proxy', () => {
  it('routes through the discovered system proxy when the environment has none, bypassing OS exceptions', async () => {
    const seen: string[] = [];
    const proxy = createServer((request, response) => { seen.push(`${request.method} ${request.url}`); response.end('via-system-proxy'); });
    const direct = createServer((_request, response) => response.end('direct'));
    const proxyAddress = await listen(proxy);
    const directAddress = await listen(direct);
    const reader = vi.fn<PlatformProxyReader>(async () => ({ server: proxyAddress, bypass: ['127.0.0.1'] }));
    const client = createLlmHttpClient({}, { platformProxy: reader });
    try {
      expect(await (await client.fetch('http://system-proxy.invalid/v1/models')).text()).toBe('via-system-proxy');
      expect(seen).toEqual(['GET http://system-proxy.invalid/v1/models']);
      expect(await (await client.fetch(`http://${directAddress}/`)).text()).toBe('direct');
      expect(seen).toHaveLength(1);
      // reqwest caches the platform lookup (SYS_PROXIES is a Lazy static).
      expect(reader).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await Promise.all([close(proxy), close(direct)]);
    }
  });

  it('never consults the platform when a proxy environment variable is set', async () => {
    const direct = createServer((_request, response) => response.end('direct'));
    const directAddress = await listen(direct);
    const reader = vi.fn<PlatformProxyReader>(async () => ({ server: '127.0.0.1:9', bypass: [] }));
    const client = createLlmHttpClient({ HTTPS_PROXY: 'http://127.0.0.1:9', NO_PROXY: '127.0.0.1' }, { platformProxy: reader });
    try {
      expect(await (await client.fetch(`http://${directAddress}/`)).text()).toBe('direct');
      expect(reader).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await close(direct);
    }
  });

  it('a failing platform reader means no proxy', async () => {
    const direct = createServer((_request, response) => response.end('direct'));
    const directAddress = await listen(direct);
    const client = createLlmHttpClient({}, { platformProxy: async () => { throw new Error('registry denied'); } });
    try {
      expect(await (await client.fetch(`http://${directAddress}/`)).text()).toBe('direct');
    } finally {
      await client.close();
      await close(direct);
    }
  });
});
