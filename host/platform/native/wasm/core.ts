/**
 * Portable half of the F7 WASI loader: compiling from bytes or a fetched
 * `Response`, the guest command protocol, the stderr log sink and the
 * cancellation error. No Node imports; `loader.ts` (desktop, `node:wasi` in a
 * worker) and `web.ts` (fetch + {@link MemoryWasi}) both build on this file.
 */

/** Anything a platform adapter can hand over: raw bytes or an HTTP response for the `.wasm` asset. */
export type WasmSource = Uint8Array | ArrayBuffer | Response | PromiseLike<Response>;

function isResponse(value: unknown): value is Response {
  return typeof Response !== 'undefined' && value instanceof Response;
}

/**
 * `WebAssembly.compileStreaming` when the response is served as
 * `application/wasm` (browsers reject anything else), otherwise a buffered compile.
 */
export async function compileWasm(source: WasmSource): Promise<WebAssembly.Module> {
  const resolved = await source;
  if (!isResponse(resolved)) {
    // TS 5.7+ 的 BufferSource 只接受普通 ArrayBuffer 上的视图；视图复用同一份模块字节。
    return WebAssembly.compile(resolved instanceof ArrayBuffer ? resolved
      : new Uint8Array(resolved.buffer as ArrayBuffer, resolved.byteOffset, resolved.byteLength));
  }
  if (!resolved.ok) throw new Error(`failed to fetch wasm module ${resolved.url}: HTTP ${resolved.status}`);
  const contentType = resolved.headers.get('content-type') ?? '';
  if (typeof WebAssembly.compileStreaming === 'function' && contentType.split(';')[0]!.trim() === 'application/wasm') {
    return WebAssembly.compileStreaming(resolved);
  }
  return WebAssembly.compile(await resolved.arrayBuffer());
}

/** Compile once per loader; a failed compile is retried on the next call. */
export function cachedModule(load: () => Promise<WebAssembly.Module>): () => Promise<WebAssembly.Module> {
  let compiled: Promise<WebAssembly.Module> | null = null;
  return () => {
    compiled ??= load().catch((error: unknown) => {
      compiled = null;
      throw error;
    });
    return compiled;
  };
}

/** Guest argv: `f7-native-wasm <request.json> <response.json>`, both inside the `/out` preopen. */
export const F7_REQUEST_NAME = 'request.json';
export const F7_RESPONSE_NAME = 'response.json';
export const F7_ARGS: readonly string[] = ['f7-native-wasm', `/out/${F7_REQUEST_NAME}`, `/out/${F7_RESPONSE_NAME}`];

export class WasmCancelledError extends Error {
  constructor() { super('WASI execution cancelled'); this.name = 'WasmCancelledError'; }
}

/**
 * Rust `log::warn!` sites inside the WASI crate write to stderr (there is no
 * logger in wasm).  The plugin installs a sink so those lines reach the same
 * `ctx.logger` targets as the Tauri build instead of being dropped.
 */
export type WasmLogSink = (line: string) => void;
let logSink: WasmLogSink | null = null;

export function setWasmLogSink(sink: WasmLogSink | null): void {
  logSink = sink;
}

/** Forwards each non-empty stderr line to the installed sink. */
export function emitWasmStderr(text: string): void {
  if (logSink === null) return;
  for (const line of text.split('\n')) {
    if (line.length > 0) logSink(line);
  }
}

export function parseWasmResponse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

export function missingResponseError(error: unknown): Error {
  return new Error(`f7-native-wasm produced no response: ${error instanceof Error ? error.message : String(error)}`);
}
