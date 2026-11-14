/** 存储 spike 页面：按 Playwright 的请求启动 / 终止 spike Worker（崩溃恢复实验需要从主线程 terminate）。 */

type SpikeOp = 'spike' | 'crash-prepare' | 'crash-recover' | 'hold';
type JournalMode = 'truncate' | 'wal-exclusive';

interface SpikeApi {
  run(op: SpikeOp, options?: { rows?: number; mode?: JournalMode; keep?: boolean }): Promise<unknown>;
  releaseKept(): void;
  persist(): Promise<{ persisted: boolean | null; persistedBefore: boolean | null; estimate: StorageEstimate | null }>;
}

const kept: Worker[] = [];

const api: SpikeApi = {
  run(op, options = {}) {
    const worker = new Worker(new URL('./spike-worker.ts', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onerror = (event) => { worker.terminate(); reject(new Error(event.message)); };
      worker.onmessage = (event: MessageEvent<{ result: unknown }>) => {
        // 崩溃实验：不给 Worker 关闭连接的机会，直接终止；`keep` 让 Worker 继续持有 pool。
        if (options.keep) kept.push(worker);
        else worker.terminate();
        resolve(event.data.result);
      };
      worker.postMessage({ op, ...(options.rows ? { rows: options.rows } : {}), ...(options.mode ? { mode: options.mode } : {}) });
    });
  },
  releaseKept() {
    for (const worker of kept.splice(0)) worker.terminate();
  },
  async persist() {
    const storage = navigator.storage;
    const persistedBefore = typeof storage?.persisted === 'function' ? await storage.persisted() : null;
    const persisted = typeof storage?.persist === 'function' ? await storage.persist() : null;
    const estimate = typeof storage?.estimate === 'function' ? await storage.estimate() : null;
    return { persisted, persistedBefore, estimate };
  },
};

(globalThis as { __dstuSpike?: SpikeApi }).__dstuSpike = api;
document.body.dataset.ready = 'true';
