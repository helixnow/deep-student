/**
 * Portable F7 runner: same command protocol as `loader.ts`, with `/out` (and
 * read-only `/media`) held in memory by {@link MemoryWasi}. The guest runs on
 * the calling thread, so a started request cannot be interrupted; hosts that
 * need cancellation or a responsive UI run the engine inside a Web Worker.
 */
import {
  emitWasmStderr, F7_ARGS, F7_REQUEST_NAME, F7_RESPONSE_NAME, missingResponseError, parseWasmResponse, WasmCancelledError,
} from './core.ts';
import { MemoryDirectory, MemoryWasi } from './wasi.ts';

export interface MemoryRunOptions {
  signal?: AbortSignal;
  /** Extra files placed in the guest `/out` directory before the module runs. */
  files?: Record<string, Uint8Array>;
  /** Files exposed read-only as guest `/media` (audio decode/probe). */
  media?: Record<string, Uint8Array>;
}

export interface MemoryRun {
  response: Record<string, unknown>;
  /** Final contents of guest `/out`, including request/response JSON and any engine outputs. */
  files: ReadonlyMap<string, Uint8Array>;
}

export interface MemoryWasmEngine {
  run(request: unknown, options?: MemoryRunOptions): Promise<MemoryRun>;
}

interface PreparedRun {
  wasi: MemoryWasi;
  out: MemoryDirectory;
}

function prepare(request: unknown, options: MemoryRunOptions): PreparedRun {
  const out = new MemoryDirectory(options.files ?? {});
  out.write(F7_REQUEST_NAME, new TextEncoder().encode(JSON.stringify(request)));
  const preopens: Record<string, MemoryDirectory> = { '/out': out };
  if (options.media !== undefined) preopens['/media'] = new MemoryDirectory(options.media, { readonly: true });
  return { wasi: new MemoryWasi({ args: F7_ARGS, preopens, stderr: emitWasmStderr }), out };
}

function finish({ wasi, out }: PreparedRun, instance: WebAssembly.Instance): MemoryRun {
  wasi.start(instance);
  const bytes = out.read(F7_RESPONSE_NAME);
  if (bytes === undefined) throw missingResponseError(new Error(`/out/${F7_RESPONSE_NAME} was not written`));
  return { response: parseWasmResponse(new TextDecoder().decode(bytes)), files: out.snapshot() };
}

/**
 * Synchronous run for synchronous service contracts (`mindmapXml.parse`).
 * Browsers only allow synchronous instantiation of large modules off the main thread.
 */
export function runMemoryCommandSync(module: WebAssembly.Module, request: unknown, options: Omit<MemoryRunOptions, 'signal'> = {}): MemoryRun {
  const prepared = prepare(request, options);
  return finish(prepared, new WebAssembly.Instance(module, prepared.wasi.imports()));
}

export function createMemoryWasmEngine(load: () => Promise<WebAssembly.Module>): MemoryWasmEngine {
  return {
    async run(request, options = {}) {
      const { signal } = options;
      if (signal?.aborted) throw new WasmCancelledError();
      const module = await load();
      if (signal?.aborted) throw new WasmCancelledError();
      const prepared = prepare(request, options);
      const instance = await WebAssembly.instantiate(module, prepared.wasi.imports());
      if (signal?.aborted) throw new WasmCancelledError();
      return finish(prepared, instance);
    },
  };
}
