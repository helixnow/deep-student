import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { JsonValue, ProviderRequest } from '../api.ts';
import {
  AdapterError, buildGeminiRequest, buildGeminiRequestWithVersion, convertGeminiNonstreamResponseToOpenai,
  isSyntheticToolCallId, parseGeminiStreamLine, type GeminiPendingToolCall,
} from '../src/adapters/gemini-openai-converter.ts';
import { setRemoteImageFetcher } from '../src/media/remote-image.ts';
import { createRecordingLogger } from './recording-logger.ts';

/**
 * Test-only deep view of the converter's wire JSON. Production signatures stay
 * JsonValue; every assertion below still compares real runtime values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wire = any;

const wire = (value: JsonValue): Wire => value as Wire;
const json = (value: unknown): JsonValue => value as JsonValue;
const newState = (): Map<number, GeminiPendingToolCall> => new Map();

const build = (body: unknown, model = 'gemini-pro'): ProviderRequest =>
  buildGeminiRequest('https://generativelanguage.googleapis.com', 'test-api-key', model, json(body));

describe('gemini openai converter', () => {
  it('test_build_gemini_request_nonstream', () => {
    const openaiBody = {
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: "What's in this image?" },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ...' } },
          ],
        },
      ],
      temperature: 0.7,
      max_tokens: 100,
    };

    const request = build(openaiBody, 'gemini-pro-vision');
    expect(request.url).toContain(':generateContent?');
    expect(request.url).toContain('key=test-api-key');

    expect(request.headers).toHaveLength(2);
    expect(request.headers.some(([key]) => key === 'Content-Type')).toBe(true);
    expect(request.headers.some(([key]) => key === 'x-goog-api-key')).toBe(true);

    const body = wire(request.body);
    expect(body.contents).toHaveLength(1);
    const parts = body.contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe("What's in this image?");
    expect(parts[1].inlineData).toEqual({ mimeType: 'image/jpeg', data: '/9j/4AAQ...' });
  });

  it('test_build_gemini_request_stream', () => {
    const request = build({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
      stream: true,
    });
    expect(request.url).toContain(':streamGenerateContent?');
    expect(wire(request.body).systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'You are a helpful assistant.' }],
    });
  });

  it('test_parse_gemini_stream_line_content', () => {
    const events = parseGeminiStreamLine('data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}', newState());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'Hello' });
  });

  it('test_parse_gemini_stream_line_accepts_bare_ndjson', () => {
    const events = parseGeminiStreamLine('{"candidates":[{"content":{"parts":[{"text":"NDJSON"}]}}]}', newState());
    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'NDJSON' });
  });

  it('test_parse_gemini_stream_event_and_data_block', () => {
    const events = parseGeminiStreamLine(
      'event: message\ndata: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}',
      newState(),
    );
    expect(events[0]).toEqual({ type: 'ContentChunk', value: 'Hello' });
  });

  it('test_parse_gemini_stream_line_done', () => {
    const events = parseGeminiStreamLine('data: [DONE]', newState());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'Done' });
  });

  it('test_parse_gemini_stream_line_function_call', () => {
    const events = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{"location":"Tokyo"}}}]}}]}',
      newState(),
    );
    expect(events).toHaveLength(1);
    const value = wire((events[0] as Wire).value);
    expect(value.type).toBe('function');
    expect(value.function.name).toBe('get_weather');
    expect(JSON.parse(value.function.arguments)).toEqual({ location: 'Tokyo' });
  });

  it('test_parse_gemini_stream_line_usage', () => {
    const events = parseGeminiStreamLine(
      'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}',
      newState(),
    );
    expect(events).toHaveLength(1);
    const value = wire((events[0] as Wire).value);
    expect(value.promptTokenCount).toBe(10);
    expect(value.candidatesTokenCount).toBe(20);
    expect(value.totalTokenCount).toBe(30);
  });

  it('test_parse_gemini_stream_line_usage_lifts_cached_tokens', () => {
    const events = parseGeminiStreamLine(
      'data: {"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":20,"totalTokenCount":120,"cachedContentTokenCount":80,"thoughtsTokenCount":15}}',
      newState(),
    );
    expect(events).toHaveLength(1);
    const value = wire((events[0] as Wire).value);
    expect(value.cached_tokens).toBe(80);
    expect(value.cachedContentTokenCount).toBe(80);
    expect(value.reasoning_tokens).toBe(15);
    expect(value.prompt_tokens).toBe(100);
  });

  it('test_parse_gemini_stream_line_usage_without_cache_omits_cached_tokens', () => {
    const events = parseGeminiStreamLine(
      'data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20,"totalTokenCount":30}}',
      newState(),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('Usage');
    expect(wire((events[0] as Wire).value).cached_tokens).toBeUndefined();
  });

  it('test_convert_gemini_nonstream_response', () => {
    const response = wire(convertGeminiNonstreamResponseToOpenai(json({
      candidates: [{
        content: { parts: [{ text: 'Hello' }, { text: ' world!' }] },
        finishReason: 'STOP',
        index: 0,
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
    }), 'gemini-pro'));

    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.content).toBe('Hello\n world!');
    expect(response.usage.prompt_tokens).toBe(5);
    expect(response.usage.completion_tokens).toBe(2);
    expect(response.usage.total_tokens).toBe(7);
  });

  it.each([
    ['42', '42'],
    ['Paris', 'Paris is the capital of France.'],
  ])('keeps answer text that also occurs in a separate thought part (%s)', (thought, answer) => {
    // GenerateContentResponse: thought summaries and the answer are separate Parts.
    const fixture = {
      candidates: [{
        content: { role: 'model', parts: [{ thought: true, text: thought }, { text: answer }] },
        finishReason: 'STOP',
        index: 0,
      }],
    };
    const response = wire(convertGeminiNonstreamResponseToOpenai(json(fixture), 'gemini-2.5-flash'));
    expect(response.choices[0].message.content).toBe(answer);
    expect(response.choices[0].message.thinking_content).toBe(thought);
    expect(parseGeminiStreamLine(`data: ${JSON.stringify(fixture)}`, newState())).toEqual([
      { type: 'ReasoningChunk', value: thought },
      { type: 'ContentChunk', value: answer },
      { type: 'Done' },
    ]);
  });

  it('test_convert_with_tools', () => {
    const request = build({
      model: 'gpt-4',
      messages: [{ role: 'user', content: "What's the weather?" }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather information',
          parameters: { type: 'object', properties: { location: { type: 'string' } } },
        },
      }],
    });
    const tools = wire(request.body).tools;
    expect(tools).toHaveLength(1);
    const declarations = tools[0].functionDeclarations;
    expect(declarations).toHaveLength(1);
    expect(declarations[0].name).toBe('get_weather');
  });

  it('test_error_handling_invalid_json', () => {
    expect(() => build({ invalid: 'structure' })).toThrowError(AdapterError);
    try {
      build({ invalid: 'structure' });
      throw new Error('expected AdapterError');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).kind).toBe('serialization_error');
      expect((error as AdapterError).message).toContain('Failed to parse OpenAI request');
    }
  });

  it('test_parse_invalid_stream_line', () => {
    expect(parseGeminiStreamLine('not a data line', newState())).toHaveLength(0);
    expect(parseGeminiStreamLine('data: not json', newState())).toHaveLength(0);
  });

  it('test_usage_robustness', () => {
    const response = wire(convertGeminiNonstreamResponseToOpenai(json({
      candidates: [{ content: { parts: [{ text: 'Hello' }] }, index: 0 }],
    }), 'gemini-pro'));
    expect(response.usage.prompt_tokens).toBe(0);
    expect(response.usage.completion_tokens).toBe(0);
    expect(response.usage.total_tokens).toBe(0);

    const partial = wire(convertGeminiNonstreamResponseToOpenai(json({
      candidates: [{ content: { parts: [{ text: 'Hello' }] }, index: 0 }],
      usageMetadata: { promptTokenCount: 10 },
    }), 'gemini-pro'));
    expect(partial.usage.prompt_tokens).toBe(10);
    expect(partial.usage.completion_tokens).toBe(0);
    expect(partial.usage.total_tokens).toBe(10);
  });

  it('test_tool_response_mapping', () => {
    const request = build({
      model: 'gpt-4',
      messages: [
        { role: 'user', content: "What's the weather like?" },
        {
          role: 'assistant',
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location": "Tokyo"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_123', name: 'get_weather', content: '{"temperature": 25, "condition": "sunny"}' },
      ],
    });
    const contents = wire(request.body).contents;
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe('user');
    expect(contents[1].role).toBe('model');
    expect(contents[1].parts[0].text).toBe('[Tool call: get_weather({"location":"Tokyo"})]');
    expect(contents[2].role).toBe('user');
    expect(contents[2].parts[0].text).toBe('[Tool result for get_weather: {"temperature":25,"condition":"sunny"}]');
  });

  it('test_multiple_content_parts', () => {
    const response = wire(convertGeminiNonstreamResponseToOpenai(json({
      candidates: [{
        content: {
          parts: [
            { text: 'Part 1' },
            { text: 'Part 2' },
            { functionCall: { name: 'func', args: { key: 'value' } } },
          ],
        },
        index: 0,
      }],
    }), 'gemini-pro'));

    const message = response.choices[0].message;
    expect(message.content).toBe('Part 1\nPart 2');
    expect(message.tool_calls).toHaveLength(1);
  });

  it('test_topk_injection_from_openai_body', () => {
    const request = buildGeminiRequestWithVersion(
      'https://generativelanguage.googleapis.com',
      'k',
      'gemini-2.5-pro',
      json({ model: 'gemini-2.5-pro', messages: [{ role: 'user', content: 'hi' }], top_k: 33 }),
      'v1',
    );
    expect(wire(request.body).generationConfig.topK).toBe(33);
  });

  it('test_thinking_forces_v1beta_when_no_version_specified', () => {
    const request = buildGeminiRequestWithVersion(
      'https://generativelanguage.googleapis.com',
      'k',
      'gemini-2.5-flash',
      json({
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'hi' }],
        google_thinking_config: { include_thoughts: true },
      }),
      undefined,
    );
    expect(request.url).toContain('/v1beta/');
  });

  it('test_gemini_25_explicit_thinking_budget_overrides_reasoning_effort', () => {
    const cases: [Record<string, unknown>, number][] = [
      [
        {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'hi' }],
          reasoning_effort: 'high',
          thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
        },
        0,
      ],
      [
        {
          model: 'gemini-2.5-pro',
          messages: [{ role: 'user', content: 'hi' }],
          reasoning_effort: 'minimal',
          google_thinking_config: { thinking_budget: -1, include_thoughts: true },
        },
        -1,
      ],
    ];
    for (const [openaiBody, expectedBudget] of cases) {
      const request = build(openaiBody, openaiBody.model as string);
      expect(wire(request.body).generationConfig.thinkingConfig.thinkingBudget).toBe(expectedBudget);
    }
  });

  it('test_gemini_25_reasoning_effort_supplies_budget_without_explicit_config', () => {
    const request = build({
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    }, 'gemini-2.5-flash');
    expect(wire(request.body).generationConfig.thinkingConfig.thinkingBudget).toBe(24576);
  });

  it('test_stream_function_call_preserves_native_id', () => {
    const events = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"fc-native-123","name":"get_weather","args":{"location":"Tokyo"}}}]}}]}',
      newState(),
    );
    expect(events).toHaveLength(1);
    expect(wire((events[0] as Wire).value).id).toBe('fc-native-123');
  });

  it('test_stream_function_call_without_id_falls_back_to_uuid', () => {
    const events = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_weather","args":{}}}]}}]}',
      newState(),
    );
    expect(events).toHaveLength(1);
    const id = wire((events[0] as Wire).value).id as string;
    expect(isSyntheticToolCallId(id)).toBe(true);
  });

  it('test_stream_late_native_id_replaces_synthetic', () => {
    const state = newState();
    parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"f","args":{}}}]}}]}',
      state,
    );
    const events = parseGeminiStreamLine(
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"id":"fc-late","name":"f","args":{"a":1}}}]}}]}',
      state,
    );
    expect(wire((events[0] as Wire).value).id).toBe('fc-late');
  });

  it('test_nonstream_function_call_preserves_native_id', () => {
    const response = wire(convertGeminiNonstreamResponseToOpenai(json({
      candidates: [{
        content: { parts: [{ functionCall: { id: 'fc-abc', name: 'func', args: { k: 'v' } } }] },
        index: 0,
      }],
    }), 'gemini-3.5-flash'));
    expect(response.choices[0].message.tool_calls[0].id).toBe('fc-abc');
  });

  it('test_native_id_round_trip_into_function_call_and_response', () => {
    const request = build({
      model: 'gemini-3.5-flash',
      messages: [
        { role: 'user', content: "What's the weather?" },
        {
          role: 'assistant',
          thought_signature: 'sig-1',
          tool_calls: [{
            id: 'fc-native-1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location": "Tokyo"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'fc-native-1', name: 'get_weather', content: '{"temp": 25}' },
      ],
    }, 'gemini-3.5-flash');

    const contents = wire(request.body).contents;
    expect(contents).toHaveLength(3);
    const functionCall = contents[1].parts[0].functionCall;
    expect(functionCall.id).toBe('fc-native-1');
    expect(functionCall.name).toBe('get_weather');
    const functionResponse = contents[2].parts[0].functionResponse;
    expect(functionResponse.id).toBe('fc-native-1');
    expect(functionResponse.name).toBe('get_weather');
  });

  it('test_synthetic_id_not_sent_back_to_api', () => {
    const syntheticId = `call-${randomUUID()}`;
    const request = build({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: "What's the weather?" },
        {
          role: 'assistant',
          thought_signature: 'sig-1',
          tool_calls: [{
            id: syntheticId,
            type: 'function',
            function: { name: 'get_weather', arguments: '{}' },
          }],
        },
        { role: 'tool', tool_call_id: syntheticId, name: 'get_weather', content: '{"temp": 25}' },
      ],
    }, 'gemini-2.5-flash');

    const contents = wire(request.body).contents;
    expect(contents[1].parts[0].functionCall.id).toBeUndefined();
    expect(contents[2].parts[0].functionResponse.id).toBeUndefined();
  });

  it('test_unknown_content_part_degrades_instead_of_failing', () => {
    const request = build({
      model: 'gemini-3.5-flash',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this' },
          { type: 'input_audio', input_audio: { data: 'base64...', format: 'wav' } },
          { type: 'video_url', video_url: { url: 'https://example.com/v.mp4' } },
          { type: 'input_file', file_data: '...' },
        ],
      }],
    }, 'gemini-3.5-flash');
    const parts = wire(request.body).contents[0].parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe('Describe this');
  });

  it('test_is_synthetic_tool_call_id', () => {
    expect(isSyntheticToolCallId(`call-${randomUUID()}`)).toBe(true);
    expect(isSyntheticToolCallId('fc-native-123')).toBe(false);
    expect(isSyntheticToolCallId('call-123')).toBe(false);
    expect(isSyntheticToolCallId('')).toBe(false);
  });

  it('test_penalties_flow_into_generation_config', () => {
    const request = buildGeminiRequestWithVersion(
      'https://generativelanguage.googleapis.com',
      'k',
      'gemini-2.5-pro',
      json({
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }],
        frequency_penalty: 0.4,
        presence_penalty: 0.2,
      }),
      'v1',
    );
    const config = wire(request.body).generationConfig;
    expect(config.frequencyPenalty).toBeCloseTo(0.4, 6);
    expect(config.presencePenalty).toBeCloseTo(0.2, 6);
  });
});

describe('gemini remote image inline data', () => {
  it('image_url_to_inline_data_uses_injected_binary_cache', () => {
    setRemoteImageFetcher({
      fetchImage: url => url === 'https://example.com/a.png'
        ? { bytes: new TextEncoder().encode('png-bytes'), mimeType: 'image/png' }
        : undefined,
    });
    try {
      const request = build({
        model: 'gpt-4',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        }],
      });
      const parts = wire(request.body).contents[0].parts as Wire[];
      expect(parts).toHaveLength(2);
      expect(parts[1].inlineData).toEqual({
        mimeType: 'image/png',
        data: Buffer.from('png-bytes').toString('base64'),
      });
    } finally {
      setRemoteImageFetcher(null);
    }
  });

  it('image_url_to_inline_data_drops_remote_images_when_cache_misses', () => {
    setRemoteImageFetcher({ fetchImage: () => undefined });
    try {
      const request = build({
        model: 'gpt-4',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
          ],
        }],
      });
      const parts = wire(request.body).contents[0].parts as Wire[];
      expect(parts).toHaveLength(1);
      expect(parts[0].text).toBe('hi');
    } finally {
      setRemoteImageFetcher(null);
    }
  });
});

it('gemini_converter_logs_unsupported_parts_and_merged_turns', () => {
  const { logger, messages } = createRecordingLogger();
  const request = buildGeminiRequestWithVersion(
    'https://generativelanguage.googleapis.com', 'test-api-key', 'gemini-pro',
    json({
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'first' },
            { type: 'input_audio', input_audio: { data: 'AAA', format: 'wav' } },
          ],
        },
        { role: 'user', content: 'second' },
      ],
    }),
    undefined,
    logger,
  );
  const contents = wire(request.body).contents as Wire[];
  expect(contents).toHaveLength(1);
  expect(contents[0].parts).toEqual([{ text: 'first' }, { text: 'second' }]);
  expect(messages.map(entry => entry.level)).toEqual(['warn', 'warn']);
  expect(messages[0]!.message).toContain('Skipping unsupported content part type');
  expect(messages[1]).toMatchObject({
    level: 'warn',
    message: "[GeminiConverter] Merged consecutive '%s' turns (%d parts appended)",
    args: ['user', 1],
  });
});
