import { describe, expect, it } from 'vitest';
import { AppError } from '../../../platform/errors/api.ts';
import { MultimodalInput } from '../src/multimodal/types.ts';
import {
  DEFAULT_BATCH_SIZE, DEFAULT_SUMMARY_CONCURRENCY, VL_EMBED_BACKOFF_BASE_MS, VL_EMBED_BACKOFF_MAX_MS,
  defaultEmbeddingServiceConfig, isTransientEmbeddingError, looksLikeValidBase64,
  prepareInputsWithFallback, vlEmbedBackoffDelay,
} from '../src/multimodal/embedding-service.ts';

describe('multimodal embedding service', () => {
  it('test_embedding_service_config_default', () => {
    const config = defaultEmbeddingServiceConfig();
    expect(config.batch_size).toBe(DEFAULT_BATCH_SIZE);
    expect(config.enable_fallback).toBe(true);
    expect(config.summary_concurrency).toBe(DEFAULT_SUMMARY_CONCURRENCY);
  });

  it('test_prepare_inputs_with_fallback_valid_image', () => {
    const validBase64 = 'a'.repeat(200);
    const input = MultimodalInput.textAndImage('test text', validBase64, 'image/png');
    expect(input.text).toBe('test text');
    expect(input.image).not.toBeUndefined();

    const [prepared] = prepareInputsWithFallback([input]);
    expect(prepared).toEqual({ text: 'test text', image: { data: validBase64, media_type: 'image/png' } });

    const [degraded] = prepareInputsWithFallback([MultimodalInput.textAndImage('fallback', 'short', 'image/png')]);
    expect(degraded).toEqual({ text: 'fallback' });
  });

  it('test_looks_like_valid_base64', () => {
    expect(looksLikeValidBase64('aGVsbG8='.repeat(20))).toBe(true);
    expect(looksLikeValidBase64('aGVsbG8=')).toBe(false);
    expect(looksLikeValidBase64(`data:image/png;base64,${'a'.repeat(200)}`)).toBe(false);
    expect(looksLikeValidBase64(`${'a'.repeat(100)}#${'b'.repeat(100)}`)).toBe(false);
  });

  it('test_is_transient_embedding_error', () => {
    expect(isTransientEmbeddingError(AppError.network('多模态嵌入API请求失败: connection reset'))).toBe(true);
    expect(isTransientEmbeddingError(AppError.llm('请求过于频繁，请稍后重试'))).toBe(true);
    expect(isTransientEmbeddingError(AppError.llm('嵌入服务暂时不可用，请稍后重试'))).toBe(true);
    expect(isTransientEmbeddingError(AppError.llm('API 密钥无效或已过期，请检查设置'))).toBe(false);
    expect(isTransientEmbeddingError(AppError.configuration('冻结的多模态嵌入配置已禁用或能力协议不匹配'))).toBe(false);
  });

  it('test_vl_embed_backoff_delay_capped', () => {
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      for (const nanos of [0, 1, 123_456_789, 999_999_999]) {
        const delay = vlEmbedBackoffDelay(attempt, nanos);
        expect(delay).toBeGreaterThanOrEqual(VL_EMBED_BACKOFF_BASE_MS);
        expect(delay).toBeLessThanOrEqual(VL_EMBED_BACKOFF_MAX_MS + VL_EMBED_BACKOFF_MAX_MS / 4);
      }
    }
  });
});
