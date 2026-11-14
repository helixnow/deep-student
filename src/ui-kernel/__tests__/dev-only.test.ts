import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '../kernel';
import { normalizeUiPluginMeta, UiPluginMetaError, type UiPluginMeta } from '../meta';
import { installOfficialUiPlugins } from '../../ui-plugins/official/install';
import { memoryRegistryAdapters } from '../../ui-plugins/testing/registries';

const debugPanel = (meta: Partial<UiPluginMeta> = {}) => defineUiPlugin({
  meta: { id: 'dstu.ui.debug-panel', devOnly: true, ...meta },
  apply: (ctx) => { ctx.ui.contribute('nav', { id: 'debug', value: { id: 'debug' } }); },
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('meta.devOnly (development-only UI plugins)', () => {
  it('installs in development builds and is skipped, with a recorded reason, in production builds', async () => {
    const dev = new UiKernel({}, { build: 'development' });
    await expect(dev.install(debugPanel(), { origin: 'builtin' })).resolves.toBe(true);
    expect(dev.slots.list('nav').map((e) => e.owner)).toEqual(['dstu.ui.debug-panel']);
    expect(dev.skipped()).toEqual([]);

    const prod = new UiKernel({}, { build: 'production' });
    await expect(prod.install(debugPanel(), { origin: 'builtin' })).resolves.toBe(false);
    expect(prod.list()).toEqual([]);
    expect(prod.slots.list('nav')).toEqual([]);
    expect(prod.skipped()).toEqual([{ id: 'dstu.ui.debug-panel', reason: 'build', build: 'production' }]);
    await Promise.all([dev.dispose(), prod.dispose()]);
  });

  it('follows the Vite build flag by default', async () => {
    vi.stubEnv('DEV', false);
    const prod = new UiKernel();
    expect(prod.build).toBe('production');
    await expect(prod.install(debugPanel())).resolves.toBe(false);
    vi.stubEnv('DEV', true);
    const dev = new UiKernel();
    expect(dev.build).toBe('development');
    await expect(dev.install(debugPanel())).resolves.toBe(true);
    await dev.dispose();
  });

  it('applies to the official installer: production assemblies leave out dstu.ui.dev and dstu.ui.debug', async () => {
    const prod = new UiKernel(memoryRegistryAdapters(), { build: 'production' });
    await installOfficialUiPlugins(prod);
    expect(prod.list()).not.toContain('dstu.ui.dev');
    expect(prod.list()).not.toContain('dstu.ui.debug');
    expect(prod.skipped().map((s) => [s.id, s.reason])).toEqual([['dstu.ui.debug', 'build'], ['dstu.ui.dev', 'build']]);
    expect(prod.registries.commands.list().filter((c) => c.id.startsWith('dev.'))).toEqual([]);
    await prod.dispose();
  });

  it('a community plugin that requires dstu.ui.debug contributes to debug.panels in development and is skipped in production', async () => {
    const panels = defineUiPlugin({
      meta: { id: 'acme.debug-extras', requires: ['dstu.ui.debug'] },
      apply: (ctx) => { ctx.ui.contribute('debug.panels', { id: 'extras', value: { id: 'extras' } }); },
    });
    const dev = new UiKernel(memoryRegistryAdapters(), { build: 'development' });
    await installOfficialUiPlugins(dev);
    await expect(dev.install(panels)).resolves.toBe(true);
    expect(dev.slots.list('debug.panels').filter((e) => e.owner === 'acme.debug-extras').map((e) => e.id)).toEqual(['extras']);

    const prod = new UiKernel(memoryRegistryAdapters(), { build: 'production' });
    await installOfficialUiPlugins(prod);
    await expect(prod.install(panels)).resolves.toBe(false);
    expect(prod.list()).not.toContain('acme.debug-extras');
    expect(prod.skipped()).toContainEqual({ id: 'acme.debug-extras', reason: 'requires', requires: ['dstu.ui.debug'] });
    await Promise.all([dev.dispose(), prod.dispose()]);
  });

  it('normalizes and validates the declaration', () => {
    expect(normalizeUiPluginMeta({ id: 'a', devOnly: true }).devOnly).toBe(true);
    expect(normalizeUiPluginMeta({ id: 'a', devOnly: false }).devOnly).toBeUndefined();
    expect(normalizeUiPluginMeta({ id: 'a' }).devOnly).toBeUndefined();
    expect(() => normalizeUiPluginMeta({ id: 'a', devOnly: 'yes' as never })).toThrow(UiPluginMetaError);
  });
});
