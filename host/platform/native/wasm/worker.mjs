import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WASI } from 'node:wasi';
import { parentPort, workerData } from 'node:worker_threads';

const ARGS = ['f7-native-wasm', '/out/request.json', '/out/response.json'];

function describe(error) {
  return { message: error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : 'Error' };
}

/**
 * `runWasmSync` mode: one long-lived thread serving requests from `workerData.port` while the
 * caller blocks on `workerData.flag` (Int32Array: [0] request state, [1] started).
 * Every request, and any exit of this thread, stores a non-zero state and notifies [0].
 */
function serveSync({ port, flag, wasmPath }) {
  const settle = (state) => { Atomics.store(flag, 0, state); Atomics.notify(flag, 0); };
  process.on('exit', () => settle(2));
  let module = null;
  port.on('message', (request) => {
    const outputDir = mkdtempSync(join(tmpdir(), 'f7-native-'));
    const stderrPath = join(outputDir, 'stderr.log');
    let reply;
    try {
      writeFileSync(join(outputDir, 'request.json'), JSON.stringify(request));
      const stderr = openSync(stderrPath, 'w');
      let failure;
      try {
        module ??= new WebAssembly.Module(readFileSync(wasmPath));
        const wasi = new WASI({ version: 'preview1', args: ARGS, env: {}, preopens: { '/out': outputDir }, returnOnExit: true, stderr });
        wasi.start(new WebAssembly.Instance(module, wasi.getImportObject()));
      } catch (error) {
        failure = describe(error);
      } finally {
        closeSync(stderr);
      }
      reply = { stderr: readFileSync(stderrPath, 'utf8'), ...(failure === undefined ? {} : { error: failure }) };
      if (failure === undefined) {
        try {
          reply.response = readFileSync(join(outputDir, 'response.json'), 'utf8');
        } catch (error) {
          reply.missing = describe(error).message;
        }
      }
    } catch (error) {
      reply = { stderr: '', error: describe(error) };
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
    port.postMessage(reply);
    settle(1);
  });
  Atomics.store(flag, 1, 1);
  Atomics.notify(flag, 1);
}

/** `holdNextWasmRun`: block the guest inside its `nth` call of `call` until the Host releases `gate`. */
function holdAt(wasiImport, { call, nth, gate }) {
  const original = wasiImport[call];
  if (typeof original !== 'function') throw new Error(`unknown WASI import ${call}`);
  let calls = 0;
  return {
    ...wasiImport,
    [call]: (...args) => {
      calls += 1;
      if (calls === nth) {
        parentPort.postMessage({ held: true });
        Atomics.wait(gate, 0, 0);
      }
      return original(...args);
    },
  };
}

async function runOnce() {
  const stderr = openSync(workerData.stderrPath, 'w');
  let failure;
  try {
    const wasi = new WASI({ version: 'preview1', args: ARGS, env: {}, preopens: workerData.preopens, returnOnExit: true, stderr });
    const imports = wasi.getImportObject();
    if (workerData.hold) imports.wasi_snapshot_preview1 = holdAt(imports.wasi_snapshot_preview1, workerData.hold);
    const instance = await WebAssembly.instantiate(workerData.module, imports);
    wasi.start(instance);
  } catch (error) {
    failure = describe(error);
  } finally { closeSync(stderr); }
  parentPort.postMessage(failure === undefined ? { ok: true } : { ok: false, error: failure });
}

if (workerData.sync) serveSync(workerData.sync);
else await runOnce();
