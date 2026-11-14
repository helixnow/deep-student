/**
 * Imports one module as the entry point of a fresh module graph (this worker's own ESM loader) and
 * reports whether evaluation threw. Used by `tests/plugin-isolation.runtime.test.ts`.
 */
import { parentPort, workerData } from 'node:worker_threads';

let reply;
try {
  const namespace = await import(workerData.specifier);
  reply = { ok: true, exports: Object.keys(namespace).length };
} catch (error) {
  reply = {
    ok: false,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}
parentPort.postMessage(reply);
process.exit(0);
