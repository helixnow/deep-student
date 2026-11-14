/**
 * 真实 Electron（electron/main.ts）+ Host 替身，跑通 L19 使用的全部 `browser.*` shell op：
 * 创建/重复创建、视口、物理 bounds、可见性、桥调用、macOS CSS 遮挡注入/清除、导航历史、
 * 销毁与销毁后的错误文案。
 */
import { spawnElectron } from './electron-process.ts';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..');
const darwin = process.platform === 'darwin';
const embedded = process.platform === 'darwin' || process.platform === 'win32';

interface ShellResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface SnapshotState {
  state?: {
    path?: string;
    title?: string;
    clipPath?: string;
    htmlBackground?: string;
    bodyBackground?: string;
    layer?: boolean;
    layerBackground?: string | null;
  };
  opts?: { interactiveOnly?: boolean };
}

function expectOk(result: unknown): unknown {
  const value = result as ShellResult;
  expect(value.ok).toBe(true);
  return value.value;
}

describe('browser surface host (real Electron + stub Host)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  it('serves every browser.* op used by the L19 surface host', async () => {
    await buildPreload();
    const mainHtml = readFileSync(join(here, 'fixtures', 'browser-main.html'));
    const probe = (tag: string) =>
      `<script>(async () => { try { await window.__TAURI_INTERNALS__.invoke('origin_probe', { tag: '${tag}' }, ` +
      `{ headers: { origin: 'https://forged.example' } }); } catch (error) { ` +
      `document.title = 'origin probe failed: ' + String(error); } })();</script>`;
    const page = (title: string, color: string, tag: string | null = null) =>
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="margin:0;background:${color}">${title}${tag === null ? '' : probe(tag)}</body></html>`;
    // 远程内容页尝试弹窗、读取权限状态并把自己导航到应用协议；结果经 origin_probe 交给 Host 替身。
    const securityPage = `<!doctype html><html><head><meta charset="utf-8"><title>security</title></head><body>security<script>
      (async () => {
        const query = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (e) { return 'error:' + e.name; } };
        const result = { tag: 'security' };
        result.popupBlocked = window.open('https://example.com/popup', '_blank') === null;
        result.camera = await query('camera');
        result.microphone = await query('microphone');
        result.notification = Notification.permission;
        location.href = 'tauri://localhost/index.html';
        await new Promise((resolve) => setTimeout(resolve, 400));
        result.pathAfterNavigation = location.pathname;
        await window.__TAURI_INTERNALS__.invoke('origin_probe', result);
      })();
    </script></body></html>`;
    const server = createServer((request, response) => {
      const path = request.url ?? '/';
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(path === '/local-content' ? page('local content', 'rgb(0, 0, 255)', 'local') : mainHtml);
    });
    const contentServer = createServer((request, response) => {
      const path = request.url ?? '/';
      response.writeHead(200, { 'Content-Type': 'text/html' });
      if (path === '/a') response.end(page('page A', 'rgb(255, 0, 0)', 'remote'));
      else if (path === '/b') response.end(page('page B', 'rgb(0, 128, 0)'));
      else if (path === '/security') response.end(securityPage);
      else response.end('<!doctype html><title>missing</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => contentServer.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    cleanups.push(() => contentServer.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const contentAddress = contentServer.address();
    if (contentAddress === null || typeof contentAddress === 'string') throw new Error('no content port');

    const tmp = mkdtempSync(join(tmpdir(), 'dstu-browser-surface-'));
    const reportPath = join(tmp, 'report.json');
    const require = createRequire(import.meta.url);
    const electron = require('electron') as string;
    const child = await spawnElectron(electron, [join(electronDir, 'main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(here, 'fixtures', 'browser-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        BROWSER_REPORT: reportPath,
        BROWSER_PAGE_ORIGIN: `http://127.0.0.1:${contentAddress.port}`,
        BROWSER_LOCAL_ORIGIN: `http://127.0.0.1:${address.port}`,
        BROWSER_PROFILE_DIR: join(tmp, 'browser-profile'),
      },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    cleanups.push(() => child.kill('SIGKILL'));

    const deadline = Date.now() + 50_000;
    while (!existsSync(reportPath)) {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`no browser surface report; electron output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
    expect(report.fatal).toBeUndefined();

    // X1 的 filestream_check_access → app.pdfStreamAllowedDirs：真实 main 返回隔离数据目录。
    expect(expectOk(report.pdfStreamDirs) as string[]).toContain(join(tmp, 'appdata'));
    // Host ctx.shell.request → main 内置通知插件：成功返回与 Tauri 参数错误都可见。
    expect(report.notificationPermission).toEqual({ ok: true, value: true });
    expect(report.notificationArgError).toEqual({
      ok: false,
      error: 'invalid args `options` for command `notify`: command notify missing required key options',
    });
    // systemNotification 的窗口活跃查询走真实 main；结果取决于 xvfb 窗口状态，只锁定布尔形状。
    expect(report.mainWindowActive).toEqual({ ok: true, value: expect.any(Boolean) });

    const viewport = expectOk(report.viewport) as { width: number; height: number };
    expect(Number.isInteger(viewport.width)).toBe(true);
    expect(Number.isInteger(viewport.height)).toBe(true);
    expect(viewport.width).toBeGreaterThan(0);
    expect(viewport.height).toBeGreaterThan(0);

    // Linux 走 detached 窗口，与 Rust 的 detached 分支一样 no-op（SPEC「browser.setContentBounds」）；
    // macOS/Windows 走内嵌 WebContentsView，未创建时报 webview not found。
    expect(report.screenshotBeforeCreate).toEqual({ ok: false, error: 'webview not found: browser-content' });
    expect(report.boundsBeforeCreate).toEqual(
      embedded
        ? { ok: false, error: 'browser-content webview not found' }
        : { ok: true, value: null },
    );
    expect(report.create).toEqual({ ok: true, value: null });
    expect(report.createAgain).toEqual({ ok: true, value: null });
    expect(report.bounds).toEqual({ ok: true, value: null });
    expect(report.visibility).toEqual({ ok: true, value: null });

    const pathA = report.pathA as SnapshotState;
    expect(pathA.state?.path).toBe('/a');
    expect(pathA.opts).toEqual({ interactiveOnly: true });

    // 浏览器内容页的 IPC 来源由 main 从帧 URL 推导：即使页面伪造 Origin 头，source.origin 仍是真实 origin。
    expect(report.originProbe).toEqual({
      args: { tag: 'remote' },
      source: {
        window: embedded ? 'main' : 'browser-content',
        webview: 'browser-content',
        origin: `http://127.0.0.1:${contentAddress.port}`,
      },
      headers: { origin: 'https://forged.example' },
    });
    // 内容页停在应用 devUrl 同源地址时也不能继承 local ACL：source 必须带非 local 的 "null"。
    expect(report.localNavigate).toEqual({ ok: true, value: null });
    expect((report.localPath as SnapshotState).state?.path).toBe('/local-content');
    expect(report.localProbe).toEqual({
      args: { tag: 'local' },
      source: {
        window: embedded ? 'main' : 'browser-content',
        webview: 'browser-content',
        origin: 'null',
      },
      headers: { origin: 'https://forged.example' },
    });
    expect(report.remoteNavigate).toEqual({ ok: true, value: null });
    expect((report.remotePath as SnapshotState).state?.path).toBe('/a');

    // 原生 surface 截图：必须来自 browser-content 自身，而不是 main 窗口的 capturePage。
    const shot = expectOk(report.screenshot) as {
      available: boolean; mimeType: string; dataBase64: string; width: number; height: number;
    };
    expect(shot.available).toBe(true);
    expect(shot.mimeType).toBe('image/png');
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
    expect(Buffer.from(shot.dataBase64, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

    if (darwin) {
      expect(report.occlusions).toEqual({ ok: true, value: null });
      const occluded = report.occlusionSnapshot as SnapshotState;
      expect(occluded.state?.clipPath).toContain('path(evenodd,');
      expect(occluded.state?.clipPath).toContain('Z');
      expect(occluded.state?.htmlBackground).toBe('transparent');
      expect(occluded.state?.bodyBackground).toBe('transparent');
      expect(occluded.state?.layer).toBe(true);
      expect(occluded.state?.layerBackground).toBe('rgb(255, 0, 0)');
      expect(report.clearOcclusions).toEqual({ ok: true, value: null });
      const cleared = report.clearSnapshot as SnapshotState;
      expect(cleared.state?.clipPath).toBe('');
      expect(cleared.state?.htmlBackground).toBe('');
      expect(cleared.state?.bodyBackground).toBe('rgb(255, 0, 0)');
      expect(cleared.state?.layer).toBe(false);
    } else {
      expect(report.occlusions).toEqual({ ok: true, value: null });
    }

    expect(expectOk(report.click)).toEqual({ method: 'click', target: { ref: 'ref-1' } });
    expect(expectOk(report.type)).toEqual({
      method: 'type', ref: 'ref-2', text: 'hello', opts: { clear: true },
    });
    expect(expectOk(report.inputFiles)).toEqual({
      method: 'setInputFiles', ref: 'file-1', files: [{ name: 'a.txt', base64: 'YQ==' }],
    });
    expect(expectOk(report.scroll)).toEqual({
      method: 'scroll', opts: { direction: 'down', amount: 300, ref: null },
    });
    expect(report.focus).toEqual({ ok: true, value: null });
    expect(report.release).toEqual({ ok: true, value: null });

    expect(report.navigateB).toEqual({ ok: true, value: null });
    expect((report.pathB as SnapshotState).state?.path).toBe('/b');
    // Rust on_document_title_changed / on_page_load(Finished) → browser 插件，来源为 content webview。
    const contentSource = { window: embedded ? 'main' : 'browser-content', webview: 'browser-content' };
    const pageB = `http://127.0.0.1:${contentAddress.port}/b`;
    // `native: true` 只由 main 的原生回调设置（browser-content-events.ts nativeBrowserContentEvent）。
    expect(report.contentEventsB).toEqual([
      { event: 'dstu-browser://title-changed', payload: { title: 'page B', url: pageB }, source: contentSource, native: true },
      { event: 'dstu-browser://page-finished', payload: { url: pageB }, source: contentSource, native: true },
    ]);
    expect(report.back).toEqual({ ok: true, value: null });
    expect((report.pathBack as SnapshotState).state?.path).toBe('/a');
    expect(report.forward).toEqual({ ok: true, value: null });
    expect((report.pathForward as SnapshotState).state?.path).toBe('/b');
    expect(report.reload).toEqual({ ok: true, value: null });
    expect((report.pathReload as SnapshotState).state?.path).toBe('/b');
    // browser-content 的会话由 session.fromPath() 新建：同样默认拒绝权限、不建新窗口、不离开 http(s)。
    expect(report.securityNavigate).toEqual({ ok: true, value: null });
    expect((report.securityProbe as { args?: unknown }).args).toEqual({
      tag: 'security',
      popupBlocked: true,
      camera: 'denied',
      microphone: 'denied',
      notification: 'denied',
      pathAfterNavigation: '/security',
    });
    expect((report.securityPath as SnapshotState).state?.path).toBe('/security');
    expect(output).toContain('[security] browser: blocked new window for https://example.com');
    expect(output).toContain('[security] browser: blocked navigate to tauri://localhost');
    expect(report.agentGuardOn).toEqual({ ok: true, value: null });
    expect(report.agentGuardOff).toEqual({ ok: true, value: null });
    expect(report.contentEventsBlocked).toEqual([{
      event: 'dstu-browser://navigation-blocked',
      payload: { url: 'http://10.255.255.1/agent-blocked', reason: 'private/internal address literal is blocked for agent navigation' },
      source: contentSource,
      native: true,
    }]);
    expect(report.hide).toEqual({ ok: true, value: null });

    expect(report.destroy).toEqual({ ok: true, value: true });
    expect(report.destroyAgain).toEqual({ ok: true, value: true });
    expect(report.afterDestroySnapshot).toEqual({ ok: false, error: 'webview not found: browser-content' });
    expect(report.afterDestroyScreenshot).toEqual({ ok: false, error: 'webview not found: browser-content' });
    expect(report.afterDestroyBounds).toEqual(
      embedded
        ? { ok: false, error: 'browser-content webview not found' }
        : { ok: true, value: null },
    );
    expect(report.unknown).toEqual({ ok: false, error: 'unknown shell op: browser.nope' });
  }, 70_000);
});
