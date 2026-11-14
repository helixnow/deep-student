import { expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createTestHost } from '../../../kernel/testing.ts';
import type { ApiConfig } from '../../llm/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { AsrConfigError, AsrEndpoint } from '../src/asr.ts';
import {
  resolveRequestEndpoint, resolveSiliconflowKey, transcribeVoiceInput, transcribeWithEndpoint,
  type AsrFetch, type VoiceInputTranscribeRequest, type VoiceInputUsage, VoiceInputError,
} from '../src/voice-input.ts';

const SAMPLE_AUDIO = Buffer.from('fake-audio', 'utf8').toString('base64');
const fetchAsr: AsrFetch = (input, init) => fetch(input, init);
const testPaths = { appDataDir: process.cwd() };

function sampleRequest(): VoiceInputTranscribeRequest {
  return {
    audioBase64: SAMPLE_AUDIO,
    mimeType: 'audio/webm',
    providerId: 'siliconflow',
    model: 'Qwen/Qwen3-ASR-1.7B',
    configId: 'voice-asr',
    language: 'zh',
    prompt: 'medical dictation',
    durationMs: 1500,
  };
}

function endpoint(baseUrl: string, model: string): AsrEndpoint {
  return new AsrEndpoint('siliconflow', 'SiliconFlow', baseUrl, 'sk-test', model, 'voice-asr');
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface TestServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

async function startServer(
  respond: (request: RecordedRequest, response: ServerResponse) => void,
): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const recorded: RecordedRequest = {
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
    requests.push(recorded);
    respond(recorded, response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)));
    }),
  };
}

function json(body: unknown, status = 200): (request: RecordedRequest, response: ServerResponse) => void {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
}

function capture(run: () => Promise<unknown>): Promise<VoiceInputError> {
  return run().then(
    () => { throw new Error('expected a transcription error'); },
    (error: VoiceInputError) => error,
  );
}

it('transcribe_with_transcriptions_endpoint_posts_multipart_form', async () => {
  const server = await startServer(json({ text: '你好，世界', language: 'zh' }));
  try {
    const result = await transcribeWithEndpoint(
      endpoint(`${server.url}/v1`, 'Qwen/Qwen3-ASR-1.7B'), sampleRequest(), fetchAsr);
    expect(result.text).toBe('你好，世界');
    expect(result.language).toBe('zh');
    expect(result.providerId).toBe('siliconflow');
    expect(result.model).toBe('Qwen/Qwen3-ASR-1.7B');

    const request = server.requests[0]!;
    expect(request.url).toBe('/v1/audio/transcriptions');
    expect(request.headers.authorization).toBe('Bearer sk-test');
    expect(request.body).toContain('name="model"');
    expect(request.body).toContain('Qwen/Qwen3-ASR-1.7B');
    expect(request.body).toContain('name="language"');
    expect(request.body).toContain('medical dictation');
    expect(request.body).toContain('name="file"');
  } finally { await server.close(); }
});

it('transcribe_with_qwen_flash_posts_input_audio_chat_request', async () => {
  const server = await startServer(json({ choices: [{ message: { role: 'assistant', content: '转写结果' } }] }));
  try {
    const result = await transcribeWithEndpoint(
      endpoint(`${server.url}/compatible-mode/v1`, 'qwen3-asr-flash'), sampleRequest(), fetchAsr);
    expect(result.text).toBe('转写结果');
    expect(result.model).toBe('qwen3-asr-flash');

    const request = server.requests[0]!;
    expect(request.url).toBe('/compatible-mode/v1/chat/completions');
    expect(request.headers.authorization).toBe('Bearer sk-test');
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body.model).toBe('qwen3-asr-flash');
    expect(body.stream).toBe(false);
    expect(body.asr_options).toEqual({ language: 'zh' });
    expect(request.body).toMatch(/"type":"input_audio".*"data":"data:audio\/webm;base64,/);
  } finally { await server.close(); }
});

it('transcribe_maps_401_to_auth_failed', async () => {
  const server = await startServer(json({ error: 'unauthorized' }, 401));
  try {
    const error = await capture(() => transcribeWithEndpoint(
      endpoint(`${server.url}/v1`, 'Qwen/Qwen3-ASR-1.7B'), sampleRequest(), fetchAsr));
    expect(error.message).toContain('"code":"auth-failed"');
    expect(error.message).toContain('SiliconFlow API key');
  } finally { await server.close(); }
});

it('transcribe_maps_429_to_rate_limited', async () => {
  const server = await startServer(json({ error: 'too many requests' }, 429));
  try {
    const error = await capture(() => transcribeWithEndpoint(
      endpoint(`${server.url}/v1`, 'Qwen/Qwen3-ASR-1.7B'), sampleRequest(), fetchAsr));
    expect(error.message).toContain('"code":"rate-limited"');
  } finally { await server.close(); }
});

it('transcribe_maps_5xx_to_transcription_failed', async () => {
  const server = await startServer(json({ error: 'unavailable' }, 503));
  try {
    const error = await capture(() => transcribeWithEndpoint(
      endpoint(`${server.url}/v1`, 'Qwen/Qwen3-ASR-1.7B'), sampleRequest(), fetchAsr));
    expect(error.message).toContain('"code":"transcription-failed"');
  } finally { await server.close(); }
});

it('transcribe_rejects_empty_transcripts', async () => {
  const server = await startServer(json({ text: '   ' }));
  try {
    const error = await capture(() => transcribeWithEndpoint(
      endpoint(`${server.url}/v1`, 'Qwen/Qwen3-ASR-1.7B'), sampleRequest(), fetchAsr));
    expect(error.message).toContain('"code":"empty-transcript"');
  } finally { await server.close(); }
});

it('transcribe_maps_transport_failures_to_network_codes', async () => {
  const error = await capture(() => transcribeWithEndpoint(
    endpoint('http://[::1', 'Qwen/Qwen3-ASR-1.7B'), sampleRequest(), fetchAsr));
  expect(error.errorType).toBe('Network');
  const payload = JSON.parse(error.message) as Record<string, unknown>;
  expect(['network-failed', 'timeout']).toContain(payload.code);
});

function apiConfig(id: string, baseUrl: string, overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id,
    name: id,
    vendorId: null,
    vendorName: 'Relay',
    providerType: 'custom',
    providerScope: null,
    authMode: null,
    apiProtocol: null,
    supportsOpenaiResponses: null,
    apiKey: 'sk-config',
    baseUrl,
    model: 'Qwen/Qwen3-ASR-1.7B',
    isMultimodal: false,
    isReasoning: false,
    isEmbedding: false,
    isReranker: false,
    isImageGeneration: false,
    enabled: true,
    modelAdapter: '',
    maxOutputTokens: 0,
    temperature: 0,
    supportsTools: false,
    geminiApiVersion: '',
    isBuiltin: false,
    isReadOnly: false,
    reasoningEffort: null,
    reasoningMode: null,
    thinkingEnabled: false,
    thinkingBudget: null,
    includeThoughts: false,
    minP: null,
    topK: null,
    enableThinking: null,
    supportsReasoning: false,
    headers: null,
    topPOverride: null,
    frequencyPenaltyOverride: null,
    presencePenaltyOverride: null,
    repetitionPenalty: null,
    reasoningSplit: null,
    effort: null,
    verbosity: null,
    isFavorite: false,
    maxTokensLimit: null,
    contextWindow: null,
    extraBody: null,
    resolvedAdapterId: null,
    ...overrides,
  };
}

function fakeLlm(configs: ApiConfig[], assigned: string | null) {
  return {
    getApiConfigs: async () => configs,
    getModelAssignments: async () => ({
      model2_config_id: null,
      review_analysis_model_config_id: null,
      anki_card_model_config_id: null,
      qbank_ai_grading_model_config_id: null,
      qbank_ai_generation_model_config_id: null,
      embedding_model_config_id: null,
      reranker_model_config_id: null,
      chat_title_model_config_id: null,
      exam_sheet_ocr_model_config_id: null,
      translation_model_config_id: null,
      vl_embedding_model_config_id: null,
      vl_reranker_model_config_id: null,
      memory_decision_model_config_id: null,
      voice_input_asr_model_config_id: assigned,
      image_generation_model_config_id: null,
      compaction_model_config_id: null,
      translation_display_mode: null,
    }),
  };
}

function settings(values: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(values));
  return {
    values: store,
    service: {
      get: (key: string) => store.get(key) ?? null,
      save: (key: string, value: string) => { store.set(key, value); },
      getSecret: async (key: string) => store.get(key) ?? null,
    },
  };
}

it('resolveSiliconflowKey prefers builtin key and ignores failures', async () => {
  expect(await resolveSiliconflowKey({
    getSecret: async key => (key === 'siliconflow.api_key' ? ' sk-user ' : null),
  })).toBe(' sk-user ');
  expect(await resolveSiliconflowKey({
    getSecret: async key => (key === 'builtin-siliconflow.api_key' ? 'sk-builtin' : 'sk-user'),
  })).toBe('sk-builtin');
  expect(await resolveSiliconflowKey({
    getSecret: async key => (key === 'siliconflow.api_key' ? '   ' : null),
  })).toBeNull();
  expect(await resolveSiliconflowKey({
    getSecret: async () => { throw new Error('keychain'); },
  })).toBeNull();
});

it('resolveRequestEndpoint honours configId, assignments and siliconflow fallback', async () => {
  const config = apiConfig('voice-asr', 'https://relay.example.test/v1');
  const byId = await resolveRequestEndpoint(sampleRequest(), fakeLlm([config], null), null);
  expect(byId.providerName).toBe('Relay');
  expect(byId.apiKey).toBe('sk-config');
  expect(byId.model).toBe('Qwen/Qwen3-ASR-1.7B');
  expect(byId.headers).toEqual([]);

  const assigned = await resolveRequestEndpoint(
    { ...sampleRequest(), configId: null, providerId: null, model: null },
    fakeLlm([config], 'voice-asr'), null);
  expect(assigned.configId).toBe('voice-asr');

  // assignment 指向停用/空模型配置时回退默认端点。
  const fallback = await resolveRequestEndpoint(
    { ...sampleRequest(), configId: null, providerId: null, model: null },
    fakeLlm([apiConfig('voice-asr', 'https://x', { enabled: false })], 'voice-asr'), 'sk-fallback');
  expect(fallback.providerId).toBe('siliconflow');
  expect(fallback.apiKey).toBe('sk-fallback');
  expect(fallback.model).toBe('Qwen/Qwen3-ASR-1.7B');

  const silent = await resolveRequestEndpoint(
    { ...sampleRequest(), configId: null, providerId: null, model: null },
    { getApiConfigs: async () => { throw new Error('offline'); },
      getModelAssignments: async () => { throw new Error('offline'); } }, 'sk');
  expect(silent.providerId).toBe('siliconflow');

  const customModel = await resolveRequestEndpoint(
    { ...sampleRequest(), configId: null, providerId: null, model: 'whisper-1' },
    null, 'sk');
  expect(customModel.model).toBe('whisper-1');
  expect(customModel.providerName).toBe('SiliconFlow');
});

function captureConfig(run: () => Promise<unknown>): Promise<AsrConfigError> {
  return run().then(
    () => { throw new Error('expected an ASR config error'); },
    (error: AsrConfigError) => {
      expect(error).toBeInstanceOf(AsrConfigError);
      return error;
    },
  );
}

it('resolveRequestEndpoint maps missing/disabled configs and providers', async () => {
  const missing = await captureConfig(() => resolveRequestEndpoint(
    sampleRequest(), fakeLlm([], null), null));
  expect(missing.code).toBe('model-config-missing');
  expect(missing.message).toBe('语音识别模型配置不存在: voice-asr');

  const disabled = await captureConfig(() => resolveRequestEndpoint(
    sampleRequest(), fakeLlm([apiConfig('voice-asr', 'https://x', { enabled: false })], null), null));
  expect(disabled.code).toBe('model-disabled');
  expect(disabled.message).toBe('语音识别模型 Qwen/Qwen3-ASR-1.7B 已停用');

  const provider = await captureConfig(() => resolveRequestEndpoint(
    { ...sampleRequest(), configId: null, providerId: 'anthropic', model: null },
    null, null));
  expect(provider.code).toBe('provider-unavailable');
  expect(provider.message).toBe('Voice input provider anthropic needs a model configuration (configId)');

  const noLlm = await captureConfig(() => resolveRequestEndpoint(sampleRequest(), null, null));
  expect(noLlm.code).toBe('model-config-missing');
  expect(noLlm.message).toBe('读取模型配置失败: 模型服务不可用');

  // AL-16: a rejection that is not an Error still shows its text, as `AppError`'s Display does.
  for (const [rejection, text] of [
    ['database is locked', 'database is locked'],
    [AppError.database('config table missing'), 'config table missing'],
  ] as const) {
    const unreadable = await captureConfig(() => resolveRequestEndpoint(sampleRequest(), {
      getApiConfigs: async () => { throw rejection; },
      getModelAssignments: async () => ({}) as never,
    }, null));
    expect(unreadable.code).toBe('model-config-missing');
    expect(unreadable.message).toBe(`读取模型配置失败: ${text}`);
  }
});

it('voice_input_transcribe registers and returns the wire response', async () => {
  const server = await startServer(json({ text: '语音转写', language: 'zh' }));
  const { service } = settings();
  const viaLlmHttp: string[] = [];
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: service,
      llm: fakeLlm([apiConfig('voice-asr', `${server.url}/v1`)], null),
      llmHttp: { fetch: ((input, init) => { viaLlmHttp.push(String(input)); return fetch(input, init); }) as AsrFetch },
      paths: testPaths,
    },
  });
  try {
    expect(await host.invoke('voice_input_transcribe', { request: sampleRequest() })).toEqual({
      text: '语音转写',
      language: 'zh',
      durationMs: 1500,
      providerId: 'custom',
      model: 'Qwen/Qwen3-ASR-1.7B',
    });
    expect(viaLlmHttp).toEqual([`${server.url}/v1/audio/transcriptions`]);
    expect(server.requests[0]!.url).toBe('/v1/audio/transcriptions');
    expect(server.requests[0]!.headers.authorization).toBe('Bearer sk-config');
  } finally {
    await host.dispose();
    await server.close();
  }
});

it('voice_input_transcribe without llmHttp fails as a network error and sends nothing', async () => {
  const server = await startServer(json({ text: '语音转写', language: 'zh' }));
  const { service } = settings();
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: service,
      llm: fakeLlm([apiConfig('voice-asr', `${server.url}/v1`)], null),
      paths: testPaths,
    },
  });
  try {
    await expect(host.invoke('voice_input_transcribe', { request: sampleRequest() })).rejects.toEqual({
      error_type: 'Network',
      message: JSON.stringify({
        code: 'network-failed',
        message: 'Voice input request failed: ASR request failed: LLM HTTP 服务不可用（需要 llmHttp）',
      }),
      details: null,
    });
    expect(server.requests).toHaveLength(0);
  } finally {
    await host.dispose();
    await server.close();
  }
});

it('transcribe_sends_only_through_the_supplied_fetch', async () => {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const replay: AsrFetch = async (input, init) => {
    seen.push({ url: String(input), init });
    return new Response(JSON.stringify({ text: '回放转写', language: 'zh' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const result = await transcribeWithEndpoint(
    endpoint('http://llm-replay.invalid/s/voice/v1', 'Qwen/Qwen3-ASR-1.7B'), sampleRequest(), replay);
  expect(result.text).toBe('回放转写');
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe('http://llm-replay.invalid/s/voice/v1/audio/transcriptions');
  expect(seen[0]!.init?.method).toBe('POST');
  expect((seen[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  expect(seen[0]!.init?.body).toBeInstanceOf(FormData);
  expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);
});

it('voice_input_transcribe maps config errors to AppError payload strings', async () => {
  const { service } = settings();
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: service,
      llm: fakeLlm([], null),
      paths: testPaths,
    },
  });
  try {
    await expect(host.invoke('voice_input_transcribe', { request: sampleRequest() })).rejects.toEqual({
      error_type: 'Validation',
      message: JSON.stringify({
        code: 'model-config-missing',
        message: '语音识别模型配置不存在: voice-asr',
      }),
      details: null,
    });

    const noKey = await createTestHost({
      plugins: [media],
      provide: { storage: unusedStorage(), settings: service, llm: fakeLlm([], null), paths: testPaths },
    });
    try {
      await expect(noKey.invoke('voice_input_transcribe', {
        request: { ...sampleRequest(), configId: null, providerId: null, model: null },
      })).rejects.toEqual({
        error_type: 'Configuration',
        message: JSON.stringify({
          code: 'settings-required',
          message: '未配置语音识别：请在「设置 → 模型分配」选择语音识别（ASR）模型，或填写 SiliconFlow API Key 使用默认模型',
        }),
        details: null,
      });
    } finally { await noKey.dispose(); }
  } finally { await host.dispose(); }
});

it('voice_input_transcribe_records_resolution_and_transcription_usage', async () => {
  const server = await startServer(json({ text: '你好，世界', language: 'zh' }));
  try {
    const config = apiConfig('voice-asr', `${server.url}/v1`);
    const llm = {
      getModelAssignments: async () => ({ voice_input_asr_model_config_id: 'voice-asr' }),
      getApiConfigs: async () => [config],
    };
    const usage: VoiceInputUsage[] = [];
    const result = await transcribeVoiceInput(
      sampleRequest(), llm as never, null, fetchAsr, item => { usage.push(item); });
    expect(result.text).toBe('你好，世界');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      providerId: 'custom',
      model: 'Qwen/Qwen3-ASR-1.7B',
      configId: 'voice-asr',
      success: true,
      errorMessage: null,
    });
    expect(usage[0]!.latencyMs).toBeGreaterThanOrEqual(0);

    const failures: VoiceInputUsage[] = [];
    const error = await capture(() => transcribeVoiceInput(
      sampleRequest(), null, null, fetchAsr, item => { failures.push(item); }));
    expect(error.message).toContain('"code":"model-config-missing"');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      providerId: 'siliconflow',
      model: 'Qwen/Qwen3-ASR-1.7B',
      configId: 'voice-asr',
      success: false,
    });
    expect(failures[0]!.errorMessage).toBe('读取模型配置失败: 模型服务不可用');
  } finally { await server.close(); }
});
