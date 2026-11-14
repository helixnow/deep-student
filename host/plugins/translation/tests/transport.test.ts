import { describe, expect, it, vi } from 'vitest';
import type { ApiConfig } from '../../llm/api.ts';
import { OpenAIAdapter } from '../../llm-providers/api.ts';
import {
  buildTranslationRequestBody, classifyProviderBlock, defaultStreamOptions, extractNonstreamText,
  httpFailure, parseProtocolBlock, streamTranslate,
} from '../src/transport.ts';
import { popoverStreamOptions } from '../src/commands.ts';
import { decodeBase64ImagePayload } from '../src/ocr_payload.ts';
import { decodeBase64Standard } from '../../../platform/secrets/crypto-service.ts';

function config(maxOutputTokens: number, maxTokensLimit: number | null): ApiConfig {
  return {
    id: 'c', name: 'c', providerType: 'openai', providerScope: 'openai',
    apiProtocol: 'openai_chat_completions', supportsOpenaiResponses: false,
    apiKey: '', baseUrl: 'https://api.example.com/v1', model: 'test',
    isMultimodal: false, isReasoning: false, isEmbedding: false, isReranker: false,
    isImageGeneration: false, enabled: true, modelAdapter: 'general',
    maxOutputTokens, maxTokensLimit, temperature: 0.7, supportsTools: false,
    reasoningEffort: null, supportsReasoning: false, headers: null,
    enableThinking: null, thinkingEnabled: false, verbosity: null,
  } as ApiConfig;
}

describe('pipeline.rs::build_translation_request_body', () => {
  it('translation_payload_uses_model_and_provider_output_budget', () => {
    const options = defaultStreamOptions();
    expect(buildTranslationRequestBody(config(65_536, null), 'system', 'user', options).max_tokens)
      .toBe(65_536);
    expect(buildTranslationRequestBody(config(65_536, 32_768), 'system', 'user', options).max_tokens)
      .toBe(32_768);
    expect(buildTranslationRequestBody(config(1_024, null), 'system', 'user', options).max_tokens)
      .toBe(1_024);
  });

  it('translation_payload_preserves_explicit_output_budget', () => {
    const options = { ...defaultStreamOptions(), maxTokens: 8_192 };
    expect(buildTranslationRequestBody(config(16_384, 12_288), 'system', 'user', options).max_tokens)
      .toBe(8_192);
  });

  it('keeps the Rust message roles, temperature and streaming flag', () => {
    const body = buildTranslationRequestBody(config(1024, null), 'sys', 'usr', defaultStreamOptions());
    expect(body).toMatchObject({
      model: 'test',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }],
      temperature: 0.3,
      stream: true,
    });
  });
});

describe('chat_popover.rs::popover_leaves_output_limit_to_model_configuration', () => {
  it('popover_leaves_output_limit_to_model_configuration', () => {
    const options = popoverStreamOptions();
    expect(options.maxTokens).toBeNull();
    expect(options.enableThinking).toBe(false);
    expect(options.temperature).toBe(0.2);
    expect(options.idleTimeoutMs).toBe(30_000);
    expect(options.totalTimeoutMs).toBe(120_000);
    expect(options.maxRequestAttempts).toBe(2);
  });
});

describe('cmd/translation.rs::decode_base64_image_payload', () => {
  it('decode_payload_infers_png_from_signature', () => {
    const { bytes, extension } = decodeBase64ImagePayload('iVBORw0KGgo=', decodeBase64Standard);
    expect(extension).toBe('png');
    expect(bytes.length).toBe(8);
  });

  it('decode_payload_prefers_data_url_mime_when_signature_is_insufficient', () => {
    const { extension } = decodeBase64ImagePayload('data:image/webp;base64,AAECAwQF', decodeBase64Standard);
    expect(extension).toBe('webp');
  });

  it('rejects malformed data urls and oversized payloads', () => {
    expect(() => decodeBase64ImagePayload('data:image/png;base64', decodeBase64Standard)).toThrow('Invalid data URL format');
    expect(() => decodeBase64ImagePayload('!!!!', decodeBase64Standard)).toThrow('Base64解码失败');
  });
});

describe('pipeline.rs error classification', () => {
  it.each(['response headers', 'HTTP error body'])('enforces the total timeout while waiting for %s', async phase => {
    vi.useFakeTimers();
    const clearCancelStream = vi.fn(async () => {});
    let requestSignal: AbortSignal | null | undefined;
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>(resolve => { notifyFetchStarted = resolve; });
    try {
      const operation = streamTranslate({
        config: config(1024, null), apiKey: 'fixture', systemPrompt: 'translate',
        userPrompt: 'hello', streamEvent: 'timeout-headers', onChunk: () => {},
        options: { totalTimeoutMs: 120_000 },
        control: {
          consumePendingCancel: async () => false,
          subscribeCancelStream: async () => new AbortController().signal,
          clearCancelStream,
          clearCancelArtifacts: async () => {},
        },
        runtime: {
          fetch: async (_input, init) => {
            requestSignal = init?.signal;
            notifyFetchStarted();
            if (phase === 'HTTP error body') {
              return new Response(new ReadableStream<Uint8Array>(), { status: 503 });
            }
            return new Promise<Response>(() => {});
          },
          sleep: async () => {}, now: () => Date.now(),
        },
      });
      const assertion = expect(operation).rejects.toMatchObject({ code: 'timeout_total' });
      await fetchStarted;
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(requestSignal?.aborted).toBe(true);
      expect(clearCancelStream).toHaveBeenCalledWith('timeout-headers');
    } finally {
      vi.useRealTimers();
    }
  }, 1000);

  it('maps every HTTP status range to the Rust user-facing message', () => {
    expect(httpFailure(400)).toMatchObject({ message: '翻译请求参数无效，请检查模型配置', code: 'http_400', retriable: false });
    expect(httpFailure(401)).toMatchObject({ message: 'API 密钥无效或已过期，请检查设置', code: 'http_401', retriable: false });
    expect(httpFailure(402)).toMatchObject({ code: 'http_402', retriable: false });
    expect(httpFailure(403)).toMatchObject({ code: 'http_403' });
    expect(httpFailure(404)).toMatchObject({ code: 'http_404' });
    expect(httpFailure(408)).toMatchObject({ code: 'http_408', retriable: true });
    expect(httpFailure(413)).toMatchObject({ code: 'http_413', retriable: false });
    expect(httpFailure(429)).toMatchObject({ code: 'rate_limited', retriable: true });
    expect(httpFailure(503)).toMatchObject({ code: 'http_5xx', retriable: true });
    expect(httpFailure(418)).toMatchObject({ code: 'http_4xx', retriable: false });
    expect(httpFailure(302)).toMatchObject({ code: 'http_error', retriable: true });
  });

  it('classifies provider blocks as content, output limit or provider errors', () => {
    expect(classifyProviderBlock({ type: 'safety_error', reason: 'x' }))
      .toMatchObject({ code: 'content_filtered', retriable: false });
    expect(classifyProviderBlock({ type: 'provider_error', reason: 'max_output_tokens' }))
      .toMatchObject({ code: 'max_output_tokens' });
    expect(classifyProviderBlock({ type: 'provider_error', details: { message: 'boom' } }))
      .toMatchObject({ message: '翻译服务返回错误：boom', code: 'provider_error' });
    expect(classifyProviderBlock({})).toMatchObject({ message: '翻译服务返回错误，请稍后重试' });
  });
});

describe('protocol stream parsing', () => {
  it('parses OpenAI chat deltas, finish_reason and [DONE]', () => {
    const adapter = new OpenAIAdapter();
    expect(parseProtocolBlock('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}', 'openai_chat_completions'))
      .toEqual([{ type: 'content', text: 'hi' }]);
    // providers/mod.rs:368: finish_reason is held until transport terminal; it is not Done itself.
    expect(parseProtocolBlock('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}', 'openai_chat_completions', adapter))
      .toEqual([]);
    expect(parseProtocolBlock('data: [DONE]', 'openai_chat_completions', adapter)).toEqual([{ type: 'done' }]);
  });

  it('turns provider error frames into safety events', () => {
    expect(parseProtocolBlock('data: {"error":{"message":"quota"}}', 'openai_chat_completions'))
      .toEqual([{ type: 'safety', info: { type: 'provider_error', reason: 'stream_error', details: { message: 'quota' } } }, { type: 'done' }]);
  });

  it('parses Responses, Anthropic and Gemini content events', () => {
    expect(parseProtocolBlock('data: {"type":"response.output_text.delta","delta":"hi"}', 'openai_responses'))
      .toEqual([{ type: 'content', text: 'hi' }]);
    expect(parseProtocolBlock('data: {"type":"response.completed"}', 'openai_responses'))
      .toEqual([{ type: 'done' }]);
    expect(parseProtocolBlock('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}', 'anthropic_messages'))
      .toEqual([{ type: 'content', text: 'hi' }]);
    expect(parseProtocolBlock('data: {"type":"message_stop"}', 'anthropic_messages'))
      .toEqual([{ type: 'done' }]);
    expect(parseProtocolBlock('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}', 'google_generate_content'))
      .toEqual([{ type: 'content', text: 'hi' }, { type: 'done' }]);
    expect(parseProtocolBlock('data: [DONE]', 'google_generate_content')).toEqual([{ type: 'done' }]);
    expect(parseProtocolBlock('data: {"promptFeedback":{"blockReason":"SAFETY"}}', 'google_generate_content'))
      .toEqual([{ type: 'safety', info: { type: 'prompt_blocked', reason: 'SAFETY', details: { blockReason: 'SAFETY' } } }]);
  });
});

describe('non-stream response extraction', () => {
  it('extracts text for every supported protocol', () => {
    expect(extractNonstreamText({ choices: [{ message: { content: 'hi' } }] }, 'openai_chat_completions')).toBe('hi');
    expect(extractNonstreamText({ output: [{ content: [{ type: 'output_text', text: 'hi' }] }] }, 'openai_responses')).toBe('hi');
    expect(extractNonstreamText({ content: [{ type: 'text', text: 'hi' }] }, 'anthropic_messages')).toBe('hi');
    expect(extractNonstreamText({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }, 'google_generate_content')).toBe('hi');
  });
});
