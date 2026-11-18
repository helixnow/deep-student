import { describe, expect, it } from 'vitest';
import { MistralAdapter } from '../src/adapters/mistral.ts';
import { preparePlainProviderRequest } from '../src/prepared_request.ts';
import { providerAdapterForConfig } from '../src/provider_adapter.ts';
import { applyReasoningConfig } from '../src/question_authoring.ts';
import { makeConfig, type Body } from './support.ts';

const adapter = new MistralAdapter();

describe('adapters/mistral.rs', () => {
  it.each([
    ['deepseek-v4-1-flash-1017', true, 'medium', 'high'],
    ['deepseek-v4-1-flash-1017', true, 'max', 'max'],
    ['deepseek-v4-1-flash-1017', false, 'max', 'none'],
    ['zai-glm-5-3', true, 'max', 'max'],
    ['zai-glm-5-3-flash', false, 'high', 'low'],
  ])('sends the Mistral effort for %s (thinking %s, requested %s)', (model, enabled, requested, expected) => {
    const config = makeConfig({ model, providerType: 'mistral', modelAdapter: 'mistral', reasoningEffort: requested });
    const body: Record<string, never> = {};
    applyReasoningConfig(body, config, enabled);
    expect(body).toEqual({ reasoning_effort: expected });
  });

  it('replays thinking in content while keeping the assistant tool call and its result linked', () => {
    const config = makeConfig({ model: 'deepseek-v4-1-flash-1017', providerType: 'mistral',
      baseUrl: 'https://api.mistral.ai/v1', modelAdapter: 'mistral', apiProtocol: 'openai_chat_completions' });
    const call = { id: 'Mistral01', type: 'function', function: { name: 'lookup', arguments: '{}' } };
    const request = preparePlainProviderRequest(providerAdapterForConfig(config), config, { messages: [
      { role: 'system', content: [{ type: 'text', text: 'System', cache_control: { type: 'ephemeral' } }] },
      { role: 'assistant', content: 'Looking it up', reasoning_content: 'Need the tool', tool_calls: [call] },
      { role: 'tool', content: '42', tool_call_id: call.id },
      { role: 'assistant', content: 'The answer is 42', reasoning_content: 'Use the result' },
    ] }, null, null, 'test');
    expect(request.body).toMatchObject({ messages: [
      { role: 'system', content: [{ type: 'text', text: 'System' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: [{ type: 'text', text: 'Need the tool' }] },
        { type: 'text', text: 'Looking it up' },
      ], tool_calls: [call] },
      { role: 'tool', content: '42', tool_call_id: call.id },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: [{ type: 'text', text: 'Use the result' }] },
        { type: 'text', text: 'The answer is 42' },
      ] },
    ] });
    expect(JSON.stringify(request.body)).not.toMatch(/reasoning_content|cache_control/);
  });
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
