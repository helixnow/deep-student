import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../api.ts';
import { findReasoningLevelProfile, mapReasoningLevelForConfig } from '../src/reasoning_level_map.ts';

function config(model: string, effort: string): ApiConfig {
  return {
    id: 'test', name: 'test', vendorId: null, vendorName: null,
    providerType: 'openai', providerScope: null, authMode: null, apiProtocol: null,
    supportsOpenaiResponses: null, apiKey: 'k', baseUrl: 'https://api.openai.com/v1',
    model, isMultimodal: false, isReasoning: true, isEmbedding: false, isReranker: false,
    isImageGeneration: false, enabled: true, modelAdapter: 'general', maxOutputTokens: 1024,
    temperature: 0.7, supportsTools: false, geminiApiVersion: 'v1beta', isBuiltin: false,
    isReadOnly: false, reasoningEffort: effort, reasoningMode: null, thinkingEnabled: true,
    thinkingBudget: null, includeThoughts: false, minP: null, topK: null, enableThinking: null,
    supportsReasoning: true, headers: null, topPOverride: null, frequencyPenaltyOverride: null,
    presencePenaltyOverride: null, repetitionPenalty: null, reasoningSplit: null, effort: null,
    verbosity: null, isFavorite: false, maxTokensLimit: null, contextWindow: null,
    extraBody: null, resolvedAdapterId: null,
  };
}

describe('reasoning_level_map.rs', () => {
  it('contains_match_requires_version_boundary', () => {
    expect(findReasoningLevelProfile(config('gpt-6-sol', 'max'))).not.toBeNull();
    expect(findReasoningLevelProfile(config('relay-gpt-6', 'max'))).not.toBeNull();
    const gpt60 = findReasoningLevelProfile(config('gpt-60', 'max'));
    expect(gpt60?.modelContains.includes('gpt-6') ?? false).toBe(false);
  });

  it('gpt6_max_snaps_to_xhigh_on_chat_completions', () => {
    const cfg = config('gpt-6-sol', 'max');
    cfg.apiProtocol = 'openai_chat_completions';
    const mapped = mapReasoningLevelForConfig(cfg);
    expect(mapped).not.toBeNull();
    expect(mapped?.reasoningEffort).toBe('xhigh');
  });

  it('gpt6_max_passes_through_on_default_responses_route', () => {
    expect(mapReasoningLevelForConfig(config('gpt-6-sol', 'max'))).toBeNull();
  });

  it('custom_relay_keeps_all_five_levels', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const cfg = config('some-relay-gpt-6-sol', level);
      cfg.providerType = 'custom';
      cfg.baseUrl = 'https://relay.example.com/v1';
      expect(mapReasoningLevelForConfig(cfg), level).toBeNull();
    }
  });

  it('gpt55_max_snaps_to_xhigh', () => {
    const mapped = mapReasoningLevelForConfig(config('gpt-5.5', 'max'));
    expect(mapped).not.toBeNull();
    expect(mapped?.reasoningEffort).toBe('xhigh');
  });

  it('gpt51_xhigh_snaps_to_high', () => {
    const mapped = mapReasoningLevelForConfig(config('gpt-5.1', 'xhigh'));
    expect(mapped).not.toBeNull();
    expect(mapped?.reasoningEffort).toBe('high');
  });

  it('gemini3_pro_medium_stays_and_xhigh_snaps', () => {
    const cfg = config('gemini-3.1-pro-preview', 'low');
    cfg.providerType = 'google';
    cfg.modelAdapter = 'google';
    cfg.baseUrl = 'https://generativelanguage.googleapis.com';
    expect(mapReasoningLevelForConfig(cfg)).toBeNull();

    cfg.reasoningEffort = 'xhigh';
    const mapped = mapReasoningLevelForConfig(cfg);
    expect(mapped).not.toBeNull();
    expect(mapped?.reasoningEffort).toBe('high');
  });

  it('glm53_medium_snaps_to_high', () => {
    const cfg = config('glm-5.3', 'medium');
    cfg.providerType = 'zhipu';
    cfg.modelAdapter = 'zhipu';
    cfg.baseUrl = 'https://open.bigmodel.cn/api/paas/v4';
    const mapped = mapReasoningLevelForConfig(cfg);
    expect(mapped).not.toBeNull();
    expect(mapped?.reasoningEffort).toBe('high');
  });

  it('kimi_k3_medium_snaps_to_high', () => {
    const cfg = config('kimi-k3', 'medium');
    cfg.providerType = 'moonshot';
    cfg.modelAdapter = 'moonshot';
    cfg.baseUrl = 'https://api.moonshot.cn/v1';
    const mapped = mapReasoningLevelForConfig(cfg);
    expect(mapped).not.toBeNull();
    expect(mapped?.reasoningEffort).toBe('high');
  });

  it('non_standard_vendor_words_are_left_to_adapters', () => {
    for (const word of ['auto', 'adaptive', 'enabled', 'ultra']) {
      expect(mapReasoningLevelForConfig(config('gpt-6-sol', word)), word).toBeNull();
    }
  });

  it('none_and_unset_are_not_touched', () => {
    for (const word of ['none', 'unset']) {
      expect(mapReasoningLevelForConfig(config('gpt-6-sol', word)), word).toBeNull();
    }
  });

  it('mapping_only_touches_effort_field', () => {
    const original = config('gpt-6-sol', 'max');
    original.apiProtocol = 'openai_chat_completions';
    const mapped = mapReasoningLevelForConfig(original);
    expect(mapped).not.toBeNull();
    expect(mapped?.reasoningEffort).toBe('xhigh');
    expect(mapped?.thinkingBudget).toBe(original.thinkingBudget);
    expect(mapped?.enableThinking).toBe(original.enableThinking);
    expect(mapped?.thinkingEnabled).toBe(original.thinkingEnabled);
    expect(mapped?.isReasoning).toBe(original.isReasoning);
    expect(mapped?.supportsReasoning).toBe(original.supportsReasoning);
    expect(mapped?.verbosity).toBe(original.verbosity);
    expect(mapped?.extraBody).toBe(original.extraBody);
    expect(mapped?.temperature).toBe(original.temperature);
    expect(mapped?.apiProtocol).toBe(original.apiProtocol);
  });

  it('deepseek_xhigh_uses_official_alias_not_nearest_snap', () => {
    const cfg = config('deepseek-v4-pro', 'xhigh');
    cfg.providerType = 'deepseek';
    cfg.modelAdapter = 'deepseek';
    cfg.baseUrl = 'https://api.deepseek.com/v1';
    const mapped = mapReasoningLevelForConfig(cfg);
    expect(mapped).not.toBeNull();
    expect(mapped?.reasoningEffort).toBe('high');
  });

  it('deepseek_medium_maps_to_high_per_official_table', () => {
    const cfg = config('deepseek-v4-pro', 'medium');
    cfg.providerType = 'deepseek';
    cfg.modelAdapter = 'deepseek';
    cfg.baseUrl = 'https://api.deepseek.com/v1';
    const mapped = mapReasoningLevelForConfig(cfg);
    expect(mapped).not.toBeNull();
    expect(mapped?.reasoningEffort).toBe('high');
  });

  it('deepseek_low_and_max_pass_through', () => {
    for (const level of ['low', 'max']) {
      const cfg = config('deepseek-v4-pro', level);
      cfg.providerType = 'deepseek';
      cfg.modelAdapter = 'deepseek';
      cfg.baseUrl = 'https://api.deepseek.com/v1';
      expect(mapReasoningLevelForConfig(cfg), level).toBeNull();
    }
  });

  it('unknown_model_on_official_host_is_left_untouched', () => {
    expect(mapReasoningLevelForConfig(config('totally-unknown-model', 'max'))).toBeNull();
  });
});
