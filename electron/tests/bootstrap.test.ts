/**
 * main 进程启动兜底：启动失败必须提示并退出（否则进程继续持有单实例锁，之后每次启动都直接退出）；
 * 主进程未处理的 Promise 拒绝与异常写日志。
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeError,
  installProcessErrorLogging,
  runApp,
  SHELL_SANDBOX_HELPER_ARG,
  SHELL_SANDBOX_HELPER_FAILURE_CODE,
  SHELL_SANDBOX_HELPER_UNAVAILABLE,
  SHELL_SANDBOX_HELPER_WINDOWS_ONLY,
  shellSandboxHelperArgv,
  type BootstrapApp,
  type LaunchArguments,
} from '../shell/bootstrap.ts';

/** electron/ 不得导入 host/plugins/（boundaries `electron-imports-plugin`），从源码读出 Host 侧 spawn helper 用的开关。 */
const HELPER_ARG = (() => {
  const source = readFileSync(join(import.meta.dirname, '../../host/plugins/agent-workspace/src/tools/shell-sandbox-windows.ts'), 'utf8');
  const match = /^export const HELPER_ARG = '([^']+)';$/m.exec(source);
  if (match === null) throw new Error('HELPER_ARG not found in shell-sandbox-windows.ts');
  return match[1]!;
})();

function silentStderr(): LaunchArguments['stderr'] {
  return { write: (_text, callback) => callback() };
}

const PLAIN_LAUNCH: LaunchArguments = { argv: ['/Applications/Deep Student.app/Contents/MacOS/Deep Student'], defaultApp: false, platform: 'darwin', stderr: silentStderr() };

function fakeApp(lock = true) {
  const calls: string[] = [];
  const app: BootstrapApp = {
    requestSingleInstanceLock: () => {
      calls.push('lock');
      return lock;
    },
    quit: () => { calls.push('quit'); },
    whenReady: async () => { calls.push('ready'); },
    exit: (code) => { calls.push(`exit:${code}`); },
  };
  return { app, calls };
}

describe('runApp', () => {
  it('a second instance quits without waiting for ready or starting', async () => {
    const { app, calls } = fakeApp(false);
    const start = vi.fn(async () => undefined);
    await runApp({ app, dialog: { showErrorBox: vi.fn() }, launch: PLAIN_LAUNCH, start, log: () => undefined, productName: 'Deep Student' });
    expect(calls).toEqual(['lock', 'quit']);
    expect(start).not.toHaveBeenCalled();
  });

  it('a failed start shows an error box and exits with code 1', async () => {
    const { app, calls } = fakeApp();
    const showErrorBox = vi.fn();
    const logs: string[] = [];
    await runApp({
      app,
      dialog: { showErrorBox },
      launch: PLAIN_LAUNCH,
      start: async () => { throw new Error('cannot resolve app data dir (unknown path)'); },
      log: (message) => logs.push(message),
      productName: 'Deep Student',
    });
    expect(calls).toEqual(['lock', 'ready', 'exit:1']);
    expect(showErrorBox).toHaveBeenCalledOnce();
    const [title, content] = showErrorBox.mock.calls[0] as [string, string];
    expect(title).toBe('Deep Student failed to start');
    expect(content).toContain('cannot resolve app data dir (unknown path)');
    expect(logs.some((line) => line.startsWith('[startup] failed:') && line.includes('unknown path'))).toBe(true);
  });

  it('a synchronous throw and a non-Error rejection take the same path', async () => {
    for (const start of [() => { throw new TypeError('Invalid URL'); }, () => Promise.reject('plain string')]) {
      const { app, calls } = fakeApp();
      const showErrorBox = vi.fn();
      await runApp({ app, dialog: { showErrorBox }, launch: PLAIN_LAUNCH, start: start as () => Promise<void>, log: () => undefined, productName: 'Deep Student' });
      expect(calls.at(-1)).toBe('exit:1');
      expect(showErrorBox).toHaveBeenCalledOnce();
    }
  });

  it('still exits when the error box itself fails', async () => {
    const { app, calls } = fakeApp();
    const logs: string[] = [];
    await runApp({
      app,
      dialog: { showErrorBox: () => { throw new Error('no display'); } },
      launch: PLAIN_LAUNCH,
      start: async () => { throw new Error('boom'); },
      log: (message) => logs.push(message),
      productName: 'Deep Student',
    });
    expect(calls.at(-1)).toBe('exit:1');
    expect(logs.some((line) => line.includes('no display'))).toBe(true);
  });

  it('a successful start neither prompts nor exits', async () => {
    const { app, calls } = fakeApp();
    const showErrorBox = vi.fn();
    const start = vi.fn(async () => undefined);
    await runApp({ app, dialog: { showErrorBox }, launch: PLAIN_LAUNCH, start, log: () => undefined, productName: 'Deep Student' });
    expect(calls).toEqual(['lock', 'ready']);
    expect(start).toHaveBeenCalledOnce();
    expect(showErrorBox).not.toHaveBeenCalled();
  });
});

describe('Windows shell sandbox helper self-invocation (Rust main.rs maybe_run_helper before run)', () => {
  const EXE = 'C:\\Program Files\\Deep Student\\Deep Student.exe';
  const PAYLOAD = 'C:\\Users\\u\\AppData\\Local\\Temp\\deep-student-shell-sandbox-1.json';

  it('uses the same flag as the Host side that spawns the helper', () => {
    expect(SHELL_SANDBOX_HELPER_ARG).toBe(HELPER_ARG);
  });

  it('recognises the flag only as the first app argument, packaged or `electron main.ts …`', () => {
    expect(shellSandboxHelperArgv({ argv: [EXE, HELPER_ARG, PAYLOAD], defaultApp: false })).toEqual([EXE, HELPER_ARG, PAYLOAD]);
    expect(shellSandboxHelperArgv({ argv: [EXE, 'C:\\repo\\electron\\main.ts', HELPER_ARG, PAYLOAD], defaultApp: true })).toEqual([EXE, HELPER_ARG, PAYLOAD]);
    // Rust 只看 args().nth(1)：开关出现在别处（或开发态被当成脚本路径）时按普通启动处理。
    expect(shellSandboxHelperArgv({ argv: [EXE, '--other', HELPER_ARG, PAYLOAD], defaultApp: false })).toBeNull();
    expect(shellSandboxHelperArgv({ argv: [EXE, HELPER_ARG, PAYLOAD], defaultApp: true })).toBeNull();
    expect(shellSandboxHelperArgv({ argv: [EXE, `${HELPER_ARG}=1`], defaultApp: false })).toBeNull();
    expect(shellSandboxHelperArgv({ argv: [EXE], defaultApp: false })).toBeNull();
    expect(shellSandboxHelperArgv({ argv: [], defaultApp: false })).toBeNull();
  });

  it('RF-W06-shell-sandbox-helper-flag-all-platforms: macOS and Linux refuse the flag too (Rust #[cfg(windows)] starts the app there)', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { app, calls } = fakeApp();
      const start = vi.fn(async () => undefined);
      const written: string[] = [];
      await runApp({
        app,
        dialog: { showErrorBox: vi.fn() },
        launch: { argv: ['/opt/ds/deep-student', HELPER_ARG, '/tmp/p.json'], defaultApp: false, platform, stderr: { write: (text, callback) => { written.push(text); callback(); } } },
        start,
        log: () => undefined,
        productName: 'Deep Student',
      });
      expect(calls).toEqual([`exit:${SHELL_SANDBOX_HELPER_FAILURE_CODE}`]);
      expect(written).toEqual([`${SHELL_SANDBOX_HELPER_WINDOWS_ONLY}\n`]);
      expect(start).not.toHaveBeenCalled();
    }
  });

  it('refuses before the single-instance lock: writes the reason to stderr, exits 126, never starts', async () => {
    const { app, calls } = fakeApp();
    const start = vi.fn(async () => undefined);
    const showErrorBox = vi.fn();
    const written: string[] = [];
    await runApp({
      app,
      dialog: { showErrorBox },
      launch: {
        argv: [EXE, HELPER_ARG, PAYLOAD],
        defaultApp: false,
        platform: 'win32',
        stderr: { write: (text, callback) => { written.push(text); calls.push('stderr'); callback(); } },
      },
      start,
      log: () => undefined,
      productName: 'Deep Student',
    });
    expect(calls).toEqual(['stderr', `exit:${SHELL_SANDBOX_HELPER_FAILURE_CODE}`]);
    expect(SHELL_SANDBOX_HELPER_FAILURE_CODE).toBe(126);
    expect(written).toEqual([`${SHELL_SANDBOX_HELPER_UNAVAILABLE}\n`]);
    expect(written[0]).toMatch(/^Windows local shell sandbox failed: /);
    expect(start).not.toHaveBeenCalled();
    expect(showErrorBox).not.toHaveBeenCalled();
  });

  it('still exits 126 when stderr is unusable', async () => {
    for (const stderr of [
      { write: () => { throw new Error('EPIPE'); } },
      { write: (_text: string, callback: (error?: Error | null) => void) => callback(new Error('EPIPE')) },
    ]) {
      const { app, calls } = fakeApp();
      await runApp({ app, dialog: { showErrorBox: vi.fn() }, launch: { argv: [EXE, HELPER_ARG, PAYLOAD], defaultApp: false, platform: 'win32', stderr }, start: vi.fn(), log: () => undefined, productName: 'Deep Student' });
      expect(calls).toEqual([`exit:${SHELL_SANDBOX_HELPER_FAILURE_CODE}`]);
    }
  });
});

describe('installProcessErrorLogging', () => {
  it('logs unhandled rejections and uncaught exceptions without replacing Electron\'s default exception dialog', () => {
    const proc = new EventEmitter();
    const logs: string[] = [];
    installProcessErrorLogging(proc, (message) => logs.push(message));
    proc.emit('unhandledRejection', new Error('late failure'), Promise.resolve());
    proc.emit('uncaughtExceptionMonitor', new TypeError('bad state'), 'uncaughtException');
    expect(logs[0]).toMatch(/^\[process\] unhandled rejection: Error: late failure/);
    expect(logs[1]).toMatch(/^\[process\] uncaught exception \(uncaughtException\): TypeError: bad state/);
    // 只观察不接管：不注册 uncaughtException，Electron 仍按默认方式处理（弹出主进程错误框）。
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });

  it('describeError keeps stacks and stringifies non-errors', () => {
    expect(describeError(new Error('x'))).toContain('Error: x');
    expect(describeError('text')).toBe('text');
    expect(describeError({ code: 7 })).toBe('{"code":7}');
    expect(describeError(undefined)).toBe('undefined');
  });
});
