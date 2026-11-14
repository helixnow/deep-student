import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { ApiConfig, LLMManager } from '../../llm/api.ts';
import { llmReplayPlugin, type ReplayFrame, type ReplayScript } from '../../llm-providers/api.ts';
import translation from '../index.ts';
import type { TranslationLogger } from '../src/logging.ts';
import type { ChatTranslationRequest, TranslationRequest } from '../api.ts';

const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: 'openai-gpt4',
    name: 'OpenAI GPT',
    providerType: 'openai',
    providerScope: 'openai',
    apiProtocol: 'openai_chat_completions',
    supportsOpenaiResponses: false,
    apiKey: 'sk-test',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-5.4-mini',
    isMultimodal: true,
    isReasoning: false,
    isEmbedding: false,
    isReranker: false,
    isImageGeneration: false,
    enabled: true,
    modelAdapter: 'general',
    maxOutputTokens: 8192,
    temperature: 0.7,
    supportsTools: true,
    reasoningEffort: null,
    supportsReasoning: false,
    headers: null,
    maxTokensLimit: null,
    enableThinking: null,
    thinkingEnabled: false,
    verbosity: null,
    ...overrides,
  } as ApiConfig;
}

function fakeLlm(target: ApiConfig = config()): { llm: LLMManager; cancelled: string[]; target: ApiConfig } {
  const controllers = new Map<string, AbortController>();
  const pending = new Set<string>();
  const cancelled: string[] = [];
  const llm = {
    getTranslationModelConfig: async () => target,
    decryptApiKey: async (key: string) => key,
    subscribeCancelStream: async (name: string) => {
      const controller = new AbortController();
      controllers.set(name, controller);
      return controller.signal;
    },
    requestCancelStream: async (name: string) => {
      cancelled.push(name);
      controllers.get(name)?.abort();
      pending.add(name);
    },
    consumePendingCancel: async (name: string) => pending.delete(name),
    clearCancelStream: async (name: string) => { controllers.delete(name); },
    clearCancelArtifacts: async (name: string) => {
      controllers.delete(name);
      pending.delete(name);
    },
    cancelStreamsByPrefix: async (prefix: string) => {
      for (const name of controllers.keys()) if (name.startsWith(prefix)) await llm.requestCancelStream(name);
    },
  } as unknown as LLMManager;
  return { llm, cancelled, target };
}

function streamResponse(blocks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) controller.enqueue(encoder.encode(block));
      controller.close();
    },
  }), { status: 200, statusText: 'OK' });
}

function openaiChunk(content: string, finish: string | null = null): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finish }] })}\n\n`;
}

async function hostWith(llm: LLMManager, logger?: TranslationLogger) {
  const host = await createTestHost({ plugins: [translation], provide: { llm, llmCodexAuth: {},
    llmHttp: { fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => globalThis.fetch(input, init) },
    ...(logger ? { log: { logger: () => logger } } : {}),
  } });
  hosts.push(host);
  return host;
}

/** Mounts llm-replay with `script` and points the fake's model config at it; `llmHttp` fetches through the replay. */
async function replayHost(fake: ReturnType<typeof fakeLlm>, script: ReplayScript, logger?: TranslationLogger) {
  const host = await createTestHost({
    plugins: [translation, [llmReplayPlugin, { scripts: { translation: script } }]],
    provide: { llm: fake.llm, llmCodexAuth: {},
      llmHttp: { fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => host.ctx.llmReplay.fetch(input, init) },
      ...(logger ? { log: { logger: () => logger } } : {}),
    },
  });
  hosts.push(host);
  fake.target.baseUrl = host.ctx.llmReplay.baseUrl('translation');
  return host;
}

function sse(frames: ReplayFrame[], end: 'done' | 'eof' | 'hold' = 'done'): ReplayScript {
  return { description: 'translation stream', rounds: [{ kind: 'sse', frames, end }] };
}

function httpError(status: number, body: string): ReplayScript {
  return { description: `HTTP ${status}`, rounds: [{ kind: 'http-error', status, body }] };
}

/** One response with exactly these SSE bytes. */
function literal(...chunks: string[]): ReplayScript {
  return { description: 'raw SSE bytes', responses: [{ status: 200, headers: { 'content-type': 'text/event-stream' }, chunks }] };
}

const request: TranslationRequest = {
  text: 'Hello world',
  src_lang: 'en',
  tgt_lang: 'zh-CN',
  session_id: 's1',
};

describe('translation commands', () => {
  it('R1-TR-06: notification failure warns and does not replace successful translation', async () => {
    const warnings: string[] = [];
    const host = await replayHost(fakeLlm(), sse([{ content: 'translated' }]),
      { warn: message => warnings.push(message), info() {}, debug() {}, error() {} });
    vi.spyOn(host.ctx.backendEvents, 'emit').mockImplementation(() => { throw new Error('delivery unavailable'); });
    expect(await host.invoke('translate_text_stream', { request })).toMatchObject({ translated_text: 'translated' });
    expect(warnings).toContain('[Translation] event delivery failed: delivery unavailable');
    await expect(host.invoke('stream_chat_translation_plain', { request: { request_id: 'delivery', source: 'hello', src_lang: 'en', tgt_lang: 'zh' } })).resolves.toBeNull();
    expect(warnings).toContain('[ChatTranslation] 发送事件失败 (chat_translation_delivery): delivery unavailable');
    expect(await host.invoke('translate_text_candidates', { request, numCandidates: 1 })).toMatchObject({ cancelled: false });
    expect(warnings).toContain('[TranslationCandidates] 发送事件失败 (translation_candidates_s1): delivery unavailable');
  });
  it('V03-05: stream, chat and candidate events broadcast like Tauri 2 Window::emit (translation/events.rs:56-154)', async () => {
    const host = await replayHost(fakeLlm(), sse([{ content: 'translated' }]));
    await host.invoke('translate_text_stream', { request });
    await host.invoke('stream_chat_translation_plain', { request: { request_id: 'broadcast', source: 'hello', src_lang: 'en', tgt_lang: 'zh' } });
    await host.invoke('translate_text_candidates', { request, numCandidates: 1 });
    const prefixes = ['translation_stream_', 'chat_translation_', 'translation_candidates_'];
    const translationEvents = host.events.filter((event) => prefixes.some((prefix) => event.event.startsWith(prefix)));
    for (const prefix of prefixes) expect(translationEvents.some((event) => event.event.startsWith(prefix)), prefix).toBe(true);
    expect(translationEvents.filter((event) => event.target.kind !== 'Any')).toEqual([]);
  });
  it('R1-TR-01: DeepSeek length followed by EOF is incomplete, not a completed translation', async () => {
    const host = await replayHost(fakeLlm(config({ model: 'deepseek-flash', providerType: 'deepseek',
      modelAdapter: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })), literal(openaiChunk('partial', 'length')));
    await expect(host.invoke('translate_text_stream', { request })).rejects.toMatchObject({ error_type: 'LLM',
      message: '翻译流式响应异常中断，结果不完整。请检查网络连接后重试。' });
    const events = host.eventsNamed('translation_stream_s1') as Record<string, unknown>[];
    expect(events.filter(event => event.type === 'data').map(event => event.chunk)).toEqual(['partial']);
    expect(events.some(event => event.type === 'complete')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'stream_incomplete' });
    expect(host.ctx.llmReplay.requests).toHaveLength(1);
  });

  it('R1-TR-01: keeps the Rust raw-DONE shortcut after a DeepSeek length frame', async () => {
    const host = await replayHost(fakeLlm(config({ model: 'deepseek-flash', providerType: 'deepseek',
      modelAdapter: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' })), literal(openaiChunk('partial', 'length'), 'data: [DONE]\n\n'));
    expect(await host.invoke('translate_text_stream', { request })).toMatchObject({ translated_text: 'partial' });
  });

  it('R1-TR-01: Gemini thought parts never become translated text', async () => {
    vi.stubGlobal('fetch', async () => streamResponse([
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'private reasoning', thought: true }, { text: '译文' }] }, finishReason: 'STOP' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]));
    const host = await hostWith(fakeLlm(config({ model: 'gemini-2.5-flash', providerType: 'google', apiProtocol: 'google_generate_content' })).llm);
    expect(await host.invoke('translate_text_stream', { request })).toMatchObject({ translated_text: '译文' });
    expect(host.eventsNamed('translation_stream_s1')).not.toContainEqual(expect.objectContaining({ chunk: 'private reasoning' }));
  });

  it('R1-TR-02: a read failure after delivered text never resends or duplicates the prefix', async () => {
    let attempts = 0;
    vi.stubGlobal('fetch', async () => {
      attempts++;
      let read = false;
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
        if (!read) { read = true; controller.enqueue(new TextEncoder().encode(openaiChunk('prefix'))); }
        else controller.error(new Error('transport broke after delta'));
      } }));
    });
    const host = await hostWith(fakeLlm().llm);
    await expect(host.invoke('translate_text_stream', { request })).rejects.toMatchObject({ error_type: 'LLM', message: '读取流失败: transport broke after delta' });
    const events = host.eventsNamed('translation_stream_s1') as Record<string, unknown>[];
    expect(attempts).toBe(1);
    expect(events.filter(event => event.type === 'data').map(event => event.chunk)).toEqual(['prefix']);
    expect(events.some(event => event.type === 'complete')).toBe(false);
  });

  it('R1-TR-02: cancellation during establishment backoff settles without advancing the retry timer', async () => {
    const llm = fakeLlm();
    const host = await replayHost(llm, httpError(503, 'busy'));
    vi.useFakeTimers();
    try {
      const pending = host.startInvoke('translate_text_stream', { request });
      await vi.advanceTimersByTimeAsync(1);
      expect(host.ctx.llmReplay.requests).toHaveLength(1);
      await llm.llm.requestCancelStream('translation_stream_s1');
      expect(await pending.result).toBeNull();
      expect(host.ctx.llmReplay.requests).toHaveLength(1);
      expect(host.eventsNamed('translation_stream_s1')).toContainEqual({ type: 'cancelled' });
    } finally { vi.useRealTimers(); }
  });

  it('R1-TR-01: shared provider error followed by Done still rejects without retrying partial output', async () => {
    const host = await replayHost(fakeLlm(),
      literal(openaiChunk('prefix'), 'data: {"error":{"message":"quota"}}\n\n', 'data: [DONE]\n\n'));
    await expect(host.invoke('translate_text_stream', { request })).rejects.toMatchObject({
      error_type: 'LLM', message: '翻译服务返回错误：quota',
    });
    expect(host.ctx.llmReplay.requests).toHaveLength(1);
    const events = host.eventsNamed('translation_stream_s1') as Record<string, unknown>[];
    expect(events.filter(event => event.type === 'data').map(event => event.chunk)).toEqual(['prefix']);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'provider_error', retriable: false });
  });
  it('translate_text_stream emits data/complete and returns the Rust response shape', async () => {
    const host = await replayHost(fakeLlm(), sse([{ content: '你好' }, { content: '，世界' }, { finish: 'stop' }]));
    const result = await host.invoke<Record<string, unknown>>('translate_text_stream', { request });
    expect(result.translated_text).toBe('你好，世界');
    expect(result.session_id).toBe('s1');
    expect(result.id).toBe('s1');
    expect(typeof result.created_at).toBe('string');
    expect(String(result.created_at)).toMatch(/\+00:00$/);

    const events = host.eventsNamed('translation_stream_s1') as Record<string, unknown>[];
    expect(events.filter((event) => event.type === 'data').map((event) => event.chunk))
      .toEqual(['你好', '，世界']);
    expect(events.at(-1)).toMatchObject({
      type: 'complete', id: 's1', translated_text: '你好，世界',
    });
  });

  it('translate_text_stream emits an error event then rejects with AppError', async () => {
    const host = await replayHost(fakeLlm(), httpError(401, 'nope'));
    await expect(host.invoke('translate_text_stream', { request })).rejects.toMatchObject({
      error_type: 'LLM', message: 'API 密钥无效或已过期，请检查设置',
    });
    expect(host.eventsNamed('translation_stream_s1')).toContainEqual({
      type: 'error', message: 'API 密钥无效或已过期，请检查设置', code: 'http_401', retriable: false,
    });
  });

  it('translate_text_candidates runs every profile concurrently and reports candidate events', async () => {
    const host = await replayHost(fakeLlm(), {
      description: 'candidate text chosen by the request temperature',
      derive: (body) => {
        const temperature = (body as { temperature: number }).temperature;
        const text = temperature === 0.2 ? '准确' : temperature === 0.7 ? '自然' : '简洁';
        return { ok: true, index: 0, round: { kind: 'sse', frames: [{ content: text }, { finish: 'stop' }], end: 'done' } };
      },
    });
    const result = await host.invoke<Record<string, unknown>>('translate_text_candidates', {
      request: { ...request, text: 'Hello world '.repeat(20) }, numCandidates: 3,
    });
    const temperatures = host.ctx.llmReplay.requests.map(entry => (entry.body as { temperature: number }).temperature);
    expect(temperatures.sort()).toEqual([0.2, 0.5, 0.7]);
    expect(result.cancelled).toBe(false);
    const candidates = result.candidates as { index: number; label: string; text: string; error: string | null }[];
    expect(candidates.map((candidate) => candidate.label)).toEqual(['precise', 'natural', 'concise']);
    expect(candidates.map((candidate) => candidate.text)).toEqual(['准确', '自然', '简洁']);
    const events = host.eventsNamed('translation_candidates_s1') as Record<string, unknown>[];
    expect(events.filter((event) => event.type === 'candidate_complete')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: 'complete', detected_lang: null });
  });

  it('translate_text_candidates rejects blank or oversized input with Rust validation strings', async () => {
    const host = await hostWith(fakeLlm().llm);
    await expect(host.invoke('translate_text_candidates', {
      request: { ...request, session_id: '  ' },
    })).rejects.toMatchObject({ error_type: 'Validation', message: 'session_id 不能为空' });
    await expect(host.invoke('translate_text_candidates', {
      request: { ...request, text: '   ' },
    })).rejects.toMatchObject({ error_type: 'Validation', message: '翻译文本不能为空' });
    await expect(host.invoke('translate_text_candidates', {
      request: { ...request, text: 'x'.repeat(8001) },
    })).rejects.toMatchObject({
      error_type: 'Validation', message: '多候选翻译文本过长（8001 字符，最大 8000）',
    });
  });

  it('cancel_translation_candidates broadcasts to all three candidate stream events', async () => {
    const fake = fakeLlm();
    const host = await hostWith(fake.llm);
    await expect(host.invoke('cancel_translation_candidates', { sessionId: 's9' })).resolves.toBe(true);
    expect(fake.cancelled).toEqual([
      'translation_candidates_s9__c0',
      'translation_candidates_s9__c1',
      'translation_candidates_s9__c2',
    ]);
  });

  it('translate_text_stream stops on cancel_stream and emits cancelled', async () => {
    const fake = fakeLlm();
    const host = await replayHost(fake, sse([{ content: '部分' }], 'hold'));
    const pending = host.startInvoke('translate_text_stream', { request });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fake.llm.requestCancelStream('translation_stream_s1');
    await expect(pending.result).resolves.toBeNull();
    expect(host.eventsNamed('translation_stream_s1')).toEqual([
      expect.objectContaining({ type: 'data', chunk: '部分' }),
      { type: 'cancelled' },
    ]);
    expect(host.ctx.llmReplay.requests.map(entry => entry.end)).toEqual(['client-closed']);
  });

  it('stream_chat_translation_plain streams deltas and completes', async () => {
    const host = await replayHost(fakeLlm(), sse([{ content: '你好' }, { finish: 'stop' }]));
    const chat: ChatTranslationRequest = {
      request_id: 'r1', source: 'Hello', src_lang: 'en', tgt_lang: 'zh-CN',
      context_before: 'before', context_after: null,
    };
    await expect(host.invoke('stream_chat_translation_plain', { request: chat })).resolves.toBeNull();
    expect(host.eventsNamed('chat_translation_r1')).toEqual([
      { type: 'chunk', delta: '你好' },
      { type: 'complete' },
    ]);
  });

  it('stream_chat_translation_aligned reports an empty stream as an error', async () => {
    const host = await replayHost(fakeLlm(), sse([]));
    const chat: ChatTranslationRequest = {
      request_id: 'r2', source: 'Hello', src_lang: 'en', tgt_lang: 'zh-CN',
    };
    await expect(host.invoke('stream_chat_translation_aligned', { request: chat }))
      .rejects.toMatchObject({ error_type: 'LLM', message: '翻译服务返回空结果，请重试。' });
    expect(host.eventsNamed('chat_translation_r2')).toEqual([
      { type: 'error', message: '翻译服务返回空结果，请重试。' },
    ]);
  });

  it('chat popover validates request ids and source bounds', async () => {
    const host = await hostWith(fakeLlm().llm);
    const base: ChatTranslationRequest = {
      request_id: 'r3', source: 'Hello', src_lang: 'en', tgt_lang: 'zh-CN',
    };
    await expect(host.invoke('stream_chat_translation_plain', {
      request: { ...base, request_id: ' ' },
    })).rejects.toMatchObject({ error_type: 'Validation', message: 'request_id 不能为空' });
    await expect(host.invoke('stream_chat_translation_plain', {
      request: { ...base, source: ' ' },
    })).rejects.toMatchObject({ error_type: 'Validation', message: '待翻译文本为空' });
    await expect(host.invoke('stream_chat_translation_plain', {
      request: { ...base, source: 'x'.repeat(8001) },
    })).rejects.toMatchObject({
      error_type: 'Validation', message: '聊天翻译文本过长（8001 字符，最大 8000）',
    });
  });
});
