/**
 * RF-W06-browser-content-label-taken：真实 Electron（electron/main.ts）+ Host 替身。主页面先用 `create_webview_window` 建一个
 * label 为 browser-content 的应用窗口，Host 随后请求 `browser.createContentWindow`。Rust 会把这个窗口当作已有的
 * browser-content 交给 Agent；外壳按 Tauri 撞 label 的报错拒绝，也不建浏览器面。反方向（browser-content 在用时页面建同名窗口）
 * 由 W23 的 `plugins/window.ts` 处理。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';
import { spawnElectron } from './electron-process.ts';

const detached = process.platform === 'linux';

const MAIN_PAGE = `<!doctype html><meta charset="utf-8"><title>label taken</title><script>
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  let page;
  try {
    page = { ok: true, value: await invoke('plugin:webview|create_webview_window', { options: { label: 'browser-content', url: '/blank', width: 200, height: 150, visible: false } }) };
  } catch (error) {
    page = { ok: false, error: String(error) };
  }
  try { await invoke('browser_surface_probe', page); } catch (error) { document.title = 'probe failed: ' + String(error); }
})();
</script>`;

describe('browser-content label taken by an app window (real Electron + stub Host)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  it('RF-W06-browser-content-label-taken: createContentWindow fails with the Tauri label error and creates no surface', async () => {
    await buildPreload();
    const server = createServer((request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(request.url?.startsWith('/blank') ? '<!doctype html><title>blank</title>' : MAIN_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-label-taken-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const reportPath = join(tmp, 'report.json');
    const profileDir = join(tmp, 'browser-profile');
    const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(import.meta.dirname, '..', 'main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(import.meta.dirname, 'fixtures', 'browser-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        BROWSER_SCENARIO: 'label-taken',
        BROWSER_REPORT: reportPath,
        BROWSER_PAGE_ORIGIN: `http://127.0.0.1:${address.port}`,
        BROWSER_LOCAL_ORIGIN: `http://127.0.0.1:${address.port}`,
        BROWSER_PROFILE_DIR: profileDir,
      },
      stdio: 'pipe',
    });
    cleanups.push(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const deadline = Date.now() + 40_000;
    while (!existsSync(reportPath)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no report; electron output:\n${output.slice(-4000)}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    expect(report.fatal, output.slice(-4000)).toBeUndefined();

    expect(report.page).toEqual({ ok: true, value: null });
    expect(report.create).toEqual({
      ok: false,
      error: detached
        ? 'failed to create detached browser-content window: a window with label `browser-content` already exists'
        : 'failed to create embedded browser-content webview: a webview with label `browser-content` already exists',
    });
    expect(report.screenshot).toEqual({ ok: false, error: 'webview not found: browser-content' });
    expect(output).not.toContain('[browser] created');
  }, 60_000);
});
