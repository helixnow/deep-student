/**
 * `dstu-util/src/utils/token_budget.rs` with the `tokenizer_tiktoken` feature.
 *
 * The Rust implementation uses `tiktoken-rs` (cl100k_base / o200k_base) and caps
 * pathological inputs by sampling the head/middle/tail. `tiktoken` is the same
 * publisher's original Rust/WASM core; the pure-JS port has pathological BPE
 * latency even on 2000-character samples. Ranks, specials and the sampling
 * formula are unchanged. See SPEC for measured evidence and dependency request.
 */
import { createRequire } from 'node:module';
import type { NativeTokenizer, TokenEncoding } from './api.ts';
import { createTokenizer, type Tiktoken } from './core.ts';

export { estimateTokens, estimateTokens as estimateTokensHeuristic, pickEncoding } from './core.ts';

interface TiktokenModule { get_encoding(name: TokenEncoding): Tiktoken }

// Loaded on first use so a root install without the pending `tiktoken` dependency
// still boots the plugin; callers get the real MODULE_NOT_FOUND, never an estimate.
function get_encoding(name: TokenEncoding): Tiktoken {
  return (createRequire(import.meta.url)('tiktoken') as TiktokenModule).get_encoding(name);
}

export const tokenizer: NativeTokenizer = createTokenizer(get_encoding);
