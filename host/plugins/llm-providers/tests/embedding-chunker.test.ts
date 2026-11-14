import { expect, it } from 'vitest';
import { EmbeddingChunker, EmbeddingTokenLimits } from '../src/multimodal/embedding-chunker.ts';

it('test_estimate_tokens_chinese', () => {
  const tokens = EmbeddingChunker.estimateTokens('这是一段中文测试文本');
  expect(tokens).toBeGreaterThanOrEqual(10);
  expect(tokens).toBeLessThanOrEqual(20);
});
it('test_estimate_tokens_english', () => {
  const tokens = EmbeddingChunker.estimateTokens('This is a test sentence.');
  expect(tokens).toBeGreaterThanOrEqual(4);
  expect(tokens).toBeLessThanOrEqual(10);
});
it('test_estimate_tokens_mixed', () => {
  expect(EmbeddingChunker.estimateTokens('Hello 世界 Test 测试')).toBeGreaterThan(0);
});
it('test_chunk_short_text', () => {
  expect(new EmbeddingChunker(100).chunkText('短文本')).toEqual(['短文本']);
});
it('test_chunk_long_text', () => {
  expect(new EmbeddingChunker(10).chunkText('这是第一段。\n\n这是第二段。\n\n这是第三段。').length).toBeGreaterThanOrEqual(2);
});
it('test_hard_chunk_utf8_safe', () => {
  for (const chunk of new EmbeddingChunker(5).hardChunk('你好世界测试文本')) {
    expect(/^[\x00-\x7f]*$/.test(chunk) || chunk.length > 0).toBe(true);
    expect([...chunk].join('')).toBe(chunk);
  }
});
it('test_aggregate_mean_pooling', () => {
  const result = EmbeddingChunker.aggregateEmbeddings([[1, 0, 0], [0, 1, 0]], 'MeanPooling');
  expect(result).toHaveLength(3);
  expect(Math.abs(result[0]! - result[1]!)).toBeLessThan(0.01);
});
it('test_tail_text_by_tokens', () => {
  const text = '前面一些文本。这是尾部内容';
  const tail = EmbeddingChunker.tailTextByTokens(text, 3);
  expect(tail.length).toBeGreaterThan(0);
  expect(text.endsWith(tail)).toBe(true);
  expect(EmbeddingChunker.tailTextByTokens(text, 0)).toBe('');
  expect(EmbeddingChunker.tailTextByTokens('', 10)).toBe('');
});
it('test_chunk_text_overlap', () => {
  const chunks = new EmbeddingChunker(20).withOverlap(5).chunkText('这是第一段内容。\n\n这是第二段内容。\n\n这是第三段内容。');
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks[1]!.startsWith(EmbeddingChunker.tailTextByTokens('这是第一段内容。', 5).trim())).toBe(true);
  for (const chunk of chunks) expect(EmbeddingChunker.estimateTokens(chunk)).toBeLessThanOrEqual(20);
});
it('test_chunk_text_overlap_respects_token_budget', () => {
  const chunks = new EmbeddingChunker(12).withOverlap(5).chunkText('这是第一段内容。\n\n这是第二段内容。\n\n这是第三段内容。');
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  for (const chunk of chunks) expect(EmbeddingChunker.estimateTokens(chunk)).toBeLessThanOrEqual(12);
});
it('test_chunk_text_no_overlap_when_single_chunk', () => {
  expect(new EmbeddingChunker(1000).withOverlap(50).chunkText('短文本不需要分块')).toEqual(['短文本不需要分块']);
});
it('test_token_limits', () => {
  const limits = new EmbeddingTokenLimits();
  expect(limits.getLimit('BAAI/bge-large-zh-v1.5')).toBe(Math.trunc(512 * 0.9));
  expect(limits.getLimit('BAAI/bge-m3')).toBe(Math.trunc(8192 * 0.9));
  expect(limits.getLimit('Qwen/Qwen3-Embedding-8B')).toBe(Math.trunc(32768 * 0.9));
});
