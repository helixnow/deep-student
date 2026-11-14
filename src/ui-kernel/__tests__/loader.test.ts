import { describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel, type RemoteHost } from '../kernel';
import { pluginUrl, UiPluginLoader, type UiManifestEntry } from '../loader';
import { UiPluginDisposedError } from '../scope';
import { __resetSharedModulesForTest, installSharedModules, sharedModuleSource } from '../shared';

const entry = (id: string, file = `/plugins/${id}/ui.js`, version?: string): UiManifestEntry => ({ id, file, version });

describe('UiPluginLoader', () => {
  it('reports the real loaded UI version and unloads mismatches or failed handshakes', async () => {
    const kernel = new UiKernel();
    const ready = vi.fn().mockResolvedValueOnce({ id: 'paired', matched: false })
      .mockRejectedValueOnce(new Error('Host unavailable'))
      .mockResolvedValueOnce({ id: 'paired', matched: true });
    const loader = new UiPluginLoader(kernel, {
      importModule: async () => ({ default: defineUiPlugin({
        meta: { id: 'paired', version: '1.2.3' },
        apply: (ctx) => ctx.ui.nav.register({ id: 'paired-nav', viewId: 'paired', labelKey: 'paired' }),
      }) }), ready,
    });
    await loader.sync([entry('paired', '/p/ui.js', '9.9.9')]);
    expect(ready).toHaveBeenLastCalledWith('paired', '1.2.3');
    expect(kernel.list()).toEqual([]);
    expect(kernel.slots.list('nav')).toEqual([]);
    expect(loader.errors.get('paired')).toContain('does not match Host');
    await loader.sync([entry('paired')]);
    expect(kernel.list()).toEqual([]);
    expect(loader.errors.get('paired')).toBe('Host unavailable');
    await loader.sync([entry('paired')]);
    expect(kernel.list()).toEqual(['paired']);
    expect(loader.errors.size).toBe(0);
    await loader.dispose();
  });
  it('installs community UI plugins from the manifest and isolates failures', async () => {
    const kernel = new UiKernel();
    const modules: Record<string, unknown> = {
      [pluginUrl(entry('good'))]: { default: defineUiPlugin({ meta: { id: 'good' }, apply: (ctx) => ctx.ui.nav.register({ id: 'g', viewId: 'g', labelKey: 'g' }) }) },
      [pluginUrl(entry('wrong-id'))]: { default: defineUiPlugin({ meta: { id: 'other' }, apply() {} }) },
      [pluginUrl(entry('no-export'))]: {},
    };
    const error = vi.fn();
    const loader = new UiPluginLoader(kernel, {
      importModule: async (url) => {
        if (url.includes('throws')) throw new Error('network down');
        return modules[url] as { default?: unknown };
      },
      log: { warn: vi.fn(), error },
    });
    await loader.sync([entry('good'), entry('wrong-id'), entry('no-export'), entry('throws')]);
    expect(kernel.list()).toEqual(['good']);
    expect(kernel.slots.list('nav').map((e) => e.owner)).toEqual(['good']);
    expect(Object.fromEntries(loader.errors)).toEqual({
      'wrong-id': 'UI plugin id "other" does not match host plugin id "wrong-id"',
      'no-export': 'UI module must default-export defineUiPlugin(...)',
      throws: 'network down',
    });
    expect(error).toHaveBeenCalledTimes(3);
  });

  it('reconciles manifest changes: unloads removed or changed plugins, installs new ones', async () => {
    const kernel = new UiKernel();
    let generation = 0;
    const loader = new UiPluginLoader(kernel, {
      importModule: async () => {
        generation++;
        const n = generation;
        return { default: defineUiPlugin({ meta: { id: 'p' }, apply: (ctx) => ctx.ui.nav.register({ id: `n${n}`, viewId: 'v', labelKey: 'l' }) }) };
      },
    });
    await loader.sync([entry('p', '/a/ui.js', '1.0.0')]);
    expect(kernel.slots.list('nav').map((e) => e.id)).toEqual(['n1']);
    await loader.sync([entry('p', '/a/ui.js', '1.0.0')]); // 不变：不重载
    expect(generation).toBe(1);
    await loader.sync([entry('p', '/a/ui.js', '1.1.0')]); // 版本变化：重载
    expect(kernel.slots.list('nav').map((e) => e.id)).toEqual(['n2']);
    await loader.sync([]); // 移除
    expect(kernel.list()).toEqual([]);
    expect(kernel.slots.list('nav')).toEqual([]);
  });

  it('reports a plugin whose required UI plugins this build leaves out as skipped, not failed', async () => {
    const kernel = new UiKernel({}, { build: 'production' });
    await kernel.install(defineUiPlugin({ meta: { id: 'dstu.ui.debug', devOnly: true }, apply() {} }), { origin: 'builtin' });
    const warn = vi.fn();
    const error = vi.fn();
    const loader = new UiPluginLoader(kernel, {
      importModule: async () => ({ default: defineUiPlugin({ meta: { id: 'acme.panels', requires: ['dstu.ui.debug'] }, apply() {} }) }),
      log: { warn, error },
    });
    await loader.sync([entry('acme.panels')]);
    expect(warn).toHaveBeenCalledWith('[ui-plugins] "acme.panels" requires "dstu.ui.debug", which this build or platform leaves out; skipped');
    expect(error).not.toHaveBeenCalled();
    expect(loader.loadErrors()).toEqual([]);
    await loader.dispose();
  });

  it('builds ds-plugin URLs from the plugin id and module file name', () => {
    expect(pluginUrl(entry('community.word-of-day', '/Users/x/plugins/wod/dist/ui.js'))).toBe('ds-plugin://community.word-of-day/ui.js');
    expect(pluginUrl(entry('example.word-of-day', 'C:\\plugins\\wod\\dist\\ui.js'), 2)).toBe('ds-plugin://example.word-of-day/ui.js?reload=2');
  });

  it('imports an updated, re-added or previously failed plugin from a URL of its own (the page caches ES modules by URL)', async () => {
    const urls: string[] = [];
    let fail = true;
    const plugin = (n: number) => defineUiPlugin({ meta: { id: 'fresh' }, apply: (ctx) => ctx.ui.nav.register({ id: `n${n}`, viewId: 'v', labelKey: 'l' }) });
    const importModule = async (url: string) => {
      urls.push(url);
      if (fail) throw new Error('fetch failed');
      return { default: plugin(urls.length) };
    };
    const kernel = new UiKernel();
    const loader = new UiPluginLoader(kernel, { importModule, log: { warn: vi.fn(), error: vi.fn() } });
    await loader.sync([entry('fresh', '/p/ui.js', '1.0.0')]);
    expect(loader.errors.get('fresh')).toBe('fetch failed');
    fail = false;
    await loader.sync([entry('fresh', '/p/ui.js', '1.0.0')]); // retry after a failed import
    await loader.sync([entry('fresh', '/p/ui.js', '1.0.0')]); // unchanged: no import
    await loader.sync([entry('fresh', '/p/ui.js', '1.1.0')]); // update
    await loader.sync([]);
    await loader.sync([entry('fresh', '/p/ui.js', '1.1.0')]); // re-added (e.g. the Host restarted)
    expect(kernel.slots.list('nav').map((e) => e.id)).toEqual(['n4']);
    await loader.dispose();
    const second = new UiPluginLoader(kernel, { importModule });
    await second.sync([entry('fresh', '/p/ui.js', '1.1.0')]); // another loader in the same page
    expect(urls).toEqual([
      'ds-plugin://fresh/ui.js',
      'ds-plugin://fresh/ui.js?reload=1',
      'ds-plugin://fresh/ui.js?reload=2',
      'ds-plugin://fresh/ui.js?reload=3',
      'ds-plugin://fresh/ui.js?reload=4',
    ]);
    expect(kernel.slots.list('nav').map((e) => e.id)).toEqual(['n5']);
    await second.dispose();
  });

  it('does not install a pending import after disposal and revokes loaded contributions', async () => {
    const kernel = new UiKernel();
    let finish!: (module: { default: unknown }) => void;
    const pending = new Promise<{ default: unknown }>((resolve) => { finish = resolve; });
    const loader = new UiPluginLoader(kernel, { importModule: () => pending });
    const syncing = loader.sync([entry('late')]);
    await Promise.resolve();
    const disposing = loader.dispose();
    finish({ default: defineUiPlugin({ meta: { id: 'late' }, apply: (ctx) => ctx.ui.nav.register({ id: 'late', viewId: 'late', labelKey: 'late' }) }) });
    await syncing;
    await disposing;
    await loader.sync([entry('late')]);
    expect(kernel.list()).toEqual([]);
    expect(kernel.slots.list('nav')).toEqual([]);
  });

  it('keeps reconciling and still disposes after one manifest sync rejects', async () => {
    const kernel = new UiKernel();
    const loader = new UiPluginLoader(kernel, {
      importModule: async (url) => ({ default: defineUiPlugin({ meta: { id: decodeURIComponent(url.split('/')[2]!) }, apply: (ctx) => ctx.ui.nav.register({ id: url, viewId: url, labelKey: url }) }) }),
    });
    await loader.sync([entry('first')]);
    await expect(loader.sync(null as unknown as UiManifestEntry[])).rejects.toThrow();
    await loader.sync([entry('first'), entry('second')]);
    expect(kernel.list()).toEqual(['first', 'second']);
    await loader.dispose();
    expect(kernel.list()).toEqual([]);
    expect(kernel.slots.list('nav')).toEqual([]);
  });
});

describe('shared modules', () => {
  it('generates an ESM shim exporting the host singleton members and default', () => {
    const src = sharedModuleSource('react', { useState: 1, createElement: 2, 'not-ident': 3, default: 4 });
    expect(src).toContain('const m = globalThis.__DS_SHARED__["react"];');
    expect(src).toContain('export const createElement = m["createElement"];');
    expect(src).toContain('export const useState = m["useState"];');
    expect(src).not.toContain('not-ident');
    expect(src).toContain('export default');
  });

  it('installs one import map mapping bare specifiers to blob URLs, idempotently', () => {
    __resetSharedModulesForTest();
    const maps: string[] = [];
    let n = 0;
    const env = { createObjectURL: () => `blob:shared-${++n}`, appendImportMap: (json: string) => maps.push(json) };
    const react = { useState: () => null };
    const first = installSharedModules({ react, '@deepstudent/ui': { DsButton: 1 } }, env);
    const second = installSharedModules({ react }, env);
    expect(second).toBe(first);
    expect(maps).toHaveLength(1);
    expect(JSON.parse(maps[0]!)).toEqual({ imports: { react: 'blob:shared-1', '@deepstudent/ui': 'blob:shared-2' } });
    expect((globalThis as unknown as { __DS_SHARED__: Record<string, unknown> }).__DS_SHARED__.react).toBe(react);
  });
});

describe('ctx.ui.host', () => {
  it('routes remote service calls through plugin:host|call with the calling plugin as caller', async () => {
    const invoke = vi.fn(async () => ({ word: 'serendipity' }));
    const kernel = new UiKernel({ invoke });
    let result: unknown;
    await kernel.install(defineUiPlugin({ meta: { id: 'wod' }, apply: async (ctx) => { result = await ctx.ui.host.wordOfDay!.today!('zh'); } }));
    expect(invoke).toHaveBeenCalledWith('plugin:host|call', { caller: 'wod', service: 'wordOfDay', method: 'today', args: ['zh'] });
    expect(result).toEqual({ word: 'serendipity' });
  });

  it('a paired half calls as itself (its id is its Host plugin id); handles taken in apply keep their caller later', async () => {
    const invoke = vi.fn(async () => null);
    const kernel = new UiKernel({ invoke });
    let fromPlugin: RemoteHost | undefined;
    let fromHalf: RemoteHost | undefined;
    await kernel.install(defineUiPlugin({
      meta: { id: 'dstu.ui.frame' },
      apply: async (ctx) => {
        fromPlugin = ctx.ui.host;
        await ctx.ui.pair(defineUiPlugin({ meta: { id: 'dstu.anki', host: true }, apply: (half) => { fromHalf = half.ui.host; } }));
      },
    }));
    await fromPlugin!.frame!.open!(1);
    await fromHalf!.anki!.status!();
    expect(invoke.mock.calls).toEqual([
      ['plugin:host|call', { caller: 'dstu.ui.frame', service: 'frame', method: 'open', args: [1] }],
      ['plugin:host|call', { caller: 'dstu.anki', service: 'anki', method: 'status', args: [] }],
    ]);
  });

  it('rejects calls outside a plugin and after the plugin is unloaded, without reaching the Host', async () => {
    const invoke = vi.fn(async () => null);
    const kernel = new UiKernel({ invoke });
    await expect(kernel.ui().host.wordOfDay!.today!('zh')).rejects.toThrow(/ctx\.ui\.host is only available inside a UI plugin/);
    let host: RemoteHost | undefined;
    await kernel.install(defineUiPlugin({ meta: { id: 'wod' }, apply: (ctx) => { host = ctx.ui.host; } }));
    await kernel.unload('wod');
    await expect(host!.wordOfDay!.today!('zh')).rejects.toBeInstanceOf(UiPluginDisposedError);
    expect(invoke).not.toHaveBeenCalled();
  });
});
