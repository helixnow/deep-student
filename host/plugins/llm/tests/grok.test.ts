import { describe, expect, it } from 'vitest';
import { GrokAdapter } from '../src/adapters/grok.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new GrokAdapter();

describe('adapters/grok.rs', () => {
  it('test_parse_grok_version', () => {
    expect(GrokAdapter.parseGrokVersion('grok-4.3')).toEqual([4, 3]);
    expect(GrokAdapter.parseGrokVersion('grok-4.3-latest')).toEqual([4, 3]);
    expect(GrokAdapter.parseGrokVersion('grok-4.20-0309-reasoning')).toEqual([4, 20]);
    expect(GrokAdapter.parseGrokVersion('grok-4-1-fast-reasoning')).toEqual([4, 1]);
    expect(GrokAdapter.parseGrokVersion('grok-4')).toEqual([4, 0]);
    expect(GrokAdapter.parseGrokVersion('grok-3-mini')).toEqual([3, 0]);
    expect(GrokAdapter.parseGrokVersion('grok-build-0.1')).toBeNull();
    expect(GrokAdapter.parseGrokVersion('grok-latest')).toBeNull();
  });
  it('test_grok43_reasoning_effort_passthrough', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'medium', model: 'grok-4.3' }), null);
    expect(body.reasoning_effort).toBe('medium');
  });
  it('test_grok_latest_alias_reasoning_effort_passthrough', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'medium', model: 'grok-latest' }), null);
    expect(body.reasoning_effort).toBe('medium');
  });
  it('test_grok43_reasoning_effort_none', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'none', model: 'grok-4.3-latest' }), null);
    expect(body.reasoning_effort).toBe('none');
  });
  it('test_grok43_runtime_disable_maps_to_none', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'grok-4.3', reasoningEffort: 'high' }), false);
    expect(body.reasoning_effort).toBe('none');
  });
  it('test_grok420_reasoning_effort_passthrough', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'high', model: 'grok-4.20-0309-reasoning' }), null);
    expect(body.reasoning_effort).toBe('high');
  });
  it('test_grok420_multi_agent_preserves_xhigh', () => {
    for (const model of ['grok-4.20-0309-multi-agent', 'xai/grok-4.20-beta-multi-agent']) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'xhigh', model }), null);
      expect(body.reasoning_effort, model).toBe('xhigh');
    }
  });
  it('test_grok420_multi_agent_cannot_disable_reasoning', () => {
    for (const [savedEffort, runtimeOverride] of [['none', null], ['high', false]] as const) {
      const body: Body = {};
      adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: savedEffort, model: 'grok-4.20-0309-multi-agent' }), runtimeOverride);
      expect(body.reasoning_effort).toBe('low');
    }
  });
  it('test_non_reasoning_variant_no_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'high', model: 'grok-4.20-0309-non-reasoning' }), null);
    expect(body.reasoning_effort).toBeUndefined();
  });
  it('test_grok41_fast_no_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'high', model: 'grok-4-1-fast-reasoning' }), null);
    expect(body.reasoning_effort).toBeUndefined();
  });
  it('test_effort_normalization_superset_values', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ reasoningEffort: 'xhigh', model: 'grok-4.3' }), null);
    expect(body.reasoning_effort).toBe('high');
  });
  it('test_grok4_removes_unsupported_params', () => {
    const body: Body = { presence_penalty: 0.5, frequency_penalty: 0.5, stop: ['END'] };
    adapter.applyReasoningConfig(body, makeConfig({ model: 'grok-4.3' }), null);
    expect(body.presence_penalty).toBeUndefined();
    expect(body.frequency_penalty).toBeUndefined();
    expect(body.stop).toBeUndefined();
  });
  it('test_no_nonstandard_param_injection', () => {
    const body: Body = {};
    adapter.applyCommonParams(body, makeConfig({ model: 'grok-4.3', minP: 0.1, topK: 50, repetitionPenalty: 1.1 }));
    expect(body.min_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.repetition_penalty).toBeUndefined();
  });
  it('test_grok46_xhigh_passthrough', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'grok-4.6', reasoningEffort: 'xhigh' }), null);
    expect(body.reasoning_effort).toBe('xhigh');
  });
  it('test_grok45_xhigh_falls_back_to_high', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'grok-4.5', reasoningEffort: 'xhigh' }), null);
    expect(body.reasoning_effort).toBe('high');
  });
});
