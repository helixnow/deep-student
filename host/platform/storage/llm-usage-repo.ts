/**
 * LLM usage 的查询与写入（`dstu-storage/src/llm_usage/repo.rs`，SQL 原样）与 `database.rs` 的统计辅助。
 */
import type { SqlExecutor, SqlParam } from './api.ts';
import { storageLog } from './logging.ts';
import { canonicalRfc3339Z, parseRfc3339Millis, rfc3339DateBoundary, rfc3339NowZ, rfc3339ZFromMillis } from './time.ts';
import {
  callerTypeDisplayName,
  callerTypeFromStr,
  callerTypeToString,
  computeUsageAverages,
  type CallerTypeSummary,
  type DailySummary,
  type ModelSummary,
  type SessionUsageSummary,
  type TimeGranularity,
  type UsageRecord,
  type UsageSummary,
  type UsageTrendPoint,
} from './llm-usage-models.ts';

const LOG_TARGET = 'dstu_storage::llm_usage';

function optional<T>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

function num(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : (value as number);
}

function optionalNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return num(value);
}

function text(value: unknown): string {
  return String(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `parse_rfc3339_utc` then serde's `DateTime<Utc>` (`Z`, AutoSi). */
function timestampOrNull(value: unknown): string | null {
  return typeof value === 'string' ? canonicalRfc3339Z(value) : null;
}

/** `LlmUsageRepo::infer_provider`（repo.rs:124）。 */
export function inferProvider(modelId: string): string {
  const model = modelId.toLowerCase();
  if (model.includes('gpt') || model.includes('o1') || model.includes('o3')) return 'openai';
  if (model.includes('claude')) return 'anthropic';
  if (model.includes('gemini') || model.includes('gemma')) return 'google';
  if (model.includes('deepseek')) return 'deepseek';
  if (model.includes('qwen') || model.includes('qwq')) return 'alibaba';
  if (model.includes('llama') || model.includes('mixtral') || model.includes('mistral')) return 'meta/mistral';
  if (model.includes('embedding') || model.includes('bge')) return 'embedding';
  if (model.includes('rerank')) return 'reranker';
  return 'unknown';
}

export function insertParams(record: UsageRecord, provider: string): SqlParam[] {
  return [
    record.id,
    record.createdAt,
    provider,
    record.modelId,
    optional(record.adapter),
    optional(record.configId),
    record.promptTokens,
    record.completionTokens,
    record.totalTokens,
    optional(record.reasoningTokens),
    optional(record.cachedTokens),
    optional(record.cacheWriteTokens),
    record.tokenSource ?? 'api',
    optional(record.durationMs),
    callerTypeToString(record.callerType),
    optional(record.callerId),
    optional(record.variantId),
    optional(record.runId),
    record.success ? 'success' : 'error',
    optional(record.errorMessage),
    optional(record.estimatedCostUsd),
  ];
}

export const INSERT_USAGE_SQL = `
INSERT INTO llm_usage_logs (
    id, timestamp, provider, model, adapter, api_config_id,
    prompt_tokens, completion_tokens, total_tokens,
    reasoning_tokens, cached_tokens, cache_write_tokens, token_source,
    duration_ms, caller_type, session_id, variant_id, run_id,
    status, error_message, cost_estimate
) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?
)`;

/** `LlmUsageRepo::insert_usage`（repo.rs:34）。 */
export function insertUsage(conn: SqlExecutor, record: UsageRecord): void {
  const provider = record.providerId ?? inferProvider(record.modelId);
  conn.run(INSERT_USAGE_SQL, insertParams(record, provider));
  logCacheDebugUsage(record);
}

/**
 * `LlmUsageRepo::insert_usage_batch`（repo.rs:162）：Rust counts per-record
 * successes and keeps the transaction alive on a failed insert (`is_ok()`),
 * committing whatever succeeded.
 */
export function insertUsageBatch(conn: SqlExecutor, records: readonly UsageRecord[]): number {
  if (records.length === 0) return 0;
  conn.run('BEGIN');
  let count = 0;
  try {
    for (const record of records) {
      try {
        const provider = record.providerId ?? inferProvider(record.modelId);
        conn.run(INSERT_USAGE_SQL, insertParams(record, provider));
        logCacheDebugUsage(record);
        count += 1;
      } catch (error) {
        storageLog(LOG_TARGET, 'debug', `[LlmUsageRepo] 批量插入记录 ${record.id} 失败（已跳过）: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    conn.run('COMMIT');
  } catch (error) {
    try { conn.run('ROLLBACK'); }
    catch (rollbackError) {
      storageLog(LOG_TARGET, 'warn', `[LlmUsageRepo] 回滚批量插入事务失败: ${String(rollbackError)}`);
    }
    throw error;
  }
  return count;
}

let cacheDebugSource: () => boolean = () => false;

/** Desktop wires `CHAT_V2_CACHE_DEBUG === '1'` here (storage plugin); platforms without an environment stay off. */
export function setCacheDebugSource(source: () => boolean): void {
  cacheDebugSource = source;
}

/** mod.rs:32 `cache_debug_enabled`: re-evaluated on every call, like Rust's `std::env::var`. */
export function cacheDebugEnabled(): boolean {
  return cacheDebugSource();
}

/** `LlmUsageRepo::cache_debug_usage_line`（repo.rs:96）。 */
export function cacheDebugUsageLine(record: UsageRecord): string {
  const cached = record.cachedTokens ?? 0;
  const hit = record.promptTokens > 0 ? cached / record.promptTokens * 100 : 0;
  return `[PromptCache] usage: scope=${record.callerId ?? '-'}::${record.variantId ?? '-'}, model=${record.modelId}, prompt=${record.promptTokens}, cached=${cached}, cache_write=${record.cacheWriteTokens ?? 0}, hit=${hit.toFixed(1)}%`;
}

export function logCacheDebugUsage(record: UsageRecord): void {
  if (cacheDebugEnabled()) storageLog(LOG_TARGET, 'info', cacheDebugUsageLine(record));
}

/** `LlmUsageRepo::get_usage_trends`（repo.rs:239）。 */
export function getUsageTrends(conn: SqlExecutor, days: number, granularity: TimeGranularity): UsageTrendPoint[] {
  const format = granularity === 'hour' ? '%Y-%m-%d %H:00'
    : granularity === 'week' ? '%Y-W%W'
      : granularity === 'month' ? '%Y-%m' : '%Y-%m-%d';
  const rows = conn.all(
    `SELECT strftime('${format}', timestamp) AS time_key,
            SUM(total_tokens) AS total_tokens,
            SUM(prompt_tokens) AS prompt_tokens,
            SUM(completion_tokens) AS completion_tokens,
            COUNT(*) AS call_count,
            MIN(timestamp) AS first_ts,
            SUM(cost_estimate) AS total_cost_estimate
       FROM llm_usage_logs
      WHERE timestamp >= datetime('now', '-${days} days')
      GROUP BY time_key
      ORDER BY time_key ASC`,
  );
  return rows.map((row) => {
    const first = row.first_ts === null || row.first_ts === undefined ? '' : text(row.first_ts);
    const parsed = parseRfc3339Millis(first);
    return {
      timeLabel: text(row.time_key),
      timestamp: parsed ?? 0,
      totalTokens: num(row.total_tokens),
      promptTokens: num(row.prompt_tokens),
      completionTokens: num(row.completion_tokens),
      requestCount: num(row.call_count),
      ...(row.total_cost_estimate === null || row.total_cost_estimate === undefined
        ? {}
        : { estimatedCostUsd: num(row.total_cost_estimate) }),
    };
  });
}

/** `LlmUsageRepo::get_usage_by_model`（repo.rs:296）。 */
export function getUsageByModel(conn: SqlExecutor, startDate: string, endDate: string): ModelSummary[] {
  const rows = conn.all(
    `SELECT model, COUNT(*) AS call_count,
            SUM(prompt_tokens) AS total_prompt_tokens,
            SUM(completion_tokens) AS total_completion_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(cost_estimate) AS total_cost_estimate
       FROM llm_usage_logs
      WHERE date_key >= ? AND date_key <= ?
      GROUP BY model
      ORDER BY total_tokens DESC`,
    [startDate, endDate],
  );
  return rows.map((row) => ({
    modelId: text(row.model),
    requestCount: num(row.call_count),
    promptTokens: num(row.total_prompt_tokens),
    completionTokens: num(row.total_completion_tokens),
    totalTokens: num(row.total_tokens),
    ...(row.total_cost_estimate === null || row.total_cost_estimate === undefined
      ? {}
      : { estimatedCostUsd: num(row.total_cost_estimate) }),
  }));
}

/** `LlmUsageRepo::get_usage_by_caller`（repo.rs:337）。 */
export function getUsageByCaller(conn: SqlExecutor, startDate: string, endDate: string): CallerTypeSummary[] {
  const rows = conn.all(
    `SELECT caller_type, COUNT(*) AS call_count,
            SUM(total_tokens) AS total_tokens,
            SUM(cost_estimate) AS total_cost_estimate
       FROM llm_usage_logs
      WHERE date_key >= ? AND date_key <= ?
      GROUP BY caller_type
      ORDER BY total_tokens DESC`,
    [startDate, endDate],
  );
  return rows.map((row) => {
    const callerType = callerTypeFromStr(text(row.caller_type));
    return {
      callerType,
      displayName: callerTypeDisplayName(callerType),
      requestCount: num(row.call_count),
      totalTokens: num(row.total_tokens),
      ...(row.total_cost_estimate === null || row.total_cost_estimate === undefined
        ? {}
        : { estimatedCostUsd: num(row.total_cost_estimate) }),
    };
  });
}

function parseDateBoundary(value: string, endOfDay: boolean): string | null {
  return rfc3339DateBoundary(value, endOfDay);
}

/** `LlmUsageRepo::get_usage_summary`（repo.rs:378）。 */
export function getUsageSummary(conn: SqlExecutor, startDate?: string | null, endDate?: string | null): UsageSummary {
  let where = '';
  const params: SqlParam[] = [];
  if (startDate !== null && startDate !== undefined && endDate !== null && endDate !== undefined) {
    where = 'WHERE date_key >= ? AND date_key <= ?';
    params.push(startDate, endDate);
  } else if (startDate !== null && startDate !== undefined) {
    where = 'WHERE date_key >= ?';
    params.push(startDate);
  } else if (endDate !== null && endDate !== undefined) {
    where = 'WHERE date_key <= ?';
    params.push(endDate);
  }

  const row = conn.one(
    `SELECT COUNT(*) AS total_calls,
            COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(reasoning_tokens), 0) AS total_reasoning_tokens,
            COALESCE(SUM(cached_tokens), 0) AS total_cached_tokens,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success_count,
            COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_count,
            SUM(cost_estimate) AS total_cost_estimate,
            AVG(duration_ms) AS avg_duration_ms,
            MIN(timestamp) AS first_timestamp,
            MAX(timestamp) AS last_timestamp
       FROM llm_usage_logs
       ${where}`,
    params,
  );

  const now = rfc3339NowZ();
  const first = timestampOrNull(row.first_timestamp);
  const last = timestampOrNull(row.last_timestamp);
  const requestedStart = startDate ? parseDateBoundary(startDate, false) : null;
  const requestedEnd = endDate ? parseDateBoundary(endDate, true) : null;
  const summary: UsageSummary = {
    startDate: (requestedStart === null ? null : canonicalRfc3339Z(requestedStart)) ?? first ?? now,
    endDate: (requestedEnd === null ? null : canonicalRfc3339Z(requestedEnd)) ?? last ?? now,
    totalRequests: num(row.total_calls),
    successRequests: num(row.success_count),
    errorRequests: num(row.error_count),
    totalPromptTokens: num(row.total_prompt_tokens),
    totalCompletionTokens: num(row.total_completion_tokens),
    totalTokens: num(row.total_tokens),
    totalReasoningTokens: num(row.total_reasoning_tokens),
    totalCachedTokens: num(row.total_cached_tokens),
    ...(row.total_cost_estimate === null || row.total_cost_estimate === undefined
      ? {}
      : { totalEstimatedCostUsd: num(row.total_cost_estimate) }),
    ...(row.avg_duration_ms === null || row.avg_duration_ms === undefined
      ? {}
      : { avgDurationMs: num(row.avg_duration_ms) }),
  };
  computeUsageAverages(summary);
  return summary;
}

/**
 * `LlmUsageRepo::get_session_usage`（repo.rs:450-480）。
 *
 * G1 有意偏离：Rust :464 写成 `WHERE caller_id = ?1`，但 llm_usage 迁移从未建 caller_id 列，
 * Rust 运行时同样报 `no such column: caller_id`。record.caller_id 实际写入 session_id 列
 * （repo.rs:49/73、collector.rs:299），读取时也从 session_id 映射回 caller_id（repo.rs:497/523），
 * 与 :450 注释“caller_id = session_id”一致，因此这里按 session_id 过滤；schema 不变。
 */
// RUST-FIX(RF-W07-llm-usage-session-caller-id): Rust queries a caller_id column no migration creates.
export function getSessionUsage(conn: SqlExecutor, sessionId: string): SessionUsageSummary {
  const row = conn.one(
    `SELECT COUNT(*) AS request_count,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            SUM(cost_estimate) AS cost_estimate
       FROM llm_usage_logs
      WHERE session_id = ?`,
    [sessionId],
  );
  return {
    sessionId,
    requestCount: num(row.request_count),
    promptTokens: num(row.prompt_tokens),
    completionTokens: num(row.completion_tokens),
    totalTokens: num(row.total_tokens),
    ...(row.cost_estimate === null || row.cost_estimate === undefined
      ? {}
      : { estimatedCostUsd: num(row.cost_estimate) }),
  };
}

/** `LlmUsageRepo::get_recent_usage_page`（repo.rs:516）。 */
export function getRecentUsagePage(conn: SqlExecutor, offset: number, limit: number): UsageRecord[] {
  const rows = conn.all(
    `SELECT id, timestamp, provider, model, api_config_id,
            prompt_tokens, completion_tokens, total_tokens,
            reasoning_tokens, cached_tokens,
            duration_ms, caller_type, session_id, status, error_message, cost_estimate,
            adapter, token_source, cache_write_tokens, variant_id, run_id
       FROM llm_usage_logs
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  return rows.map((row) => {
    const rawTimestamp = text(row.timestamp);
    const parsed = parseRfc3339Millis(rawTimestamp);
    if (parsed === null) {
      storageLog(LOG_TARGET, 'warn', `[LlmUsageRepo] Failed to parse timestamp '${rawTimestamp}', using epoch fallback`);
    }
    const createdAt = parsed === null
      ? rfc3339ZFromMillis(0)
      : (canonicalRfc3339Z(rawTimestamp) ?? rfc3339ZFromMillis(parsed));
    return {
      id: text(row.id),
      callerType: callerTypeFromStr(text(row.caller_type)),
      ...(row.session_id === null ? {} : { callerId: text(row.session_id) }),
      ...(row.variant_id === null ? {} : { variantId: text(row.variant_id) }),
      ...(row.run_id === null ? {} : { runId: text(row.run_id) }),
      modelId: text(row.model),
      ...(row.api_config_id === null ? {} : { configId: text(row.api_config_id) }),
      ...(row.provider === null ? {} : { providerId: text(row.provider) }),
      ...(row.adapter === null ? {} : { adapter: text(row.adapter) }),
      ...(row.token_source === null ? {} : { tokenSource: text(row.token_source) }),
      promptTokens: num(row.prompt_tokens),
      completionTokens: num(row.completion_tokens),
      totalTokens: num(row.total_tokens),
      ...(row.reasoning_tokens === null ? {} : { reasoningTokens: num(row.reasoning_tokens) }),
      ...(row.cached_tokens === null ? {} : { cachedTokens: num(row.cached_tokens) }),
      ...(row.cache_write_tokens === null ? {} : { cacheWriteTokens: num(row.cache_write_tokens) }),
      ...(row.cost_estimate === null ? {} : { estimatedCostUsd: num(row.cost_estimate) }),
      ...(row.duration_ms === null ? {} : { durationMs: num(row.duration_ms) }),
      success: text(row.status) === 'success',
      ...(row.error_message === null ? {} : { errorMessage: text(row.error_message) }),
      createdAt,
    };
  });
}

/** `LlmUsageRepo::get_recent_usage`（repo.rs:511）。 */
export function getRecentUsage(conn: SqlExecutor, limit: number): UsageRecord[] {
  return getRecentUsagePage(conn, 0, limit);
}

/** `LlmUsageRepo::delete_old_records`（repo.rs:545）。 */
export function deleteOldRecords(conn: SqlExecutor, beforeDate: string): number {
  return conn.run('DELETE FROM llm_usage_logs WHERE date_key < ?', [beforeDate]).changes;
}

/** `LlmUsageRepo::get_daily_summary`（repo.rs:564）。 */
export function getDailySummary(conn: SqlExecutor, startDate: string, endDate: string): DailySummary[] {
  const rows = conn.all(
    `SELECT date_key, COUNT(*) AS call_count,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_count,
            SUM(prompt_tokens) AS total_prompt_tokens,
            SUM(completion_tokens) AS total_completion_tokens,
            SUM(total_tokens) AS total_tokens,
            SUM(cost_estimate) AS total_cost_estimate
       FROM llm_usage_logs
      WHERE date_key >= ? AND date_key <= ?
      GROUP BY date_key
      ORDER BY date_key DESC`,
    [startDate, endDate],
  );
  return rows.map((row) => ({
    date: text(row.date_key),
    requestCount: num(row.call_count),
    successCount: num(row.success_count),
    errorCount: num(row.error_count),
    totalPromptTokens: num(row.total_prompt_tokens),
    totalCompletionTokens: num(row.total_completion_tokens),
    totalTokens: num(row.total_tokens),
    ...(row.total_cost_estimate === null || row.total_cost_estimate === undefined
      ? {}
      : { totalEstimatedCostUsd: num(row.total_cost_estimate) }),
  }));
}

export interface PriceCoverageStat {
  key: string | null;
  totalRequests: number;
  pricedRequests: number;
  totalTokens: number;
  pricedTokens: number;
}

export type PriceCoverageDimension = 'overall' | 'model' | 'caller_type';

/** `LlmUsageRepo::get_price_coverage`（repo.rs:621）。 */
export function getPriceCoverage(
  conn: SqlExecutor,
  startDate: string,
  endDate: string,
  dimension: PriceCoverageDimension,
): PriceCoverageStat[] {
  const selectKey = dimension === 'overall' ? 'NULL' : dimension;
  const groupBy = dimension === 'overall' ? '' : `GROUP BY ${dimension} ORDER BY ${dimension}`;
  const rows = conn.all(
    `SELECT ${selectKey} AS coverage_key,
            COUNT(*) AS total_requests,
            COUNT(cost_estimate) AS priced_requests,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(CASE WHEN cost_estimate IS NOT NULL THEN total_tokens ELSE 0 END), 0) AS priced_tokens
       FROM llm_usage_logs
      WHERE date_key >= ? AND date_key <= ?
      ${groupBy}`,
    [startDate, endDate],
  );
  return rows.map((row) => ({
    key: row.coverage_key === null ? null : text(row.coverage_key),
    totalRequests: num(row.total_requests),
    pricedRequests: num(row.priced_requests),
    totalTokens: num(row.total_tokens),
    pricedTokens: num(row.priced_tokens),
  }));
}

/** `LlmUsageRepo::get_recent_price_coverage`（repo.rs:668）。 */
export function getRecentPriceCoverage(conn: SqlExecutor, days: number): PriceCoverageStat {
  const row = conn.one(
    `SELECT COUNT(*) AS total_requests,
            COUNT(cost_estimate) AS priced_requests,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(CASE WHEN cost_estimate IS NOT NULL THEN total_tokens ELSE 0 END), 0) AS priced_tokens
       FROM llm_usage_logs
      WHERE timestamp >= datetime('now', ?)`,
    [`-${days} days`],
  );
  return {
    key: null,
    totalRequests: num(row.total_requests),
    pricedRequests: num(row.priced_requests),
    totalTokens: num(row.total_tokens),
    pricedTokens: num(row.priced_tokens),
  };
}

// ------------------------------------------------------------------ database helpers

export const LLM_USAGE_SCHEMA_VERSION = 20260826;

export interface LlmUsageDatabaseStats {
  logCount: number;
  dailySummaryCount: number;
  totalTokens: number;
  totalCostEstimate: number;
  schemaVersion: number;
}

/** `LlmUsageDatabase::get_schema_version`（database.rs:283）。 */
export function getSchemaVersion(conn: SqlExecutor): number {
  return num(conn.pluck('SELECT COALESCE(MAX(version), 0) FROM refinery_schema_history') ?? 0);
}

/** `LlmUsageDatabase::is_foreign_keys_enabled`（database.rs:300）。 */
export function isForeignKeysEnabled(conn: SqlExecutor): boolean {
  return num(conn.pluck('PRAGMA foreign_keys') ?? 0) === 1;
}

/** `LlmUsageDatabase::get_statistics`（database.rs:511）。 */
export function getStatistics(conn: SqlExecutor): LlmUsageDatabaseStats {
  return {
    logCount: num(conn.pluck('SELECT COUNT(*) FROM llm_usage_logs') ?? 0),
    dailySummaryCount: num(conn.pluck('SELECT COUNT(*) FROM llm_usage_daily') ?? 0),
    totalTokens: num(conn.pluck('SELECT COALESCE(SUM(total_tokens), 0) FROM llm_usage_logs') ?? 0),
    totalCostEstimate: Number(conn.pluck('SELECT COALESCE(SUM(cost_estimate), 0.0) FROM llm_usage_logs') ?? 0),
    schemaVersion: LLM_USAGE_SCHEMA_VERSION,
  };
}
