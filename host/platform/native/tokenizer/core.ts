/**
 * Portable part of the tokenizer (`token_budget.rs`): encoding choice, the
 * head/middle/tail sampling cap and the heuristic estimate. The tiktoken core
 * is injected, so desktop (`index.ts`, CJS `tiktoken`) and mobile / Web
 * (`web.ts`, `tiktoken/init` with a fetched `.wasm`) share every rule here.
 */
import type { NativeTokenizer, TokenEncoding } from './api.ts';

/** The slice of tiktoken's `Tiktoken` the service uses. */
export interface Tiktoken { encode(text: string, allowedSpecial: 'all'): Uint32Array }

const TIKTOKEN_SAMPLE_THRESHOLD_CHARS = 8_000;
const TIKTOKEN_SAMPLE_PART_CHARS = 2_000;
const TIKTOKEN_SAMPLE_SAFETY_MARGIN = 1.1;

/** `token_budget.rs::has_o_series_prefix`: first match only, ASCII word boundary before it. */
function hasOSeriesPrefix(model: string): boolean {
  for (const prefix of ['o1', 'o3', 'o4']) {
    const position = model.indexOf(prefix);
    if (position === -1) continue;
    if (position === 0 || !/[a-z0-9]/.test(model[position - 1]!)) return true;
  }
  return false;
}

/** `token_budget.rs::pick_encoding`. */
export function pickEncoding(modelHint: string | null | undefined): TokenEncoding {
  if (modelHint === null || modelHint === undefined) return 'cl100k_base';
  const model = modelHint.toLowerCase();
  if (
    model.includes('o200k')
    || model.includes('gpt-4o')
    || model.includes('gpt-4.1')
    || model.includes('gpt-4.5')
    || model.includes('gpt-5')
    || hasOSeriesPrefix(model)
  ) return 'o200k_base';
  return 'cl100k_base';
}

function isCjk(codePoint: number): boolean {
  return (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x20000 && codePoint <= 0x2a6df)
    || (codePoint >= 0x2a700 && codePoint <= 0x2b73f)
    || (codePoint >= 0x2b740 && codePoint <= 0x2b81f)
    || (codePoint >= 0x2b820 && codePoint <= 0x2ceaf)
    || (codePoint >= 0x2ceb0 && codePoint <= 0x2ebef)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff);
}

function isKana(codePoint: number): boolean {
  return (codePoint >= 0x3040 && codePoint <= 0x309f)
    || (codePoint >= 0x30a0 && codePoint <= 0x30ff);
}

function isHangul(codePoint: number): boolean {
  return (codePoint >= 0xac00 && codePoint <= 0xd7af)
    || (codePoint >= 0x1100 && codePoint <= 0x11ff)
    || (codePoint >= 0xa960 && codePoint <= 0xa97f)
    || (codePoint >= 0xd7b0 && codePoint <= 0xd7ff);
}

/**
 * `token_budget.rs::estimate_tokens`: f32 accumulation is deliberate, so very
 * long inputs reproduce the Rust rounding rather than drifting in f64.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let sum = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x80) {
      if (
        (codePoint >= 0x30 && codePoint <= 0x39)
        || (codePoint >= 0x41 && codePoint <= 0x5a)
        || (codePoint >= 0x61 && codePoint <= 0x7a)
      ) sum = Math.fround(sum + 0.25);
      else if (codePoint === 0x20 || (codePoint >= 0x09 && codePoint <= 0x0d)) sum = Math.fround(sum + 0.05);
      else sum = Math.fround(sum + 0.3);
      continue;
    }
    sum = Math.fround(sum + (isCjk(codePoint) || isKana(codePoint) || isHangul(codePoint) ? 1 : 0.8));
  }
  return Math.max(1, Math.round(sum));
}

/** `token_budget.rs::encode_capped`; `EncodeWithSpecialTokens` == `encode(text, 'all')`. */
function encodeCapped(encoder: (name: TokenEncoding) => Tiktoken, encoding: TokenEncoding, text: string): number {
  const characters = Array.from(text);
  const totalChars = characters.length;
  if (totalChars <= TIKTOKEN_SAMPLE_THRESHOLD_CHARS) {
    return encoder(encoding).encode(text, 'all').length;
  }
  const head = characters.slice(0, TIKTOKEN_SAMPLE_PART_CHARS).join('');
  const midStart = Math.floor((totalChars - TIKTOKEN_SAMPLE_PART_CHARS) / 2);
  const mid = characters.slice(midStart, midStart + TIKTOKEN_SAMPLE_PART_CHARS).join('');
  const tail = characters.slice(totalChars - TIKTOKEN_SAMPLE_PART_CHARS).join('');
  const headTokens = encoder(encoding).encode(head, 'all').length;
  const midTokens = encoder(encoding).encode(mid, 'all').length;
  const tailTokens = encoder(encoding).encode(tail, 'all').length;
  const sampledTokens = headTokens + midTokens + tailTokens;
  const maxDensity = Math.max(headTokens, midTokens, tailTokens) / TIKTOKEN_SAMPLE_PART_CHARS;
  const extrapolated = Math.round(maxDensity * totalChars * TIKTOKEN_SAMPLE_SAFETY_MARGIN);
  return Math.max(extrapolated, sampledTokens);
}

/** The tokenizer service over a `get_encoding`; encoders are created once per encoding. */
export function createTokenizer(getEncoding: (name: TokenEncoding) => Tiktoken): NativeTokenizer {
  const encoders = new Map<TokenEncoding, Tiktoken>();
  const encoder = (name: TokenEncoding): Tiktoken => {
    let found = encoders.get(name);
    if (found === undefined) {
      found = getEncoding(name);
      encoders.set(name, found);
    }
    return found;
  };
  return {
    encode(text, modelHint) {
      return Array.from(encoder(pickEncoding(modelHint)).encode(text, 'all'));
    },
    estimateTokensWithModel(text, modelHint) {
      return encodeCapped(encoder, pickEncoding(modelHint), text);
    },
  };
}

