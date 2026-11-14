/**
 * 真实 Electron 下的 Agent 私网防护：生产 `AgentNavigationGuard` 装在 `session.fromPath()` 会话与窗口上
 * （与 browser-surface.ts 相同），依次加载场景 URL，把每个场景的结果以 `RESULT <json>` 打到 stdout。
 *
 * - `host-resolver-rules` 给出测试域名的“DNS 结果”，`resolveHost` 与网络栈都按它解析。
 * - 会话代理指向测试进程里的 HTTP 代理（记录收到的每个请求），所以 public.test 等域名不需要真的可达；
 *   rebind.test 绕过代理直连 127.0.0.1 上的测试服务器。
 * - rebind.test 的“判定时解析”由注入的 lookup 回答公网地址，模拟解析判定之后 DNS 被换成内网地址。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { AgentNavigationGuard } from '../../shell/browser-agent-guard.ts';

const proxyPort = Number(process.env.GUARD_PROXY_PORT);
const originPort = Number(process.env.GUARD_ORIGIN_PORT);

app.commandLine.appendSwitch('host-resolver-rules', [
  'MAP public.test 93.184.216.34',
  'MAP internal.test 10.0.0.5',
  'MAP rebind.test 127.0.0.1',
  'MAP missing.test ~NOTFOUND',
].join(', '));

interface Blocked { url: string; reason: string; fromGuardedContents: boolean }

async function run(): Promise<unknown> {
  const ses = session.fromPath(mkdtempSync(join(tmpdir(), 'agent-guard-profile-')));
  await ses.setProxy({ proxyRules: `http=127.0.0.1:${proxyPort}`, proxyBypassRules: 'rebind.test' });
  const blocked: Blocked[] = [];
  let window: BrowserWindow | null = null;
  const guard = new AgentNavigationGuard({
    lookup: async (host) => (host === 'rebind.test'
      ? ['93.184.216.34']
      : (await ses.resolveHost(host)).endpoints.map((endpoint) => endpoint.address)),
    onBlocked: (url, reason, contents) => blocked.push({ url, reason, fromGuardedContents: contents === window?.webContents }),
  });
  guard.installSession(ses);
  window = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true } });
  guard.attachContents(window.webContents);
  const contents = window.webContents;

  const load = async (url: string) => {
    blocked.length = 0;
    let outcome = 'loaded';
    try {
      await contents.loadURL(url);
    } catch (error) {
      outcome = (error as { code?: string }).code ?? String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { outcome, finalUrl: contents.getURL(), blocked: [...blocked] };
  };

  const results: Record<string, unknown> = {};
  guard.setPolicy({ agentPrivateNetworkGuard: false, agentAllowInsecureHttp: false });
  results.userRedirect = await load('http://public.test/redirect-internal');

  guard.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: true });
  results.agentPublic = await load('http://public.test/page');
  results.agentRedirectDns = await load('http://public.test/redirect-internal');
  // will-redirect 上同步拦下的导航不提交任何页面，先回到公网页面让结果不依赖上一个场景。
  await load('http://public.test/page');
  results.agentRedirectLiteral = await load('http://public.test/redirect-literal');
  results.agentDnsFailure = await load('http://missing.test/');
  results.agentRebinding = await load(`http://rebind.test:${originPort}/`);

  // 页面自己发起的导航走 will-navigate：本地主机名同步拦下，页面停在原处。
  await load('http://public.test/page');
  blocked.length = 0;
  await contents.executeJavaScript(`location.href = 'http://localhost:${originPort}/'; 0`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  results.agentPageNavigation = { finalUrl: contents.getURL(), blocked: [...blocked] };

  guard.setPolicy({ agentPrivateNetworkGuard: true, agentAllowInsecureHttp: false });
  results.agentInsecureHttp = await load('http://public.test/page');
  return results;
}

void app.whenReady().then(run).then((results) => {
  process.stdout.write(`RESULT ${JSON.stringify(results)}\n`);
  app.exit(0);
}, (error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
