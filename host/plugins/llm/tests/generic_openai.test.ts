import { describe, expect, it } from 'vitest';
import { GenericOpenAIAdapter } from '../src/adapters/generic_openai.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new GenericOpenAIAdapter();

describe('generic_openai.rs', () => {
  const createTestConfig = (supportsReasoning: boolean, isReasoning: boolean) =>
    makeConfig({
      supportsReasoning, isReasoning, thinkingEnabled: true, thinkingBudget: 4096,
      includeThoughts: true,
    });

  it('test_apply_reasoning_config_with_reasoning', () => {
    const body: Body = { temperature: 0.7 };
    adapter.applyReasoningConfig(body, createTestConfig(true, false), null);
    expect(body.reasoning_effort).toBe('medium');
    expect(body.enable_thinking).toBeUndefined();
    expect(body.thinking_budget).toBeUndefined();
    expect(body.include_thoughts).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it('test_remove_sampling_params_for_reasoning_model', () => {
    const body: Body = { temperature: 0.7, top_p: 0.9 };
    adapter.applyReasoningConfig(body, createTestConfig(false, true), null);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('test_xhigh_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'xhigh' }), null);
    expect(body.reasoning_effort).toBe('xhigh');
    expect(body.reasoning).toBeUndefined();
  });

  it('test_gpt56_pro_mode_is_responses_only', () => {
    const config = makeConfig({
      providerType: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.6-sol',
      apiProtocol: 'openai_responses', reasoningEffort: 'high', reasoningMode: 'pro',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect((body.reasoning as Body).mode).toBe('pro');

    config.apiProtocol = 'openai_chat_completions';
    const chatBody: Body = {};
    adapter.applyReasoningConfig(chatBody, config, null);
    expect(chatBody.reasoning).toBeUndefined();
  });

  it('test_provider_aliases_normalize_to_standard_effort', () => {
    for (const [input, expected] of [
      ['disabled', 'none'], ['enabled', 'medium'], ['adaptive', 'medium'],
      ['auto', 'medium'], ['max', 'xhigh'],
    ]) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: input }), null);
      expect(body.reasoning_effort, input).toBe(expected);
    }
  });

  it('test_gpt56_preserves_max_reasoning_effort', () => {
    for (const model of [
      'gpt-5.6', 'gpt-5.6-sol', 'openai/gpt-5.6', 'GPT-5.6-Terra',
      'gpt-6', 'gpt-6-luna', 'gpt-6.1', 'openai/gpt-6',
    ]) {
      const body: Body = { temperature: 0.7 };
      adapter.applyReasoningConfig(body, makeConfig({ model, reasoningEffort: 'max' }), null);
      expect(body.reasoning_effort, model).toBe('max');
      expect(body.temperature, model).toBeUndefined();
    }
  });

  it('test_gpt56_openrouter_nested_dialect_preserves_max', () => {
    const config = makeConfig({
      providerType: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-5.6', reasoningEffort: 'max',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect((body.reasoning as Body).effort).toBe('max');
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_gpt6_openrouter_nested_dialect_preserves_max', () => {
    const config = makeConfig({
      providerType: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',
      model: 'openai/gpt-6.1', reasoningEffort: 'max',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect((body.reasoning as Body).effort).toBe('max');
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_non_gpt56_models_still_normalize_max_to_xhigh', () => {
    for (const model of ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.60', 'gpt-60', 'not-gpt-6-preview', 'o3']) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({ model, reasoningEffort: 'max' }), null);
      expect(body.reasoning_effort, model).toBe('xhigh');
    }
  });

  it('test_gpt56_non_max_efforts_keep_standard_normalization', () => {
    for (const [input, expected] of [['xhigh', 'xhigh'], ['adaptive', 'medium'], ['high', 'high']]) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({ model: 'gpt-5.6', reasoningEffort: input }), null);
      expect(body.reasoning_effort, input).toBe(expected);
    }
  });

  it('test_toggle_and_budget_only_use_standard_effort', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, thinkingBudget: 20000, includeThoughts: true,
    });
    const body: Body = { enable_thinking: true, thinking_budget: 20000 };
    adapter.applyReasoningConfig(body, config, null);
    expect(body.reasoning_effort).toBe('xhigh');
    expect(body.enable_thinking).toBeUndefined();
    expect(body.thinking_budget).toBeUndefined();
    expect(body.include_thoughts).toBeUndefined();
  });

  it('test_openrouter_chat_uses_nested_reasoning_effort_and_preserves_options', () => {
    const config = makeConfig({
      providerType: 'custom', baseUrl: 'https://openrouter.ai/api/v1', reasoningEffort: 'high',
    });
    const body: Body = {
      reasoning_effort: 'low', reasoning: { max_tokens: 4096, enabled: false, exclude: true },
    };
    adapter.applyReasoningConfig(body, config, null);
    expect((body.reasoning as Body).effort).toBe('high');
    expect((body.reasoning as Body).exclude).toBe(true);
    expect((body.reasoning as Body).max_tokens).toBeUndefined();
    expect((body.reasoning as Body).enabled).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_openrouter_chat_none_keeps_sampling_and_uses_nested_reasoning', () => {
    const config = makeConfig({
      providerScope: 'openrouter', baseUrl: 'https://proxy.example.com/v1',
      reasoningEffort: 'none', supportsReasoning: true, isReasoning: true,
    });
    const body: Body = { temperature: 0.7, top_p: 0.9 };
    adapter.applyReasoningConfig(body, config, null);
    expect((body.reasoning as Body).effort).toBe('none');
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_openrouter_lookalike_host_keeps_generic_top_level_dialect', () => {
    const config = makeConfig({
      providerType: 'custom', baseUrl: 'https://openrouter.ai.evil.example/v1', reasoningEffort: 'high',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.reasoning_effort).toBe('high');
    expect(body.reasoning).toBeUndefined();
  });

  it('test_gemini_dynamic_and_zero_budgets_keep_distinct_semantics', () => {
    for (const [budget, expectedEffort, removesSampling] of [
      [-1, 'medium', true], [0, 'none', false],
    ] as const) {
      const config = makeConfig({
        supportsReasoning: true, thinkingEnabled: true, thinkingBudget: budget,
      });
      const body: Body = { temperature: 0.7 };
      expect(adapter.shouldRemoveSamplingParams(config), `budget=${budget}`).toBe(removesSampling);
      adapter.applyReasoningConfig(body, config, null);
      expect(body.reasoning_effort, `budget=${budget}`).toBe(expectedEffort);
      expect(body.temperature === 0.7, `budget=${budget}`).toBe(!removesSampling);
    }
  });

  it('test_legacy_anthropic_effort_is_normalized_without_leaking_effort', () => {
    const config = makeConfig({ effort: 'max' });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    adapter.applyCommonParams(body, config);
    expect(body.reasoning_effort).toBe('xhigh');
    expect(body.effort).toBeUndefined();
  });

  it('test_verbosity_parameter', () => {
    const config = makeConfig({ reasoningEffort: 'high', verbosity: 'high' });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.verbosity).toBe('high');
    expect(body.text).toBeUndefined();
  });

  it('test_temperature_removed_when_reasoning_medium', () => {
    const config = makeConfig({ reasoningEffort: 'medium' });
    const body: Body = { temperature: 0.7, top_p: 0.9 };
    adapter.applyReasoningConfig(body, config, null);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
  });

  it('test_temperature_kept_when_reasoning_none', () => {
    const config = makeConfig({ reasoningEffort: 'none' });
    const body: Body = { temperature: 0.7 };
    adapter.applyReasoningConfig(body, config, null);
    expect(body.temperature).toBe(0.7);
    expect(body.reasoning_effort).toBe('none');
  });

  it('test_temperature_kept_when_reasoning_none_even_if_is_reasoning_true', () => {
    const config = makeConfig({ reasoningEffort: 'none', isReasoning: true, supportsReasoning: true });
    const body: Body = { temperature: 0.7, top_p: 0.9 };
    adapter.applyReasoningConfig(body, config, null);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
  });

  it('test_toggle_off_keeps_sampling_and_sends_standard_none', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, enableThinking: false,
    });
    const body: Body = { temperature: 0.7, top_p: 0.9 };
    expect(adapter.shouldRemoveSamplingParams(config)).toBe(false);
    adapter.applyReasoningConfig(body, config, null);
    expect(body.reasoning_effort).toBe('none');
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
  });

  it('test_temperature_removed_when_reasoning_high_and_is_reasoning_true', () => {
    const config = makeConfig({ reasoningEffort: 'high', isReasoning: true, supportsReasoning: true });
    const body: Body = { temperature: 0.7 };
    adapter.applyReasoningConfig(body, config, null);
    expect(body.temperature).toBeUndefined();
  });

  it('test_invalid_reasoning_effort_keeps_sampling_params', () => {
    const config = makeConfig({ reasoningEffort: 'foo' });
    const body: Body = { temperature: 0.7, top_p: 0.9 };
    adapter.applyReasoningConfig(body, config, null);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_siliconflow_glm_effort_primary_budget_fallback', () => {
    const config = makeConfig({
      providerType: 'siliconflow', providerScope: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1', model: 'THUDM/GLM-5.2',
      modelAdapter: 'zhipu', supportsReasoning: true, isReasoning: true,
      thinkingEnabled: true, enableThinking: true, reasoningEffort: 'high',
    });
    const body: Body = { temperature: 0.7, thinking_budget: 16384 };
    adapter.applyReasoningConfig(body, config, null);
    expect(body.enable_thinking).toBe(true);
    expect(body.reasoning_effort).toBe('high');
    expect(body.thinking_budget).toBeUndefined();
    expect(body.temperature).toBe(0.7);
  });

  it('test_siliconflow_budget_fallback_without_effort', () => {
    const config = makeConfig({
      providerType: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'THUDM/GLM-5.2', supportsReasoning: true, isReasoning: true,
      enableThinking: true, thinkingBudget: 999_999,
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(32768);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_siliconflow_off_clears_stale_depth', () => {
    const config = makeConfig({
      providerType: 'siliconflow', model: 'THUDM/GLM-5.2', supportsReasoning: true,
      enableThinking: false, reasoningEffort: 'high', thinkingBudget: 16384,
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, false);
    expect(body.enable_thinking).toBe(false);
    expect(body.thinking_budget).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });
});
