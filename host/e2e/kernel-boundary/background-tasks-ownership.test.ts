/**
 * V09 P1-2（V09-dispose-leaks.md R5）：fake storage → 真实 diagnostics（提供 backgroundTasks）→ 业务插件提交 10 秒任务。
 * - 卸载提交方插件：任务收到 abort、立即移出集合（归属从调用方上下文推断，提交方代码不用改）。
 * - Host dispose：任务在途且不理 abort 时，dispose 远小于外壳 5 秒预算，排在后面的 storage dispose 照常执行。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { createTestHost, definePlugin, type TestHost } from '../../kernel/testing.ts';
import diagnostics from '../../platform/diagnostics/index.ts';
import type { BackgroundTasks } from '../../platform/diagnostics/api.ts';

const TEN_SECONDS = 10_000;

function sleep(ms: number, signal?: AbortSignal): Promise<'slept' | 'aborted'> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve('slept'), ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve('aborted'); }, { once: true });
  });
}

function fakeStorage(order: string[]) {
  return definePlugin({
    meta: { id: 'fixture.storage', provides: ['storage'] },
    apply(ctx) {
      ctx.reflect.provide('storage', { locations: { baseDir: ctx.root.get('app')?.dataDir ?? '' }, database: () => { throw new Error('fake storage'); } });
      ctx.effect(() => () => void order.push('storage disposed'));
    },
  });
}

interface Probe {
  signals: AbortSignal[];
  outcomes: Promise<unknown>[];
}

/** 提交方：照 qbank / review 的写法经 `ctx.get('backgroundTasks')` 取服务，`spawn(() => …)` 只传任务函数。 */
function spawner(id: string, order: string[], probe: Probe, task: (signal: AbortSignal) => Promise<unknown>) {
  return definePlugin({
    meta: { id },
    inject: ['backgroundTasks'],
    apply(ctx) {
      const background = ctx.get('backgroundTasks') as BackgroundTasks;
      const handle = background.spawn(async signal => {
        probe.signals.push(signal);
        order.push(`${id} task started`);
        return task(signal);
      });
      if (handle) probe.outcomes.push(handle);
      ctx.effect(() => () => void order.push(`${id} disposed`));
    },
  });
}

let host: TestHost | undefined;
afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

async function tick(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('V09 P1-2: backgroundTasks belong to the submitting plugin', () => {
  it('unloading the submitter aborts its task and removes it from the set', async () => {
    const order: string[] = [];
    const probe: Probe = { signals: [], outcomes: [] };
    host = await createTestHost({
      plugins: [fakeStorage(order), diagnostics, spawner('fixture.business', order, probe, signal => sleep(TEN_SECONDS, signal))],
    });
    await tick();
    const background = host.ctx.get('backgroundTasks') as BackgroundTasks;
    expect(order).toEqual(['fixture.business task started']);
    expect(background.size).toBe(1);

    await host.unload('fixture.business');
    expect(probe.signals[0]!.aborted).toBe(true);
    expect(String((probe.signals[0]!.reason as Error).message)).toContain('its owner was unloaded');
    expect(background.size).toBe(0);
    await expect(probe.outcomes[0]).resolves.toBe('aborted');
  });

  it('a task submitted through the root context has no owner and survives unloading unrelated plugins', async () => {
    const order: string[] = [];
    const probe: Probe = { signals: [], outcomes: [] };
    host = await createTestHost({
      plugins: [fakeStorage(order), diagnostics, spawner('fixture.business', order, probe, async () => 'done')],
    });
    const root = host.ctx.root.get('backgroundTasks') as BackgroundTasks;
    let rootSignal!: AbortSignal;
    void root.spawn(async signal => { rootSignal = signal; return sleep(TEN_SECONDS, signal); });
    await tick();
    await host.unload('fixture.business');
    expect(rootSignal.aborted).toBe(false);
    expect(root.size).toBe(1);
  });

  it('an explicit owner overrides inference; options.signal also aborts the task', async () => {
    const order: string[] = [];
    const probe: Probe = { signals: [], outcomes: [] };
    let ownerCtx!: Context;
    const owner = definePlugin({ meta: { id: 'fixture.owner' }, apply(ctx) { ownerCtx = ctx; } });
    host = await createTestHost({ plugins: [fakeStorage(order), diagnostics, owner] });
    const background = host.ctx.root.get('backgroundTasks') as BackgroundTasks;
    let owned!: AbortSignal;
    void background.spawn(async signal => { owned = signal; return sleep(TEN_SECONDS, signal); }, { owner: ownerCtx });
    const external = new AbortController();
    let linked!: AbortSignal;
    const linkedTask = background.spawn(async signal => { linked = signal; return sleep(TEN_SECONDS, signal); }, { signal: external.signal });
    await tick();
    expect(background.size).toBe(2);
    external.abort(new Error('caller gave up'));
    expect(linked.aborted).toBe(true);
    await expect(linkedTask).resolves.toBe('aborted');
    expect(background.size).toBe(1);
    await host.unload('fixture.owner');
    expect(owned.aborted).toBe(true);
    expect(background.size).toBe(0);
  });

  it('Host dispose with a task that ignores abort finishes far below 5s and storage dispose still runs', async () => {
    const order: string[] = [];
    const probe: Probe = { signals: [], outcomes: [] };
    host = await createTestHost({
      plugins: [fakeStorage(order), diagnostics, spawner('fixture.business', order, probe, () => sleep(TEN_SECONDS))],
    });
    await tick();
    const started = performance.now();
    await host.dispose();
    host = undefined;
    const elapsed = performance.now() - started;
    expect(probe.signals[0]!.aborted).toBe(true);
    expect(order).toEqual(['fixture.business task started', 'fixture.business disposed', 'storage disposed']);
    expect(elapsed).toBeLessThan(2_000);
  });

  it('Host dispose with a task that honours abort does not wait for the grace period', async () => {
    const order: string[] = [];
    const probe: Probe = { signals: [], outcomes: [] };
    host = await createTestHost({
      plugins: [fakeStorage(order), diagnostics],
    });
    const background = host.ctx.root.get('backgroundTasks') as BackgroundTasks;
    const task = background.spawn(signal => sleep(TEN_SECONDS, signal));
    await tick();
    const started = performance.now();
    await host.dispose();
    host = undefined;
    expect(performance.now() - started).toBeLessThan(500);
    await expect(task).resolves.toBe('aborted');
    expect(order).toEqual(['storage disposed']);
  });
});
