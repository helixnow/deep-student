import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../api.ts';
import { GeminiAdapter } from '../src/providers/gemini.ts';

const json = (value: unknown): JsonValue => value as JsonValue;
const body = (model: string, extra: Record<string, unknown> = {}) => json({
  model,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});
const ENDPOINT = 'https://generativelanguage.googleapis.com';

describe('gemini provider adapter', () => {
  it('builds the request from a v1beta model prefix', () => {
    const request = new GeminiAdapter().buildRequest(ENDPOINT, 'k', 'v1beta:gemini-pro', body('ignored'));
    expect(request.url).toContain('/v1beta/models/gemini-pro:generateContent');
    expect(request.headers).toEqual([
      ['Content-Type', 'application/json'],
      ['x-goog-api-key', 'k'],
    ]);
  });

  it('uses gemini_api_version from the body when the model has no prefix', () => {
    const request = new GeminiAdapter().buildRequest(
      ENDPOINT, 'k', 'gemini-pro', body('gemini-pro', { gemini_api_version: 'v1beta' }),
    );
    expect(request.url).toContain('/v1beta/models/gemini-pro:generateContent');
    expect((request.body as Record<string, unknown>).gemini_api_version).toBeUndefined();
  });

  it('lets the model prefix win over gemini_api_version', () => {
    const request = new GeminiAdapter().buildRequest(
      ENDPOINT, 'k', 'v1:gemini-pro', body('gemini-pro', { gemini_api_version: 'v1beta' }),
    );
    expect(request.url).toContain('/v1/models/gemini-pro:generateContent');
  });

  it('wraps converter failures like ProviderError::BuildFailed', () => {
    expect(() => new GeminiAdapter().buildRequest(ENDPOINT, 'k', 'gemini-pro', json({ messages: [] })))
      .toThrowError(/^Gemini 请求构建失败: Serialization error: /);
  });

  it('parses stream lines with the converter state and terminal semantics', () => {
    const adapter = new GeminiAdapter();
    expect(adapter.requiresExplicitStreamCompletion()).toBe(true);
    expect(adapter.parseStream('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}'))
      .toEqual([{ type: 'ContentChunk', value: 'hi' }]);
    expect(adapter.parseStream('data: {"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":2,"totalTokenCount":3}}')[0]!.type)
      .toBe('Usage');
    expect(adapter.parseStream('data: [DONE]')).toEqual([{ type: 'Done' }]);
    expect(adapter.finishStream()).toEqual([]);
  });

  it('completes on STOP after delivering content and usage', () => {
    const adapter = new GeminiAdapter();
    expect(adapter.parseStream(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'finished' }] }, finishReason: 'STOP' }],
      usageMetadata: { totalTokenCount: 3 },
    })).map(event => event.type)).toEqual(['ContentChunk', 'Usage', 'Done']);
  });

  it('reports unsuccessful finish reasons instead of completing successfully', () => {
    const adapter = new GeminiAdapter();
    for (const reason of ['MAX_TOKENS', 'SAFETY', 'MALFORMED_FUNCTION_CALL']) {
      expect(adapter.parseStream(JSON.stringify({ candidates: [{ finishReason: reason }] })))
        .toEqual([expect.objectContaining({ type: 'SafetyBlocked', value: expect.objectContaining({ reason }) })]);
    }
  });

  it.each([undefined, 'native'])('keeps calls at parts[0] distinct across chunks (%s IDs)', (idPrefix) => {
    const adapter = new GeminiAdapter();
    const call = (name: string, args: unknown) => adapter.parseStream(JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: {
        ...(idPrefix ? { id: `${idPrefix}-${name}` } : {}), name, args,
      } }] } }],
    }))[0];
    const first = call('tool_one', { first: 1 });
    const second = call('tool_two', { second: 2 });
    expect(first).toMatchObject({ type: 'ToolCall', value: {
      index: 0, function: { name: 'tool_one', arguments: '{"first":1}' },
    } });
    expect(second).toMatchObject({ type: 'ToolCall', value: {
      index: 1, function: { name: 'tool_two', arguments: '{"second":2}' },
    } });
    expect(adapter._pendingToolCalls.size).toBe(2);
  });

  it('reuses a stream-global index only for the same native call ID', () => {
    const adapter = new GeminiAdapter();
    const chunk = JSON.stringify({ candidates: [{ content: { parts: [{
      functionCall: { id: 'native-one', name: 'tool_one', args: {} },
    }] } }] });
    expect(adapter.parseStream(chunk)[0]).toMatchObject({ value: { index: 0 } });
    expect(adapter.parseStream(chunk)[0]).toMatchObject({ value: { index: 0 } });
    expect(adapter._pendingToolCalls.size).toBe(1);
  });
});
