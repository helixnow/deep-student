import { describe, expect, it } from 'vitest';
import { AppError } from '../../../platform/errors/api.ts';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import { makeConfig } from './support.ts';
import {
  bodyRejectsStreaming, defaultSingleShotOptions, isRetryableHttpStatus,
  isStreamKnownUnsupported, runSingleShot,
  type SingleShotCompletion, type SingleShotOptions, type SingleShotResponse,
  type SingleShotSender, type TransportMode,
} from '../src/single_shot_stream.ts';

/**
 * 单次结构化补全的流式传输（llm_manager/single_shot_stream.rs）。
 *
 * `send` 是可注入的：每个测试直接决定每次尝试返回的 HTTP 响应与字节节奏，
 * 不发起任何真实网络请求；超时窗口被压到毫秒级。
 */

const encoder = new TextEncoder();

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function bodyOf(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function testConfig(id: string) {
  return makeConfig({ id, name: id, model: 'mock-model', baseUrl: 'http://127.0.0.1', enabled: true });
}

function sse(events: string[]): string {
  return events.map((event) => `data: ${event}\n\n`).join('');
}

function contentEvent(text: string): string {
  return JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

function finishEvent(): string {
  return JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
}

function sseResponse(body: string): SingleShotResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    adapter: new OpenAIAdapter(),
    isCodex: false,
    body: bodyOf([bytes(body)]),
  };
}

function jsonResponse(payload: unknown): SingleShotResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    adapter: new OpenAIAdapter(),
    isCodex: false,
    body: bodyOf([bytes(JSON.stringify(payload))]),
  };
}

function statusResponse(status: number, body: string, headers: Record<string, string> = {}): SingleShotResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    adapter: new OpenAIAdapter(),
    isCodex: false,
    body: bodyOf([bytes(body)]),
  };
}

/** SSE response whose chunks arrive one by one with `intervalMs` between them. */
function pacedSseResponse(
  chunks: string[], intervalMs: number, stallAtEnd: boolean,
): SingleShotResponse {
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    adapter: new OpenAIAdapter(),
    isCodex: false,
    body: {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < chunks.length; index += 1) {
          if (index > 0) await delay(intervalMs);
          yield bytes(chunks[index]!);
        }
        if (stallAtEnd) await new Promise<never>(() => {});
      },
    },
  };
}

interface Harness {
  attempts: number;
  modes: TransportMode[];
  send: SingleShotSender;
}

function harness(
  handler: (
    attempt: number, body: { stream: boolean },
  ) => SingleShotResponse | Promise<SingleShotResponse>,
): Harness {
  const state: Harness = {
    attempts: 0,
    modes: [],
    send: async (mode) => {
      const attempt = state.attempts;
      state.attempts += 1;
      state.modes.push(mode);
      return handler(attempt, { stream: mode === 'stream' });
    },
  };
  return state;
}

function fastOptions(): SingleShotOptions {
  return {
    ...defaultSingleShotOptions('test'),
    headerTimeoutMs: 5_000,
    idleTimeoutMs: 300,
    totalTimeoutMs: 10_000,
    nonstreamTimeoutMs: 5_000,
    backoffBaseMs: 10,
    backoffMaxMs: 20,
  };
}

/** Runs the driver and returns the thrown AppError (fails if it resolves). */
async function failure(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the single-shot call to fail');
}

describe('src-tauri/crates/dstu-llm/src/llm_manager/single_shot_stream.rs', () => {
  it('accumulates_content_and_ignores_reasoning', async () => {
    const server = harness((_attempt, body) => {
      expect(body.stream).toBe(true);
      const reasoning = JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] });
      const usage = JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } });
      return sseResponse(sse([
        reasoning,
        contentEvent('[{"a":'),
        contentEvent('1}]'),
        finishEvent(),
        usage,
        '[DONE]',
      ]));
    });

    const completion: SingleShotCompletion = await runSingleShot(
      fastOptions(), testConfig('accumulate'), server.send,
    );

    expect(completion.content).toBe('[{"a":1}]');
    expect(completion.reasoningBytes).toBe('thinking...'.length);
    expect(completion.finishReason).toBe('stop');
    expect((completion.usage as { prompt_tokens: number }).prompt_tokens).toBe(11);
    expect(completion.mode).toBe('stream');
    expect(completion.attempts).toBe(1);
  });

  it('slow_but_steady_stream_outlives_fixed_total_timeouts', async () => {
    // 16 chunks, 120ms apart (~1.8s total): far beyond the 300ms idle window
    // that a fixed total timeout would have cut at.
    const chunks: string[] = [];
    for (let index = 0; index < 15; index += 1) {
      chunks.push(`data: ${contentEvent(String(index))}\n\n`);
    }
    chunks.push(`data: ${finishEvent()}\n\ndata: [DONE]\n\n`);
    const server = harness(() => pacedSseResponse(chunks, 120, false));

    const started = Date.now();
    const completion = await runSingleShot(
      fastOptions(), testConfig('steady'), server.send,
    );

    expect(Date.now() - started).toBeGreaterThan(1_500);
    expect(completion.content).toBe('01234567891011121314');
    expect(server.attempts).toBe(1);
  });

  it('idle_stream_times_out_and_retries', async () => {
    const server = harness((attempt) => {
      if (attempt === 0) {
        // One chunk then silence.
        return pacedSseResponse([`data: ${contentEvent('partial')}\n\n`], 10, true);
      }
      return sseResponse(sse([contentEvent('ok'), finishEvent(), '[DONE]']));
    });

    const started = Date.now();
    const completion = await runSingleShot(
      fastOptions(), testConfig('idle-retry'), server.send,
    );

    expect(completion.content).toBe('ok');
    expect(completion.attempts).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it('idle_timeout_surfaces_after_retry_budget', async () => {
    const server = harness(() => pacedSseResponse([], 10, true));
    const opts = { ...fastOptions(), maxRetries: 1 };

    const error = await failure(runSingleShot(opts, testConfig('idle-exhausted'), server.send));

    expect(error.message).toContain('空闲');
    expect(server.attempts).toBe(2);
  });

  it('total_cap_is_fatal_and_not_retried', async () => {
    const chunks: string[] = [];
    for (let index = 0; index < 100; index += 1) {
      chunks.push(`data: ${contentEvent('x')}\n\n`);
    }
    const server = harness(() => pacedSseResponse(chunks, 50, false));
    const opts = {
      ...fastOptions(),
      headerTimeoutMs: 5_000,
      idleTimeoutMs: 300,
      totalTimeoutMs: 600,
    };

    const error = await failure(runSingleShot(opts, testConfig('total-cap'), server.send));

    expect(error.message).toContain('总时长');
    // single_shot_stream.rs:476-479 prints `total_timeout.as_secs()`, which truncates 600 ms to 0.
    expect(error.message).toBe('test 流式响应超过总时长上限 0s');
    expect(server.attempts).toBe(1);
  });

  it('retries_cloudflare_524', async () => {
    const server = harness((attempt) => {
      if (attempt === 0) return statusResponse(524, 'error code: 524');
      return sseResponse(sse([contentEvent('ok'), finishEvent(), '[DONE]']));
    });

    const completion = await runSingleShot(fastOptions(), testConfig('524'), server.send);

    expect(completion.content).toBe('ok');
    expect(completion.attempts).toBe(2);
  });

  it('client_errors_are_not_retried_and_keep_status_details', async () => {
    const server = harness(() => statusResponse(401, '{"error":{"message":"bad key"}}'));

    const error = await failure(runSingleShot(fastOptions(), testConfig('401'), server.send));

    expect((error.details as { status: number }).status).toBe(401);
    expect(server.attempts).toBe(1);
  });

  it('stream_rejection_falls_back_to_nonstream_and_is_remembered', async () => {
    const server = harness((_attempt, body) => {
      if (body.stream) {
        return statusResponse(
          400,
          '{"error":{"message":"Streaming is not supported for this model"}}',
          { 'content-type': 'application/json' },
        );
      }
      return jsonResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: 'plain' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      });
    });
    const config = testConfig('stream-unsupported-fallback');

    const completion = await runSingleShot(fastOptions(), config, server.send);

    expect(completion.content).toBe('plain');
    expect(completion.mode).toBe('nonStream');
    expect((completion.usage as { prompt_tokens: number }).prompt_tokens).toBe(3);
    expect(isStreamKnownUnsupported(config)).toBe(true);

    // Second call goes straight to non-streaming.
    const second = await runSingleShot(fastOptions(), config, server.send);

    expect(second.content).toBe('plain');
    expect(second.attempts).toBe(1);
    expect(server.modes).toEqual(['stream', 'nonStream', 'nonStream']);
  });

  it('provider_ignoring_stream_flag_is_parsed_as_json', async () => {
    const server = harness(() => jsonResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'json-body' }, finish_reason: 'stop' }],
    }));

    const completion = await runSingleShot(
      fastOptions(), testConfig('ignored-stream'), server.send,
    );

    expect(completion.content).toBe('json-body');
  });

  it('byte_cap_is_enforced_without_retry', async () => {
    const server = harness(() => {
      const big = 'x'.repeat(4_096);
      return sseResponse(sse([contentEvent(big), contentEvent(big), '[DONE]']));
    });
    const opts = { ...fastOptions(), maxStreamBytes: 2_048 };

    const error = await failure(runSingleShot(opts, testConfig('byte-cap'), server.send));

    expect(error.message).toContain('大小上限');
    expect(server.attempts).toBe(1);
  });

  it('eof_without_terminal_marker_is_retried', async () => {
    const server = harness((attempt) => (attempt === 0
      ? sseResponse(sse([contentEvent('trunc')]))
      : sseResponse(sse([contentEvent('full'), finishEvent(), '[DONE]']))));

    const completion = await runSingleShot(
      fastOptions(), testConfig('missing-terminal'), server.send,
    );

    expect(completion.content).toBe('full');
    expect(completion.attempts).toBe(2);
  });

  it('delivered_partial_is_returned_instead_of_retried', async () => {
    const server = harness(() => pacedSseResponse(
      [`data: ${contentEvent('[{"q":1},')}\n\n`], 10, true,
    ));
    let seen = '';

    const completion = await runSingleShot(
      fastOptions(),
      testConfig('partial'),
      server.send,
      (delta) => { seen += delta; return true; },
    );

    expect(completion.interrupted).not.toBeNull();
    expect(completion.content).toBe('[{"q":1},');
    expect(seen).toBe('[{"q":1},');
    expect(server.attempts).toBe(1);
  });

  it('cancellation_drops_the_stream_promptly', async () => {
    const server = harness(() => pacedSseResponse([], 10, true));
    const controller = new AbortController();
    const opts: SingleShotOptions = {
      ...fastOptions(),
      headerTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 10_000,
      cancel: controller.signal,
    };
    setTimeout(() => controller.abort(), 100);

    const started = Date.now();
    const error = await failure(runSingleShot(opts, testConfig('cancel'), server.send));

    expect(error.message).toContain('取消');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('retryable_status_policy', () => {
    for (const status of [408, 429, 500, 502, 503, 504, 520, 522, 524, 529]) {
      expect(isRetryableHttpStatus(status), String(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 413, 422, 501, 505]) {
      expect(isRetryableHttpStatus(status), String(status)).toBe(false);
    }
    expect(bodyRejectsStreaming(400, "Unsupported parameter: 'stream'")).toBe(true);
    expect(bodyRejectsStreaming(400, 'max_tokens too large')).toBe(false);
    expect(bodyRejectsStreaming(500, 'stream failed')).toBe(false);
  });
});
