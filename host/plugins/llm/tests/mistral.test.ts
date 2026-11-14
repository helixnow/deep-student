import { describe, expect, it } from 'vitest';
import { MistralAdapter } from '../src/adapters/mistral.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new MistralAdapter();

describe('adapters/mistral.rs', () => {
  it('test_magistral_prompt_mode', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'magistral-medium-latest', enableThinking: true }), null,
    );
    expect(body.prompt_mode).toBe('reasoning');

    const offBody: Body = {};
    adapter.applyReasoningConfig(
      offBody, makeConfig({ model: 'magistral-medium-latest' }), null,
    );
    expect(offBody.prompt_mode).toBeNull();
  });

  it('test_magistral_with_prefix', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body,
      makeConfig({ model: 'mistral/magistral-medium-latest', enableThinking: true }),
      null,
    );
    expect(body.prompt_mode).toBe('reasoning');
  });

  it('test_magistral_no_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body,
      makeConfig({
        model: 'magistral-medium-latest', enableThinking: true, reasoningEffort: 'high',
      }),
      null,
    );
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.prompt_mode).toBe('reasoning');
  });

  it('test_medium_latest_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'mistral-medium-latest', reasoningEffort: 'high' }), null,
    );
    expect(body.reasoning_effort).toBe('high');
    expect(body.prompt_mode).toBeUndefined();
  });

  it('test_small_4_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'mistral-small-4', reasoningEffort: 'none' }), null,
    );
    expect(body.reasoning_effort).toBe('none');
  });

  it('test_runtime_disable_maps_effort_models_to_none', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'mistral-medium-latest', reasoningEffort: 'high' }), false,
    );
    expect(body.reasoning_effort).toBe('none');
  });

  it('test_versioned_medium_35_reasoning_effort', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'mistral-medium-3-5', reasoningEffort: 'medium' }), null,
    );
    expect(body.reasoning_effort).toBe('medium');
  });

  it('test_effort_normalization_superset_values', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'mistral-medium-latest', reasoningEffort: 'xhigh' }), null,
    );
    expect(body.reasoning_effort).toBe('high');
  });

  it('test_mistral_large_no_reasoning_params', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(
      body, makeConfig({ model: 'mistral-large-latest', reasoningEffort: 'high' }), null,
    );
    expect(body.prompt_mode).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('test_codestral_no_prompt_mode', () => {
    const body: Body = {};
    adapter.applyReasoningConfig(body, makeConfig({ model: 'codestral-latest' }), null);
    expect(body.prompt_mode).toBeUndefined();
  });

  it('test_mistral_keeps_sampling_params', () => {
    expect(adapter.shouldRemoveSamplingParams(makeConfig({
      model: 'mistral-large-latest', isReasoning: true,
    }))).toBe(false);
  });

  it('test_mistral_common_params', () => {
    const body: Body = {};
    adapter.applyCommonParams(body, makeConfig({
      model: 'mistral-large-latest', minP: 0.1, topK: 50, repetitionPenalty: 1.1,
    }));
    expect(body.min_p).toBe(0.1);
    expect(body.top_k).toBe(50);
    expect(body.repetition_penalty).toBe(1.1);
  });
});
