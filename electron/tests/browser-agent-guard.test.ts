/**
 * Agent 控制内置浏览器时的私网防护（Rust `dstu-browser/src/browser/window.rs` 的 `navigation_allowed` /
 * `NavigationPolicyHandle::validate_agent_target_for_agent` / `BoundedDnsResolver`）在外壳侧的判定。
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DNS_TIMEOUT_MS, AgentNavigationGuard } from '../shell/browser-agent-guard.ts';

function guard(lookup: (host: string) => Promise<string[]>, timeoutMs = AGENT_DNS_TIMEOUT_MS) {
  const lookups: string[] = [];
  const instance = new AgentNavigationGuard({
    lookup: async (host) => {
      lookups.push(host);
      return lookup(host);
    },
    timeoutMs,
  });
  return { guard: instance, lookups };
}

const publicLookup = async () => ['93.184.216.34'];

describe('AgentNavigationGuard', () => {
  it('is inert until the browser plugin turns the agent guard on (user browsing keeps Tauri behaviour)', async () => {
    const { guard: g, lookups } = guard(publicLookup);
    expect(g.precheck('http://10.0.0.1/')).toEqual({ allow: true });
    expect(await g.check('http://intranet.corp/')).toBeNull();
    expect(lookups).toEqual([]);
  });

  it('rejects malformed policy updates instead of guessing', () => {
    const { guard: g } = guard(publicLookup);
    expect(() => g.setPolicy({ agentPrivateNetworkGuard: 'yes', agentAllowInsecureHttp: false })).toThrow(/agentPrivateNetworkGuard/);
    expect(() => g.setPolicy(null)).toThrow();
    expect(g.policy).toEqual({ agentPrivateNetworkGuard: false, agentAllowInsecureHttp: false });
  });

  it('applies the canonical policy with http limited to loopback unless network mode is full, then the private-network block', () => {
    const { guard: g } = guard(publicLookup);
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
    expect(g.precheck('http://example.com/')).toEqual({ block: 'http navigation is limited to loopback hosts' });
    expect(g.precheck('file:///etc/passwd')).toEqual({ block: "scheme 'file' is not allowed for top-level navigation" });
    // loopback http passes the canonical policy but not the agent guard.
    expect(g.precheck('http://127.0.0.1:8080/')).toEqual({ block: 'private/internal address literal is blocked for agent navigation' });
    expect(g.precheck('https://localhost/')).toEqual({ block: 'private/internal address literal is blocked for agent navigation' });
    expect(g.precheck('https://app.localhost./')).toEqual({ block: 'private/internal address literal is blocked for agent navigation' });
    expect(g.precheck('https://[fe80::1]/')).toEqual({ block: 'private/internal address literal is blocked for agent navigation' });
    expect(g.precheck('https://169.254.169.254/latest/meta-data')).toEqual({ block: 'private/internal address literal is blocked for agent navigation' });
    expect(g.precheck('https://[::ffff:10.0.0.1]/')).toEqual({ block: 'private/internal address literal is blocked for agent navigation' });
    expect(g.precheck('https://1.1.1.1/')).toEqual({ allow: true });
    expect(g.precheck('https://example.com/')).toEqual({ resolve: { host: 'example.com', port: 443 } });
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: true });
    expect(g.precheck('http://example.com:8080/')).toEqual({ resolve: { host: 'example.com', port: 8080 } });
  });

  it('DNS outcomes match Rust: any private answer, no answer, or a resolver error blocks the navigation', async () => {
    const answers: Record<string, string[] | Error> = {
      'mixed.test': ['93.184.216.34', '10.1.2.3'],
      'v6.test': ['fd00::1'],
      'empty.test': [],
      'missing.test': new Error('net::ERR_NAME_NOT_RESOLVED'),
      'public.test': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    };
    const { guard: g } = guard(async (host) => {
      const answer = answers[host]!;
      if (answer instanceof Error) throw answer;
      return answer;
    });
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
    expect(await g.check('https://mixed.test/')).toBe('DNS resolved to private/internal address 10.1.2.3');
    expect(await g.check('https://v6.test/')).toBe('DNS resolved to private/internal address fd00::1');
    expect(await g.check('https://empty.test/')).toBe('DNS resolution returned no addresses');
    expect(await g.check('https://missing.test/')).toBe('DNS resolution failed: net::ERR_NAME_NOT_RESOLVED');
    expect(await g.check('https://public.test/')).toBeNull();
    expect(await g.check('http://public.test/')).toBe('http navigation is limited to loopback hosts');
  });

  it('times out after 2 s like the Rust resolver, and stays busy while that lookup is still outstanding', async () => {
    let release: (value: string[]) => void = () => undefined;
    const { guard: g, lookups } = guard((host) => (host === 'slow.test' ? new Promise((resolve) => { release = resolve; }) : publicLookup()), 50);
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
    expect(await g.check('https://slow.test/')).toBe('DNS resolution timed out');
    expect(await g.check('https://public.test/')).toBe('DNS resolver is busy');
    expect(lookups).toEqual(['slow.test']);
    release(['93.184.216.34']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await g.check('https://public.test/')).toBeNull();
    expect(AGENT_DNS_TIMEOUT_MS).toBe(2_000);
  });

  it('concurrent lookups that finish in time are not "busy" (Rust serialises them on the UI thread instead)', async () => {
    const { guard: g } = guard(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return ['93.184.216.34'];
    });
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
    expect(await Promise.all([g.check('https://a.test/'), g.check('https://b.test/')])).toEqual([null, null]);
  });

  it('an answer that is not an IP address is a resolver failure, never a pass', async () => {
    const { guard: g } = guard(async () => ['not-an-ip']);
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
    expect(await g.check('https://odd.test/')).toBe('DNS resolution failed: unexpected address "not-an-ip"');
  });

  it('DNS rebinding: the address the browser actually connected to is classified with the same rules', () => {
    const { guard: g } = guard(publicLookup);
    expect(g.connectedAddressBlocked('127.0.0.1')).toBeNull();
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
    expect(g.connectedAddressBlocked('127.0.0.1')).toBe('DNS resolved to private/internal address 127.0.0.1');
    expect(g.connectedAddressBlocked('::ffff:192.168.1.1')).toBe('DNS resolved to private/internal address ::ffff:192.168.1.1');
    expect(g.connectedAddressBlocked('93.184.216.34')).toBeNull();
    // 缓存命中等没有套接字地址的响应：没有可判定的地址，不拦。
    expect(g.connectedAddressBlocked(undefined)).toBeNull();
    expect(g.connectedAddressBlocked('')).toBeNull();
  });
});

type Hook = (details: Record<string, unknown>, callback: (response: { cancel?: boolean }) => void) => void;

function fakeSession(proxy = 'DIRECT') {
  const hooks: { beforeRequest?: Hook; headersReceived?: Hook } = {};
  const session = {
    webRequest: {
      onBeforeRequest: (hook: Hook) => { hooks.beforeRequest = hook; },
      onHeadersReceived: (hook: Hook) => { hooks.headersReceived = hook; },
    },
    resolveProxy: async () => proxy,
  };
  const call = (hook: Hook | undefined, details: Record<string, unknown>) =>
    new Promise<{ cancel?: boolean }>((resolve) => hook!(details, resolve));
  return { session: session as unknown as Parameters<AgentNavigationGuard['installSession']>[0], hooks, call };
}

describe('Rust deviations of the agent private-network guard', () => {
  it('RF-W06-agent-block-request-level-error-page: a DNS-blocked main-frame request is cancelled at the request layer and reported once', async () => {
    const blocked: Array<[string, string]> = [];
    const g = new AgentNavigationGuard({ lookup: async () => ['10.0.0.5'], onBlocked: (url, reason) => blocked.push([url, reason]) });
    const { session, hooks, call } = fakeSession();
    g.installSession(session);
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: true });
    // Rust 在同步的 on_navigation 里返回 false，页面停在原页。Electron 的导航事件不能等异步解析，只能在请求层取消，
    // Chromium 随后在被拦 URL 上提交 ERR_BLOCKED_BY_CLIENT 错误页（真实 Electron：browser-agent-guard-host.test.ts）。
    expect(await call(hooks.beforeRequest, { url: 'http://internal.test/secret', resourceType: 'mainFrame' })).toEqual({ cancel: true });
    expect(blocked).toEqual([['http://internal.test/secret', 'DNS resolved to private/internal address 10.0.0.5']]);
    // 子资源与 Rust 一样不判。
    expect(await call(hooks.beforeRequest, { url: 'http://internal.test/a.png', resourceType: 'image' })).toEqual({});
  });

  it('RF-W06-agent-dns-rebinding-recheck: a response from a private address the browser connected to directly is dropped even though DNS looked public', async () => {
    const blocked: Array<[string, string]> = [];
    const g = new AgentNavigationGuard({ lookup: publicLookup, onBlocked: (url, reason) => blocked.push([url, reason]) });
    const { session, hooks, call } = fakeSession();
    g.installSession(session);
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: true });
    // 判定时域名解析为公网（Rust 到此为止就放行）；Chromium 连接前重新解析，实际连到了 127.0.0.1。
    expect(await call(hooks.beforeRequest, { url: 'http://rebind.test/', resourceType: 'mainFrame' })).toEqual({});
    expect(await call(hooks.headersReceived, { url: 'http://rebind.test/', resourceType: 'mainFrame', ip: '127.0.0.1' })).toEqual({ cancel: true });
    expect(blocked).toEqual([['http://rebind.test/', 'DNS resolved to private/internal address 127.0.0.1']]);
    expect(await call(hooks.headersReceived, { url: 'http://public.test/', resourceType: 'mainFrame', ip: '93.184.216.34' })).toEqual({});
  });

  it('RF-W06-agent-dns-rebinding-recheck: through a proxy the connected address is the proxy, so nothing is re-judged', async () => {
    const g = new AgentNavigationGuard({ lookup: publicLookup });
    const { session, hooks, call } = fakeSession('PROXY 127.0.0.1:7890');
    g.installSession(session);
    g.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: true });
    expect(await call(hooks.headersReceived, { url: 'http://public.test/', resourceType: 'mainFrame', ip: '127.0.0.1' })).toEqual({});
  });
});
