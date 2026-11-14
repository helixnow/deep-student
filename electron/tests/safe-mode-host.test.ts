/**
 * P1-2 安全模式的真实 Electron 接线（main.ts + 真实协议/环境，Host 用替身）：
 * - `--safe-mode` 时握手 profile 是随包官方 profile，即使存在 user.profile.json、DS_HOST_PROFILE 也被忽略；
 * - Host 进程拿到 `--safe-mode` 参数与 `DS_SAFE_MODE=1`；
 * - 非安全模式启动会删掉继承来的 `DS_SAFE_MODE`；
 * - safe mode 下 `ds-plugin://` 直接 403，不读锁。
 */
import { spawnElectron } from './electron-process.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPreload } from '../scripts/build-preload.mjs';
import { officialProfilePath } from '../shell/host-profile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const electronDir = join(here, '..');
const cleanups: Array<() => void> = [];

interface HandshakeReport {
  profile: string;
  appDataDir: string;
  safeModeEnv: string | null;
  argv: string[];
}

interface Launch {
  report: HandshakeReport;
  userDataDir: string;
}

/** one launch：本机 HTTP 页面（跳过 localStorage 迁移）→ 等 Host 替身写出握手报告。 */
async function launch(options: { args: string[]; env?: Record<string, string> }): Promise<Launch> {
  const tmp = mkdtempSync(join(tmpdir(), 'dstu-safe-mode-host-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>safe mode</title><body>ok</body>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  cleanups.push(() => server.close());
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');

  const appDataDir = join(tmp, 'appdata');
  mkdirSync(join(appDataDir, 'plugins'), { recursive: true });
  // 社区 profile 存在也必须被安全模式忽略。
  writeFileSync(join(appDataDir, 'plugins', 'user.profile.json'), JSON.stringify({ plugins: ['demo'] }));
  const reportPath = join(tmp, 'handshake.json');

  const require = createRequire(import.meta.url);
  const electron = require('electron') as string;
  const userDataDir = join(tmp, 'userdata');
  const child = await spawnElectron(electron, [join(electronDir, 'main.ts'), ...options.args], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
      DS_HOST_ENTRY: join(here, 'fixtures', 'stub-host.ts'),
      DS_APP_DATA_DIR: appDataDir,
      DS_ELECTRON_USER_DATA: userDataDir,
      SMOKE_HANDSHAKE_REPORT: reportPath,
      ...options.env,
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
      throw new Error(`no Host handshake; electron output:\n${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as HandshakeReport;
  return { report, userDataDir };
}

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
});

describe('safe mode host wiring (real Electron)', () => {
  it('RF-W06-safe-mode: --safe-mode forces the official profile, ignores DS_HOST_PROFILE, and forwards both the flag and DS_SAFE_MODE', async () => {
    await buildPreload();
    const { report } = await launch({
      args: ['--safe-mode'],
      env: { DS_HOST_PROFILE: '/tmp/attacker-profile.json', DS_SAFE_MODE: '1' },
    });
    // 官方 profile 相对 Host 入口（这里是测试替身）的 ../profiles/desktop.json。
    const official = officialProfilePath(join(here, 'fixtures', 'stub-host.ts'));
    expect(report.profile).toBe(official);
    expect(report.profile).not.toContain('user.profile.json');
    expect(report.profile).not.toContain('attacker-profile');
    expect(report.safeModeEnv).toBe('1');
    expect(report.argv).toContain('--safe-mode');
  }, 60_000);

  it('a normal launch deletes an inherited DS_SAFE_MODE and keeps the user profile', async () => {
    await buildPreload();
    const { report } = await launch({ args: [], env: { DS_SAFE_MODE: '1' } });
    expect(report.profile.endsWith(join('plugins', 'user.profile.json'))).toBe(true);
    expect(report.safeModeEnv).toBeNull();
    expect(report.argv.filter((arg) => arg === '--safe-mode')).toEqual([]);
  }, 60_000);

  it('RF-W06-startup-recovery: the startup ledger starts pending and is reset by the Host-only app.startupReady request', async () => {
    await buildPreload();
    const { userDataDir } = await launch({ args: [], env: { SMOKE_STARTUP_READY: '1' } });
    const file = join(userDataDir, 'plugin-startup-state.json');
    const deadline = Date.now() + 10_000;
    let ledger: { failures: number; pending: boolean } | null = null;
    while (Date.now() < deadline) {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { failures: number; pending: boolean };
        ledger = parsed;
        if (!parsed.pending) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(ledger).toEqual({ failures: 0, pending: false });
  }, 60_000);
});
