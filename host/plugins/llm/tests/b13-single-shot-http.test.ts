import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import { createLlmStreamingService } from '../src/streaming_service.ts';
import { defaultSingleShotOptions } from '../src/single_shot_stream.ts';
import { makeConfig } from './support.ts';

let server: Server;
let baseUrl: string;
let handler: (response: ServerResponse) => void;
beforeAll(async () => {
  server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain request before replying. */ }
    handler(response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const service = createLlmStreamingService({ createAdapter: () => new OpenAIAdapter() });
function call(id: string, onDelta?: (text: string) => boolean) {
  return service.singleShotCompletion(makeConfig({ id, baseUrl, apiProtocol: 'openai_chat_completions' }),
    { messages: [{ role: 'user', content: 'fixture' }] }, 'fixture-key', 'fixture-session', 'build failed',
    { ...defaultSingleShotOptions(id), maxRetries: 1, backoffBaseMs: 1, backoffMaxMs: 1 }, onDelta);
}
const content = 'data: {"choices":[{"delta":{"content":"中文"}}]}\n\n';

describe('B13 single-shot local HTTP regressions', () => {
  it('keeps oversized HTTP errors bounded without a RangeError and retries once', async () => {
    let hits = 0;
    handler = response => {
      hits++;
      response.writeHead(503);
      response.end('busy '.repeat(30_000));
    };
    await expect(call('b13-large-error')).rejects.toMatchObject({
      error_type: 'LLM', message: expect.stringContaining('503'),
    });
    expect(hits).toBe(2);
  });

  it('does not silently accept truncated SSE mislabeled as JSON after delivering content', async () => {
    let hits = 0;
    handler = response => {
      hits++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(content);
    };
    const chunks: string[] = [];
    const result = await call('b13-json-sse-truncated', text => { chunks.push(text); return true; });
    expect(result.content).toBe('中文');
    expect(result.interrupted).toContain('未收到结束标记');
    expect(chunks).toEqual(['中文']);
    expect(hits).toBe(1);
  });

  it('accepts complete mislabeled SSE and preserves split UTF-8 over a slow socket', async () => {
    handler = response => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const bytes = Buffer.from(content + 'data: [DONE]\n\n');
      const split = bytes.indexOf(Buffer.from('中')) + 1;
      response.write(bytes.subarray(0, split));
      setTimeout(() => response.end(bytes.subarray(split)), 25);
    };
    expect(await call('b13-json-sse-complete')).toMatchObject({ content: '中文', interrupted: null, attempts: 1 });
  });

  it('retries truncated mislabeled SSE only when no callback has received content', async () => {
    let hits = 0;
    handler = response => {
      hits++;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(content);
    };
    await expect(call('b13-json-sse-retry')).rejects.toMatchObject({
      error_type: 'Network', message: expect.stringContaining('未收到结束标记'),
    });
    expect(hits).toBe(2);
  });

  it('accepts a provider finish reason at EOF even without a DONE marker', async () => {
    handler = response => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(content + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    };
    expect(await call('b13-json-sse-finish')).toMatchObject({
      content: '中文', finishReason: 'stop', interrupted: null, attempts: 1,
    });
  });
});
