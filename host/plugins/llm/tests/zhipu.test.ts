import { describe, expect, it } from 'vitest';
import { ZhipuAdapter } from '../src/adapters/zhipu.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new ZhipuAdapter();

describe('adapters/zhipu.rs', () => {
  it('test_glm47_thinking_enabled', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ thinkingEnabled: true, model: 'glm-4.7' }), null);
    expect((body.thinking as Body).type).toBe('enabled');
  });

  it('test_glm47_thinking_disabled', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ thinkingEnabled: false, model: 'glm-4.7-flash' }), null);
    expect(body.thinking).toBeUndefined();
  });

  it('test_tool_stream', () => {
    const body: Body = { tools: [] };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'glm-4.6' }), null);
    expect(body.tool_stream).toBe(true);
  });

  it('test_clear_thinking', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ thinkingEnabled: true, includeThoughts: true, model: 'glm-4.7' }), null);
    expect((body.thinking as Body).clear_thinking).toBe(false);
  });

  it('test_removes_penalty_params', () => {
    const body: Body = { frequency_penalty: 0.5, presence_penalty: 0.5, temperature: 0.7 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'glm-4.6' }), null);
    expect(body.frequency_penalty).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
    expect(body.temperature).toBe(0.7);
  });

  it('test_glm47_preserved_thinking', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ thinkingEnabled: true, includeThoughts: true, model: 'glm-4.7' }), null);
    expect((body.thinking as Body).type).toBe('enabled');
    expect((body.thinking as Body).clear_thinking).toBe(false);
  });

  it('test_supports_thinking', () => {
    for (const model of ['glm-4.5', 'zai-org/GLM-4.5V', 'glm-4.6', 'zai-org/GLM-4.6V', 'glm-4.7', 'glm-5', 'GLM-5', 'glm-5.1', 'glm-5.2', 'glm-5-turbo']) {
      expect(ZhipuAdapter.supportsThinking(model), model).toBe(true);
    }
    for (const model of ['GLM-4.7-Flash', 'GLM-4.6V-FlashX', 'THUDM/GLM-4.1V-9B-Thinking', 'glm-4', 'glm-4.0']) {
      expect(ZhipuAdapter.supportsThinking(model), model).toBe(false);
    }
  });

  it('test_parse_glm_version', () => {
    expect(ZhipuAdapter.parseGlmVersion('glm-5.2')).toEqual([5, 2]);
    expect(ZhipuAdapter.parseGlmVersion('glm-5.1')).toEqual([5, 1]);
    expect(ZhipuAdapter.parseGlmVersion('glm-5')).toEqual([5, 0]);
    expect(ZhipuAdapter.parseGlmVersion('glm-5-turbo')).toEqual([5, 0]);
    expect(ZhipuAdapter.parseGlmVersion('glm-4.7-flash')).toEqual([4, 7]);
    expect(ZhipuAdapter.parseGlmVersion('zai-org/GLM-4.6V')).toEqual([4, 6]);
    expect(ZhipuAdapter.parseGlmVersion('glm-5.2[1m]')).toEqual([5, 2]);
    expect(ZhipuAdapter.parseGlmVersion('qwen3-max')).toBeNull();
  });

  it('test_supports_reasoning_effort', () => {
    for (const model of ['glm-5.2', 'GLM-5.2', 'glm-5.3', 'glm-6']) expect(ZhipuAdapter.supportsReasoningEffort(model), model).toBe(true);
    for (const model of ['glm-5.1', 'glm-5', 'glm-4.7']) expect(ZhipuAdapter.supportsReasoningEffort(model), model).toBe(false);
  });

  it('test_glm52_reasoning_effort_passthrough', () => {
    for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({ model: 'glm-5.2', thinkingEnabled: true, reasoningEffort: effort }), null);
      expect(body.reasoning_effort, effort).toBe(effort);
    }
  });

  it('test_glm51_no_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'glm-5.1', thinkingEnabled: true, reasoningEffort: 'max' }), null);
    expect(body.reasoning_effort).toBeUndefined();
    expect((body.thinking as Body).type).toBe('enabled');
  });

  it('test_glm52_invalid_effort_ignored', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'glm-5.2', thinkingEnabled: true, reasoningEffort: 'turbo' }), null);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_turn_level_thinking_override', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ thinkingEnabled: true, model: 'glm-4.7' }), false);
    expect((body.thinking as Body).type).toBe('disabled');
  });

  it('test_turn_level_thinking_enable', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ thinkingEnabled: false, model: 'glm-4.7' }), true);
    expect((body.thinking as Body).type).toBe('enabled');
  });

  it('test_glm53_forced_thinking_and_effort_subset', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      model: 'glm-5.3', providerType: 'zhipu', supportsReasoning: true, isReasoning: true,
      enableThinking: false, reasoningEffort: 'medium',
    }), false);
    expect((body.thinking as Body).type).toBe('enabled');
    expect(body.reasoning_effort).toBe('high');
  });

  it('test_glm53_xhigh_maps_to_high', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'glm-5.3-flash', reasoningEffort: 'xhigh' }), null);
    expect(body.reasoning_effort).toBe('high');
  });

  it('test_glm52_unaffected_by_53_rules', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      model: 'glm-5.2', supportsReasoning: true, isReasoning: true, enableThinking: false,
    }), false);
    expect((body.thinking as Body).type).toBe('disabled');
  });
});
