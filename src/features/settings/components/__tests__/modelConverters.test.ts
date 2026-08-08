import { describe, expect, it } from 'vitest';
import {
  convertApiConfigToProfile,
  convertProfileToApiConfig,
  getAllowedApiProtocolsForModelAdapter,
  inferProviderTypeFromBaseUrl,
  normalizeApiProtocolForModelAdapter,
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

  it('keeps DeepSeek V4 semantics while rejecting an unsupported responses protocol', () => {
    const api: ApiConfig = {
      ...convertProfileToApiConfig(baseProfile, baseVendor),
      modelAdapter: 'openai',
      apiProtocol: 'openai_responses',
    };

    const profile = convertApiConfigToProfile(api, baseVendor.id);

    expect(profile.modelAdapter).toBe('deepseek');
    expect(profile.apiProtocol).toBe('openai_chat_completions');
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

  it('only exposes and preserves responses after a custom vendor declares support', () => {
    const unsupportedOptions = {
      providerType: 'custom',
      baseUrl: 'https://proxy.example.com/v1',
      supportsOpenAIResponses: false,
    };

    expect(getAllowedApiProtocolsForModelAdapter('general', unsupportedOptions)).toEqual([
      'openai_chat_completions',
    ]);
    expect(
      normalizeApiProtocolForModelAdapter(
        'openai_responses',
        'general',
        unsupportedOptions.providerType,
        unsupportedOptions
      )
    ).toBe('openai_chat_completions');

    const supportedOptions = { ...unsupportedOptions, supportsOpenAIResponses: true };
    expect(getAllowedApiProtocolsForModelAdapter('general', supportedOptions)).toContain(
      'openai_responses'
    );
    expect(
      normalizeApiProtocolForModelAdapter(
        'openai_responses',
        'general',
        supportedOptions.providerType,
        supportedOptions
      )
    ).toBe('openai_responses');
  });

  it('makes native adapter protocols provider-aware', () => {
    expect(
      getAllowedApiProtocolsForModelAdapter('anthropic', {
        providerType: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
      })
    ).toEqual(['anthropic_messages']);
    expect(
      getAllowedApiProtocolsForModelAdapter('google', {
        providerType: 'gemini',
        baseUrl: 'https://generativelanguage.googleapis.com',
      })
    ).toEqual(['google_generate_content']);

    for (const adapter of ['anthropic', 'google']) {
      expect(
        getAllowedApiProtocolsForModelAdapter(adapter, {
          providerType: 'custom',
          baseUrl: 'https://one-api.example.com/v1',
        })
      ).toEqual(['openai_chat_completions']);
      expect(
        getAllowedApiProtocolsForModelAdapter(adapter, {
          providerType: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          supportsOpenAIResponses: true,
        })
      ).toEqual(['openai_chat_completions', 'openai_responses']);
    }
  });

  it('round-trips proxied Claude and Gemini profiles through OpenAI protocols', () => {
    const cases = [
      {
        providerType: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        adapter: 'anthropic' as const,
        model: 'anthropic/claude-sonnet-4.6',
      },
      {
        providerType: 'custom',
        baseUrl: 'https://one-api.example.com/v1',
        adapter: 'google' as const,
        model: 'google/gemini-3.1-pro-preview',
      },
    ];

    for (const item of cases) {
      const vendor: VendorConfig = {
        ...baseVendor,
        id: `vendor-${item.providerType}-${item.adapter}`,
        providerType: item.providerType,
        baseUrl: item.baseUrl,
        apiProtocol: undefined,
      };
      const profile: ModelProfile = {
        ...baseProfile,
        id: `profile-${item.adapter}`,
        vendorId: vendor.id,
        model: item.model,
        providerScope: item.providerType,
        modelAdapter: item.adapter,
        apiProtocol: undefined,
      };

      const api = convertProfileToApiConfig(profile, vendor);
      expect(api.apiProtocol).toBe('openai_chat_completions');
      expect(api.modelAdapter).toBe(item.adapter);

      const roundTripped = convertApiConfigToProfile(api, vendor.id);
      expect(roundTripped.apiProtocol).toBe('openai_chat_completions');
      expect(roundTripped.modelAdapter).toBe(item.adapter);
    }
  });

  it('preserves explicitly supported Responses for proxied native model families', () => {
    for (const adapter of ['anthropic', 'google'] as const) {
      const vendor: VendorConfig = {
        ...baseVendor,
        id: `vendor-responses-${adapter}`,
        providerType: 'custom',
        baseUrl: 'https://sub2api.example.com/v1',
        supportsOpenAIResponses: true,
      };
      const profile: ModelProfile = {
        ...baseProfile,
        vendorId: vendor.id,
        model: adapter === 'anthropic' ? 'claude-sonnet-4-6' : 'gemini-3.1-pro-preview',
        providerScope: 'custom',
        modelAdapter: adapter,
        apiProtocol: 'openai_responses',
      };

      const api = convertProfileToApiConfig(profile, vendor);
      expect(api.apiProtocol).toBe('openai_responses');
      expect(convertApiConfigToProfile(api, vendor.id).apiProtocol).toBe('openai_responses');
    }
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

  it('defaults official DeepSeek V4-Flash models to Responses (2026-08 V4-Flash GA)', () => {
    for (const model of ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner']) {
      const profile: ModelProfile = { ...baseProfile, model };

      const api = convertProfileToApiConfig(profile, baseVendor);

      expect(api.apiProtocol, model).toBe('openai_responses');
    }

    // legacy 别名映射到 flash：显式 responses 也能保留
    const flashProfile: ModelProfile = {
      ...baseProfile,
      model: 'deepseek-v4-flash',
      apiProtocol: 'openai_responses',
    };
    const flashApi = convertProfileToApiConfig(flashProfile, baseVendor);
    expect(flashApi.apiProtocol).toBe('openai_responses');
  });

  it('keeps official DeepSeek V4-Pro and V3.x on chat completions even when responses is requested', () => {
    for (const model of ['deepseek-v4-pro', 'deepseek-v3.2', 'deepseek-v3.1']) {
      const profile: ModelProfile = {
        ...baseProfile,
        model,
        apiProtocol: 'openai_responses',
      };

      const api = convertProfileToApiConfig(profile, baseVendor);
      expect(api.apiProtocol, model).toBe('openai_chat_completions');

      const roundTripped = convertApiConfigToProfile(api, baseVendor.id);
      expect(roundTripped.apiProtocol, model).toBe('openai_chat_completions');
    }

    // 协议可选项：flash 解锁 responses，pro 不可选
    const flashAllowed = getAllowedApiProtocolsForModelAdapter('deepseek', {
      providerType: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
    });
    expect(flashAllowed).toContain('openai_responses');

    const proAllowed = getAllowedApiProtocolsForModelAdapter('deepseek', {
      providerType: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-pro',
    });
    expect(proAllowed).not.toContain('openai_responses');
    expect(proAllowed).toContain('openai_chat_completions');

    // 空模型（供应商级上下文）不降级
    const vendorLevel = getAllowedApiProtocolsForModelAdapter('deepseek', {
      providerType: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(vendorLevel).toContain('openai_responses');
  });
});

describe('settings modelConverters Qwen provider support', () => {
  it('detects DashScope and Alibaba Cloud Model Studio workspace hosts', () => {
    expect(inferProviderTypeFromBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('qwen');
    expect(inferProviderTypeFromBaseUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1')).toBe('qwen');
    expect(inferProviderTypeFromBaseUrl('https://workspace-id.maas.aliyuncs.com/v1')).toBe('qwen');
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
