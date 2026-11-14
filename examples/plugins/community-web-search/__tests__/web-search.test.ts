// @vitest-environment node
/**
 * example.web-search：用户 profile（extends 官方 profile）经真实装载器把本插件装在官方 browser 插件旁边。
 * 覆盖：装载与配置校验、贡献（服务）、与官方 webSearch 并存、旧的同 id 替换做法被拒绝、卸载、没有 UI 半。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadProfile } from '../../../../host/kernel/profile.ts';
import type { SearchInput, SearchResult } from '../../../../host/plugins/mcp/api.ts';
import { examplePath, loadExample } from '../../../testing/harness';
// 官方 browser 插件的模块图（约 900 个文件）在收集阶段装入；装载器随后按 profile 的 file URL 动态 import 拿到同一个模块实例。
import '../../../../host/plugins/browser/index.ts';

const ID = 'example.web-search';
const dir = (...segments: string[]) => examplePath('community-web-search', ...segments);
const OFFICIAL = dir('__tests__', 'fixtures', 'official.profile.json');

/** 官方 browser 插件需要的其他 lane 服务的最小替身（同 scripts/electron-migration/contracts/community-web-search-example.test.ts）。 */
const officialDeps = {
  settings: { get: (): string | null => null, getSecret: async (): Promise<string | null> => null },
  storage: {},
  log: { logger: () => undefined },
  featureFlags: { load: () => ({ isFeatureEnabled: () => false }) },
};

const input = (top_k: number): SearchInput => ({
  query: 'fsrs scheduler', top_k, engine: null, site: null, time_range: null, start: null, force_engine: null,
});
const providerOf = (result: SearchResult) => (result.result as { provider?: unknown } | undefined)?.provider;

let disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function load(profile: string) {
  const loaded = await loadExample(profile, { provide: officialDeps, official: OFFICIAL });
  disposers.push(() => loaded.host.dispose());
  return loaded;
}

describe('example.web-search', () => {
  it('loads next to the official browser plugin with the validated config from the user profile', async () => {
    const { host, result } = await load(dir('user.profile.json'));
    expect(result.degraded).toEqual([]);
    expect(result.installed.map((p) => p.id).sort()).toEqual(['dstu.browser', ID]);
    expect(host.runtime.get(ID)!.config).toEqual({ label: 'my-search', site: 'https://example.edu/my-search', maxResults: 2 });

    const mine = await host.ctx.get('exampleWebSearch')!.doSearch(input(5));
    expect(providerOf(mine)).toBe('my-search');
    expect(mine.citations?.map((c) => c.documentId)).toEqual([
      'https://example.edu/my-search?q=fsrs%20scheduler&rank=1',
      'https://example.edu/my-search?q=fsrs%20scheduler&rank=2',
    ]);
    // 官方服务原样保留：top_k = 0 时官方实现不触网，provider 为 "none"。
    expect(providerOf(await host.ctx.get('webSearch')!.doSearch(input(0)))).toBe('none');
  });

  it('fills config defaults and respects top_k', async () => {
    const { host, result } = await load(dir('test.profile.json'));
    expect(result.degraded).toEqual([]);
    expect(host.runtime.get(ID)!.config).toEqual({ label: 'example-web-search', site: 'https://example.edu/search', maxResults: 3 });
    const service = host.ctx.get('exampleWebSearch')!;
    expect((await service.doSearch(input(10))).citations).toHaveLength(3);
    expect((await service.doSearch(input(1))).citations).toHaveLength(1);
    expect(await service.doSearch(input(0))).toMatchObject({ ok: true, result: { items: [] }, citations: [] });
  });

  it('is degraded with CONFIG_INVALID before apply when the profile config does not match Config', async () => {
    const { host, result } = await load(dir('__tests__', 'fixtures', 'bad-config.profile.json'));
    expect(result.installed).toEqual([]);
    expect(result.degraded).toEqual([{ id: ID, reason: expect.stringMatching(/^CONFIG_INVALID: invalid config: \$\.maxResults /) }]);
    expect(host.ctx.get('exampleWebSearch')).toBeUndefined();
  });

  it('cannot replace the official plugin by reusing its id: the entry is degraded, and the profile has lost the official plugin', async () => {
    const { host, result } = await load(dir('__tests__', 'fixtures', 'override.profile.json'));
    expect(result.installed).toEqual([]);
    expect(result.degraded).toEqual([{
      id: 'dstu.browser',
      reason: 'ID_MISMATCH: profile entry "dstu.browser" points to a package whose manifest id is "example.web-search"',
    }]);
    expect(host.ctx.get('exampleWebSearch')).toBeUndefined();
    expect(host.ctx.get('webSearch')).toBeUndefined();
  });

  it('removes its service on unload and leaves the official one in place', async () => {
    const { host } = await load(dir('user.profile.json'));
    await host.unload(ID);
    expect(host.ctx.get('exampleWebSearch')).toBeUndefined();
    expect(host.ctx.get('webSearch')).toBeDefined();
    expect(await loadProfile(host.runtime, dir('test.profile.json'), { platform: 'desktop' })).toMatchObject({ degraded: [] });
    expect(host.ctx.get('exampleWebSearch')).toBeDefined();
  });

  it('has no UI half: the UI manifests list no module for it, so it loads no UI code and claims no i18n namespace', async () => {
    const { host } = await load(dir('user.profile.json'));
    expect((await host.invoke<{ id: string }[]>('plugin:ui|manifest', {})).map((e) => e.id)).not.toContain(ID);
    const v2 = await host.invoke<{ plugins: Record<string, unknown>[] }>('plugin:ui|manifest', { version: 2 });
    expect(v2.plugins.find((p) => p.id === ID)).toEqual({ id: ID, origin: 'community', platforms: ['desktop'], version: '1.0.0' });
  });
});
