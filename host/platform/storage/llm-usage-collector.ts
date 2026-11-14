/**
 * LLM usage 的待写队列（`llm_usage/mod.rs:44-75`）与后台 collector（`collector.rs`）：有界通道 + 5s / 50 条批量冲刷。
 */
import type { SqlExecutor } from './api.ts';
import { storageLog } from './logging.ts';
import { UsageRecordBuilder, type CallerType, type UsageRecord } from './llm-usage-models.ts';
import { errorMessage, INSERT_USAGE_SQL, insertParams, logCacheDebugUsage } from './llm-usage-repo.ts';

const LOG_TARGET = 'dstu_storage::llm_usage';

// ------------------------------------------------------------------ pending queue

export const MAX_PENDING_USAGE_RECORDS = 1000;

const pendingQueue: UsageRecord[] = [];

/** mod.rs:44 `enqueue_pending`：超出上限时丢弃最旧记录。 */
export function enqueuePending(record: UsageRecord): void {
  if (pendingQueue.length >= MAX_PENDING_USAGE_RECORDS) {
    pendingQueue.shift();
    storageLog(LOG_TARGET, 'warn', `[LLM Usage] Pending queue full (${MAX_PENDING_USAGE_RECORDS}), dropping oldest usage record`);
  }
  pendingQueue.push(record);
}

/** mod.rs:61 `flush_pending`。 */
export function flushPending(collector: UsageCollector): number {
  const drained = pendingQueue.splice(0, pendingQueue.length);
  for (const record of drained) collector.record(record);
  return drained.length;
}

export function pendingUsageQueue(): readonly UsageRecord[] {
  return pendingQueue;
}

export function clearPendingUsageQueue(): void {
  pendingQueue.length = 0;
}

// ------------------------------------------------------------------ collector

export const USAGE_CHANNEL_CAPACITY = 1000;
export const USAGE_BATCH_SIZE_THRESHOLD = 50;
export const USAGE_FLUSH_INTERVAL_MS = 5000;

type CollectorMessage =
  | { kind: 'record'; record: UsageRecord }
  | { kind: 'batch'; records: UsageRecord[] }
  | { kind: 'shutdown'; done: () => void };

export interface LlmUsageConnectionSource {
  getConnSafe(): SqlExecutor;
}

/** `UsageCollector::extract_provider`（collector.rs:396）。 */
export function extractProvider(modelId: string): string {
  const model = modelId.toLowerCase();
  if (model.startsWith('gpt-') || model.startsWith('o1')) return 'openai';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('deepseek')) return 'deepseek';
  if (model.startsWith('qwen')) return 'alibaba';
  if (model.startsWith('gemini')) return 'google';
  if (model.includes('llama') || model.includes('mistral')) return 'siliconflow';
  return 'unknown';
}

/** collector.rs:282 `insert_records`：单事务写入，任何一条失败整体回滚。 */
export function insertRecords(source: LlmUsageConnectionSource, records: readonly UsageRecord[]): void {
  const conn = source.getConnSafe();
  try { conn.run('BEGIN TRANSACTION'); }
  catch (error) { throw new Error(`Failed to begin transaction: ${errorMessage(error)}`); }
  for (const record of records) {
    try {
      conn.run(INSERT_USAGE_SQL, insertParams(record, record.providerId ?? extractProvider(record.modelId)));
    } catch (error) {
      try { conn.run('ROLLBACK'); }
      catch (rollbackError) {
        storageLog(LOG_TARGET, 'warn', `[UsageCollector::Background] 回滚失败: ${errorMessage(rollbackError)}`);
      }
      throw new Error(`Failed to insert record ${record.id}: ${errorMessage(error)}`);
    }
    logCacheDebugUsage(record);
  }
  try { conn.run('COMMIT'); }
  catch (error) { throw new Error(`Failed to commit transaction: ${errorMessage(error)}`); }
}

/** Non-blocking collector mirroring `UsageCollector` (collector.rs:73-260). */
export class UsageCollector {
  private readonly source: LlmUsageConnectionSource;
  private readonly messages: CollectorMessage[] = [];
  private buffer: UsageRecord[] = [];
  private lastFlush = Date.now();
  private shutdownFlag = false;
  private pumping = false;
  private scheduled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(source: LlmUsageConnectionSource) {
    this.source = source;
  }

  isShutdown(): boolean {
    return this.shutdownFlag;
  }

  /** `UsageCollector::record`（collector.rs:420）：channel full drops the record. */
  record(record: UsageRecord): void {
    if (this.shutdownFlag) {
      storageLog(LOG_TARGET, 'warn', `[UsageCollector] Collector is shutdown, dropping record: ${record.id}`);
      return;
    }
    if (this.messages.length >= USAGE_CHANNEL_CAPACITY) {
      storageLog(LOG_TARGET, 'warn', '[UsageCollector] Channel full (capacity 1000), dropping usage record');
      return;
    }
    this.messages.push({ kind: 'record', record });
    this.schedule();
  }

  /** `UsageCollector::record_batch`（collector.rs:451）：flush immediately. */
  recordBatch(records: UsageRecord[]): void {
    if (this.shutdownFlag) {
      storageLog(LOG_TARGET, 'warn', `[UsageCollector] Collector is shutdown, dropping ${records.length} records`);
      return;
    }
    if (records.length === 0) return;
    if (this.messages.length >= USAGE_CHANNEL_CAPACITY) {
      storageLog(LOG_TARGET, 'warn', `[UsageCollector] Channel full (capacity 1000), dropping ${records.length} batch records`);
      return;
    }
    this.messages.push({ kind: 'batch', records: [...records] });
    this.schedule();
  }

  /** `UsageCollector::record_from_api_response`（collector.rs:477）。 */
  recordFromApiResponse(
    callerType: CallerType,
    modelId: string,
    promptTokens: number,
    completionTokens: number,
    sessionId: string | null,
    durationMs: number | null,
    success: boolean,
    errorMessage: string | null,
  ): void {
    const builder = new UsageRecordBuilder(callerType, modelId, promptTokens, completionTokens);
    if (sessionId !== null) builder.withCallerId(sessionId);
    if (durationMs !== null) builder.withDuration(durationMs);
    if (!success) builder.withError(errorMessage ?? 'Unknown error');
    this.record(builder.build());
  }

  /** `UsageCollector::shutdown`（collector.rs:520）：flush then stop. */
  async shutdown(): Promise<void> {
    if (this.shutdownFlag) return;
    this.shutdownFlag = true;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        storageLog(LOG_TARGET, 'warn', '[UsageCollector] Shutdown flush timed out after 10000ms');
        resolve();
      }, 10_000);
      timer.unref?.();
      this.messages.push({
        kind: 'shutdown',
        done: () => { clearTimeout(timer); resolve(); },
      });
      this.schedule();
    });
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.messages.length > 0) {
        const message = this.messages.shift()!;
        if (message.kind === 'record') {
          this.buffer.push(message.record);
          const shouldFlush = this.buffer.length >= USAGE_BATCH_SIZE_THRESHOLD
            || Date.now() - this.lastFlush >= USAGE_FLUSH_INTERVAL_MS;
          if (shouldFlush) this.flush();
        } else if (message.kind === 'batch') {
          this.buffer.push(...message.records);
          this.flush();
        } else {
          this.flush();
          this.clearTimer();
          message.done();
        }
      }
      this.armTimer();
    } finally {
      this.pumping = false;
      if (this.messages.length > 0) this.schedule();
    }
  }

  private flush(): void {
    if (this.buffer.length === 0) {
      this.lastFlush = Date.now();
      return;
    }
    const records = this.buffer;
    this.buffer = [];
    this.lastFlush = Date.now();
    try {
      insertRecords(this.source, records);
    } catch (error) {
      storageLog(LOG_TARGET, 'error', `[UsageCollector::Background] Failed to insert ${records.length} records: ${errorMessage(error)}`);
    }
  }

  private armTimer(): void {
    if (this.shutdownFlag || this.buffer.length === 0 || this.timer !== undefined) return;
    const wait = Math.max(0, USAGE_FLUSH_INTERVAL_MS - (Date.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
      this.armTimer();
    }, wait);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
