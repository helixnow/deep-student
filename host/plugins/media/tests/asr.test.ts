import { expect, it } from 'vitest';
import type { ApiConfig } from '../../llm/api.ts';
import {
  AIMD_MAX, AIMD_MIN, AsrConfigError, AsrEndpoint, Aimd, classifyFailure, cleanAsrText,
  chatAsrLanguage, DEFAULT_SILICONFLOW_MODEL, modelSupportsVerboseJson, parseChatTranscript,
  parseTranscriptionBody,
} from '../src/asr.ts';

it('aimd_additive_increase_multiplicative_decrease', () => {
  const a = new Aimd(2, 1, 4);
  a.onSuccess();
  expect(a.limit()).toBe(2);
  a.onSuccess();
  expect(a.limit()).toBe(3);
  for (let i = 0; i < 3; i++) a.onSuccess();
  expect(a.limit()).toBe(4);
  for (let i = 0; i < 10; i++) a.onSuccess();
  expect(a.limit()).toBe(4);
  const now = 1_000_000;
  a.onRateLimited(now, 2);
  expect(a.limit()).toBe(2);
  expect(a.coolingUntil(now)).not.toBeNull();
  expect(a.coolingUntil(now + 3000)).toBeNull();
  a.onRateLimited(now);
  a.onRateLimited(now);
  expect(a.limit()).toBe(1);
  // 失败打断连续成功
  a.onSuccess();
  a.onFailure();
  a.onSuccess();
  expect(a.limit()).toBe(2);
});

it('failure_classification', () => {
  const s = (status: number) => ({ kind: 'status' as const, status, retryAfterSeconds: null, body: '' });
  expect(classifyFailure(s(429))).toEqual({ kind: 'rate_limited', retryAfterSeconds: null });
  expect(classifyFailure(s(400))).toEqual({ kind: 'segment_fatal' });
  expect(classifyFailure(s(401))).toEqual({ kind: 'job_fatal', code: 'auth-failed' });
  expect(classifyFailure(s(403))).toEqual({ kind: 'job_fatal', code: 'auth-failed' });
  expect(classifyFailure(s(503))).toEqual({ kind: 'retryable' });
  expect(classifyFailure({ kind: 'transport', timeout: true, message: '' })).toEqual({ kind: 'retryable' });
});

it('verbose_json_bounds_parsed', () => {
  const r = parseTranscriptionBody('{"text":" hi ","segments":[{"start":0.32,"end":1.5},{"start":1.6,"end":2.25}]}');
  expect(r.text).toBe('hi');
  expect(r.speechBoundsMs).toEqual([320, 2250]);
  const plain = parseTranscriptionBody('{"text":"plain"}');
  expect(plain.speechBoundsMs).toBeNull();
  expect(() => parseTranscriptionBody('not json')).toThrow();
  const qwen = parseTranscriptionBody('{"text":"language Chinese<asr_text>讲到这里"}');
  expect(qwen.text).toBe('讲到这里');
  expect(modelSupportsVerboseJson('FunAudioLLM/whisper-large-v3')).toBe(true);
  expect(modelSupportsVerboseJson('Qwen/Qwen3-ASR-1.7B')).toBe(false);
});

it('endpoint_url_tolerates_full_endpoint_base_urls', () => {
  const ep = new AsrEndpoint('siliconflow', 'SiliconFlow',
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'key', 'qwen3-asr-flash', null);
  expect(ep.url('chat/completions')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
});

it('chat_transcript_parsing_strips_qwen_language_prefix', () => {
  const [text, language] = parseChatTranscript(
    '{"choices":[{"message":{"role":"assistant","content":"欢迎使用阿里云。","annotations":[{"type":"audio_info","language":"zh","emotion":"neutral"}]}}]}');
  expect(text).toBe('欢迎使用阿里云。');
  expect(language).toBe('zh');

  const [cleaned] = parseChatTranscript(
    '{"choices":[{"message":{"content":[{"type":"text","text":"language Chinese<asr_text>你好"}]}}]}');
  expect(cleaned).toBe('你好');
  expect(() => parseChatTranscript('{"choices":[]}')).toThrow();
  expect(cleanAsrText('  plain text ')).toBe('plain text');
  expect(chatAsrLanguage('zh-CN')).toBe('zh');
  expect(chatAsrLanguage('auto')).toBeNull();
});

it('aimd_constants_match_rust_defaults', () => {
  expect(AIMD_MIN).toBe(1);
  expect(AIMD_MAX).toBe(8);
});

function apiConfig(
  provider: string, model: string, apiKey: string,
): ApiConfig {
  return {
    id: 'cfg-asr',
    name: 'ASR',
    vendorId: null,
    vendorName: '统一出口',
    providerType: provider,
    providerScope: null,
    authMode: null,
    apiProtocol: null,
    supportsOpenaiResponses: null,
    apiKey,
    baseUrl: 'http://relay.example.test/v1/',
    model,
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
    headers: {
      'X-Relay-Tenant': 'deep-student',
      Authorization: 'Bearer hijack',
    },
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
  };
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AsrConfigError);
    expect((error as AsrConfigError).code).toBe(code);
    return;
  }
  throw new Error(`expected AsrConfigError ${code}`);
}

it('relay_config_uses_its_own_base_url_key_and_headers', () => {
  const cfg = apiConfig('custom', 'Qwen/Qwen3-ASR-0.6B', 'sk-relay');
  const endpoint = AsrEndpoint.fromApiConfig(cfg);
  expect(endpoint.providerId).toBe('custom');
  expect(endpoint.providerName).toBe('统一出口');
  expect(endpoint.apiKey).toBe('sk-relay');
  expect(endpoint.configId).toBe('cfg-asr');
  expect(endpoint.protocol).toBe('transcriptions');
  expect(endpoint.url('audio/transcriptions'))
    .toBe('http://relay.example.test/v1/audio/transcriptions');
  expect(endpoint.headers).toEqual([['X-Relay-Tenant', 'deep-student']]);

  const missingKey = apiConfig('custom', 'whisper-1', '***');
  expectCode(() => AsrEndpoint.fromApiConfig(missingKey), 'settings-required');
  const anthropic = apiConfig('anthropic', 'whisper-1', 'sk');
  expectCode(() => AsrEndpoint.fromApiConfig(anthropic), 'provider-unavailable');
  const realtime = apiConfig('qwen', 'qwen3-asr-flash-realtime', 'sk');
  expectCode(() => AsrEndpoint.fromApiConfig(realtime), 'provider-unavailable');
  // 旧版一键分配写入的已下架模型由默认模型接替
  const retired = apiConfig('siliconflow', 'TeleAI/TeleSpeechASR', 'sk-sf');
  expect(AsrEndpoint.fromApiConfig(retired).model).toBe(DEFAULT_SILICONFLOW_MODEL);
  expect(DEFAULT_SILICONFLOW_MODEL).toBe('Qwen/Qwen3-ASR-1.7B');
  expect(new AsrConfigError('settings-required', 'x').code).toBe('settings-required');
});
