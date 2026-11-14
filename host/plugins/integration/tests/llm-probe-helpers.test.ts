import { describe, expect, it } from 'vitest';
import type { ApiConfig } from '../../llm/api.ts';
// boundary-allow cross-plugin-impl: L22 集成测试直接验证 L02 已接入真实命令的探活纯函数
import { buildAsrProbeWav, buildChatProbeBody, inspectProbeBuffer, looksLikeAsrModelId, resolveTestModelKind } from '../../llm/src/connection_test.ts';
// boundary-allow cross-plugin-impl: L22 集成测试直接验证 L02 已接入真实命令的模型端点/字段探测
import { PROBE_CONTEXT_WINDOW_KEYS, PROBE_MAX_OUTPUT_KEYS, probeU32Field, vendorModelsEndpoint } from '../../llm/src/vendor_models.ts';

/**
 * `src/commands.rs` 中探活/端点/ASR 纯函数的 TS 行为级移植。
 *
 * 直接调用 L02 `connection_test.ts` / `vendor_models.ts` 的生产实现，这些函数
 * 已接入 `test_api_connection` 与供应商模型目录命令；不复制算法、不替身被测函数。
 * Codex OAuth 两条经 `test_api_connection` 命令移植到 `llm-codex-connection.test.ts`。
 */
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function config(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    id: '', name: '', vendorId: null, vendorName: null, providerType: null,
    providerScope: null, authMode: null, apiProtocol: null, supportsOpenaiResponses: null,
    apiKey: '', baseUrl: '', model: '', isMultimodal: false, isReasoning: false,
    isEmbedding: false, isReranker: false, isImageGeneration: false, enabled: false,
    modelAdapter: 'general', maxOutputTokens: 8192, temperature: 0.7, supportsTools: false,
    geminiApiVersion: 'v1', isBuiltin: false, isReadOnly: false, reasoningEffort: null,
    reasoningMode: null, thinkingEnabled: false, thinkingBudget: null, includeThoughts: false,
    minP: null, topK: null, enableThinking: null, supportsReasoning: false, headers: null,
    topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: null, effort: null, verbosity: null,
    isFavorite: false, maxTokensLimit: null, contextWindow: null, extraBody: null,
    resolvedAdapterId: null, ...overrides,
  };
}

describe('src/commands.rs probe helpers', () => {
  it('ollama_root_base_url_lists_models_under_v1', () => {
    for (const base of ['http://localhost:11434', 'http://127.0.0.1:11434/']) {
      const { url, kind } = vendorModelsEndpoint(base, 'openai', null);
      expect(url.pathname).toBe('/v1/models');
      expect(kind).toBe('openai');
    }
    expect(vendorModelsEndpoint('http://localhost:11434/v1', 'openai', null).url.pathname)
      .toBe('/v1/models');
    expect(vendorModelsEndpoint('http://localhost:8080', 'openai', null).url.pathname)
      .toBe('/models');
  });

  it('chat_probe_body_uses_completion_tokens_for_reasoning_models', () => {
    const body = buildChatProbeBody(config({
      model: 'o3', providerType: 'custom', providerScope: 'custom',
      apiProtocol: 'openai_chat_completions', isReasoning: true, supportsReasoning: true,
    }));
    expect(body.max_completion_tokens).toBe(32);
    expect(body.max_tokens).toBeUndefined();
    expect(body.stream).toBe(true);
    expect(body.temperature).toBeUndefined();
  });

  it('chat_probe_body_disables_thinking_for_qwen_reasoning', () => {
    const body = buildChatProbeBody(config({
      model: 'qwen3-max', providerType: 'qwen', providerScope: 'qwen', modelAdapter: 'qwen',
      apiProtocol: 'openai_chat_completions', isReasoning: true, supportsReasoning: true,
      enableThinking: true,
    }));
    expect(body.enable_thinking).toBe(false);
    expect(body.max_completion_tokens).toBe(32);
    expect(body.max_tokens).toBeUndefined();
  });

  it('chat_probe_body_respects_mimo_dialect', () => {
    const body = buildChatProbeBody(config({
      model: 'mimo-v2.5-pro', providerType: 'mimo', providerScope: 'mimo', modelAdapter: 'mimo',
      apiProtocol: 'openai_chat_completions', isReasoning: true, supportsReasoning: true,
    }));
    expect(body.max_completion_tokens).toBe(32);
    expect(body.max_tokens).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('chat_probe_body_keeps_max_tokens_for_plain_models', () => {
    const body = buildChatProbeBody(config({
      model: 'gpt-4o-mini', providerType: 'custom', providerScope: 'custom',
      apiProtocol: 'openai_chat_completions',
    }));
    expect(body.max_tokens).toBe(32);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  it('probe_u32_field_reads_common_provider_shapes', () => {
    expect(probeU32Field({ context_length: 128_000 }, PROBE_CONTEXT_WINDOW_KEYS)).toBe(128_000);
    expect(probeU32Field({ max_model_len: '32768' }, PROBE_CONTEXT_WINDOW_KEYS)).toBe(32_768);
    expect(probeU32Field(
      { top_provider: { max_completion_tokens: 8192 } }, PROBE_MAX_OUTPUT_KEYS,
    )).toBe(8_192);
    expect(probeU32Field({ inputTokenLimit: 1_000_000 }, ['inputTokenLimit'])).toBe(1_000_000);
    expect(probeU32Field({ max_tokens: 4096 }, PROBE_CONTEXT_WINDOW_KEYS)).toBeNull();
    expect(probeU32Field({ context_length: 0 }, PROBE_CONTEXT_WINDOW_KEYS)).toBeNull();
    expect(probeU32Field({}, PROBE_MAX_OUTPUT_KEYS)).toBeNull();
  });

  it('inspect_probe_buffer_judges_sse_events', () => {
    expect(inspectProbeBuffer(
      encode('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'), false,
    )).toEqual({ kind: 'success' });
    expect(inspectProbeBuffer(
      encode('event: response.created\ndata: {"type":"response.created"}\n\n'), false,
    )).toEqual({ kind: 'success' });
    expect(inspectProbeBuffer(encode('data: [DONE]\n\n'), false)).toEqual({ kind: 'success' });

    const error = inspectProbeBuffer(
      encode('data: {"error":{"message":"model not found"}}\n\n'), false,
    );
    expect(error.kind).toBe('failure');
    if (error.kind === 'failure') {
      expect(error.category).toBe('provider_error');
      expect(error.message).toContain('model not found');
    }

    expect(inspectProbeBuffer(encode(': keep-alive\n\n'), false)).toEqual({ kind: 'pending' });
    expect(inspectProbeBuffer(encode('data: {"cho'), false)).toEqual({ kind: 'pending' });
    expect(inspectProbeBuffer(encode('data: {"choices":[]}'), true)).toEqual({ kind: 'success' });

    const empty = inspectProbeBuffer(new Uint8Array(), true);
    expect(empty.kind).toBe('failure');
    if (empty.kind === 'failure') expect(empty.category).toBe('format');
  });

  it('inspect_probe_buffer_judges_non_sse_responses', () => {
    expect(inspectProbeBuffer(
      encode('{"choices":[{"message":{"content":"ok"}}]}'), false,
    )).toEqual({ kind: 'success' });

    const jsonError = inspectProbeBuffer(
      encode('{"error":{"message":"bad api key"}}'), false,
    );
    expect(jsonError.kind).toBe('failure');
    if (jsonError.kind === 'failure') expect(jsonError.category).toBe('provider_error');

    const html = inspectProbeBuffer(encode('<html>502 Bad Gateway</html>'), false);
    expect(html.kind).toBe('failure');
    if (html.kind === 'failure') expect(html.category).toBe('format');
  });

  it('test_model_kind_prefers_flags_then_heuristics', () => {
    expect(resolveTestModelKind(config({ model: 'gpt-4o-mini', isEmbedding: true })))
      .toBe('embedding');
    expect(resolveTestModelKind(config({ model: 'bge-m3' }))).toBe('embedding');
    expect(resolveTestModelKind(config({ model: 'bge-reranker-v2-m3' }))).toBe('reranker');
    expect(resolveTestModelKind(config({ model: 'gpt-image-1.5' }))).toBe('image_generation');
    expect(resolveTestModelKind(config({ model: 'gpt-5.5' }))).toBe('chat');
  });

  it('asr_models_route_to_asr_probe', () => {
    for (const model of [
      'XingChenAGI/XingChenASR-V3.2-Ultra',
      'XingChenAGI/XingChenASR-V3.2',
      'TeleAI/TeleSpeechASR',
      'Qwen/Qwen3-ASR-1.7B',
      'openai/whisper-large-v3',
      'FunAudioLLM/SenseVoiceSmall',
      'qwen3-stt',
      'asr-v3',
    ]) {
      expect(resolveTestModelKind(config({ model }))).toBe('asr');
    }
  });

  it('chat_models_do_not_route_to_asr_probe', () => {
    for (const model of [
      'deepseek-v4.1-flash',
      'gpt-4o',
      'kimi-k2.5',
      'qwen3.8-max',
      'text-embedding-3-large',
      'bge-reranker-v2-m3',
    ]) {
      expect(resolveTestModelKind(config({ model }))).not.toBe('asr');
    }
  });

  it('asr_heuristic_excludes_tts_and_speech_synthesis', () => {
    for (const model of [
      'openai/tts-1',
      'FunAudioLLM/SpeechSynthesis-large',
      'vendor/speech-generation-x',
      'text-to-speech-model',
    ]) {
      expect(looksLikeAsrModelId(model)).toBe(false);
    }
  });

  it('build_asr_probe_wav_is_valid_mono_16k', () => {
    const wav = buildAsrProbeWav();
    expect(Buffer.from(wav.subarray(0, 4)).toString('latin1')).toBe('RIFF');
    expect(Buffer.from(wav.subarray(8, 12)).toString('latin1')).toBe('WAVE');
    expect(Buffer.from(wav.subarray(36, 40)).toString('latin1')).toBe('data');
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const dataLength = view.getUint32(40, true);
    expect(dataLength).toBe(32_000);
    expect(wav.byteLength).toBe(44 + dataLength);
  });
});
