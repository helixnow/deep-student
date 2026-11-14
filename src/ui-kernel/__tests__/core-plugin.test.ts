import { describe, expect, it } from 'vitest';
import { defineUiPlugin, UiCorePluginError, UiKernel, type UiBuildKind } from '../kernel';
import { UiPluginMetaError } from '../meta';

const menuRow = (id: string) => ({ id, viewId: id, labelKey: id });

const core = defineUiPlugin({
  meta: { id: 'dstu.ui.menu', core: true },
  apply(ctx) {
    ctx.ui.nav.register(menuRow('official'));
  },
});

const navIds = (kernel: UiKernel) => kernel.slots.list('nav').map((entry) => `${entry.owner}:${entry.id}`).sort();

async function kernelWithCore(build: UiBuildKind) {
  const kernel = new UiKernel({}, { build });
  expect(await kernel.install(core, { origin: 'builtin' })).toBe(true);
  return kernel;
}

describe('core UI plugins (meta.core)', () => {
  it('cannot be unloaded or replaced by a community plugin in production; community plugins still add to its slots', async () => {
    const kernel = await kernelWithCore('production');
    expect(kernel.isProtectedCore('dstu.ui.menu')).toBe(true);
    expect(kernel.plugins().find((p) => p.id === 'dstu.ui.menu')?.meta.core).toBe(true);

    await expect(kernel.unload('dstu.ui.menu')).rejects.toBeInstanceOf(UiCorePluginError);
    await expect(kernel.unload('dstu.ui.menu')).rejects.toThrow('cannot be unloaded in production');
    await expect(kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.menu' }, apply: () => {} }))).rejects.toThrow('cannot be replaced by a community plugin');
    expect(kernel.list()).toEqual(['dstu.ui.menu']);

    await kernel.install(defineUiPlugin({ meta: { id: 'community.extra' }, apply(ctx) { ctx.ui.nav.register(menuRow('extra')); } }));
    expect(navIds(kernel)).toEqual(['community.extra:extra', 'dstu.ui.menu:official']);
    expect(await kernel.unload('community.extra')).toBe(true);
    expect(navIds(kernel)).toEqual(['dstu.ui.menu:official']);

    expect(await kernel.install(core, { origin: 'builtin' })).toBe(true);
    expect(navIds(kernel)).toEqual(['dstu.ui.menu:official']);

    await kernel.dispose();
    expect(kernel.list()).toEqual([]);
    expect(navIds(kernel)).toEqual([]);
  });

  it('can be unloaded and replaced in development builds and tests', async () => {
    const kernel = await kernelWithCore('development');
    expect(kernel.isProtectedCore('dstu.ui.menu')).toBe(false);
    expect(await kernel.unload('dstu.ui.menu')).toBe(true);
    expect(navIds(kernel)).toEqual([]);
    await kernel.install(core, { origin: 'builtin' });
    expect(await kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.menu' }, apply: () => {} }))).toBe(true);
    expect(navIds(kernel)).toEqual([]);
    await kernel.dispose();
  });

  it('is reserved for official plugins and excludes devOnly', async () => {
    const kernel = new UiKernel({}, { build: 'production' });
    await expect(kernel.install(defineUiPlugin({ meta: { id: 'community.core', core: true }, apply: () => {} }))).rejects.toBeInstanceOf(UiPluginMetaError);
    await expect(kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.x', core: true, devOnly: true }, apply: () => {} }), { origin: 'builtin' }))
      .rejects.toThrow('mutually exclusive');
    await expect(kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.y', core: 'yes' as never }, apply: () => {} }), { origin: 'builtin' }))
      .rejects.toThrow('meta.core must be a boolean');
    expect(kernel.list()).toEqual([]);
  });

  it('does not protect non-core official plugins in production', async () => {
    const kernel = new UiKernel({}, { build: 'production' });
    await kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.shell' }, apply: () => {} }), { origin: 'builtin' });
    expect(await kernel.unload('dstu.ui.shell')).toBe(true);
  });

  it('still withdraws a core plugin whose Host plugin is missing and reinstalls it when the Host plugin returns', async () => {
    const kernel = new UiKernel({}, { build: 'production' });
    await kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.cards', core: true, requiresHost: ['dstu.anki'] }, apply(ctx) {
      ctx.ui.nav.register(menuRow('cards'));
    } }), { origin: 'builtin' });
    kernel.hostStatus.update({ plugins: [], degraded: [] });
    await kernel.settled();
    expect(kernel.list()).toEqual([]);
    kernel.hostStatus.update({ plugins: [{ id: 'dstu.anki' }], degraded: [] });
    await kernel.settled();
    expect(navIds(kernel)).toEqual(['dstu.ui.cards:cards']);
    await kernel.dispose();
  });
});
