import { describe, expect, it } from 'vitest';
import { ErnieAdapter } from '../src/adapters/ernie.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new ErnieAdapter();

describe('adapters/ernie.rs', () => {
  it('test_max_tokens_passthrough', () => {
    const body: Body = { max_tokens: 4096 };
    adapter.applyReasoningConfig(body, makeConfig(), null);
    expect(body.max_tokens).toBe(4096);
    expect(body.max_output_tokens).toBeUndefined();
  });
  it('test_max_completion_tokens_passthrough', () => {
    const body: Body = { max_completion_tokens: 8192 };
    adapter.applyReasoningConfig(body, makeConfig(), null);
    expect(body.max_completion_tokens).toBe(8192);
    expect(body.max_output_tokens).toBeUndefined();
  });
  it('test_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'deepseek-v4-pro', reasoningEffort: 'high' }), null);
    expect(body.reasoning_effort).toBe('high');
  });
  it('test_reasoning_effort_max_accepted', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'deepseek-v4-pro', reasoningEffort: 'max' }), null);
    expect(body.reasoning_effort).toBe('max');
  });
  it('test_ernie_family_strips_reasoning_effort', () => {
    for (const model of ['ernie-5.0', 'ernie-5.0-thinking-preview', 'ernie-x1.1']) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({ model, reasoningEffort: 'max' }), null);
      expect(body.reasoning_effort, model).toBeUndefined();
    }
  });
  it('test_hosted_deepseek_xhigh_snaps_to_max', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'deepseek-v4-pro', reasoningEffort: 'xhigh' }), null);
    expect(body.reasoning_effort).toBe('max');
  });
  it('test_reasoning_effort_case_insensitive', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'deepseek-v4-pro', reasoningEffort: 'HIGH' }), null);
    expect(body.reasoning_effort).toBe('high');
  });
  it('test_invalid_reasoning_effort_ignored', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'invalid' }), null);
    expect(body.reasoning_effort).toBeUndefined();
  });
  it('test_thinking_switch_enabled', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'ernie-x1.1', thinkingEnabled: true }), null);
    expect(body.thinking).toEqual({ type: 'enabled' });
  });
  it('test_thinking_switch_disabled', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'ernie-5.0-thinking-latest', thinkingEnabled: false }), null);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });
  it('test_turn_level_thinking_override', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'ernie-x1.1', thinkingEnabled: false }), true);
    expect(body.thinking).toEqual({ type: 'enabled' });
  });
  it('test_enable_thinking_bool_converted_to_thinking_object', () => {
    const body: Body = { enable_thinking: true };
    adapter.applyReasoningConfig(body, makeConfig({ supportsReasoning: true, thinkingEnabled: true }), true);
    expect(body.enable_thinking).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'enabled' });
  });
  it('test_thinking_budget_stripped_for_ernie', () => {
    const body: Body = { thinking_budget: 2048 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'ernie-x1.1', thinkingEnabled: true }), true);
    expect(body.thinking_budget).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'enabled' });
  });
  it('test_thinking_budget_kept_for_hosted_deepseek', () => {
    const body: Body = { thinking_budget: 4096 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'deepseek-v3.2-think', supportsReasoning: true, thinkingEnabled: true }), true);
    expect(body.thinking_budget).toBe(4096);
    expect(body.thinking).toEqual({ type: 'enabled' });
  });
  it('test_non_thinking_model_no_thinking_param', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'ernie-4.5-turbo-128k' }), null);
    expect(body.thinking).toBeUndefined();
  });
  it('test_is_thinking_model', () => {
    for (const model of ['ernie-5.0-thinking-latest', 'ernie-5.0-thinking-preview', 'ERNIE-5.0-THINKING-LATEST', 'ernie-x1.1']) expect(ErnieAdapter.isThinkingModel(model), model).toBe(true);
    for (const model of ['ernie-5.0', 'ernie-4.0']) expect(ErnieAdapter.isThinkingModel(model), model).toBe(false);
  });
  it('test_should_remove_sampling_params_for_thinking_model', () => {
    expect(adapter.shouldRemoveSamplingParams(makeConfig({ model: 'ernie-5.0-thinking-latest' }))).toBe(true);
  });
  it('test_keep_sampling_params_for_non_thinking_model', () => {
    expect(adapter.shouldRemoveSamplingParams(makeConfig({ model: 'ernie-5.0' }))).toBe(false);
  });
  it('test_passback_policy_for_thinking_model', () => {
    expect(adapter.getPassbackPolicy(makeConfig({ model: 'ernie-5.0-thinking-latest' }))).toBe('deep_seek_style');
  });
  it('test_penalty_score_conversion', () => {
    const body: Body = {};
    adapter.applyCommonParams(body, makeConfig({ repetitionPenalty: 1.2 }));
    expect(body.penalty_score).toBe(1.2);
    expect(body.repetition_penalty).toBeUndefined();
  });
});
