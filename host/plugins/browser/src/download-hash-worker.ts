// Same source-worker loading pattern as F3 worker-entry.ts / F4 diagnostics-worker.ts.
import { parentPort, workerData } from 'node:worker_threads';
import { hashDownloadFileBoundedCore } from './download-hash.ts';

if (parentPort === null) throw new Error('download hash worker must run inside worker_threads');
const input: unknown = workerData;
if (input === null || typeof input !== 'object' || !('path' in input) || typeof input.path !== 'string'
  || !('maxBytes' in input) || typeof input.maxBytes !== 'number') {
  throw new Error('invalid download hash worker input');
}
parentPort.postMessage(hashDownloadFileBoundedCore(input.path, input.maxBytes));
