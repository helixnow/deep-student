/**
 * Durable VFS index consumer, `src/lib.rs::start_vfs_index_worker` (3293-3455).
 *
 * SQLite owns pending/failed/retry state (`claim_pending_resources` applies
 * `max_retries` and `index_next_retry_at` backoff), so the loop keeps no job list:
 * an interrupted run resumes on the next tick or the next start.
 */
import type { IndexingConfig } from '../api.ts';
import type { LaneLogger } from './logger.ts';

const CONFIG_RETRY_MS = 5_000;
const MAX_WAIT_MS = 5_000;
const MIN_WAIT_MS = 100;
const UNCONFIGURED_LOG_INTERVAL_MS = 300_000;
const ORPHAN_DRAIN_LIMIT = 200;

export type IndexWorkerSleep = (ms: number, signal: AbortSignal) => Promise<void>;

export interface VfsIndexWorkerDeps {
  getConfig(): IndexingConfig;
  /** Rust only starts the worker with Lance compiled in and `VfsLanceStore` initialised. */
  lanceEnabled(): boolean;
  /** Rust databases in maintenance mode fail every borrow, so no batch can run. */
  startupMaintenance(): boolean;
  textEmbeddingConfigured(): Promise<boolean>;
  reviveConfigBlocked(): number;
  processTextBatch(batchSize: number): Promise<[number, number]>;
  prepareUnitsWithoutEmbedding(limit: number): number;
  drainLanceOrphanQueue(limit: number): Promise<number>;
  multimodalConfigured(): Promise<boolean>;
  processMultimodalBatch(batchSize: number): Promise<[number, number]>;
  maybeOptimizeAll(): Promise<number>;
  logger?: LaneLogger;
  now?: () => number;
  sleep?: IndexWorkerSleep;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const defaultIndexWorkerSleep: IndexWorkerSleep = (ms, signal) => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  timer.unref?.();
  const onAbort = (): void => { clearTimeout(timer); resolve(); };
  signal.addEventListener('abort', onAbort, { once: true });
});

export class VfsIndexWorker {
  private readonly deps: VfsIndexWorkerDeps;
  private readonly now: () => number;
  private readonly sleep: IndexWorkerSleep;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private tick: Promise<void> | null = null;
  private paused = 0;
  private wake: AbortController | null = null;
  private lastRun: number | null = null;
  private lastUnconfiguredLog: number | null = null;
  private embeddingWasConfigured: boolean | null = null;

  constructor(deps: VfsIndexWorkerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => performance.now());
    this.sleep = deps.sleep ?? defaultIndexWorkerSleep;
  }

  get running(): boolean { return this.loop !== null; }

  start(): void {
    if (this.loop !== null) return;
    const abort = new AbortController();
    this.abort = abort;
    this.loop = this.run(abort.signal).finally(() => {
      this.deps.logger?.info('[VfsIndexWorker] stopped');
    });
  }

  /** Stops the loop and waits for the in-flight batch. */
  async stop(): Promise<void> {
    const loop = this.loop;
    if (loop === null) return;
    this.abort?.abort();
    this.wake?.abort();
    await loop;
    this.loop = null;
    this.abort = null;
  }

  /** Maintenance barrier: no new batch starts; resolves once the in-flight batch ended. */
  async pause(deadline = Date.now() + 30_000): Promise<void> {
    this.paused += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.tick,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('VFS index worker maintenance drain timed out')), Math.max(0, deadline - Date.now()));
        }),
      ]);
    } catch (error) {
      this.resume();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  resume(): void {
    if (this.paused > 0) this.paused -= 1;
    if (this.paused === 0) this.wake?.abort();
  }

  private async wait(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const wake = new AbortController();
    this.wake = wake;
    const onAbort = (): void => wake.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try { await this.sleep(ms, wake.signal); }
    finally {
      signal.removeEventListener('abort', onAbort);
      if (this.wake === wake) this.wake = null;
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (this.paused > 0 || this.deps.startupMaintenance() || !this.deps.lanceEnabled()) {
        await this.wait(CONFIG_RETRY_MS, signal);
        continue;
      }
      let config: IndexingConfig;
      try {
        config = this.deps.getConfig();
      } catch (error) {
        this.deps.logger?.warn(`[VfsIndexWorker] Failed to load config: ${messageOf(error)}`);
        await this.wait(CONFIG_RETRY_MS, signal);
        continue;
      }
      const interval = Math.max(1, config.intervalSecs) * 1000;
      // A disabled worker must not derive its wait from an expired run.
      if (!config.enabled) {
        await this.wait(Math.min(interval, MAX_WAIT_MS), signal);
        continue;
      }
      const lastRun = this.lastRun;
      if (lastRun !== null && this.now() - lastRun < interval) {
        const remaining = Math.min(interval - (this.now() - lastRun), MAX_WAIT_MS);
        await this.wait(Math.max(remaining, MIN_WAIT_MS), signal);
        continue;
      }
      this.lastRun = this.now();
      const tick = this.runTick(config);
      this.tick = tick;
      try { await tick; }
      finally { if (this.tick === tick) this.tick = null; }
    }
  }

  private async runTick(config: IndexingConfig): Promise<void> {
    const { deps } = this;
    let textConfigured = false;
    try { textConfigured = await deps.textEmbeddingConfigured(); }
    catch { textConfigured = false; }
    if (textConfigured && this.embeddingWasConfigured !== true) {
      try {
        const revived = deps.reviveConfigBlocked();
        if (revived > 0) {
          deps.logger?.info(`[VfsIndexWorker] Embedding model available; revived ${revived} config-blocked resources`);
        }
      } catch (error) {
        deps.logger?.warn(`[VfsIndexWorker] Failed to revive config-blocked resources: ${messageOf(error)}`);
      }
    }
    this.embeddingWasConfigured = textConfigured;
    if (textConfigured) {
      this.lastUnconfiguredLog = null;
      try {
        const [success, failed] = await deps.processTextBatch(config.batchSize);
        if (success > 0 || failed > 0) {
          deps.logger?.info(`[VfsIndexWorker] text batch completed: success=${success}, failed=${failed}`);
        }
      } catch (error) {
        deps.logger?.warn(`[VfsIndexWorker] text batch failed: ${messageOf(error)}`);
      }
    } else {
      const now = this.now();
      if (this.lastUnconfiguredLog === null || now - this.lastUnconfiguredLog >= UNCONFIGURED_LOG_INTERVAL_MS) {
        deps.logger?.warn('[VfsIndexWorker] Text embedding model not configured; skipping text indexing batch. '
          + 'Set default in 嵌入维度管理 (or model_assignments.embedding_model_config_id).');
        this.lastUnconfiguredLog = now;
      }
      try { deps.prepareUnitsWithoutEmbedding(config.batchSize); }
      catch (error) { deps.logger?.warn(`[VfsIndexWorker] Preparing units without embedding failed: ${messageOf(error)}`); }
      try { await deps.drainLanceOrphanQueue(ORPHAN_DRAIN_LIMIT); }
      catch (error) { deps.logger?.warn(`[VfsIndexWorker] Orphan cleanup failed: ${messageOf(error)}`); }
    }

    let multimodal = false;
    try { multimodal = await deps.multimodalConfigured(); }
    catch { multimodal = false; }
    if (multimodal) {
      try {
        const [success, failed] = await deps.processMultimodalBatch(config.batchSize);
        if (success > 0 || failed > 0) {
          deps.logger?.info(`[VfsIndexWorker] multimodal batch completed: success=${success}, failed=${failed}`);
        }
      } catch (error) {
        deps.logger?.warn(`[VfsIndexWorker] multimodal batch failed: ${messageOf(error)}`);
      }
    }

    try {
      const optimized = await deps.maybeOptimizeAll();
      if (optimized > 0) deps.logger?.info(`[VfsIndexWorker] Lance auto-optimize completed: ${optimized} tables`);
    } catch (error) {
      deps.logger?.warn(`[VfsIndexWorker] Lance auto-optimize failed: ${messageOf(error)}`);
    }
  }
}
