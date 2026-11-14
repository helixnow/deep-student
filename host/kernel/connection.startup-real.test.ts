/**
 * D2 真实组合链：生产 `serveHost` + F3 `StorageCordisService`/`StartupFinalizerRegistry` +
 * F2 `createStartupGate`。不使用同义 registry 替身。
 *
 * 覆盖：正常执行顺序与 gate 时序、执行失败（HostFatal/no ready/no gate/无自动重试）、
 * 恢复模式（跳过业务 finalizer 仍 mark gate）、业务插件注册失败（当前隔离规则与部分注册泄漏）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import { serveHost, type HostTransport } from './connection.ts';
import { ContractSet } from './contracts.ts';
import type { HostRuntime } from './runtime.ts';
import { HOST_PROTOCOL_VERSION, type Handshake, type HostToMain, type MainToHostMessage } from './protocol.ts';
import { realStartupStates } from './__fixtures__/startup-real.plugin.ts';
import { realHookStates } from './__fixtures__/startup-hook.plugin.ts';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dstu-connection-real-'));

afterAll(() => rmSync(DATA_DIR, { recursive: true, force: true }));

class TestTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly messageListeners: ((message: unknown) => void)[] = [];

  send(message: HostToMain): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.messageListeners.push(listener); }
  onClose(_listener: () => void): void {}
  close(): void {}
  deliver(message: MainToHostMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

function handshake(overrides: Partial<Handshake> = {}): Handshake {
  return {
    kind: 'handshake',
    protocol: HOST_PROTOCOL_VERSION,
    appDataDir: DATA_DIR,
    appVersion: '0.0.0-test',
    platform: 'linux',
    debug: true,
    ...overrides,
  };
}

function hostLogs(runtime: HostRuntime): string[] {
  const logs: string[] = [];
  runtime.ctx.logger.exporter({
    export(message) { logs.push(`${message.type} [${message.name}] ${format(...(message.args as unknown[]))}`); },
  });
  return logs;
}

async function boot(profile: string) {
  const transport = new TestTransport();
  const exits: number[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  const before = realStartupStates.length;
  const hookBefore = realHookStates.length;
  let logs: string[] = [];
  const session = serveHost(transport, {
    profile: `${FIXTURES}${profile}`,
    contracts: () => new ContractSet([]),
    onRuntime: (runtime) => { logs = hostLogs(runtime); },
    exit: (code) => {
      exits.push(code);
      resolveExit(code);
    },
  });
  transport.deliver(handshake());
  const runtime = await session.ready;
  return {
    transport,
    session,
    runtime,
    exits,
    exited,
    logs,
    state: realStartupStates[before],
    hookState: realHookStates[hookBefore],
  };
}

function fatalMessage(messages: readonly HostToMain[]): string | undefined {
  const fatal = messages.find(message => message.kind === 'fatal');
  return fatal?.kind === 'fatal' ? fatal.message : undefined;
}

describe('startup composition root (D2, real F3 registry)', () => {
  it('runs the real registry in dependency order and marks the real gate only afterwards', async () => {
    const { transport, session, runtime, exits, state } = await boot('startup-real.profile.json');
    expect(runtime).not.toBeNull();
    expect(state).toBeDefined();
    expect(transport.sent.some(message => message.kind === 'ready')).toBe(true);
    expect(state!.runs).toEqual(['migrate', 'restore', 'cleanup']);
    // gate 必须在全部 finalizer 成功后才 mark；finalizer 执行期间仍是未就绪。
    expect(state!.gateReadyAtRun).toEqual([false, false, false]);
    expect(state!.gate.isStartupReady()).toBe(true);
    expect(state!.storage.finalizerNames()).toEqual([
      'fixture.startup-real.migrate',
      'fixture.startup-real.restore',
      'fixture.startup-real.cleanup',
    ]);
    expect(transport.sent.some(message => message.kind === 'event' && message.event === 'host://plugins-degraded')).toBe(false);
    await session.shutdown();
    expect(exits).toEqual([0]);
  });

  it('fails boot on a real finalizer error without ready, gate mark or automatic retry', async () => {
    const { transport, runtime, exits, exited, logs, state } = await boot('startup-real-failure.profile.json');
    expect(runtime).toBeNull();
    expect(transport.sent.some(message => message.kind === 'ready')).toBe(false);
    expect(fatalMessage(transport.sent)).toContain('startup finalizer failed: fixture.startup-real.restore');
    // 失败前已完成的钩子保留在 registry；失败钩子只执行一次——boot 不 retry。
    expect(state!.runs).toEqual(['migrate', 'restore']);
    expect(state!.gateReadyAtRun).toEqual([false, false]);
    expect(state!.gate.isStartupReady()).toBe(false);
    expect(logs.some(line => line.includes('startup finalization failed at runStartupFinalizers'))).toBe(true);
    expect(logs.some(line => line.includes('finalizer: fixture.startup-real.restore'))).toBe(true);
    expect(logs.some(line => line.includes('completed: fixture.startup-real.migrate'))).toBe(true);
    expect(logs.some(line => line.includes('real restore finalizer failed'))).toBe(true);
    // finalizer 失败不是插件 apply 失败，不产生 degraded 事件。
    expect(transport.sent.some(message => message.kind === 'event' && message.event === 'host://plugins-degraded')).toBe(false);
    await expect(exited).resolves.toBe(1);
    expect(exits).toEqual([1]);
  });

  it('skips all business finalizers in recovery mode but still marks the gate', async () => {
    const { transport, session, runtime, exits, state } = await boot('startup-real-recovery.profile.json');
    expect(runtime).not.toBeNull();
    expect(transport.sent.some(message => message.kind === 'ready')).toBe(true);
    // 注册仍然发生（apply 已完成），但组合根在恢复模式不 run。
    expect(state!.storage.finalizerNames()).toEqual([
      'fixture.startup-real.migrate',
      'fixture.startup-real.restore',
      'fixture.startup-real.cleanup',
    ]);
    expect(state!.runs).toEqual([]);
    expect(state!.gate.isStartupReady()).toBe(true);
    await session.shutdown();
    expect(exits).toEqual([0]);
  });

  it('documents current apply isolation when a business plugin cannot register a finalizer', async () => {
    const { transport, session, runtime, exits, state, hookState } = await boot('startup-real-registration.profile.json');
    expect(runtime).not.toBeNull();
    expect(transport.sent.some(message => message.kind === 'ready')).toBe(true);
    // 既有规则：业务插件 apply 失败只隔离自身，全局 boot 仍 ready。
    expect(runtime!.degradedPlugins()).toEqual([
      expect.objectContaining({
        id: 'fixture.startup-hook',
        reason: expect.stringContaining('already registered'),
      }),
    ]);
    const degraded = transport.sent.find(message => message.kind === 'event' && message.event === 'host://plugins-degraded');
    expect(degraded).toMatchObject({ kind: 'event', target: { kind: 'Any' } });
    expect((degraded as { payload: unknown }).payload).toEqual([
      expect.objectContaining({ id: 'fixture.startup-hook' }),
    ]);
    // 当前 F3 registerFinalizer 没有注销句柄：插件回滚后，第一次注册的钩子仍被执行。
    // 这是“注册失败但启动仍 ready”的现有行为，必需恢复/清理钩子的政策待架构师裁定。
    expect(hookState!.executed).toEqual(['cleanup']);
    expect(state!.runs).toEqual(['migrate', 'restore', 'cleanup']);
    expect(state!.gate.isStartupReady()).toBe(true);
    await session.shutdown();
    expect(exits).toEqual([0]);
  });
});
