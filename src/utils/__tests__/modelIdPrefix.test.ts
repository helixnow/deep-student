import { describe, expect, it } from 'vitest';
import { detectModelKindSignal, stripGatewayPrefix } from '../modelIdPrefix';

describe('stripGatewayPrefix', () => {
  it('strips a gateway slug prefix after the first underscore', () => {
    expect(stripGatewayPrefix('embed-gateway_qwen3.7-text-rerank')).toBe('qwen3.7-text-rerank');
    expect(stripGatewayPrefix('embed-gateway_qwen3-vl-embedding')).toBe('qwen3-vl-embedding');
    expect(stripGatewayPrefix('embed-gateway_qwen3.8-max')).toBe('qwen3.8-max');
    expect(stripGatewayPrefix('chat-relay_deepseek-v4-pro')).toBe('deepseek-v4-pro');
  });

  it('strips path prefixes (OpenRouter / hosted platforms) first', () => {
    expect(stripGatewayPrefix('BAAI/bge-m3')).toBe('bge-m3');
    expect(stripGatewayPrefix('pro/BAAI/bge-m3')).toBe('bge-m3');
    expect(stripGatewayPrefix('qwen/text-embedding-v4')).toBe('text-embedding-v4');
  });

  it('keeps "model_version" shapes intact (rest lacks separators)', () => {
    // 网易有道真实 ID：_v1 是版本号，剥离会丢掉 embedding 信号
    expect(stripGatewayPrefix('bce-embedding-base_v1')).toBe('bce-embedding-base_v1');
    expect(stripGatewayPrefix('bce-reranker-base_v1')).toBe('bce-reranker-base_v1');
    // 纯日期后缀
    expect(stripGatewayPrefix('bge-m3_20250815')).toBe('bge-m3_20250815');
  });

  it('keeps IDs whose prefix is not a dashed slug', () => {
    expect(stripGatewayPrefix('gte_Qwen2-7B-instruct')).toBe('gte_Qwen2-7B-instruct');
    expect(stripGatewayPrefix('my_id')).toBe('my_id');
  });

  it('keeps IDs without underscores', () => {
    expect(stripGatewayPrefix('Qwen3-Embedding-0.6B')).toBe('Qwen3-Embedding-0.6B');
    expect(stripGatewayPrefix('text-embedding-3-large')).toBe('text-embedding-3-large');
    expect(stripGatewayPrefix('')).toBe('');
  });

  it('requires the rest to contain letters (pure-date rest is a version suffix)', () => {
    expect(stripGatewayPrefix('tomato_2026-01-01')).toBe('tomato_2026-01-01');
  });
});

describe('detectModelKindSignal', () => {
  it('detects rerank before embedding (gateway slug may contain "embed")', () => {
    expect(detectModelKindSignal('embed-gateway_qwen3.7-text-rerank')).toBe('rerank');
    expect(detectModelKindSignal('bge-reranker-v2-m3')).toBe('rerank');
    expect(detectModelKindSignal('netease-youdao/bce-reranker-base_v1')).toBe('rerank');
  });

  it('detects embedding from the stripped model name', () => {
    expect(detectModelKindSignal('embed-gateway_qwen3-vl-embedding')).toBe('embedding');
    expect(detectModelKindSignal('embed-gateway_text-embedding-v4')).toBe('embedding');
    expect(detectModelKindSignal('text-embedding-3-large')).toBe('embedding');
    expect(detectModelKindSignal('BAAI/bge-m3')).toBe('embedding');
    expect(detectModelKindSignal('voyage-multimodal-3')).toBe('embedding');
  });

  it('returns null for chat models behind an embedding-flavored gateway prefix', () => {
    expect(detectModelKindSignal('embed-gateway_qwen3.8-max')).toBeNull();
    expect(detectModelKindSignal('qwen3.8-max')).toBeNull();
    expect(detectModelKindSignal('deepseek-v4-pro')).toBeNull();
    expect(detectModelKindSignal('')).toBeNull();
  });
});
