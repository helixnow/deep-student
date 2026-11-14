import { describe, expect, it } from 'vitest';
import { QwenAdapter } from '../src/adapters/qwen.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new QwenAdapter();

describe('adapters/qwen.rs', () => {
  it('test_enable_thinking', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ supportsReasoning: true, thinkingEnabled: true, thinkingBudget: 2048 }), null);
    expect(body.enable_thinking).toBe(true);
    expect(body.thinking_budget).toBe(2048);
  });

  it('test_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'high' }), null);
    expect(body.reasoning_effort).toBe('high');
  });

  it('test_forced_thinking_models_ignore_disable_override', () => {
    for (const model of ['qwen3.7-max-preview', 'qwen3.7-max-2026-05-17', 'Qwen/Qwen3-235B-A22B-Thinking-2507', 'Qwen/Qwen3-VL-235B-A22B-Thinking']) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({ model, supportsReasoning: true, enableThinking: false }), false);
      expect(body.enable_thinking, model).toBe(true);
    }
  });

  it('test_hybrid_qwen_models_remain_disableable', () => {
    for (const model of ['qwen3.7-plus', 'qwen3.7-max-2026-06-08', 'qwen-plus', 'qwen-turbo']) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({ model, supportsReasoning: true, enableThinking: false }), false);
      expect(body.enable_thinking, model).toBe(false);
    }
  });

  it('test_qwen37_preserves_thinking_history_on_dashscope', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      providerType: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.7-plus', supportsReasoning: true, thinkingEnabled: true, includeThoughts: true,
    }), null);
    expect(body.preserve_thinking).toBe(true);
  });

  it('test_preserve_thinking_is_scoped_to_supported_dashscope_models', () => {
    for (const config of [
      makeConfig({ providerType: 'qwen', model: 'qwen3.5-plus', supportsReasoning: true, includeThoughts: true }),
      makeConfig({ providerType: 'siliconflow', model: 'Qwen/Qwen3.7-Plus', supportsReasoning: true, includeThoughts: true }),
    ]) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, config, null);
      expect(body.preserve_thinking).toBeUndefined();
    }
  });

  it('test_dashscope_does_not_send_unsupported_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      providerType: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      reasoningEffort: 'high', supportsReasoning: true,
    }), true);
    expect(body.enable_thinking).toBe(true);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_workspace_maas_uses_official_qwen_reasoning_dialect', () => {
    for (const baseUrl of [
      'https://workspace-id.cn-beijing.maas.aliyuncs.com/v1',
      'https://workspace-id.ap-southeast-1.maas.aliyuncs.com/v1',
    ]) {
      const body: Body = { frequency_penalty: 0.5 };
      adapter.applyReasoningConfig(body, makeConfig({
        baseUrl, reasoningEffort: 'high', supportsReasoning: true, thinkingBudget: 8192,
      }), true);
      expect(body.enable_thinking).toBe(true);
      expect(body.thinking_budget).toBe(8192);
      expect(body.reasoning_effort, baseUrl).toBeUndefined();
      expect(body.frequency_penalty, baseUrl).toBeUndefined();
    }
  });

  it('test_keep_temperature', () => {
    expect(adapter.shouldRemoveSamplingParams(makeConfig({ isReasoning: true }))).toBe(false);
  });

  it('test_removes_frequency_penalty', () => {
    const body: Body = { frequency_penalty: 0.5, presence_penalty: 0.5 };
    adapter.applyReasoningConfig(body, makeConfig({
      providerType: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    }), null);
    expect(body.frequency_penalty).toBeUndefined();
    expect(body.presence_penalty).toBe(0.5);
  });

  it('test_siliconflow_keeps_frequency_penalty', () => {
    const body: Body = { frequency_penalty: 0.5 };
    adapter.applyReasoningConfig(body, makeConfig({
      providerType: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1',
    }), null);
    expect(body.frequency_penalty).toBe(0.5);
  });

  it('test_siliconflow_clamps_thinking_budget', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      providerType: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1',
      supportsReasoning: true, thinkingEnabled: true, thinkingBudget: 64,
    }), null);
    expect(body.thinking_budget).toBe(128);
  });

  it('test_qwen38_effort_primary_and_budget_fallback', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      model: 'qwen3.8-max', providerType: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      supportsReasoning: true, isReasoning: true, enableThinking: true,
      reasoningEffort: 'high', thinkingBudget: 16384,
    }), null);
    expect(body.enable_thinking).toBe(true);
    expect(body.reasoning_effort).toBe('xhigh');
    expect(body.thinking_budget).toBeUndefined();
  });

  it('test_qwen38_budget_fallback_without_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      model: 'qwen3.8-max', providerType: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      supportsReasoning: true, isReasoning: true, enableThinking: true, thinkingBudget: 16384,
    }), null);
    expect(body.thinking_budget).toBe(16384);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_qwen38_omni_none_disables_via_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      model: 'qwen3.8-omni-flash', providerType: 'qwen',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      supportsReasoning: true, isReasoning: true, enableThinking: true, reasoningEffort: 'none',
    }), null);
    expect(body.reasoning_effort).toBe('none');
    expect(body.thinking_budget).toBeUndefined();
  });

  it('test_qwen38_vendor_prefix_and_legacy_qwen3_8b_untouched', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      model: 'Qwen/qwen3.8-flash', providerType: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1', supportsReasoning: true,
      isReasoning: true, enableThinking: true, reasoningEffort: 'medium',
    }), null);
    expect(body.reasoning_effort).toBe('medium');

    const body2: Body = {};
    adapter.applyReasoningConfig(body2, makeConfig({
      model: 'Qwen/Qwen3-8B', providerType: 'siliconflow',
      baseUrl: 'https://api.siliconflow.cn/v1', supportsReasoning: true,
      isReasoning: true, enableThinking: true, reasoningEffort: 'high', thinkingBudget: 4096,
    }), null);
    expect(body2.reasoning_effort).toBeUndefined();
    expect(body2.thinking_budget).toBe(4096);
  });
});
