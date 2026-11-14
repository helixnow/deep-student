import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { f3FeatureFlags } from './support/f3-feature-flags.ts';
import browser from '../index.ts';

const hosts: TestHost[] = [];
async function setup(initial: Record<string, string> = {}, debug = true) {
  const values = new Map(Object.entries(initial));
  const settings = {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => values.delete(key),
    listByPrefix: () => [],
    deleteByPrefix: () => 0,
    getSecret: async () => null,
    saveSecret: async () => undefined,
    deleteSecret: async () => false,
  };
  const host = await createTestHost({
    plugins: [browser], provide: {
      settings, log: { logger: () => undefined },
      storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } },
      featureFlags: f3FeatureFlags,
    },
    app: { version: '0.11.0', debug },
  });
  hosts.push(host);
  return { host, values };
}
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

describe('src/cmd/web_search.rs feature flag commands', () => {
  it('get_feature_flags returns defaults grouped by category and debug browser gate', async () => {
    const { host } = await setup();
    const result = await host.invoke('get_feature_flags') as {
      flags: { name: string; state: unknown; created_at: string }[];
      flags_by_category: Record<string, { name: string }[]>;
      total_count: number;
    };
    expect(result.total_count).toBe(18);
    expect(result.flags.map(flag => flag.name)).toContain('ui.workbench_browser');
    expect(result.flags_by_category.tools!.map(flag => flag.name)).toContain('tools.browser_agent');
    expect(result.flags.find(flag => flag.name === 'ui.workbench_browser')!.state).toBe('Enabled');
    expect(result.flags.find(flag => flag.name === 'observability.performance_metrics')!.state).toEqual({ Gradual: 0.3 });
    expect(result.flags[0]!.created_at).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/);
  });

  it('update_feature_flag enables, disables and sets gradual rollout then persists', async () => {
    const { host, values } = await setup();
    expect(await host.invoke('update_feature_flag', { featureName: 'search.reranker', action: 'enable' }))
      .toEqual({ success: true, message: "功能 'search.reranker' 已成功启用" });
    expect(await host.invoke('is_feature_enabled', { featureName: 'search.reranker' })).toBe(true);
    expect(values.get('feature_flags.config')).toContain('"search.reranker"');

    expect(await host.invoke('update_feature_flag', { featureName: 'search.reranker', action: 'disable' }))
      .toEqual({ success: true, message: "功能 'search.reranker' 已成功禁用" });
    expect(await host.invoke('is_feature_enabled', { featureName: 'search.reranker' })).toBe(false);

    await host.invoke('update_feature_flag', { featureName: 'search.reranker', action: 'set_gradual', value: 0 });
    expect(await host.invoke('is_feature_enabled', { featureName: 'search.reranker' })).toBe(false);
    await host.invoke('update_feature_flag', { featureName: 'search.reranker', action: 'set_gradual', value: 1 });
    expect(await host.invoke('is_feature_enabled', { featureName: 'search.reranker' })).toBe(true);
    const stored = JSON.parse(values.get('feature_flags.config')!);
    expect(stored['search.reranker'].state).toEqual({ Gradual: 1 });
    expect(stored['search.reranker'].rollout_percentage).toBe(1);

    await host.invoke('update_feature_flag', { featureName: 'search.reranker', action: 'set_gradual', value: 0.30000000000000004 });
    const gradual = JSON.parse(values.get('feature_flags.config')!)['search.reranker'];
    expect(gradual.state).toEqual({ Gradual: 0.3 });
    expect(gradual.rollout_percentage).toBe(0.3);
  });

  it('reports the exact Rust validation errors for unsupported actions and missing flags', async () => {
    const { host } = await setup();
    await expect(host.invoke('update_feature_flag', { featureName: 'search.reranker', action: 'explode' }))
      .rejects.toEqual({ error_type: 'Validation', message: '不支持的操作: explode', details: null });
    await expect(host.invoke('update_feature_flag', { featureName: 'missing.flag', action: 'enable' }))
      .rejects.toEqual({ error_type: 'Validation', message: "启用功能失败: Feature 'missing.flag' not found", details: null });
    await expect(host.invoke('update_feature_flag', { featureName: 'search.reranker', action: 'set_gradual' }))
      .rejects.toEqual({ error_type: 'Validation', message: '渐进发布需要提供百分比参数', details: null });
  });

  it('is_feature_enabled honours dependencies and release browser gates', async () => {
    const { host } = await setup({}, false);
    expect(await host.invoke('is_feature_enabled', { featureName: 'tools.browser_agent' })).toBe(false);
    expect(await host.invoke('is_feature_enabled', { featureName: 'tools.workbench_agent' })).toBe(true);
    expect(await host.invoke('is_feature_enabled', { featureName: 'ui.workbench_browser' })).toBe(false);
    expect(await host.invoke('is_feature_enabled', { featureName: 'unknown.feature' })).toBe(false);
  });

  it('applies user-specific and gradual rollout state loaded from settings', async () => {
    const config = {
      'feature_under_test': {
        name: 'feature_under_test', description: 'test', state: { UserSpecific: ['allowed'] }, category: 'test',
        dependencies: [], min_version: null, max_version: null, rollout_percentage: null,
        created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
      },
    };
    const { host } = await setup({ 'feature_flags.config': JSON.stringify(config) });
    expect(await host.invoke('is_feature_enabled', { featureName: 'feature_under_test', userId: 'allowed' })).toBe(true);
    expect(await host.invoke('is_feature_enabled', { featureName: 'feature_under_test', userId: 'denied' })).toBe(false);
    expect(await host.invoke('is_feature_enabled', { featureName: 'feature_under_test' })).toBe(false);
  });
});
