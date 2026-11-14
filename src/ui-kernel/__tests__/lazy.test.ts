import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { defineUiPlugin, UiKernel } from '../kernel';
import { createLazyContributionPoint } from '../lazy';

let kernel: UiKernel | undefined;
afterEach(async () => {
  await kernel?.dispose();
  kernel = undefined;
  vi.restoreAllMocks();
});

async function plugin(k: UiKernel, id: string, apply: (ctx: Context) => void = () => {}): Promise<Context> {
  let ctx: Context | undefined;
  await k.install(defineUiPlugin({ meta: { id }, apply: (c) => { ctx = c; apply(c); } }));
  return ctx!;
}

const ids = (k: UiKernel, slot: string) => k.slots.list(slot).map((entry) => entry.id);

describe('ctx.ui.attach (lazy chunk contributions)', () => {
  it('contributes earlier and later announcements under the attaching plugin and revokes them on unload', async () => {
    kernel = new UiKernel();
    kernel.slots.declare({ name: 'test.lazy', cardinality: 'list' });
    const point = createLazyContributionPoint<string>('test.lazy');
    point.announce('early');
    await plugin(kernel, 'example.lazy', (ctx) => {
      ctx.ui.attach(point, (value) => { ctx.ui.contribute('test.lazy', { id: value, value }); });
    });
    point.announce('late');
    expect(ids(kernel, 'test.lazy')).toEqual(['early', 'late']);
    expect(kernel.slots.list('test.lazy').map((entry) => entry.owner)).toEqual(['example.lazy', 'example.lazy']);

    await kernel.unload('example.lazy');
    expect(ids(kernel, 'test.lazy')).toEqual([]);
    point.announce('after-unload');
    expect(ids(kernel, 'test.lazy')).toEqual([]);
  });

  it('the handle detaches before unload; contributions already made stay with the plugin', async () => {
    kernel = new UiKernel();
    kernel.slots.declare({ name: 'test.lazy', cardinality: 'list' });
    const point = createLazyContributionPoint<string>('test.lazy');
    const ctx = await plugin(kernel, 'example.lazy');
    const detach = ctx.ui.attach(point, (value) => { ctx.ui.contribute('test.lazy', { id: value, value }); });
    point.announce('a');
    detach();
    detach();
    point.announce('b');
    expect(ids(kernel, 'test.lazy')).toEqual(['a']);
  });

  it('a rejected value is reported to the attaching plugin\'s error budget and does not stop the others', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    kernel = new UiKernel();
    kernel.slots.declare({ name: 'test.lazy', cardinality: 'keyed' });
    const point = createLazyContributionPoint<string>('test.lazy');
    point.announce('dup');
    point.announce('dup');
    point.announce('ok');
    let n = 0;
    await plugin(kernel, 'example.lazy', (ctx) => {
      ctx.ui.attach(point, (value) => { ctx.ui.contribute('test.lazy', { id: `${value}:${n++}`, key: value, value }); });
    });
    expect(kernel.slots.list('test.lazy').map((entry) => entry.id)).toEqual(['dup:0', 'ok:2']);
    const reports = kernel.errors.list('example.lazy');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ phase: 'report', slot: 'lazy:test.lazy' });
    expect(reports[0]!.message).toMatch(/key "dup" is already provided/);
  });
});
