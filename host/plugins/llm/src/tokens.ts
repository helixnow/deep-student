/**
 * Token 估算（移植 `dstu-util/src/utils/token_budget.rs` 的启发式路径与
 * commands.rs:307–334 的 `estimate_tokens` 命令）。
 *
 * Desktop command counting uses the published F7 tokenizer. Internal heuristic
 * callers retain the separate Rust estimate_tokens behavior.
 */
import type { NativeTokenizer } from '../../../platform/native/tokenizer/api.ts';

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x2a700 && codePoint <= 0x2b73f) ||
    (codePoint >= 0x2b740 && codePoint <= 0x2b81f) ||
    (codePoint >= 0x2b820 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0x2ceb0 && codePoint <= 0x2ebef) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff)
  );
}

function isKana(codePoint: number): boolean {
  return (codePoint >= 0x3040 && codePoint <= 0x309f) || (codePoint >= 0x30a0 && codePoint <= 0x30ff);
}

function isHangul(codePoint: number): boolean {
  return (
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0x1100 && codePoint <= 0x11ff) ||
    (codePoint >= 0xa960 && codePoint <= 0xa97f) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
  );
}

function isAsciiAlphanumeric(codePoint: number): boolean {
  return (
    (codePoint >= 0x30 && codePoint <= 0x39) ||
    (codePoint >= 0x41 && codePoint <= 0x5a) ||
    (codePoint >= 0x61 && codePoint <= 0x7a)
  );
}

function isAsciiWhitespace(codePoint: number): boolean {
  return codePoint === 0x20 || codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d || codePoint === 0x0c;
}

export function estimateTokens(text: string): number {
  if (text === '') return 0;
  let sum = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0)!;
    if (codePoint < 0x80) {
      if (isAsciiAlphanumeric(codePoint)) sum = Math.fround(sum + 0.25);
      else if (isAsciiWhitespace(codePoint)) sum = Math.fround(sum + Math.fround(0.05));
      else sum = Math.fround(sum + Math.fround(0.3));
      continue;
    }
    if (isCjk(codePoint) || isKana(codePoint) || isHangul(codePoint)) sum = Math.fround(sum + 1.0);
    else sum = Math.fround(sum + Math.fround(0.8));
  }
  return Math.max(1, Math.round(sum));
}

export interface EstimateTokensResult {
  total: number;
  per_message: number[];
  precise: boolean;
  tokenizer: string;
}

export function estimateTokensForRequest(
  texts: readonly string[],
  model: string | null | undefined,
  tokenizer: NativeTokenizer,
): EstimateTokensResult {
  const perMessage: number[] = [];
  let total = 0;
  for (const text of texts) {
    const count = tokenizer.estimateTokensWithModel(text, model);
    total += count;
    perMessage.push(count);
  }
  return { total, per_message: perMessage, precise: true, tokenizer: 'tiktoken' };
}
