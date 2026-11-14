/** Exercise the production supervisor; replace only Electron's process/port boundary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageChannelMain, utilityProcess } from 'electron';
import { existsSync } from 'node:fs';
import { HOST_PROTOCOL_VERSION } from '../../host/kernel/protocol.ts';
import { createBackgroundTasks } from '../../host/platform/diagnostics/background-tasks.ts';
import { STARTUP_READY_WAIT } from '../api.ts';
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
vi.mock('node:fs', async (importOriginal) => ({ ...await importOriginal<typeof import('node:fs')>(), existsSync: vi.fn(() => false) }));

beforeEach(() => { vi.clearAllMocks(); vi.mocked(existsSync).mockReturnValue(false); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function start() {
  const log = vi.fn();
  const supervisor = new HostSupervisor({
    entry: '/isolated/host.ts', args: [],
    handshake: { appDataDir: '/isolated/data', appVersion: '0.11.0', platform: 'linux', debug: true },
    onEvent: vi.fn(), onShellRequest: async () => null, onUnavailable: vi.fn(), log,
  });
  supervisor.start();
  return {
    supervisor,
    child: vi.mocked(utilityProcess.fork).mock.results[0]!.value,
    port: vi.mocked(MessageChannelMain).mock.results[0]!.value.port1,
    log,
  };
}

it('a slow startup is not killed at 30 seconds before the Rust startup budget expires', () => {
  const { child, port, log } = start();
  vi.advanceTimersByTime(31_000);
  expect(child.kill).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalled();
  port.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
  vi.advanceTimersByTime(STARTUP_READY_WAIT);
  expect(child.kill).not.toHaveBeenCalled();
});

it('a Host that never becomes ready is still killed at the bounded startup deadline', () => {
  const { child, log } = start();
  vi.advanceTimersByTime(STARTUP_READY_WAIT - 1);
  expect(child.kill).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('[host] no ready message within 120s, killing');
});

it('HostFatal lets the Host finish its own cleanup and exit code 1 instead of killing it at once', () => {
  const { child, port, log } = start();
  port.emit('message', { data: { kind: 'fatal', message: 'profile failed to load' } });
  expect(log).toHaveBeenCalledWith('[host] fatal: profile failed to load');
  vi.advanceTimersByTime(4_999);
  expect(child.kill).not.toHaveBeenCalled();
  child.emit('exit', 1);
  expect(log).toHaveBeenCalledWith('[host] Desktop Host exited (code 1)');
  vi.advanceTimersByTime(10_000);
  expect(child.kill).not.toHaveBeenCalled();
});

it('a Host that reports HostFatal but never exits is killed after the grace period', () => {
  const { child, port, log } = start();
  port.emit('message', { data: { kind: 'fatal', message: 'stuck' } });
  vi.advanceTimersByTime(5_000);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('[host] did not exit within 5s after fatal, killing');
});

it('ordered shutdown leaves the Host 2s for storage/log cleanup after its full background-task wait', async () => {
  const background = createBackgroundTasks();
  background.spawn(() => new Promise<never>(() => undefined));
  const waitStarted = Date.now();
  let hostWaited: number | null = null;
  void background.shutdown().then(() => { hostWaited = Date.now() - waitStarted; });
  await vi.runAllTimersAsync();
  expect(hostWaited).toBeGreaterThan(0);

  const { supervisor, child, port, log } = start();
  port.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
  let finished = false;
  void supervisor.shutdown().then(() => { finished = true; });
  expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'shutdown' });
  await vi.advanceTimersByTimeAsync(hostWaited! + 2_000);
  expect(child.kill).not.toHaveBeenCalled();
  child.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalledWith('[host] shutdown timed out, killing');
});

it('a Host that never exits after shutdown is still killed at the shutdown budget', async () => {
  const { supervisor, child, port, log } = start();
  port.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
  void supervisor.shutdown();
  await vi.advanceTimersByTimeAsync(HOST_SHUTDOWN_BUDGET_MS - 1);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('[host] shutdown timed out, killing');
});

describe('the Host compile cache directory', () => {
  const forkEnv = () => (vi.mocked(utilityProcess.fork).mock.calls.at(-1)![2] as { env?: NodeJS.ProcessEnv }).env;
  const startWith = (compileCacheDir: string | undefined) => new HostSupervisor({
    entry: '/isolated/host.ts', args: [],
    handshake: { appDataDir: '/isolated/data', appVersion: '0.11.0', platform: 'linux', debug: true },
    onEvent: vi.fn(), onShellRequest: async () => null, onUnavailable: vi.fn(), log: vi.fn(),
    ...(compileCacheDir === undefined ? {} : { compileCacheDir }),
  }).start();
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.NODE_COMPILE_CACHE; delete process.env.NODE_COMPILE_CACHE; });
  afterEach(() => { if (saved === undefined) delete process.env.NODE_COMPILE_CACHE; else process.env.NODE_COMPILE_CACHE = saved; });

  it('is given to the Host as NODE_COMPILE_CACHE, on top of the environment main prepared before the fork', () => {
    process.env.DS_SHELL_OS_DIRS_PROBE = 'from-main';
    try {
      startWith('/isolated/userdata/host-compile-cache');
      expect(forkEnv()).toMatchObject({ NODE_COMPILE_CACHE: '/isolated/userdata/host-compile-cache', DS_SHELL_OS_DIRS_PROBE: 'from-main' });
    } finally {
      delete process.env.DS_SHELL_OS_DIRS_PROBE;
    }
  });

  it('a NODE_COMPILE_CACHE kept in the environment (development only) wins; without a directory the Host inherits main\'s environment', () => {
    process.env.NODE_COMPILE_CACHE = '/dev/override';
    startWith('/isolated/userdata/host-compile-cache');
    expect(forkEnv()).toBeUndefined();
    delete process.env.NODE_COMPILE_CACHE;
    startWith(undefined);
    expect(forkEnv()).toBeUndefined();
  });
});

const pageLoad = { kind: 'window', ref: { window: 'main', webview: 'main' }, state: 'page-load-started' } as const;
const posted = (port: { postMessage: ReturnType<typeof vi.fn> }) => port.postMessage.mock.calls.map(([message]) => message as { kind: string });

it('page-load-started sent before HostReady is buffered and delivered once, in order, after ready', () => {
  const supervisor = new HostSupervisor({
    entry: '/isolated/host.ts', args: [],
    handshake: { appDataDir: '/isolated/data', appVersion: '0.11.0', platform: 'linux', debug: true },
    onEvent: vi.fn(), onShellRequest: async () => null, onUnavailable: vi.fn(), log: vi.fn(),
  });
  supervisor.start();
  const port = vi.mocked(MessageChannelMain).mock.results[0]!.value.port1;
  supervisor.sendMessage({ kind: 'window', ref: { window: 'main', webview: 'main' }, state: 'created' });
  supervisor.sendMessage(pageLoad);
  expect(posted(port).map((message) => message.kind)).toEqual(['handshake']);
  port.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
  expect(posted(port).slice(1)).toEqual([{ kind: 'window', ref: { window: 'main', webview: 'main' }, state: 'created' }, pageLoad]);
  supervisor.sendMessage(pageLoad);
  expect(posted(port).slice(1)).toEqual([{ kind: 'window', ref: { window: 'main', webview: 'main' }, state: 'created' }, pageLoad, pageLoad]);
});

it('page-load-started sent while a crashed Host restarts is delivered to the restarted Host after its ready', () => {
  const supervisor = new HostSupervisor({
    entry: '/isolated/host.ts', args: [],
    handshake: { appDataDir: '/isolated/data', appVersion: '0.11.0', platform: 'linux', debug: true },
    onEvent: vi.fn(), onShellRequest: async () => null, onUnavailable: vi.fn(), log: vi.fn(),
  });
  supervisor.start();
  const firstChild = vi.mocked(utilityProcess.fork).mock.results[0]!.value;
  const firstPort = vi.mocked(MessageChannelMain).mock.results[0]!.value.port1;
  firstPort.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
  firstChild.emit('exit', 1);
  supervisor.sendMessage(pageLoad);
  const secondPort = vi.mocked(MessageChannelMain).mock.results[1]!.value.port1;
  expect(posted(firstPort).map((message) => message.kind)).toEqual(['handshake']);
  expect(posted(secondPort).map((message) => message.kind)).toEqual(['handshake']);
  secondPort.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
  expect(posted(secondPort).slice(1)).toEqual([pageLoad]);
});

describe('startup attempt and unexpected-exit hooks', () => {
  function supervised(options: { onUnexpectedExit?: (ready: boolean) => boolean } = {}) {
    const onStartAttempt = vi.fn();
    const onUnavailable = vi.fn();
    const onUnexpectedExit = vi.fn(options.onUnexpectedExit ?? (() => true));
    const supervisor = new HostSupervisor({
      entry: '/isolated/host.ts', args: [],
      handshake: { appDataDir: '/isolated/data', appVersion: '0.11.0', platform: 'linux', debug: true },
      onEvent: vi.fn(), onShellRequest: async () => null, onUnavailable, onStartAttempt, onUnexpectedExit, log: vi.fn(),
    });
    supervisor.start();
    return { supervisor, onStartAttempt, onUnavailable, onUnexpectedExit };
  }

  it('RF-W06-startup-recovery: reports every start attempt (including automatic restarts) and the readiness of the exiting Host', () => {
    const { onStartAttempt, onUnexpectedExit } = supervised();
    expect(onStartAttempt).toHaveBeenCalledTimes(1);
    const firstChild = vi.mocked(utilityProcess.fork).mock.results[0]!.value;
    firstChild.emit('exit', 1);
    expect(onUnexpectedExit).toHaveBeenLastCalledWith(false);
    expect(onStartAttempt).toHaveBeenCalledTimes(2);

    const port = vi.mocked(MessageChannelMain).mock.results[1]!.value.port1;
    port.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
    const secondChild = vi.mocked(utilityProcess.fork).mock.results[1]!.value;
    secondChild.emit('exit', 1);
    expect(onUnexpectedExit).toHaveBeenLastCalledWith(true);
  });

  it('a false verdict stops automatic restart and reports the Host unavailable', () => {
    const { onUnavailable, onUnexpectedExit } = supervised({ onUnexpectedExit: () => false });
    const child = vi.mocked(utilityProcess.fork).mock.results[0]!.value;
    child.emit('exit', 1);
    expect(onUnexpectedExit).toHaveBeenCalledWith(false);
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable.mock.calls[0]![0]).toContain('startup recovery required');
    expect(vi.mocked(utilityProcess.fork)).toHaveBeenCalledTimes(1);
  });

  it('ordered shutdown does not consult the unexpected-exit hook', async () => {
    const { supervisor, onUnexpectedExit } = supervised();
    const child = vi.mocked(utilityProcess.fork).mock.results[0]!.value;
    void supervisor.shutdown();
    child.emit('exit', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });
});

describe('automatic user plugin crash isolation', () => {
  it('recovers before the native crash-loop gate, keeps the profile intact and reports isolation after ready', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const onEvent = vi.fn();
    const onUnexpectedExit = vi.fn(() => false);
    const args = ['--contracts=/contracts'];
    const supervisor = new HostSupervisor({
      entry: '/isolated/host.ts', args,
      handshake: { appDataDir: '/isolated/data', appVersion: '0.11.0', platform: 'linux', debug: true },
      onEvent, onUnexpectedExit, onShellRequest: async () => null, onUnavailable: vi.fn(), log: vi.fn(),
    });
    supervisor.start();
    vi.mocked(utilityProcess.fork).mock.results[0]!.value.emit('exit', 1);
    expect(existsSync).toHaveBeenCalledWith('/isolated/data/plugins/user.profile.json');
    expect(supervisor.userPluginsIsolated).toBe(true);
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(vi.mocked(utilityProcess.fork).mock.calls[1]![1]).toEqual(['--contracts=/contracts', '--safe-mode']);
    expect(args).toEqual(['--contracts=/contracts']);
    const port = vi.mocked(MessageChannelMain).mock.results[1]!.value.port1;
    port.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: 'host://plugin-profile-failed', payload: expect.objectContaining({ isolated: true }),
    }));
  });

  it('covers full-trust plugins that crash shortly after HostReady, and keeps subsequent spawns isolated', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const { supervisor, child, port } = start();
    port.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
    vi.advanceTimersByTime(1_000);
    child.emit('exit', 1);
    vi.mocked(utilityProcess.fork).mock.results[1]!.value.emit('exit', 1);
    expect(supervisor.userPluginsIsolated).toBe(true);
    expect(vi.mocked(utilityProcess.fork).mock.calls.slice(1).every(call => call[1]?.includes('--safe-mode'))).toBe(true);
  });

  it('does not isolate ordinary crashes after a stable run', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const { supervisor, child, port } = start();
    port.emit('message', { data: { kind: 'ready', protocol: HOST_PROTOCOL_VERSION } });
    vi.advanceTimersByTime(60_001);
    child.emit('exit', 1);
    expect(supervisor.userPluginsIsolated).toBe(false);
    expect(vi.mocked(utilityProcess.fork).mock.calls[1]![1]).toEqual([]);
  });

  it('still bounds retries if even the official-only Host cannot start', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const { supervisor } = start();
    for (let index = 0; index < 4; index++) vi.mocked(utilityProcess.fork).mock.results[index]!.value.emit('exit', 1);
    expect(utilityProcess.fork).toHaveBeenCalledTimes(4);
    expect(supervisor.available).toBe(false);
  });

  it('pipes stdout and stderr instead of inheriting console handles that fail in Windows GUI launches', () => {
    start();
    const forkOptions = vi.mocked(utilityProcess.fork).mock.calls[0]![2];
    expect(forkOptions?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });
});
