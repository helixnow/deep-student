/**
 * 真实 Electron：Agent 控制时内置浏览器的私网防护拦截重定向、DNS 失败与 DNS 重绑定，
 * 且被拦的请求不会离开浏览器（代理与源服务器都看不到）。fixture 见 `fixtures/browser-agent-guard-main.ts`。
 */
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { spawnElectron } from './electron-process.ts';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no local port');
  return address.port;
}

const page = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body>${title}</body></html>`;

describe('agent navigation guard (real Electron)', () => {
  const servers: Server[] = [];
  afterAll(() => {
    for (const server of servers) server.close();
  });

  it('blocks redirects into the private network, DNS failures and rebinding only while the agent is in control', async () => {
    const proxied: string[] = [];
    const proxy = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://unknown.invalid');
      if (url.pathname !== '/favicon.ico') proxied.push(`${url.host}${url.pathname}`);
      if (url.pathname === '/redirect-internal') {
        response.writeHead(302, { Location: 'http://internal.test/secret' });
        response.end();
      } else if (url.pathname === '/redirect-literal') {
        response.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
        response.end();
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(page(`${url.host}${url.pathname}`));
      }
    });
    const direct: string[] = [];
    const origin = createServer((request, response) => {
      if (request.url !== '/favicon.ico') direct.push(`${request.headers.host}${request.url}`);
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(page('loopback service'));
    });
    servers.push(proxy, origin);
    const proxyPort = await listen(proxy);
    const originPort = await listen(origin);

    const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(import.meta.dirname, 'fixtures/browser-agent-guard-main.ts')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', GUARD_PROXY_PORT: String(proxyPort), GUARD_ORIGIN_PORT: String(originPort) },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += String(chunk); });
    child.stderr.on('data', (chunk) => { output += String(chunk); });
    const exitCode = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 40_000);
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    });
    expect(exitCode, output).toBe(0);
    const line = output.split('\n').find((entry) => entry.startsWith('RESULT '));
    expect(line, output).toBeDefined();
    const results = JSON.parse(line!.slice('RESULT '.length)) as Record<string, unknown>;

    const rebindUrl = `http://rebind.test:${originPort}/`;
    const blockedBy = (url: string, reason: string) => [{ url, reason, fromGuardedContents: true }];
    expect(results).toEqual({
      // 用户自己浏览：与 Tauri 一样不做私网判定，重定向照常跟随。
      userRedirect: { outcome: 'loaded', finalUrl: 'http://internal.test/secret', blocked: [] },
      // 经代理的公网页面：连接地址是本机代理，不误判为重绑定。
      agentPublic: { outcome: 'loaded', finalUrl: 'http://public.test/page', blocked: [] },
      // 请求层取消：Chromium 在被拦 URL 上提交 ERR_BLOCKED_BY_CLIENT 错误页（Rust 的同步拦截停在原页）。
      agentRedirectDns: {
        outcome: 'ERR_BLOCKED_BY_CLIENT',
        finalUrl: 'http://internal.test/secret',
        blocked: blockedBy('http://internal.test/secret', 'DNS resolved to private/internal address 10.0.0.5'),
      },
      agentRedirectLiteral: {
        outcome: 'ERR_FAILED',
        finalUrl: 'http://public.test/page',
        blocked: blockedBy('http://169.254.169.254/latest/meta-data', 'private/internal address literal is blocked for agent navigation'),
      },
      agentDnsFailure: {
        outcome: 'ERR_BLOCKED_BY_CLIENT',
        finalUrl: 'http://missing.test/',
        blocked: blockedBy('http://missing.test/', 'DNS resolution failed: net::ERR_NAME_NOT_RESOLVED'),
      },
      agentRebinding: {
        outcome: 'ERR_BLOCKED_BY_CLIENT',
        finalUrl: rebindUrl,
        blocked: blockedBy(rebindUrl, 'DNS resolved to private/internal address 127.0.0.1'),
      },
      agentPageNavigation: {
        finalUrl: 'http://public.test/page',
        blocked: blockedBy(`http://localhost:${originPort}/`, 'private/internal address literal is blocked for agent navigation'),
      },
      agentInsecureHttp: {
        outcome: 'ERR_BLOCKED_BY_CLIENT',
        finalUrl: 'http://public.test/page',
        blocked: blockedBy('http://public.test/page', 'http navigation is limited to loopback hosts'),
      },
    });
    // 被拦的重定向目标从未发出：internal.test 只在用户浏览时出现一次，169.254.169.254 与 missing.test 从未出现。
    expect(proxied).toEqual([
      'public.test/redirect-internal',
      'internal.test/secret',
      'public.test/page',
      'public.test/redirect-internal',
      'public.test/page',
      'public.test/redirect-literal',
      'public.test/page',
    ]);
    // 重绑定只能在响应头阶段识别：请求已到达回环服务，但响应被丢弃；页面发起的 localhost 导航从未发出。
    expect(direct).toEqual([`rebind.test:${originPort}/`]);
  }, 60_000);
});
