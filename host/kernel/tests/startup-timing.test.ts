/**
 * 启动计时（STARTUP-PROFILE.md）：`serveHost` 记录阶段与每个插件的 apply 耗时，HostReady 时写一行 info 摘要。
 * 计时只是旁路记录：装载顺序、隔离与 HostReady 不变（由 serve-preimported / profile-* 测试守护）。
 */
import { format } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '../api.ts';
import { serveHost, type HostTransport } from '../connection.ts';
import { ContractSet } from '../contracts.ts';
import { HOST_PROTOCOL_VERSION, type HostToMain, type MainToHostMessage } from '../protocol.ts';
import { StartupTimeline } from '../startup-timing.ts';

class TestTransport implements HostTransport {
  readonly sent: HostToMain[] = [];
  private readonly listeners: ((message: unknown) => void)[] = [];
  send(message: HostToMain): void { this.sent.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.listeners.push(listener); }
  onClose(_listener: () => void): void {}
  close(): void {}
  deliver(message: MainToHostMessage): void { for (const listener of this.listeners) listener(message); }
}

describe('startup timing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('records boot phases in order and one apply timing per installed or failed plugin', async () => {
    // Scheduling pauses can make the throwing plugin slower than a real 30ms timer on CI.
    // Control the measurement clock, while keeping the real asynchronous plugin lifecycle.
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const slow = definePlugin({
      meta: { id: 'fixture.timing.slow', lane: 'F1-fixture', provides: ['storage'] },
      async apply(ctx) {
        await Promise.resolve();
        now += 30;
        ctx.provide('storage', {});
      },
    });
    const broken = definePlugin({
      meta: { id: 'fixture.timing.broken', lane: 'F1-fixture' },
      inject: ['storage'],
      apply() { now += 1; throw new Error('apply failed on purpose'); },
    });
    const inactive = definePlugin({
      meta: { id: 'fixture.timing.inactive', lane: 'F1-fixture' },
      inject: ['notProvidedAnywhere'],
      apply() {},
    });
    const transport = new TestTransport();
    const logs: string[] = [];
    const session = serveHost(transport, {
      installs: async () => [{ plugin: broken }, { plugin: inactive }, { plugin: slow }],
      contracts: () => new ContractSet([]),
      onRuntime: runtime => runtime.ctx.logger.exporter({ export: message => { logs.push(`${message.type} [${message.name}] ${format(...(message.args as unknown[]))}`); } }),
    });
    transport.deliver({ kind: 'handshake', protocol: HOST_PROTOCOL_VERSION, appDataDir: '/tmp/dstu-timing', appVersion: '0.0.0-test', platform: 'linux', debug: true });
    const runtime = await session.ready;
    expect(runtime).not.toBeNull();

    const timings = runtime!.startup.snapshot();
    expect(timings.phases.map(phase => phase.name)).toEqual([
      'handshake', 'contracts loaded', 'runtime created', 'modules imported', 'plugins installed', 'finalizers done', 'ready',
    ]);
    const at = timings.phases.map(phase => phase.at);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // inactive 条目不安装，因此没有 apply 计时；失败的 apply 记为 ok: false。
    expect(timings.installs.map(({ id, ok }) => ({ id, ok }))).toEqual([
      { id: 'fixture.timing.slow', ok: true },
      { id: 'fixture.timing.broken', ok: false },
    ]);
    expect(timings.installs.map(({ ms }) => ms)).toEqual([30, 1]);

    const summary = logs.filter(line => line.startsWith('info [host] startup: ready at '));
    expect(summary, logs.join('\n')).toHaveLength(1);
    expect(summary[0]).toContain('slowest apply: fixture.timing.slow ');
    expect(transport.sent.at(-1)).toEqual({ kind: 'ready', protocol: HOST_PROTOCOL_VERSION });
    await session.shutdown();
  });

  it('summary lists phase deltas and only the slowest applies', () => {
    vi.spyOn(performance, 'now').mockReturnValue(100);
    const timeline = new StartupTimeline();
    timeline.mark('handshake', 100);
    timeline.mark('ready', 350);
    for (let i = 0; i < 12; i++) timeline.recordInstall(`p${i}`, performance.now() - i, true);
    const summary = timeline.summary(3);
    expect(summary).toMatch(/^startup: ready at 350ms after process start \(handshake at 100ms; ready \+250ms\); slowest apply: p11 [\d.]+ms, p10 [\d.]+ms, p9 [\d.]+ms$/);
  });
});
