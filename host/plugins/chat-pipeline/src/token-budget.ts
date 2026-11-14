/**
 * dstu-util/src/utils/token_budget.rs — heuristic token estimation.
 *
 * The Rust build measures exactly with tiktoken only when the
 * `tokenizer_tiktoken` feature is on; otherwise `estimate_tokens_with_model`
 * falls back to `estimate_tokens`. Production injects the F7 tokenizer. f32 arithmetic
 * is preserved with `Math.fround` so token counts match the Rust build bit for
 * bit on the heuristic path.
 */
import type { NativeTokenizer } from '../../../platform/native/tokenizer/api.ts';

let nativeTokenizer: NativeTokenizer | null = null;

export function configureTokenizer(tokenizer: NativeTokenizer): void {
  nativeTokenizer = tokenizer;
}

function isCjk(cp: number): boolean {
  return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f)
    || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf)
    || (cp >= 0x2ceb0 && cp <= 0x2ebef) || (cp >= 0xf900 && cp <= 0xfaff);
}
function isKana(cp: number): boolean {
  return (cp >= 0x3040 && cp <= 0x309f) || (cp >= 0x30a0 && cp <= 0x30ff);
}
function isHangul(cp: number): boolean {
  return (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff)
    || (cp >= 0xa960 && cp <= 0xa97f) || (cp >= 0xd7b0 && cp <= 0xd7ff);
}
function isAsciiAlphanumeric(cp: number): boolean {
  return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a);
}
/** char::is_ascii_whitespace: space, tab, LF, FF, CR (not VT U+000B). */
function isAsciiWhitespace(cp: number): boolean {
  return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d && cp !== 0x0b);
}

/** token_budget.rs::estimate_tokens (f32 accumulation, then round + max(1)). */
export function estimateTokens(text: string): number {
  if (text === '') return 0;
  let sum = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) {
      if (isAsciiAlphanumeric(cp)) sum = Math.fround(sum + 0.25);
      else if (isAsciiWhitespace(cp)) sum = Math.fround(sum + Math.fround(0.05));
      else sum = Math.fround(sum + Math.fround(0.3));
      continue;
    }
    sum = Math.fround(sum + (isCjk(cp) || isKana(cp) || isHangul(cp) ? 1 : Math.fround(0.8)));
  }
  return Math.max(1, Math.round(sum));
}

/** Production uses tiktoken; standalone helpers retain Rust's no-feature path. */
export function estimateTokensWithModel(text: string, modelHint?: string | null): number {
  return nativeTokenizer === null ? estimateTokens(text)
    : nativeTokenizer.estimateTokensWithModel(text, modelHint);
}
