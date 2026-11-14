/**
 * Tokenizer on mobile / Web: tiktoken's bundler entry (`tiktoken/init`) with
 * its `.wasm` supplied by the caller, e.g. `fetch(assetUrl)` for the asset the
 * bundler emits for `tiktoken/tiktoken_bg.wasm`. Same ranks as the desktop CJS
 * build; `core.ts` holds every counting rule.
 */
import { get_encoding, init } from 'tiktoken/init';
import type { NativeTokenizer } from './api.ts';
import { createTokenizer } from './core.ts';
import { compileWasm, type WasmSource } from '../wasm/core.ts';

/** tiktoken keeps one wasm instance per JS realm; later calls reuse it. */
export async function loadWebTokenizer(wasm: WasmSource): Promise<NativeTokenizer> {
  const module = await compileWasm(wasm);
  await init(imports => WebAssembly.instantiate(module, imports));
  return createTokenizer(name => get_encoding(name));
}
