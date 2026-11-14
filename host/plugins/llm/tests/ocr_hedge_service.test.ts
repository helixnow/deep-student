import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import { makeConfig } from './support.ts';
import type { PreparedOcrRequest } from '../src/exam_engine.ts';
import { OcrCircuitBreaker } from '../src/ocr_circuit_breaker.ts';
import { createOcrHedgeService } from '../src/ocr_hedge_service.ts';
import { createLlmStreamingService } from '../src/streaming_service.ts';

describe('OCR progressive hedging production transport', () => {
  it('advances immediately on failure and resolves via the provided service', async () => {
    const hits: string[] = [];
    const server = createServer((request, response) => {
      hits.push(request.url!);
      if (request.url!.startsWith('/first')) { response.writeHead(503); response.end('unavailable'); }
      else { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {"choices":[{"delta":{"content":"OCR text"}}]}\n\ndata: [DONE]\n\n'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {},
      llmAdapters: { createAdapter: () => new OpenAIAdapter() },
    } });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const candidates = ['first', 'second'].map((id, idx) => ({ kind: 'remote' as const, request: prepared(idx, `${base}/${id}`) }));
      expect(await host.ctx.llmOcrHedge.runPrepared(candidates)).toBe('OCR text');
      expect(hits).toEqual(['/first/chat/completions', '/second/chat/completions']);
    } finally { await host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('a later winner cancels a slow HTTP response and releases half-open probes on cancellation', async () => {
    let dropped!: () => void;
    const closed = new Promise<void>(resolve => { dropped = resolve; });
    const server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
      if (request.url!.startsWith('/slow')) response.on('close', dropped);
      else response.end('data: {"choices":[{"delta":{"content":"fast"}}]}\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const adapters = { createAdapter: () => new OpenAIAdapter() };
    const streaming = createLlmStreamingService(adapters);
    const breaker = OcrCircuitBreaker.withConfig(1, 0, 300_000);
    const runner = createOcrHedgeService({ fetch, adapters }, streaming, { decryptApiKey: async key => key },
      { isOcrThinkingEnabled: () => false }, breaker, 25);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const configured = makeConfig({ baseUrl: `${base}/fast`, model: 'vision', maxOutputTokens: 40_000, maxTokensLimit: 24_000 });
      const requests = await runner.prepareCandidates('data:image/png;base64,aW1hZ2U=', [{ kind: 'remote', config: configured, engineType: 'generic_vlm' }], null);
      expect(requests[0]).toMatchObject({ kind: 'remote', request: { apiKey: configured.apiKey,
        requestBody: { max_tokens: 24_000, messages: [{ role: 'user', content: [{ type: 'image_url' }, { type: 'text' }] }] } } });
      expect(await runner.runPrepared(['slow', 'fast'].map((id, idx) => ({ kind: 'remote', request: prepared(idx, `${base}/${id}`) })))).toBe('fast');
      await closed;
      expect(breaker.currentState()).toBe('Closed');
      breaker.recordFailure();
      const cancellation = new AbortController(); cancellation.abort();
      await expect(runner.runPrepared([{ kind: 'remote', request: prepared(0, `${base}/slow`) }], cancellation.signal))
        .rejects.toMatchObject({ message: 'OCR cancelled' });
      expect(breaker.allowRequest()).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

function prepared(idx: number, baseUrl: string): PreparedOcrRequest {
  return { idx, engineName: 'generic_vlm', modelName: 'vision', config: makeConfig({ baseUrl, model: 'vision' }),
    apiKey: 'key', requestBody: { messages: [{ role: 'user', content: 'OCR' }] }, isCodex: false };
}
