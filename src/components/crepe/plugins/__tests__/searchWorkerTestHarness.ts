import { Worker as NodeWorker } from 'node:worker_threads';
import { Blob as NodeBlob } from 'node:buffer';
import { vi } from 'vitest';

/** Browser Worker API backed by an actual separate V8 isolate, not a regex mock. */
export function installSearchWorkerHarness() {
  const blobs = new Map<string, NodeBlob>();
  const workers = new Set<NodeWorker>();
  let terminated = 0;
  let id = 0;
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL(blob: Blob) {
      const url = `blob:test-${++id}`;
      blobs.set(url, blob as unknown as NodeBlob);
      return url;
    }
    static revokeObjectURL(url: string) { blobs.delete(url); }
  });
  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: unknown }) => void;
    onerror?: (event: { message: string }) => void;
    worker?: NodeWorker;
    stopped = false;
    source: Promise<string>;
    constructor(url: string) { this.source = blobs.get(url)!.text(); }
    async postMessage(data: unknown) {
      const source = await this.source;
      if (this.stopped) return;
      const worker = this.worker = new NodeWorker(`
        const { parentPort } = require('node:worker_threads');
        let onmessage;
        const postMessage = (data) => parentPort.postMessage(data);
        ${source}
        parentPort.on('message', (data) => onmessage({ data }));
      `, { eval: true });
      workers.add(worker);
      worker.on('message', (data) => this.onmessage?.({ data }));
      worker.on('error', (error) => this.onerror?.({ message: error.message }));
      worker.postMessage(data);
    }
    terminate() {
      this.stopped = true;
      terminated++;
      if (this.worker) { workers.delete(this.worker); void this.worker.terminate(); }
    }
  });
  return {
    get terminated() { return terminated; },
    cleanup() { for (const worker of workers) void worker.terminate(); vi.unstubAllGlobals(); vi.restoreAllMocks(); },
  };
}
