/**
 * 真实 Electron main + 早期失败的 Host 替身：Host 在日志插件装载前失败时，原因必须写进主进程自己的日志文件
 * （HostFatal 正文、退出码 / 信号、最后一段 stderr），同时 stderr 仍原样转发到 main 的输出。
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

describe.skipIf(process.platform === 'win32')('Host early failures reach the main-process log file (real Electron)', () => {
  const cleanups: Array<() => void> = [];
  afterAll(() => {
    for (const cleanup of cleanups) cleanup();
  });

  async function runWith(mode: 'fatal' | 'crash' | 'signal'): Promise<{ log: string; output: string }> {
    await buildPreload();
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>host failure</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => server.close());
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    const tmp = mkdtempSync(join(tmpdir(), `dstu-host-failure-${mode}-`));
    const home = join(tmp, 'appdata.os', 'home');
    const logFile = process.platform === 'darwin'
      ? join(home, 'Library', 'Logs', 'com.deepstudent.app', 'electron-main.log')
      : join(home, '.local', 'share', 'com.deepstudent.app', 'logs', 'electron-main.log');
    const child = await spawnElectron(createRequire(import.meta.url)('electron') as string, [join(here, 'fixtures', 'restart-main.ts')], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DS_ELECTRON_DEV_URL: `http://127.0.0.1:${address.port}/`,
        DS_HOST_ENTRY: join(here, 'fixtures', 'failing-host.ts'),
        DS_APP_DATA_DIR: join(tmp, 'appdata'),
        DS_ELECTRON_USER_DATA: join(tmp, 'userdata'),
        HOST_FAILURE_MODE: mode,
      },
      stdio: 'pipe',
    });
    cleanups.push(() => child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const deadline = Date.now() + 45_000;
    for (;;) {
      const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
      // P1-2：连续两次未就绪退出后外壳不再自动重启，等用户明确选择（测试替身按“保留配置”作答）。
      if (log.includes('startup recovery required')) {
        // 最后一次退出的 stderr 尾部与 child-process-gone 行在恢复行之后写入。
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        child.kill('SIGKILL');
        return { log: readFileSync(logFile, 'utf8'), output };
      }
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`no "startup recovery required" in ${logFile}:\n${log}\n--- output ---\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  it('RF-W06-startup-recovery: HostFatal: message, stack, exit code and the stderr tail', async () => {
    const { log, output } = await runWith('fatal');
    expect(log).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[host\] fatal: profile failed to load: storage service unavailable$/m);
    expect(log).toContain('at ');
    expect(log).toContain('[host] Desktop Host exited (code 1)');
    expect(log).toMatch(/\[host\] last stderr before exit:\n(?:.*\n)*\[failing-host\] early diagnostic \(fatal\) before any logger\n(?:.*\n)*\[failing-host\] fatal sent/);
    // P1-2：未就绪退出不再跑到 3 次上限；第二次后交给启动恢复。
    expect(log).toContain('[host] restarting (1/3)');
    expect(log).toContain('startup recovery required');
    expect(log).not.toContain('restarted 3 times');
    // stderr 仍转发到 main 自己的 stderr（开发终端可见）。
    expect(output).toContain('[failing-host] early diagnostic (fatal) before any logger');
  }, 60_000);

  it('crash before the port exists: no HostFatal, but the exception text is in the main log', async () => {
    const { log } = await runWith('crash');
    expect(log).not.toContain('[host] fatal:');
    expect(log).toMatch(/\[host\] Desktop Host exited \(code \d+\)/);
    expect(log).toContain('failing-host crashed while loading modules');
    expect(log).toContain('[failing-host] early diagnostic (crash) before any logger');
  }, 60_000);

  it('killed by a signal: the signal is named', async () => {
    const { log } = await runWith('signal');
    expect(log).toContain('[host] Desktop Host process gone: reason killed, signal SIGKILL (9)');
    expect(log).toContain('[failing-host] early diagnostic (signal) before any logger');
  }, 60_000);
});
