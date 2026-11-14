// @vitest-environment node
/**
 * FE-A3：渲染端的 Host 同步（`startCommunityUiPlugins` 的 v2 路径）——v2 清单与 `plugin:host|status` 写入
 * `kernel.hostStatus`，社区条目交给加载器；旧 Host（v1 数组 / v2 请求失败）回落到 v1 清单，官方 UI 保持乐观。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineUiPlugin, UiKernel } from '../kernel';
import { communityEntries, startCommunityUiPlugins, type CommunityUiBridge, type UiHostManifest } from '../community';
import type { UiManifestEntry } from '../loader';

vi.mock('../../ui-sdk', () => ({ defineUiPlugin: () => {} }));
vi.mock('../shared', () => ({ installSharedModules: () => {} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setImmediate(resolve)); }

const v2 = (plugins: UiHostManifest['plugins'], degraded: UiHostManifest['degraded'] = [], safeMode?: boolean): UiHostManifest =>
  ({ version: 2, plugins, degraded, ...(safeMode === undefined ? {} : { safeMode }) });
const builtin = (id: string) => ({ id, origin: 'builtin' as const, platforms: ['desktop'] });
const community = { id: 'community.stats', origin: 'community' as const, platforms: ['desktop'], version: '1.0.0', file: '/plugins/stats/ui.js' };

const statsModule = { default: defineUiPlugin({ meta: { id: 'community.stats', host: true }, apply: (ctx) => ctx.ui.nav.register({ id: 'stats', viewId: 'stats', labelKey: 'stats' }) }) };

function v2Bridge(overrides: Partial<CommunityUiBridge> = {}) {
  const handlers: { manifest?: (m: UiHostManifest) => void; status?: (d: { id: string; reason: string }[]) => void; v1?: (m: UiManifestEntry[]) => void } = {};
  const offs = { manifest: vi.fn(), status: vi.fn(), v1: vi.fn() };
  const manifest = deferred<UiHostManifest | UiManifestEntry[]>();
  const status = deferred<{ id: string; reason: string }[]>();
  const bridge: Required<CommunityUiBridge> = {
    invoke: vi.fn(async () => []),
    listen: vi.fn(async (fn) => { handlers.v1 = fn; return offs.v1; }),
    manifest: vi.fn(() => manifest.promise),
    listenManifest: vi.fn(async (fn) => { handlers.manifest = fn; return offs.manifest; }),
    status: vi.fn(() => status.promise),
    listenStatus: vi.fn(async (fn) => { handlers.status = fn; return offs.status; }),
    ...overrides,
  };
  return { bridge, handlers, offs, manifest, status };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('renderer host sync (v2 manifest + plugin:host|status)', () => {
  it('returns before the Host answers, then records host state and loads only community UI entries', async () => {
    vi.stubGlobal('window', {});
    const kernel = new UiKernel();
    const { bridge, handlers, offs, manifest, status } = v2Bridge();
    const load = vi.fn(async () => statsModule);
    const stop = await startCommunityUiPlugins(kernel, bridge, load);
    expect(kernel.hostStatus.known).toBe(false);
    expect(bridge.listen).not.toHaveBeenCalled();

    manifest.resolve(v2([builtin('dstu.anki'), builtin('dstu.chat'), community]));
    await vi.waitFor(() => expect(kernel.list()).toEqual(['community.stats']));
    expect(load.mock.calls).toEqual([['ds-plugin://community.stats/ui.js']]);
    expect(kernel.hostStatus.state('dstu.anki')).toBe('online');
    expect(kernel.hostStatus.state('dstu.review')).toBe('missing');

    status.resolve([{ id: 'dstu.anki', reason: 'missing service "db"' }]);
    await flush();
    expect(kernel.hostStatus.state('dstu.anki')).toBe('degraded');
    expect(kernel.hostStatus.reason('dstu.anki')).toBe('missing service "db"');

    handlers.status!([]);
    expect(kernel.hostStatus.state('dstu.anki')).toBe('online');
    handlers.manifest!(v2([builtin('dstu.anki')]));
    await vi.waitFor(() => expect(kernel.list()).toEqual([]));

    await stop();
    expect(offs.manifest).toHaveBeenCalledOnce();
    expect(offs.status).toHaveBeenCalledOnce();
    await kernel.dispose();
  });

  it('ignores an initial reply that an event already superseded', async () => {
    vi.stubGlobal('window', {});
    const kernel = new UiKernel();
    const { bridge, handlers, manifest } = v2Bridge();
    const stop = await startCommunityUiPlugins(kernel, bridge, vi.fn(async () => statsModule));
    handlers.manifest!(v2([builtin('dstu.anki')]));
    manifest.resolve(v2([]));
    await flush();
    expect(kernel.hostStatus.state('dstu.anki')).toBe('online');
    await stop();
    await kernel.dispose();
  });

  it('falls back to the v1 community manifest on a Host without v2, keeping official UI optimistic', async () => {
    vi.stubGlobal('window', {});
    const kernel = new UiKernel();
    const { bridge, handlers, offs, manifest, status } = v2Bridge();
    const load = vi.fn(async () => statsModule);
    const stop = await startCommunityUiPlugins(kernel, bridge, load);
    manifest.resolve([{ id: 'community.stats', file: '/plugins/stats/ui.js' }]);
    await vi.waitFor(() => expect(kernel.list()).toEqual(['community.stats']));
    expect(kernel.hostStatus.known).toBe(false);
    expect(kernel.hostStatus.state('dstu.anki')).toBe('unknown');
    status.resolve([{ id: 'dstu.anki', reason: 'x' }]);
    await flush();
    expect(kernel.hostStatus.state('dstu.anki')).toBe('degraded');
    handlers.v1!([]);
    await vi.waitFor(() => expect(kernel.list()).toEqual([]));
    await stop();
    expect(offs.v1).toHaveBeenCalledOnce();
    await kernel.dispose();
  });

  it('retries with the v1 request when the v2 request is rejected', async () => {
    vi.stubGlobal('window', {});
    const kernel = new UiKernel();
    const { bridge, manifest } = v2Bridge({ invoke: vi.fn(async () => [{ id: 'community.stats', file: '/plugins/stats/ui.js' }]) });
    const stop = await startCommunityUiPlugins(kernel, bridge, vi.fn(async () => statsModule));
    manifest.reject(new Error('validation: unknown arg version'));
    await vi.waitFor(() => expect(kernel.list()).toEqual(['community.stats']));
    expect(bridge.invoke).toHaveBeenCalledOnce();
    await stop();
    await kernel.dispose();
  });

  it('does not apply late replies after stop', async () => {
    vi.stubGlobal('window', {});
    const kernel = new UiKernel();
    const { bridge, manifest, status } = v2Bridge();
    const load = vi.fn();
    const stop = await startCommunityUiPlugins(kernel, bridge, load);
    await stop();
    manifest.resolve(v2([community]));
    status.resolve([{ id: 'dstu.anki', reason: 'x' }]);
    await flush();
    expect(load).not.toHaveBeenCalled();
    expect(kernel.hostStatus.known).toBe(false);
    expect(kernel.hostStatus.state('dstu.anki')).toBe('unknown');
    await kernel.dispose();
  });

  it('RF-W17-safe-mode-community-ui: a safe-mode manifest unloads community UI and a late v1 event cannot load it', async () => {
    vi.stubGlobal('window', {});
    const kernel = new UiKernel();
    const { bridge, handlers, manifest } = v2Bridge();
    const load = vi.fn(async () => statsModule);
    const stop = await startCommunityUiPlugins(kernel, bridge, load);
    // An old Host answers v1 first: the community UI loads normally.
    manifest.resolve([{ id: 'community.stats', file: '/plugins/stats/ui.js' }]);
    await vi.waitFor(() => expect(kernel.list()).toEqual(['community.stats']));
    expect(kernel.hostStatus.safeMode).toBe(false);
    // A v2 manifest then reports a safe-mode session: community UI is unloaded at once.
    handlers.manifest!(v2([builtin('dstu.anki')], [], true));
    await vi.waitFor(() => expect(kernel.list()).toEqual([]));
    expect(kernel.hostStatus.safeMode).toBe(true);
    expect(kernel.hostStatus.state('dstu.anki')).toBe('online');
    // And a late v1 event cannot smuggle community UI back in.
    handlers.v1!([{ id: 'community.stats', file: '/plugins/stats/ui.js' }]);
    await flush();
    expect(kernel.list()).toEqual([]);
    await stop();
    await kernel.dispose();
  });

  it('unloads community UI when a later manifest switches the session to safe mode', async () => {
    vi.stubGlobal('window', {});
    const kernel = new UiKernel();
    const { bridge, handlers, manifest } = v2Bridge();
    const stop = await startCommunityUiPlugins(kernel, bridge, vi.fn(async () => statsModule));
    manifest.resolve(v2([builtin('dstu.anki'), community]));
    await vi.waitFor(() => expect(kernel.list()).toEqual(['community.stats']));
    handlers.manifest!(v2([builtin('dstu.anki')], [], true));
    await vi.waitFor(() => expect(kernel.list()).toEqual([]));
    expect(kernel.hostStatus.safeMode).toBe(true);
    expect(kernel.hostStatus.state('dstu.anki')).toBe('online');
    await stop();
    await kernel.dispose();
  });

  it('exposes CONSENT_REQUIRED separately from other degradation reasons', async () => {
    vi.stubGlobal('window', {});
    const kernel = new UiKernel();
    const { bridge, status } = v2Bridge();
    const stop = await startCommunityUiPlugins(kernel, bridge, vi.fn(async () => statsModule));
    status.resolve([
      { id: 'community.stats', reason: 'CONSENT_REQUIRED: consent record missing' },
      { id: 'dstu.anki', reason: 'CONFIG_INVALID: theme must be a string' },
      { id: 'dstu.chat', reason: 'missing service "db"' },
    ]);
    await flush();
    expect(kernel.hostStatus.state('community.stats')).toBe('degraded');
    expect(kernel.hostStatus.consentRequired('community.stats')).toBe(true);
    expect(kernel.hostStatus.degraded('community.stats')).toEqual({ code: 'CONSENT_REQUIRED', detail: 'consent record missing', consentRequired: true });
    expect(kernel.hostStatus.consentRequired('dstu.anki')).toBe(false);
    expect(kernel.hostStatus.degraded('dstu.anki')?.code).toBe('CONFIG_INVALID');
    expect(kernel.hostStatus.degraded('dstu.chat')).toEqual({ detail: 'missing service "db"', consentRequired: false });
    expect(kernel.hostStatus.degraded('dstu.review')).toBeUndefined();
    await stop();
    await kernel.dispose();
  });

  it('maps v2 community entries to the v1 loader shape', () => {
    expect(communityEntries(v2([builtin('dstu.anki'), community, { id: 'community.headless', origin: 'community', platforms: ['desktop'] }])))
      .toEqual([{ id: 'community.stats', file: '/plugins/stats/ui.js', version: '1.0.0' }]);
  });
});
