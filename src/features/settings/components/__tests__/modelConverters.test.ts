import { describe, expect, it } from 'vitest';
import {
  convertApiConfigToProfile,
  convertProfileToApiConfig,
  inferProviderTypeFromBaseUrl,
} from '../modelConverters';
import type { ApiConfig, ModelProfile, VendorConfig } from '@/types';

const baseVendor: VendorConfig = {
  id: 'vendor-1',
  name: 'DeepSeek',
  providerType: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
};

const baseProfile: ModelProfile = {
  id: 'profile-1',
  vendorId: 'vendor-1',
  label: 'DeepSeek V4 Pro',
  model: 'deepseek-v4-pro',
  providerScope: 'deepseek',
  modelAdapter: 'openai',
  status: 'enabled',
  enabled: true,
  isMultimodal: false,
  isReasoning: true,
  isEmbedding: false,
  isReranker: false,
  supportsTools: true,
  supportsReasoning: true,
  maxOutputTokens: 8192,
  temperature: 0.6,
  reasoningEffort: 'high',
  thinkingEnabled: true,
  includeThoughts: true,
};

describe('settings modelConverters DeepSeek adapter normalization', () => {
  it('normalizes legacy official DeepSeek profiles from openai adapter to deepseek', () => {
    const api = convertProfileToApiConfig(baseProfile, baseVendor);

    expect(api.modelAdapter).toBe('deepseek');
    expect(api.apiProtocol).toBe('openai_chat_completions');
    expect(api.providerScope).toBe('deepseek');
    expect(api.reasoningEffort).toBe('high');
    expect(api.supportsReasoning).toBe(true);
  });

  it('normalizes SiliconFlow-hosted DeepSeek models to the shared DeepSeek adapter', () => {
    const siliconFlowVendor: VendorConfig = {
      ...baseVendor,
      name: 'SiliconFlow',
      providerType: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1',
    };
    const profile: ModelProfile = {
      ...baseProfile,
      model: 'deepseek-ai/DeepSeek-V3.2',
      providerScope: 'siliconflow',
      modelAdapter: 'general',
      reasoningEffort: undefined,
      thinkingBudget: 8192,
    };

    const api = convertProfileToApiConfig(profile, siliconFlowVendor);

    expect(api.providerType).toBe('siliconflow');
    expect(api.providerScope).toBe('siliconflow');
    expect(api.modelAdapter).toBe('deepseek');
    expect(api.thinkingBudget).toBe(8192);
    expect(api.reasoningEffort).toBeUndefined();
  });

  it('preserves DeepSeek V4 profile semantics when converting back from api config', () => {
    const api: ApiConfig = {
      ...convertProfileToApiConfig(baseProfile, baseVendor),
      modelAdapter: 'openai',
      apiProtocol: 'openai_responses',
    };

    const profile = convertApiConfigToProfile(api, baseVendor.id);

    expect(profile.modelAdapter).toBe('deepseek');
    expect(profile.apiProtocol).toBe('openai_responses');
    expect(profile.providerScope).toBe('deepseek');
    expect(profile.reasoningEffort).toBe('high');
    expect(profile.supportsReasoning).toBe(true);
  });

  it('inherits explicit vendor api protocol into runtime api config', () => {
    const responsesVendor: VendorConfig = {
      ...baseVendor,
      providerType: 'openai',
      apiProtocol: 'openai_responses',
      baseUrl: 'https://api.openai.com/v1',
    };
    const profile: ModelProfile = {
      ...baseProfile,
      vendorId: responsesVendor.id,
      model: 'gpt-5.2',
      modelAdapter: 'general',
      providerScope: 'openai',
      apiProtocol: undefined,
    };

    const api = convertProfileToApiConfig(profile, responsesVendor);

    expect(api.apiProtocol).toBe('openai_responses');
  });

  it('defaults official OpenAI vendors to responses when protocol is absent', () => {
    const openAiVendor: VendorConfig = {
      ...baseVendor,
      providerType: 'openai',
      apiProtocol: undefined,
      baseUrl: 'https://api.openai.com/v1',
    };
    const profile: ModelProfile = {
      ...baseProfile,
      vendorId: openAiVendor.id,
      model: 'gpt-4o-mini',
      modelAdapter: 'general',
      providerScope: 'openai',
      apiProtocol: undefined,
    };

    const api = convertProfileToApiConfig(profile, openAiVendor);

    expect(api.apiProtocol).toBe('openai_responses');
  });

  it('defaults third-party vendors with declared responses support to responses when protocol is absent', () => {
    const proxyVendor: VendorConfig = {
      ...baseVendor,
      id: 'vendor-proxy',
      name: 'ProxyAI',
      providerType: 'custom',
      apiProtocol: undefined,
      supportsOpenAIResponses: true,
      baseUrl: 'https://proxy.example.com/v1',
    };
    const profile: ModelProfile = {
      ...baseProfile,
      vendorId: proxyVendor.id,
      model: 'gpt-4o-mini',
      modelAdapter: 'general',
      providerScope: 'custom',
      apiProtocol: undefined,
    };

    const api = convertProfileToApiConfig(profile, proxyVendor);

    expect(api.apiProtocol).toBe('openai_responses');
  });

  it('defaults official openai-compatible configs to responses when protocol is absent', () => {
    const openAiVendor: VendorConfig = {
      ...baseVendor,
      providerType: 'openai',
      apiProtocol: undefined,
      baseUrl: 'https://api.openai.com/v1',
    };
    const profile: ModelProfile = {
      ...baseProfile,
      vendorId: openAiVendor.id,
      model: 'gpt-4o-mini',
      modelAdapter: 'general',
      providerScope: 'openai',
      apiProtocol: undefined,
    };

    const api = convertProfileToApiConfig(profile, openAiVendor);

    expect(api.apiProtocol).toBe('openai_responses');
  });

  it('keeps generic third-party openai-compatible vendors on chat completions by default without responses support', () => {
    const proxyVendor: VendorConfig = {
      ...baseVendor,
      id: 'vendor-generic-proxy',
      name: 'Generic Proxy',
      providerType: 'custom',
      apiProtocol: undefined,
      baseUrl: 'https://proxy.example.com/v1',
    };
    const profile: ModelProfile = {
      ...baseProfile,
      vendorId: proxyVendor.id,
      model: 'gpt-4o-mini',
      modelAdapter: 'general',
      providerScope: 'custom',
      apiProtocol: undefined,
    };

    const api = convertProfileToApiConfig(profile, proxyVendor);

    expect(api.apiProtocol).toBe('openai_chat_completions');
  });

  it('round-trips DeepSeek context window metadata through model profile conversion', () => {
    const profileWithContext = {
      ...baseProfile,
      contextWindow: 1_000_000,
    } as ModelProfile & { contextWindow?: number };

    const api = convertProfileToApiConfig(profileWithContext, baseVendor);
    expect(api.contextWindow).toBe(1_000_000);

    const profile = convertApiConfigToProfile(api, baseVendor.id) as ModelProfile & { contextWindow?: number };
    expect(profile.contextWindow).toBe(1_000_000);
  });
});

describe('settings modelConverters NVIDIA provider support', () => {
  it('detects NVIDIA integrate API hosts as the nvidia provider type', () => {
    expect(inferProviderTypeFromBaseUrl('https://integrate.api.nvidia.com')).toBe('nvidia');
    expect(inferProviderTypeFromBaseUrl('https://integrate.api.nvidia.com/v1')).toBe('nvidia');
  });

  it('keeps NVIDIA-hosted DeepSeek models on the generic OpenAI-compatible adapter', () => {
    const nvidiaVendor: VendorConfig = {
      ...baseVendor,
      id: 'builtin-nvidia',
      name: 'NVIDIA',
      providerType: 'nvidia',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
    };
    const profile: ModelProfile = {
      ...baseProfile,
      vendorId: 'builtin-nvidia',
      label: 'NVIDIA - DeepSeek V4 Flash',
      model: 'deepseek-ai/deepseek-v4-flash',
      providerScope: 'nvidia',
      modelAdapter: 'general',
      reasoningEffort: undefined,
      thinkingBudget: undefined,
      enableThinking: false,
      thinkingEnabled: false,
      includeThoughts: false,
    };

    const api = convertProfileToApiConfig(profile, nvidiaVendor);

    expect(api.providerType).toBe('nvidia');
    expect(api.providerScope).toBe('nvidia');
    expect(api.modelAdapter).toBe('general');
    expect(api.reasoningEffort).toBeUndefined();
    expect(api.thinkingBudget).toBeUndefined();
  });
});

describe('settings modelConverters Xiaomi MiMo provider support', () => {
  it('detects Xiaomi MiMo API hosts as the mimo provider type', () => {
    expect(inferProviderTypeFromBaseUrl('https://api.xiaomimimo.com/v1')).toBe('mimo');
    expect(inferProviderTypeFromBaseUrl('https://token-plan-cn.xiaomimimo.com/v1')).toBe('mimo');
    expect(inferProviderTypeFromBaseUrl('https://token-plan-sgp.xiaomimimo.com/v1')).toBe('mimo');
    expect(inferProviderTypeFromBaseUrl('https://token-plan-ams.xiaomimimo.com/v1')).toBe('mimo');
  });

  it('round-trips MiMo models through the dedicated adapter path', () => {
    const mimoVendor: VendorConfig = {
      ...baseVendor,
      id: 'builtin-mimo',
      name: 'Xiaomi MiMo',
      providerType: 'mimo',
      baseUrl: 'https://api.xiaomimimo.com/v1',
    };
    const profile: ModelProfile = {
      ...baseProfile,
      vendorId: 'builtin-mimo',
      label: 'MiMo V2.5 Pro',
      model: 'mimo-v2.5-pro',
      providerScope: 'mimo',
      modelAdapter: 'mimo' as ModelProfile['modelAdapter'],
      reasoningEffort: undefined,
      thinkingBudget: undefined,
      enableThinking: true,
      thinkingEnabled: true,
      includeThoughts: true,
    };

    const api = convertProfileToApiConfig(profile, mimoVendor);
    expect(api.providerType).toBe('mimo');
    expect(api.providerScope).toBe('mimo');
    expect(api.modelAdapter).toBe('mimo');
    expect(api.enableThinking).toBe(true);

    const roundTripped = convertApiConfigToProfile(api, mimoVendor.id);
    expect(roundTripped.modelAdapter).toBe('mimo');
    expect(roundTripped.providerScope).toBe('mimo');
    expect(roundTripped.includeThoughts).toBe(true);
  });
});
