import { describe, expect, it } from 'vitest';
import { defineUiPlugin, UiKernel } from '../kernel';
import { normalizeUiPluginMeta, requiredHostPlugins, UI_KERNEL_API_VERSION, UI_PLATFORMS, UiPluginDependencyError } from '../meta';
import { createDesktopPlatform } from '../services/platform';

const navPlugin = (meta: Parameters<typeof defineUiPlugin>[0]['meta']) =>
  defineUiPlugin({ meta, apply: (ctx) => ctx.ui.nav.register({ id: `${meta.id}/nav`, viewId: 'v', labelKey: 'l' }) });

describe('UiPluginMeta v2', () => {
  it('keeps v1 metadata valid and describes installed plugins with normalized v2 fields', async () => {
    const kernel = new UiKernel();
    await kernel.install(navPlugin({ id: 'legacy.v1', version: '1.0.0' }));
    await kernel.install(navPlugin({
      id: 'community.stats', version: '0.1.0', apiVersion: 2, platforms: ['desktop', 'mobile'],
      host: true, requiresHost: ['dstu.review', 'community.stats'], requires: ['legacy.v1'], i18n: { namespace: 'community.stats' },
    }));
    expect(kernel.plugins()).toEqual([
      {
        id: 'community.stats', origin: 'community', hostPlugins: ['community.stats', 'dstu.review'],
        meta: {
          id: 'community.stats', version: '0.1.0', apiVersion: 2, platforms: ['desktop', 'mobile'],
          host: 'community.stats', requiresHost: ['dstu.review', 'community.stats'], requires: ['legacy.v1'], namespace: 'community.stats',
        },
      },
      {
        id: 'legacy.v1', origin: 'community', hostPlugins: [],
        meta: { id: 'legacy.v1', version: '1.0.0', apiVersion: 1, requiresHost: [], requires: [], namespace: 'legacy.v1' },
      },
    ]);
    expect(normalizeUiPluginMeta({ id: 'dstu.ui.stats', i18n: { namespace: 'stats' } }).namespace).toBe('stats');
    await kernel.dispose();
  });

  it('pairs a UI half with a differently named Host plugin for FE-A3 reconciliation', () => {
    expect(requiredHostPlugins(normalizeUiPluginMeta({ id: 'dstu.ui.anki', host: 'dstu.anki', requiresHost: ['dstu.review'] }))).toEqual(['dstu.anki', 'dstu.review']);
    expect(requiredHostPlugins(normalizeUiPluginMeta({ id: 'dstu.ui.todo' }))).toEqual([]);
  });

  it('uses the same platform vocabulary as the Host meta.platforms (W14)', () => {
    expect(UI_PLATFORMS).toEqual(['desktop', 'mobile']);
    expect(UI_KERNEL_API_VERSION).toBe(2);
  });

  it.each([
    [{ id: 'p', platforms: [] }, 'p: meta.platforms must be a non-empty array'],
    [{ id: 'p', platforms: ['tablet'] }, 'p: unknown platform "tablet" in meta.platforms (expected desktop | mobile)'],
    [{ id: 'p', platforms: ['desktop', 'desktop'] }, 'p: duplicate platform desktop in meta.platforms'],
    [{ id: 'p', apiVersion: 3 }, 'p: requires UI plugin API 3, this kernel provides 2'],
    [{ id: 'p', host: '' }, 'p: meta.host must be true or a non-empty plugin id'],
    [{ id: 'p', requires: ['p'] }, 'p: meta.requires must not list the plugin itself'],
    [{ id: 'p', requiresHost: [42] }, 'p: meta.requiresHost must be an array of non-empty plugin ids'],
    [{ id: 'p', i18n: { namespace: 'a:b' } }, 'p: meta.i18n.namespace must be a non-empty string without ":"'],
  ])('rejects invalid metadata %j before touching the kernel', async (meta, message) => {
    const kernel = new UiKernel();
    await expect(kernel.install(navPlugin(meta as never))).rejects.toThrow(message);
    expect(kernel.list()).toEqual([]);
    expect(kernel.slots.list('nav')).toEqual([]);
  });

  it('skips plugins whose platforms exclude the current platform without contributing anything', async () => {
    const kernel = new UiKernel({ platform: { ...createDesktopPlatform('macos'), kind: 'mobile' } });
    await expect(kernel.install(navPlugin({ id: 'desktop.only', platforms: ['desktop'] }))).resolves.toBe(false);
    await expect(kernel.install(navPlugin({ id: 'portable', platforms: ['desktop', 'mobile'] }))).resolves.toBe(true);
    await expect(kernel.install(navPlugin({ id: 'unrestricted' }))).resolves.toBe(true);
    expect(kernel.list()).toEqual(['portable', 'unrestricted']);
    expect(kernel.slots.list('nav').map((e) => e.owner)).toEqual(['portable', 'unrestricted']);
    expect(kernel.skipped()).toEqual([{ id: 'desktop.only', reason: 'platform', platform: 'mobile', platforms: ['desktop'] }]);
    await kernel.dispose();
  });

  it('replacing an installed plugin with a version for another platform unloads the old one and reports the skip', async () => {
    const kernel = new UiKernel();
    await kernel.install(navPlugin({ id: 'same' }));
    await expect(kernel.install(navPlugin({ id: 'same', platforms: ['mobile'] }))).resolves.toBe(false);
    expect(kernel.list()).toEqual([]);
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(kernel.skipped().map((s) => s.id)).toEqual(['same']);
    await kernel.install(navPlugin({ id: 'same' }));
    expect(kernel.skipped()).toEqual([]);
    await kernel.dispose();
  });

  it('requires declared UI plugin dependencies to be installed first', async () => {
    const kernel = new UiKernel();
    const dependent = navPlugin({ id: 'dependent', requires: ['base', 'other'] });
    const failure = kernel.install(dependent);
    await expect(failure).rejects.toBeInstanceOf(UiPluginDependencyError);
    await expect(kernel.install(dependent)).rejects.toThrow('dependent: missing UI plugin dependencies: base, other');
    await kernel.install(navPlugin({ id: 'base' }));
    await kernel.install(navPlugin({ id: 'other' }));
    await expect(kernel.install(dependent)).resolves.toBe(true);
    expect(kernel.list()).toEqual(['base', 'dependent', 'other']);
    await kernel.dispose();
  });

  it('skips a plugin whose missing dependencies were all skipped (build or platform), transitively; an absent one still throws', async () => {
    const kernel = new UiKernel({}, { build: 'production' });
    await expect(kernel.install(navPlugin({ id: 'frame.dev', devOnly: true }), { origin: 'builtin' })).resolves.toBe(false);
    await expect(kernel.install(navPlugin({ id: 'frame.mobile', platforms: ['mobile'] }))).resolves.toBe(false);
    await expect(kernel.install(navPlugin({ id: 'uses-dev', requires: ['frame.dev'] }))).resolves.toBe(false);
    await expect(kernel.install(navPlugin({ id: 'uses-both', requires: ['frame.mobile', 'uses-dev'] }))).resolves.toBe(false);
    await expect(kernel.install(navPlugin({ id: 'uses-absent', requires: ['frame.dev', 'absent'] })))
      .rejects.toThrow('uses-absent: missing UI plugin dependencies: frame.dev, absent');
    expect(kernel.list()).toEqual([]);
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(kernel.skipped().filter((s) => s.reason === 'requires')).toEqual([
      { id: 'uses-both', reason: 'requires', requires: ['frame.mobile', 'uses-dev'] },
      { id: 'uses-dev', reason: 'requires', requires: ['frame.dev'] },
    ]);
    await kernel.dispose();
  });
});
