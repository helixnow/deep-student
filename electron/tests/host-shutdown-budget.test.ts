/**
 * V09-P1-2（外壳半）：Host 的关停有上限（W01 `dde2f603`，`host/kernel/runtime.ts` 的 `COMMAND_CLOSE_TIMEOUT_MS` 在途命令
 * 2000 ms + `DISPOSE_PHASE_BUDGET_MS` 插件 dispose 3000 ms，加 `host/kernel/main.ts` `exitSoon` 的 500 ms，合计 5500 ms；后台任务
 * 先 abort 再等 1000 ms，落在 dispose 阶段之内，见 `host/kernel/API.md`「关停」）。外壳的固定预算至少再多留 1500 ms 给进程退出
 * 与日志落盘（`.reports/W01-handoffs/backgroundTasks-interface.md` §4、§5）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageChannelMain, utilityProcess } from 'electron';
import { HOST_PROTOCOL_VERSION } from '../../host/kernel/protocol.ts';
import { COMMAND_CLOSE_TIMEOUT_MS, DISPOSE_PHASE_BUDGET_MS } from '../../host/kernel/runtime.ts';
import { HOST_SHUTDOWN_BUDGET_MS, HostSupervisor } from '../shell/host.ts';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    utilityProcess: { fork: vi.fn(() => Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() })) },
    MessageChannelMain: vi.fn(function () {
      return { port1: Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn(), close: vi.fn() }), port2: {} };
    }),
  };
});

/** `host/kernel/main.ts` `exitSoon` 的等待（没有导出）。 */
const HOST_EXIT_SOON_MS = 500;
const HOST_BOUNDED_SHUTDOWN_MS = COMMAND_CLOSE_TIMEOUT_MS + DISPOSE_PHASE_BUDGET_MS + HOST_EXIT_SOON_MS;
const EXIT_AND_FLUSH_MARGIN_MS = 1_500;

beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

// 与下一例同一口径：预算恰好等于下限时，强杀计时器会在 Host 用满下限的那一刻触发，所以要严格大于。
it('V09-P1-2: the shell budget covers the Host bounded shutdown plus the exit and log-flush margin', () => {
  expect(HOST_SHUTDOWN_BUDGET_MS).toBeGreaterThan(HOST_BOUNDED_SHUTDOWN_MS + EXIT_AND_FLUSH_MARGIN_MS);
});

it('V09-P1-2: a Host that takes its whole bounded shutdown and the margin, then exits, is never killed', async () => {
  const log = vi.fn();
  const supervisor = new HostSupervisor({
    entry: '/isolated/host.ts', args: [],
    handshake: { appDataDir: '/isolated/data', appVersion: '0.11.0', platform: 'linux', debug: true },
    onEvent: vi.fn(), onShellRequest: async () => null, onUnavailable: vi.fn(), log,
  });
  supervisor.start();
  const child = vi.mocked(utilityProcess.fork).mock.results[0]!.value as { kill: ReturnType<typeof vi.fn>; emit(event: string, code: number): void };
  const port = vi.mocked(MessageChannelMain).mock.results[0]!.value.port1 as { emit(event: string, value: unknown): void; postMessage: ReturnType<typeof vi.fn> };
  port.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
  let finished = false;
  void supervisor.shutdown().then(() => { finished = true; });
  expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'shutdown' });

  await vi.advanceTimersByTimeAsync(HOST_BOUNDED_SHUTDOWN_MS + EXIT_AND_FLUSH_MARGIN_MS);
  expect(child.kill).not.toHaveBeenCalled();
  child.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(finished).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalledWith('[host] shutdown timed out, killing');
});

it('RF-W06-quit-hard-deadline: forceKill sends SIGKILL to a Host that ignored both shutdown and the SIGTERM kill, and does nothing once it has exited', async () => {
  const log = vi.fn();
  const supervisor = new HostSupervisor({
    entry: '/isolated/host.ts', args: [],
    handshake: { appDataDir: '/isolated/data', appVersion: '0.11.0', platform: 'linux', debug: true },
    onEvent: vi.fn(), onShellRequest: async () => null, onUnavailable: vi.fn(), log,
  });
  supervisor.start();
  const child = vi.mocked(utilityProcess.fork).mock.results[0]!.value as { kill: ReturnType<typeof vi.fn>; emit(event: string, code: number): void; pid?: number };
  child.pid = 424_242;
  const signal = vi.spyOn(process, 'kill').mockImplementation(() => true);
  try {
    void supervisor.shutdown();
    await vi.advanceTimersByTimeAsync(HOST_SHUTDOWN_BUDGET_MS);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(signal).not.toHaveBeenCalled();
    supervisor.forceKill();
    expect(signal.mock.calls).toEqual([[424_242, 'SIGKILL']]);
    expect(log).toHaveBeenCalledWith('[host] still running at the quit deadline, sending SIGKILL');
    child.emit('exit', 0);
    signal.mockClear();
    supervisor.forceKill();
    expect(signal).not.toHaveBeenCalled();
  } finally {
    signal.mockRestore();
  }
});