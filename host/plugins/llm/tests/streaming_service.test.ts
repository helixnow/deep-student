import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { defaultSingleShotOptions } from '../api.ts';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import { makeConfig } from './support.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let server: Server;
let url: string;
let handler: (body: Record<string, unknown>, response: ServerResponse) => void;
beforeAll(async () => {
  server = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const chunk of request) buffers.push(Buffer.from(chunk));
    handler(JSON.parse(Buffer.concat(buffers).toString()), response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  host = await createTestHost({ plugins: [plugin], provide: {
    settings: { get: () => null }, secrets: {}, llmAdapters: { createAdapter: () => new OpenAIAdapter() },
  } });
}, 120_000);
afterAll(async () => { await host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });

const delta = (text: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
function call(id: string, onDelta?: (text: string) => boolean, signal?: AbortSignal) {
  const options = { ...defaultSingleShotOptions(id), maxRetries: 1, backoffBaseMs: 1, backoffMaxMs: 1,
    idleTimeoutMs: 35, headerTimeoutMs: 1000, totalTimeoutMs: 1000, ...(signal ? { cancel: signal } : {}) };
  return host.ctx.llmStreaming.singleShotCompletion(makeConfig({ id, baseUrl: url, apiProtocol: 'openai_chat_completions' }),
    { messages: [{ role: 'user', content: 'cards' }], temperature: 0.4 }, 'secret', 'session', 'build failed', options, onDelta);
}

describe('published llmStreaming service', () => {
  it('publishes ordered adapter metadata without aliases for L16', () => {
    const infos = host.ctx.llmAdapterInfos.listAdapterInfos();
    expect(infos.map(info => info.value)).toEqual(['general', 'google', 'anthropic', 'mistral',
      'deepseek', 'qwen', 'zhipu', 'doubao', 'ernie', 'moonshot', 'grok', 'minimax', 'mimo']);
    expect(infos.every(info => info.label.length > 0 && info.description.length > 0)).toBe(true);
  });
  it('streams deltas and exposes completion metadata through the real HTTP transport', async () => {
    handler = (body, response) => {
      expect(body.stream).toBe(true);
      expect(body.temperature).toBe(0.4);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(delta('卡片') + 'data: [DONE]\n\n');
    };
    const chunks: string[] = [];
    const result = await call('normal', text => { chunks.push(text); return true; });
    expect(chunks).toEqual(['卡片']);
    expect(result).toMatchObject({ content: '卡片', mode: 'stream', attempts: 1, interrupted: null, aborted: false });
  });
  it('retries establishment and falls back when stream is explicitly rejected', async () => {
    const modes: unknown[] = [];
    handler = (body, response) => {
      modes.push(body.stream);
      if (modes.length === 1) { response.writeHead(503); response.end('busy'); }
      else if (body.stream) { response.writeHead(400); response.end('stream is unsupported'); }
      else { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: 'answer' } }] })); }
    };
    expect(await call('fallback')).toMatchObject({ content: 'answer', mode: 'nonStream', attempts: 3 });
    expect(modes).toEqual([true, true, false]);
  });
  it('preserves CRLF event metadata and flushes EOF through the shared production SSE buffer', async () => {
    handler = (_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const bytes = Buffer.from('event: message\r\ndata: {"choices":[{"delta":{"content":"数学题"}}]}\r\n\r\ndata: [DONE]');
      const split = bytes.indexOf(Buffer.from('数')) + 1;
      response.write(bytes.subarray(0, split));
      response.end(bytes.subarray(split));
    };
    const received: string[] = [];
    const result = await call('shared-sse', text => { received.push(text); return true; });
    expect(result.content).toBe('数学题');
    expect(received).toEqual(['数学题']);
    expect(result.interrupted).toBeNull();
    expect(result.attempts).toBe(1);
  });
  it('drops a stalled response before retrying and on final timeout', async () => {
    let closed = 0, hits = 0;
    handler = (_body, response) => {
      hits++;
      response.on('close', () => closed++);
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
    };
    await expect(call('idle')).rejects.toMatchObject({ error_type: 'Network' });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(hits).toBe(2);
    expect(closed).toBe(2);
  });
  it('never retries after delivering partial output', async () => {
    let hits = 0;
    handler = (_body, response) => {
      hits++;
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(delta('partial'));
    };
    const result = await call('partial', () => true);
    expect(result.content).toBe('partial');
    expect(result.interrupted).not.toBeNull();
    expect(hits).toBe(1);
  });
  it('cancellation aborts the socket and callback false stops delivery', async () => {
    let closed!: () => void;
    const dropped = new Promise<void>(resolve => { closed = resolve; });
    const controller = new AbortController();
    handler = (_body, response) => {
      response.on('close', closed);
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(delta('first'));
    };
    await expect(call('cancel', () => { controller.abort(); return true; }, controller.signal))
      .rejects.toMatchObject({ message: expect.stringContaining('请求已取消') });
    await dropped;
    expect(await call('stop', () => false)).toMatchObject({ content: 'first', aborted: true });
  });
});
