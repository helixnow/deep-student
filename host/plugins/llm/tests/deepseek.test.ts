import { describe, expect, it } from 'vitest';
import {
  DeepSeekAdapter, applyOfficialDeepseekGenerationParams, isOfficialDeepseekV4,
  normalizeDeepseekChatRequest,
} from '../src/adapters/deepseek.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new DeepSeekAdapter();

describe('adapters/deepseek.rs', () => {
  it('chat_wire_normalizes_system_parts_and_output_limit_on_deepseek_relays', () => {
    const config = makeConfig({
      model: 'tree-deepseek-v4.1-flash', modelAdapter: 'deepseek', providerType: 'custom',
      apiProtocol: 'openai_chat_completions', baseUrl: 'https://relay.example/v1',
    });
    const user = {
      role: 'user', content: [
        { type: 'text', text: 'Read this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      ],
    };
    const assistant = {
      role: 'assistant', content: '', reasoning_content: 'keep reasoning',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'load_skills', arguments: '{}' } }],
    };
    const body: Body = {
      max_completion_tokens: 1024,
      messages: [
        {
          role: 'system', content: [
            { type: 'text', text: 'instructions', cache_control: { type: 'ephemeral' } },
            { type: 'text', text: '<available_skills>exact catalog</available_skills>' },
          ],
        },
        user, assistant,
      ],
    };
    normalizeDeepseekChatRequest(body, config);
    expect((body.messages as Body[])[0]!.content)
      .toBe('instructions\n<available_skills>exact catalog</available_skills>');
    expect((body.messages as Body[])[1]).toEqual(user);
    expect((body.messages as Body[])[2]).toEqual(assistant);
    expect(body.max_tokens).toBe(1024);
    expect(body.max_completion_tokens).toBeUndefined();
    const once = structuredClone(body);
    normalizeDeepseekChatRequest(body, config);
    expect(body).toEqual(once);
  });

  it('chat_wire_preserves_explicit_limit_and_other_protocols', () => {
    const body: Body = {
      max_tokens: 128, max_completion_tokens: 1024,
      messages: [{
        role: 'system',
        content: [{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral' } }],
      }],
    };
    const config = makeConfig({
      model: 'deepseek-flash', modelAdapter: 'deepseek', providerType: 'deepseek',
      apiProtocol: 'openai_chat_completions', baseUrl: 'https://api.deepseek.com/v1',
    });
    const normalized = structuredClone(body);
    normalizeDeepseekChatRequest(normalized, config);
    expect(normalized.max_tokens).toBe(128);
    expect((normalized.messages as Body[])[0]!.content).toBe('instructions');

    for (const protocol of ['openai_responses', 'anthropic_messages']) {
      config.apiProtocol = protocol;
      const other = structuredClone(body);
      normalizeDeepseekChatRequest(other, config);
      expect(other, protocol).toEqual(body);
    }
    config.modelAdapter = 'general';
    config.model = 'gpt-5.4';
    config.baseUrl = 'https://api.openai.com/v1';
    config.apiProtocol = 'openai_chat_completions';
    const otherModel = structuredClone(body);
    normalizeDeepseekChatRequest(otherModel, config);
    expect(otherModel).toEqual(body);
  });

  it('test_thinking_type_format_deepseek_official', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect((body.thinking as Body).type).toBe('enabled');
    expect(body.enable_thinking).toBeUndefined();
  });

  it('test_official_v4_reasoning_effort_medium_maps_to_high', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'medium',
      model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect((body.thinking as Body).type).toBe('enabled');
    expect(body.reasoning_effort).toBe('high');
    expect(body.enable_thinking).toBeUndefined();
  });

  it('test_official_v4_reasoning_effort_xhigh_maps_to_high', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'xhigh',
      model: 'deepseek-v4-flash', baseUrl: 'https://api.deepseek.com/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.reasoning_effort).toBe('high');
  });

  it('test_official_v4_reasoning_effort_low_stays_low', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'low',
      model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.reasoning_effort).toBe('low');
  });

  it('test_official_v4_reasoning_effort_ultra_maps_to_max', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'ultra',
      model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.reasoning_effort).toBe('max');
  });

  it('test_v4_output_cap_respects_explicit_budgets_and_official_endpoint', () => {
    const official = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const budgets: Array<[number, number]> = [
      [1024, 1024], [256_000, 256_000], [500_000, 393_216], [0, 131_072],
    ];
    for (const [requested, expected] of budgets) {
      const config = { ...official, maxOutputTokens: requested };
      const body: Body = { thinking: { type: 'enabled' }, reasoning_effort: 'max' };
      expect(applyOfficialDeepseekGenerationParams(body, config)).toBe(true);
      expect(body.max_tokens).toBe(expected);
      expect(body.max_completion_tokens).toBeUndefined();
    }
    const thirdParty = {
      ...official, model: 'deepseek-ai/DeepSeek-V4-Pro',
      baseUrl: 'https://api.siliconflow.cn/v1',
    };
    expect(applyOfficialDeepseekGenerationParams({}, thirdParty)).toBe(false);
    const proxy = { ...official, providerType: 'deepseek', baseUrl: 'https://proxy.example/v1' };
    expect(isOfficialDeepseekV4(proxy)).toBe(false);
  });

  it('test_v41_flash_uses_v4_thinking_and_sampling_rules', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'high',
      model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect((body.thinking as Body).type).toBe('enabled');
    expect(body.reasoning_effort).toBe('high');
    expect(adapter.shouldRemoveSamplingParams(config)).toBe(false);
  });

  it('test_official_v4_rejects_unsupported_reasoning_effort_before_io', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'ultra-mega',
      model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(() => adapter.validateReasoningConfig(config))
      .toThrow(/UNSUPPORTED_REASONING_EFFORT/);
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', 'none', 'unset']) {
      config.reasoningEffort = effort;
      expect(() => adapter.validateReasoningConfig(config), effort).not.toThrow();
    }
    config.reasoningEffort = 'ultra-mega';
    config.baseUrl = 'https://proxy.example.com/v1';
    expect(() => adapter.validateReasoningConfig(config)).not.toThrow();
  });

  it('test_official_v4_validation_skips_disabled_thinking', () => {
    const config = makeConfig({
      supportsReasoning: true, enableThinking: false, reasoningEffort: 'ultra-mega',
      model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(() => adapter.validateReasoningConfig(config)).not.toThrow();
  });

  it('test_legacy_alias_supports_v4_reasoning_effort', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'high',
      model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.reasoning_effort).toBe('high');
    expect(body.thinking).toBeDefined();
  });

  it('test_official_v4_reasoning_none_still_removes_sampling_params', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'none',
      model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(adapter.shouldRemoveSamplingParams(config)).toBe(false);
  });

  it('test_official_v4_disable_thinking_uses_thinking_type_disabled', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, enableThinking: false,
      reasoningEffort: 'max', model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect((body.thinking as Body).type).toBe('disabled');
    expect(body.reasoning_effort).toBeUndefined();
    expect(adapter.shouldRemoveSamplingParams(config)).toBe(false);
  });

  it('test_official_v4_disable_thinking_even_when_legacy_config_lacks_capability_flag', () => {
    const config = makeConfig({
      supportsReasoning: false, thinkingEnabled: false, enableThinking: false,
      model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect((body.thinking as Body).type).toBe('disabled');
  });

  it('test_siliconflow_v4_shaped_id_keeps_siliconflow_format', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'max',
      model: 'deepseek-ai/DeepSeek-V4-Pro', baseUrl: 'https://api.siliconflow.cn/v1',
      thinkingBudget: 50000,
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.enable_thinking).toBe(true);
    expect(body.reasoning_effort).toBe('max');
    expect(body.thinking_budget).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });

  it('test_siliconflow_v32_depth_presets_map_to_budget', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, reasoningEffort: 'low',
      model: 'deepseek-ai/DeepSeek-V3.2', baseUrl: 'https://api.siliconflow.cn/v1',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(2048);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_siliconflow_enable_thinking_format', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, model: 'deepseek-ai/DeepSeek-V3.2',
      baseUrl: 'https://api.siliconflow.cn/v1', thinkingBudget: 4096,
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(4096);
    expect(body.thinking).toBeUndefined();
  });

  it('test_siliconflow_detection_by_provider_type', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, model: 'deepseek-ai/DeepSeek-V3.2',
      baseUrl: 'https://some-proxy.example.com/v1', providerType: 'siliconflow',
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking).toBeUndefined();
  });

  it('test_v31_with_tools_disables_thinking', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, model: 'deepseek-ai/deepseek-v3.1',
    });
    const body: Body = { tools: [] };
    adapter.applyReasoningConfig(body, config, true);
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it('test_remove_sampling_params_for_v4_thinking', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, model: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com/v1',
    });
    expect(adapter.shouldRemoveSamplingParams(config)).toBe(false);
  });

  it('test_keep_sampling_params_for_non_thinking', () => {
    expect(adapter.shouldRemoveSamplingParams(makeConfig())).toBe(false);
  });

  it('test_thinking_budget_clamp', () => {
    const config = makeConfig({
      supportsReasoning: true, thinkingEnabled: true, model: 'deepseek-ai/DeepSeek-V3.2',
      baseUrl: 'https://api.siliconflow.cn/v1', thinkingBudget: 50,
    });
    const body: Body = {};
    adapter.applyReasoningConfig(body, config, null);
    expect(body.thinking_budget).toBe(128);
  });
});
