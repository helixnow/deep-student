/**
 * WP-078：真实 Electron 45 窗口经 Tauri 桥调用 `plugin:clipboard-manager|*`，在隔离 Xvfb 的真实系统剪贴板上
 * 验证 tauri-plugin-clipboard-manager 2.2.3 / arboard 3.6.1 的桌面语义（write→read、clear→read、html 备选文本、图片 RGBA）。
 */
import { spawnElectron } from './electron-process.ts';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..');
/** arboard `Error::ContentNotAvailable` 的 Display。 */
const EMPTY = 'The clipboard contents were not available in the requested format or the clipboard is empty.';

describe('plugin:clipboard-manager (real Electron clipboard)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const c of cleanups) c();
  });

  it('write→read, clear→read, html altText and image round-trip keep the Tauri/arboard results', async () => {
    await buildPreload();
    const html = readFileSync(join(here, 'fixtures', 'clipboard.html'));
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-electron-clipboard-'));
    const report = join(tmp, 'report.json');
    // default.json 只给主 WebView read_text / write_text（与 Tauri 相同，其余命令被 ACL 拒绝）；夹具要验证全部
    // 六个命令的插件语义，所以在随包 capability 之外再授予其余四个。
    const capabilities = join(tmp, 'capabilities');
    cpSync(join(electronDir, '..', 'resources/app', 'capabilities'), capabilities, { recursive: true });
    writeFileSync(join(capabilities, 'clipboard-host-test.json'), JSON.stringify({
      identifier: 'clipboard-host-test',
      description: 'WP-078 fixture: clipboard commands beyond default.json',
      webviews: ['main'],
      permissions: ['clipboard-manager:allow-clear', 'clipboard-manager:allow-read-image', 'clipboard-manager:allow-write-html', 'clipboard-manager:allow-write-image'],
    }));
    const require = createRequire(import.meta.url);
    const electron = require('electron') as string;
    // Linux 上不继承开发者桌面的 DISPLAY，由 spawnElectron 起隔离 Xvfb，避免覆盖真实用户剪贴板。
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform === 'linux') {
      delete env.DISPLAY;
      delete env.WAYLAND_DISPLAY;
    }
    const child = await spawnElectron(electron, [join(electronDir, 'main.ts')], {
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(here, 'fixtures', 'stub-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        DS_CAPABILITIES_DIR: capabilities,
        SMOKE_REPORT: report,
      },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    cleanups.push(() => child.kill('SIGKILL'));

    const deadline = Date.now() + 25_000;
    while (!existsSync(report)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no report; electron output:\n${output}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 100));
    const r = JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown>;

    expect(r.clear).toEqual({ ok: null });
    expect(r.readTextAfterClear).toEqual({ err: EMPTY });
    expect(r.readImageAfterClear).toEqual({ err: EMPTY });

    expect(r.writeText).toEqual({ ok: null });
    expect(r.readText).toEqual({ ok: 'WP-078 剪贴板 ✓' });
    expect(r.readImageAfterText).toEqual({ err: EMPTY });

    // arboard `set_html(html, None)` 只写 HTML 目标，`get_text` 找不到文本格式。
    expect(r.writeHtml).toEqual({ ok: null });
    expect(r.readTextAfterHtml).toEqual({ err: EMPTY });
    expect(r.writeHtmlAlt).toEqual({ ok: null });
    expect(r.readTextAfterHtmlAlt).toEqual({ ok: 'WP-078 alt' });

    expect(r.writeImage).toEqual({ ok: null });
    expect(r.readImage).toEqual({ ok: expect.any(Number) });
    expect(r.imageSize).toEqual({ width: 3, height: 1 });
    expect(r.imagePixels).toEqual([255, 0, 0, 255, 0, 128, 255, 255, 10, 20, 30, 128]);
    expect(r.readTextAfterImage).toEqual({ err: EMPTY });

    expect(r.writeTextAgain).toEqual({ ok: null });
    expect(r.clearAgain).toEqual({ ok: null });
    expect(r.readTextAfterSecondClear).toEqual({ err: EMPTY });
    expect(r.writeTextMissingArg).toEqual({
      err: 'invalid args `text` for command `write_text`: command write_text missing required key text',
    });
    expect(output).not.toContain('availableFormats');
  }, 40_000);
});
