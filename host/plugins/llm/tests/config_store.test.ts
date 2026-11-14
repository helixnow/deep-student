import { describe, expect, it } from 'vitest';
import type { SettingsStore, SettingRow } from '../../../platform/settings/api.ts';
import type { CryptoService, EncryptedData } from '../../../platform/secrets/api.ts';
import type { ApiConfig, ModelProfile, VendorConfig } from '../api.ts';
import {
  ConfigError, LlmConfigStore, apiOriginsMatch, defaultVendorConfig, deserializeVendorConfigs,
  loadBuiltinModels, loadBuiltinVendors, mergeBuiltinProfileUserAware, mergeVendorProfile,
  modelAssignmentsFromDe,
} from '../src/config_store.ts';
import {
  effectiveApiProtocolForConfig, getProviderProtocolRecord, isOfficialDeepseekConfig,
  providerAllowedProtocols, providerSupportsOpenaiResponses, requestAdapterIdForConfig,
  resolvePreferredProtocolForProvider, shouldUseOpenaiResponsesForConfig,
  type ProtocolConfigLike,
} from '../src/protocol.ts';
import { PROVIDER_PROTOCOL_REGISTRY_DOCUMENT } from '../src/data/provider_protocol_registry.ts';
import { setLlmLogger } from '../src/logging.ts';

class MemorySettings implements SettingsStore {
  readonly plain = new Map<string, string>();
  readonly secrets = new Map<string, string>();
  failDeleteSecret = false;
  failSaveSecret = false;

  save(key: string, value: string): void {
    this.plain.set(key, value);
  }
  get(key: string): string | null {
    return this.plain.get(key) ?? null;
  }
  delete(key: string): boolean {
    return this.plain.delete(key);
  }
  listByPrefix(prefix: string): SettingRow[] {
    return [...this.plain.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '2026-01-01T00:00:00+00:00' }));
  }
  deleteByPrefix(prefix: string): number {
    let removed = 0;
    for (const key of [...this.plain.keys()]) {
      if (key.startsWith(prefix)) {
        this.plain.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
  async saveSecret(key: string, value: string): Promise<void> {
    if (this.failSaveSecret) throw new Error('secure store unavailable');
    this.secrets.set(key, value);
  }
  async getSecret(key: string): Promise<string | null> {
    return this.secrets.get(key) ?? null;
  }
  async deleteSecret(key: string): Promise<boolean> {
    if (this.failDeleteSecret) throw new Error('secure store read-only');
    return this.secrets.delete(key);
  }
}

function isEncryptedFormat(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Partial<EncryptedData>;
    return (
      typeof parsed.ciphertext === 'string' &&
      typeof parsed.nonce === 'string' &&
      (parsed.version === null || typeof parsed.version === 'number')
    );
  } catch {
    return false;
  }
}

const fakeCrypto = {
  keyPath: '/tmp/.master_key',
  keyFingerprint: '00000000',
  encryptApiKey(plaintext: string): EncryptedData {
    return {
      ciphertext: Buffer.from(plaintext, 'utf8').toString('base64'),
      nonce: '',
      version: 2,
    };
  },
  decryptApiKey(data: EncryptedData): string {
    return Buffer.from(data.ciphertext, 'base64').toString('utf8');
  },
  migratePlaintextKey(plaintext: string): string {
    return JSON.stringify(fakeCrypto.encryptApiKey(plaintext));
  },
  verifyKeyIntegrity(): boolean {
    return true;
  },
  async rotateMasterKey(): Promise<CryptoService> {
    return fakeCrypto as unknown as CryptoService;
  },
} as unknown as CryptoService;

function makeStore(settings = new MemorySettings()): { store: LlmConfigStore; settings: MemorySettings } {
  return {
    settings,
    store: new LlmConfigStore({
      settings,
      isEncryptedFormat,
      openCrypto: async () => fakeCrypto,
    }),
  };
}

function seedConfigs(settings: MemorySettings, vendors: VendorConfig[], profiles: ModelProfile[]): void {
  settings.save('vendor_configs', JSON.stringify(vendors));
  settings.save('model_profiles', JSON.stringify(profiles));
  settings.save('builtin_caps_migration_v2', 'done');
}

function profileFixture(
  id: string,
  label: string,
  model: string,
  supportsTools: boolean,
  isBuiltin: boolean,
): ModelProfile {
  return {
    id,
    vendorId: 'builtin-deepseek',
    label,
    model,
    providerScope: 'deepseek',
    apiProtocol: null,
    modelAdapter: 'deepseek',
    isMultimodal: false,
    isReasoning: false,
    isEmbedding: false,
    isReranker: false,
    isImageGeneration: false,
    supportsTools,
    supportsReasoning: false,
    status: 'enabled',
    enabled: true,
    maxOutputTokens: 8192,
    temperature: 0.7,
    reasoningEffort: null,
    reasoningMode: null,
    thinkingEnabled: false,
    thinkingBudget: null,
    includeThoughts: false,
    enableThinking: null,
    minP: null,
    topK: null,
    geminiApiVersion: null,
    isBuiltin,
    repetitionPenalty: null,
    reasoningSplit: null,
    effort: null,
    verbosity: null,
    isFavorite: false,
    maxTokensLimit: null,
    contextWindow: null,
    extraBody: null,
  };
}

function apiDefaults(overrides: Partial<ApiConfig>): ApiConfig {
  return {
    id: 'cfg',
    name: 'cfg',
    vendorId: null,
    vendorName: null,
    providerType: null,
    providerScope: null,
    authMode: null,
    apiProtocol: null,
    supportsOpenaiResponses: null,
    apiKey: '',
    baseUrl: '',
    model: '',
    isMultimodal: false,
    isReasoning: false,
    isEmbedding: false,
    isReranker: false,
    isImageGeneration: false,
    enabled: true,
    modelAdapter: 'general',
    maxOutputTokens: 8192,
    temperature: 0.7,
    supportsTools: false,
    geminiApiVersion: 'v1',
    isBuiltin: false,
    isReadOnly: false,
    reasoningEffort: null,
    reasoningMode: null,
    thinkingEnabled: false,
    thinkingBudget: null,
    includeThoughts: false,
    minP: null,
    topK: null,
    enableThinking: null,
    supportsReasoning: false,
    headers: null,
    topPOverride: null,
    frequencyPenaltyOverride: null,
    presencePenaltyOverride: null,
    repetitionPenalty: null,
    reasoningSplit: null,
    effort: null,
    verbosity: null,
    isFavorite: false,
    maxTokensLimit: null,
    contextWindow: null,
    extraBody: null,
    resolvedAdapterId: null,
    ...overrides,
  };
}

const protocolOf = (config: ApiConfig): ProtocolConfigLike => ({
  apiProtocol: config.apiProtocol,
  providerType: config.providerType,
  providerScope: config.providerScope,
  supportsOpenaiResponses: config.supportsOpenaiResponses,
  modelAdapter: config.modelAdapter,
  baseUrl: config.baseUrl,
  model: config.model,
});

describe('llm_manager/mod.rs configuration', () => {
  it('logs missing profile vendors before skipping them (L02-06)', async () => {
    const { store, settings } = makeStore();
    const profile = { ...profileFixture('orphan-profile', 'Orphan', 'orphan', false, false), vendorId: 'missing-vendor' };
    seedConfigs(settings, [], [profile]);
    const warnings: string[] = [];
    setLlmLogger({ info: () => {}, debug: () => {}, error: () => {}, warn: text => warnings.push(text) });
    try {
      expect((await store.getApiConfigs()).some(config => config.id === profile.id)).toBe(false);
      expect(warnings).toContain('[VendorModel] 找不到模型条目关联的供应商: orphan-profile');
    } finally { setLlmLogger(null); }
  });
  it('vendor_config_default_uses_registry_backed_openai_defaults', () => {
    const vendor = defaultVendorConfig();
    expect(vendor.providerType).toBe('openai');
    expect(vendor.apiProtocol).toBe('openai_responses');
    expect(vendor.supportsOpenaiResponses).toBe(true);
  });

  it('resolve_preferred_protocol_for_provider_uses_registry_defaults_for_native_vendors', () => {
    expect(
      resolvePreferredProtocolForProvider('anthropic', 'anthropic', 'https://api.anthropic.com/v1', null),
    ).toBe('anthropic_messages');
    expect(
      resolvePreferredProtocolForProvider('gemini', 'google', 'https://generativelanguage.googleapis.com', null),
    ).toBe('google_generate_content');
    expect(
      resolvePreferredProtocolForProvider('siliconflow', 'general', 'https://api.siliconflow.cn/v1', null),
    ).toBe('openai_chat_completions');
  });

  it('registry_level_responses_support_only_unlocks_option_without_switching_default', () => {
    for (const [provider, baseUrl] of [
      ['qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'],
      ['doubao', 'https://ark.cn-beijing.volces.com/api/v3'],
      ['ernie', 'https://qianfan.baidubce.com/v2'],
    ]) {
      const record = getProviderProtocolRecord(provider);
      expect(record, `${provider} provider`).not.toBeNull();
      expect(record!.supports_openai_responses).toBe(true);
      expect(record!.allowed_protocols).toContain('openai_responses');
      expect(
        resolvePreferredProtocolForProvider(provider, 'general', baseUrl!, null),
        `${provider} default routing`,
      ).toBe('openai_chat_completions');
      expect(
        resolvePreferredProtocolForProvider(provider, 'general', baseUrl!, true),
        `${provider} explicit opt-in`,
      ).toBe('openai_responses');
    }

    for (const provider of ['grok', 'xai']) {
      expect(
        resolvePreferredProtocolForProvider(provider, 'general', 'https://api.x.ai/v1', null),
        `${provider} registry Responses default`,
      ).toBe('openai_responses');
    }
  });

  it('responses_routing_accepts_all_model_adapters_when_the_host_declares_support', () => {
    for (const adapter of ['qwen', 'deepseek', 'doubao', 'anthropic', 'claude', 'google', 'gemini']) {
      const explicit = apiDefaults({
        providerType: 'custom',
        baseUrl: 'https://proxy.example.com/v1',
        modelAdapter: adapter,
        apiProtocol: 'openai_responses',
        supportsOpenaiResponses: true,
      });
      expect(shouldUseOpenaiResponsesForConfig(protocolOf(explicit)), `${adapter} explicit`).toBe(true);

      const defaulted = apiDefaults({ ...explicit, apiProtocol: null });
      expect(shouldUseOpenaiResponsesForConfig(protocolOf(defaulted)), `${adapter} default`).toBe(true);
    }

    const official = apiDefaults({
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      modelAdapter: 'deepseek',
    });
    expect(shouldUseOpenaiResponsesForConfig(protocolOf(official))).toBe(true);
  });

  it('official_deepseek_responses_gating_follows_documented_model_list', () => {
    expect(providerAllowedProtocols('deepseek')).toContain('openai_responses');
    expect(
      resolvePreferredProtocolForProvider('deepseek', 'general', '', null),
    ).toBe('openai_responses');

    const flash = apiDefaults({
      providerType: 'deepseek',
      modelAdapter: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      supportsReasoning: true,
      isReasoning: true,
    });
    expect(shouldUseOpenaiResponsesForConfig(protocolOf(flash))).toBe(true);
    expect(
      shouldUseOpenaiResponsesForConfig(protocolOf({ ...flash, model: 'deepseek-flash' })),
    ).toBe(true);

    for (const model of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']) {
      const route = { ...flash, model };
      expect(shouldUseOpenaiResponsesForConfig(protocolOf(route)), `model=${model} default`).toBe(true);
      expect(
        shouldUseOpenaiResponsesForConfig(protocolOf({ ...route, apiProtocol: 'openai_responses' })),
        `model=${model} explicit`,
      ).toBe(true);
    }

    for (const model of ['deepseek-v3.2', 'deepseek-v3.1']) {
      const route = { ...flash, model };
      expect(effectiveApiProtocolForConfig(protocolOf(route)), `model=${model} default`).toBe(
        'openai_chat_completions',
      );
      expect(
        shouldUseOpenaiResponsesForConfig(protocolOf({ ...route, apiProtocol: 'openai_responses' })),
        `model=${model} explicit`,
      ).toBe(false);
    }
  });

  it('official_deepseek_detection_requires_official_base_url', () => {
    const official = apiDefaults({
      providerType: 'deepseek',
      modelAdapter: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
    });
    expect(isOfficialDeepseekConfig(protocolOf(official))).toBe(true);
    expect(isOfficialDeepseekConfig(protocolOf({ ...official, baseUrl: '' }))).toBe(true);
    const proxy = { ...official, baseUrl: 'https://myproxy.example.com/v1' };
    expect(isOfficialDeepseekConfig(protocolOf(proxy))).toBe(false);
    expect(
      isOfficialDeepseekConfig(protocolOf({ ...official, baseUrl: 'https://myproxy.example.com/api.deepseek.com/v1' })),
    ).toBe(false);
    const hosted = { ...official, providerType: 'siliconflow', providerScope: 'deepseek', baseUrl: 'https://api.siliconflow.cn/v1' };
    expect(isOfficialDeepseekConfig(protocolOf(hosted))).toBe(false);

    expect(effectiveApiProtocolForConfig(protocolOf(proxy))).toBe('openai_chat_completions');
    expect(
      effectiveApiProtocolForConfig(protocolOf({ ...proxy, supportsOpenaiResponses: true })),
    ).toBe('openai_responses');
  });

  it('new_2026_providers_are_registered_with_expected_defaults', () => {
    for (const provider of ['grok', 'xai', 'ernie', 'mistral']) {
      const record = getProviderProtocolRecord(provider);
      expect(record, `${provider} provider`).not.toBeNull();
      const expectedDefault = provider === 'grok' || provider === 'xai' ? 'openai_responses' : 'openai_chat_completions';
      expect(record!.default_protocol).toBe(expectedDefault);
      expect(record!.allowed_protocols).not.toContain('anthropic_messages');
    }
  });

  it('official_openai_detection_uses_exact_host_match', () => {
    expect(providerSupportsOpenaiResponses('openai', 'https://api.openai.com/v1', null)).toBe(true);
    expect(providerSupportsOpenaiResponses('openai', '', null)).toBe(true);
    expect(providerSupportsOpenaiResponses('openai', 'https://myproxy.com/api.openai.com/v1', null)).toBe(false);
    expect(providerSupportsOpenaiResponses('openai', 'https://api.openai.com.evil.example/v1', null)).toBe(false);
  });

  it('provider_protocol_registry_contract_is_well_formed', () => {
    const registry = PROVIDER_PROTOCOL_REGISTRY_DOCUMENT as unknown as {
      providers: { provider_type: string; allowed_protocols: string[]; default_protocol: string }[];
    };
    expect(registry.providers.length).toBeGreaterThan(0);
    for (const provider of registry.providers) {
      expect(provider.provider_type).not.toBe('');
      expect(provider.allowed_protocols.length).toBeGreaterThan(0);
      expect(provider.default_protocol).not.toBe('');
      expect(provider.allowed_protocols).toContain(provider.default_protocol);
    }
  });

  it('provider_protocol_registry_contract_preserves_shared_routing_expectations', () => {
    const openai = getProviderProtocolRecord('openai');
    expect(openai?.default_protocol).toBe('openai_responses');
    expect(openai?.supports_openai_responses).toBe(true);
    expect(openai?.allowed_protocols).toContain('openai_responses');

    const anthropic = getProviderProtocolRecord('anthropic');
    expect(anthropic?.allowed_protocols).toEqual(['anthropic_messages']);

    const gemini = getProviderProtocolRecord('gemini');
    expect(gemini?.allowed_protocols).toEqual(['google_generate_content']);

    const custom = getProviderProtocolRecord('custom');
    expect(custom?.default_protocol).toBe('openai_chat_completions');
    expect(providerSupportsOpenaiResponses('custom', 'https://proxy.example.com/v1', null)).toBe(false);
  });

  it('openai_codex_registry_is_responses_only', () => {
    const codex = getProviderProtocolRecord('openai_codex');
    expect(codex?.default_protocol).toBe('openai_responses');
    expect(codex?.allowed_protocols).toEqual(['openai_responses']);
    expect(codex?.supports_openai_responses).toBe(true);
    expect(
      resolvePreferredProtocolForProvider(
        'openai_codex',
        'general',
        'https://chatgpt.com/backend-api/codex',
        true,
      ),
    ).toBe('openai_responses');
  });

  it('auth_mode_defaults_for_legacy_serialized_configs', () => {
    const vendor = JSON.parse(JSON.stringify(defaultVendorConfig())) as Record<string, unknown>;
    delete vendor['authMode'];
    const vendorValue = { ...vendor, apiKeys: [], headers: {} };
    const parsed = deserializeVendorConfigs(JSON.stringify([vendorValue]));
    expect(parsed[0]?.authMode).toBeNull();
  });

  it('third_party_openai_compatible_base_url_does_not_imply_official_responses_support', () => {
    expect(providerSupportsOpenaiResponses('openai', 'https://api.qsl.fan/v1', null)).toBe(false);
  });

  it('oauth_codex_builtin_model_requires_an_authenticated_session', () => {
    const vendor = loadBuiltinVendors([]).find((item) => item.id === 'builtin-openai-codex')!;
    const profile = loadBuiltinModels([]).find((item) => item.id === 'builtin-codex-gpt-5.4')!;
    expect(vendor.apiKey).toBe('');
    expect(vendor.authMode).toBe('openai_codex_oauth');

    const signedOut = mergeVendorProfile(vendor, profile, false, (value) => value);
    expect(signedOut.runtime.enabled).toBe(false);

    const resolved = mergeVendorProfile(vendor, profile, true, (value) => value);
    expect(resolved.runtime.enabled).toBe(true);
    expect(resolved.runtime.apiKey).toBe('');
    expect(resolved.runtime.apiProtocol).toBe('openai_responses');
    expect(shouldUseOpenaiResponsesForConfig(protocolOf(resolved.runtime))).toBe(true);
  });

  it('bootstrap_vendor_model_config_repairs_invalid_openai_responses_overrides', async () => {
    const { store, settings } = makeStore();
    const vendor: VendorConfig = {
      id: 'vendor-qsl',
      name: 'QSL',
      providerType: 'openai',
      authMode: null,
      apiProtocol: 'openai_responses',
      supportsOpenaiResponses: null,
      baseUrl: 'https://api.qsl.fan/v1',
      apiKey: '',
      apiKeys: [],
      headers: {},
      rateLimitPerMinute: null,
      defaultTimeoutMs: null,
      notes: null,
      isBuiltin: false,
      isReadOnly: false,
      sortOrder: null,
      maxTokensLimit: null,
      websiteUrl: null,
    };
    const profile = {
      ...profileFixture('profile-qsl', 'DeepSeek V4', 'deepseek-v4-pro', true, true),
      vendorId: 'vendor-qsl',
      providerScope: null,
      apiProtocol: 'openai_responses',
      modelAdapter: 'general',
    };
    seedConfigs(settings, [vendor], [profile]);

    await store.bootstrapVendorModelConfig();

    const vendors = await store.readUserVendorConfigs();
    expect(vendors[0]?.apiProtocol).toBe('openai_chat_completions');
    expect(vendors[0]?.supportsOpenaiResponses).toBe(false);

    const profiles = await store.readUserModelProfiles();
    expect(profiles[0]?.apiProtocol).toBe('openai_chat_completions');
  });

  it('merge_builtin_profile_user_aware_preserves_user_modified_fields', () => {
    const profiles = [profileFixture('builtin-deepseek-reasoner', 'My Custom Label', 'deepseek-reasoner-custom', false, false)];
    const builtin = profileFixture('builtin-deepseek-reasoner', 'DeepSeek Reasoner (深度推理)', 'deepseek-reasoner', true, true);
    const previous = profileFixture('builtin-deepseek-reasoner', 'DeepSeek Reasoner (旧标签)', 'deepseek-reasoner', true, true);

    mergeBuiltinProfileUserAware(profiles, builtin, previous);

    expect(profiles.length).toBe(1);
    expect(profiles[0]?.label).toBe('My Custom Label');
    expect(profiles[0]?.model).toBe('deepseek-reasoner-custom');
    expect(profiles[0]?.supportsTools).toBe(false);
    expect(profiles[0]?.isBuiltin).toBe(true);
  });

  it('merge_builtin_profile_user_aware_updates_untouched_fields_from_builtin', () => {
    const profiles = [profileFixture('builtin-deepseek-chat', 'DeepSeek Chat (旧标签)', 'deepseek-chat', true, false)];
    const builtin = profileFixture('builtin-deepseek-chat', 'DeepSeek Chat (新标签)', 'deepseek-chat', true, true);
    builtin.temperature = 0.2;
    const previous = profileFixture('builtin-deepseek-chat', 'DeepSeek Chat (旧标签)', 'deepseek-chat', true, true);
    previous.temperature = 0.7;
    profiles[0]!.temperature = 0.7;

    mergeBuiltinProfileUserAware(profiles, builtin, previous);

    expect(profiles.length).toBe(1);
    expect(profiles[0]?.label).toBe('DeepSeek Chat (新标签)');
    expect(profiles[0]?.temperature).toBeCloseTo(0.2, 6);
    expect(profiles[0]?.isBuiltin).toBe(true);
  });

  it('merge_builtin_profile_user_aware_adds_missing_builtin_profile', () => {
    const profiles: ModelProfile[] = [];
    const builtin = profileFixture('builtin-deepseek-chat', 'DeepSeek Chat (对话)', 'deepseek-chat', true, true);
    mergeBuiltinProfileUserAware(profiles, builtin, undefined);
    expect(profiles.length).toBe(1);
    expect(profiles[0]?.id).toBe('builtin-deepseek-chat');
    expect(profiles[0]?.isBuiltin).toBe(true);
  });

  it('merge_builtin_profile_user_aware_without_snapshot_syncs_capability_fields', () => {
    const profiles = [profileFixture('builtin-deepseek-chat', 'User Local Label', 'deepseek-chat-custom', false, false)];
    const builtin = profileFixture('builtin-deepseek-chat', 'DeepSeek Chat (官方)', 'deepseek-chat', true, true);
    mergeBuiltinProfileUserAware(profiles, builtin, undefined);
    expect(profiles[0]?.label).toBe('User Local Label');
    expect(profiles[0]?.model).toBe('deepseek-chat-custom');
    expect(profiles[0]?.supportsTools).toBe(true);
    expect(profiles[0]?.isBuiltin).toBe(true);
  });

  it('get_model_profiles_drops_hidden_flag_for_new_builtin_model_without_history', async () => {
    const { store, settings } = makeStore();
    seedConfigs(settings, [], []);
    settings.save('hidden_builtin_model_profile_ids', '["builtin-gemini-3-flash"]');
    settings.save('builtin_model_profiles_snapshot', '[]');

    const profiles = await store.getModelProfiles();
    expect(
      profiles.some((profile) => profile.id === 'builtin-gemini-3-flash' && profile.model === 'gemini-3.5-flash'),
    ).toBe(true);
    const hidden = JSON.parse(settings.get('hidden_builtin_model_profile_ids') ?? '[]') as string[];
    expect(hidden).not.toContain('builtin-gemini-3-flash');
  });

  it('get_model_profiles_drops_hidden_flag_when_builtin_slot_points_to_new_model', async () => {
    const { store, settings } = makeStore();
    seedConfigs(settings, [], []);
    settings.save('hidden_builtin_model_profile_ids', '["builtin-gemini-3-flash"]');
    settings.save(
      'builtin_model_profiles_snapshot',
      JSON.stringify([
        profileFixture('builtin-gemini-3-flash', 'Gemini 3 Flash (均衡)', 'gemini-3-flash-preview', true, true),
      ]),
    );

    const profiles = await store.getModelProfiles();
    expect(
      profiles.some((profile) => profile.id === 'builtin-gemini-3-flash' && profile.model === 'gemini-3.5-flash'),
    ).toBe(true);
    const hidden = JSON.parse(settings.get('hidden_builtin_model_profile_ids') ?? '[]') as string[];
    expect(hidden).not.toContain('builtin-gemini-3-flash');
  });

  it('save_model_profiles_does_not_hide_new_builtin_models', async () => {
    const { store, settings } = makeStore();
    seedConfigs(settings, [], []);
    const known = profileFixture('builtin-gemini-3-pro', 'Gemini 3.1 Pro Preview (旗舰)', 'gemini-3.1-pro-preview', true, true);
    settings.save('builtin_model_profiles_snapshot', JSON.stringify([known]));

    await store.saveModelProfiles([known]);
    const hidden = JSON.parse(settings.get('hidden_builtin_model_profile_ids') ?? '[]') as string[];
    expect(hidden).not.toContain('builtin-gemini-3-flash');
  });

  it('save_model_profiles_does_not_hide_retargeted_builtin_slot', async () => {
    const { store, settings } = makeStore();
    seedConfigs(settings, [], []);
    settings.save(
      'builtin_model_profiles_snapshot',
      JSON.stringify([
        profileFixture('builtin-gemini-3-flash', 'Gemini 3 Flash (均衡)', 'gemini-3-flash-preview', true, true),
      ]),
    );
    const known = profileFixture('builtin-gemini-3-pro', 'Gemini 3.1 Pro Preview (旗舰)', 'gemini-3.1-pro-preview', true, true);

    await store.saveModelProfiles([known]);
    const hidden = JSON.parse(settings.get('hidden_builtin_model_profile_ids') ?? '[]') as string[];
    expect(hidden).not.toContain('builtin-gemini-3-flash');
  });

  it('model profile rows serialize like serde_json Vec<ModelProfile>: struct field order and f32 floats', async () => {
    const rustOrder = [
      'id', 'vendorId', 'label', 'model', 'providerScope', 'apiProtocol', 'modelAdapter',
      'isMultimodal', 'isReasoning', 'isEmbedding', 'isReranker', 'isImageGeneration',
      'supportsTools', 'supportsReasoning', 'status', 'enabled', 'maxOutputTokens', 'temperature',
      'reasoningEffort', 'reasoningMode', 'thinkingEnabled', 'thinkingBudget', 'includeThoughts',
      'enableThinking', 'minP', 'topK', 'geminiApiVersion', 'isBuiltin', 'repetitionPenalty',
      'reasoningSplit', 'effort', 'verbosity', 'isFavorite', 'maxTokensLimit', 'contextWindow', 'extraBody',
    ];
    const { store, settings } = makeStore();
    seedConfigs(settings, [], []);
    for (const profile of await store.getModelProfiles()) expect(Object.keys(profile)).toEqual(rustOrder);
    const snapshotText = settings.get('builtin_model_profiles_snapshot')!;
    const snapshot = JSON.parse(snapshotText) as Array<Record<string, unknown>>;
    expect(snapshot.length).toBeGreaterThan(0);
    for (const entry of snapshot) expect(Object.keys(entry)).toEqual(rustOrder);
    expect(snapshotText).toMatch(/"id":"builtin-gemini-3-flash"[^}]*"temperature":1\.0,/);

    const shuffled = Object.fromEntries(Object.entries({
      ...profileFixture('user-local', 'Local', 'local-model', false, false), temperature: 1, minP: 0.05, repetitionPenalty: 2,
    }).reverse()) as unknown as ModelProfile;
    await store.saveModelProfiles([shuffled]);
    const savedText = settings.get('model_profiles')!;
    expect(Object.keys((JSON.parse(savedText) as Array<Record<string, unknown>>)[0]!)).toEqual(rustOrder);
    expect(savedText).toContain('"temperature":1.0,');
    expect(savedText).toContain('"minP":0.05,');
    expect(savedText).toContain('"repetitionPenalty":2.0,');
    expect(savedText).toContain('"maxOutputTokens":');
    expect(savedText).not.toMatch(/"maxOutputTokens":\d+\.0/);
  });

  it('save_vendor_configs_returns_error_when_builtin_secret_clear_fails', async () => {
    const { store, settings } = makeStore();
    const vendor = { ...loadBuiltinVendors([]).find((item) => item.id === 'builtin-openai')!, apiKey: 'sk-test-openai' };
    await store.saveVendorConfigs([vendor]);
    expect(settings.secrets.get('builtin-openai.api_key')).toBe('sk-test-openai');

    settings.failDeleteSecret = true;
    await expect(store.saveVendorConfigs([{ ...vendor, apiKey: '' }])).rejects.toBeInstanceOf(ConfigError);
  });

  it('api_origins_match_compares_scheme_host_and_default_port', () => {
    expect(apiOriginsMatch('https://api.openai.com/v1', 'https://api.openai.com/v2')).toBe(true);
    expect(apiOriginsMatch('https://api.openai.com/v1', 'https://api.openai.com:443/v1')).toBe(true);
    expect(apiOriginsMatch('https://api.openai.com/v1', 'http://api.openai.com/v1')).toBe(false);
    expect(apiOriginsMatch('https://api.openai.com/v1', 'https://api.openai.com:8443/v1')).toBe(false);
  });

  it('model_assignments_defaults_fill_missing_keys', () => {
    const assignments = modelAssignmentsFromDe({ model2_config_id: 'cfg-1' });
    expect(assignments.model2_config_id).toBe('cfg-1');
    expect(assignments.translation_display_mode).toBeNull();
    expect(assignments.compaction_model_config_id).toBeNull();
  });

  it('request_adapter_id_follows_protocol_and_host_rules', () => {
    expect(
      requestAdapterIdForConfig({
        apiProtocol: 'anthropic_messages', providerType: 'custom', providerScope: null,
        supportsOpenaiResponses: null, modelAdapter: 'anthropic', baseUrl: 'https://x/v1', model: 'claude',
      }),
    ).toBe('anthropic');
    expect(
      requestAdapterIdForConfig({
        apiProtocol: null, providerType: 'qwen', providerScope: 'qwen',
        supportsOpenaiResponses: null, modelAdapter: 'general', baseUrl: 'https://dashscope/v1', model: 'qwen3',
      }),
    ).toBe('qwen');
    expect(
      requestAdapterIdForConfig({
        apiProtocol: null, providerType: 'custom', providerScope: 'custom',
        supportsOpenaiResponses: null, modelAdapter: 'qwen', baseUrl: 'https://proxy/v1', model: 'qwen3',
      }),
    ).toBe('general');
    expect(
      requestAdapterIdForConfig({
        apiProtocol: null, providerType: 'siliconflow', providerScope: 'siliconflow',
        supportsOpenaiResponses: null, modelAdapter: 'deepseek', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-v4',
      }),
    ).toBe('deepseek');
  });
});
