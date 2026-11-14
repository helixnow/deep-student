/**
 * V06-05：移动端外壳的 Host 生命周期保护与桌面 `electron/shell/host.ts` 一致：就绪超时、Worker 退出时
 * 进行中的调用以退出原因结束、60 秒内最多重启 3 次、fatal 后 5 秒宽限、有序退出后调用立即失败。
 * 假 Worker 用真实 MessageChannel 与外壳通信，按 Host 协议回应握手 / invoke / shutdown。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MainToRenderer } from '../../../electron/shell/bridge-messages.ts';
import {
  FATAL_EXIT_GRACE_MS,
  HostWorkerSupervisor,
  MAX_RESTARTS,
  READY_TIMEOUT_MS,
  RESTART_WINDOW_MS,
  SHUTDOWN_TIMEOUT_MS,
  type WorkerLike,
} from '../../src/shell/host-supervisor.ts';
import { MobileShell } from '../../src/shell/mobile-shell.ts';
import { REPO } from './support/sqlite-node.ts';

type Behavior = 'ready' | 'silent' | 'crash-on-handshake' | 'fatal' | 'fatal-then-exit' | 'ignore-shutdown';

class FakeWorker implements WorkerLike {
  readonly listeners = new Map<string, Array<(event: any) => void>>();
  readonly invokes: string[] = [];
  terminated = false;
  private port: MessagePort | null = null;

  constructor(private readonly behavior: Behavior, private readonly answerInvokes: boolean) {}

  addEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  postMessage(message: { kind: string; port: MessagePort }): void {
    this.port = message.port;
    this.port.addEventListener('message', event => this.fromShell(event.data));
    this.port.start();
  }

  terminate(): void {
    this.terminated = true;
    this.port?.close();
  }

  /** host-worker.ts 的 `exit`：Host 清理完毕后在 Host 端口上报告退出码（`mobile/src/worker/exit-report.ts`）。 */
  exit(code: number): void {
    this.port!.postMessage({ kind: 'dstu-worker-exit', code });
  }

  private fromShell(message: { kind: string; id?: string; protocol?: number; cmd?: string }): void {
    if (this.terminated) return;
    switch (message.kind) {
      case 'handshake':
        if (this.behavior === 'ready' || this.behavior === 'ignore-shutdown') this.port!.postMessage({ kind: 'ready', protocol: message.protocol });
        else if (this.behavior === 'crash-on-handshake') this.emit('error', { message: 'boom' });
        else if (this.behavior === 'fatal') this.port!.postMessage({ kind: 'fatal', message: 'plugin exploded' });
        else if (this.behavior === 'fatal-then-exit') {
          this.port!.postMessage({ kind: 'fatal', message: 'plugin exploded' });
          this.exit(1);
        }
        return;
      case 'invoke':
        this.invokes.push(message.cmd!);
        if (this.answerInvokes) this.port!.postMessage({ kind: 'result', id: message.id, ok: true, value: `${message.cmd} ok` });
        return;
      case 'shutdown':
        if (this.behavior !== 'ignore-shutdown') this.exit(0);
        return;
    }
  }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
};

function harness(behaviors: Behavior[], options: { answerInvokes?: boolean } = {}) {
  const shell = new MobileShell({ handshake: { appDataDir: '/deep-student', appVersion: '0.0.0-test', platform: 'linux', debug: false } });
  const workers: FakeWorker[] = [];
  const logs: string[] = [];
  const unavailable: string[] = [];
  const loaded: number[] = [];
  const supervisor = new HostWorkerSupervisor({
    shell,
    createWorker: () => {
      const worker = new FakeWorker(behaviors[Math.min(workers.length, behaviors.length - 1)]!, options.answerInvokes ?? false);
      workers.push(worker);
      return worker;
    },
    log: message => logs.push(message),
    onUnavailable: reason => unavailable.push(reason),
    onWorkerLoaded: atMs => loaded.push(atMs),
  });
  const results = new Map<number, { ok: boolean; body: unknown }>();
  shell.bridgeTransport().subscribe((message: MainToRenderer) => {
    if (message.type !== 'result') return;
    const body = message.body.kind === 'json' ? JSON.parse(message.body.data) as unknown : message.body.data;
    results.set(message.callbackId % 2 === 0 ? message.callbackId : message.callbackId - 1, { ok: message.callbackId % 2 === 0, body });
  });
  let nextCallback = 0;
  const invoke = (cmd: string) => {
    const callback = (nextCallback += 2);
    shell.bridgeTransport().send({ type: 'invoke', cmd, callback, error: callback + 1, payload: { contentType: 'application/json', data: '{}' }, headers: {} });
    return () => results.get(callback);
  };
  return { shell, supervisor, workers, logs, unavailable, loaded, invoke };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Host Worker supervision', () => {
  it('a Worker crash fails in-flight invokes with the exit reason and restarts the Host', async () => {
    const h = harness(['ready', 'ready']);
    h.supervisor.start();
    await h.shell.ready;
    const pending = h.invoke('get_setting');
    await flush();
    expect(h.workers[0]!.invokes).toEqual(['get_setting']);
    expect(pending()).toBeUndefined();

    h.workers[0]!.emit('error', { message: 'boom' });
    expect(pending()).toEqual({ ok: false, body: 'Mobile Host exited (worker error: boom)' });
    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.workers).toHaveLength(2);
    expect(h.logs).toContain('[host] restarting (1/3)');

    await flush();
    const next = h.invoke('get_setting');
    await flush();
    expect(h.workers[1]!.invokes).toEqual(['get_setting']);
    h.workers[1]!.emit('error', { message: 'again' });
    expect(next()).toEqual({ ok: false, body: 'Mobile Host exited (worker error: again)' });
  });

  it('after an orderly shutdown in-flight invokes fail and later invokes fail immediately', async () => {
    const h = harness(['ready']);
    h.supervisor.start();
    await h.shell.ready;
    const pending = h.invoke('get_setting');
    await flush();
    await h.supervisor.shutdown();
    expect(pending()).toEqual({ ok: false, body: 'Mobile Host exited (code 0)' });
    const later = h.invoke('get_setting');
    expect(later()).toEqual({ ok: false, body: 'Mobile Host exited (code 0)' });
    expect(h.workers).toHaveLength(1);
    expect(h.supervisor.available).toBe(false);
  });

  it('no ready message within STARTUP_READY_WAIT terminates the Worker and counts as a crash', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness(['silent', 'ready']);
    h.supervisor.start();
    await flush();
    vi.advanceTimersByTime(READY_TIMEOUT_MS - 1);
    expect(h.workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.logs).toContain(`[host] no ready message within ${READY_TIMEOUT_MS / 1000}s, terminating`);
    expect(h.workers).toHaveLength(2);
    await flush();
    await h.shell.ready;
  });

  it('gives up after 3 restarts within 60 s: ready rejects and invokes fail immediately', async () => {
    const h = harness(['crash-on-handshake']);
    h.supervisor.start();
    const reason = `Mobile Host exited (worker error: boom); restarted ${MAX_RESTARTS} times within ${RESTART_WINDOW_MS / 1000}s, giving up`;
    await expect(h.shell.ready).rejects.toThrow(reason);
    expect(h.workers).toHaveLength(MAX_RESTARTS + 1);
    expect(h.workers.every(worker => worker.terminated)).toBe(true);
    expect(h.unavailable).toEqual([reason]);
    expect(h.invoke('get_setting')()).toEqual({ ok: false, body: reason });
  });

  it('restarts older than the 60 s window do not count', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = harness(['ready'], { answerInvokes: true });
    h.supervisor.start();
    for (let i = 0; i < MAX_RESTARTS + 2; i++) {
      await flush();
      h.workers.at(-1)!.emit('error', { message: `crash ${i}` });
      vi.advanceTimersByTime(RESTART_WINDOW_MS);
    }
    expect(h.unavailable).toEqual([]);
    expect(h.workers).toHaveLength(MAX_RESTARTS + 3);
  });

  it('fatal: the reason carries the fatal message; a Host that does not exit is terminated after the grace period', async () => {
    const exits = harness(['fatal', 'ready']);
    exits.supervisor.start();
    await flush();
    exits.workers[0]!.exit(1);
    await flush();
    expect(exits.logs).toContain('[host] Mobile Host exited (code 1) after fatal: plugin exploded');
    await exits.shell.ready;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const hangs = harness(['fatal', 'ready']);
    hangs.supervisor.start();
    await flush();
    vi.advanceTimersByTime(FATAL_EXIT_GRACE_MS - 1);
    expect(hangs.workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(hangs.workers[0]!.terminated).toBe(true);
    expect(hangs.logs).toContain(`[host] did not exit within ${FATAL_EXIT_GRACE_MS / 1000}s after fatal, terminating`);
    expect(hangs.workers).toHaveLength(2);
  });

  it('an exit reported right after the fatal still carries the fatal message: both travel on the Host port, in order', async () => {
    const h = harness(['fatal-then-exit', 'ready']);
    h.supervisor.start();
    await h.shell.ready;
    expect(h.logs.filter(line => line.startsWith('[host] Mobile Host exited'))).toEqual(['[host] Mobile Host exited (code 1) after fatal: plugin exploded']);
    expect(h.logs).toContain('[host] restarting (1/3)');
  });

  it('a Host that ignores shutdown is terminated after SHUTDOWN_TIMEOUT_MS; in-flight invokes fail with that reason, no restart', async () => {
    const h = harness(['ignore-shutdown']);
    h.supervisor.start();
    await h.shell.ready;
    const pending = h.invoke('get_setting');
    await flush();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const done = h.supervisor.shutdown();
    vi.advanceTimersByTime(SHUTDOWN_TIMEOUT_MS - 1);
    expect(h.workers[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    await done;
    const reason = 'Mobile Host exited (terminated after shutdown timeout)';
    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.logs).toContain('[host] shutdown timed out, terminating');
    expect(pending()).toEqual({ ok: false, body: reason });
    expect(h.unavailable).toEqual([reason]);
    expect(h.workers).toHaveLength(1);
  });

  it('a message that cannot be deserialized ends the Worker like a crash and restarts the Host', async () => {
    const h = harness(['ready', 'ready']);
    h.supervisor.start();
    await h.shell.ready;
    const pending = h.invoke('get_setting');
    await flush();
    h.workers[0]!.emit('messageerror', {});
    expect(pending()).toEqual({ ok: false, body: 'Mobile Host exited (worker message could not be deserialized)' });
    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.logs).toContain('[host] restarting (1/3)');
    expect(h.workers).toHaveLength(2);
  });

  it('errors and exits from a Worker that was already replaced are ignored', async () => {
    const h = harness(['ready', 'ready'], { answerInvokes: true });
    h.supervisor.start();
    await h.shell.ready;
    h.workers[0]!.emit('error', { message: 'boom' });
    await flush();
    h.workers[0]!.emit('error', { message: 'late error' });
    h.workers[0]!.emit('messageerror', {});
    h.workers[0]!.exit(1);
    await flush();
    expect(h.workers).toHaveLength(2);
    expect(h.workers[1]!.terminated).toBe(false);
    expect(h.logs.filter(line => line.startsWith('[host] restarting'))).toEqual(['[host] restarting (1/3)']);
    const reply = h.invoke('get_setting');
    await flush();
    expect(reply()).toEqual({ ok: true, body: 'get_setting ok' });
  });

  it('a Worker crash during an orderly shutdown ends the Host without a restart; shutdown afterwards returns at once', async () => {
    const h = harness(['ignore-shutdown']);
    h.supervisor.start();
    await h.shell.ready;
    const done = h.supervisor.shutdown();
    h.workers[0]!.emit('error', { message: 'boom during shutdown' });
    await done;
    const reason = 'Mobile Host exited (worker error: boom during shutdown)';
    expect(h.unavailable).toEqual([reason]);
    expect(h.workers).toHaveLength(1);
    expect(h.logs.filter(line => line.startsWith('[host] restarting'))).toEqual([]);
    await h.supervisor.shutdown();
    expect(h.invoke('get_setting')()).toEqual({ ok: false, body: reason });
  });

  it('reports when the Worker has evaluated the Host modules', () => {
    const h = harness(['silent']);
    h.supervisor.start();
    expect(h.loaded).toEqual([]);
    h.workers[0]!.emit('message', { data: { kind: 'dstu-worker-loaded', modulesEvaluatedMs: 12 } });
    expect(h.loaded).toHaveLength(1);
    expect(h.loaded[0]).toBeGreaterThan(0);
  });

  it('uses the desktop supervisor values', () => {
    const desktop = readFileSync(join(REPO, 'electron/shell/host.ts'), 'utf8');
    const api = readFileSync(join(REPO, 'electron/api.ts'), 'utf8');
    const value = (source: string, pattern: RegExp) => Number(pattern.exec(source)?.[1]?.replaceAll('_', ''));
    expect(desktop).toMatch(/const READY_TIMEOUT_MS = STARTUP_READY_WAIT;/);
    expect(READY_TIMEOUT_MS).toBe(value(api, /export const STARTUP_READY_WAIT = ([\d_]+);/));
    expect(RESTART_WINDOW_MS).toBe(value(desktop, /const RESTART_WINDOW_MS = ([\d_]+);/));
    expect(MAX_RESTARTS).toBe(value(desktop, /const MAX_RESTARTS = ([\d_]+);/));
    expect(FATAL_EXIT_GRACE_MS).toBe(value(desktop, /const FATAL_EXIT_GRACE_MS = ([\d_]+);/));
    expect(desktop).toMatch(/async shutdown\(timeoutMs = HOST_SHUTDOWN_BUDGET_MS\)/);
    expect(SHUTDOWN_TIMEOUT_MS).toBe(value(desktop, /export const HOST_SHUTDOWN_BUDGET_MS = ([\d_]+);/));
  });
});
