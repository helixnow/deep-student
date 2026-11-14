import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import {
  buildToolsWithMcp,
} from '../src/tools.ts';
import {
  bridgeCodexNonstreamResponse, normalizeCodexErrorResponse,
  readCodexResponseBodyLimited,
} from '../src/codex_transport.ts';
import { logAndEmitLlmRequest, NoopStreamSink, flushPendingDebugLogWrites, setDebugLogFiles } from '../src/audit_log.ts';
import { createNodeFiles } from '../../../platform/files/index.ts';
import { preparePlainProviderRequest } from '../src/prepared_request.ts';
import { providerAdapterForConfig } from '../src/provider_adapter.ts';
import { defaultSingleShotOptions, type SingleShotResponse } from '../src/single_shot_stream.ts';
import { runStreamingCompletion } from '../src/stream_sink.ts';
import { makeConfig, type Body } from './support.ts';
import type { JsonValue } from '../../../platform/errors/api.ts';

function sseResponse(...chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(Buffer.from(chunk, 'utf8'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('llm_manager/model2_pipeline.rs', () => {
  it('deepseek_chat_audit_toggle_does_not_change_the_final_request', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'llm-audit-'));
    // Production wires `ctx.files`; standalone calls supply a Node-backed service rooted there.
    setDebugLogFiles(() => createNodeFiles({ roots: [{ name: 'temp', path: temp }] }));
    const config = makeConfig({
      model: 'tree-deepseek-v4.1-flash',
      modelAdapter: 'deepseek',
      providerType: 'custom',
      apiProtocol: 'openai_chat_completions',
      baseUrl: 'https://relay.example/v1',
    });
    const body: Body = {
      model: config.model,
      max_completion_tokens: 128,
      messages: [
        {
          role: 'system',
          content: [{
            type: 'text',
            text: '<available_skills>exact IDs</available_skills>',
            cache_control: { type: 'ephemeral' },
          }],
        },
        { role: 'user', content: 'Load the skill' },
      ],
    };
    const prepared = preparePlainProviderRequest(
      providerAdapterForConfig(config), config, body as unknown as JsonValue, null,
      'sess-audit-test', 'test request',
    );
    expect((prepared.body as Body).messages)
      .toEqual([
        { role: 'system', content: '<available_skills>exact IDs</available_skills>' },
        { role: 'user', content: 'Load the skill' },
      ]);
    expect((prepared.body as Body).max_tokens).toBe(128);
    const before = structuredClone(prepared.body);
    const sink = new NoopStreamSink();
    for (const persistConfig of [null, { log_dir: temp }]) {
      logAndEmitLlmRequest(
        'CHAT_STREAM', sink, 'chat_v2_event_sess-audit-test', 'msg-test',
        config.model, prepared.url, prepared.body, persistConfig,
      );
      expect(prepared.body).toEqual(before);
    }
    expect(await flushPendingDebugLogWrites()).toBe(true);
    const files = readdirSync(temp);
    expect(files.length).toBe(1);
    const saved = JSON.parse(readFileSync(join(temp, files[0]!), 'utf8')) as Body;
    expect((saved.request_body as Body).messages).toEqual((before as Body).messages);
  });

  it('codex_transport_bridges_sse_and_maps_usage_limit_404', async () => {
    const sse = sseResponse(
      'data: {"type":"response.output_text.delta","delta":"fixture"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_fixture",'
        + '"status":"completed","output":[],"usage":{"total_tokens":7}}}\n\n',
    );
    const bridged = await bridgeCodexNonstreamResponse(sse);
    expect(bridged.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const bridgedJson = await bridged.json() as Body;
    expect(bridgedJson.id).toBe('resp_fixture');
    expect(((bridgedJson.output as Body[])[0]!.content as Body[])[0]!.text).toBe('fixture');
    expect((bridgedJson.usage as Body).total_tokens).toBe(7);

    const limited = await normalizeCodexErrorResponse(jsonResponse(
      404, '{"error":{"code":"usage_limit_reached","message":"quota exhausted"}}',
    ));
    expect(limited.status).toBe(429);
    const limitedBody = await limited.text();
    expect(limitedBody).toContain('usage_limit_reached');
    expect(limitedBody.includes('quota exhausted')).toBe(false);

    const missing = await normalizeCodexErrorResponse(
      jsonResponse(404, '{"error":{"code":"not_found"}}'),
    );
    expect(missing.status).toBe(404);

    const oversized = new Response('123456789', { status: 400 });
    await expect(readCodexResponseBodyLimited(oversized, 8, '测试响应')).rejects.toThrow();
  });

  it('stream_with_noop_sink_completes_without_window', async () => {
    let calls = 0;
    const streamBody = [
      'data: {"id":"chatcmpl-noop","object":"chat.completion.chunk","created":1,'
        + '"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant",'
        + '"content":"你好"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-noop","object":"chat.completion.chunk","created":1,'
        + '"model":"test-model","choices":[{"index":0,"delta":{"content":"世界"},'
        + '"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-noop","object":"chat.completion.chunk","created":1,'
        + '"model":"test-model","choices":[{"index":0,"delta":{},'
        + '"finish_reason":"stop"}],"usage":{"prompt_tokens":3,'
        + '"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ];
    const send = async (): Promise<SingleShotResponse> => {
      calls += 1;
      const response: SingleShotResponse = {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        adapter: new OpenAIAdapter(),
        isCodex: false,
        body: (async function* generate(): AsyncGenerator<Uint8Array> {
          for (const chunk of streamBody) yield Buffer.from(chunk, 'utf8');
        })(),
      };
      return response;
    };
    const config = makeConfig({
      model: 'test-model', baseUrl: 'https://noop.example/v1', supportsTools: true,
    });
    const completion = await runStreamingCompletion(
      defaultSingleShotOptions('stream noop'),
      config,
      send,
      {
        streamEvent: 'chat_v2_event_noop_sink_test',
        requestId: 'req-noop',
        sink: new NoopStreamSink(),
      },
    );
    expect(completion.content).toBe('你好世界');
    expect(completion.aborted).toBe(false);
    expect(calls).toBe(1);
  });

  it('build_tools_with_mcp_without_window_skips_mcp', () => {
    const tools = buildToolsWithMcp({ window: null });
    expect(tools).toEqual([]);
  });
});
