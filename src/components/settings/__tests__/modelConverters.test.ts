import { describe, expect, it } from 'vitest';
import { convertApiConfigToProfile, convertProfileToApiConfig } from '../modelConverters';
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
});
