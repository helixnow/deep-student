/**
 * 真实 Electron（electron/main.ts）+ Host 替身：Rust `on_page_load` 的 `PageLoadEvent::Started`（src-tauri/src/lib.rs:487-491）
 * 由主框架新文档提交发送 `page-load-started`。初次加载、整页 reload 各一次；hash/pushState、子 frame 与进行中的 invoke 不发送；
 * Host 尚未 ready 时由 main 缓冲后送达；browser-content 按自己的 window/webview label 发送，销毁后不再发送。
 */
import { spawnElectron } from './electron-process.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..');
const embedded = process.platform === 'darwin' || process.platform === 'win32';
const READY_DELAY_MS = 4000;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>page load</title></head><body><script>
(async () => {
  const invoke = (step) => window.__TAURI_INTERNALS__.invoke('page_load_step', { step, at: Date.now() });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  if (sessionStorage.getItem('page-load-reloaded') === '1') { await invoke('reloaded'); return; }
  await invoke('initial');
  location.hash = '#same-document';
  await sleep(300);
  await invoke('hash');
  history.pushState({}, '', '/pushed');
  await sleep(300);
  await invoke('push');
  const frame = document.createElement('iframe');
  await new Promise((resolve) => { frame.onload = resolve; frame.src = '/frame'; document.body.appendChild(frame); });
  await invoke('iframe');
  void invoke('hang');
  await sleep(300);
  sessionStorage.setItem('page-load-reloaded', '1');
  location.reload();
})().catch((error) => { document.title = 'page load failed: ' + String(error); });
</script></body></html>`;

interface LogEntry {
  kind: 'window' | 'abandon' | 'invoke';
  ref?: unknown;
  state?: string;
  id?: string;
  reason?: string;
  step?: string;
  at?: number;
  source?: unknown;
}

describe('page-load-started lifecycle (real Electron + stub Host)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  it('sends PageLoadEvent::Started once per main-frame document commit, buffered until Host ready', async () => {
    await buildPreload();
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      if (request.url === '/frame') response.end('<!doctype html><title>frame</title>sub frame');
      else if (request.url === '/content') response.end('<!doctype html><title>content</title>browser content');
      else response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-page-load-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const reportPath = join(tmp, 'report.json');
    const electron = createRequire(import.meta.url)('electron') as string;
    const child = await spawnElectron(electron, [join(electronDir, 'main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(here, 'fixtures', 'page-load-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        PAGE_LOAD_REPORT: reportPath,
        PAGE_LOAD_CONTENT_URL: `http://127.0.0.1:${address.port}/content`,
        PAGE_LOAD_PROFILE_DIR: join(tmp, 'browser-profile'),
        PAGE_LOAD_READY_DELAY_MS: String(READY_DELAY_MS),
      },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    cleanups.push(() => child.kill('SIGKILL'));

    const deadline = Date.now() + 45_000;
    while (!existsSync(reportPath)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no page load report; electron output:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
      readyAt: number; log: LogEntry[]; results?: Record<string, unknown>; fatal?: string;
    };
    expect(report.fatal, output).toBeUndefined();
    expect(report.results).toEqual({
      create: { ok: true, value: null },
      reload: { ok: true, value: null },
      destroy: { ok: true, value: true },
    });

    const mainRef = { window: 'main', webview: 'main' };
    const contentRef = { window: embedded ? 'main' : 'browser-content', webview: 'browser-content' };
    const invokes = report.log.filter((entry) => entry.kind === 'invoke');
    const hang = invokes.find((entry) => entry.step === 'hang');
    expect(hang?.id).toEqual(expect.any(String));
    // created / focused / blurred 等既有状态不在本用例范围内。
    const relevant = report.log
      .filter((entry) => entry.kind !== 'window' || entry.state === 'page-load-started')
      .map((entry) => (entry.kind === 'invoke' ? { kind: 'invoke', step: entry.step, source: entry.source } : entry));
    const step = (name: string) => ({ kind: 'invoke', step: name, source: mainRef });
    const started = (ref: unknown) => ({ kind: 'window', ref, state: 'page-load-started' });
    expect(relevant, output).toEqual([
      // 首次加载一次；hash / pushState（同文档）、子 frame 与进行中的 invoke 都不发送。
      started(mainRef),
      step('initial'),
      step('hash'),
      step('push'),
      step('iframe'),
      step('hang'),
      // 整页 reload：既有的 abandon 在导航开始时发出，新文档提交后再发一次 page-load-started。
      { kind: 'abandon', id: hang!.id, reason: 'reloaded' },
      started(mainRef),
      step('reloaded'),
      // browser-content：初次加载、reload 各一次；销毁后不再发送。
      started(contentRef),
      started(contentRef),
    ]);

    // 页面在 Host ready 之前已提交并开始执行：首次 page-load-started 由 main 缓冲后送达且只送一次。
    const initial = invokes.find((entry) => entry.step === 'initial');
    expect(initial!.at!).toBeLessThan(report.readyAt);
  }, 70_000);
});
