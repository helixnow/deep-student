/**
 * V04-12：插件（iLink）自启动的时机。
 *
 * Rust `src/lib.rs:1356-1368` 在 setup 末尾 `sleep(3s)` 后调用 `PluginManager::bootstrap_enabled()`（等 DB 和
 * LLM 就绪）；数据治理恢复模式在 setup 中提前 return，根本不注册 PluginManager。Host 对应：`dstu.plugins`
 * 注册启动 finalizer，finalizer 里排 3000 ms 定时器；恢复模式下 serve.ts 不跑 finalizer，于是不自启动。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serveHost, type HostTransport } from '../connection.ts';
import { definePlugin } from '../api.ts';
import { ContractSet } from '../contracts.ts';
import { PluginManager } from '../plugin-manager.ts';
import pluginHost, { PLUGIN_BOOTSTRAP_DELAY_MS, PLUGIN_BOOTSTRAP_FINALIZER } from '../plugins.ts';
import { HOST_PROTOCOL_VERSION, type HostToMain, type MainToHostMessage } from '../protocol.ts';
import { createTestHost } from '../testing.ts';

class TestTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];
  send(message: HostToMain): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.listeners.push(listener); }
  onClose(_listener: () => void): void {}
  close(): void {}
  deliver(message: MainToHostMessage): void { for (const listener of this.listeners) listener(message); }
}

const settings = {
  get: () => null, save: () => undefined, delete: () => false,
  getSecret: async () => null, saveSecret: async () => undefined, deleteSecret: async () => false,
};

/** storage / startupGate / dataSpace 的最小替身：finalizer 按注册顺序执行，与 F3 registry 一致。 */
function platform(order: string[], recovery: boolean) {
  return definePlugin({
    meta: { id: 'fixture.v0412.platform', lane: 'F1-fixture', provides: ['storage', 'startupGate', 'dataSpace', 'settings'] },
    apply(ctx) {
      const finalizers: [string, () => void | Promise<void>][] = [];
      ctx.provide('storage', {
        registerFinalizer: (name: string, fn: () => void | Promise<void>) => { finalizers.push([name, fn]); },
        runStartupFinalizers: async () => {
          for (const [name, fn] of finalizers) { order.push(`finalizer ${name}`); await fn(); }
        },
      });
      ctx.provide('startupGate', { markStartupReady: () => { order.push('gate'); } });
      ctx.provide('dataSpace', { status: () => ({ recovery_required: recovery }) });
      ctx.provide('settings', settings);
    },
  });
}

async function boot(recovery: boolean) {
  const order: string[] = [];
  const transport = new TestTransport();
  const session = serveHost(transport, {
    installs: async () => [{ plugin: pluginHost, source: 'static:plugins' }, { plugin: platform(order, recovery), source: 'static:platform' }],
    contracts: () => ContractSet.fromDirectory(),
  });
  transport.deliver({ kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: '/tmp/v0412', appVersion: '0.0.0-test', platform: 'linux', debug: true });
  const runtime = await session.ready;
  expect(runtime).not.toBeNull();
  expect(runtime!.degradedPlugins()).toEqual([]);
  expect(transport.sent.at(-1)).toEqual({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });
  return { order, session };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('V04-12 dstu.plugins bootstrap_enabled timing', () => {
  it('runs 3000 ms after the startup finalizers, not during plugin apply', async () => {
    const bootstrap = vi.spyOn(PluginManager.prototype, 'bootstrapEnabled').mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { order, session } = await boot(false);
    expect(order).toEqual([`finalizer ${PLUGIN_BOOTSTRAP_FINALIZER}`, 'gate']);
    expect(bootstrap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(PLUGIN_BOOTSTRAP_DELAY_MS - 1);
    expect(bootstrap).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(PLUGIN_BOOTSTRAP_DELAY_MS).toBe(3000);
    vi.useRealTimers();
    await session.shutdown();
  });

  it('never runs in recovery mode (recovery_required: finalizers are skipped)', async () => {
    const bootstrap = vi.spyOn(PluginManager.prototype, 'bootstrapEnabled').mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { order, session } = await boot(true);
    expect(order).toEqual(['gate']);
    await vi.advanceTimersByTimeAsync(10 * PLUGIN_BOOTSTRAP_DELAY_MS);
    expect(bootstrap).not.toHaveBeenCalled();
    vi.useRealTimers();
    await session.shutdown();
  });

  it('a Host shut down inside the 3 s window does not start plugins afterwards', async () => {
    const bootstrap = vi.spyOn(PluginManager.prototype, 'bootstrapEnabled').mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { session } = await boot(false);
    await vi.advanceTimersByTimeAsync(1000);
    const closing = session.shutdown();
    await vi.advanceTimersByTimeAsync(10 * PLUGIN_BOOTSTRAP_DELAY_MS);
    await closing;
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('a host without startup finalizers (TestHost) does not auto-start and says why', async () => {
    const bootstrap = vi.spyOn(PluginManager.prototype, 'bootstrapEnabled').mockResolvedValue(undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const warnings: string[] = [];
    const host = await createTestHost({ provide: { settings } });
    host.ctx.logger.exporter({ levels: { default: 4 }, export: message => { if (message.type === 'warn') warnings.push(String(message.args[0])); } });
    await host.install(pluginHost);
    try {
      await vi.advanceTimersByTimeAsync(10 * PLUGIN_BOOTSTRAP_DELAY_MS);
      expect(bootstrap).not.toHaveBeenCalled();
      expect(warnings).toEqual(['[plugins] no startup finalizers (storage service missing); enabled plugins are not auto-started']);
    } finally {
      vi.useRealTimers();
      await host.dispose();
    }
  });
});
