import { describe, expect, it } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { defaultVendorConfig, modelProfileFromDe } from '../src/config_values.ts';
import type { ModelProfile } from '../api.ts';

describe('persisted configuration serde types (L02-05)', () => {
  async function setup() {
    const settings = new Map([['vendor_configs', '[]'], ['model_profiles', '[]'], ['builtin_caps_migration_v2', 'done']]);
    const failingKeys = new Set<string>();
    const warnings: string[] = [];
    const host = await createTestHost({ plugins: [plugin], provide: {
      settings: { get: (key: string) => { if (failingKeys.has(key)) throw new Error('settings read unavailable'); return settings.get(key) ?? null; },
        save: (key: string, value: string) => settings.set(key, value), getSecret: async () => null },
      secrets: { isEncryptedFormat: () => false },
      log: { logger: () => ({ warn: (message: string) => warnings.push(message), info() {}, debug() {}, error() {} }) },
    } });
    return { host, settings, failingKeys, warnings };
  }
  it('read_hidden_builtin_model_profile_ids uses Rust whitespace and does not rewrite a valid hidden list', async () => {
    const { host, settings } = await setup();
    try {
      // Populate the real builtin snapshot first, so reconciliation recognizes the current model.
      const baseline = await host.invoke<ModelProfile[]>('get_model_profiles');
      const builtin = baseline.find(profile => profile.id === 'builtin-gemini-3-flash')!;
      expect(builtin).toBeDefined();
      const raw = JSON.stringify([`\u0085${builtin.id}\u0085`, builtin.id, '\u0085']);
      settings.set('hidden_builtin_model_profile_ids', raw);
      const hidden = await host.invoke<ModelProfile[]>('get_model_profiles');
      expect(hidden.some(profile => profile.id === builtin.id)).toBe(false);
      expect(settings.get('hidden_builtin_model_profile_ids')).toBe(raw);
      settings.set('hidden_builtin_model_profile_ids', JSON.stringify([`\ufeff${builtin.id}\ufeff`]));
      const visible = await host.invoke<ModelProfile[]>('get_model_profiles');
      expect(visible.some(profile => profile.id === builtin.id)).toBe(true);
    } finally { await host.dispose(); }
  });
  it('read_hidden_builtin_model_profile_ids rejects the entire malformed vector and logs the fallback', async () => {
    const { host, settings, warnings } = await setup();
    try {
      const baseline = await host.invoke<ModelProfile[]>('get_model_profiles');
      const builtin = baseline.find(profile => profile.id === 'builtin-gemini-3-flash')!;
      expect(builtin).toBeDefined();
      for (const raw of ['null', '{}', '[', JSON.stringify([builtin.id, 123]), JSON.stringify([builtin.id, null]), JSON.stringify([builtin.id, {}])]) {
        warnings.length = 0;
        settings.set('hidden_builtin_model_profile_ids', raw);
        const profiles = await host.invoke<ModelProfile[]>('get_model_profiles');
        expect(profiles.some(profile => profile.id === builtin.id)).toBe(true);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/^\[VendorModel\] 解析隐藏内置模型列表失败，回退为空列表: .+/u);
        expect(settings.get('hidden_builtin_model_profile_ids')).toBe(raw);
      }
    } finally { await host.dispose(); }
  });
  it('read_hidden_builtin_model_profile_ids keeps absent/read-failure fallback silent', async () => {
    const { host, failingKeys, warnings } = await setup();
    try {
      const baseline = await host.invoke<ModelProfile[]>('get_model_profiles');
      expect(baseline.length).toBeGreaterThan(0);
      expect(warnings).toEqual([]);
      failingKeys.add('hidden_builtin_model_profile_ids');
      const result = await host.invoke<ModelProfile[]>('get_model_profiles');
      expect(result).toEqual(baseline);
      expect(warnings).toEqual([]);
    } finally { await host.dispose(); }
  });
  it('rejects non-string assignments through the real command instead of leaking a numeric model id', async () => {
    const { host, settings } = await setup();
    try {
      settings.set('model_assignments', '{"model2_config_id":123}');
      await expect(host.invoke('get_model_assignments')).rejects.toMatchObject({ error_type: 'Configuration',
        message: expect.stringContaining('invalid type: integer `123`, expected a string'), details: null });
      settings.set('model_assignments', '{"model2_config_id":null,"extra":123}');
      expect(await host.invoke('get_model_assignments')).toMatchObject({ model2_config_id: null });
    } finally { await host.dispose(); }
  });
  it('rejects malformed vendor elements, vectors, maps and nullable fields instead of dropping them', async () => {
    const { host, settings } = await setup();
    try {
      const vendor = { ...defaultVendorConfig(), id: 'v', name: 'Vendor', baseUrl: 'https://provider.invalid/v1', apiKey: '' };
      for (const value of [null, 12, { ...vendor, authMode: 12 }, { ...vendor, isBuiltin: null },
        { ...vendor, apiKeys: ['one', 12] }, { ...vendor, headers: { authorization: 12 } },
        { ...vendor, rateLimitPerMinute: -1 }, { ...vendor, sortOrder: 2 ** 31 }]) {
        settings.set('vendor_configs', JSON.stringify([value]));
        await expect(host.invoke('get_vendor_configs')).rejects.toMatchObject({ error_type: 'Configuration', message: expect.stringContaining('解析供应商配置失败') });
      }
    } finally { await host.dispose(); }
  });
  it('distinguishes defaulted fields from Option fields and enforces aliases/integer types', async () => {
    const { host, settings } = await setup();
    try {
      const profile = modelProfileFromDe({ id: 'm', vendorId: 'v', label: 'Model', model: 'model' });
      for (const value of [{ ...profile, modelAdapter: null }, { ...profile, enabled: 'true' },
        { ...profile, temperature: null }, { ...profile, maxOutputTokens: 3.5 },
        { ...profile, enableThinking: 1 }, { ...profile, topK: -1 },
        { ...profile, extraBody: [] }, { ...profile, context_window: 1024 }]) {
        settings.set('model_profiles', JSON.stringify([value]));
        await expect(host.invoke('get_model_profiles')).rejects.toMatchObject({ error_type: 'Configuration', message: expect.stringContaining('解析模型条目失败') });
      }
      settings.set('model_profiles', JSON.stringify([{ id: 'm', vendorId: 'v', label: 'Model', model: 'model', providerScope: null, enableThinking: null }]));
      expect(await host.invoke('get_model_profiles')).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'm', modelAdapter: 'general', enabled: true, enableThinking: null })]));
    } finally { await host.dispose(); }
  });
});
