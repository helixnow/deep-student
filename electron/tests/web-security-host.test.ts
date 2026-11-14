/**
 * 真实 Electron main（fixtures/security-main.ts → electron/main.ts）+ 测试替身 Host：
 * 页面里的 window.open、顶层导航与权限查询经过生产安全策略；asset 协议经真实 protocol.handle 流式返回。
 */
import { spawnElectron } from './electron-process.ts';
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function probePage(assetUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>security probe</title></head><body>
<a id="ext" href="https://example.net/clicked">external</a>
<script>
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const query = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (e) { return 'error:' + e.name; } };
(async () => {
  const I = window.__TAURI_INTERNALS__;
  const r = { phase: 'probe' };
  r.popupExternal = window.open('https://example.com/popup', '_blank') === null;
  r.popupBlob = window.open(URL.createObjectURL(new Blob(['x'], { type: 'text/plain' })), '_blank') === null;
  r.popupFile = window.open('file:///etc/hosts', '_blank') === null;
  r.notification = Notification.permission;
  r.microphone = await query('microphone');
  r.camera = await query('camera');
  r.geolocation = await query('geolocation');
  r.clipboardRead = await query('clipboard-read');
  r.midi = await navigator.requestMIDIAccess().then(() => 'granted', (e) => e.name);
  const asset = ${JSON.stringify(assetUrl)};
  try {
    const whole = await fetch(asset);
    const bytes = new Uint8Array(await whole.arrayBuffer());
    let sum = 0;
    for (const b of bytes) sum = (sum + b) % 65521;
    r.asset = { status: whole.status, length: bytes.byteLength, sum };
    const part = await fetch(asset, { headers: { Range: 'bytes=10-19' } });
    r.assetRange = { status: part.status, contentRange: part.headers.get('content-range'), length: (await part.arrayBuffer()).byteLength };
  } catch (e) {
    r.asset = 'error:' + e.message;
  }
  await I.invoke('smoke_report', r);
  location.href = 'file:///etc/hosts';
  await sleep(400);
  location.href = 'http://127.0.0.1:1/other-origin';
  await sleep(400);
  location.href = 'https://example.org/navigated';
  await sleep(400);
  location.href = 'mailto:someone@example.com';
  await sleep(400);
  document.getElementById('ext').click();
  await sleep(400);
  await I.invoke('smoke_report', { phase: 'after-navigation', href: location.href });
})();
</script></body></html>`;
}

describe('web security (real Electron main + stub Host)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  it('denies unmanaged windows, keeps the main window on the app origin and applies the permission allowlist', async () => {
    await buildPreload();
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'dstu-electron-security-')));
    const assetFile = join(tmp, 'large.bin');
    const data = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < data.length; i += 1) data[i] = (i * 13 + 5) & 0xff;
    writeFileSync(assetFile, data);
    let expectedSum = 0;
    for (const b of data) expectedSum = (expectedSum + b) % 65521;
    const encoded = encodeURIComponent(assetFile);
    const assetUrl = process.platform === 'win32' ? `http://asset.localhost/${encoded}` : `asset://localhost/${encoded}`;

    const html = probePage(assetUrl);
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const devUrl = `http://127.0.0.1:${address.port}/`;
    const mainUrl = new URL('index.html', devUrl).href;

    const report = join(tmp, 'report.json');
    const events = join(tmp, 'events.jsonl');
    writeFileSync(events, '');
    const require = createRequire(import.meta.url);
    const electron = require('electron') as string;
    const child = await spawnElectron(electron, [join(here, 'fixtures', 'security-main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: devUrl,
        DS_HOST_ENTRY: join(here, 'fixtures', 'stub-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        SMOKE_REPORT: report,
        SECURITY_EVENTS: events,
      },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    cleanups.push(() => child.kill('SIGKILL'));

    let probe: Record<string, unknown> | null = null;
    const deadline = Date.now() + 40_000;
    for (;;) {
      if (existsSync(report)) {
        const current = JSON.parse(readFileSync(report, 'utf8')) as Record<string, unknown>;
        if (current.phase === 'probe') probe = current;
        if (current.phase === 'after-navigation') {
          expect(current.href).toBe(mainUrl);
          break;
        }
      }
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`no after-navigation report (probe=${JSON.stringify(probe)}); events:\n${readFileSync(events, 'utf8')}\nelectron output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(probe).toMatchObject({
      popupExternal: true,
      popupBlob: true,
      popupFile: true,
      notification: 'granted',
      microphone: 'granted',
      camera: 'denied',
      geolocation: 'denied',
      clipboardRead: 'granted',
      asset: { status: 200, length: data.length, sum: expectedSum },
      assetRange: { status: 206, contentRange: `bytes 10-19/${data.length}`, length: 10 },
    });
    expect(probe?.midi).not.toBe('granted');

    const entries = readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { kind: string; url?: string });
    expect(entries.filter((entry) => entry.kind === 'window-created')).toHaveLength(1);
    expect(entries.filter((entry) => entry.kind === 'did-navigate').map((entry) => entry.url)).toEqual([mainUrl]);
    expect(entries.filter((entry) => entry.kind === 'open-external').map((entry) => entry.url)).toEqual([
      'https://example.com/popup',
      'https://example.org/navigated',
      'mailto:someone@example.com',
      'https://example.net/clicked',
    ]);
    expect(output).toContain('[security] app: blocked navigate to http://127.0.0.1:1');
  }, 60_000);
});
