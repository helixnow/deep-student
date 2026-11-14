import { describe, expect, it, vi } from 'vitest';
import {
  buildChatProbeBody, buildProbeRequest, classifyProbeHttpFailure, inspectProbeBuffer,
  judgeSsePayload, resolveTestModelKind, runAsrProbe, runCatalogProbe, runChatProbe,
  runJsonProbe, testApiConnection,
} from '../src/connection_test.ts';
import type { LlmConfigStore } from '../src/config_store.ts';
import type { ApiConfig } from '../api.ts';
import { makeConfig } from './support.ts';

const encoder = new TextEncoder();

function streamResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status });
}

describe('commands.rs connection probe', () => {
  it('classify_probe_http_failure_maps_status_codes', () => {
    expect(classifyProbeHttpFailure(401, '{"error":"invalid key"}').category).toBe('auth');
    expect(classifyProbeHttpFailure(401, '').message).toContain('401');
    expect(classifyProbeHttpFailure(429, '').category).toBe('rate_limit');
    expect(classifyProbeHttpFailure(404, '').category).toBe('model_not_found');
    expect(classifyProbeHttpFailure(402, '').category).toBe('billing');
    expect(classifyProbeHttpFailure(400, '').category).toBe('bad_request');
    expect(classifyProbeHttpFailure(500, '').category).toBe('server');
  });

  it('classify_probe_http_failure_redacts_credentials_in_body', () => {
    const { message } = classifyProbeHttpFailure(
      401, '{"error":"invalid api key sk-abcdefghijklmnopqrstuvwx"}',
    );
    expect(message).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(message).toContain('[REDACTED]');
  });

  it('chat_probe_body_routes_gpt5_official_to_responses_dialect', () => {
    const config = makeConfig({
      model: 'gpt-5.5', providerType: 'openai', apiProtocol: 'openai_responses',
      supportsOpenaiResponses: true, baseUrl: 'https://api.openai.com/v1',
      isReasoning: true, supportsReasoning: true,
    });
    const body = buildChatProbeBody(config);
    const request = buildProbeRequest(config, body);
    expect(request.url.endsWith('/responses')).toBe(true);
    expect((request.body as { max_output_tokens?: number }).max_output_tokens).toBe(32);
    expect((request.body as { max_tokens?: number }).max_tokens).toBeUndefined();
    expect((request.body as { stream?: boolean }).stream).toBe(true);
  });

  it('judge_sse_payload_accepts_done_and_valid_events', () => {
    expect(judgeSsePayload('[DONE]')).toEqual({ kind: 'success' });
    expect(judgeSsePayload('{"choices":[{"delta":{"content":"Hi"}}]}')).toEqual({ kind: 'success' });
    expect(judgeSsePayload('keep-alive')).toBeNull();
  });

  it('inspect_probe_buffer_detects_error_html_and_partial_streams', () => {
    const error = inspectProbeBuffer(
      encoder.encode('data: {"error":{"message":"bad key"}}\n\n'), false,
    );
    expect(error.kind).toBe('failure');
    if (error.kind === 'failure') expect(error.message).toContain('供应商返回错误');

    const html = inspectProbeBuffer(encoder.encode('<html>gateway</html>'), false);
    expect(html.kind).toBe('failure');

    const partial = inspectProbeBuffer(encoder.encode('data: {"choices":'), false);
    expect(partial.kind).toBe('pending');

    const empty = inspectProbeBuffer(new Uint8Array(), true);
    expect(empty.kind).toBe('failure');
  });

  it('run_chat_probe_succeeds_on_first_data_event', async () => {
    const fetchImpl = vi.fn(async () => streamResponse([
      'event: message\ndata: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    ])) as unknown as typeof fetch;
    await expect(runChatProbe(
      { fetch: fetchImpl }, 'https://example.com/chat', [['Authorization', 'Bearer x']],
      { model: 'm' }, 1000,
    )).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('run_chat_probe_surfaces_auth_failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('invalid key', { status: 401 })) as unknown as typeof fetch;
    await expect(runChatProbe(
      { fetch: fetchImpl }, 'https://example.com/chat', [], {}, 1000,
    )).rejects.toMatchObject({ probeCategory: 'auth' });
  });

  it('run_chat_probe_times_out_when_provider_stalls', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    await expect(runChatProbe(
      { fetch: fetchImpl }, 'https://example.com/chat', [], {}, 20,
    )).rejects.toMatchObject({ probeCategory: 'timeout' });
  });

  it('run_json_probe_accepts_embedding_shape_and_reports_errors', async () => {
    const okFetch = vi.fn(async () => new Response('{"data":[{"embedding":[0.1]}]}', { status: 200 })) as unknown as typeof fetch;
    await expect(runJsonProbe(
      { fetch: okFetch }, 'https://example.com/v1/embeddings', 'k', null,
      { model: 'bge', input: ['x'] }, 1000,
    )).resolves.toBeUndefined();

    const errorFetch = vi.fn(async () => new Response('{"error":{"message":"nope"}}', { status: 200 })) as unknown as typeof fetch;
    await expect(runJsonProbe(
      { fetch: errorFetch }, 'https://example.com/v1/embeddings', 'k', null, {}, 1000,
    )).rejects.toMatchObject({ probeCategory: 'provider_error' });

    const badFetch = vi.fn(async () => new Response('not-json', { status: 200 })) as unknown as typeof fetch;
    await expect(runJsonProbe(
      { fetch: badFetch }, 'https://example.com/v1/rerank', '', null, {}, 1000,
    )).rejects.toMatchObject({ probeCategory: 'format' });
  });

  it('run_asr_probe_posts_multipart_audio', async () => {
    let observed: FormData | null = null;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      observed = init?.body as FormData;
      return new Response('{"text":"hi"}', { status: 200 });
    }) as unknown as typeof fetch;
    const warning = await runAsrProbe(
      { fetch: fetchImpl }, makeConfig({ baseUrl: 'https://example.com/v1', model: 'whisper-1' }), 1000,
    );
    expect(warning).toBeNull();
    expect(observed).toBeInstanceOf(FormData);
    expect((observed as unknown as FormData).get('model')).toBe('whisper-1');
    expect((observed as unknown as FormData).get('file')).toBeInstanceOf(Blob);
  });

  it('run_catalog_probe_warns_when_model_is_not_listed', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '{"data":[{"id":"other-model"}]}', { status: 200 },
    )) as unknown as typeof fetch;
    const warning = await runCatalogProbe(
      { fetch: fetchImpl },
      makeConfig({ baseUrl: 'https://api.example.com/v1', model: 'my-image-model' }), 1000,
    );
    expect(warning).toContain('未找到');

    const emptyFetch = vi.fn(async () => new Response('{"data":[]}', { status: 200 })) as unknown as typeof fetch;
    const emptyWarning = await runCatalogProbe(
      { fetch: emptyFetch },
      makeConfig({ baseUrl: 'https://api.example.com/v1', model: 'my-image-model' }), 1000,
    );
    expect(emptyWarning).toContain('清单为空');
  });

  it('resolve_test_model_kind_prefers_capabilities_then_name_heuristics', () => {
    expect(resolveTestModelKind(makeConfig({ isEmbedding: true, model: 'x' }))).toBe('embedding');
    expect(resolveTestModelKind(makeConfig({ isReranker: true, model: 'x' }))).toBe('reranker');
    expect(resolveTestModelKind(makeConfig({ isImageGeneration: true, model: 'x' }))).toBe('image_generation');
    expect(resolveTestModelKind(makeConfig({ model: 'bge-m3' }))).toBe('embedding');
    expect(resolveTestModelKind(makeConfig({ model: 'qwen3-rerank' }))).toBe('reranker');
    expect(resolveTestModelKind(makeConfig({ model: 'whisper-large-v3' }))).toBe('asr');
    expect(resolveTestModelKind(makeConfig({ model: 'gpt-4o-mini' }))).toBe('chat');
  });

  it('test_api_connection_rejects_cross_origin_saved_vendor', async () => {
    const store = {
      vendorConfigForRuntime: async () => ({
        id: 'v1', name: 'v', providerType: 'openai', authMode: null,
        baseUrl: 'https://api.openai.com/v1',
      }),
    } as unknown as LlmConfigStore;
    await expect(testApiConnection(
      { apiKey: 'k', apiBase: 'https://evil.example/v1', vendorId: 'v1' },
      { store, fetch: vi.fn() as unknown as typeof fetch, now: () => 0, getSecret: async () => null },
    )).rejects.toMatchObject({ error_type: 'Validation' });
  });

  it('test_api_connection_reports_chat_probe_success_as_camel_case', async () => {
    const config: ApiConfig = makeConfig({
      model: 'gpt-4o-mini', providerType: 'custom', baseUrl: 'https://example.com/v1',
    });
    const store = {
      vendorConfigForRuntime: async () => null,
      runtimeConfigForVendorModel: async () => config,
    } as unknown as LlmConfigStore;
    const fetchImpl = vi.fn(async () => streamResponse([
      'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    ])) as unknown as typeof fetch;
    const outcome = await testApiConnection(
      { apiKey: 'sk-test', apiBase: 'https://example.com/v1', vendorId: 'v1', model: 'gpt-4o-mini' },
      { store, fetch: fetchImpl, now: () => 0, getSecret: async () => null },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.latencyMs).toBe(0);
    expect(outcome.category).toBeUndefined();
  });
});
