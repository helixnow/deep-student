import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '@/types';
import { filterOcrEngineCandidateApis } from '../OcrEngineCard';

function config(overrides: Partial<ApiConfig> & Pick<ApiConfig, 'id' | 'model'>): ApiConfig {
  return {
    name: overrides.model,
    apiKey: '***',
    baseUrl: 'https://api.example.com/v1',
    isMultimodal: true,
    isReasoning: false,
    isEmbedding: false,
    isReranker: false,
    enabled: true,
    modelAdapter: 'general',
    ...overrides,
  } as ApiConfig;
}

describe('filterOcrEngineCandidateApis', () => {
  it('keeps multimodal configs that are not engines yet', () => {
    const apis = [
      config({ id: 'openai-vlm', model: 'gpt-5.6' }),
      config({ id: 'text-only', model: 'deepseek-flash', isMultimodal: false }),
      config({ id: 'already-ocr', model: 'qwen-vl-max' }),
    ];

    const result = filterOcrEngineCandidateApis(apis, [{ configId: 'already-ocr' }]);
    expect(result.map((item) => item.id)).toEqual(['openai-vlm']);
  });

  it('never offers OpenCode Go as an OCR engine', () => {
    const apis = [
      config({ id: 'go-deepseek', model: 'deepseek-v4.1-flash', vendorId: 'builtin-opencode-go' }),
      config({ id: 'go-glm', model: 'glm-5.3', providerType: 'opencode_go' }),
      config({ id: 'go-by-url', model: 'kimi-k3', baseUrl: 'https://opencode.ai/inference/go/openai/v1' }),
      config({ id: 'zen-by-url', model: 'qwen3.8-max', baseUrl: 'https://opencode.ai/zen/go/v1' }),
      config({ id: 'openai-vlm', model: 'gpt-5.6' }),
    ];

    const result = filterOcrEngineCandidateApis(apis, []);
    expect(result.map((item) => item.id)).toEqual(['openai-vlm']);
  });
});
