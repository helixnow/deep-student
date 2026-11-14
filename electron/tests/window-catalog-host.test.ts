/** Real Electron main + real F2 Host service; no dependency on the storage/profile integration. */
import { spawnElectron } from './electron-process.ts';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';

it('late Host service discovers existing main, native focus, and a live fallback after main is destroyed', async () => {
  await buildPreload();
  const dir = mkdtempSync(join(tmpdir(), 'f2-window-catalog-'));
  const report = join(dir, 'report.json');
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><title>window catalog</title>'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no server port');
  const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [fileURLToPath(new URL('../main.ts', import.meta.url))], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      DS_HOST_ENTRY: fileURLToPath(new URL('./fixtures/window-catalog-host.ts', import.meta.url)),
      DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
      DS_ELECTRON_USER_DATA: join(dir, 'userdata'),
      DS_APP_DATA_DIR: join(dir, 'appdata'),
      WINDOW_CATALOG_REPORT: report,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += String(data); });
  child.stderr.on('data', (data) => { output += String(data); });
  try {
    const deadline = performance.now() + 30_000;
    while (!existsSync(report)) {
      if (performance.now() > deadline || child.exitCode !== null) throw new Error(`no window catalog report:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const actual = JSON.parse(readFileSync(report, 'utf8'));
    expect(actual.error, output).toBeUndefined();
    expect(actual.initial).toEqual([{ label: 'main', isMain: true, focused: actual.mainFocused }]);
    expect(typeof actual.mainFocused).toBe('boolean');
    expect(actual.main).toEqual(actual.initial[0]);
    expect(actual.withFallback).toHaveLength(2);
    expect(actual.withFallback).toContainEqual({ label: 'fallback', isMain: false, focused: false });
    expect(actual.afterMainDestroyed).toEqual([{ label: 'fallback', isMain: false, focused: false }]);
    expect(actual.mainAfterDestroyed).toBeNull();
    expect(actual.selectedFallback).toEqual(actual.afterMainDestroyed[0]);
  } finally {
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
    child.kill('SIGKILL');
    await closed;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 45_000);
