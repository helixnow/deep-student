/**
 * 真实 Electron（electron/main.ts）+ Host 替身：主窗口 CloseRequested 的后台驻留（src-tauri/src/lib.rs:1714-1783）。
 * 各条件、显式退出、关机与各平台分支见 `app-lifecycle.test.ts`；这里只确认 main 真的接上了。
 * 顺带核对 main 交给 Host 的编译缓存目录（`NODE_COMPILE_CACHE`）。
 * - 有驻留条件：关闭主窗口后窗口隐藏但不销毁（页面继续运行），驻留判定经 `plugin:host|call` 以 main 身份询问 Host；
 *   第二实例启动（lib.rs:695-701）把它重新显示出来。
 * - 没有驻留条件：关闭主窗口后应用退出（macOS 走 lib.rs:1770 的 app.exit(0)；Windows / Linux 是最后一个窗口关闭）。
 */
import { spawnElectron } from './electron-process.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..');
const electron = createRequire(import.meta.url)('electron') as string;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>residency</title></head><body><script>
(async () => {
  const T = window.__TAURI_INTERNALS__;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const visible = () => T.invoke('plugin:window|is_visible', { label: 'main' });
  const until = async (want, ms) => {
    const end = Date.now() + ms;
    while ((await visible()) !== want) { if (Date.now() > end) return false; await sleep(100); }
    return true;
  };
  const step = async (name) => T.invoke('residency_step', { step: name, visible: await visible() });
  await until(true, 10000);
  await step('loaded');
  void T.invoke('plugin:window|close', { label: 'main' }).catch(() => undefined);
  if (!(await until(false, 10000))) return;
  await step('hidden');
  if (await until(true, 30000)) await step('shown');
})().catch((error) => { document.title = 'residency failed: ' + String(error); });
</script></body></html>`;

interface Entry { kind: string; step?: string; visible?: boolean; service?: string; method?: string; source?: unknown; compileCache?: string | null }

describe('background residency wiring (real Electron + stub Host)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
  });

  async function launch(state: Record<string, boolean>) {
    await buildPreload();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-residency-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const reportPath = join(tmp, 'report.json');
    const env: NodeJS.ProcessEnv & { DS_ELECTRON_USER_DATA: string } = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
      DS_HOST_ENTRY: join(here, 'fixtures', 'background-residency-host.ts'),
      DS_APP_DATA_DIR: join(tmp, 'appdata'),
      DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
      RESIDENCY_REPORT: reportPath,
      RESIDENCY_STATE: JSON.stringify(state),
    };
    delete env.NODE_COMPILE_CACHE;
    const spawn = async () => {
      const child = await spawnElectron(electron, [join(electronDir, 'main.ts')], { env, stdio: 'pipe' });
      cleanups.push(() => child.kill('SIGKILL'));
      return child;
    };
    const child = await spawn();
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const read = (): Entry[] => (existsSync(reportPath) ? (JSON.parse(readFileSync(reportPath, 'utf8')) as { log: Entry[] }).log : []);
    const waitFor = async (what: string, predicate: (log: Entry[]) => boolean, ms = 30_000) => {
      const deadline = Date.now() + ms;
      for (;;) {
        const log = read();
        if (predicate(log)) return log;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; log ${JSON.stringify(log)}; electron output:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    return { child, spawn, read, waitFor, output: () => output, userData: env.DS_ELECTRON_USER_DATA };
  }

  const hasStep = (name: string) => (log: Entry[]) => log.some((entry) => entry.kind === 'step' && entry.step === name);
  const exited = (child: ChildProcessWithoutNullStreams) =>
    new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.once('exit', (code) => resolve(code));
    });

  it('with a residency condition, closing the main window hides it (asked from main through plugin:host|call) and a second launch shows it again', async () => {
    const app = await launch({ automation: false, superAgent: false, quickAssistant: true, notificationsDisabled: true });
    await app.waitFor('the page to load', hasStep('loaded'));
    const hidden = await app.waitFor('the main window to hide', hasStep('hidden'));
    expect(hidden.find((entry) => entry.kind === 'host-call')).toMatchObject({
      service: 'agentAutomation', method: 'backgroundResidency', source: { window: 'main', webview: 'main' },
    });
    // 判定已执行（窗口仍隐藏、页面仍在）之后再唤回。
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(app.child.exitCode, app.output()).toBeNull();
    const second = await app.spawn();
    await exited(second);
    const shown = await app.waitFor('the main window to come back', hasStep('shown'));
    expect(shown.filter((entry) => entry.kind === 'step').map((entry) => [entry.step, entry.visible])).toEqual([
      ['loaded', true], ['hidden', false], ['shown', true],
    ]);
    expect(shown.some((entry) => entry.kind === 'shutdown')).toBe(false);
  }, 90_000);

  it('without a residency condition, closing the main window quits the app through the ordered shutdown', async () => {
    const app = await launch({ automation: false, superAgent: false, quickAssistant: false, notificationsDisabled: true });
    await app.waitFor('the page to load', hasStep('loaded'));
    expect(await exited(app.child), app.output()).toBe(0);
    const log = app.read();
    expect(log.some((entry) => entry.kind === 'host-call' && entry.method === 'backgroundResidency')).toBe(true);
    expect(log.at(-1)?.kind).toBe('shutdown');
    // main 把 Host 的 Node 编译缓存放在 userData 下，而不是 os.tmpdir()。
    expect(log.find((entry) => entry.kind === 'handshake')?.compileCache).toBe(join(app.userData, 'host-compile-cache'));
  }, 90_000);
});
