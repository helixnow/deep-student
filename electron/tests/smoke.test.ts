/**
 * 启动真实 Electron（electron/main.ts）+ 测试替身 Host（fixtures/stub-host.ts），验证：页面加载并装好
 * Tauri 桥；未知命令以 Host 的错误 reject；内置命令在 main 内执行；前端 emit → Host → 后端事件回到页面。
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

describe('electron smoke (real Electron + stub Host)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const c of cleanups) c();
  });

  it('loads page, rejects unknown command with Host error, round-trips an event', async () => {
    await buildPreload();
    const html = readFileSync(join(here, 'fixtures', 'smoke.html'));
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-electron-smoke-'));
    const report = join(tmp, 'report.json');
    const meta = join(tmp, 'meta.json');
    const require = createRequire(import.meta.url);
    const electron = require('electron') as string;
    const child = await spawnElectron(electron, [join(electronDir, 'main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(here, 'fixtures', 'stub-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        SMOKE_REPORT: report,
        SMOKE_META_REPORT: meta,
      },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (d) => (output += String(d)));
    child.stderr.on('data', (d) => (output += String(d)));
    cleanups.push(() => child.kill('SIGKILL'));

    const deadline = Date.now() + 25_000;
    while (!existsSync(report) || !existsSync(meta)) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no report; electron output:\n${output}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 100));
    const r = JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown>;
    const envelope = JSON.parse(readFileSync(meta, 'utf8')) as {
      source: Record<string, unknown>;
      headers: Record<string, string>;
      argv: string[];
    };
    expect(envelope.source).toEqual({ window: 'main', webview: 'main' });
    expect(envelope.headers).toEqual({ origin: 'https://forged.example' });

    // Host 的 CapabilityAcl 从 --tauri-dir 加载 capabilities/ 与 permissions/；验证真实启动参数指向仓库目录。
    const tauriDir = join(electronDir, '..', 'resources/app');
    expect(envelope.argv).toContain(`--tauri-dir=${tauriDir}`);
    expect(existsSync(join(tauriDir, 'capabilities', 'browser-content.json'))).toBe(true);
    expect(existsSync(join(tauriDir, 'permissions', 'application-commands.toml'))).toBe(true);

    expect(r.isTauri).toBe(true);
    expect(r.label).toBe('main');
    // FE-A5：preload 暴露的只读平台信息（页面改不了它，也换不掉它）。
    expect(r.platform).toEqual({ value: { kind: 'desktop', os: process.platform, arch: process.arch }, frozen: true, writable: false, configurable: false });
    expect(r.nonexistent).toBe('nonexistent not allowed. Command not found');
    expect(r.builtinMissing).toBe('window.nonexistent not allowed. Command not found');
    expect(r.join).toBe(process.platform === 'win32' ? 'a\\b' : 'a/b');
    expect(r.windows).toEqual(['main']);
    expect(r.imagePixels).toEqual([255, 0, 0, 255, 0, 128, 255, 128]);
    expect(r.imageSize).toEqual({ width: 2, height: 1 });
    expect(r.closedImage).toBe(true);
    expect(typeof r.listenId).toBe('number');
    expect(r.event).toEqual({
      event: 'smoke://pong',
      payload: { echo: { n: 1 }, source: { window: 'main', webview: 'main' } },
      id: r.listenId,
    });
    // preload 以 webFrame.insertCSS 注入的拖动区域规则确实生效（"" 区域：本身 drag，直接子元素 no-drag）。
    expect(r.dragCss).toEqual({ region: 'drag', child: 'no-drag' });
  }, 40_000);
});
