import { describe, expect, it } from 'vitest';
import { defineUiPlugin, UiKernel } from '../kernel';
import { installOfficialUiPlugins } from '../../ui-plugins/official/install';

describe('installation origin belongs to the contributing fiber, not the plugin id', () => {
  it('defaults direct installation to community even for an official id and ignores self-reported origin', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin({
      meta: { id: 'dstu.ui.shell', origin: 'builtin' } as any,
      apply(ctx) {
        ctx.ui.contribute('nav', {
          id: 'test', origin: 'builtin', owner: 'pretend',
          value: { origin: 'builtin', viewId: 'test', labelKey: 'test' },
        } as any);
      },
    }));
    expect(kernel.slots.list('nav')).toMatchObject([{ id: 'test', owner: 'dstu.ui.shell', origin: 'community' }]);
    await kernel.dispose();
  });

  it('carries origin through async and nested Cordis fibers and keeps config separate from provenance', async () => {
    const kernel = new UiKernel();
    await kernel.install(defineUiPlugin<{ title: string }>({
      meta: { id: 'dstu.ui.nested' },
      async apply(ctx, config) {
        await Promise.resolve();
        ctx.ui.nav.register({ id: 'parent', viewId: 'parent', labelKey: config.title });
        await ctx.plugin({
          name: 'child',
          async apply(child) {
            await Promise.resolve();
            child.ui.views.register({ id: 'child', titleKey: config.title, component: () => null });
          },
        });
      },
    }), { origin: 'builtin', config: { title: 'configured:title' } });
    expect(kernel.slots.list('nav')).toMatchObject([{ owner: 'dstu.ui.nested', origin: 'builtin', value: { labelKey: 'configured:title' } }]);
    expect(kernel.slots.get('views', 'child')).toMatchObject({ owner: 'dstu.ui.nested', origin: 'builtin', value: { titleKey: 'configured:title' } });
    await kernel.unload('dstu.ui.nested');
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(kernel.slots.list('views')).toEqual([]);
  });

  it('notifies snapshots on same-id origin changes and restores builtin only through official installation', async () => {
    const kernel = new UiKernel();
    const plugin = defineUiPlugin({ meta: { id: 'dstu.ui.shell' }, apply(ctx) {
      ctx.ui.nav.register({ id: 'same', viewId: 'same', labelKey: 'same' });
    } });
    await installOfficialUiPlugins(kernel, [plugin]);
    const builtin = kernel.slots.list('nav');
    expect(builtin[0].origin).toBe('builtin');
    let notifications = 0;
    const stop = kernel.slots.subscribe(() => { notifications++; });
    await kernel.install(plugin);
    const community = kernel.slots.list('nav');
    expect(community).not.toBe(builtin);
    expect(community[0]).toMatchObject({ id: 'same', owner: 'dstu.ui.shell', origin: 'community' });
    expect(builtin[0].origin).toBe('builtin');
    expect(notifications).toBe(2); // old fiber removal, new fiber contribution
    await installOfficialUiPlugins(kernel, [plugin]);
    expect(kernel.slots.list('nav')[0].origin).toBe('builtin');
    stop();
    await kernel.dispose();
  });
});
