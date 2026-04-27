import { describe, expect, it } from 'vitest';
import {
  convertApiConfigToProfile,
  convertProfileToApiConfig,
  inferProviderTypeFromBaseUrl,
} from '../modelConverters';
import type { ApiConfig, ModelProfile, VendorConfig } from '../../../types';

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
    };

    const profile = convertApiConfigToProfile(api, baseVendor.id);

    expect(profile.modelAdapter).toBe('deepseek');
    expect(profile.providerScope).toBe('deepseek');
    expect(profile.reasoningEffort).toBe('high');
    expect(profile.supportsReasoning).toBe(true);
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
