import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { tiktokenMissing } from './pending-dependency.ts';
import { estimateTokensHeuristic, pickEncoding, tokenizer } from '../tokenizer/index.ts';

describe('tiktoken Rust/WASM adapter (dstu-util/utils/token_budget.rs)', () => {
  it.skipIf(tiktokenMissing)('estimate_tokens_with_model_short_text_matches_exact_encoding: encodes with cl100k_base by default and matches tiktoken token counts', () => {
    expect(tokenizer.encode('hello world')).toEqual([15339, 1917]);
    expect(tokenizer.encode('')).toEqual([]);
    expect(tokenizer.encode('hello world 你好，世界')).toHaveLength(9);
    expect(tokenizer.estimateTokensWithModel('hello world')).toBe(2);
    expect(tokenizer.estimateTokensWithModel('hello world 你好，世界')).toBe(9);
    // tiktoken-rs `encode_with_special_tokens`: special tokens keep their ids.
    expect(tokenizer.encode('<|endoftext|>')).toEqual([100257]);
    expect(tokenizer.estimateTokensWithModel('<|endoftext|>')).toBe(1);
  });

  it.skipIf(tiktokenMissing)('selects o200k_base for the model families listed in pick_encoding', () => {
    for (const hint of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.5-preview', 'gpt-5', 'o1-preview', 'o3-mini', 'o4-mini', 'openai/o200k']) {
      expect(pickEncoding(hint), hint).toBe('o200k_base');
    }
    for (const hint of ['gpt-4-turbo', 'gpt-3.5-turbo', 'claude-3-7-sonnet', 'proto1-model', 'xo1']) {
      expect(pickEncoding(hint), hint).toBe('cl100k_base');
    }
    expect(pickEncoding(null)).toBe('cl100k_base');
    expect(pickEncoding(undefined)).toBe('cl100k_base');
    // o200k packs CJK more tightly: 3 tokens instead of cl100k's 6.
    expect(tokenizer.encode('你好，世界', 'gpt-4o')).toHaveLength(3);
    expect(tokenizer.estimateTokensWithModel('你好，世界', 'gpt-4o')).toBe(3);
  });

  it('reproduces the f32 heuristic for callers that do not use tiktoken', () => {
    expect(estimateTokensHeuristic('')).toBe(0);
    expect(estimateTokensHeuristic('hello world')).toBe(3); // 10*0.25 + 0.05 = 2.55
    expect(estimateTokensHeuristic('你好，世界')).toBe(5); // 4*1.0 + 0.8 = 4.8
    expect(estimateTokensHeuristic('!!!...')).toBe(2); // 6*0.3 = 1.8
    expect(estimateTokensHeuristic('カタカナ')).toBe(4);
    expect(estimateTokensHeuristic('한글')).toBe(2);
    expect(estimateTokensHeuristic('😀')).toBe(1);
  });

  it.skipIf(tiktokenMissing)('estimate_tokens_with_model_heterogeneous_text_does_not_average_away_dense_segments: samples head/middle/tail above 8000 characters', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. ';
    const dense = Array.from({ length: 2800 }, (_, index) =>
      String.fromCharCode(33 + (index * 47) % 94)).join('');
    const text = prose.repeat(64).slice(0, 2800) + dense + prose.repeat(64).slice(0, 2800);
    expect(Array.from(text)).toHaveLength(8400);
    const exact = tokenizer.encode(text).length;
    const estimate = tokenizer.estimateTokensWithModel(text);
    expect(estimate).toBeGreaterThanOrEqual(exact);
    expect(estimate).toBeGreaterThan(0);
  });

  it.skipIf(tiktokenMissing)('estimate_tokens_with_model_huge_repetitive_text_is_fast_and_reasonable', () => {
    const pathological = '数'.repeat(200_000);
    const start = performance.now();
    const estimate = tokenizer.estimateTokensWithModel(pathological);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(estimate).toBeGreaterThanOrEqual(100_000);
    expect(estimate).toBeLessThanOrEqual(400_000);
  });

  it.skipIf(tiktokenMissing)('estimate_tokens_with_model_heterogeneous_text_does_not_average_away_dense_segments: retains the original 20000/20000/20000 CJK input', () => {
    const cycle = (text: string, count: number): string => {
      const characters = Array.from(text);
      return Array.from({ length: count }, (_, index) => characters[index % characters.length]).join('');
    };
    const prose = cycle('The quick brown fox jumps over the lazy dog. ', 20_000);
    const dense = cycle('深度学习工作台需要把检索增强生成与间隔重复记忆卡片结合起来', 20_000);
    const text = prose + dense + prose;
    const exact = tokenizer.encode(text).length;
    expect(tokenizer.estimateTokensWithModel(text)).toBeGreaterThanOrEqual(exact);
  }, 90_000);

  it.skipIf(tiktokenMissing)('estimate_tokens_with_model_varied_huge_text_extrapolates_close_to_exact', () => {
    const base = Array.from('fn process_frame(idx: usize) -> Result<Frame, RenderError> { /* 渲染管线 */ }');
    const varied = Array.from({ length: 120_000 }, (_, index) => base[index % base.length]).join('');
    const exact = tokenizer.encode(varied).length;
    const ratio = tokenizer.estimateTokensWithModel(varied) / exact;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
    expect(ratio).toBeLessThanOrEqual(1.25);
  });

  it.skipIf(tiktokenMissing)('estimate_tokens_with_model_short_text_matches_exact_encoding: leaves texts at or below the threshold on the exact path', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(200).slice(0, 8000);
    expect(tokenizer.estimateTokensWithModel(text)).toBe(tokenizer.encode(text).length);
  });

  it.skipIf(tiktokenMissing)('is provided by the dstu.native plugin', async () => {
    const host = await createTestHost({ plugins: [native] });
    try {
      expect(host.ctx.nativeTokenizer.estimateTokensWithModel('hello world')).toBe(2);
      expect(host.ctx.nativeTokenizer.encode('hello')).toEqual(tokenizer.encode('hello'));
    } finally { await host.dispose(); }
  });
});
