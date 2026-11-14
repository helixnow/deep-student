import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { makeConfig } from './support.ts';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import {
  LocalOcrRequests, buildOcrRequestBody, nextOcrResult, runOcrWithDeadline,
  runSingleOcrRequest, type OcrResultChannel, type PreparedOcrRequest,
} from '../src/exam_engine.ts';

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('exam_engine.rs', () => {
  it('ocr_request_payload_has_no_adapter_output_cap', () => {
    const config = makeConfig({ maxOutputTokens: 12_000, maxTokensLimit: null });
    expect(buildOcrRequestBody(config, [], 0).max_tokens).toBe(12_000);

    const limited = makeConfig({ maxOutputTokens: 40_000, maxTokensLimit: 24_000 });
    expect(buildOcrRequestBody(limited, [], 0).max_tokens).toBe(24_000);

    const small = makeConfig({ maxOutputTokens: 1_024, maxTokensLimit: null });
    expect(buildOcrRequestBody(small, [], 0).max_tokens).toBe(1_024);
  });

  it('local_codex_result_survives_closed_background_channel', async () => {
    const closedChannel: OcrResultChannel = { next: async () => null };

    const localRequests = new LocalOcrRequests();
    localRequests.add(7, (async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return 'codex-result';
    })());

    const result = await Promise.race([
      nextOcrResult(closedChannel, localRequests),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('local request should not be starved by the closed channel')), 1_000);
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result).toEqual([7, { ok: true, value: 'codex-result' }]);
  });

  it('keeps a losing channel receive for the next selection instead of dropping its result', async () => {
    const local = new LocalOcrRequests();
    let remoteDone!: (result: import('../src/exam_engine.ts').OcrRequestResult) => void;
    const remote = new Promise<import('../src/exam_engine.ts').OcrRequestResult>(resolve => { remoteDone = resolve; });
    let receives = 0;
    const channel: OcrResultChannel = { next: () => ++receives === 1 ? remote : Promise.resolve(null) };
    local.add(1, Promise.resolve('local'));
    expect(await nextOcrResult(channel, local)).toEqual([1, { ok: true, value: 'local' }]);
    remoteDone([2, { ok: true, value: 'remote' }]);
    expect(await nextOcrResult(channel, local)).toEqual([2, { ok: true, value: 'remote' }]);
    expect(receives).toBe(1);
  });

  /**
   * 落败的对冲引擎通过取消令牌停止；其 future（以及流式 HTTP 响应）必须被
   * drop，使供应商停止生成而不是继续在后台流式输出。
   */
  it('cancelled_hedge_engine_drops_its_stream', async () => {
    let firstChunkSent = false;
    let streamDropped = false;
    const observed = { body: null as { [key: string]: unknown } | null };

    const server = await startServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        observed.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { [key: string]: unknown };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.flushHeaders();
        const timer = setInterval(() => {
          firstChunkSent = true;
          response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'x' } }] })}\n\n`);
        }, 30);
        response.on('close', () => {
          clearInterval(timer);
          streamDropped = true;
        });
      });
    });

    try {
      const request: PreparedOcrRequest = {
        idx: 1,
        engineName: 'hedge_engine',
        modelName: 'ocr-model',
        config: makeConfig({
          id: 'hedge-drop-test',
          name: 'hedge-drop-test',
          model: 'ocr-model',
          baseUrl: `${server.base}/v1`,
        }),
        apiKey: 'test-key',
        requestBody: { model: 'ocr-model', messages: [] },
        isCodex: false,
      };

      const race = new AbortController();
      const engine = runSingleOcrRequest({ fetch, adapters: { createAdapter: () => new OpenAIAdapter() } }, request, { cancel: race.signal })
        .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error: messageOf(error) }));

      await waitFor(() => firstChunkSent, 'stream never started');
      expect(observed.body?.stream).toBe(true);

      race.abort();
      expect(await engine).toEqual({ ok: false, error: 'OCR cancelled' });

      await waitFor(
        () => streamDropped,
        'server-side stream must be dropped after the losing engine is cancelled',
      );
    } finally {
      await server.close();
    }
  });

  it('ocr_deadline_covers_stalled_response_body', async () => {
    let bodyStarted = false;
    const server = await startServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      // 前缀发出后永久挂起：只有总超时能结束这次请求。
      response.write('{"choices":');
      bodyStarted = true;
    });

    try {
      const operation = async (signal: AbortSignal): Promise<void> => {
        const response = await fetch(`${server.base}/ocr`, { signal });
        if (!response.ok) throw new Error(`unexpected HTTP status: ${response.status}`);
        const body = await response.text();
        JSON.parse(body);
      };

      const error = await runOcrWithDeadline(2, 'stalled-body', 250, operation)
        .then(() => null, (thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Engine #2 (stalled-body) timed out (250ms)');
      expect(bodyStarted).toBe(true);
    } finally {
      await server.close();
    }
  });
});
