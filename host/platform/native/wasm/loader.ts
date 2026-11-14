/**
 * Loader for the F7 WASI engine (`f7-native-wasm.wasm`).
 *
 * The artifact is prebuilt and checked in (sha256 in `f7-native-wasm.wasm.sha256`); it is not
 * rebuilt in this repository. It embeds `starlark = 0.14.2`, `symphonia = 0.5.5`,
 * `regex = 1.12.3`, `image = 0.24.9` and `roxmltree = 0.20.0` (see README.md).  Node's `node:wasi`
 * runs the module with only an ephemeral output directory (and, for audio, the
 * media file's own directory) preopened; the module is compiled once and
 * instantiated per request.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { cachedModule, compileWasm, emitWasmStderr, missingResponseError, parseWasmResponse, WasmCancelledError } from './core.ts';

export { setWasmLogSink, WasmCancelledError, type WasmLogSink } from './core.ts';

const wasmPath = new URL('./f7-native-wasm.wasm', import.meta.url);
const workerUrl = new URL('./worker.mjs', import.meta.url);

/** Desktop source: the artifact next to this file, compiled once per process. */
const module = cachedModule(async () => compileWasm(await readFile(wasmPath)));

export interface WasmRun {
  response: Record<string, unknown>;
  /** Ephemeral host directory behind the guest `/out` preopen. */
  outputDir: string;
}

export interface WasmRunOptions {
  signal?: AbortSignal;
  /** Host directory exposed read-only as guest `/media` (audio decode/probe). */
  mediaDir?: string;
  /** Extra files written into the guest `/out` directory before the module runs. */
  files?: Record<string, Uint8Array>;
}

/**
 * Holds the guest of the next {@link runWasm} inside its `nth` (1-based) call of the WASI import
 * `call` and reports that through `onHeld` on the Host thread. The guest stays blocked there until
 * `release()` is called or the run is cancelled.
 */
export interface WasmGuestHold {
  call: string;
  nth: number;
  onHeld(release: () => void): void;
}

let nextHold: WasmGuestHold | null = null;

/**
 * Test seam for cancellation: lets a test abort while the engine is provably executing, instead of
 * racing a timer against how fast the engine finishes on the current machine.
 */
export function holdNextWasmRun(hold: WasmGuestHold): void {
  nextHold = hold;
}

async function execute(preopens: Record<string, string>, stderrPath: string, signal?: AbortSignal): Promise<void> {
  const hold = nextHold;
  nextHold = null;
  if (signal?.aborted) throw new WasmCancelledError();
  const compiled = await module();
  if (signal?.aborted) throw new WasmCancelledError();
  const gate = hold === null ? null : new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(workerUrl, {
    workerData: { module: compiled, preopens, stderrPath, ...(hold === null ? {} : { hold: { call: hold.call, nth: hold.nth, gate } }) },
  });
  let failure: Error | undefined;
  let responded = false;
  const cancel = (): void => {
    // Await exit below before the caller removes /out or reads the stderr file.
    worker.terminate().catch((error: unknown) => { failure = error instanceof Error ? error : new Error(String(error)); });
  };
  const ended = new Promise<void>((resolve, reject) => {
    worker.on('message', (message: { ok: boolean; held?: true; error?: { message: string; name: string } }) => {
      if (message.held) {
        hold!.onHeld(() => { Atomics.store(gate!, 0, 1); Atomics.notify(gate!, 0); });
        return;
      }
      responded = true;
      if (!message.ok) { failure = new Error(message.error!.message); failure.name = message.error!.name; }
    });
    worker.once('error', (error) => { failure = error; });
    worker.once('exit', code => {
      if (signal?.aborted) reject(new WasmCancelledError());
      else if (failure !== undefined) reject(failure);
      else if (!responded || code !== 0) reject(new Error(`WASI worker exited with code ${code} without completing the request`));
      else resolve();
    });
  });
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  try { await ended; }
  finally { signal?.removeEventListener('abort', cancel); }
}

export async function runWasm(request: unknown, options: WasmRunOptions = {}): Promise<WasmRun> {
  const outputDir = await mkdtemp(join(tmpdir(), 'f7-native-'));
  const preopens: Record<string, string> = { '/out': outputDir };
  if (options.mediaDir !== undefined) preopens['/media'] = options.mediaDir;
  const requestPath = join(outputDir, 'request.json');
  const responsePath = join(outputDir, 'response.json');
  try {
    for (const [name, bytes] of Object.entries(options.files ?? {})) {
      await writeFile(join(outputDir, name), bytes);
    }
    await writeFile(requestPath, JSON.stringify(request));
    const stderrPath = join(outputDir, 'stderr.log');
    await writeFile(stderrPath, ''); // Exists even when cancelled before worker startup.
    let startError: { error: unknown } | null = null;
    try {
      await execute(preopens, stderrPath, options.signal);
    } catch (error) {
      startError = { error };
    }
    emitWasmStderr(await readFile(stderrPath, 'utf8'));
    if (startError !== null) throw startError.error;
    let text: string;
    try {
      text = await readFile(responsePath, 'utf8');
    } catch (error) {
      throw missingResponseError(error);
    }
    return { response: parseWasmResponse(text), outputDir };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

export async function removeRun(run: WasmRun): Promise<void> {
  await rm(run.outputDir, { recursive: true, force: true });
}

/**
 * V8 stack of the thread behind {@link runWasmSync}. Guest frames also live on the host stack, and
 * roxmltree's tokenizer recurses once per nesting level: on the ~1 MB default stack of the Host's
 * main thread the host stack ran out first (macOS arm64: below 2500 levels), so the depth limit
 * depended on the CPU. With this stack the guest's own 1 MiB stack is the limit everywhere
 * (SPEC "WP-095": 3000 levels parse, deeper input throws `WebAssembly.RuntimeError`).
 */
const SYNC_STACK_MB = 8;
/** The synchronous runner thread is released after this long without requests. */
const SYNC_IDLE_MS = 30_000;
const SYNC_START_TIMEOUT_MS = 30_000;

interface SyncRunner {
  worker: Worker;
  port: MessagePort;
  /** [0]: 0 while a request is pending, 1 replied, 2 the thread is exiting; [1]: 1 once started. */
  flag: Int32Array;
  idle: ReturnType<typeof setTimeout> | null;
}

interface SyncReply {
  stderr: string;
  response?: string;
  missing?: string;
  error?: { name: string; message: string };
}

let syncRunner: SyncRunner | null = null;

function retireSyncRunner(runner: SyncRunner): void {
  if (syncRunner === runner) syncRunner = null;
  if (runner.idle !== null) clearTimeout(runner.idle);
  runner.port.close();
  void runner.worker.terminate();
}

function startSyncRunner(): SyncRunner {
  const { port1, port2 } = new MessageChannel();
  const flag = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(workerUrl, {
    workerData: { sync: { port: port2, flag, wasmPath: fileURLToPath(wasmPath) } },
    transferList: [port2],
    resourceLimits: { stackSizeMb: SYNC_STACK_MB },
  });
  worker.unref();
  port1.unref();
  const runner: SyncRunner = { worker, port: port1, flag, idle: null };
  worker.once('exit', () => { if (syncRunner === runner) syncRunner = null; });
  if (Atomics.wait(flag, 1, 0, SYNC_START_TIMEOUT_MS) === 'timed-out') {
    retireSyncRunner(runner);
    throw new Error(`f7-native-wasm synchronous worker did not start within ${SYNC_START_TIMEOUT_MS} ms`);
  }
  return runner;
}

/** Errors cross the thread as name + message; keep the classes callers distinguish. */
function remoteError(error: { name: string; message: string }): Error {
  const rebuilt = error.name === 'RuntimeError' ? new WebAssembly.RuntimeError(error.message)
    : error.name === 'RangeError' ? new RangeError(error.message)
      : error.name === 'TypeError' ? new TypeError(error.message)
        : new Error(error.message);
  if (rebuilt.name !== error.name) rebuilt.name = error.name;
  return rebuilt;
}

/**
 * Runs one request synchronously, for synchronous service contracts (`mindmapXml.parse`).  Same
 * module, protocol and `/out` preopen as {@link runWasm}; the guest runs on a dedicated thread
 * with a {@link SYNC_STACK_MB} MB stack while the caller blocks, so it cannot be cancelled.
 */
export function runWasmSync(request: unknown): Record<string, unknown> {
  const runner = syncRunner ??= startSyncRunner();
  if (runner.idle !== null) clearTimeout(runner.idle);
  runner.idle = null;
  Atomics.store(runner.flag, 0, 0);
  runner.port.postMessage(request);
  while (Atomics.load(runner.flag, 0) === 0) Atomics.wait(runner.flag, 0, 0);
  const received = receiveMessageOnPort(runner.port);
  if (received === undefined) {
    retireSyncRunner(runner);
    throw new Error('f7-native-wasm synchronous worker exited before replying');
  }
  if (Atomics.load(runner.flag, 0) === 2) retireSyncRunner(runner);
  else {
    runner.idle = setTimeout(() => retireSyncRunner(runner), SYNC_IDLE_MS);
    runner.idle.unref();
  }
  const reply = received.message as SyncReply;
  emitWasmStderr(reply.stderr);
  if (reply.error !== undefined) throw remoteError(reply.error);
  if (reply.response === undefined) throw missingResponseError(new Error(reply.missing ?? 'response.json was not read'));
  return parseWasmResponse(reply.response);
}
