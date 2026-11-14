/**
 * R13-02 owner execution service: real worker_threads transport for todo,
 * pomodoro and the L11 resource searches.
 *
 * A persistent worker handles todo/pomodoro operations sequentially. Each
 * `runResourceSearch` uses a short-lived worker so the Rust `spawn_blocking`
 * fan-out (handlers.rs:843-922) can actually overlap instead of queueing on one
 * thread. The worker opens its own F3 handle; nothing is cloned across threads.
 *
 * `pauseAndDrain` is the maintenance seam requested by R13b/C2: it stops new
 * admissions, waits for accepted requests and short-lived searches, then closes
 * the worker connections. F3 must call it from `enterMaintenance` and call
 * `resume` after `release`; until F3 publishes that registration hook, a
 * backup/restore cannot consider worker connections frozen.
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import {
  VfsRepositoryError, vfsWorkerService, type JsonValue, type VfsWorkerFolderOperation, type VfsWorkerSearchType,
  type VfsWorkerService,
} from '../api.ts';
import { attachNumberAtoms, type DetachedAtom } from './worker-atoms.ts';
import { vfsReposLocalRuntime, type LocalWorkerHandle } from './local-runtime.ts';

type WorkerLogger = ReturnType<Context['logger']>;
type WorkerLogLevel = 'error' | 'warn' | 'info' | 'debug';

interface WorkerReady { type: 'ready'; threadId: number }
interface WorkerLog {
  type: 'log'; level: WorkerLogLevel; message: string;
}
interface WorkerFailure {
  name: string; message: string; code?: string; data?: unknown; stack?: string;
}
interface WorkerResponse {
  type: 'response'; id: number; ok: boolean; value?: unknown; atoms?: DetachedAtom[]; error?: WorkerFailure;
}
type WorkerMessage = WorkerReady | WorkerLog | WorkerResponse;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

const REQUEST_TIMEOUT_MS = 120_000;
const DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_POLL_MS = 10;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function reviveError(failure: WorkerFailure | undefined): Error {
  const message = failure?.message ?? 'vfs worker failed';
  if (failure?.code !== undefined) {
    const data = failure.data !== null && typeof failure.data === 'object'
      ? failure.data as Record<string, JsonValue> : undefined;
    return new VfsRepositoryError(failure.code, message, data);
  }
  const error = new Error(message);
  if (failure?.name !== undefined) error.name = failure.name;
  if (failure?.stack !== undefined) error.stack = failure.stack;
  return error;
}

export class VfsWorker extends Service implements VfsWorkerService {
  private readonly dbPath: string;
  private readonly deviceId: string;
  private readonly logger: WorkerLogger;
  private worker: LocalWorkerHandle | null = null;
  private readyThreadId = 0;
  private readyPromise: Promise<number> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly oneShots = new Set<LocalWorkerHandle>();
  /** Requests admitted before `pauseAndDrain` sets the gate; drained with pending. */
  private admissions = 0;
  private paused = false;
  private closing = false;

  constructor(ctx: Context, deviceId: string, dbPath: string) {
    super(ctx, vfsWorkerService.name);
    this.deviceId = deviceId;
    this.dbPath = dbPath;
    this.logger = ctx.logger('dstu_vfs::repos');
  }

  /** 线程实现由本地运行时端口注入：桌面是 `node:worker_threads`，移动端不可用（调用报错）。 */
  private spawn(): LocalWorkerHandle {
    return vfsReposLocalRuntime().spawnWorker({ dbPath: this.dbPath, deviceId: this.deviceId });
  }

  private ensureWorker(admitted = false): Promise<number> {
    if (this.closing) return Promise.reject(new Error('vfs worker is disposed'));
    if (this.paused && !admitted) return Promise.reject(new Error('vfs worker is paused for maintenance'));
    if (this.readyThreadId !== 0) return Promise.resolve(this.readyThreadId);
    if (this.readyPromise !== null) return this.readyPromise;
    let worker: LocalWorkerHandle;
    // 缺省端口（移动端）没有 worker：直接拒绝，不留下已拒绝的缓存 Promise。
    try { worker = this.spawn(); }
    catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    this.readyPromise = new Promise<number>((resolve, reject) => {
      this.worker = worker;
      let ready = false;
      worker.onMessage(raw => {
        const message = raw as WorkerMessage;
        if (message.type === 'ready') {
          ready = true;
          this.readyThreadId = message.threadId;
          resolve(message.threadId);
          return;
        }
        if (message.type === 'log') {
          this.forwardLog(message);
          return;
        }
        this.settle(message);
      });
      worker.onError(error => {
        if (!ready) reject(error);
        this.failAll(error);
        this.reset();
      });
      worker.onExit(code => {
        if (this.closing) return;
        const error = new Error(`vfs worker exited with code ${code}`);
        if (!ready) reject(error);
        this.failAll(error);
        this.reset();
      });
    });
    return this.readyPromise;
  }

  private forwardLog(message: WorkerLog): void {
    const method = this.logger[message.level];
    try {
      method.call(this.logger, message.message);
    } catch (error) {
      // Logging must never break task execution; mirror Rust's non-fatal log sink.
      this.logger.warn(`[VFS::Worker] failed to forward ${message.level} log: ${String(error)}`);
    }
  }

  private reset(): void {
    this.worker = null;
    this.readyThreadId = 0;
    this.readyPromise = null;
  }

  private settle(message: WorkerResponse): void {
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (pending.settled) return;
    if (message.ok) pending.resolve(attachNumberAtoms(message.value, message.atoms ?? []));
    else pending.reject(reviveError(message.error));
  }

  private failAll(error: unknown): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (!pending.settled) pending.reject(error);
    }
  }

  private async request<T>(repository: 'todo' | 'pomodoro' | 'folder', method: string,
    args: readonly unknown[]): Promise<T> {
    if (this.closing) throw new Error('vfs worker is disposed');
    if (this.paused) throw new Error('vfs worker is paused for maintenance');
    // Hold the admission until the request resolves/rejects (not merely until
    // the worker becomes ready) so a maintenance drain cannot slip between
    // `ensureWorker()` and `pending.set()` and close the connection under it.
    this.admissions += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.admissions -= 1;
    };
    let worker: LocalWorkerHandle | null;
    try {
      await this.ensureWorker(true);
      worker = this.worker;
    } catch (error) {
      release();
      throw error;
    }
    if (worker === null) {
      release();
      throw new Error('vfs worker is not available');
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(id);
        if (pending === undefined) return;
        pending.settled = true;
        pending.reject(new Error(
          `vfs worker operation timed out after ${REQUEST_TIMEOUT_MS}ms: ${repository}.${method}; ` +
          'the operation may still be running in the worker and was not cancelled'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: value => { release(); resolve(value as T); },
        reject: error => { release(); reject(error); },
        timer,
        settled: false,
      });
      try {
        worker.postMessage({ id, repository, method, args });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        release();
        reject(error);
      }
    });
  }

  runTodoOperation<T = unknown>(method: string, args: readonly unknown[] = []): Promise<T> {
    return this.request<T>('todo', method, args);
  }

  runPomodoroOperation<T = unknown>(method: string, args: readonly unknown[] = []): Promise<T> {
    return this.request<T>('pomodoro', method, args);
  }

  runFolderOperation<T = unknown>(method: VfsWorkerFolderOperation, args: readonly unknown[] = []): Promise<T> {
    return this.request<T>('folder', method, args);
  }

  runResourceSearch<T = unknown>(type: VfsWorkerSearchType, query: string, limit: number,
    offset = 0): Promise<T> {
    if (this.closing) return Promise.reject(new Error('vfs worker is disposed'));
    if (this.paused) return Promise.reject(new Error('vfs worker is paused for maintenance'));
    let spawned: LocalWorkerHandle;
    // 缺省端口（移动端）没有 worker：返回拒绝的 Promise，保持 async 形状。
    try { spawned = this.spawn(); }
    catch (error) { return Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    return new Promise<T>((resolve, reject) => {
      const worker = spawned;
      this.oneShots.add(worker);
      let settled = false;
      // `keepRunning` is used for timeout: the caller is rejected, but the
      // worker keeps running and stays tracked until it exits or maintenance
      // drains it, matching the Rust "not cancelled" timeout semantics.
      const finish = (error?: Error, value?: unknown, keepRunning = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Keep the worker in `oneShots` until its `exit` event so maintenance
        // drain waits for the connection to close, not merely for the response.
        if (!keepRunning) void worker.terminate();
        if (error === undefined) resolve(value as T);
        else reject(error);
      };
      const timer = setTimeout(() => finish(new Error(
        `vfs resource search timed out after ${REQUEST_TIMEOUT_MS}ms: ${type}; ` +
        'the search may still be running in the worker and was not cancelled'), undefined, true),
      REQUEST_TIMEOUT_MS);
      worker.onMessage(raw => {
        const message = raw as WorkerMessage;
        if (message.type === 'ready') {
          try {
            worker.postMessage({
              id: 1, repository: 'search', method: type, args: [query, limit, offset],
            });
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
          return;
        }
        if (message.type === 'log') {
          this.forwardLog(message);
          return;
        }
        if (!message.ok) finish(reviveError(message.error));
        else finish(undefined, attachNumberAtoms(message.value, message.atoms ?? []));
      });
      worker.onError(error => finish(error instanceof Error ? error : new Error(String(error))));
      worker.onExit(code => {
        this.oneShots.delete(worker);
        if (!settled) finish(new Error(`vfs search worker exited with code ${code}`));
      });
    });
  }

  workerThreadId(): Promise<number> {
    return this.ensureWorker();
  }

  async pauseAndDrain(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.closing) return;
    this.paused = true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.admissions === 0 && this.pending.size === 0 && this.oneShots.size === 0) break;
      await delay(DRAIN_POLL_MS);
    }
    const idle = this.admissions === 0 && this.pending.size === 0 && this.oneShots.size === 0;
    if (!idle) {
      this.failAll(new Error('vfs worker paused for maintenance before the operation completed'));
      const worker = this.worker;
      this.reset();
      if (worker !== null) void worker.terminate();
      const oneShots = [...this.oneShots];
      this.oneShots.clear();
      for (const oneShot of oneShots) void oneShot.terminate();
      throw new Error(`vfs worker maintenance drain timed out after ${timeoutMs}ms`);
    }
    const worker = this.worker;
    this.reset();
    if (worker !== null) await worker.terminate();
  }

  resume(): void {
    if (!this.closing) this.paused = false;
  }

  async dispose(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.paused = true;
    this.failAll(new Error('vfs worker is disposed'));
    const worker = this.worker;
    this.reset();
    const oneShots = [...this.oneShots];
    this.oneShots.clear();
    await Promise.all([
      ...(worker === null ? [] : [worker.terminate()]),
      ...oneShots.map(oneShot => oneShot.terminate()),
    ]);
  }
}
