import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../../llm/api.ts';
import {
  applyGenerationParams, applyOfficialDeepseekGenerationParams, applyReasoningConfig, resolveQuirks,
} from '../../llm/api.ts';
import type { JsonValue } from '../api.ts';
import { SseEventBuffer } from '../../../platform/util/api.ts';
import { OpenAIAdapter } from '../src/providers/openai-chat.ts';
import { OpenAIResponsesAdapter } from '../src/providers/openai-responses.ts';

const ENDPOINT = 'https://api.deepseek.com/v1';

/** `ApiConfig::default()`（dstu-core llm_config.rs:127）。 */
function apiConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: '', name: '', vendorId: null, vendorName: null, providerType: null, providerScope: null,
    authMode: null, apiProtocol: null, supportsOpenaiResponses: null, apiKey: '', baseUrl: '',
    model: '', isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
    isImageGeneration: false, enabled: false, modelAdapter: 'general', maxOutputTokens: 8192,
    temperature: 0.7, supportsTools: false, geminiApiVersion: 'v1', isBuiltin: false,
    isReadOnly: false, reasoningEffort: null, reasoningMode: null, thinkingEnabled: false,
    thinkingBudget: null, includeThoughts: false, minP: null, topK: null, enableThinking: null,
    supportsReasoning: false, headers: null, topPOverride: null, frequencyPenaltyOverride: null,
    presencePenaltyOverride: null, repetitionPenalty: null, reasoningSplit: null, effort: null,
    verbosity: null, isFavorite: false, maxTokensLimit: null, contextWindow: null,
    extraBody: null, resolvedAdapterId: null,
    ...overrides,
  };
}

/** Test-only deep view of wire JSON; runtime values are unchanged. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = any;
const wire = (value: JsonValue): Wire => value as Wire;
const json = (value: unknown): JsonValue => value as JsonValue;

describe('deepseek harness regressions', () => {
  it('deepseek_harness_http_stream_consumes_trailing_usage_before_failure', () => {
    const adapter = new OpenAIAdapter();
    const request = adapter.buildRequest(ENDPOINT, '', 'deepseek-flash', json({
      model: 'deepseek-flash',
      stream: true,
      messages: [{ role: 'user', content: 'Explain' }],
    }));
    const body = wire(request.body);
    expect(body.model).toBe('deepseek-flash');
    expect(body.stream).toBe(true);

    const payload = [
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":80}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    const buffer = new SseEventBuffer();
    const events: ReturnType<OpenAIAdapter['parseStream']> = [];
    let terminal = false;
    for (const block of buffer.processBytes(new TextEncoder().encode(payload))) {
      const parsed = adapter.parseStream(block);
      terminal = parsed.some(event => event.type === 'Done' || event.type === 'SafetyBlocked');
      events.push(...parsed);
      if (terminal) break;
    }

    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'partial' });
    expect(events[1]!.type).toBe('Usage');
    expect(wire((events[1] as Wire).value).prompt_cache_hit_tokens).toBe(80);
    expect(events[2]!.type).toBe('SafetyBlocked');
    expect(wire((events[2] as Wire).value).reason).toBe('length');
    expect(events).toHaveLength(3);
  });

  it('deepseek_harness_failure_at_eof_and_request_reuse_are_isolated', () => {
    const adapter = new OpenAIAdapter();
    for (const endpoint of [ENDPOINT, 'https://api.openai.com/v1', ENDPOINT]) {
      adapter.buildRequest(endpoint, '', 'deepseek-flash', json({}));
      adapter.parseStream('data: {"choices":[{"delta":{},"finish_reason":"length"}]}');
      const terminal = adapter.finishStream();
      if (endpoint === ENDPOINT) {
        expect(terminal).toHaveLength(1);
        expect(terminal[0]!.type).toBe('SafetyBlocked');
        expect(wire((terminal[0] as Wire).value).reason).toBe('length');
      } else {
        expect(terminal).toEqual([{ type: 'Done' }]);
      }
      expect(adapter.finishStream()).toHaveLength(0);
    }
  });

  it('deepseek_harness_responses_replays_chat_cot_without_duplicating_native_items', () => {
    const native = json({ type: 'reasoning', id: 'reason-2', content: [{ type: 'reasoning_text', text: 'second thought' }] });
    const body = json({
      messages: [
        { role: 'user', content: 'Read the note' },
        {
          role: 'assistant', content: '', reasoning_content: 'first thought',
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_note', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'note content' },
        { role: 'assistant', content: 'answer', reasoning_content: 'second thought', response_reasoning_item: native },
        { role: 'user', content: 'Explain more' },
      ],
    });

    const result = wire(new OpenAIResponsesAdapter().buildRequest(ENDPOINT, '', 'deepseek-flash', body).body);
    const input = result.input as Wire[];
    const reasoning = input.filter(item => item.type === 'reasoning');
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0].content[0].text).toBe('first thought');
    expect(reasoning[1]).toEqual(native);
    const call = input.findIndex(item => item.type === 'function_call');
    expect(call).toBeGreaterThanOrEqual(0);
    expect(input.slice(0, call).some(item => item.type === 'reasoning')).toBe(true);

    const openai = wire(new OpenAIResponsesAdapter().buildRequest('https://api.openai.com/v1', '', 'gpt-5', body).body);
    expect((openai.input as Wire[]).filter(item => item.type === 'reasoning')).toHaveLength(1);
  });

  it('deepseek_harness_system_update_keeps_history_position', () => {
    const body = json({
      messages: [
        { role: 'system', content: 'original instructions' },
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
        { role: 'system', content: 'replacement instructions' },
        { role: 'user', content: 'follow up' },
      ],
    });

    const result = wire(new OpenAIResponsesAdapter().buildRequest(ENDPOINT, '', 'deepseek-flash', body).body);
    expect(result.instructions).toBe('original instructions');
    expect(result.input[2].role).toBe('system');
    expect(result.input[2].content[0].text).toBe('replacement instructions');
  });

  it('deepseek_harness_failed_finish_is_not_successful_partial_output', () => {
    for (const reason of ['length', 'content_filter', 'insufficient_system_resource', 'aborted']) {
      const adapter = new OpenAIAdapter();
      adapter.buildRequest(ENDPOINT, '', 'deepseek-flash', json({}));
      const events = adapter.parseStream(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'partial answer' }, finish_reason: reason }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 80 },
      })}`);
      expect(events.some(event => event.type === 'SafetyBlocked' || event.type === 'Done')).toBe(false);
      expect(events.some(event => event.type === 'Usage')).toBe(true);
      const terminal = adapter.parseStream('data: [DONE]');
      expect(terminal).toHaveLength(1);
      expect(terminal[0]!.type).toBe('SafetyBlocked');
      expect(wire((terminal[0] as Wire).value).reason).toBe(reason);
      expect(adapter.finishStream()).toHaveLength(0);
    }

    const adapter = new OpenAIAdapter();
    const events = adapter.parseStream('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}');
    expect(events.some(event => event.type === 'SafetyBlocked')).toBe(false);
  });

  it('deepseek_harness_nonofficial_transports_keep_existing_behavior', () => {
    for (const endpoint of [
      'https://api.openai.com/v1',
      'https://openrouter.ai/api/v1',
      'https://api.siliconflow.cn/v1',
      'https://proxy.example/v1',
      'https://api.deepseek.com.proxy.example/v1',
    ]) {
      const body = json({
        messages: [
          { role: 'system', content: 'first' },
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'answer', reasoning_content: 'thought' },
          { role: 'system', content: 'second' },
        ],
        top_p: 0.7,
        thinking: { type: 'disabled' },
      });
      const adapter = new OpenAIAdapter();
      const chat = wire(adapter.buildRequest(endpoint, '', 'deepseek-flash', body).body);
      expect(chat.top_p, endpoint).toBe(0.7);

      const response = wire(new OpenAIResponsesAdapter().buildRequest(endpoint, '', 'deepseek-flash', body).body);
      expect(response.top_p, endpoint).toBeUndefined();
      expect((response.input as Wire[]).some(item => item.type === 'reasoning'), endpoint).toBe(false);

      for (const reason of ['length', 'content_filter', 'provider_custom_stop']) {
        const events = adapter.parseStream(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}`);
        expect(events.some(event => event.type === 'SafetyBlocked'), `${endpoint}: ${reason}`).toBe(false);
        expect(adapter.finishStream()).toEqual([{ type: 'Done' }]);
      }
    }
  });

  it('deepseek_harness_request_modes_survive_both_transports', () => {
    for (const [enabled, effort, expectedEffort] of [
      [true, 'low', 'low'],
      [true, 'xhigh', 'high'],
      [true, 'max', 'max'],
      [false, 'max', 'none'],
    ] as const) {
      const config = apiConfig({
        model: 'deepseek-flash',
        modelAdapter: 'deepseek',
        providerType: 'deepseek',
        baseUrl: ENDPOINT,
        supportsReasoning: true,
        isReasoning: true,
        enableThinking: enabled,
        reasoningEffort: effort,
        topPOverride: 0.97,
        maxOutputTokens: 1024,
        temperature: 0.7,
      });
      const body = json({
        messages: [{ role: 'user', content: 'Explain the chart.' }],
        tools: [{
          type: 'function',
          function: { name: 'read_chart', parameters: { type: 'object', properties: {} } },
        }],
        stream: true,
        frequency_penalty: 0.5,
      });
      applyReasoningConfig(wire(body), config, enabled);
      applyGenerationParams(wire(body), config, resolveQuirks(config));

      const chat = wire(new OpenAIAdapter().buildRequest(ENDPOINT, '', config.model, body).body);
      const responses = wire(new OpenAIResponsesAdapter().buildRequest(ENDPOINT, '', config.model, body).body);

      expect(chat.max_tokens).toBe(1024);
      expect(chat.max_completion_tokens).toBeUndefined();
      expect(responses.max_output_tokens).toBe(1024);
      expect(responses.reasoning.effort).toBe(expectedEffort);
      expect(responses.thinking).toBeUndefined();
      for (const wireBody of [chat, responses]) {
        expect(wireBody.frequency_penalty).toBeUndefined();
        if (enabled) {
          expect(Math.abs(wireBody.top_p - 0.97)).toBeLessThan(0.00001);
          expect(wireBody.temperature).toBeUndefined();
        } else {
          expect(wireBody.top_p).toBeUndefined();
          expect(wireBody.temperature).toBeDefined();
        }
      }
    }
  });

  it('deepseek_harness_hosted_xhigh_keeps_legacy_max_mapping', () => {
    for (const [endpoint, provider] of [
      ['https://api.siliconflow.cn/v1', 'siliconflow'],
      ['https://proxy.example/v1', 'deepseek'],
    ] as const) {
      const config = apiConfig({
        baseUrl: endpoint,
        providerType: provider,
        model: 'deepseek-v4-flash',
        modelAdapter: 'deepseek',
        supportsReasoning: true,
        enableThinking: true,
        reasoningEffort: 'xhigh',
      });
      const body = json({});
      applyReasoningConfig(wire(body), config, true);
      expect(wire(body).reasoning_effort, endpoint).toBe('max');
      expect(applyOfficialDeepseekGenerationParams(wire(body), config), endpoint).toBe(false);
    }
  });

  it('unified_five_levels_reach_the_wire_for_official_openai', () => {
    const config = apiConfig({
      model: 'gpt-6-sol',
      modelAdapter: 'openai',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiProtocol: 'openai_chat_completions',
      supportsReasoning: true,
      isReasoning: true,
      enableThinking: true,
      reasoningEffort: 'max',
    });
    const body = json({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    applyReasoningConfig(wire(body), config, true);

    const result = wire(new OpenAIAdapter().buildRequest(config.baseUrl, '', config.model, body).body);
    expect(result.reasoning_effort).toBe('xhigh');
  });

  it('unified_five_levels_reach_the_wire_for_official_gpt6_responses', () => {
    const config = apiConfig({
      model: 'gpt-6-sol',
      modelAdapter: 'openai',
      providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      apiProtocol: 'openai_responses',
      supportsOpenaiResponses: true,
      supportsReasoning: true,
      isReasoning: true,
      enableThinking: true,
      reasoningEffort: 'max',
    });
    const body = json({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    applyReasoningConfig(wire(body), config, true);

    const result = wire(new OpenAIResponsesAdapter().buildRequest(config.baseUrl, '', config.model, body).body);
    expect(result.reasoning.effort).toBe('max');
  });

  it('unified_five_levels_reach_the_wire_for_relay_passthrough', () => {
    for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const config = apiConfig({
        model: `some-relay-gpt-6-sol-${level}`,
        modelAdapter: 'general',
        providerType: 'custom',
        providerScope: 'custom',
        baseUrl: 'https://relay.example.com/v1',
        apiProtocol: 'openai_chat_completions',
        supportsReasoning: true,
        isReasoning: true,
        enableThinking: true,
        reasoningEffort: level,
      });
      const body = json({ messages: [{ role: 'user', content: 'hi' }], stream: true });
      applyReasoningConfig(wire(body), config, true);

      const result = wire(new OpenAIAdapter().buildRequest(config.baseUrl, '', config.model, body).body);
      expect(result.reasoning_effort, level).toBe(level);
    }
  });

  it('unified_five_levels_reach_the_wire_for_official_deepseek', () => {
    const config = apiConfig({
      model: 'deepseek-v4-pro',
      modelAdapter: 'deepseek',
      providerType: 'deepseek',
      baseUrl: ENDPOINT,
      supportsReasoning: true,
      isReasoning: true,
      enableThinking: true,
      reasoningEffort: 'xhigh',
    });
    const body = json({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    applyReasoningConfig(wire(body), config, true);

    expect(wire(body).reasoning_effort).toBe('high');
  });

  it('unified_five_levels_reach_the_wire_for_glm53_and_kimi_k3', () => {
    for (const [adapter, model, endpoint] of [
      ['zhipu', 'glm-5.3', 'https://open.bigmodel.cn/api/paas/v4'],
      ['moonshot', 'kimi-k3', 'https://api.moonshot.cn/v1'],
    ] as const) {
      const config = apiConfig({
        model,
        modelAdapter: adapter,
        providerType: adapter,
        baseUrl: endpoint,
        supportsReasoning: true,
        isReasoning: true,
        enableThinking: true,
        reasoningEffort: 'medium',
      });
      const body = json({ messages: [{ role: 'user', content: 'hi' }], stream: true });
      applyReasoningConfig(wire(body), config, true);

      expect(wire(body).reasoning_effort, model).toBe('high');
    }
  });

  it('unified_five_levels_reach_the_wire_for_gemini_low', () => {
    const config = apiConfig({
      model: 'gemini-3.1-pro-preview',
      modelAdapter: 'google',
      providerType: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com',
      supportsReasoning: true,
      isReasoning: true,
      enableThinking: true,
      reasoningEffort: 'low',
    });
    const body = json({ messages: [{ role: 'user', content: 'hi' }], stream: true });
    applyReasoningConfig(wire(body), config, true);

    expect(wire(body).thinkingConfig.thinkingLevel).toBe('low');
  });
});
