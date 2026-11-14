import { spawnElectron } from './electron-process.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('WindowManager logs a failed initial loadURL instead of leaving an unhandled rejection (real Electron)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'f2-load-failure-'));
  const report = join(dir, 'report.json');
  const electron = createRequire(import.meta.url)('electron') as string;
  const child = await spawnElectron(electron, [fileURLToPath(new URL('./fixtures/window-load-failure.ts', import.meta.url))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', DS_ELECTRON_USER_DATA: join(dir, 'userdata'), LOAD_FAILURE_REPORT: report },
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
    const result = JSON.parse(readFileSync(report, 'utf8')) as { logs: string[]; rejections: string[] };
    expect(result.rejections, output).toEqual([]);
    expect(result.logs).toHaveLength(1);
    // Electron 的 loadURL 自带空 catch：不加处理时失败既不报未处理拒绝，也没有任何日志。
    expect(result.logs[0]).toMatch(/^\[window main\] failed to load http:\/\/127\.0\.0\.1:1\/unreachable: ERR_[A-Z_]+ \(-\d+\)/);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
