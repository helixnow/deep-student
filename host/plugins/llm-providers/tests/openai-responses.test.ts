import { describe, expect, it } from 'vitest';
import type { JsonValue, StreamEvent } from '../api.ts';
import { SseEventBuffer } from '../../../platform/util/api.ts';
import { OpenAIAdapter } from '../src/providers/openai-chat.ts';
import { OpenAIResponsesAdapter } from '../src/providers/openai-responses.ts';
import { createRecordingLogger } from './recording-logger.ts';

/**
 * Test-only deep view of the adapter's wire JSON. Production signatures stay
 * JsonValue/JsonObject; every assertion below still compares real runtime values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = any;

const wire = (value: JsonValue): Wire => value as Wire;
const convert = (model: string, body: unknown): Wire =>
  wire(OpenAIResponsesAdapter.convertToResponsesFormat(model, body as JsonValue));
const convertForEndpoint = (model: string, body: unknown, baseUrl: string): Wire =>
  wire(OpenAIResponsesAdapter.convertToResponsesFormatForEndpoint(model, body as JsonValue, baseUrl));
const wireValue = (event: StreamEvent): Wire => wire((event as { value?: JsonValue }).value ?? null);

const messages = (...items: JsonValue[]): JsonValue => ({ messages: items });

describe('openai responses adapter', () => {
  it('openai_responses_adapter_converts_messages_and_reasoning', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } },
        ] },
      ],
      max_tokens: 256, temperature: 0.2, response_format: { type: 'json_object' },
    };
    const payload = convert('gpt-5.2', body);
    expect(payload.stream).toBe(true);
    expect(payload.instructions).toBe('You are helpful.');
    expect(payload.reasoning.summary).toBe('auto');
    expect(payload.max_output_tokens).toBe(256);
    expect(payload.temperature).toBe(0.2);
    expect(payload.text.format.type).toBe('json_object');
    const input = payload.input;
    expect(input).toHaveLength(1);
    expect(input[0].role).toBe('user');
    expect(input[0].content[0].type).toBe('input_text');
    expect(input[0].content[1].type).toBe('input_image');
  });

  it('openai_responses_adapter_maps_reasoning_effort_and_verbosity', () => {
    const payload = convert('gpt-5', { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high', verbosity: 'low' });
    expect(payload.reasoning).toEqual({ effort: 'high', summary: 'auto' });
    expect(payload.text).toEqual({ verbosity: 'low' });
  });

  it('openai_responses_adapter_maps_runtime_off_to_reasoning_none', () => {
    const payload = convert('gpt-5', { messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'none' });
    expect(payload.reasoning).toEqual({ effort: 'none', summary: 'auto' });
  });

  it('openai_responses_adapter_preserves_known_provider_thinking_extensions', () => {
    for (const [model, baseUrl, extension] of [
      ['qwen3.7-plus', 'https://dashscope.aliyuncs.com/compatible-mode/v1', { enable_thinking: true, thinking_budget: 8192 }],
      ['doubao-seed-1-6-thinking', 'https://ark.cn-beijing.volces.com/api/v3', { thinking: { type: 'enabled' } }],
      ['ernie-5.0-thinking', 'https://qianfan.baidubce.com/v2', { thinking: { type: 'enabled' } }],
    ] as const) {
      const payload = convertForEndpoint(model, { messages: [{ role: 'user', content: 'hi' }], ...extension }, baseUrl);
      for (const key of ['thinking', 'enable_thinking', 'thinking_budget'] as const) expect(payload[key], `model=${model}, key=${key}`).toEqual((extension as Record<string, JsonValue>)[key]);
    }
  });

  it('openai_responses_adapter_drops_provider_thinking_extensions_for_openai', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled' }, enable_thinking: true, thinking_budget: 8192 };
    const payload = convert('gpt-5.2', body);
    const alias = convertForEndpoint('ep-openai-alias', body, 'https://api.openai.com/v1');
    for (const key of ['thinking', 'enable_thinking', 'thinking_budget']) {
      expect(Object.hasOwn(payload, key)).toBe(false);
      expect(Object.hasOwn(alias, key)).toBe(false);
    }
  });

  it('openai_responses_adapter_preserves_extensions_for_provider_deployment_alias', () => {
    const payload = convertForEndpoint('ep-20260714-abcd',
      { messages: [{ role: 'user', content: 'hi' }], thinking: { type: 'enabled' }, thinking_budget: 8192 },
      'https://ark.cn-beijing.volces.com/api/v3');
    expect(payload.thinking).toEqual({ type: 'enabled' });
    expect(payload.thinking_budget).toBe(8192);
  });

  it('openai_responses_adapter_preserves_extensions_for_dashscope_intl', () => {
    const payload = convertForEndpoint('deployment-alias',
      { messages: [{ role: 'user', content: 'hi' }], enable_thinking: true, thinking_budget: 8192 },
      'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
    expect(payload.enable_thinking).toBe(true);
    expect(payload.thinking_budget).toBe(8192);
  });

  it('openai_responses_adapter_preserves_extensions_for_qwen_workspace_maas', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }], enable_thinking: true, thinking_budget: 8192 };
    for (const baseUrl of ['https://workspace-id.cn-beijing.maas.aliyuncs.com/v1', 'https://workspace-id.ap-southeast-1.maas.aliyuncs.com/v1']) {
      const payload = convertForEndpoint('deployment-alias', body, baseUrl);
      expect(payload.enable_thinking).toBe(true);
      expect(payload.thinking_budget).toBe(8192);
    }
  });

  it('openai_responses_adapter_drops_extensions_for_openrouter_qwen', () => {
    const payload = convertForEndpoint('qwen/qwen3.7-plus',
      { messages: [{ role: 'user', content: 'hi' }], enable_thinking: true, thinking_budget: 8192 },
      'https://openrouter.ai/api/v1');
    expect(Object.hasOwn(payload, 'enable_thinking')).toBe(false);
    expect(Object.hasOwn(payload, 'thinking_budget')).toBe(false);
  });

  it('openai_responses_adapter_respects_stream_and_store_from_body', () => {
    const payload = convert('gpt-5.2', { messages: [{ role: 'user', content: 'hi' }], stream: false, store: true });
    expect(payload.stream).toBe(false);
    expect(payload.store).toBe(true);
    const defaults = convert('gpt-5.2', { messages: [{ role: 'user', content: 'hi' }] });
    expect(defaults.stream).toBe(true);
    expect(defaults.store).toBe(false);
  });

  it('openai_responses_adapter_flattens_json_schema_response_format', () => {
    const payload = convert('gpt-5.2', {
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_schema', json_schema: { name: 'weather', schema: { type: 'object', properties: {}, additionalProperties: false }, strict: true } },
    });
    const format = payload.text.format;
    expect(format.type).toBe('json_schema');
    expect(format.name).toBe('weather');
    expect(format.schema.type).toBe('object');
    expect(format.strict).toBe(true);
    expect(format.json_schema).toBeUndefined();
    const jsonObject = convert('gpt-5.2', { messages: [{ role: 'user', content: 'hi' }], response_format: { type: 'json_object' } });
    expect(jsonObject.text.format.type).toBe('json_object');
  });

  it('openai_responses_adapter_converts_tools_and_tool_choice', () => {
    const payload = convert('gpt-5.2', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'lookup_weather', description: 'lookup', parameters: { type: 'object', properties: {} } } }],
      tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
      parallel_tool_calls: false,
    });
    const tools = payload.tools;
    expect(tools[0].type).toBe('function');
    expect(tools[0]!.name).toBe('lookup_weather');
    expect(tools[0].description).toBe('lookup');
    expect(tools[0].parameters.type).toBe('object');
    expect(tools[0].strict).toBe(false);
    expect(tools[0].function).toBeUndefined();
    expect(payload.tool_choice).toEqual({ type: 'function', name: 'lookup_weather' });
    expect(payload.parallel_tool_calls).toBe(false);
  });

  it('openai_responses_adapter_passes_through_strict_and_non_function_tools', () => {
    const payload = convert('gpt-5.2', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: 'lookup_weather', description: 'lookup', parameters: { type: 'object', properties: {} }, strict: true } },
        { type: 'web_search' },
      ],
    });
    const tools = payload.tools;
    expect(tools).toHaveLength(2);
    expect(tools[0].strict).toBe(true);
    expect(tools[1]).toEqual({ type: 'web_search' });
  });

  it('openai_responses_adapter_build_request_sanitizes_invalid_tools', () => {
    const request = new OpenAIResponsesAdapter().buildRequest('https://api.openai.com/v1', 'test-key', 'gpt-5', {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        { type: 'function', function: { name: '   ', description: 'blank', parameters: { type: 'object', properties: {} } } },
        { type: 'web_search_preview', name: '' },
        { type: 'function', function: { name: 'lookup_weather', description: 'lookup', parameters: { type: 'object', properties: {} } } },
      ],
      tool_choice: { type: 'function', function: { name: '   ' } },
    });
    const requestBody = wire(request.body);
    const tools = requestBody.tools as JsonValue[];
    expect(tools).toHaveLength(1);
    expect((tools[0] as { [key: string]: JsonValue }).name).toBe('lookup_weather');
    expect(requestBody.tool_choice).toBeUndefined();
  });

  it('openai_responses_adapter_parses_stream_events', () => {
    const adapter = new OpenAIResponsesAdapter();
    const content = adapter.parseStream('data: {"type":"response.output_text.delta","delta":"hello"}');
    expect(content[0]).toEqual({ type: 'ContentChunk', value: 'hello' });
    const reasoning = adapter.parseStream('data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}');
    expect(reasoning[0]).toEqual({ type: 'ReasoningChunk', value: 'thinking' });
    const completed = adapter.parseStream('data: {"type":"response.completed","response":{"usage":{"input_tokens":1}}}');
    expect(completed[0]!.type).toBe('Usage');
    expect(completed.at(-1)).toEqual({ type: 'Done' });
    const toolItem = adapter.parseStream('data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","call_id":"call_1","name":"lookup_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}');
    expect(toolItem[0]).toEqual({ type: 'ToolCall', value: { index: 2, id: 'call_1', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' } } });
  });

  it('openai_responses_adapter_accepts_bare_ndjson', () => {
    const events = new OpenAIResponsesAdapter().parseStream('{"type":"response.output_text.delta","delta":"ndjson"}');
    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'ndjson' });
  });

  it('openai_responses_adapter_parses_event_and_data_sse_blocks', () => {
    const events = new OpenAIResponsesAdapter().parseStream('event: response.output_text.delta\ndata: {"delta":"framed"}');
    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'framed' });
  });

  it('openai_responses_adapter_parses_buffered_event_only_type', () => {
    const buffer = new SseEventBuffer();
    expect(buffer.processBytes(new TextEncoder().encode('event: response.output_text.delta\nda'))).toEqual([]);
    const blocks = buffer.processBytes(new TextEncoder().encode('ta: {"delta":"buffered"}\n'));
    expect(blocks).toHaveLength(1);
    const events = new OpenAIResponsesAdapter().parseStream(blocks[0]!);
    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'buffered' });
  });

  it('openai_responses_adapter_falls_back_to_terminal_tool_calls_without_duplicates', () => {
    const adapter = new OpenAIResponsesAdapter();
    const first = adapter.parseStream('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"first_tool","arguments":"{}"}}');
    expect(first[0]).toEqual({ type: 'ToolCall', value: { index: 0, id: 'call_1', type: 'function', function: { name: 'first_tool', arguments: '{}' } } });
    const terminal = adapter.parseStream('data: {"type":"response.done","response":{"output":[{"type":"function_call","call_id":"call_1","name":"first_tool","arguments":"{}"},{"type":"function_call","call_id":"call_2","name":"second_tool","arguments":"{\\"value\\":2}"}]}}');
    const toolCalls = terminal.filter(event => event.type === 'ToolCall').map(wireValue);
    expect(toolCalls).toEqual([{ index: 1, id: 'call_2', type: 'function', function: { name: 'second_tool', arguments: '{"value":2}' } }]);
    expect(terminal.at(-1)).toEqual({ type: 'Done' });
  });

  it('openai_responses_adapter_streams_added_and_argument_deltas', () => {
    const adapter = new OpenAIResponsesAdapter();
    const added = adapter.parseStream('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather","arguments":""}}');
    expect(added).toEqual([{ type: 'ToolCall', value: { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup_weather', arguments: '' } } }]);
    const firstDelta = adapter.parseStream('data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"{\\"city\\":"}');
    expect(firstDelta).toEqual([{ type: 'ToolCall', value: { index: 0, type: 'function', function: { arguments: '{"city":' } } }]);
    const secondDelta = adapter.parseStream('data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","output_index":0,"delta":"\\"Paris\\"}"}');
    expect(secondDelta).toEqual([{ type: 'ToolCall', value: { index: 0, type: 'function', function: { arguments: '"Paris"}' } } }]);
    const done = adapter.parseStream('data: {"type":"response.function_call_arguments.done","item_id":"fc_1","output_index":0,"arguments":"{\\"city\\":\\"Paris\\"}"}');
    expect(done).toEqual([{ type: 'ToolCall', value: { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' } } }]);
    expect(adapter.parseStream('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"lookup_weather","arguments":"{\\"city\\":\\"Paris\\"}"}}')).toEqual([]);
    const terminal = adapter.parseStream('data: {"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call_1","name":"lookup_weather","arguments":"{\\"city\\":\\"Paris\\"}"}]}}');
    expect(terminal.some(event => event.type === 'ToolCall')).toBe(false);
    expect(terminal.at(-1)).toEqual({ type: 'Done' });
  });

  it('openai_responses_adapter_output_item_done_uses_accumulated_argument_deltas', () => {
    const adapter = new OpenAIResponsesAdapter();
    adapter.parseStream('data: {"type":"response.output_item.added","output_index":2,"item":{"type":"function_call","id":"fc_9","call_id":"call_9","name":"lookup","arguments":""}}');
    adapter.parseStream('data: {"type":"response.function_call_arguments.delta","item_id":"fc_9","output_index":2,"delta":"{\\"q\\":\\"rust\\"}"}');
    const done = adapter.parseStream('data: {"type":"response.output_item.done","output_index":2,"item":{"type":"function_call","id":"fc_9","call_id":"call_9","name":"lookup"}}');
    expect(done).toEqual([{ type: 'ToolCall', value: { index: 2, id: 'call_9', type: 'function', function: { name: 'lookup', arguments: '{"q":"rust"}' } } }]);
  });

  it('openai_responses_adapter_emits_server_side_web_search_progress_events', () => {
    const adapter = new OpenAIResponsesAdapter();
    const events = adapter.parseStream('data: {"type":"response.web_search_call.searching","call_id":"ws_1"}');
    expect(events).toEqual([{ type: 'WebSearchCall', value: { id: 'ws_1', stage: 'searching' } }]);
    const completed = adapter.parseStream('data: {"type":"response.web_search_call.completed","item":{"id":"ws_1","status":"completed","search_results":[{"url":"https://example.com/a","title":"Alpha"},{"url":"https://example.com/b","title":"Beta","text":"beta snippet"}]}}');
    const payload = wireValue(completed[0]!);
    expect(payload.id).toBe('ws_1');
    expect(payload.stage).toBe('completed');
    expect(payload.sources[0].title).toBe('Alpha');
    expect(payload.sources[1].snippet).toBe('beta snippet');
  });

  it('openai_responses_adapter_web_search_in_progress_stage_is_not_searching', () => {
    const adapter = new OpenAIResponsesAdapter();
    const inProgress = adapter.parseStream('data: {"type":"response.web_search_call.in_progress","call_id":"ws_ip"}');
    expect(inProgress).toEqual([{ type: 'WebSearchCall', value: { id: 'ws_ip', stage: 'in_progress' } }]);
    const searching = adapter.parseStream('data: {"type":"response.web_search_call.searching","call_id":"ws_ip"}');
    expect((wireValue(searching[0]!)).stage).toBe('searching');
    const added = adapter.parseStream('data: {"type":"response.output_item.added","output_index":0,"item":{"type":"web_search_call","id":"ws_add","status":"in_progress"}}');
    expect(added).toEqual([{ type: 'WebSearchCall', value: { id: 'ws_add', stage: 'in_progress', item: { type: 'web_search_call', id: 'ws_add', status: 'in_progress' } } }]);
  });

  it('openai_responses_adapter_attaches_full_web_search_item_for_replay', () => {
    const adapter = new OpenAIResponsesAdapter();
    const completed = adapter.parseStream('data: {"type":"response.web_search_call.completed","item":{"id":"ws_full","status":"completed","action":{"type":"search","query":"rust"},"search_results":[{"url":"https://example.com/r","title":"R"}]}}');
    const payload = wireValue(completed[0]!);
    expect(payload.item.type).toBe('web_search_call');
    expect(payload.item.id).toBe('ws_full');
    expect(payload.item.status).toBe('completed');
    expect(payload.item.action.query).toBe('rust');
    expect(payload.item.search_results[0].url).toBe('https://example.com/r');

    const done = new OpenAIResponsesAdapter().parseStream('data: {"type":"response.output_item.done","output_index":1,"item":{"type":"web_search_call","id":"ws_typed","status":"completed","search_results":[{"url":"https://example.com/t","title":"T"}]}}');
    expect(wireValue(done[0]!).item.type).toBe('web_search_call');
    expect(wireValue(done[0]!).item.id).toBe('ws_typed');

    const terminal = new OpenAIResponsesAdapter().parseStream('data: {"type":"response.completed","response":{"id":"r1","output":[{"type":"message","content":[{"type":"output_text","text":"answer","annotations":[{"type":"url_citation","url":"https://example.com/a","title":"A"}]}]}]}}');
    const synthetic = wireValue(terminal.find(event => event.type === 'WebSearchCall')!);
    expect(synthetic.item).toBeUndefined();
  });

  it('openai_responses_adapter_replays_web_search_items_from_assistant_meta', () => {
    const webSearchItem = { type: 'web_search_call', id: 'ws_hist', status: 'completed', action: { type: 'search', query: 'rust' }, search_results: [{ url: 'https://example.com/r', title: 'R' }] };
    const payload = convert('deepseek-v4-flash', {
      messages: [
        { role: 'user', content: 'search something' },
        { role: 'assistant', content: 'Here is what I found.', response_web_search_items: [webSearchItem, { type: 'message', id: 'not_a_search' }] },
        { role: 'user', content: 'follow up' },
      ],
    });
    const input = payload.input;
    const replayIndex = input.findIndex((item: Wire) => item.type === 'web_search_call');
    expect(replayIndex).toBeGreaterThanOrEqual(0);
    expect(input[replayIndex]).toEqual(webSearchItem);
    const assistantIndex = input.findIndex((item: Wire) => item.role === 'assistant');
    expect(replayIndex).toBeLessThan(assistantIndex);
    expect(input.some((item: Wire) => item.id === 'not_a_search')).toBe(false);
  });

  it('openai_responses_prompt_cache_breakpoint_wire_bodies_are_capability_gated', () => {
    const body = { messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }] };
    const official = convertForEndpoint('gpt-5.6', body, 'https://api.openai.com/v1');
    expect(official).toEqual({
      model: 'gpt-5.6',
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: 'You are helpful.', prompt_cache_breakpoint: { mode: 'explicit' } }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
      stream: true, store: false, reasoning: { summary: 'auto' }, include: ['reasoning.encrypted_content'],
    });
    const thirdParty = convertForEndpoint('gpt-5.6', body, 'https://gateway.example/v1');
    expect(thirdParty).toEqual({
      model: 'gpt-5.6',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true, store: false, instructions: 'You are helpful.', reasoning: { summary: 'auto' }, include: ['reasoning.encrypted_content'],
    });
    const accidental = convertForEndpoint('deployment-not-gpt-6-preview', body, 'https://api.openai.com/v1');
    expect(accidental).toEqual({
      model: 'deployment-not-gpt-6-preview',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true, store: false, instructions: 'You are helpful.',
    });
  });

  it('openai_responses_prompt_cache_breakpoint_gate_covers_endpoint_variants', () => {
    const body = { messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'hi' }] };
    const officialVariant = convertForEndpoint('gpt-5.6', body, 'https://api.openai.com/v1/?token=x#frag');
    expect(officialVariant.input[0].content[0].prompt_cache_breakpoint).toEqual({ mode: 'explicit' });
    const endpointless = convert('gpt-5.6', body);
    expect(endpointless.instructions).toBe('You are helpful.');
    for (const item of endpointless.input as JsonValue[]) for (const block of wire(item).content as JsonValue[]) expect(wire(block).prompt_cache_breakpoint).toBeUndefined();
  });

  it('model_supports_prompt_cache_breakpoint_parses_gpt_versions', () => {
    for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'GPT-5.7', 'gpt-5.10', 'gpt-6', 'openai/gpt-6.1']) expect(OpenAIResponsesAdapter.modelSupportsPromptCacheBreakpoint(model), model).toBe(true);
    for (const model of ['gpt-5', 'gpt-5.5', 'gpt-4o', 'deployment-not-gpt-6-preview', 'not-gpt-5.6', 'deepseek-v4-flash', 'qwen3.7-plus']) expect(OpenAIResponsesAdapter.modelSupportsPromptCacheBreakpoint(model), model).toBe(false);
  });

  it('openai_responses_adapter_extracts_web_search_from_output_item_done', () => {
    const events = new OpenAIResponsesAdapter().parseStream('data: {"type":"response.output_item.done","output_index":1,"item":{"type":"web_search_call","id":"ws_2","status":"completed","search_results":[{"url":"https://example.com/2","title":"Second"}]}}');
    const payload = wireValue(events[0]!);
    expect(payload.id).toBe('ws_2');
    expect(payload.stage).toBe('completed');
    expect(payload.sources[0].url).toBe('https://example.com/2');
  });

  it('openai_responses_adapter_terminal_fallback_extracts_annotations_without_duplicating', () => {
    const adapter = new OpenAIResponsesAdapter();
    const streamed = adapter.parseStream('data: {"type":"response.web_search_call.completed","item":{"id":"ws_3","status":"completed","search_results":[{"url":"https://example.com/1","title":"One"}]}}');
    expect(streamed.filter(event => event.type === 'WebSearchCall')).toHaveLength(1);
    const terminal = adapter.parseStream('data: {"type":"response.completed","response":{"id":"r1","output":[{"type":"web_search_call","id":"ws_3","status":"completed","search_results":[{"url":"https://example.com/1","title":"One"}]},{"type":"message","content":[{"type":"output_text","text":"answer","annotations":[{"type":"url_citation","url":"https://example.com/1","title":"One"}]}]}]}}');
    expect(terminal.some(event => event.type === 'WebSearchCall')).toBe(false);
    expect(terminal.at(-1)).toEqual({ type: 'Done' });
    const onlyAnnotations = adapter.parseStream('data: {"type":"response.completed","response":{"id":"r2","output":[{"type":"message","content":[{"type":"output_text","text":"answer","annotations":[{"type":"url_citation","url":"https://example.com/9","title":"Nine"}]}]}]}}');
    const payload = wireValue(onlyAnnotations[0]!);
    expect(payload.stage).toBe('completed');
    expect(payload.sources[0].url).toBe('https://example.com/9');
  });

  it('deepseek_responses_uses_reasoning_instead_of_chat_thinking_extensions', () => {
    for (const baseUrl of ['https://api.deepseek.com/v1', 'https://siliconflow.cn/v1', 'https://api.openai.com/v1']) expect(OpenAIResponsesAdapter.preservesProviderReasoningExtensions(baseUrl)).toBe(false);
  });

  it('openai_responses_adapter_accepts_deepseek_web_search_sources_shape', () => {
    const adapter = new OpenAIResponsesAdapter();
    const events = adapter.parseStream('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"web_search_call","id":"ws_ds","status":"in_progress","web_search_sources":[{"url":"https://example.com/ds","title":"DeepSeek Source"}]}}');
    const payload = wireValue(events[0]!);
    expect(payload.id).toBe('ws_ds');
    expect(payload.stage).toBe('in_progress');
    expect(payload.sources).toBeUndefined();
    const completed = adapter.parseStream('data: {"type":"response.web_search_call.completed","item":{"id":"ws_ds","status":"completed","web_search_sources":[{"url":"https://example.com/ds","title":"DeepSeek Source","text":"desc"}]}}');
    const completedPayload = wireValue(completed[0]!);
    expect(completedPayload.stage).toBe('completed');
    expect(completedPayload.sources[0].title).toBe('DeepSeek Source');
    expect(completedPayload.sources[0].snippet).toBe('desc');
  });

  it('holds DeepSeek output until review completes, and preserves signed read-link items', () => {
    const searchTool = { type: 'deepseek_web_search' };
    const readTool = { type: 'deepseek_read_url' };
    const start = () => {
      const adapter = new OpenAIResponsesAdapter();
      const request = adapter.buildRequest('https://api.deepseek.com/v1', 'test-key', 'deepseek-flash', {
        messages: [{ role: 'user', content: 'Summarize https://example.com/lesson' }],
        tools: [searchTool, readTool], safety_check: { level: 'high' },
      });
      expect(request.body).toMatchObject({ tools: [searchTool, readTool], safety_check: { level: 'high' } });
      return adapter;
    };
    const output = { type: 'message', content: [{ type: 'output_text', text: 'Unreviewed text' }] };
    const item = { type: 'web_search_call', id: 'ws_deepseek', status: 'completed',
      action: { type: 'open_page', url: 'https://example.com/lesson' },
      page: { url: 'https://example.com/lesson', title: 'Lesson' }, signature: 'signed-item' };
    const rejected = start();
    expect(rejected.parseStream('data: {"type":"response.output_text.delta","delta":"Unreviewed text"}')).toEqual([]);
    expect(start().parseStream('data: [DONE]')).toMatchObject([{ type: 'SafetyBlocked', value: { reason: 'missing_terminal' } }]);
    const failure = rejected.parseStream('data: ' + JSON.stringify({ type: 'response.incomplete',
      response: { incomplete_details: { reason: 'content_filter' }, output: [output, item] } }));
    expect(failure).toMatchObject([{ type: 'SafetyBlocked', value: { reason: 'content_filter' } }]);

    const approved = start();
    expect(approved.parseStream('data: {"type":"response.output_text.done","text":"Unreviewed text"}')).toEqual([]);
    const success = approved.parseStream('data: ' + JSON.stringify({ type: 'response.completed',
      response: { output: [item, output] } }));
    expect(success).toContainEqual({ type: 'ContentChunk', value: 'Unreviewed text' });
    expect(success.find(event => event.type === 'WebSearchCall')).toMatchObject({
      value: { item, sources: [{ url: 'https://example.com/lesson', title: 'Lesson' }] },
    });
    expect(success.at(-1)).toEqual({ type: 'Done' });
    const replay = convertForEndpoint('deepseek-flash', { messages: [
      { role: 'assistant', content: 'Unreviewed text', response_web_search_items: [item] },
    ] }, 'https://api.deepseek.com/v1');
    expect(replay.input).toContainEqual(item);
  });

  it('uses the final DeepSeek annotations as Unicode offsets and does not release calls before moderation', () => {
    const adapter = new OpenAIResponsesAdapter();
    adapter.buildRequest('https://api.deepseek.com', 'key', 'deepseek-flash', {
      messages: [{ role: 'user', content: '带来源回答' }], tools: [{ type: 'deepseek_web_search' }],
    });
    const sse = (event: unknown) => adapter.parseStream('data: ' + JSON.stringify(event));
    const functionItem = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{}' };
    expect(sse({ type: 'response.output_item.done', item: functionItem })).toEqual([]);
    const output = [{ type: 'message', content: [{ type: 'output_text', text: '🌱结论。', annotations: [
      { type: 'url_citation', url: 'https://example.com/a_(b)', start_index: 0, end_index: 3 },
      { type: 'url_citation', url: 'javascript:alert(1)', start_index: 0, end_index: 4 },
    ] }] }, functionItem];
    const events = sse({ type: 'response.completed', response: { status: 'completed', output } });
    expect(events).toContainEqual({ type: 'ContentChunk', value: '🌱结论 [1](<https://example.com/a_(b)>)。' });
    expect(events.filter(event => event.type === 'ToolCall')).toHaveLength(1);
  });

  it('converts a DeepSeek file reference to a Responses input_file part', () => {
    const payload = convertForEndpoint('deepseek-flash', { messages: [{ role: 'user', content: [
      { type: 'input_file', file_id: 'file-api-demo' }, { type: 'text', text: '总结' },
    ] }] }, 'https://api.deepseek.com/v1');
    expect(payload.input).toEqual([{ role: 'user', content: [
      { type: 'input_file', file_id: 'file-api-demo' }, { type: 'input_text', text: '总结' },
    ] }]);
  });

  it('openai_responses_adapter_reports_untyped_error_objects', () => {
    const events = new OpenAIResponsesAdapter().parseStream('data: {"error":{"code":402,"message":"Insufficient credits"}}');
    expect(events).toEqual([{ type: 'SafetyBlocked', value: { type: 'provider_error', reason: 'stream_error', details: { code: 402, message: 'Insufficient credits' } } }]);
  });

  it('openai_responses_adapter_preserves_incomplete_output_without_marking_done', () => {
    const events = new OpenAIResponsesAdapter().parseStream('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"partial answer"}]}],"usage":{"output_tokens":128}}}');
    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'partial answer' });
    expect(events.some(event => event.type === 'Usage' && wireValue(event).output_tokens === 128)).toBe(true);
    expect(events.some(event => event.type === 'SafetyBlocked' && wireValue(event).reason === 'response.incomplete' && wireValue(event).details.reason === 'max_output_tokens')).toBe(true);
    expect(events.some(event => event.type === 'Done')).toBe(false);
  });

  it('openai_responses_adapter_uses_output_text_fallbacks_without_duplication', () => {
    const doneOnly = new OpenAIResponsesAdapter();
    expect(doneOnly.parseStream('data: {"type":"response.output_text.done","text":"complete text"}')[0]).toEqual({ type: 'ContentChunk', value: 'complete text' });
    expect(doneOnly.parseStream('data: {"type":"response.completed","response":{"output_text":"complete text"}}').some(event => event.type === 'ContentChunk')).toBe(false);

    const deltaFirst = new OpenAIResponsesAdapter();
    expect(deltaFirst.parseStream('data: {"type":"response.output_text.delta","delta":"streamed"}')[0]).toEqual({ type: 'ContentChunk', value: 'streamed' });
    expect(deltaFirst.parseStream('data: {"type":"response.output_text.done","text":"streamed"}')).toEqual([]);
    expect(deltaFirst.parseStream('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"streamed"}]}]}}').some(event => event.type === 'ContentChunk')).toBe(false);

    const completedEvents = new OpenAIResponsesAdapter().parseStream('data: {"type":"response.completed","response":{"output_text":"duplicate convenience value","output":[{"type":"message","content":[{"type":"output_text","text":"first"},{"type":"output_text","text":" second"}]}]}}');
    expect(completedEvents.filter(event => event.type === 'ContentChunk').map(wireValue)).toEqual(['first second']);
    expect(completedEvents.at(-1)).toEqual({ type: 'Done' });
  });

  it('openai_responses_adapter_extracts_reasoning_from_completed_event', () => {
    const adapter = new OpenAIResponsesAdapter();
    const events = adapter.parseStream('data: {"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"first"},{"type":"summary_text","text":"second"}]}],"usage":{"input_tokens":1}}}');
    expect(events[0]).toEqual({ type: 'ReasoningChunk', value: 'first\n\nsecond' });
    expect(events[1]!.type).toBe('Usage');
    expect(events.at(-1)).toEqual({ type: 'Done' });
    const duplicate = adapter.parseStream('data: {"type":"response.done","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"first"},{"type":"summary_text","text":"second"}]}]}}');
    expect(duplicate.some(event => event.type === 'ReasoningChunk')).toBe(false);
  });

  it('openai_responses_adapter_does_not_duplicate_reasoning_after_deltas', () => {
    const adapter = new OpenAIResponsesAdapter();
    expect(adapter.parseStream('data: {"type":"response.reasoning_summary_text.delta","delta":"step one"}')[0]).toEqual({ type: 'ReasoningChunk', value: 'step one' });
    expect(adapter.parseStream('data: {"type":"response.reasoning_summary_text.done","text":"step one and two"}')).toEqual([]);
    const completed = adapter.parseStream('data: {"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"step one and two"}]}],"usage":{"input_tokens":1}}}');
    expect(completed.some(event => event.type === 'ReasoningChunk')).toBe(false);
    expect(completed[0]!.type).toBe('Usage');
    expect(completed.at(-1)).toEqual({ type: 'Done' });
  });

  it('openai_responses_adapter_uses_done_event_as_fallback_without_deltas', () => {
    const adapter = new OpenAIResponsesAdapter();
    expect(adapter.parseStream('data: {"type":"response.reasoning_text.done","text":"full reasoning"}')[0]).toEqual({ type: 'ReasoningChunk', value: 'full reasoning' });
    const completed = adapter.parseStream('data: {"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"full reasoning"}]}],"usage":{"input_tokens":1}}}');
    expect(completed.some(event => event.type === 'ReasoningChunk')).toBe(false);
  });

  it('openai_responses_adapter_encodes_tool_history', () => {
    const payload = convert('gpt-5.2', {
      messages: [
        { role: 'assistant', content: 'Calling tool', response_reasoning_item: { type: 'reasoning', id: 'reasoning_1', encrypted_content: 'encrypted-state' }, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'Sunny' },
      ],
    });
    const input = payload.input;
    const reasoningIndex = input.findIndex((item: Wire) => item.type === 'reasoning');
    const functionCallIndex = input.findIndex((item: Wire) => item.type === 'function_call');
    expect(reasoningIndex).toBeLessThan(functionCallIndex);
    expect(input[reasoningIndex].encrypted_content).toBe('encrypted-state');
    expect(input.some((item: Wire) => item.type === 'function_call')).toBe(true);
    expect(input.some((item: Wire) => item.type === 'function_call_output')).toBe(true);
  });

  it('openai_responses_completed_fallback_interleaves_reasoning_and_tool_calls', () => {
    const adapter = new OpenAIResponsesAdapter();
    const events = adapter.parseStream('data: {"type":"response.completed","response":{"output":[{"type":"reasoning","id":"rs_1","encrypted_content":"enc-1"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"tool_a","arguments":"{}"},{"type":"reasoning","id":"rs_2","encrypted_content":"enc-2"},{"type":"function_call","id":"fc_2","call_id":"call_2","name":"tool_b","arguments":"{}"}]}}');
    const sequence = events.filter(event => event.type === 'ResponseReasoningItem' || event.type === 'ToolCall')
      .map(event => `${event.type === 'ResponseReasoningItem' ? 'reasoning' : 'tool'}:${wireValue(event).id}`);
    expect(sequence).toEqual(['reasoning:rs_1', 'tool:call_1', 'reasoning:rs_2', 'tool:call_2']);
  });

  it('openai_responses_completed_dedupes_streamed_reasoning_items_by_id', () => {
    const adapter = new OpenAIResponsesAdapter();
    const streamed = adapter.parseStream('data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","id":"rs_1","encrypted_content":"enc-1"}}');
    expect(streamed.filter(event => event.type === 'ResponseReasoningItem')).toHaveLength(1);
    const completed = adapter.parseStream('data: {"type":"response.completed","response":{"output":[{"type":"reasoning","id":"rs_1","encrypted_content":"enc-1"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"tool_a","arguments":"{}"},{"type":"reasoning","id":"rs_2","encrypted_content":"enc-2"}]}}');
    expect(completed.filter(event => event.type === 'ResponseReasoningItem').map(event => wireValue(event).id)).toEqual(['rs_2']);
  });

  it('openai_responses_adapter_replays_reasoning_item_before_plain_assistant_message', () => {
    const payload = convert('gpt-5.2', {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello there!', response_reasoning_item: { type: 'reasoning', id: 'rs_final', encrypted_content: 'enc-final' } },
        { role: 'user', content: 'and again' },
      ],
    });
    const input = payload.input;
    const reasoningIndex = input.findIndex((item: Wire) => item.type === 'reasoning');
    expect(input[reasoningIndex].encrypted_content).toBe('enc-final');
    const assistantIndex = input.findIndex((item: Wire) => item.role === 'assistant' && item.content[0].text === 'Hello there!');
    expect(reasoningIndex).toBeLessThan(assistantIndex);
  });

  it('openai_responses_adapter_encodes_assistant_history_as_output_text', () => {
    const payload = convert('gpt-5.2', messages(
      { role: 'user', content: 'knock knock' },
      { role: 'assistant', content: "Who's there?" },
      { role: 'user', content: 'Orange' },
    ));
    const input = payload.input;
    expect(input[1].role).toBe('assistant');
    expect(input[1].content[0].type).toBe('output_text');
    expect(input[1].content[0].text).toBe("Who's there?");
  });

  it('openai_responses_adapter_preserves_assistant_output_parts', () => {
    const payload = convert('gpt-5.2', {
      messages: [{ role: 'assistant', content: [{ type: 'output_text', text: 'First answer' }, { type: 'refusal', refusal: "Can't help with that." }] }],
    });
    const input = payload.input;
    expect(input[0].role).toBe('assistant');
    expect(input[0].content[0]).toEqual({ type: 'output_text', text: 'First answer' });
    expect(input[0].content[1]).toEqual({ type: 'refusal', refusal: "Can't help with that." });
  });

  it('openai_adapters_do_not_duplicate_complete_endpoint_paths', () => {
    const chat = new OpenAIAdapter().buildRequest('https://proxy.example.com/v1/chat/completions/', 'test-key', 'gpt-test', { messages: [] });
    expect(chat.url).toBe('https://proxy.example.com/v1/chat/completions');
    const responses = new OpenAIResponsesAdapter().buildRequest('https://proxy.example.com/v1/responses/', 'test-key', 'gpt-test', { messages: [] });
    expect(responses.url).toBe('https://proxy.example.com/v1/responses');
    const root = new OpenAIResponsesAdapter().buildRequest('https://proxy.example.com/v1', 'test-key', 'gpt-test', { messages: [] });
    expect(root.url).toBe('https://proxy.example.com/v1/responses');
  });

  it('openai_adapters_insert_endpoint_before_query_and_fragment', () => {
    const chat = new OpenAIAdapter().buildRequest('https://proxy.example.com/v1/?token=signed#tenant-a', 'test-key', 'gpt-test', { messages: [] });
    expect(chat.url).toBe('https://proxy.example.com/v1/chat/completions?token=signed#tenant-a');
    const responses = new OpenAIResponsesAdapter().buildRequest('https://proxy.example.com/v1/responses/?token=signed#tenant-a', 'test-key', 'gpt-test', { messages: [] });
    expect(responses.url).toBe('https://proxy.example.com/v1/responses?token=signed#tenant-a');
  });

  it('openai_adapters_replace_cross_protocol_endpoints_and_preserve_url_tail', () => {
    const chat = new OpenAIAdapter().buildRequest('https://proxy.example.com/v1/responses/?token=signed#tenant-a', 'test-key', 'gpt-test', { messages: [] });
    expect(chat.url).toBe('https://proxy.example.com/v1/chat/completions?token=signed#tenant-a');
    const responses = new OpenAIResponsesAdapter().buildRequest('https://proxy.example.com/v1/chat/completions/?token=signed#tenant-a', 'test-key', 'gpt-test', { messages: [] });
    expect(responses.url).toBe('https://proxy.example.com/v1/responses?token=signed#tenant-a');
  });
});

describe('prompt cache breakpoint model gate', () => {
  it('model_supports_prompt_cache_breakpoint_parses_versions_as_u32', () => {
    expect(OpenAIResponsesAdapter.modelSupportsPromptCacheBreakpoint('gpt-5.6')).toBe(true);
    expect(OpenAIResponsesAdapter.modelSupportsPromptCacheBreakpoint('gpt-6')).toBe(true);
    expect(OpenAIResponsesAdapter.modelSupportsPromptCacheBreakpoint('deploy/gpt-6-preview')).toBe(true);
    expect(OpenAIResponsesAdapter.modelSupportsPromptCacheBreakpoint('gpt-99999999999999999999')).toBe(false);
    expect(OpenAIResponsesAdapter.modelSupportsPromptCacheBreakpoint('gpt-5.99999999999999999999')).toBe(false);
    expect(OpenAIResponsesAdapter.modelSupportsPromptCacheBreakpoint('gpt-5.5')).toBe(false);
  });
});

it('openai_responses_adapter_logs_untyped_and_failed_stream_errors', () => {
  const { logger, messages } = createRecordingLogger();
  const adapter = new OpenAIResponsesAdapter(logger);
  const untyped = adapter.parseStream('data: {"error":{"message":"untyped boom"}}');
  expect(untyped).toEqual([{
    type: 'SafetyBlocked',
    value: { type: 'provider_error', reason: 'stream_error', details: { message: 'untyped boom' } },
  }]);
  const failed = adapter.parseStream('event: response.failed\ndata: {"response":{"error":{"message":"failed boom"}}}');
  expect(failed.at(-1)).toMatchObject({ type: 'SafetyBlocked', value: { reason: 'response.failed' } });
  expect(messages.map(entry => [entry.level, entry.message])).toEqual([
    ['error', '[OpenAIResponsesAdapter] Untyped stream error: %s'],
    ['error', '[OpenAIResponsesAdapter] Stream failed event: %s'],
  ]);
});
