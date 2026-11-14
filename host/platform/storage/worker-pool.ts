/**
 * Database worker execution seam (L13b R13-02).
 *
 * Rust runs synchronous SQLite transactions inside `tokio::task::spawn_blocking`
 * (`todo_handlers.rs:77-103`, `vfs/handlers.rs:843-922`). A Node `DatabaseHandle`
 * cannot be structured-cloned to another thread, so this module gives the owner
 * lane a small contract instead of a remote SQL channel:
 *
 * - the caller registers named task functions in a lane-owned module;
 * - each worker opens its **own** `createStorageService` / `DatabaseHandle`;
 * - the task receives `{ db, payload, threadId }` and calls its own repository
 *   functions (`vfsRepo` / `todoRepo`) with `db` as `SqlExecutor`;
 * - results and business `Err` payloads cross the thread boundary as data only.
 *
 * This proves the thread hop: `threadId` inside the task differs from the Host
 * main thread.  It does not accept SQL text from callers.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { CommandError } from '../../kernel/api.ts';
import {
  StorageError,
  type DatabaseHandle,
  type DatabaseName,
  type CoordinatedDatabaseName,
  type OpenFileOptions,
} from './api.ts';
import { storageLog, type StorageLogLevel } from './logging.ts';

export interface DatabaseWorkerTaskContext {
  /** 该 worker 线程内新打开的库句柄；任务结束即关闭。 */
  readonly db: DatabaseHandle;
  readonly payload: unknown;
  readonly threadId: number;
}

export type DatabaseWorkerTask = (context: DatabaseWorkerTaskContext) => unknown | Promise<unknown>;

/** 任务模块必须导出 `workerTasks: Record<string, DatabaseWorkerTask>`。 */
export type DatabaseWorkerTasks = Readonly<Record<string, DatabaseWorkerTask>>;

export interface MultiDatabaseWorkerTaskContext {
  readonly payload: unknown;
  readonly threadId: number;
  readonly activeDir: string;
  /** Routes worker logs to the parent Host logger without moving business work back. */
  log(target: string, level: StorageLogLevel, message: string): void;
  /** No mkdir, create, migrations or slot re-resolution. Missing => undefined; other failures throw. */
  openExisting(database: CoordinatedDatabaseName, options?: { readonly?: boolean }): DatabaseHandle | undefined;
  /**
   * Opens a task-owned SQLite file (e.g. a temporary APKG `collection.anki2`) in this worker with the
   * same defaults/errors as `StorageService.openFile` (`plain` profile, mustExist=false,
   * createParentDirs=true). Not added to the registered/long-lived databases; closed by `close`
   * or the task's finally. Never return the handle from the task.
   */
  openFile(path: string, options?: OpenFileOptions): DatabaseHandle;
  /** Optional early close (openExisting/openFile handles); every remaining handle closes in the task's finally. */
  close(database: DatabaseHandle): void;
}
export type MultiDatabaseWorkerTasks = Readonly<Record<string,
  (context: MultiDatabaseWorkerTaskContext) => unknown | Promise<unknown>>>;

export interface DatabaseWorkerPoolOptions {
  /** 与 `ctx.app.dataDir` 相同；worker 内重新解析活动槽。 */
  readonly baseDir: string;
  readonly dataLocalDir?: string;
  readonly migrationsDir?: string;
  /** lane 所有者模块（导出 `workerTasks`）；worker 只 import 此模块，不接受 SQL。 */
  readonly taskModule: string | URL;
  /** 可选任务白名单；未列出的名称在主线程直接拒绝。 */
  readonly tasks?: readonly string[];
  /** worker 线程数，默认 1（写事务在同一库上串行更接近 Rust 单连接）。 */
  readonly size?: number;
  /** 单次任务默认超时；默认 120s。 */
  readonly timeoutMs?: number;
}

export interface DatabaseWorkerRunOptions {
  readonly database: DatabaseName;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface MultiDatabaseWorkerRunOptions {
  /** Capture ctx.storage.locations.activeDir on the caller thread. */
  readonly activeDir: string;
  readonly databases: readonly CoordinatedDatabaseName[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
type WorkerRunOptions = DatabaseWorkerRunOptions | MultiDatabaseWorkerRunOptions;

export interface DatabaseWorkerPool {
  readonly size: number;
  /** 在 worker 线程执行任务；业务错误以 {@link CommandError}.value 原样返回。 */
  run<T = unknown>(task: string, payload: unknown, options: DatabaseWorkerRunOptions): Promise<T>;
  /** Calls module.multiDatabaseWorkerTasks; no implicit database is opened. */
  runWithDatabases<T = unknown>(task: string, payload: unknown, options: MultiDatabaseWorkerRunOptions): Promise<T>;
  /** 维护屏障：拒绝新任务、等待在途任务结束并终止全部 worker（关闭线程内连接）。 */
  pause(): Promise<void>;
  /** 维护结束：放行排队任务并按需重建 worker。 */
  resume(): void;
  close(): Promise<void>;
}

type WorkerRequest = {
  readonly id: number;
  readonly task: string;
  readonly payload: unknown;
} & ({ readonly database: DatabaseName } | {
  readonly activeDir: string;
  readonly databases: readonly CoordinatedDatabaseName[];
});

interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly value?: unknown;
  readonly code?: unknown;
  readonly data?: unknown;
  readonly details?: unknown;
  readonly detail?: unknown;
  readonly traceId?: unknown;
  readonly sqliteCode?: unknown;
  readonly database?: unknown;
  readonly phase?: unknown;
}

interface WorkerReply {
  readonly id: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: SerializedError;
  readonly threadId?: number;
}

export interface WorkerLogMessage {
  readonly kind: 'log';
  readonly target: string;
  readonly level: StorageLogLevel;
  readonly message: string;
}

export type { WorkerRequest, WorkerReply };

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

interface Waiter {
  readonly resolve: (slot: WorkerSlot) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

interface QueuedTask {
  readonly task: string;
  readonly payload: unknown;
  readonly options: WorkerRunOptions;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
}

let nextPoolId = 1;

class WorkerSlot {
  readonly worker: Worker;
  readonly poolId: number;
  readonly pending = new Map<number, Pending>();
  busy = false;
  seq = 0;
  dead = false;

  constructor(data: { tasksModule: string; baseDir: string; dataLocalDir?: string; migrationsDir?: string }) {
    this.poolId = nextPoolId++;
    this.worker = new Worker(new URL('./worker-entry.ts', import.meta.url), {
      workerData: data,
      // Task results/errors are plain JSON; never transfer SQLite handles.
      resourceLimits: { maxOldGenerationSizeMb: 512 },
    });
  }
}

function moduleUrl(specifier: string | URL): string {
  if (specifier instanceof URL) return specifier.href;
  if (specifier.startsWith('file:') || specifier.startsWith('data:')) return specifier;
  return pathToFileURL(path.resolve(specifier)).href;
}

function serializeError(error: unknown): SerializedError {
  if (typeof error === 'string') return { name: 'Error', message: error, value: error };
  if (error instanceof Error) {
    const extra = error as Error & Record<string, unknown>;
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(extra.value === undefined ? {} : { value: extra.value }),
      ...(extra.code === undefined ? {} : { code: extra.code }),
      ...(extra.data === undefined ? {} : { data: extra.data }),
      ...(extra.details === undefined ? {} : { details: extra.details }),
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
      ...(extra.traceId === undefined ? {} : { traceId: extra.traceId }),
      ...(extra.sqliteCode === undefined ? {} : { sqliteCode: extra.sqliteCode }),
      ...(extra.database === undefined ? {} : { database: extra.database }),
      ...(extra.phase === undefined ? {} : { phase: extra.phase }),
    };
  }
  return { name: 'Error', message: String(error), value: error };
}

/** 业务 Err 走 `CommandError.value`，与同线程命令层完全一致；其余错误保留名称/栈/附加字段。 */
function deserializeError(serialized: SerializedError): unknown {
  if (serialized.value !== undefined) return new CommandError(serialized.value);
  const error = new Error(serialized.message);
  error.name = serialized.name;
  if (serialized.stack !== undefined) error.stack = serialized.stack;
  const extra = error as Error & Record<string, unknown>;
  if (serialized.code !== undefined) extra.code = serialized.code;
  if (serialized.data !== undefined) extra.data = serialized.data;
  if (serialized.details !== undefined) extra.details = serialized.details;
  if (serialized.detail !== undefined) extra.detail = serialized.detail;
  if (serialized.traceId !== undefined) extra.traceId = serialized.traceId;
  if (serialized.sqliteCode !== undefined) extra.sqliteCode = serialized.sqliteCode;
  if (serialized.database !== undefined) extra.database = serialized.database;
  if (serialized.phase !== undefined) extra.phase = serialized.phase;
  return error;
}

class DatabaseWorkerPoolImpl implements DatabaseWorkerPool {
  readonly size: number;
  private readonly options: DatabaseWorkerPoolOptions;
  private readonly tasks: Set<string> | undefined;
  private readonly slots: WorkerSlot[] = [];
  private readonly waiters: QueuedTask[] = [];
  private readonly resumeWaiters: Waiter[] = [];
  private readonly drainWaiters: Array<() => void> = [];
  private paused = false;
  private active = 0;
  private closing = false;
  private pausing: Promise<void> | undefined;

  constructor(options: DatabaseWorkerPoolOptions) {
    const size = options.size ?? 1;
    if (!Number.isInteger(size) || size < 1) throw new StorageError('INVALID_PARAM', `worker pool size must be >= 1, got ${size}`);
    this.options = options;
    this.size = size;
    this.tasks = options.tasks === undefined ? undefined : new Set(options.tasks);
  }

  run<T = unknown>(task: string, payload: unknown, options: DatabaseWorkerRunOptions): Promise<T> {
    return this.execute(task, payload, options) as Promise<T>;
  }

  runWithDatabases<T = unknown>(task: string, payload: unknown, options: MultiDatabaseWorkerRunOptions): Promise<T> {
    return this.execute(task, payload, options) as Promise<T>;
  }

  private execute(task: string, payload: unknown, options: WorkerRunOptions): Promise<unknown> {
    if (this.closing) return Promise.reject(new StorageError('TX_CLOSED', 'database worker pool is closed'));
    if (this.tasks !== undefined && !this.tasks.has(task)) {
      return Promise.reject(new StorageError('INVALID_PARAM', `unknown database worker task: ${task}`));
    }
    if (options.signal?.aborted === true) return Promise.reject(abortError(options.signal));
    if (this.paused) {
      return this.waitForResume(options.signal).then(() => this.execute(task, payload, options));
    }
    // 同步轮次内完成“未暂停 → 占槽/入队”：pause 不会在 await 间隙把刚获准的
    // 任务误判为未在途，也不会让暂停期间新到的任务插队启动。
    const slot = this.reserve();
    if (slot !== undefined) return this.startOn(slot, task, payload, options);
    return this.enqueue(task, payload, options);
  }

  private reserve(): WorkerSlot | undefined {
    const idle = this.slots.find((slot) => !slot.busy && !slot.dead);
    if (idle !== undefined) {
      idle.busy = true;
      return idle;
    }
    if (this.slots.length < this.size) {
      const slot = this.spawn();
      slot.busy = true;
      return slot;
    }
    return undefined;
  }

  private enqueue(task: string, payload: unknown, options: WorkerRunOptions): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const waiter: QueuedTask = {
        task, payload, options, resolve, reject,
        signal: options.signal,
        onAbort: undefined,
      };
      if (options.signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(abortError(options.signal!));
        };
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  /** 任务已实际分配到槽位；只有这些任务算“在途”，pause 需要等它们结束。 */
  private startOn(slot: WorkerSlot, task: string, payload: unknown, options: WorkerRunOptions): Promise<unknown> {
    this.active += 1;
    return this.send(slot, task, payload, options).finally(() => {
      this.active -= 1;
      if (this.active === 0) {
        for (const resolve of this.drainWaiters.splice(0)) resolve();
      }
    });
  }

  private waitForResume(signal?: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve();
    if (signal?.aborted === true) return Promise.reject(abortError(signal));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => { resolve(); },
        reject,
        signal,
        onAbort: undefined,
      };
      if (signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.resumeWaiters.indexOf(waiter);
          if (index >= 0) this.resumeWaiters.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.resumeWaiters.push(waiter);
    });
  }

  pause(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.pausing !== undefined) return this.pausing;
    this.paused = true;
    this.pausing = this.drainAndTerminate().finally(() => {
      this.pausing = undefined;
    });
    return this.pausing;
  }

  private async drainAndTerminate(): Promise<void> {
    if (this.active > 0) {
      await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
    }
    if (this.closing) return;
    const slots = [...this.slots];
    for (const slot of slots) {
      slot.dead = true;
      await slot.worker.terminate().catch(() => undefined);
    }
    for (const slot of slots) {
      const index = this.slots.indexOf(slot);
      if (index >= 0) this.slots.splice(index, 1);
    }
  }

  resume(): void {
    if (!this.paused || this.closing) return;
    if (this.pausing !== undefined) {
      // pause 还在 drain：等它完成后再放行，避免“暂停中又启动新 worker”。
      void this.pausing.then(() => this.resume());
      return;
    }
    this.paused = false;
    // 暂停前已入队的任务先拿槽位；resume 时新进入 run() 的任务排在其后。
    this.dispatchWaiters();
    for (const waiter of this.resumeWaiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.resolve(undefined as unknown as WorkerSlot);
    }
  }

  private send(slot: WorkerSlot, task: string, payload: unknown, options: WorkerRunOptions): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = ++slot.seq;
      const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 120_000;
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.settle(slot, id, () => reject(new StorageError(
            'SQLITE',
            `database worker task "${task}" timed out after ${timeoutMs}ms`,
            { sqliteCode: 'SQLITE_BUSY' },
          )));
          void this.kill(slot, new StorageError('SQLITE', `database worker task "${task}" timed out`));
        }, timeoutMs)
        : undefined;
      timer?.unref?.();

      const onAbort = options.signal === undefined ? undefined : () => {
        this.settle(slot, id, () => reject(abortError(options.signal!)));
        void this.kill(slot, abortError(options.signal!));
      };
      options.signal?.addEventListener('abort', onAbort!, { once: true });

      slot.pending.set(id, { resolve, reject, timer, signal: options.signal, onAbort });
      slot.worker.postMessage({
        id, task, payload,
        ...('database' in options
          ? { database: options.database }
          : { activeDir: options.activeDir, databases: options.databases }),
      } satisfies WorkerRequest);
    });
  }

  handleMessage(slot: WorkerSlot, reply: WorkerReply): void {
    const pending = slot.pending.get(reply.id);
    if (pending === undefined) return;
    slot.pending.delete(reply.id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(deserializeError(reply.error ?? { name: 'Error', message: 'unknown worker error' }));
    this.release(slot);
  }

  private release(slot: WorkerSlot): void {
    slot.busy = false;
    if (!this.paused) this.dispatchWaiters();
  }

  private dispatchWaiters(): void {
    if (this.paused || this.closing) return;
    while (this.waiters.length > 0) {
      const slot = this.reserve();
      if (slot === undefined) return;
      const waiter = this.waiters.shift()!;
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      this.startOn(slot, waiter.task, waiter.payload, waiter.options)
        .then(waiter.resolve, waiter.reject);
    }
  }

  private spawn(): WorkerSlot {
    const slot = new WorkerSlot({
      tasksModule: moduleUrl(this.options.taskModule),
      baseDir: this.options.baseDir,
      ...(this.options.dataLocalDir === undefined ? {} : { dataLocalDir: this.options.dataLocalDir }),
      ...(this.options.migrationsDir === undefined ? {} : { migrationsDir: this.options.migrationsDir }),
    });
    this.slots.push(slot);
    slot.worker.on('message', (message: WorkerReply | WorkerLogMessage) => {
      if ('kind' in message) storageLog(message.target, message.level, message.message);
      else this.handleMessage(slot, message);
    });
    slot.worker.on('error', (error) => this.failSlot(slot, error));
    slot.worker.on('exit', (code) => {
      if (code !== 0 && !this.closing) this.failSlot(slot, new StorageError('TX_CLOSED', `database worker exited with code ${code}`));
      else this.removeSlot(slot);
    });
    return slot;
  }

  private failSlot(slot: WorkerSlot, error: unknown): void {
    if (slot.dead) return;
    slot.dead = true;
    storageLog('dstu_storage::worker', 'error', `database worker failed: ${error instanceof Error ? error.message : String(error)}`);
    for (const [id, pending] of slot.pending) {
      this.settle(slot, id, () => pending.reject(error));
    }
    this.removeSlot(slot);
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(error);
    }
  }

  private settle(slot: WorkerSlot, id: number, reject: () => void): void {
    const pending = slot.pending.get(id);
    if (pending === undefined) return;
    slot.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    if (pending.signal !== undefined && pending.onAbort !== undefined) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    reject();
  }

  private removeSlot(slot: WorkerSlot): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    slot.dead = true;
  }

  private async kill(slot: WorkerSlot, error: unknown): Promise<void> {
    slot.dead = true;
    await slot.worker.terminate().catch(() => undefined);
    this.failSlot(slot, error);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.paused = false;
    for (const waiter of this.resumeWaiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(new StorageError('TX_CLOSED', 'database worker pool is closed'));
    }
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      waiter.reject(new StorageError('TX_CLOSED', 'database worker pool is closed'));
    }
    await Promise.all(this.slots.map(async (slot) => {
      slot.dead = true;
      for (const [id, pending] of slot.pending) {
        this.settle(slot, id, () => pending.reject(new StorageError('TX_CLOSED', 'database worker pool is closed')));
      }
      await slot.worker.terminate().catch(() => undefined);
    }));
    this.slots.length = 0;
  }
}

function abortError(signal: AbortSignal): StorageError {
  return new StorageError('ABORTED', 'database worker task aborted', { cause: signal.reason });
}

/** 创建一个仅供存储所有者使用的 worker 任务池；调用方负责在插件卸载时 `close()`。 */
export function createDatabaseWorkerPool(options: DatabaseWorkerPoolOptions): DatabaseWorkerPool {
  return new DatabaseWorkerPoolImpl(options);
}

/** worker 入口与任务模块共用的序列化器；也便于 L13b 在自测中复用同一错误形状。 */
export { serializeError, deserializeError };
export type { SerializedError };
