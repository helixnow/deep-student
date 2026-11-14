// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '../kernel';
import { resolveCommunityPluginUrl, startCommunityUiPlugins, type CommunityUiBridge } from '../community';
import type { UiManifestEntry } from '../loader';

const recorded = vi.hoisted(() => ({ shared: vi.fn(), sdk: vi.fn(), steps: [] as string[] }));
vi.mock('../../ui-sdk', () => { recorded.sdk(); return { defineUiPlugin: () => {} }; });
vi.mock('../shared', () => ({ installSharedModules: (modules: Record<string, object>) => { recorded.steps.push('shared'); recorded.shared(modules); } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  recorded.steps.length = 0;
});

describe('production community UI boot channel', () => {
  it('uses the demo marker, skipping even the transport and shared SDK', async () => {
    vi.stubGlobal('window', { __DS_DEMO_SHELL__: true });
    const bridge = { invoke: vi.fn(), listen: vi.fn() };
    await (await startCommunityUiPlugins(new UiKernel(), bridge))();
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(bridge.listen).not.toHaveBeenCalled();
    expect(recorded.shared).not.toHaveBeenCalled();
    expect(recorded.sdk).not.toHaveBeenCalled();
  });

  it('does not import the SDK or create an import map for an empty manifest; disposes its listener', async () => {
    vi.stubGlobal('window', {});
    const unlisten = vi.fn();
    const bridge = { invoke: vi.fn(async () => []), listen: vi.fn(async () => unlisten) };
    const load = vi.fn();
    const stop = await startCommunityUiPlugins(new UiKernel(), bridge, load);
    await flush();
    expect(bridge.listen).toHaveBeenCalledOnce();
    expect(bridge.invoke).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    expect(recorded.shared).not.toHaveBeenCalled();
    expect(recorded.sdk).not.toHaveBeenCalled();
    await stop();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('installs shared modules before the first plugin import, reconciles events and ignores stale initial replies', async () => {
    vi.stubGlobal('window', {});
    const kernel = new UiKernel();
    const initial = deferred<UiManifestEntry[]>();
    let changed!: (manifest: UiManifestEntry[]) => void;
    const bridge: CommunityUiBridge = {
      invoke: () => initial.promise,
      listen: async (fn) => { changed = fn; return () => {}; },
    };
    const entry = { id: 'community.test', file: '/plugins/test/ui.js' };
    const load = vi.fn(async (url: string) => {
      recorded.steps.push(url);
      return { default: defineUiPlugin({ meta: { id: entry.id }, apply(ctx) { ctx.ui.nav.register({ id: 'test', viewId: 'test', labelKey: 'test' }); } }) };
    });
    const stop = await startCommunityUiPlugins(kernel, bridge, load);
    changed([entry]);
    await vi.waitFor(() => expect(kernel.slots.list('nav').map((e) => e.owner)).toEqual(['community.test']), { timeout: 10000 });
    initial.resolve([]);
    await flush();
    expect(kernel.slots.list('nav').map((e) => e.owner)).toEqual(['community.test']);
    expect(recorded.steps).toEqual(['shared', 'ds-plugin://community.test/ui.js']);
    expect(Object.keys(recorded.shared.mock.calls[0][0])).toEqual(['react', 'react-dom', '@deepstudent/ui', 'i18next']);
    changed([]);
    await vi.waitFor(() => expect(kernel.slots.list('nav')).toEqual([]), { timeout: 10000 });
    changed([entry]);
    await vi.waitFor(() => expect(kernel.slots.list('nav').map((e) => e.owner)).toEqual(['community.test']), { timeout: 10000 });
    expect(recorded.shared).toHaveBeenCalledOnce();
    await stop();
    expect(kernel.slots.list('nav')).toEqual([]);
    changed([entry]);
    await flush();
    expect(kernel.list()).toEqual([]);
  });

  it('can stop before an initial manifest reply without later resurrecting plugins', async () => {
    vi.stubGlobal('window', {});
    const initial = deferred<UiManifestEntry[]>();
    const unlisten = vi.fn();
    const load = vi.fn();
    const stop = await startCommunityUiPlugins(new UiKernel(), { invoke: () => initial.promise, listen: async () => unlisten }, load);
    await stop();
    initial.resolve([{ id: 'late', file: '/late.js' }]);
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it('keeps ds-plugin:// URLs unchanged outside WebUI and rewrites them under WebUI runtime', () => {
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:4321' } });
    expect(resolveCommunityPluginUrl('ds-plugin://workshop.plugin-1/ui.js?reload=2')).toBe(
      'ds-plugin://workshop.plugin-1/ui.js?reload=2',
    );

    vi.stubGlobal('window', { __DS_WEBUI__: true, location: { origin: 'http://127.0.0.1:4321' } });
    expect(resolveCommunityPluginUrl('ds-plugin://workshop.plugin-1/nested/ui.js?reload=2')).toBe(
      'http://127.0.0.1:4321/api/protocol/ds-plugin/workshop.plugin-1/nested/ui.js?reload=2',
    );
    expect(resolveCommunityPluginUrl('ds-plugin://workshop.plugin-1/ui.js', 'https://dstu.local')).toBe(
      'https://dstu.local/api/protocol/ds-plugin/workshop.plugin-1/ui.js',
    );
    expect(resolveCommunityPluginUrl('/local/module.js')).toBe('/local/module.js');

    vi.stubGlobal('window', undefined);
    vi.stubGlobal('__DS_WEBUI__', true);
    try {
      expect(resolveCommunityPluginUrl('ds-plugin://workshop.plugin-2/index.js?reload=1', 'http://localhost:3000')).toBe(
        'http://localhost:3000/api/protocol/ds-plugin/workshop.plugin-2/index.js?reload=1',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
