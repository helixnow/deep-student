/**
 * `ds-plugin://` 真实 Electron 集成（main.ts + 协议注册 + Host 替身）：
 * 清单驱动的首请求、ESM 导入（MIME）、路径穿越拒绝、`host://ui-manifest` 事件后旧路径失效。
 */
import { spawnElectron } from './electron-process.ts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..');

describe('ds-plugin host (real Electron + stub Host)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  it('RF-W06-plugin-lock-integrity: serves the UI manifest module from the lock, rejects traversal and drops old paths after the lock switch', async () => {
    await buildPreload();
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-ds-plugin-host-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

    const dirA = join(tmp, 'appdata', 'plugins', 'releases', 'demo', '1.0.0-a');
    const dirB = join(tmp, 'appdata', 'plugins', 'releases', 'demo', '1.0.1-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(join(dirA, 'ui.js'), "export default 'a';\n");
    writeFileSync(join(dirA, 'old.js'), 'export const old = true;\n');
    writeFileSync(join(dirB, 'ui.js'), "export default 'b';\n");
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const lockFor = (version: string, files: Record<string, string>) => JSON.stringify({
      lockVersion: 1,
      plugins: { demo: { id: 'demo', version, path: `releases/demo/${version}`, enabled: true, files } },
    });
    const lockFile = join(tmp, 'appdata', 'plugins', 'plugins.lock.json');
    writeFileSync(lockFile, lockFor('1.0.0-a', { 'ui.js': sha("export default 'a';\n"), 'old.js': sha('export const old = true;\n') }));
    const nextLock = lockFor('1.0.1-b', { 'ui.js': sha("export default 'b';\n") });
    const manifestA = [{ id: 'demo', file: join(dirA, 'ui.js') }];
    const manifestB = [{ id: 'demo', file: join(dirB, 'ui.js') }];

    const html = readFileSync(join(here, 'fixtures', 'plugin-ui.html'), 'utf8').replace(
      '__NEXT_MANIFEST__',
      JSON.stringify(manifestB),
    );
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const reportPath = join(tmp, 'report.json');
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
        SMOKE_REPORT: reportPath,
        SMOKE_UI_MANIFEST: JSON.stringify(manifestA),
        SMOKE_UI_LOCK_PATH: lockFile,
        SMOKE_UI_LOCK_NEXT: nextLock,
      },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    cleanups.push(() => child.kill('SIGKILL'));

    const deadline = Date.now() + 40_000;
    while (!existsSync(reportPath)) {
      if (Date.now() > deadline || child.exitCode !== null) {
        throw new Error(`no ds-plugin report; electron output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as Record<string, unknown>;

    expect(report.firstError).toBeUndefined();
    expect(report.first).toEqual({
      status: 200,
      contentType: 'text/javascript',
      cacheControl: 'no-store',
      body: "export default 'a';\n",
    });
    // 动态 import 成功说明协议返回的 MIME 可作为 ESM 加载。
    expect(report.module).toBe('a');
    expect(report.oldBefore).toBe(200);
    expect(report.traversal).toBe(403);

    expect(report.updateError).toBeUndefined();
    expect(report.eventPayload).toEqual(manifestB);
    expect(report.after).toEqual({ status: 200, body: "export default 'b';\n" });
    expect(report.oldAfter).toBe(404);
  }, 60_000);
});
