import { describe, expect, it } from 'vitest';
import {
  looksLikeMultimodalEmbedding, resolveCapabilityOverrides,
} from '../src/capabilities.ts';
import { inferCapabilityOverridesFromRegistry } from '../src/mod_compat.ts';

describe('llm_manager/mod.rs', () => {
  it('vl_embedding_names_are_treated_as_multimodal', () => {
    expect(looksLikeMultimodalEmbedding('Qwen/Qwen3-VL-Embedding-8B')).toBe(true);
    expect(looksLikeMultimodalEmbedding('jina-clip-v2')).toBe(true);
    expect(looksLikeMultimodalEmbedding('BAAI/bge-m3')).toBe(false);
    expect(looksLikeMultimodalEmbedding('text-embedding-3-large')).toBe(false);
  });

  it('registry_inference_matches_siliconflow_glm_46v', () => {
    const inferred = inferCapabilityOverridesFromRegistry('zai-org/GLM-4.6V', 'siliconflow');
    expect(inferred).not.toBeNull();
    if (inferred === null) throw new Error('registry should infer GLM-4.6V capabilities');

    expect(inferred.isMultimodal).toBe(true);
    expect(inferred.supportsTools).toBe(true);
    expect(inferred.supportsReasoning).toBe(false);
  });

  it('registry_inference_matches_base_glm_46_without_scope', () => {
    const inferred = inferCapabilityOverridesFromRegistry('glm-4.6', 'zhipu');
    expect(inferred).not.toBeNull();
    if (inferred === null) throw new Error('registry should infer GLM-4.6 capabilities');

    expect(inferred.isMultimodal).toBe(false);
    expect(inferred.supportsTools).toBe(true);
    expect(inferred.supportsReasoning).toBe(true);
  });

  it('builtin_catalog_inference_covers_missing_builtin_tool_models', () => {
    const cases: Array<[string, string | null]> = [
      ['qwen3-max', 'qwen'],
      ['qwen-plus', 'qwen'],
      ['qwq-plus', 'qwen'],
      ['glm-5', 'zhipu'],
      ['kimi-k2.6', 'moonshot'],
      ['MiniMax-M2.5', 'minimax'],
      ['doubao-seed-2-0-pro-260215', 'doubao'],
      ['gpt-5-mini', 'openai'],
      ['o3-mini', 'openai'],
      ['gemini-3.5-flash', 'gemini'],
    ];

    for (const [model, scope] of cases) {
      const inferred = resolveCapabilityOverrides(model, scope);
      expect(
        inferred.supportsTools,
        `expected builtin catalog tool support for model ${model} / ${String(scope)}`,
      ).toBe(true);
    }
  });
});
