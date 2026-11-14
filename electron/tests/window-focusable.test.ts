import { spawnElectron } from './electron-process.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'linux')('WindowManager preserves decoded focusable false and defaults to true in real Electron', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f2-focusable-'));
  const report = join(dir, 'report.json');
  const electron = createRequire(import.meta.url)('electron') as string;
  const child = await spawnElectron(electron, [fileURLToPath(new URL('./fixtures/window-focusable.ts', import.meta.url))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DS_ELECTRON_USER_DATA: join(dir, 'userdata'), FOCUSABLE_REPORT: report },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += String(data); });
  child.stderr.on('data', (data) => { output += String(data); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code, output).toBe(0);
    expect(JSON.parse(readFileSync(report, 'utf8')), output).toEqual({ disabled: false, defaulted: true });
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
