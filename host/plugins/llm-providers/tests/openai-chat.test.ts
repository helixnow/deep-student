import { expect, it } from 'vitest';
import { OpenAIAdapter, isMeaningfulOpenaiToolDelta, normalizeOllamaRootBaseUrl, openaiEndpointUrl, sanitizeOpenaiRequestBody } from '../src/providers/openai-chat.ts';
import type { JsonObject, JsonValue } from '../api.ts';
import { createRecordingLogger } from './recording-logger.ts';

const data = (value: JsonValue) => `data: ${JSON.stringify(value)}`;
const sanitize = (body: JsonObject) => sanitizeOpenaiRequestBody(body) as JsonObject;
const fn = (name: string, description = 'lookup', parameters: JsonValue = { type: 'object', properties: {} }) => ({ type: 'function', function: { name, description, parameters } });
it('ollama_root_base_url_routes_chat_under_v1', () => {
  expect(openaiEndpointUrl('http://localhost:11434', 'chat/completions')).toBe('http://localhost:11434/v1/chat/completions');
  expect(openaiEndpointUrl('http://127.0.0.1:11434/', 'chat/completions')).toBe('http://127.0.0.1:11434/v1/chat/completions');
  expect(openaiEndpointUrl('http://localhost:11434/v1', 'chat/completions')).toBe('http://localhost:11434/v1/chat/completions');
  expect(normalizeOllamaRootBaseUrl('https://proxy.example.com')).toBe('https://proxy.example.com');
  expect(normalizeOllamaRootBaseUrl('http://localhost:11434/api')).toBe('http://localhost:11434/api');
});
it('openai_tool_delta_filter_skips_empty_fragments', () => {
  expect(isMeaningfulOpenaiToolDelta({ index: 0, id: '', function: {} })).toBe(false);
  expect(isMeaningfulOpenaiToolDelta({ id: '', function: { name: '', arguments: null } })).toBe(false);
});
it('openai_adapter_parse_stream_keeps_argument_deltas_and_skips_empty_tool_fragments', () => {
  const adapter = new OpenAIAdapter();
  expect(adapter.parseStream(data({ choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: {} }] } }] }))).toEqual([]);
  expect(adapter.parseStream(data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{' } }] } }] }))[0]).toEqual({ type: 'ToolCall', value: { index: 0, function: { arguments: '{' } } });
});
it('openai_adapter_parse_stream_preserves_empty_reasoning_content', () => {
  expect(new OpenAIAdapter().parseStream(data({ choices: [{ delta: { reasoning_content: '' } }] }))[0]).toEqual({ type: 'ReasoningChunk', value: '' });
});
it('openai_adapter_parse_stream_accepts_data_prefix_without_space', () => {
  const adapter = new OpenAIAdapter();
  expect(adapter.parseStream('data:{"choices":[{"delta":{"content":"hi"}}]}')[0]).toEqual({ type: 'ContentChunk', value: 'hi' });
  expect(adapter.parseStream('data:[DONE]')[0]).toEqual({ type: 'Done' });
});
it('openai_adapter_parse_stream_accepts_bare_ndjson', () => {
  expect(new OpenAIAdapter().parseStream('{"choices":[{"delta":{"content":"ndjson"}}]}')[0]).toEqual({ type: 'ContentChunk', value: 'ndjson' });
});
it('openai_chat_adapter_accepts_event_and_data_sse_blocks', () => {
  const events = new OpenAIAdapter().parseStream('event: message\ndata: {"choices":[{"delta":{"content":"framed"}}]}');
  expect(events[0]).toEqual({ type: 'ContentChunk', value: 'framed' });
});
it('openai_adapter_emits_usage_before_done_for_official_chunk_sequence', () => {
  const adapter = new OpenAIAdapter();
  const tool = { index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{}' } };
  const events = adapter.parseStream(data({ choices: [{ delta: { content: 'tail', reasoning_content: 'thought', tool_calls: [tool] }, finish_reason: 'tool_calls' }] }));
  expect(events.some(e => e.type === 'Done')).toBe(false);
  events.push(...adapter.parseStream(data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })), ...adapter.parseStream('data: [DONE]'));
  expect(events).toEqual([
    { type: 'ContentChunk', value: 'tail' }, { type: 'ReasoningChunk', value: 'thought' }, { type: 'ToolCall', value: tool },
    { type: 'Usage', value: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }, { type: 'Done' },
  ]);
});
it('openai_adapter_bare_ndjson_finish_reason_completes_at_eof', () => {
  const adapter = new OpenAIAdapter();
  expect(adapter.parseStream('{"choices":[{"index":0,"delta":{"content":"ndjson tail"},"finish_reason":"stop"}]}')).toEqual([{ type: 'ContentChunk', value: 'ndjson tail' }]);
  expect(adapter.finishStream()[0]).toEqual({ type: 'Done' });
  expect(adapter.finishStream()).toEqual([]);
});
it('openai_adapter_finish_reason_ignores_empty_and_partial_multi_choice_completion', () => {
  for (const finish_reason of [null, '', '   ']) {
    expect(new OpenAIAdapter().parseStream(data({ choices: [{ index: 0, delta: { content: 'tail' }, finish_reason }] })).some(e => e.type === 'Done')).toBe(false);
  }
  expect(new OpenAIAdapter().parseStream('data: {"choices":[{"index":0,"delta":{"content":"first"},"finish_reason":"stop"},{"index":1,"delta":{"content":"second"},"finish_reason":null}]}').some(e => e.type === 'Done')).toBe(false);
  const adapter = new OpenAIAdapter();
  expect(adapter.parseStream('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"},{"index":1,"delta":{},"finish_reason":"length"}]}').some(e => e.type === 'Done')).toBe(false);
  expect(adapter.finishStream()[0]).toEqual({ type: 'Done' });
});
it('openai_adapter_choice_completion_keeps_event_sequence_until_done_marker', () => {
  const adapter = new OpenAIAdapter();
  const events = adapter.parseStream('data: {"choices":[{"index":0,"delta":{"content":"early"},"finish_reason":"stop"}]}');
  events.push(...adapter.parseStream('data: {"choices":[{"index":0,"delta":{"content":" late"}}]}'));
  const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_tokens_details: { cached_tokens: 8 } };
  events.push(...adapter.parseStream(data({ choices: [], usage })));
  expect(events.some(e => e.type === 'Done')).toBe(false);
  events.push(...adapter.parseStream('data: [DONE]'));
  expect(events).toEqual([{ type: 'ContentChunk', value: 'early' }, { type: 'ContentChunk', value: ' late' }, { type: 'Usage', value: usage }, { type: 'Done' }]);
  expect(adapter.finishStream()).toEqual([]);
});
it('openai_adapter_parse_stream_handles_content_block_arrays', () => {
  const adapter = new OpenAIAdapter();
  expect(adapter.parseStream('data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":[{"type":"text","text":"let me think"}]},{"type":"text","text":"the answer"}]}}]}')).toEqual([{ type: 'ReasoningChunk', value: 'let me think' }, { type: 'ContentChunk', value: 'the answer' }]);
  expect(adapter.parseStream('data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":"raw thought"}]}}]}')[0]).toEqual({ type: 'ReasoningChunk', value: 'raw thought' });
});
it('openai_adapter_parse_stream_handles_reasoning_field_variants', () => {
  const adapter = new OpenAIAdapter();
  expect(adapter.parseStream('data: {"choices":[{"delta":{"reasoning":"thinking hard"}}]}')[0]).toEqual({ type: 'ReasoningChunk', value: 'thinking hard' });
  expect(adapter.parseStream('data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","text":"detail text","format":"anthropic-claude-v1"},{"type":"reasoning.encrypted","data":"opaque","format":"anthropic-claude-v1"}]}}]}')).toEqual([{ type: 'ReasoningChunk', value: 'detail text' }]);
  expect(adapter.parseStream('data: {"choices":[{"delta":{"reasoning_content":"same text","reasoning":"same text"}}]}')).toEqual([{ type: 'ReasoningChunk', value: 'same text' }]);
});
it('openai_adapter_parse_stream_reports_injected_error_objects', () => {
  const events = new OpenAIAdapter().parseStream('data: {"error":{"code":402,"message":"Insufficient credits"}}');
  expect(events[0]).toMatchObject({ type: 'SafetyBlocked', value: { type: 'provider_error', details: { message: 'Insufficient credits' } } });
  expect(events.at(-1)).toEqual({ type: 'Done' });
});
it('openai_adapter_build_request_keeps_nested_tool_choice_shape', () => {
  const body = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], tools: [fn('lookup_weather')], tool_choice: { type: 'function', function: { name: 'lookup_weather' } } };
  const request = new OpenAIAdapter().buildRequest('https://api.openai.com/v1', 'test-key', 'gpt-4o-mini', body);
  expect((request.body as JsonObject).tool_choice).toEqual({ type: 'function', function: { name: 'lookup_weather' } });
});
it('sanitize_openai_request_body_passes_through_non_function_tools', () => {
  const body = sanitize({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search' }, fn('lookup_weather')] });
  expect(body.tools).toEqual([{ type: 'web_search' }, fn('lookup_weather')]);
});
it('sanitize_openai_request_body_filters_blank_and_duplicate_tool_names', () => {
  const body = sanitize({ messages: [{ role: 'user', content: 'hi' }], tools: [fn('  ', 'blank'), fn('lookup_weather', 'first'), fn('lookup_weather', 'duplicate')], tool_choice: { type: 'function', function: { name: 'lookup_weather' } } });
  expect(body.tools).toEqual([fn('lookup_weather', 'first')]);
  expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'lookup_weather' } });
});
it('sanitize_openai_request_body_drops_tools_with_blank_flat_names', () => {
  const body = sanitize({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'web_search_preview', name: '' }, { ...fn('lookup_weather'), name: '   ' }, { type: 'web_search' }, fn('rag_search', 'search notes')] });
  expect(body.tools).toEqual([{ type: 'web_search' }, fn('rag_search', 'search notes')]);
  for (const tool of body.tools as JsonObject[]) {
    expect(typeof tool.name === 'string' && tool.name.trim() === '').toBe(false);
    const name = (tool.function as JsonObject | undefined)?.name;
    expect(typeof name === 'string' && name.trim() === '').toBe(false);
  }
});
it('sanitize_openai_request_body_drops_all_blank_tools_and_clears_tools_field', () => {
  const body = sanitize({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'custom_gateway_tool', name: '  ' }], tool_choice: 'auto' });
  expect(body).not.toHaveProperty('tools'); expect(body).not.toHaveProperty('tool_choice');
});
it('sanitize_openai_request_body_normalizes_missing_or_null_parameters', () => {
  expect(sanitize({ messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'lookup_weather', parameters: null } }] }).tools).toEqual([{ type: 'function', function: { name: 'lookup_weather', parameters: { type: 'object', properties: {} } } }]);
});
it('sanitize_openai_request_body_drops_invalid_tool_choice_when_tool_missing', () => {
  expect(sanitize({ messages: [{ role: 'user', content: 'hi' }], tools: [fn('lookup_weather')], tool_choice: { type: 'function', function: { name: '   ' } } })).not.toHaveProperty('tool_choice');
});
it('openai_adapter_build_request_sanitizes_invalid_tools', () => {
  const request = new OpenAIAdapter().buildRequest('https://api.openai.com/v1', 'test-key', 'gpt-4o-mini', { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], tools: [fn('', 'blank'), fn('lookup_weather')], tool_choice: { type: 'function', function: { name: '' } } });
  expect((request.body as JsonObject).tools).toEqual([fn('lookup_weather')]);
  expect(request.body).not.toHaveProperty('tool_choice');
});
it('openai_adapter_gates_stream_options_include_usage_by_endpoint', () => {
  const adapter = new OpenAIAdapter();
  const body = { model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] };
  expect(adapter.buildRequest('https://api.openai.com/v1', 'key', 'gpt-4o-mini', body).body).toHaveProperty('stream_options.include_usage', true);
  for (const base of ['https://gateway.example/v1', 'https://api.openai.com.evil.example/v1']) expect(adapter.buildRequest(base, 'key', 'gpt-4o-mini', body).body).not.toHaveProperty('stream_options');
  expect(adapter.buildRequest('https://api.openai.com/v1', 'key', 'gpt-4o-mini', { model: 'gpt-4o-mini', messages: body.messages }).body).not.toHaveProperty('stream_options');
  expect(adapter.buildRequest('https://api.openai.com/v1', 'key', 'gpt-4o-mini', { ...body, stream_options: { include_usage: false } }).body).toHaveProperty('stream_options.include_usage', false);
});
it('openai_adapter_stream_options_gate_pins_official_host_variants', () => {
  const adapter = new OpenAIAdapter();
  const body = { model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] };
  for (const base of ['https://api.openai.com', 'https://api.openai.com/v1/', 'https://API.OPENAI.COM/v1', 'https://api.openai.com/v1?token=x#frag']) expect(adapter.buildRequest(base, 'key', 'gpt-4o-mini', body).body).toHaveProperty('stream_options.include_usage', true);
  for (const base of ['https://mirror.api.openai.com/v1', 'https://api-openai.com/v1', 'https://api.openai.com.evil.example/v1', 'api.openai.com/v1', '']) expect(adapter.buildRequest(base, 'key', 'gpt-4o-mini', body).body).not.toHaveProperty('stream_options');
});
it('openai_adapter_logs_stream_errors_through_the_plugin_logger', () => {
  const { logger, messages } = createRecordingLogger();
  const events = new OpenAIAdapter(logger).parseStream(data({ error: { message: 'upstream boom' } }));
  expect(events[0]).toEqual({
    type: 'SafetyBlocked',
    value: { type: 'provider_error', reason: 'stream_error', details: { message: 'upstream boom' } },
  });
  expect(messages).toEqual([{
    level: 'error',
    message: '[OpenAIAdapter] Stream error event: %s',
    args: ['{"message":"upstream boom"}'],
  }]);
});
