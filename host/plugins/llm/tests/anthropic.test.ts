import { describe, expect, it } from 'vitest';
import {
  AnthropicAdapter, claudeGeneration, claudeThinkingAlwaysOn, mapBudgetTokensToEffort,
  mapReasoningEffortToAnthropic,
} from '../src/adapters/anthropic.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new AnthropicAdapter();
const thinkingType = (body: Body) => (body.thinking as Body | undefined)?.type;

describe('adapters/anthropic.rs', () => {
  it('test_claude_generation_new_models_are_adaptive', () => {
    for (const model of [
      'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-fable-5',
      'claude-mythos-5', 'claude-opus-5', 'claude-sonnet-5-1',
      'anthropic.claude-opus-4-8',
    ]) {
      expect(claudeGeneration(model), model).toBe('adaptive');
    }
  });

  it('test_claude_generation_legacy_models_are_manual', () => {
    for (const model of [
      'claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001', 'claude-opus-4-1', 'claude-sonnet-4',
      'claude-3-7-sonnet', 'claude-4.5-sonnet', 'claude-opus-4.5',
    ]) {
      expect(claudeGeneration(model), model).toBe('manual');
    }
    expect(claudeGeneration('claude-opus-4-6')).toBe('adaptive');
    expect(claudeGeneration('claude-sonnet-4-6')).toBe('adaptive');
  });

  it('test_claude_generation_unsupported_models', () => {
    expect(claudeGeneration('claude-3-5-sonnet')).toBe('unsupported');
    expect(claudeGeneration('claude-3-opus')).toBe('unsupported');
    expect(claudeGeneration('gpt-5.2')).toBe('unsupported');
    expect(claudeGeneration('')).toBe('unsupported');
  });

  it('test_claude_thinking_always_on', () => {
    expect(claudeThinkingAlwaysOn('claude-fable-5')).toBe(true);
    expect(claudeThinkingAlwaysOn('claude-mythos-5')).toBe(true);
    expect(claudeThinkingAlwaysOn('claude-sonnet-5')).toBe(false);
    expect(claudeThinkingAlwaysOn('claude-opus-4-8')).toBe(false);
  });

  it('test_adaptive_thinking_format_for_new_generation', () => {
    const config = makeConfig({
      thinkingEnabled: true, reasoningEffort: 'xhigh', model: 'claude-opus-4-8',
    });
    const body: Body = {};
    const earlyReturn = adapter.applyReasoningConfig(body, config, null);
    expect(earlyReturn).toBe(true);
    expect(thinkingType(body)).toBe('adaptive');
    expect((body.thinking as Body).budget_tokens).toBeUndefined();
    expect(body.effort).toBe('xhigh');
  });

  it('test_adaptive_thinking_maps_budget_to_effort_when_no_effort_configured', () => {
    for (const [budget, expected] of [[4096, 'low'], [10240, 'medium'], [20000, 'high'], [32768, 'max']] as const) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({
        thinkingEnabled: true, thinkingBudget: budget, model: 'claude-sonnet-5',
      }), null);
      expect(body.effort, `budget ${budget}`).toBe(expected);
    }
  });

  it('test_adaptive_thinking_omits_effort_when_nothing_configured', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, model: 'claude-fable-5',
    }), null);
    expect(thinkingType(body)).toBe('adaptive');
    expect(body.effort).toBeUndefined();
  });

  it('test_adaptive_thinking_display_param_when_include_thoughts', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, includeThoughts: true, model: 'claude-sonnet-5',
    }), null);
    expect((body.thinking as Body).display).toBe('summarized');

    const bodyNoDisplay: Body = {};
    adapter.applyReasoningConfig(bodyNoDisplay, makeConfig({
      thinkingEnabled: true, includeThoughts: false, model: 'claude-sonnet-5',
    }), null);
    expect((bodyNoDisplay.thinking as Body).display).toBeUndefined();
  });

  it('test_adaptive_generation_strips_sampling_params_even_without_thinking', () => {
    const config = makeConfig({ thinkingEnabled: false, model: 'claude-opus-4-8' });
    expect(adapter.shouldRemoveSamplingParams(config)).toBe(true);
    const body: Body = { temperature: 0.7, top_p: 0.9, top_k: 40 };
    adapter.applyReasoningConfig(body, config, null);
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
  });

  it('test_adaptive_generation_sends_disabled_when_thinking_off', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: false, model: 'claude-sonnet-5',
    }), null);
    expect(thinkingType(body)).toBe('disabled');
  });

  it('test_fable_always_on_never_sends_disabled', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: false, model: 'claude-fable-5',
    }), null);
    expect(body.thinking).toBeUndefined();
  });

  it('test_restricted_mythos_5_uses_always_on_adaptive_thinking', () => {
    const enabledBody: Body = { temperature: 0.7 };
    expect(adapter.applyReasoningConfig(enabledBody, makeConfig({
      thinkingEnabled: true, reasoningEffort: 'xhigh', model: 'claude-mythos-5',
    }), null)).toBe(true);
    expect(enabledBody.thinking).toEqual({ type: 'adaptive' });
    expect(enabledBody.effort).toBe('xhigh');
    expect(enabledBody.temperature).toBeUndefined();

    const disabledBody: Body = {};
    expect(adapter.applyReasoningConfig(disabledBody, makeConfig({
      thinkingEnabled: false, model: 'claude-mythos-5',
    }), null)).toBe(true);
    expect(disabledBody.thinking).toBeUndefined();
  });

  it('test_old_generation_does_not_remove_sampling_params_globally', () => {
    expect(adapter.shouldRemoveSamplingParams(makeConfig({
      model: 'claude-sonnet-4-5',
    }))).toBe(false);
  });

  it('test_extended_thinking_format', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, thinkingBudget: 8192, model: 'claude-sonnet-4',
    }), null);
    expect((body.thinking as Body).type).toBe('enabled');
    expect((body.thinking as Body).budget_tokens).toBe(8192);
  });

  it('test_minimum_budget_tokens', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, thinkingBudget: 100, model: 'claude-sonnet-4',
    }), null);
    expect((body.thinking as Body).budget_tokens).toBe(1024);
  });

  it('test_default_budget_tokens', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, thinkingBudget: null, model: 'claude-sonnet-4',
    }), null);
    expect((body.thinking as Body).budget_tokens).toBe(10240);
  });

  it('test_extended_thinking_removes_temperature', () => {
    const body: Body = { temperature: 0.7 };
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, model: 'claude-sonnet-4',
    }), null);
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toBeDefined();
  });

  it('test_extended_thinking_removes_top_k', () => {
    const body: Body = { top_k: 40 };
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, model: 'claude-sonnet-4',
    }), null);
    expect(body.top_k).toBeUndefined();
  });

  it('test_extended_thinking_clamps_top_p', () => {
    const body: Body = { top_p: 0.8 };
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, model: 'claude-sonnet-4',
    }), null);
    expect(body.top_p).toBe(0.95);
  });

  it('test_extended_thinking_keeps_valid_top_p', () => {
    const body: Body = { top_p: 0.97 };
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, model: 'claude-sonnet-4',
    }), null);
    expect(body.top_p).toBe(0.97);
  });

  it('test_budget_tokens_upper_limit', () => {
    expect(AnthropicAdapter.validateBudgetTokens(50000, null, 32768)).toBe(32768);
  });

  it('test_46_generation_uses_adaptive_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, reasoningEffort: 'max', model: 'claude-opus-4-6',
    }), null);
    expect(thinkingType(body)).toBe('adaptive');
    expect((body.thinking as Body).budget_tokens).toBeUndefined();
    expect(body.effort).toBe('max');
  });

  it('test_budget_tokens_lower_limit', () => {
    expect(AnthropicAdapter.validateBudgetTokens(500, null, 32768)).toBe(1024);
  });

  it('test_budget_tokens_less_than_max_tokens', () => {
    expect(AnthropicAdapter.validateBudgetTokens(10000, 8000, 32768)).toBe(7999);
  });

  it('test_budget_tokens_valid_range', () => {
    expect(AnthropicAdapter.validateBudgetTokens(8192, 16000, 32768)).toBe(8192);
  });

  it('test_budget_tokens_with_body_max_tokens', () => {
    const body: Body = { max_tokens: 16000 };
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: true, thinkingBudget: 20000, model: 'claude-sonnet-4',
    }), null);
    expect((body.thinking as Body).budget_tokens).toBe(15999);
  });

  it('test_budget_tokens_when_max_tokens_too_small', () => {
    expect(AnthropicAdapter.validateBudgetTokens(5000, 512, 32768)).toBe(511);
  });

  it('test_budget_tokens_when_max_tokens_is_one', () => {
    expect(AnthropicAdapter.validateBudgetTokens(5000, 1, 32768)).toBe(1);
  });

  it('test_enable_thinking_override_controls_history_and_passback', () => {
    const config = makeConfig({
      thinkingEnabled: false, enableThinking: true, model: 'claude-sonnet-4-5',
    });
    expect(adapter.getPassbackPolicy(config)).toBe('deep_seek_style');
    expect(adapter.requiresThinkingInHistory(config)).toBe(true);
  });

  it('test_claude_45_temperature_top_p_mutual_exclusion', () => {
    const body: Body = { temperature: 0.7, top_p: 0.9 };
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: false, model: 'claude-sonnet-4-5-20250929',
    }), null);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBeUndefined();
  });

  it('test_claude_45_removes_penalty_params', () => {
    const body: Body = { frequency_penalty: 0.5, presence_penalty: 0.5 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'claude-4.5-sonnet' }), null);
    expect(body.frequency_penalty).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
  });

  it('test_older_claude_keeps_top_p_with_temperature', () => {
    const body: Body = { temperature: 0.7, top_p: 0.9 };
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: false, model: 'claude-3-5-sonnet',
    }), null);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.9);
  });

  it('test_claude_45_keeps_top_p_when_no_temperature', () => {
    const body: Body = { top_p: 0.9 };
    adapter.applyReasoningConfig(body, makeConfig({
      thinkingEnabled: false, model: 'claude-4.5-sonnet',
    }), null);
    expect(body.top_p).toBe(0.9);
    expect(body.temperature).toBeUndefined();
  });

  it('test_older_claude_also_removes_penalty_params', () => {
    const body: Body = { frequency_penalty: 0.5, presence_penalty: 0.5 };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'claude-3-5-sonnet' }), null);
    expect(body.frequency_penalty).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
  });

  it('test_is_claude_45_version_aware', () => {
    expect(AnthropicAdapter.isClaude45('claude-opus-4.5')).toBe(true);
    expect(AnthropicAdapter.isClaude45('claude-opus-4-5')).toBe(true);
    expect(AnthropicAdapter.isClaude45('claude-opus-4-5-20251101')).toBe(true);
    expect(AnthropicAdapter.isClaude45('claude-sonnet-4.5')).toBe(true);
    expect(AnthropicAdapter.isClaude45('claude-haiku-4.5')).toBe(true);
    expect(AnthropicAdapter.isClaude45('claude-sonnet-4')).toBe(false);
    expect(AnthropicAdapter.isClaude45('claude-opus-4')).toBe(false);
    expect(AnthropicAdapter.isClaude45('claude-opus-4-8')).toBe(false);
    expect(AnthropicAdapter.isClaude45('claude-3-5-sonnet')).toBe(false);
  });

  it('claude_generation_variants_cover_effort_mapping_boundaries', () => {
    expect(mapReasoningEffortToAnthropic('minimal')).toBe('low');
    expect(mapReasoningEffortToAnthropic('XHIGH')).toBe('xhigh');
    expect(mapReasoningEffortToAnthropic('adaptive')).toBeNull();
    expect(mapBudgetTokensToEffort(4096)).toBe('low');
    expect(mapBudgetTokensToEffort(8192)).toBe('medium');
    expect(mapBudgetTokensToEffort(16384)).toBe('high');
    expect(mapBudgetTokensToEffort(32768)).toBe('max');
  });
});
