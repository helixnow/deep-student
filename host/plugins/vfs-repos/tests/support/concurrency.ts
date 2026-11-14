/**
 * Run production repository calls on independent worker threads/connections.
 *
 * The Rust concurrency tests spawn real threads (one connection each) and
 * assert the exactly-one-winner invariants. This helper keeps that shape: every
 * job gets a `worker_threads` worker that opens its own database handle, and a
 * shared gate releases them together.
 */
import { Worker } from 'node:worker_threads';
import type { ConcurrencyJob } from './concurrency-worker.ts';

export type ConcurrentOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

interface WorkerMessage<T> {
  type: 'ready' | 'done';
  ok?: boolean;
  value?: T;
  message?: string;
}

/** 默认超出测试超时前主动失败，避免 worker 泄漏导致整个进程卡住。 */
const DEFAULT_TIMEOUT_MS = 120_000;

export function runConcurrent<T>(
  jobs: readonly ConcurrencyJob[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ConcurrentOutcome<T>[]> {
  if (jobs.length === 0) return Promise.resolve([]);

  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const gateView = new Int32Array(gate);
  const workers = jobs.map(job => new Worker(new URL('./concurrency-worker.ts', import.meta.url), {
    workerData: { ...job, gate },
  }));
  const outcomes: ConcurrentOutcome<T>[] = new Array(jobs.length);
  const jobSettled = new Array<boolean>(jobs.length).fill(false);
  let ready = 0;
  let done = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) {
        resolve(outcomes);
        return;
      }
      void Promise.all(workers.map(worker => worker.terminate()));
      reject(error);
    };

    const complete = (): void => {
      if (settled) return;
      // All results are reported; make sure no worker thread outlives the test
      // (lingering MessagePorts starve the Vitest worker RPC channel).
      void Promise.all(workers.map(worker => worker.terminate())).then(() => finish());
    };

    const timer = setTimeout(() => {
      finish(new Error(`concurrent workers did not finish within ${timeoutMs}ms`));
    }, timeoutMs);

    workers.forEach((worker, index) => {
      worker.on('message', (message: WorkerMessage<T>) => {
        if (message.type === 'ready') {
          ready += 1;
          if (ready === jobs.length) {
            Atomics.store(gateView, 0, 1);
            Atomics.notify(gateView, 0, jobs.length);
          }
          return;
        }
        if (message.type !== 'done') return;
        jobSettled[index] = true;
        if (message.ok === true) {
          outcomes[index] = { ok: true, value: message.value as T };
        } else {
          outcomes[index] = { ok: false, message: message.message ?? 'worker failed' };
        }
        done += 1;
        if (done === jobs.length) complete();
      });
      worker.once('error', error => finish(error instanceof Error ? error : new Error(String(error))));
      worker.once('exit', code => {
        // The 'exit' event can race the final 'message' delivery; only fail if
        // the job is still unsettled after queued messages have been drained.
        setImmediate(() => {
          if (!jobSettled[index]) {
            finish(new Error(`concurrent worker ${index} exited before reporting (code ${code})`));
          }
        });
      });
    });
  });
}
