/**
 * LLM usage statistics (dstu-storage/src/llm_usage/*). This file is `mod.rs` (the unified record entry);
 * `models.rs` lives in llm-usage-models.ts, `repo.rs` + `database.rs` in llm-usage-repo.ts, the pending
 * queue and `collector.rs` in llm-usage-collector.ts. Everything is re-exported from here.
 */
import { storageLog } from './logging.ts';
import { UsageRecordBuilder, type CallerType, type UsageRecord } from './llm-usage-models.ts';
import { enqueuePending, flushPending, type UsageCollector } from './llm-usage-collector.ts';

export * from './llm-usage-models.ts';
export * from './llm-usage-collector.ts';
export {
  cacheDebugEnabled,
  cacheDebugUsageLine,
  deleteOldRecords,
  getDailySummary,
  getPriceCoverage,
  getRecentPriceCoverage,
  getRecentUsage,
  getRecentUsagePage,
  getSchemaVersion,
  getSessionUsage,
  getStatistics,
  getUsageByCaller,
  getUsageByModel,
  getUsageSummary,
  getUsageTrends,
  inferProvider,
  insertUsage,
  insertUsageBatch,
  isForeignKeysEnabled,
  LLM_USAGE_SCHEMA_VERSION,
  logCacheDebugUsage,
  setCacheDebugSource,
  type LlmUsageDatabaseStats,
  type PriceCoverageDimension,
  type PriceCoverageStat,
} from './llm-usage-repo.ts';

const LOG_TARGET = 'dstu_storage::llm_usage';

// ------------------------------------------------------------------ unified record entry (mod.rs:78-340)

/** mod.rs:217 `UsageStreamIdentity`: session / variant / run 分列（null = 未知）。 */
export interface UsageStreamIdentity {
  sessionId: string | null;
  variantId: string | null;
  runId: string | null;
}

/** Rust 参数列表的对象形（Option → `null`，u32/u64 → number）。 */
export interface LlmUsageCall {
  callerType: CallerType;
  model: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  durationMs: number | null;
  success: boolean;
  errorMessage: string | null;
}

export interface LlmUsageExtCall extends LlmUsageCall {
  adapter: string | null;
  tokenSource: string | null;
}

export interface LlmUsageCacheExtCall extends LlmUsageExtCall {
  cacheWriteTokens: number | null;
}

export interface LlmUsageCacheExtIdentityCall extends LlmUsageCacheExtCall, UsageStreamIdentity {}

/** 当前进程的 collector 来源（Rust: `APP_HANDLE` + `try_state::<Arc<UsageCollector>>()`）。 */
export type UsageCollectorSource = () => UsageCollector | null;

/** mod.rs:78 `record_usage_record`：collector 可用时先冲刷待写队列；不可用时入队并 warn。 */
export function recordUsageRecord(collectorSource: UsageCollectorSource, record: UsageRecord): void {
  const collector = collectorSource();
  if (collector === null) {
    enqueuePending(record);
    storageLog(LOG_TARGET, 'warn',
      `[LLM Usage] UsageCollector 未初始化，已缓存记录: model=${record.modelId}, tokens=${record.promptTokens}+${record.completionTokens}`);
    return;
  }
  const flushed = flushPending(collector);
  if (flushed > 0) {
    storageLog(LOG_TARGET, 'info', `[LLM Usage] Flushed ${flushed} pending usage records before writing current record`);
  }
  collector.record(record);
  storageLog(LOG_TARGET, 'debug', '[LLM Usage] 使用量记录成功');
}

const debugOption = (value: string | number | null): string =>
  value === null ? 'None' : typeof value === 'string' ? `Some(${JSON.stringify(value)})` : `Some(${value})`;

/** mod.rs:252 `record_llm_usage_cache_ext_with_identity`。 */
export function recordLlmUsageCacheExtWithIdentity(collectorSource: UsageCollectorSource, call: LlmUsageCacheExtIdentityCall): void {
  storageLog(LOG_TARGET, 'debug',
    `[LLM Usage] 记录使用量: model=${call.model}, prompt=${call.promptTokens}, completion=${call.completionTokens}, `
    + `reasoning=${debugOption(call.reasoningTokens)}, cached=${debugOption(call.cachedTokens)}, cache_write=${debugOption(call.cacheWriteTokens)}, `
    + `success=${call.success}, adapter=${debugOption(call.adapter)}, token_source=${debugOption(call.tokenSource)}, `
    + `session=${debugOption(call.sessionId)}, variant=${debugOption(call.variantId)}, run=${debugOption(call.runId)}`);
  const builder = new UsageRecordBuilder(call.callerType, call.model, call.promptTokens, call.completionTokens);
  if (call.reasoningTokens !== null) builder.withReasoningTokens(call.reasoningTokens);
  if (call.cachedTokens !== null) builder.withCachedTokens(call.cachedTokens);
  if (call.cacheWriteTokens !== null) builder.withCacheWriteTokens(call.cacheWriteTokens);
  if (call.sessionId !== null) builder.withCallerId(call.sessionId);
  if (call.variantId !== null) builder.withVariantId(call.variantId);
  if (call.runId !== null) builder.withRunId(call.runId);
  if (call.durationMs !== null) builder.withDuration(call.durationMs);
  if (call.adapter !== null) builder.withAdapter(call.adapter);
  if (call.tokenSource !== null) builder.withTokenSource(call.tokenSource);
  if (!call.success) builder.withError(call.errorMessage ?? 'Unknown error');
  recordUsageRecord(collectorSource, builder.build());
}

/** mod.rs:195 `record_llm_usage_cache_ext`：只带 session 维度（variant/run = None）。 */
export function recordLlmUsageCacheExt(collectorSource: UsageCollectorSource, call: LlmUsageCacheExtCall & { sessionId: string | null }): void {
  recordLlmUsageCacheExtWithIdentity(collectorSource, { ...call, variantId: null, runId: null });
}

/** mod.rs:160 `record_llm_usage_ext`：cache_write = None。 */
export function recordLlmUsageExt(collectorSource: UsageCollectorSource, call: LlmUsageExtCall & { sessionId: string | null }): void {
  recordLlmUsageCacheExt(collectorSource, { ...call, cacheWriteTokens: null });
}

/** mod.rs:126 `record_llm_usage`：adapter / token_source = None。 */
export function recordLlmUsage(collectorSource: UsageCollectorSource, call: LlmUsageCall & { sessionId: string | null }): void {
  recordLlmUsageExt(collectorSource, { ...call, adapter: null, tokenSource: null });
}
