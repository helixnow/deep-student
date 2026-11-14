import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../api.ts';
import { OpenAIAdapter } from '../src/providers/openai-chat.ts';
import { OpenAIResponsesAdapter } from '../src/providers/openai-responses.ts';
import { setRemoteImageFetcher } from '../src/media/remote-image.ts';
import { createRecordingLogger } from './recording-logger.ts';
import {
  ANTHROPIC_CACHE_BREAKPOINT_BUDGET, AnthropicAdapter, buildUsageEvent, claudeGeneration,
  convertAnthropicResponseToOpenai, enforceAnthropicCacheBreakpointBudget, mapBudgetTokensToEffort,
  type AnthropicTool,
} from '../src/providers/anthropic.ts';

/**
 * Test-only deep view of wire JSON. Production signatures stay JsonValue/JsonObject;
 * every assertion still compares real runtime values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = any;

const convert = (adapter: AnthropicAdapter, model: string, body: unknown): Wire =>
  adapter.convertOpenaiToAnthropic(model, body as JsonValue);
const wire = (value: JsonValue): Wire => value as Wire;

const ephemeral = (): JsonObject => ({ type: 'ephemeral' });
const ephemeralWithTtl = (): JsonObject => ({ type: 'ephemeral', ttl: '1h' });
const makeTool = (name: string, marker?: JsonValue): AnthropicTool =>
  marker === undefined ? { name, input_schema: { type: 'object' } } : { name, input_schema: { type: 'object' }, cache_control: marker };
const systemBlock = (text: string, marker?: JsonValue): JsonObject =>
  marker === undefined ? { type: 'text', text } : { type: 'text', text, cache_control: marker };

describe('anthropic adapter', () => {
  it('stream_completion_requirement_matches_adapter_protocols', () => {
    expect(new OpenAIResponsesAdapter().requiresExplicitStreamCompletion()).toBe(true);
    expect(new OpenAIAdapter().requiresExplicitStreamCompletion()).toBe(true);
    expect(new AnthropicAdapter().requiresExplicitStreamCompletion()).toBe(true);
  });

  it('claude_generation_matches_model_families', () => {
    expect(claudeGeneration('claude-opus-4-8')).toBe('adaptive');
    expect(claudeGeneration('claude-sonnet-5')).toBe('adaptive');
    expect(claudeGeneration('claude-fable-5')).toBe('adaptive');
    expect(claudeGeneration('anthropic.claude-opus-4-8')).toBe('adaptive');
    expect(claudeGeneration('claude-sonnet-4-5-20250929')).toBe('manual');
    expect(claudeGeneration('claude-3-7-sonnet')).toBe('manual');
    expect(claudeGeneration('claude-haiku-4-5')).toBe('manual');
    expect(claudeGeneration('claude-2')).toBe('unsupported');
    expect(claudeGeneration('gpt-4o')).toBe('unsupported');
    expect(mapBudgetTokensToEffort(10240)).toBe('medium');
    expect(mapBudgetTokensToEffort(4096)).toBe('low');
    expect(mapBudgetTokensToEffort(20000)).toBe('high');
    expect(mapBudgetTokensToEffort(40000)).toBe('max');
  });

  it('anthropic_uses_output_config_format_for_structured_output', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-4-5', {
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    });
    expect(request.response_format).toBeUndefined();
    expect(request.output_config.format.type).toBe('json');
  });

  it('anthropic_thinking_with_tools_forces_auto_tool_choice', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-4-5', {
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 2048 },
      tools: [{ type: 'function', function: { name: 'lookup_weather', description: 'lookup', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
    });
    expect(request.tool_choice).toEqual({ type: 'auto' });
  });

  it('anthropic_preserves_inline_tool_use_blocks_from_assistant_content', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-4-5', {
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'need a tool' },
          { type: 'tool_use', id: 'toolu_123', name: 'lookup_weather', input: { city: 'Paris' } },
          { type: 'text', text: 'Calling tool now.' },
        ],
      }],
    });
    const content = request.messages[0].content;
    expect(content.some((block: Wire) => block.type === 'tool_use' && block.id === 'toolu_123'
      && block.name === 'lookup_weather' && block.input.city === 'Paris')).toBe(true);
  });

  it('anthropic_adds_tools_and_system_tail_cache_breakpoints', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [
        { role: 'system', content: 'stable instructions' },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        { type: 'function', function: { name: 'alpha_tool', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'beta_tool', parameters: { type: 'object' } } },
      ],
    });
    expect(request.cache_control).toEqual(ephemeral());
    const system = request.system;
    expect(system).toHaveLength(1);
    expect(system[0]).toEqual({ type: 'text', text: 'stable instructions', cache_control: ephemeral() });
    const tools = request.tools;
    expect(tools).toHaveLength(2);
    expect(Object.hasOwn(tools[0], 'cache_control')).toBe(false);
    expect(tools[1]!.cache_control).toEqual(ephemeral());
  });

  it('anthropic_preserves_caller_block_level_system_cache_control', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'stable prefix', cache_control: ephemeral() },
            { type: 'text', text: 'volatile suffix' },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
    });
    const system = request.system;
    expect(system).toHaveLength(2);
    expect(system[0].cache_control).toEqual(ephemeral());
    expect(Object.hasOwn(system[1], 'cache_control')).toBe(false);
  });

  it('anthropic_tool_cache_control_passthrough_suppresses_tail_breakpoint', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', cache_control: ephemeral(), function: { name: 'alpha_tool', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'beta_tool', parameters: { type: 'object' } } },
      ],
    });
    const tools = request.tools;
    expect(tools).toHaveLength(2);
    expect(tools[0]!.cache_control).toEqual(ephemeral());
    expect(Object.hasOwn(tools[1], 'cache_control')).toBe(false);
  });

  it('anthropic_cache_breakpoint_budget_keeps_full_four_slots', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'stable prefix', cache_control: ephemeral() },
            { type: 'text', text: 'stable tail', cache_control: ephemeral() },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', function: { name: 'alpha_tool', parameters: { type: 'object' } } }],
    });
    expect(request.cache_control).toEqual(ephemeral());
    expect(request.tools[0].cache_control).toEqual(ephemeral());
    expect(request.system[0].cache_control).toEqual(ephemeral());
    expect(request.system[1].cache_control).toEqual(ephemeral());
  });

  it('anthropic_cache_breakpoint_budget_strips_earliest_markers_on_overflow', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 's1', cache_control: ephemeral() },
            { type: 'text', text: 's2', cache_control: ephemeral() },
            { type: 'text', text: 's3', cache_control: ephemeral() },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        { type: 'function', cache_control: ephemeral(), function: { name: 'alpha_tool', parameters: { type: 'object' } } },
        { type: 'function', cache_control: ephemeral(), function: { name: 'beta_tool', parameters: { type: 'object' } } },
      ],
    });
    expect(request.cache_control).toEqual(ephemeral());
    expect(Object.hasOwn(request.tools[0], 'cache_control')).toBe(false);
    expect(Object.hasOwn(request.tools[1], 'cache_control')).toBe(false);
    expect(request.system.map((block: { cache_control?: unknown }) => block.cache_control)).toEqual([ephemeral(), ephemeral(), ephemeral()]);
  });

  it('anthropic_build_usage_event_collects_cached_tokens', () => {
    const event = buildUsageEvent({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    }) as Wire;
    expect(event.cached_tokens).toBe(30);
    expect(event.cache_write_tokens).toBe(20);
  });

  it('build_usage_event_reads_responses_details', () => {
    const event = buildUsageEvent({
      input_tokens: 1200,
      output_tokens: 300,
      total_tokens: 1500,
      input_tokens_details: { cached_tokens: 1024, cache_write_tokens: 128 },
      output_tokens_details: { reasoning_tokens: 90 },
    }) as Wire;
    expect(event.input_tokens).toBe(1200);
    expect(event.output_tokens).toBe(300);
    expect(event.cached_tokens).toBe(1024);
    expect(event.cache_write_tokens).toBe(128);
    expect(event.reasoning_tokens).toBe(90);
  });

  it('build_usage_event_preserves_observed_zero_cache_values', () => {
    const event = buildUsageEvent({
      input_tokens: 10, output_tokens: 5,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    }) as Wire;
    expect(event.cached_tokens).toBe(0);
    expect(event.cache_write_tokens).toBe(0);
    const unmeasured = buildUsageEvent({ input_tokens: 10, output_tokens: 5 }) as Wire;
    expect(unmeasured.cached_tokens).toBeNull();
    expect(unmeasured.cache_write_tokens).toBeNull();
  });

  it('anthropic_new_generation_strips_sampling_params_unconditionally', () => {
    const body = {
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7, top_p: 0.9, top_k: 40,
    };
    const adapter = new AnthropicAdapter();
    const adaptive = convert(adapter, 'claude-opus-4-8', body);
    expect(adaptive.temperature).toBeUndefined();
    expect(adaptive.top_p).toBeUndefined();
    expect(adaptive.top_k).toBeUndefined();
    const legacy = convert(adapter, 'claude-sonnet-4-5', body);
    expect(legacy.temperature).toBe(0.7);
    expect(legacy.top_p).toBeUndefined();
    expect(legacy.top_k).toBe(40);
  });

  it('anthropic_new_generation_rewrites_enabled_thinking_to_adaptive', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 10240 },
    });
    expect(request.thinking).toEqual({ type: 'adaptive' });
    expect(request.output_config.effort).toBe('medium');
  });

  it('anthropic_old_generation_keeps_enabled_thinking_passthrough', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-4-5', {
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 2048 },
    });
    expect(request.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('anthropic_parse_stream_accumulates_signature_delta', () => {
    const adapter = new AnthropicAdapter();
    expect(adapter.parseStream('data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}')).toEqual([]);
    expect(adapter.parseStream('data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCg"}}')).toEqual([]);
    expect(adapter.parseStream('data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"XYZ123"}}')).toEqual([]);
    const stop = adapter.parseStream('data: {"type":"content_block_stop","index":0}');
    expect(stop[0]).toEqual({ type: 'ThoughtSignature', value: 'EqQBCgXYZ123' });
  });

  it('anthropic_parse_stream_accepts_event_and_data_sse_blocks', () => {
    const events = new AnthropicAdapter().parseStream(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"framed"}}');
    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'framed' });
  });

  it('anthropic_parse_stream_accepts_bare_ndjson', () => {
    const events = new AnthropicAdapter().parseStream(
      '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ndjson"}}');
    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'ndjson' });
  });

  it('anthropic_parse_stream_merges_input_tokens_from_message_start', () => {
    const adapter = new AnthropicAdapter();
    const start = adapter.parseStream(
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":123,"output_tokens":0}}}');
    expect(start[0]).toMatchObject({ type: 'Usage' });
    expect((start[0] as Wire).value.input_tokens).toBe(123);
    const delta = adapter.parseStream(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}');
    expect((delta[0] as Wire).value.input_tokens).toBe(123);
    expect((delta[0] as Wire).value.output_tokens).toBe(42);
  });

  it('anthropic_parse_stream_merges_cache_fields_from_message_start', () => {
    const adapter = new AnthropicAdapter();
    const start = adapter.parseStream(
      'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"cache_read_input_tokens":900,"cache_creation_input_tokens":50,"output_tokens":0}}}');
    expect((start[0] as Wire).value.cached_tokens).toBe(900);
    expect((start[0] as Wire).value.cache_write_tokens).toBe(50);
    const delta = adapter.parseStream(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}');
    const merged = (delta[0] as Wire).value;
    expect(merged.input_tokens).toBe(10);
    expect(merged.output_tokens).toBe(42);
    expect(merged.cached_tokens).toBe(900);
    expect(merged.cache_write_tokens).toBe(50);
    expect(adapter.parseStream('data: {"type":"message_stop"}')).toEqual([{ type: 'Done' }]);
    const next = adapter.parseStream(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}');
    expect((next[0] as Wire).value.output_tokens).toBe(7);
    expect((next[0] as Wire).value.cached_tokens).toBeNull();
  });

  it('anthropic_merged_usage_prefers_terminal_nonzero_fields', () => {
    const adapter = new AnthropicAdapter();
    adapter.parseStream('data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"cache_read_input_tokens":900}}}');
    const delta = adapter.parseStream(
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42,"cache_read_input_tokens":1200}}');
    const usage = (delta[0] as Wire).value;
    expect(usage.cached_tokens).toBe(1200);
    expect(usage.input_tokens).toBe(10);
  });

  it('convert_anthropic_response_passes_cache_fields', () => {
    const converted = convertAnthropicResponseToOpenai({
      type: 'message',
      id: 'msg_1',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 },
    }, 'claude-test') as Wire;
    expect(converted.usage.prompt_tokens).toBe(10);
    expect(converted.usage.completion_tokens).toBe(20);
    expect(converted.usage.cache_read_input_tokens).toBe(900);
    expect(converted.usage.cache_creation_input_tokens).toBe(50);
    expect(converted.choices[0].finish_reason).toBe('stop');
  });

  it('anthropic_parse_stream_surfaces_error_event', () => {
    const { logger, messages } = createRecordingLogger();
    const events = new AnthropicAdapter(logger).parseStream(
      'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    expect((events[0] as Wire).type).toBe('SafetyBlocked');
    expect((events[0] as Wire).value.type).toBe('provider_error');
    expect(events.at(-1)).toEqual({ type: 'Done' });
    expect(messages).toEqual([{
      level: 'error',
      message: '[AnthropicAdapter] Stream error event: %s',
      args: ['{"type":"overloaded_error","message":"Overloaded"}'],
    }]);
  });

  it('anthropic_parse_stream_maps_new_stop_reasons', () => {
    const adapter = new AnthropicAdapter();
    const refusal = adapter.parseStream(
      'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"category":"cyber"}}}');
    expect((refusal[0] as Wire).value.type).toBe('content_blocked');
    expect((refusal[0] as Wire).value.reason).toBe('refusal');
    expect((refusal[0] as Wire).value.stop_details.category).toBe('cyber');
    const exceeded = adapter.parseStream(
      'data: {"type":"message_delta","delta":{"stop_reason":"model_context_window_exceeded"}}');
    expect((exceeded[0] as Wire).value.type).toBe('provider_error');
    expect((exceeded[0] as Wire).value.reason).toBe('model_context_window_exceeded');
  });

  it('anthropic_assistant_thinking_blocks_keep_signature_and_redacted', () => {
    const request = convert(new AnthropicAdapter(), 'claude-fable-5', {
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoned', signature: 'sig_full' },
          { type: 'thinking', thinking: '', signature: 'sig_omitted' },
          { type: 'redacted_thinking', data: 'opaque_payload' },
          { type: 'text', text: 'answer' },
        ],
      }],
    });
    const content = request.messages[0].content;
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'reasoned', signature: 'sig_full' });
    expect(content[1]).toEqual({ type: 'thinking', thinking: '', signature: 'sig_omitted' });
    expect(content[2]).toEqual({ type: 'redacted_thinking', data: 'opaque_payload' });
  });

  it('anthropic_message_level_thought_signature_attaches_to_thinking_block', () => {
    const adapter = new AnthropicAdapter();
    const first = convert(adapter, 'claude-sonnet-5', {
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me call a tool' },
          { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
        ],
        thought_signature: 'sig_round_1',
      }],
    });
    expect(first.messages[0].content[0].type).toBe('thinking');
    expect(first.messages[0].content[0].signature).toBe('sig_round_1');
    const second = convert(adapter, 'claude-sonnet-5', {
      messages: [{
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'toolu_2', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
        thought_signature: 'sig_round_2',
      }],
    });
    const content = second.messages[0].content;
    expect(content[0]).toEqual({ type: 'thinking', thinking: '', signature: 'sig_round_2' });
    expect(content[1].type).toBe('tool_use');
  });

  it('anthropic_beta_headers_cleaned_up', () => {
    const adapter = new AnthropicAdapter();
    const legacy = adapter.buildRequest('https://api.anthropic.com', 'key', 'claude-sonnet-4-5', {
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 2048 },
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    });
    expect(legacy.headers.find(([key]) => key === 'anthropic-beta')?.[1]).toBe('interleaved-thinking-2025-05-14');
    const adaptive = adapter.buildRequest('https://api.anthropic.com', 'key', 'claude-opus-4-8', {
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
      effort: 'high',
      tools: [{ type: 'function', function: { name: 'lookup', parameters: {} } }],
    });
    expect(adaptive.headers.some(([key]) => key === 'anthropic-beta')).toBe(false);
    for (const [, value] of legacy.headers) {
      expect(value).not.toContain('thinking-2024-07-31');
      expect(value).not.toContain('tools-2024-04-04');
      expect(value).not.toContain('prompt-caching-2024-07-31');
    }
  });

  it('anthropic_json_schema_output_uses_ga_schema_field', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [{ role: 'user', content: 'hi' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: { type: 'object', properties: {}, additionalProperties: false },
          strict: true,
        },
      },
    });
    const format = request.output_config.format;
    expect(format.type).toBe('json_schema');
    expect(format.schema.type).toBe('object');
    expect(format.json_schema).toBeUndefined();
  });
});

describe('anthropic cache breakpoint budget guard', () => {
  it('budget_constant_matches_anthropic_hard_limit', () => {
    expect(ANTHROPIC_CACHE_BREAKPOINT_BUDGET).toBe(4);
  });

  it('guard_noop_when_block_markers_within_budget', () => {
    const tools = [makeTool('alpha'), makeTool('beta', ephemeral())];
    const system = [systemBlock('s1', ephemeral()), systemBlock('s2'), systemBlock('s3', ephemeral())];
    enforceAnthropicCacheBreakpointBudget(tools, system);
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toEqual(ephemeral());
    expect(system[0]!.cache_control).toEqual(ephemeral());
    expect(Object.hasOwn(system[1]!, 'cache_control')).toBe(false);
    expect(system[2]!.cache_control).toEqual(ephemeral());
  });

  it('guard_without_tools_keeps_system_markers_within_budget', () => {
    const system = [systemBlock('s1', ephemeral()), systemBlock('s2', ephemeral()), systemBlock('s3', ephemeral())];
    enforceAnthropicCacheBreakpointBudget(undefined, system);
    expect(system.filter(block => Object.hasOwn(block, 'cache_control'))).toHaveLength(3);
  });

  it('guard_without_tools_strips_earliest_system_markers_on_overflow', () => {
    const system = [
      systemBlock('s1', ephemeral()), systemBlock('s2', ephemeral()), systemBlock('s3', ephemeral()),
      systemBlock('s4', ephemeral()), systemBlock('s5', ephemeral()),
    ];
    enforceAnthropicCacheBreakpointBudget(undefined, system);
    expect(Object.hasOwn(system[0]!, 'cache_control')).toBe(false);
    expect(Object.hasOwn(system[1]!, 'cache_control')).toBe(false);
    expect(system[2]!.cache_control).toEqual(ephemeral());
    expect(system[3]!.cache_control).toEqual(ephemeral());
    expect(system[4]!.cache_control).toEqual(ephemeral());
  });

  it('guard_strips_earliest_tool_markers_and_leaves_no_null_on_serialize', () => {
    const tools = [makeTool('t1', ephemeral()), makeTool('t2', ephemeral()), makeTool('t3', ephemeral()), makeTool('t4', ephemeral())];
    const system = [systemBlock('s1')];
    enforceAnthropicCacheBreakpointBudget(tools, system);
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools.filter(tool => Object.hasOwn(tool, 'cache_control'))).toHaveLength(3);
    expect(tools[3]!.cache_control).toEqual(ephemeral());
    expect(JSON.stringify(tools[0])).not.toContain('cache_control');
    expect(JSON.stringify(tools[3])).toContain('"cache_control":{"type":"ephemeral"}');
  });

  it('guard_overflow_crosses_from_tools_into_system', () => {
    const tools = [makeTool('t1', ephemeral())];
    const system = [systemBlock('s1', ephemeral()), systemBlock('s2', ephemeral()), systemBlock('s3', ephemeral()), systemBlock('s4', ephemeral())];
    enforceAnthropicCacheBreakpointBudget(tools, system);
    expect(tools.filter(tool => Object.hasOwn(tool, 'cache_control'))).toHaveLength(0);
    expect(Object.hasOwn(system[0]!, 'cache_control')).toBe(false);
    expect(system[1]!.cache_control).toEqual(ephemeral());
    expect(system[2]!.cache_control).toEqual(ephemeral());
    expect(system[3]!.cache_control).toEqual(ephemeral());
  });

  it('guard_preserves_surviving_marker_payload_verbatim', () => {
    const tools = [makeTool('t1', ephemeral()), makeTool('t2', ephemeralWithTtl())];
    const system = [systemBlock('s1', ephemeral()), systemBlock('s2', ephemeralWithTtl())];
    enforceAnthropicCacheBreakpointBudget(tools, system);
    expect(tools[0]!.cache_control).toBeUndefined();
    expect(tools[1]!.cache_control).toEqual(ephemeralWithTtl());
    expect(system[0]!.cache_control).toEqual(ephemeral());
    expect(system[1]!.cache_control).toEqual(ephemeralWithTtl());
  });

  it('guard_handles_empty_inputs_without_panic', () => {
    const tools: AnthropicTool[] = [];
    const system: JsonObject[] = [];
    enforceAnthropicCacheBreakpointBudget(tools, system);
    expect(tools).toHaveLength(0);
    expect(system).toHaveLength(0);
  });

  it('anthropic_tool_marker_passthrough_keeps_position_and_payload', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'alpha_tool', parameters: { type: 'object' } } },
        { type: 'function', cache_control: ephemeralWithTtl(), function: { name: 'beta_tool', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'gamma_tool', parameters: { type: 'object' } } },
      ],
    });
    expect(request.cache_control).toEqual(ephemeral());
    const tools = request.tools;
    expect(tools).toHaveLength(3);
    expect(Object.hasOwn(tools[0], 'cache_control')).toBe(false);
    expect(tools[1]!.cache_control).toEqual(ephemeralWithTtl());
    expect(Object.hasOwn(tools[2], 'cache_control')).toBe(false);
  });

  it('anthropic_marker_nested_in_function_object_is_not_a_tool_marker', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'alpha_tool',
          cache_control: ephemeralWithTtl(),
          parameters: { type: 'object' },
        },
      }],
    });
    const tools = request.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.cache_control).toEqual(ephemeral());
  });

  it('anthropic_dropped_tool_entry_marker_has_no_side_effects', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'custom', cache_control: ephemeral(), function: { name: 'dropped_tool', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'alpha_tool', parameters: { type: 'object' } } },
      ],
    });
    const tools = request.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('alpha_tool');
    expect(tools[0]!.cache_control).toEqual(ephemeral());
  });

  it('anthropic_all_invalid_tools_yield_no_tools_key', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [
        { role: 'system', content: 'stable instructions' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'custom', cache_control: ephemeral(), function: { name: 'dropped_tool', parameters: { type: 'object' } } }],
    });
    expect(request).not.toHaveProperty('tools');
    expect(request.cache_control).toEqual(ephemeral());
    expect(request.system[0].cache_control).toEqual(ephemeral());
  });

  it('anthropic_auto_tools_tail_breakpoint_yields_to_caller_system_markers', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 's1', cache_control: ephemeral() },
            { type: 'text', text: 's2', cache_control: ephemeral() },
            { type: 'text', text: 's3', cache_control: ephemeral() },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
      tools: [
        { type: 'function', function: { name: 'alpha_tool', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'beta_tool', parameters: { type: 'object' } } },
      ],
    });
    expect(request.cache_control).toEqual(ephemeral());
    expect(Object.hasOwn(request.tools[0], 'cache_control')).toBe(false);
    expect(Object.hasOwn(request.tools[1], 'cache_control')).toBe(false);
    expect(request.system.map((block: { cache_control?: unknown }) => block.cache_control)).toEqual([ephemeral(), ephemeral(), ephemeral()]);
  });

  it('anthropic_passthrough_marker_survives_budget_guard_within_budget', () => {
    const request = convert(new AnthropicAdapter(), 'claude-sonnet-5', {
      messages: [
        { role: 'system', content: 'stable instructions' },
        { role: 'user', content: 'hi' },
      ],
      tools: [{
        type: 'function',
        cache_control: ephemeralWithTtl(),
        function: { name: 'alpha_tool', parameters: { type: 'object' } },
      }],
    });
    expect(request.cache_control).toEqual(ephemeral());
    expect(request.tools[0].cache_control).toEqual(ephemeralWithTtl());
    expect(request.system[0].cache_control).toEqual(ephemeral());
  });
});

// ============================================================
// Wave2-A R7 #7：前缀段字节稳定性
// ============================================================

const systemMessage = (): JsonValue => ({
  role: 'system',
  content: '你是 Deep Student 的学习助手。回答保持简洁，需要资料时优先调用工具检索。',
});

const toolDefinitions = (): JsonValue[] => [
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: '按关键词检索本地笔记',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_card',
      description: '创建一张 Anki 卡片',
      parameters: {
        type: 'object',
        properties: { front: { type: 'string' }, back: { type: 'string' } },
        required: ['front', 'back'],
      },
    },
  },
  { type: 'function', function: { name: 'list_decks', description: '列出全部牌组' } },
];

const firstTurnMessages = (): JsonValue[] => [{ role: 'user', content: '帮我总结昨天的错题' }];

const secondTurnMessages = (): JsonValue[] => {
  const messages = firstTurnMessages();
  messages.push({
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"query":"错题"}' } }],
  });
  messages.push({
    role: 'tool',
    tool_call_id: 'call_1',
    content: '共 3 道错题：一元二次方程、余弦定理、电磁感应',
  });
  messages.push({ role: 'user', content: '把第一道整理成卡片' });
  return messages;
};

const requestBody = (turnMessages: JsonValue[]): JsonValue => ({
  messages: [systemMessage(), ...turnMessages],
  tools: toolDefinitions(),
  tool_choice: 'auto',
  stream: true,
  max_tokens: 2048,
});

/** serde_json::to_vec equivalent: deterministic JSON text of one segment. */
const segmentBytes = (label: string, segment: JsonValue | undefined): string => {
  expect(segment, `${label} 段缺失`).not.toBeUndefined();
  expect(segment).not.toBeNull();
  return JSON.stringify(segment);
};

const assertSegmentByteIdentical = (label: string, first: JsonValue | undefined, second: JsonValue | undefined): void => {
  expect(segmentBytes(label, first), `${label} 稳定前缀段应逐字节相等`).toBe(segmentBytes(label, second));
};

describe('prefix snapshot stability', () => {
  it('openai_chat_prefix_segments_byte_identical_across_consecutive_requests', () => {
    const adapter = new OpenAIAdapter();
    const first = adapter.buildRequest('https://api.openai.com/v1', 'sk-test', 'gpt-4.1', requestBody(firstTurnMessages()));
    const second = adapter.buildRequest('https://api.openai.com/v1', 'sk-test', 'gpt-4.1', requestBody(secondTurnMessages()));
    const firstBody = first.body as Wire;
    const secondBody = second.body as Wire;
    expect(firstBody.messages[0].role).toBe('system');
    assertSegmentByteIdentical('OpenAI chat system 消息', firstBody.messages[0], secondBody.messages[0]);
    assertSegmentByteIdentical('OpenAI chat tools', firstBody.tools, secondBody.tools);
    expect(firstBody.tools).toHaveLength(3);
    expect(firstBody.tools[2].function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('openai_responses_developer_breakpoint_prefix_byte_identical_across_consecutive_requests', () => {
    const first = wire(OpenAIResponsesAdapter.convertToResponsesFormatForEndpoint(
      'gpt-5.6', requestBody(firstTurnMessages()), 'https://api.openai.com/v1'));
    const second = wire(OpenAIResponsesAdapter.convertToResponsesFormatForEndpoint(
      'gpt-5.6', requestBody(secondTurnMessages()), 'https://api.openai.com/v1'));
    expect(first.input[0].role).toBe('developer');
    expect(first.input[0].content[0].prompt_cache_breakpoint.mode).toBe('explicit');
    assertSegmentByteIdentical('OpenAI Responses developer 断点块', first.input[0], second.input[0]);
    assertSegmentByteIdentical('OpenAI Responses tools', first.tools, second.tools);
    expect((first.tools as Wire)[0].type).toBe('function');
    expect((second.input as Wire[]).length).toBeGreaterThan((first.input as Wire[]).length);
  });

  it('anthropic_system_and_tools_prefix_byte_identical_across_consecutive_requests', () => {
    const adapter = new AnthropicAdapter();
    const first = adapter.convertOpenaiToAnthropic('claude-fable-5', requestBody(firstTurnMessages()));
    const second = adapter.convertOpenaiToAnthropic('claude-fable-5', requestBody(secondTurnMessages()));
    assertSegmentByteIdentical('Anthropic system', first.system, second.system);
    const system = first.system as Wire[];
    expect(system.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    assertSegmentByteIdentical('Anthropic tools', first.tools, second.tools);
    const tools = first.tools as Wire[];
    expect(tools).toHaveLength(3);
    expect(tools.at(-1)?.cache_control).toEqual({ type: 'ephemeral' });
    expect(tools.slice(0, -1).every(tool => !Object.hasOwn(tool, 'cache_control'))).toBe(true);
  });

  it('deepseek_chat_prefix_segments_byte_identical_across_consecutive_requests', () => {
    const adapter = new OpenAIAdapter();
    const first = adapter.buildRequest('https://api.deepseek.com/v1', 'sk-test', 'deepseek-chat', requestBody(firstTurnMessages()));
    const second = adapter.buildRequest('https://api.deepseek.com/v1', 'sk-test', 'deepseek-chat', requestBody(secondTurnMessages()));
    const firstBody = first.body as Wire;
    const secondBody = second.body as Wire;
    assertSegmentByteIdentical('DeepSeek chat system 消息', firstBody.messages[0], secondBody.messages[0]);
    assertSegmentByteIdentical('DeepSeek chat tools', firstBody.tools, secondBody.tools);
    expect(firstBody.stream_options).toBeUndefined();
  });

  it('deepseek_responses_instructions_prefix_byte_identical_across_consecutive_requests', () => {
    const first = wire(OpenAIResponsesAdapter.convertToResponsesFormatForEndpoint(
      'deepseek-v4-flash', requestBody(firstTurnMessages()), 'https://api.deepseek.com/v1'));
    const second = wire(OpenAIResponsesAdapter.convertToResponsesFormatForEndpoint(
      'deepseek-v4-flash', requestBody(secondTurnMessages()), 'https://api.deepseek.com/v1'));
    assertSegmentByteIdentical('DeepSeek Responses instructions', first.instructions, second.instructions);
    expect(typeof first.instructions).toBe('string');
    expect((first.input as Wire[])[0].role).toBe('user');
    assertSegmentByteIdentical('DeepSeek Responses tools', first.tools, second.tools);
  });

  it('reconverting_identical_body_is_fully_byte_deterministic_for_all_three_providers', () => {
    const body = requestBody(firstTurnMessages());
    const openai = new OpenAIAdapter();
    const openaiFirst = openai.buildRequest('https://api.openai.com/v1', 'sk-test', 'gpt-4.1', body).body;
    const openaiSecond = openai.buildRequest('https://api.openai.com/v1', 'sk-test', 'gpt-4.1', body).body;
    expect(segmentBytes('OpenAI 全量 body', openaiFirst)).toBe(segmentBytes('OpenAI 全量 body', openaiSecond));

    const anthropic = new AnthropicAdapter();
    const anthropicFirst = anthropic.convertOpenaiToAnthropic('claude-fable-5', body);
    const anthropicSecond = anthropic.convertOpenaiToAnthropic('claude-fable-5', body);
    expect(segmentBytes('Anthropic 全量 body', anthropicFirst)).toBe(segmentBytes('Anthropic 全量 body', anthropicSecond));

    const deepseekFirst = wire(OpenAIResponsesAdapter.convertToResponsesFormatForEndpoint('deepseek-v4-flash', body, 'https://api.deepseek.com/v1'));
    const deepseekSecond = wire(OpenAIResponsesAdapter.convertToResponsesFormatForEndpoint('deepseek-v4-flash', body, 'https://api.deepseek.com/v1'));
    expect(segmentBytes('DeepSeek Responses 全量 body', deepseekFirst)).toBe(segmentBytes('DeepSeek Responses 全量 body', deepseekSecond));
  });
});

describe('anthropic image payloads and tool input fidelity', () => {
  it('create_base64_payload_resolves_remote_images_through_injected_cache', () => {
    setRemoteImageFetcher({
      fetchImage: url => url === 'https://example.com/cat.png'
        ? { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }
        : undefined,
    });
    try {
      const converted = convert(new AnthropicAdapter(), 'claude-sonnet-4-5', {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        }],
      }) as Wire;
      const image = (converted.messages[0].content as Wire[]).find(block => block.type === 'image');
      expect(image.source).toEqual({
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from([1, 2, 3]).toString('base64'),
      });
    } finally {
      setRemoteImageFetcher(null);
    }
  });

  it('create_base64_payload_drops_remote_images_when_cache_misses', () => {
    setRemoteImageFetcher({ fetchImage: () => undefined });
    try {
      const converted = convert(new AnthropicAdapter(), 'claude-sonnet-4-5', {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
          ],
        }],
      }) as Wire;
      expect((converted.messages[0].content as Wire[]).some(block => block.type === 'image')).toBe(false);
    } finally {
      setRemoteImageFetcher(null);
    }
  });

  it('convert_assistant_message_preserves_null_tool_arguments', () => {
    const converted = convert(new AnthropicAdapter(), 'claude-sonnet-4-5', {
      messages: [{
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: 'null' } }],
      }],
    }) as Wire;
    expect(converted.messages[0].content[0]).toEqual({ type: 'tool_use', id: 'call_1', name: 'lookup', input: null });
  });

  it('convert_anthropic_response_to_openai_preserves_null_tool_input', () => {
    const converted = wire(convertAnthropicResponseToOpenai({
      type: 'message',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: null }],
      stop_reason: 'tool_use',
    }, 'claude-sonnet-4-5')!);
    expect(converted.choices[0].message.tool_calls[0].function.arguments).toBe('null');
  });
});
