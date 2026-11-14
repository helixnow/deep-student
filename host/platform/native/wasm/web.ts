/**
 * Mobile / Web adapter for the F7 engine: the `.wasm` asset is fetched by URL
 * (streaming compile when served as `application/wasm`) and run through the
 * in-memory WASI of `engine.ts`. Bundlers resolve the default
 * `new URL('./f7-native-wasm.wasm', import.meta.url)` to an emitted asset.
 */
import { cachedModule, compileWasm } from './core.ts';
import { createMemoryWasmEngine, type MemoryWasmEngine } from './engine.ts';

export const F7_WASM_URL: URL = new URL('./f7-native-wasm.wasm', import.meta.url);

export interface WebWasmEngineOptions {
  url?: string | URL;
  fetch?: (input: string | URL) => Promise<Response>;
}

export function createWebWasmEngine(options: WebWasmEngineOptions = {}): MemoryWasmEngine {
  const url = options.url ?? F7_WASM_URL;
  const fetchAsset = options.fetch ?? ((input: string | URL) => fetch(input));
  return createMemoryWasmEngine(cachedModule(() => compileWasm(fetchAsset(url))));
}
