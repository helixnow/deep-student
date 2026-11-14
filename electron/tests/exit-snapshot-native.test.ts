/** Real app.quit + renderer snapshot module + asynchronous settings IPC (Host stand-in). */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { spawnElectron } from './electron-process.ts';

it('real user quit within the 2s debounce saves the snapshot before stopping the Host', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'exit-snapshot-'));
  const renderer = join(dir, 'renderer.js');
  const report = join(dir, 'report.json');
  let child: Awaited<ReturnType<typeof spawnElectron>> | undefined;
  try {
    await build({
      stdin: {
        contents: `import { registerDockPinnedProvider, saveSnapshot } from './src/features/workbench/core/snapshot.ts';
          window.__TAURI_INTERNALS__ = {};
          registerDockPinnedProvider(() => ['native-quit-latest']);
          saveSnapshot();
          window.require('electron').ipcRenderer.send('snapshot-ready');`,
        resolveDir: process.cwd(), loader: 'ts',
      },
      bundle: true, platform: 'browser', format: 'iife', outfile: renderer,
      plugins: [{ name: 'settings-ipc', setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'settings-ipc', namespace: 'settings-ipc' }));
        builder.onLoad({ filter: /.*/, namespace: 'settings-ipc' }, () => ({
          contents: `export const invoke = (cmd, args) => window.require('electron').ipcRenderer.invoke(cmd, args);`,
        }));
      } }],
    });
    child = await spawnElectron(createRequire(import.meta.url)('electron'), [resolve('electron/tests/fixtures/exit-snapshot-main.ts')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DS_ELECTRON_USER_DATA: join(dir, 'userdata'), SNAPSHOT_RENDERER: renderer, SNAPSHOT_REPORT: report },
    });
    let output = '';
    child.stdout.on('data', (data) => { output += String(data); });
    child.stderr.on('data', (data) => { output += String(data); });
    const code = await new Promise<number | null>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`Electron quit timed out: ${output}`)), 15_000);
      child!.once('exit', (code) => { clearTimeout(timer); done(code); });
      child!.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    expect(code, output).toBe(0);
    const result = JSON.parse(readFileSync(report, 'utf8'));
    expect(result.events, output).toEqual(['user-quit', 'save-start', 'save-done', 'shutdown']);
    expect(JSON.parse(result.payload).dockPinned).toEqual(['native-quit-latest']);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
