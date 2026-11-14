/**
 * Bounded `worker_threads` pool for CPU-heavy skill ZIP work.
 *
 * Rust runs tap scan/repack/export, market GitHub-handoff repack,
 * update-from-source repack and package scanning through `spawn_blocking`
 * (`skill_taps.rs:473-475,533-537,762`, `skill_market_client.rs:584-588`,
 * `skill_updates.rs:170-174`, `skills.rs` installer).
 * The Host must not run 64 MiB inflate/deflate on its event loop, otherwise one
 * skill operation blocks commands, cancellation and timers for every session.
 *
 * The platform worker pool promised by the migration README is not published
 * yet, so this lane owns a small bounded pool. Jobs carry their own task name;
 * the worker stays free of Cordis/platform services and can be replaced by a
 * platform pool later without changing call sites.
 */
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

export type ZipTask =
  | 'scanRepoZip'
  | 'repackSkillSubdir'
  | 'scanSkillPackage'
  | 'exportTap';

/**
 * A failure of the worker transport itself: spawn, postMessage, a worker
 * `error`/`exit`, or the pool becoming unavailable. Rust surfaces the
 * corresponding `spawn_blocking` join failure as `ChatV2Error::IoError`
 * (`skill_taps.rs:473-475,533-537`, `skills.rs:2158-2161`), not as an invalid
 * ZIP. ZIP content failures are ordinary task errors and keep InvalidInput.
 */
export class ZipWorkerInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipWorkerInfrastructureError';
  }
}

function asInfrastructureError(error: unknown): ZipWorkerInfrastructureError {
  if (error instanceof ZipWorkerInfrastructureError) return error;
  return new ZipWorkerInfrastructureError(error instanceof Error ? error.message : String(error));
}

export function isZipWorkerInfrastructureError(error: unknown): boolean {
  return error instanceof ZipWorkerInfrastructureError
    || (error instanceof Error && error.name === 'ZipWorkerInfrastructureError');
}

interface Job {
  id: number;
  task: ZipTask;
  payload: Record<string, unknown>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  name?: string;
}

const POOL_SIZE = Math.max(1, Math.min(2, availableParallelism()));
const IDLE_TIMEOUT_MS = 5_000;

class ZipWorkerPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  run<T>(task: ZipTask, payload: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        task,
        payload,
        resolve: value => resolve(value as T),
        reject,
      };
      try {
        if (!this.dispatch(job)) this.queue.push(job);
      } catch (error) {
        reject(asInfrastructureError(error));
      }
    });
  }

  private dispatch(job: Job): boolean {
    const idle = this.slots.find(slot => slot.job === null);
    if (idle !== undefined) {
      this.start(idle, job);
      return true;
    }
    if (this.slots.length >= POOL_SIZE) return false;
    this.start(this.spawn(), job);
    return true;
  }

  private spawn(): Slot {
    const worker = new Worker(new URL('./zip-worker.ts', import.meta.url));
    const slot: Slot = { worker, job: null };
    worker.on('message', (reply: WorkerReply) => this.onMessage(slot, reply));
    worker.on('error', (error: Error) => {
      this.onFailure(slot, new ZipWorkerInfrastructureError(`zip worker failed: ${error.message}`));
    });
    worker.on('exit', code => {
      if (slot.job !== null) {
        this.onFailure(slot, new ZipWorkerInfrastructureError(
          `zip worker exited unexpectedly with code ${code}`,
        ));
      }
      this.remove(slot);
    });
    this.slots.push(slot);
    return slot;
  }

  private start(slot: Slot, job: Job): void {
    slot.job = job;
    this.clearIdleTimer();
    try {
      slot.worker.postMessage({ id: job.id, task: job.task, payload: job.payload });
    } catch (error) {
      this.onFailure(slot, asInfrastructureError(error));
    }
  }

  private onMessage(slot: Slot, reply: WorkerReply): void {
    const job = slot.job;
    if (job === null || reply.id !== job.id) {
      this.warn(`unexpected zip worker reply id ${reply.id}`);
      return;
    }
    slot.job = null;
    if (reply.ok) job.resolve(reply.result);
    else {
      const error = new Error(reply.error ?? 'zip worker task failed');
      if (reply.name !== undefined && reply.name !== '') error.name = reply.name;
      job.reject(error);
    }
    this.drain();
  }

  private onFailure(slot: Slot, error: Error): void {
    const job = slot.job;
    slot.job = null;
    if (job !== null) job.reject(error);
    this.remove(slot);
    this.drain();
  }

  private remove(slot: Slot): void {
    const index = this.slots.indexOf(slot);
    if (index >= 0) this.slots.splice(index, 1);
    void slot.worker.terminate();
    if (this.slots.length === 0) {
      for (const job of this.queue.splice(0)) {
        job.reject(new ZipWorkerInfrastructureError('zip worker pool unavailable'));
      }
    }
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      try {
        if (!this.dispatch(job)) {
          this.queue.unshift(job);
          break;
        }
      } catch (error) {
        job.reject(asInfrastructureError(error));
      }
    }
    if (this.queue.length === 0 && this.slots.every(slot => slot.job === null)) this.scheduleIdleStop();
  }

  /** Terminates the idle workers now; busy ones finish their job and stop on the idle timer. */
  async stopIdle(): Promise<number> {
    const idle = this.slots.filter(slot => slot.job === null);
    if (idle.length === 0) return 0;
    if (idle.length === this.slots.length) this.clearIdleTimer();
    for (const slot of idle) this.slots.splice(this.slots.indexOf(slot), 1);
    await Promise.all(idle.map(slot => slot.worker.terminate()));
    return idle.length;
  }

  private scheduleIdleStop(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      for (const slot of this.slots.splice(0)) {
        if (slot.job === null) void slot.worker.terminate();
        else this.slots.push(slot);
      }
      this.idleTimer = undefined;
    }, IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer === undefined) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private warn(message: string): void {
    process.emitWarning(`[agent-skills] ${message}`);
  }
}

const POOL_KEY = Symbol.for('dstu.agent-skills.zip-worker-pool');
const globalWithPool = globalThis as typeof globalThis & { [POOL_KEY]?: ZipWorkerPool };
const pool = globalWithPool[POOL_KEY] ?? new ZipWorkerPool();
globalWithPool[POOL_KEY] = pool;

export function runZipTask<T>(task: ZipTask, payload: Record<string, unknown>): Promise<T> {
  return pool.run<T>(task, payload);
}

/** The pool is process-wide and outlives a plugin instance; unloading releases the idle workers it left. */
export function stopIdleZipWorkers(): Promise<number> {
  return pool.stopIdle();
}
