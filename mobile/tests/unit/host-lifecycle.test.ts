/**
 * 外壳 + supervisor + 真实 Host 会话（kernel `serveImportedHost`）的生命周期。假 Worker 在本线程里经 MessagePort 跑 Host，
 * 与 host-worker.ts 一样经 `exitReportingTransport` 在 Host 端口上报告 `dstu-worker-exit`。语义与桌面 `electron/shell/host.ts` 对照：
 * - 就绪前发出的 invoke 在就绪后得到回复（桌面在外壳排队，移动端由 Host 会话缓冲，`host/kernel/serve.ts`）；
 * - 有序退出：进行中的命令收到放弃信号并结束，插件清理执行，Host 以 0 退出，不重启，之后的调用立即失败；
 * - 启动失败：Host 发 fatal、清理后以 1 退出，supervisor 带 fatal 原因重启，新 Host 就绪后调用正常。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { LaneContract } from '../../../host/kernel/contract.ts';
import { ContractSet, parseContractSource } from '../../../host/kernel/contract-set.ts';
import { definePlugin } from '../../../host/kernel/core.ts';
import type { HostPlugin } from '../../../host/kernel/api.ts';
import type { PluginInstall } from '../../../host/kernel/runtime.ts';
import { serveImportedHost } from '../../../host/kernel/serve.ts';
import { HostWorkerSupervisor, type WorkerLike } from '../../src/shell/host-supervisor.ts';
import { MobileShell } from '../../src/shell/mobile-shell.ts';
import { exitReportingTransport } from '../../src/worker/exit-report.ts';
import { rendererInvoker } from './support/renderer.ts';

const COMMANDS = ['fixture_status', 'fixture_wait'];

const contract: LaneContract = {
  lane: 'W31-fixture', generator: 'hand-written fixture', $defs: {}, events: [],
  commands: COMMANDS.map(name => ({
    name, lane: 'W31-fixture', rust: { file: 'fixture.rs', line: 1, fn: name },
    async: true, args: [], injected: [],
    result: { 'x-rust': 'serde_json::Value' }, error: { 'x-rust': 'serde_json::Value' }, frontend: 'none',
  })),
};

interface PluginState {
  waiting: number;
  aborted: unknown[];
  disposed: number;
}

function lifecyclePlugin(state: PluginState): HostPlugin {
  return definePlugin({
    meta: { id: 'fixture.lifecycle', commands: COMMANDS, platforms: ['mobile'] },
    apply(ctx) {
      ctx.commands.register('fixture_status', () => 'up');
      ctx.commands.register('fixture_wait', (_args, { signal }) => new Promise((_resolve, reject) => {
        state.waiting++;
        signal.addEventListener('abort', () => {
          state.aborted.push(signal.reason);
          reject(signal.reason);
        });
      }));
      ctx.effect(() => () => { state.disposed++; });
    },
  });
}

/** 本线程里的 “Worker”：收到端口就在上面跑 Host；`terminate` 关闭端口（真实 Worker 会被直接结束）。 */
class InProcessWorker implements WorkerLike {
  terminated = false;
  private port: MessagePort | null = null;

  constructor(private readonly installs: () => Promise<readonly PluginInstall[]>) {}

  /** Host 的消息与退出报告都走端口；Worker 自身通道只有 `dstu-worker-loaded` 与错误事件，这里不产生。 */
  addEventListener(): void {}

  postMessage(message: { kind: string; port: MessagePort }): void {
    this.port = message.port;
    const host = exitReportingTransport(message.port);
    serveImportedHost(host.transport, {
      contracts: () => new ContractSet([parseContractSource('W31-fixture.json', JSON.stringify(contract))]),
      platform: 'mobile',
      installs: this.installs,
      exit: host.exit,
    });
  }

  terminate(): void {
    this.terminated = true;
    this.port?.close();
  }
}

const running: HostWorkerSupervisor[] = [];

afterEach(async () => {
  for (const supervisor of running.splice(0)) await supervisor.shutdown();
});

function harness(installs: (attempt: number) => Promise<readonly PluginInstall[]>) {
  const logs: string[] = [];
  const shell = new MobileShell({
    handshake: { appDataDir: '/deep-student', appVersion: '0.0.0-test', platform: 'linux', debug: false },
    log: message => logs.push(message),
  });
  const workers: InProcessWorker[] = [];
  const supervisor = new HostWorkerSupervisor({
    shell,
    createWorker: () => {
      const attempt = workers.length;
      const worker = new InProcessWorker(() => installs(attempt));
      workers.push(worker);
      return worker;
    },
    log: message => logs.push(message),
  });
  running.push(supervisor);
  return { shell, supervisor, workers, logs, invoke: rendererInvoker(shell) };
}

const until = async (condition: () => boolean) => {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

describe('mobile Host lifecycle with the real Host session', () => {
  it('an invoke sent before HostReady is held by the Host session and answered once it is ready', async () => {
    let release!: () => void;
    const booting = new Promise<void>((resolve) => { release = resolve; });
    let installsCalled = false;
    const state: PluginState = { waiting: 0, aborted: [], disposed: 0 };
    const h = harness(async () => {
      installsCalled = true;
      await booting;
      return [{ plugin: lifecyclePlugin(state) }];
    });
    h.supervisor.start();
    let settled = false;
    const early = h.invoke('fixture_status').finally(() => { settled = true; });
    await until(() => installsCalled);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await expect(early).resolves.toEqual({ ok: true, body: 'up' });
    await h.shell.ready;
  });

  it('orderly shutdown: the in-flight command is abandoned and settles, plugins are disposed, the Host exits 0 and is not restarted', async () => {
    const state: PluginState = { waiting: 0, aborted: [], disposed: 0 };
    const h = harness(async () => [{ plugin: lifecyclePlugin(state) }]);
    h.supervisor.start();
    await h.shell.ready;
    const inflight = h.invoke('fixture_wait');
    await until(() => state.waiting === 1);

    await h.supervisor.shutdown();
    // Host 先中止进行中的命令、等插件清理完再关端口，所以命令自己的拒绝（kernel 统一内部错误）先于退出原因到达。
    await expect(inflight).resolves.toEqual({ ok: false, body: { error_type: 'Unknown', message: 'reloaded', details: null } });
    expect(state.aborted).toEqual(['reloaded']);
    expect(state.disposed).toBe(1);
    expect(h.workers).toHaveLength(1);
    expect(h.workers[0]!.terminated).toBe(true);
    expect(h.supervisor.available).toBe(false);
    expect(h.logs).not.toContain('[host] shutdown timed out, terminating');
    await expect(h.invoke('fixture_status')).resolves.toEqual({ ok: false, body: 'Mobile Host exited (code 0)' });
  });

  it('a Host that fails to boot sends fatal, exits 1 after cleanup and is restarted; the new Host serves invokes', async () => {
    const state: PluginState = { waiting: 0, aborted: [], disposed: 0 };
    const h = harness(async (attempt) => {
      if (attempt === 0) throw new Error('profile module failed to evaluate');
      return [{ plugin: lifecyclePlugin(state) }];
    });
    h.supervisor.start();
    await h.shell.ready;
    expect(h.logs.filter(line => line.startsWith('[host] fatal: profile module failed to evaluate'))).toHaveLength(1);
    expect(h.logs).toContain('[host] Mobile Host exited (code 1) after fatal: profile module failed to evaluate');
    expect(h.logs).toContain('[host] restarting (1/3)');
    expect(h.workers.map(worker => worker.terminated)).toEqual([true, false]);
    await expect(h.invoke('fixture_status')).resolves.toEqual({ ok: true, body: 'up' });
  });
});
