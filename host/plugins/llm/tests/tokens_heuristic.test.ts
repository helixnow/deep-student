import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../src/tokens.ts';

describe('token_budget.rs::estimate_tokens (X7-TOKEN-01, static Rust-source vectors)', () => {
  it.each([
    ['X7-L02-HANGUL-A', 0xa960, 3],
    ['X7-L02-HANGUL-B', 0xd7b0, 3],
    ['X7-L02-HANGUL-COMPAT', 0x3130, 2],
  ])('%s preserves the original Hangul classification', (_finding, codePoint, expected) => {
    expect(estimateTokens(String.fromCodePoint(codePoint as number).repeat(3))).toBe(expected);
  });

  it.each([
    [0x10ff, 2], [0x1100, 3], [0x11ff, 3], [0x1200, 2],
    [0xa95f, 2], [0xa960, 3], [0xa97f, 3], [0xa980, 2],
    [0xabff, 2], [0xac00, 3], [0xd7af, 3], [0xd7b0, 3], [0xd7ff, 3], [0xe000, 2],
    [0x3130, 2], [0x318f, 2],
  ])('Hangul range boundary U+%s', (codePoint, expected) => {
    expect(estimateTokens(String.fromCodePoint(codePoint).repeat(3))).toBe(expected);
  });

  it.each([
    ['punctuation rounding tie', '.', 15, 5], // f32 sum bits 0x40900000 (4.5)
    ['space just below rounding tie', ' ', 30, 1], // 0x3fbffffd
    ['long punctuation accumulation', '.', 100_000, 30_028], // 0x46ea97cf
    ['long whitespace accumulation', ' ', 100_000, 4_999], // 0x459c3a3a
    ['long other scalar accumulation', '😀', 100_000, 79_988], // 0x479c3a3a
  ])('%s uses f32 weights and f32 accumulation', (_name, character, count, expected) => {
    expect(estimateTokens(character.repeat(count))).toBe(expected);
  });

  it('retains empty input, minimum one and Rust ASCII whitespace membership', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(' ')).toBe(1);
    expect(estimateTokens('AA')).toBe(1);
    expect(estimateTokens('\v'.repeat(10))).toBe(3);
    expect(estimateTokens('\t\n\f\r '.repeat(6))).toBe(1);
  });
});
