/**
 * chat_v2/pipeline/compaction/memory_flush.rs:570–735 — recovery scheduling around the
 * memory-flush ledger. Shared state mirrors ChatV2Pipeline's `memory_flush_recovery_running`
 * and `memory_flush_next_retry_at_ms` (pipeline.rs:271–273,327–328): one instance per pipeline.
 */
import type { Context } from '@deepseek-ai/cordis';
import { ChatV2Error } from '../../chat/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { hasClaimableMemoryFlushWithConn, MEMORY_FLUSH_RETRY_BACKOFF_MS } from '../repository/memory-flush.ts';
import { errorMessage } from './tool-loop.ts';

export interface MemoryFlushRecoveryDependencies {
  /** ChatV2Database::get_conn_safe */
  connection(): SqlExecutor;
  log: Pick<Context['logger'], 'warn'>;
  /**
   * memory_flush.rs:637–733, reached only after the claimable preflight succeeds.
   * Returns Rust's `processed == MEMORY_FLUSH_DRAIN_BATCH_SIZE` continuation flag.
   */
  drainClaimable(sessionId: string | null): Promise<boolean>;
}

export class MemoryFlushRecovery {
  private running = false;
  private nextRetryAtMs = 0;
  private readonly deps: MemoryFlushRecoveryDependencies;
  constructor(deps: MemoryFlushRecoveryDependencies) { this.deps = deps; }

  /** memory_flush.rs:572 schedule_memory_flush_recovery (non-blocking, shared backoff). */
  scheduleRecovery(): void {
    if (this.running || Date.now() < this.nextRetryAtMs) return;
    this.spawn();
  }

  /** lib.rs:1561–1564: spawned startup pass, no backoff check. */
  spawn(): void {
    void Promise.resolve().then(() => this.recoverPending());
  }

  /** memory_flush.rs:587 recover_pending_memory_flushes */
  recoverPending(): Promise<void> {
    return this.flushPendingSegments(null);
  }

  /** memory_flush.rs:591 flush_pending_memory_segments */
  async flushPendingSegments(sessionId: string | null): Promise<void> {
    if (this.running) return;
    this.running = true;
    let shouldContinue: boolean;
    try {
      shouldContinue = await this.guarded(sessionId);
      this.nextRetryAtMs = Date.now() + MEMORY_FLUSH_RETRY_BACKOFF_MS;
    } finally {
      this.running = false;
    }
    if (shouldContinue) {
      this.nextRetryAtMs = 0;
      this.scheduleRecovery();
    }
  }

  /** memory_flush.rs:618–635 preflight; ensures the ledger before any VFS/LLM work. */
  private async guarded(sessionId: string | null): Promise<boolean> {
    let claimable: boolean;
    try {
      claimable = hasClaimableMemoryFlushWithConn(this.deps.connection(), sessionId, Date.now());
    } catch (error) {
      const display = error instanceof ChatV2Error ? error.message : new ChatV2Error('Database', errorMessage(error)).message;
      this.deps.log.warn(`[compaction] pending memory flush preflight failed: ${display}`);
      return false;
    }
    if (!claimable) return false;
    return this.deps.drainClaimable(sessionId);
  }
}
