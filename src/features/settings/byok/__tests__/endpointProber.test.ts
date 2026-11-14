import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectByokProvider } from '../keyDetector';
import { ByokProbeError, probeByokEndpoint } from '../endpointProber';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('endpointProber', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it.each([
    ['https://api.deepseek.com/v1/', 'https://api.deepseek.com/v1/models'],
    ['https://proxy.example/v1/embeddings/', 'https://proxy.example/v1/models'],
    ['https://generativelanguage.googleapis.com/v1beta/', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100'],
    ['https://generativelanguage.googleapis.com/v1/', 'https://generativelanguage.googleapis.com/v1/models?pageSize=100'],
  ])('normalizes %s without duplicating endpoint/version segments', async (customBaseUrl, expectedUrl) => {
    const fetcher = vi.fn(async () => jsonResponse(customBaseUrl.includes('googleapis')
      ? { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }
      : { data: [{ id: 'deepseek-chat' }] }));
    await probeByokEndpoint(detectByokProvider({ rawApiKey: 'fixture-key', customBaseUrl }), { fetcher });
    expect(fetcher.mock.calls[0]?.[0]).toBe(expectedUrl);
  });

  it('does not propagate credential-bearing transport errors', async () => {
    const key = 'sk-proj-fixture1234567890abcdef';
    const fetcher = vi.fn(async () => { throw new Error(`Authorization: Bearer ${key}`); });
    await expect(probeByokEndpoint(detectByokProvider({ rawApiKey: key }), { fetcher })).rejects.toMatchObject({ code: 'probe_failed', message: 'Endpoint request failed' });
  });

  it('clears timeout timers and parent abort listeners after an aborted request', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const removeListener = vi.spyOn(parent.signal, 'removeEventListener');
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const probe = probeByokEndpoint(detectByokProvider({ rawApiKey: 'sk-proj-fixture1234567890abcdef' }), { fetcher, signal: parent.signal });
    const assertion = expect(probe).rejects.toMatchObject({ code: 'network_timeout' });
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('discovers OpenAI-compatible models, ranks embedding candidates, and probes exact vector dimensions (1024 / 1536 / 3072)', async () => {
    for (const expectedDim of [1024, 1536, 3072]) {
      const calls: Array<{ url: string; method: string; body?: unknown }> = [];
      const mockFetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        const parsedBody = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method, body: parsedBody });

        if (url === 'https://api.openai.com/v1/models' && method === 'GET') {
          return jsonResponse({
            data: [
              { id: 'gpt-4o', context_length: 128000 },
              { id: 'gpt-4o-mini', context_length: 128000 },
              { id: 'whisper-1' },
              { id: 'dall-e-3' },
              { id: 'BAAI/bge-reranker-v2-m3' },
              { id: 'text-embedding-3-large' },
              { id: 'text-embedding-3-small' },
            ],
          });
        }

        if (url === 'https://api.openai.com/v1/embeddings' && method === 'POST') {
          return jsonResponse({
            data: [{ embedding: Array.from({ length: expectedDim }, () => 0.01) }],
          });
        }

        return jsonResponse({ error: 'Not found' }, 404);
      }) as unknown as typeof fetch;

      const detection = detectByokProvider({
        rawApiKey: 'sk-proj-testkey1234567890abcdefghijklmnop',
      });
      const result = await probeByokEndpoint(detection, { fetcher: mockFetcher });

      expect(result.chatModels.map((m) => m.id)).toEqual(['gpt-4o', 'gpt-4o-mini']);
      expect(result.rerankCandidates.map((m) => m.id)).toEqual(['BAAI/bge-reranker-v2-m3']);
      expect(result.embeddingCandidates[0]?.id).toBe('text-embedding-3-small');
      expect(result.embeddingResult).toEqual({
        embeddingModelId: 'text-embedding-3-small',
        dimension: expectedDim,
      });

      const embedCall = calls.find((c) => c.method === 'POST');
      expect(embedCall?.body).toEqual({
        model: 'text-embedding-3-small',
        input: 'ping',
        encoding_format: 'float',
      });
    }
  });

  it('retains both generateContent and embedContent models on Gemini and extracts 768 / 3072 vector dimensions', async () => {
    for (const expectedDim of [768, 3072]) {
      const mockFetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['x-goog-api-key']).toBe('AIzaSyD1234567890abcdefABCDEF1234567890');

        if (url.includes('/v1beta/models?pageSize=100')) {
          return jsonResponse({
            models: [
              {
                name: 'models/gemini-2.5-pro',
                displayName: 'Gemini 2.5 Pro',
                supportedGenerationMethods: ['generateContent'],
                inputTokenLimit: 1048576,
              },
              {
                name: 'models/gemini-2.5-flash',
                displayName: 'Gemini 2.5 Flash',
                supportedGenerationMethods: ['generateContent'],
                inputTokenLimit: 1048576,
              },
              {
                name: 'models/gemini-embedding-001',
                displayName: 'Gemini Embedding 001',
                supportedGenerationMethods: ['embedContent'],
              },
            ],
          });
        }

        if (url.includes('/v1beta/models/gemini-embedding-001:embedContent')) {
          return jsonResponse({
            embedding: {
              values: Array.from({ length: expectedDim }, () => 0.02),
            },
          });
        }

        return jsonResponse({}, 404);
      }) as unknown as typeof fetch;

      const detection = detectByokProvider({
        rawApiKey: 'AIzaSyD1234567890abcdefABCDEF1234567890',
      });
      const result = await probeByokEndpoint(detection, { fetcher: mockFetcher });

      expect(result.chatModels.map((m) => m.id)).toEqual([
        'gemini-2.5-pro',
        'gemini-2.5-flash',
      ]);
      expect(result.embeddingCandidates.map((m) => m.id)).toEqual(['gemini-embedding-001']);
      expect(result.embeddingResult).toEqual({
        embeddingModelId: 'gemini-embedding-001',
        dimension: expectedDim,
      });
    }
  });

  it('degrades cleanly to chat-only for Anthropic and OpenAI-compatible 404 /embeddings without throwing', async () => {
    const anthropicFetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.anthropic.com/v1/models?limit=100') {
        return jsonResponse({
          data: [
            { id: 'claude-sonnet-4-20250514', display_name: 'Claude Sonnet 4', type: 'model' },
            { id: 'claude-3-5-haiku-20241022', display_name: 'Claude 3.5 Haiku', type: 'model' },
          ],
        });
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const anthropicDetection = detectByokProvider({
      rawApiKey: 'sk-ant-api03-testkey1234567890abcdef',
    });
    const anthropicResult = await probeByokEndpoint(anthropicDetection, {
      fetcher: anthropicFetcher,
    });
    expect(anthropicResult.chatModels).toHaveLength(2);
    expect(anthropicResult.embeddingResult).toBeNull();
    expect(anthropicResult.chatOnlyReason).toBe('provider_chat_only');

    const gatewayFetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return jsonResponse({
          data: [
            { id: 'deepseek-chat', context_length: 64000 },
            { id: 'text-embedding-3-small' },
          ],
        });
      }
      if (url.endsWith('/embeddings') && init?.method === 'POST') {
        return jsonResponse({ error: 'Embeddings not supported on this proxy' }, 404);
      }
      return jsonResponse({}, 404);
    }) as unknown as typeof fetch;

    const gatewayDetection = detectByokProvider({
      rawApiKey: 'sk-proxy1234567890abcdefghijklmnopqrstuvwx',
      customBaseUrl: 'https://proxy.example.test/v1',
    });
    const gatewayResult = await probeByokEndpoint(gatewayDetection, {
      fetcher: gatewayFetcher,
    });
    expect(gatewayResult.chatModels.map((m) => m.id)).toEqual(['deepseek-chat']);
    expect(gatewayResult.embeddingResult).toBeNull();
    expect(gatewayResult.chatOnlyReason).toBe('no_embedding_endpoint');
  });

  it('races ambiguous sk-* candidates and picks the first 200 OK responder, or throws auth_failed on 401', async () => {
    const raceFetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.deepseek.com/v1/models') {
        return jsonResponse({
          data: [{ id: 'deepseek-chat', context_length: 128000 }],
        });
      }
      return jsonResponse({ error: 'Invalid API key' }, 401);
    }) as unknown as typeof fetch;

    const ambiguous = detectByokProvider({
      rawApiKey: 'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
    });
    const winner = await probeByokEndpoint(ambiguous, { fetcher: raceFetcher });
    expect(winner.resolvedPreset.id).toBe('deepseek');
    expect(winner.chatModels.map((m) => m.id)).toEqual(['deepseek-chat']);
    expect(winner.embeddingResult).toBeNull();

    const unauthorizedFetcher = vi.fn(async () =>
      jsonResponse({ error: 'Unauthorized' }, 401),
    ) as unknown as typeof fetch;

    await expect(
      probeByokEndpoint(ambiguous, { fetcher: unauthorizedFetcher }),
    ).rejects.toMatchObject({
      code: 'auth_failed',
      httpStatus: 401,
    } satisfies Partial<ByokProbeError>);
  });
});
