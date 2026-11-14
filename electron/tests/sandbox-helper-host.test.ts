/**
 * 真实 Electron 直接运行 `electron/main.ts`：第一个应用参数是 Windows 沙箱 helper 开关时，main 在申请单实例锁之前
 * 拒绝（stderr + 退出码 126），不启动应用（不打开主进程日志、不拉起窗口与 Host）。
 * 对照组：开关不在第一个位置时照常启动，单实例锁文件出现（证明下面的观察手段是灵敏的）。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SHELL_SANDBOX_HELPER_ARG, SHELL_SANDBOX_HELPER_FAILURE_CODE, SHELL_SANDBOX_HELPER_WINDOWS_ONLY } from '../shell/bootstrap.ts';
import { spawnElectron } from './electron-process.ts';

const electronDir = join(import.meta.dirname, '..');

// Chromium 的单实例锁在 macOS / Linux 上是 userData 下的 SingletonLock；Windows 用命名对象，观察不到。
describe.skipIf(process.platform === 'win32')('shell sandbox helper self-invocation (real Electron main.ts)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  async function launch(appArgs: string[]) {
    const tmp = mkdtempSync(join(tmpdir(), 'dstu-sandbox-helper-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    const userData = join(tmp, 'userdata');
    const appData = join(tmp, 'appdata');
    const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(electronDir, 'main.ts'), ...appArgs], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: 'http://127.0.0.1:9/',
        DS_HOST_ENTRY: join(import.meta.dirname, 'fixtures', 'stub-host.ts'),
        DS_APP_DATA_DIR: appData,
        DS_ELECTRON_USER_DATA: userData,
      },
      stdio: 'pipe',
    });
    cleanups.push(() => child.kill('SIGKILL'));
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    return { child, exited, userData, appData, output: () => ({ stdout, stderr }) };
  }

  it('RF-W06-shell-sandbox-helper-flag-all-platforms: the flag as the first app argument exits 126 before the lock and starts nothing', async () => {
    const run = await launch([SHELL_SANDBOX_HELPER_ARG, join(tmpdir(), 'deep-student-shell-sandbox-missing.json')]);
    const code = await Promise.race([run.exited, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30_000))]);
    const { stdout, stderr } = run.output();
    expect(code, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(SHELL_SANDBOX_HELPER_FAILURE_CODE);
    expect(stderr).toContain(SHELL_SANDBOX_HELPER_WINDOWS_ONLY);
    // start() 的第一步就写 `[paths]` / `[host]` 行并打开主进程日志；一行都没有说明没进 start()。
    expect(stdout).not.toContain('[dstu-shell]');
    // 申请单实例锁会建出 userData 并在其中放 SingletonLock（退出时删除锁、目录保留，见对照组）。
    expect(existsSync(run.userData)).toBe(false);
    expect(existsSync(run.appData)).toBe(false);
  }, 40_000);

  it('control: the flag in a later position is an ordinary launch that takes the single-instance lock', async () => {
    const run = await launch(['--not-the-helper', SHELL_SANDBOX_HELPER_ARG]);
    // SingletonLock 是指向 `<host>-<pid>` 的符号链接，existsSync 跟随链接会得到 false。
    const locked = () => existsSync(run.userData) && readdirSync(run.userData).includes('SingletonLock');
    const started = () => run.output().stdout.includes('[dstu-shell] [host] profile');
    const deadline = Date.now() + 30_000;
    while (!(locked() && started())) {
      const { stdout, stderr } = run.output();
      if (Date.now() > deadline || run.child.exitCode !== null) throw new Error(`no SingletonLock or start(); stdout:\n${stdout}\nstderr:\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    run.child.kill('SIGKILL');
    await run.exited;
    expect(existsSync(run.userData)).toBe(true);
  }, 40_000);
});
