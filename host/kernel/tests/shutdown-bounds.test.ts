/**
 * V09 P1-1（V09-dispose-leaks.md R1/R1b）与 P1-5 的内核部分：
 * - 处理器不理 abort 时，`unload` 与 `runtime.dispose()` 在命令关闭截止时间（默认 2000 ms）后返回，先装插件的清理照常执行；
 * - 某个插件的 disposer 挂住时，dispose 最多等它 PLUGIN_DISPOSE_TIMEOUT_MS，后面的插件照常 dispose；
 * - `host/exiting` 在任何命令中止与插件 dispose 之前发出一次（serve 的 shutdown 消息为 `shutdown`，直接 dispose 为 `dispose`）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MessageChannel } from 'node:worker_threads';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost, definePlugin, type TestHost } from '../testing.ts';
import { COMMAND_CLOSE_TIMEOUT_MS, CORE_DISPOSE_RESERVE_MS, DISPOSE_PHASE_BUDGET_MS, PLUGIN_DISPOSE_TIMEOUT_MS } from '../runtime.ts';
import { serveHost } from '../connection.ts';
import { messagePortTransport } from '../transports.ts';
import { ContractSet } from '../contracts.ts';
import type { LaneContract } from '../contract.ts';
import type { HostExiting } from '../api.ts';

const contract: LaneContract = {
  lane: 'F1-fixture', generator: 'hand-written V09 fixture', events: [], $defs: {},
  commands: [{
    name: 'fixture_stuck', lane: 'F1-fixture', async: true, frontend: 'none',
    rust: { file: 'fixture.rs', line: 1, fn: 'fixture_stuck' }, injected: [], args: [], result: { type: 'string' },
  }],
};

let host: TestHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => (open = resolve));
  return { promise, open };
}

/** 命令处理器忽略 abort，只等外部闸门（sync 的 runSync、mcp 的 OAuth 回调等待即此形状）。 */
function stuckPlugin(order: string[], release: Promise<void>) {
  return definePlugin({
    meta: { id: 'fixture.stuck', commands: ['fixture_stuck'] },
    apply(ctx) {
      ctx.on('host/exiting', ({ reason }) => void order.push(`stuck saw host/exiting(${reason})`));
      ctx.commands.register('fixture_stuck', async (_args, call) => {
        call.signal.addEventListener('abort', () => void order.push('stuck call aborted'), { once: true });
        await release;
        return 'late';
      });
      ctx.effect(() => () => void order.push('stuck disposed'));
    },
  });
}

function cleanupPlugin(id: string, order: string[]) {
  return definePlugin({ meta: { id }, apply(ctx) { ctx.effect(() => () => void order.push(`${id} disposed`)); } });
}

async function settledWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([promise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
  clearTimeout(timer);
  return result;
}

describe('V09 P1-1: unload and dispose are bounded when a handler ignores abort', () => {
  it('R1: unload returns after the command close deadline; the late result still reaches the caller', async () => {
    const order: string[] = [];
    const release = gate();
    host = await createTestHost({ contracts: { only: [contract] }, plugins: [stuckPlugin(order, release.promise)] });
    const pending = host.startInvoke<string>('fixture_stuck');
    await new Promise(resolve => setTimeout(resolve, 10));
    const started = performance.now();
    const unloading = host.unload('fixture.stuck');
    expect(await settledWithin(unloading, COMMAND_CLOSE_TIMEOUT_MS + 1_000)).toBe(true);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(COMMAND_CLOSE_TIMEOUT_MS - 50);
    expect(order).toEqual(['stuck call aborted', 'stuck disposed']);
    expect(host.runtime.commands.has('fixture_stuck')).toBe(false);
    release.open();
    await expect(pending.result).resolves.toBe('late');
  });

  it('R1b: runtime.dispose returns after the deadline and plugins installed earlier still clean up; host/exiting comes first, once', async () => {
    const order: string[] = [];
    const release = gate();
    const exiting: HostExiting[] = [];
    const first = definePlugin({ meta: { id: 'fixture.first' }, apply(ctx) {
      ctx.on('host/exiting', info => void exiting.push(info));
      ctx.effect(() => () => void order.push('fixture.first disposed'));
    } });
    host = await createTestHost({ contracts: { only: [contract] }, commandCloseTimeoutMs: 300, plugins: [first, stuckPlugin(order, release.promise)] });
    void host.startInvoke<string>('fixture_stuck').result.catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 10));
    const disposing = host.runtime.dispose();
    expect(await settledWithin(disposing, 1_500)).toBe(true);
    expect(order).toEqual(['stuck saw host/exiting(dispose)', 'stuck call aborted', 'stuck disposed', 'fixture.first disposed']);
    await host.runtime.dispose();
    expect(exiting).toEqual([{ reason: 'dispose' }]);
    release.open();
  });

  it('a plugin whose disposer never settles delays shutdown by at most PLUGIN_DISPOSE_TIMEOUT_MS; later plugins still dispose', async () => {
    const order: string[] = [];
    const hung = definePlugin({ meta: { id: 'fixture.hung' }, apply(ctx) {
      ctx.effect(() => () => { order.push('fixture.hung disposing'); return new Promise<void>(() => undefined); });
    } });
    host = await createTestHost({ plugins: [cleanupPlugin('fixture.storage', order), hung, cleanupPlugin('fixture.business', order)] });
    const started = performance.now();
    await host.runtime.dispose();
    const elapsed = performance.now() - started;
    expect(order).toEqual(['fixture.business disposed', 'fixture.hung disposing', 'fixture.storage disposed']);
    expect(elapsed).toBeGreaterThanOrEqual(PLUGIN_DISPOSE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(PLUGIN_DISPOSE_TIMEOUT_MS + 1_000);
  });

  it('A13 F1: when earlier plugins use up the dispose phase, core service providers still get CORE_DISPOSE_RESERVE_MS', async () => {
    const order: string[] = [];
    const hungFor = (id: string) => definePlugin({ meta: { id }, apply(ctx) {
      ctx.effect(() => () => { order.push(`${id} disposing`); return new Promise<void>(() => undefined); });
    } });
    const slowStorage = definePlugin({ meta: { id: 'fixture.storage', provides: ['storage'] }, apply(ctx) {
      ctx.provide('storage', {});
      ctx.effect(() => async () => {
        await new Promise(resolve => setTimeout(resolve, CORE_DISPOSE_RESERVE_MS / 2));
        order.push('fixture.storage closed');
      });
    } });
    host = await createTestHost({ plugins: [slowStorage, hungFor('fixture.a'), hungFor('fixture.b')] });
    const started = performance.now();
    await host.runtime.dispose();
    const elapsed = performance.now() - started;
    expect(order).toEqual(['fixture.b disposing', 'fixture.a disposing', 'fixture.storage closed']);
    expect(elapsed).toBeGreaterThanOrEqual(DISPOSE_PHASE_BUDGET_MS - CORE_DISPOSE_RESERVE_MS - 50);
    expect(elapsed).toBeLessThan(DISPOSE_PHASE_BUDGET_MS + 1_000);
  });
});

describe('V09 P1-5 (kernel): host/exiting', () => {
  it('serve broadcasts host/exiting(shutdown) once, before transport invokes are aborted and plugins dispose', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'w01-exiting-'));
    const profile = join(dir, 'empty.json');
    writeFileSync(profile, '{"plugins":[]}');
    const { port1, port2 } = new MessageChannel();
    let exited!: () => void;
    const exitedPromise = new Promise<void>(resolve => (exited = resolve));
    const session = serveHost(messagePortTransport(port1), {
      profile,
      contracts: () => ContractSet.fromDirectory().with([{ file: 'V09.json', contract }]),
      exit: () => exited(),
    });
    try {
      port2.postMessage({ kind: 'handshake', protocol: 1, appDataDir: dir, appVersion: 'test', platform: 'linux', debug: true });
      const runtime = await session.ready;
      expect(runtime).not.toBeNull();
      const order: string[] = [];
      const seen: HostExiting[] = [];
      await runtime!.install(definePlugin({ meta: { id: 'fixture.listener' }, apply(ctx) {
        ctx.on('host/exiting', info => { seen.push(info); order.push('host/exiting'); });
        ctx.effect(() => () => void order.push('listener disposed'));
      } }));
      port2.postMessage({ kind: 'shutdown' });
      await exitedPromise;
      expect(seen).toEqual([{ reason: 'shutdown' }]);
      expect(order).toEqual(['host/exiting', 'listener disposed']);
    } finally {
      port2.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
