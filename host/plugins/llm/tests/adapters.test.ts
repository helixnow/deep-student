import { describe, expect, it } from 'vitest';
import { getAdapter, listAdapters } from '../src/adapters/registry.ts';
import { makeConfig, type Body } from './support.ts';

describe('adapters/mod.rs', () => {
  it('test_get_adapter_by_provider_type', () => {
    expect(getAdapter('minimax', null, 'openai').id).toBe('minimax');
  });

  it('test_get_adapter_by_model_adapter', () => {
    expect(getAdapter(null, null, 'anthropic').id).toBe('anthropic');
  });

  it('test_aggregator_host_uses_generic_dialect_over_model_family', () => {
    expect(getAdapter('openrouter', 'qwen', 'general').id).toBe('general');
    const cases: Array<[string, string]> = [
      ['openrouter', 'qwen'],
      ['together', 'moonshot'],
      ['fireworks', 'zhipu'],
      ['groq', 'anthropic'],
      ['custom', 'ernie'],
      ['sub2api', 'minimax'],
      ['one-api', 'google'],
      ['cpa', 'deepseek'],
    ];
    for (const [provider, family] of cases) {
      expect(getAdapter(provider, family, family).id, `provider=${provider}`).toBe('general');
    }
  });

  it('test_siliconflow_only_uses_family_adapters_for_host_dialects', () => {
    expect(getAdapter('siliconflow', 'siliconflow', 'deepseek').id).toBe('deepseek');
    expect(getAdapter('siliconflow', 'siliconflow', 'qwen').id).toBe('qwen');
    for (const modelAdapter of ['zhipu', 'moonshot', 'minimax', 'anthropic']) {
      expect(
        getAdapter('siliconflow', 'siliconflow', modelAdapter).id,
        `model_adapter=${modelAdapter}`,
      ).toBe('general');
    }
  });

  it('test_get_adapter_fallback_to_default', () => {
    expect(getAdapter(null, null, 'unknown').id).toBe('general');
  });

  it('test_list_adapters', () => {
    const adapters = listAdapters();
    expect(adapters).toContain('minimax');
    expect(adapters).toContain('openai');
    expect(adapters).toContain('anthropic');
  });

  it('test_get_ernie_adapter', () => {
    expect(getAdapter('ernie', null, 'openai').id).toBe('ernie');
  });

  it('test_get_ernie_adapter_by_baidu_alias', () => {
    expect(getAdapter('baidu', null, 'openai').id).toBe('ernie');
  });

  it('test_nvidia_provider_prefers_generic_adapter_over_model_family_adapter', () => {
    expect(getAdapter('nvidia', 'nvidia', 'deepseek').id).toBe('general');
  });

  it('test_mimo_provider_uses_mimo_adapter', () => {
    expect(getAdapter('mimo', 'mimo', 'general').id).toBe('mimo');
  });

  it('test_mimo_adapter_maps_thinking_to_mimo_thinking_object', () => {
    const adapter = getAdapter('mimo', 'mimo', 'mimo');
    const body: Body = { temperature: 1.0 };
    adapter.applyReasoningConfig(body, makeConfig({
      model: 'mimo-v2.5-pro', providerType: 'mimo', providerScope: 'mimo',
      supportsReasoning: true, thinkingEnabled: true, enableThinking: true,
      includeThoughts: true,
    }), null);
    expect((body.thinking as Body).type).toBe('enabled');
    expect(body.enable_thinking).toBeUndefined();
    expect(body.thinking_budget).toBeUndefined();
    expect(body.temperature).toBe(1.0);
  });

  it('test_extra_body_merges_without_overwriting_existing_fields', () => {
    const adapter = getAdapter(null, null, 'general');
    const config = makeConfig({
      model: 'qwen3.7-max', temperature: 0.7, minP: 0.05,
      extraBody: {
        reasoning_effort: 'high', custom_flag: true, nested: { a: 1 },
        model: 'hijacked-model', temperature: 99.9, '': 'bogus',
      },
    });
    const body: Body = {
      model: 'qwen3.7-max', messages: [], stream: true, temperature: config.temperature,
    };
    adapter.applyCommonParams(body, config);
    expect(body.reasoning_effort).toBe('high');
    expect(body.custom_flag).toBe(true);
    expect(body.nested).toEqual({ a: 1 });
    expect(body.model).toBe('qwen3.7-max');
    expect(body.temperature).toBe(0.7);
    expect(body['']).toBeUndefined();
    expect(body.min_p).toBe(0.05);
    expect(body.extra_body).toBeUndefined();
  });

  it('test_extra_body_none_is_noop', () => {
    const adapter = getAdapter(null, null, 'general');
    const body: Body = { model: 'gpt-5.4-mini' };
    const before = Object.keys(body).length;
    adapter.applyCommonParams(body, makeConfig({
      model: 'gpt-5.4-mini', extraBody: null,
    }));
    expect(Object.keys(body).length).toBe(before);
  });
});
