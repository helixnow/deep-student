import { spawnElectron } from './electron-process.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('Tauri window width/height, min size and the detached browser-content size are client-area sizes in real Electron', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'w06-content-size-'));
  const report = join(dir, 'report.json');
  const electron = createRequire(import.meta.url)('electron') as string;
  const child = await spawnElectron(electron, [fileURLToPath(new URL('./fixtures/window-content-size.ts', import.meta.url))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DS_ELECTRON_USER_DATA: join(dir, 'userdata'), CONTENT_SIZE_REPORT: report },
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
    const sizes = JSON.parse(readFileSync(report, 'utf8')) as {
      initial: number[]; outer: number[]; clamped: number[]; overlay: { content: number[]; outer: number[] }; detached: number[] | null;
    };
    expect(sizes, output).toMatchObject({ initial: [600, 400], clamped: [500, 300], detached: [640, 480] });
    expect(sizes.overlay.content).toEqual([600, 400]);
    if (process.platform === 'darwin') {
      // macOS 标准标题栏有高度：确认这个窗口确实带框，客户区断言才有意义。
      expect(sizes.outer[1]).toBeGreaterThan(400);
      // Overlay 标题栏（macOS 主窗口）的内容铺满整个窗口：Tauri 的 inner size 就是窗口尺寸，不因客户区语义变大。
      expect(sizes.overlay.outer).toEqual([600, 400]);
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
