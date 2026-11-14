/**
 * `serveHost({ installs })`：没有文件系统 profile 的宿主（移动端 Web Worker）以预先静态导入的插件启动。
 *
 * 与文件 profile 启动的差别只在“条目从哪里来”：安装隔离、启动 finalizer、startupGate、UI 清单、
 * HostReady 顺序保持不变。
 */
import { describe, expect, it } from 'vitest';
import { serveHost, type HostTransport } from '../connection.ts';
import { definePlugin } from '../api.ts';
import { AppError } from '../../platform/errors/api.ts';
import { ContractSet } from '../contracts.ts';
import { HOST_PROTOCOL_VERSION, type HostToMain, type MainToHostMessage } from '../protocol.ts';
import type { PluginInstall } from '../runtime.ts';

const SOURCE = { window: 'main', webview: 'main' };

class TestTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];
  send(message: HostToMain): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.listeners.push(listener); }
  onClose(_listener: () => void): void {}
  close(): void {}
  deliver(message: MainToHostMessage): void { for (const listener of this.listeners) listener(message); }
}

function handshake(): MainToHostMessage {
  return { kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: '/opfs/deep-student', appVersion: '0.0.0-test', platform: 'linux', debug: true };
}

function fixtures(order: string[]) {
  const storage = definePlugin({
    meta: { id: 'fixture.preimported.storage', lane: 'F1-fixture', provides: ['storage', 'startupGate'] },
    apply(ctx) {
      ctx.provide('storage', { runStartupFinalizers: async () => { order.push('finalizers'); } });
      ctx.provide('startupGate', { markStartupReady: () => { order.push('gate'); } });
    },
  });
  const probe = definePlugin({
    meta: { id: 'fixture.preimported.probe', lane: 'F1-fixture', provides: ['probe'], remote: { probe: ['double'] } },
    inject: ['storage'],
    apply(ctx) {
      order.push('probe.apply');
      ctx.provide('probe', { double: (value: number) => value * 2 });
    },
  });
  const orphan = definePlugin({
    meta: { id: 'fixture.preimported.orphan', lane: 'F1-fixture' },
    inject: ['notProvidedAnywhere'],
    apply() { order.push('orphan.apply'); },
  });
  return { storage, probe, orphan };
}

describe('serveHost with pre-imported installs', () => {
  it('settles ready when shut down before the handshake', async () => {
    const session = serveHost(new TestTransport(), {
      installs: async () => [], contracts: () => new ContractSet([]),
    });
    await session.shutdown();
    expect(await session.ready).toBeNull();
  });

  it('settles ready when shut down while installs are still loading', async () => {
    let release!: () => void;
    const loading = new Promise<void>(resolve => { release = resolve; });
    const transport = new TestTransport();
    const session = serveHost(transport, {
      installs: async () => { await loading; return []; }, contracts: () => new ContractSet([]),
    });
    transport.deliver(handshake());
    await session.shutdown();
    expect(await session.ready).toBeNull();
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(transport.sent).toEqual([]);
  });

  it('installs the given plugins without reading any profile file, then finalizes and reports ready', async () => {
    const order: string[] = [];
    const { storage, probe, orphan } = fixtures(order);
    const transport = new TestTransport();
    let requested = 0;
    const installs = async (): Promise<PluginInstall[]> => {
      requested++;
      // 故意把消费者排在提供方之前：仍按依赖拓扑排序安装。
      return [{ plugin: probe, source: 'static:probe' }, { plugin: orphan, source: 'static:orphan' }, { plugin: storage, source: 'static:storage' }];
    };
    const session = serveHost(transport, {
      installs,
      // 不存在的路径：若仍按文件 profile 启动就会 HostFatal。
      profile: '/definitely/not/a/profile.json',
      contracts: () => new ContractSet([]),
    });
    transport.deliver(handshake());
    const runtime = await session.ready;

    expect(runtime).not.toBeNull();
    expect(requested).toBe(1);
    expect(order).toEqual(['probe.apply', 'finalizers', 'gate']);
    expect(transport.sent.filter(m => m.kind === 'fatal')).toEqual([]);
    expect(transport.sent.at(-1)).toEqual({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });
    expect(runtime!.degradedPlugins()).toEqual([{ id: 'fixture.preimported.orphan', reason: 'SERVICE_MISSING: missing service "notProvidedAnywhere"' }]);

    transport.deliver({ kind: 'invoke', id: 'call-1', cmd: 'plugin:host|call', args: { caller: 'fixture.preimported.probe', service: 'probe', method: 'double', args: [21] }, source: SOURCE });
    await expect.poll(() => transport.sent.find(m => m.kind === 'result' && m.id === 'call-1')).toEqual({ kind: 'result', id: 'call-1', ok: true, value: 42 });
    expect(runtime!.hostCallCaller).toBe('require');
    expect(runtime!.hostCallsWithoutCaller()).toEqual({});
    await session.shutdown();
  });

  it('hostCallCaller: require reaches the runtime: callerless plugin:host|call is refused over the transport, the own caller passes', async () => {
    const order: string[] = [];
    const { storage, probe } = fixtures(order);
    const transport = new TestTransport();
    const session = serveHost(transport, {
      installs: async () => [{ plugin: storage, source: 'static:storage' }, { plugin: probe, source: 'static:probe' }],
      contracts: () => new ContractSet([]),
      hostCallCaller: 'require',
    });
    transport.deliver(handshake());
    const runtime = await session.ready;
    expect(runtime!.hostCallCaller).toBe('require');
    const result = (id: string) => transport.sent.find(m => m.kind === 'result' && m.id === id);

    transport.deliver({ kind: 'invoke', id: 'anonymous', cmd: 'plugin:host|call', args: { service: 'probe', method: 'double', args: [21] }, source: SOURCE });
    await expect.poll(() => result('anonymous')).toEqual({
      kind: 'result', id: 'anonymous', ok: false,
      error: AppError.validation('plugin:host|call requires "caller", the plugin id of the calling UI half (SEC-E06)'),
    });
    transport.deliver({ kind: 'invoke', id: 'own', cmd: 'plugin:host|call', args: { caller: 'fixture.preimported.probe', service: 'probe', method: 'double', args: [21] }, source: SOURCE });
    await expect.poll(() => result('own')).toEqual({ kind: 'result', id: 'own', ok: true, value: 42 });
    expect(runtime!.hostCallsWithoutCaller()).toEqual({});
    await session.shutdown();
  });

  it('reports HostFatal when the installs factory itself fails', async () => {
    const transport = new TestTransport();
    const exits: number[] = [];
    const session = serveHost(transport, {
      installs: async () => { throw new Error('bundle chunk failed to load'); },
      contracts: () => new ContractSet([]),
      exit: code => exits.push(code),
    });
    transport.deliver(handshake());
    expect(await session.ready).toBeNull();
    expect(transport.sent).toEqual([expect.objectContaining({ kind: 'fatal', message: 'bundle chunk failed to load' })]);
    await expect.poll(() => exits).toEqual([1]);
  });
});
