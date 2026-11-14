import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import browser from '../index.ts';
import { ensurePublicSettingKey, ensurePublicSettingPrefix } from '../src/settings.ts';

const hosts: TestHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });
async function setup() {
  const values = new Map<string, string>();
  const calls: unknown[] = [];
  const host = await createTestHost({ plugins: [browser], provide: {
    log: { logger: () => undefined },
    storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } },
    featureFlags: {
      load: () => { throw new Error('feature flags are not read by setting commands'); },
      save: () => undefined,
    },
    settings: {
      get: (key: string) => values.get(key) ?? null,
      saveSecret: async (key: string, value: string) => { calls.push(['saveSecret', key, value]); values.set(key, value); },
      getSecret: async (key: string) => { calls.push(['getSecret', key]); return values.get(key) ?? null; },
      deleteSecret: async (key: string) => { calls.push(['deleteSecret', key]); return values.delete(key); },
      listByPrefix: (prefix: string) => [...values].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value, updatedAt: '2026-11-03T00:00:00+00:00' })),
      deleteByPrefix: (prefix: string) => { let count = 0; for (const key of values.keys()) if (key.startsWith(prefix)) { values.delete(key); count++; } return count; },
    },
  } });
  hosts.push(host);
  return { host, values, calls };
}
describe('web_search.rs::internal_setting_boundary_tests', () => {
  it('blocks_internal_oauth_keys_from_generic_ipc', async () => {
    expect(() => ensurePublicSettingKey('internal.oauth.openai_codex.session')).toThrow();
    for (const prefix of ['internal.oauth.', 'internal.', '']) expect(() => ensurePublicSettingPrefix(prefix)).toThrow();
    const { host, calls } = await setup();
    for (const command of ['get_setting', 'save_setting', 'delete_setting']) {
      await expect(host.invoke(command, { key: 'internal.oauth.openai_codex.session', value: 'secret' })).rejects.toEqual({
        error_type: 'Configuration', message: '该设置键属于后端内部凭据，不能通过通用设置接口访问', details: null,
      });
    }
    for (const command of ['get_settings_by_prefix', 'delete_settings_by_prefix']) {
      await expect(host.invoke(command, { prefix: '' })).rejects.toEqual({
        error_type: 'Configuration', message: '该设置前缀可能包含后端内部凭据，不能通过通用设置接口访问', details: null,
      });
    }
    expect(calls).toEqual([]);
  });
  it('leaves_normal_settings_available', async () => {
    expect(() => ensurePublicSettingKey('web_search.default_engine')).not.toThrow();
    expect(() => ensurePublicSettingPrefix('mcp.tools.')).not.toThrow();
    const { host, calls } = await setup();
    expect(await host.invoke('get_setting', { key: 'absent' })).toBeNull();
    expect(await host.invoke('save_setting', { key: 'mcp.tools.x', value: 'value' })).toBe(true);
    expect(await host.invoke('get_setting', { key: 'mcp.tools.x' })).toBe('value');
    expect(await host.invoke('get_settings_by_prefix', { prefix: 'mcp.tools.' })).toEqual([['mcp.tools.x', 'value', '2026-11-03T00:00:00+00:00']]);
    expect(await host.invoke('delete_settings_by_prefix', { prefix: 'mcp.tools.' })).toBe(1);
    expect(await host.invoke('delete_setting', { key: 'mcp.tools.x' })).toBe(false);
    expect(calls).toContainEqual(['saveSecret', 'mcp.tools.x', 'value']);
  });
  it('preserves AppError database mapping and swallowing read errors only in config commands', async () => {
    const host = await createTestHost({ plugins: [browser], provide: {
      log: { logger: () => undefined },
      storage: { pathOf: () => '', database: () => { throw new Error('storage not used'); } },
      featureFlags: {
        load: () => { throw new Error('feature flags are not read by setting commands'); },
        save: () => undefined,
      },
      settings: {
        get() { throw new Error('read failed'); },
        async getSecret() { throw new Error('secure failed'); },
      },
    } });
    hosts.push(host);
    await expect(host.invoke('get_setting', { key: 'normal' })).rejects.toEqual({ error_type: 'Database', message: '读取设置失败: secure failed', details: null });
    expect(await host.invoke('get_tools_namespace_config')).toMatchObject({ namespace_prefix: null, conflict_resolution: 'use_local' });
  });
  it('returns Rust fixed security state and disabled backend conflict list', async () => {
    const { host } = await setup();
    expect(await host.invoke('detect_tool_conflicts')).toEqual([]);
    expect(await host.invoke('get_security_status')).toMatchObject({ keychain_available: false, migration_completed: true, sensitive_keys_count: 0, last_migration_time: null });
  });
});
