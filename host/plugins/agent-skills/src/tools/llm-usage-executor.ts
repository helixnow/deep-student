/**
 * Read-only LLM usage statistics tool, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs`.
 *
 * The executor reads the managed `llm_usage` database directly through the
 * storage repository functions and never invokes a command from inside the
 * backend. Arguments are validated strictly (unknown fields rejected), the
 * caller/config ids and error messages are never echoed, and long strings are
 * bounded to 2000 characters.
 */
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import {
  callerTypeToString, getPriceCoverage, getRecentPriceCoverage, getRecentUsagePage,
  getUsageByCaller, getUsageByModel, getUsageSummary, getUsageTrends,
  type CallerTypeSummary, type ModelSummary,
  type PriceCoverageStat, type UsageRecord, type UsageTrendPoint,
} from '../../../../platform/storage/llm-usage.ts';
import { parseRfc3339, toRfc3339 } from '../../../../platform/time/index.ts';

export const LLM_USAGE_TOOL_NAME = 'llm_usage_query';
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 20;
export const MAX_PAGE_OFFSET = 100_000;
export const MAX_TREND_DAYS = 366;
export const MAX_HOURLY_TREND_DAYS = 31;
export const MAX_TEXT_FIELD_CHARS = 2_000;

export type UsageGranularity = 'hour' | 'day';

export interface PageRequest {
  offset: number;
  limit: number;
}

export type UsageQuery =
  | { kind: 'summary'; startDate: string; endDate: string }
  | { kind: 'trends'; days: number; granularity: UsageGranularity; page: PageRequest }
  | { kind: 'by_model'; startDate: string; endDate: string; page: PageRequest }
  | { kind: 'by_caller'; startDate: string; endDate: string; page: PageRequest }
  | { kind: 'recent'; page: PageRequest };

type Arguments = Record<string, unknown>;

function usageError(
  code: string,
  message: string,
  hint: string,
  retryable: boolean,
): string {
  return JSON.stringify({ code, message, hint, retryable });
}

function invalidArgument(field: string, reason: string): string {
  return usageError(
    'INVALID_ARGUMENT',
    `Invalid '${field}': ${reason}`,
    'Correct the tool arguments and retry.',
    false,
  );
}

function argumentsObject(argumentsValue: unknown): Arguments {
  if (typeof argumentsValue !== 'object' || argumentsValue === null
    || Array.isArray(argumentsValue)) {
    throw invalidArgument('arguments', 'expected a JSON object');
  }
  return argumentsValue as Arguments;
}

function ensureAllowedKeys(argumentsValue: Arguments, allowed: readonly string[]): void {
  const key = Object.keys(argumentsValue).find(candidate => !allowed.includes(candidate));
  if (key !== undefined) {
    throw invalidArgument(
      key,
      'unknown field for this action; additional properties are not allowed',
    );
  }
}

function requiredString(argumentsValue: Arguments, field: string, maxChars: number): string {
  if (!(field in argumentsValue)) throw invalidArgument(field, 'field is required');
  const value = argumentsValue[field];
  if (typeof value !== 'string') throw invalidArgument(field, 'expected a string');
  const trimmed = value.trim();
  if (trimmed === '') throw invalidArgument(field, 'must not be blank');
  if ([...trimmed].length > maxChars) {
    throw invalidArgument(field, `must contain at most ${maxChars} characters`);
  }
  return trimmed;
}

function requiredU32(argumentsValue: Arguments, field: string, min: number, max: number): number {
  if (!(field in argumentsValue)) throw invalidArgument(field, 'field is required');
  const raw = argumentsValue[field];
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw invalidArgument(field, 'expected an unsigned integer');
  }
  if (raw < min || raw > max) throw invalidArgument(field, `must be between ${min} and ${max}`);
  return raw;
}

function optionalU32(
  argumentsValue: Arguments,
  field: string,
  defaultValue: number,
  min: number,
  max: number,
): number {
  return field in argumentsValue ? requiredU32(argumentsValue, field, min, max) : defaultValue;
}

function parsePage(argumentsValue: Arguments): PageRequest {
  return {
    offset: optionalU32(argumentsValue, 'offset', 0, 0, MAX_PAGE_OFFSET),
    limit: optionalU32(argumentsValue, 'limit', DEFAULT_PAGE_LIMIT, 1, MAX_PAGE_LIMIT),
  };
}

function parseCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function requiredDate(argumentsValue: Arguments, field: string): string {
  const value = requiredString(argumentsValue, field, 10);
  if (!parseCalendarDate(value)) {
    throw invalidArgument(field, 'expected a real calendar date in YYYY-MM-DD');
  }
  return value;
}

function requiredRange(argumentsValue: Arguments): [string, string] {
  const startDate = requiredDate(argumentsValue, 'start_date');
  const endDate = requiredDate(argumentsValue, 'end_date');
  if (startDate > endDate) {
    throw invalidArgument('start_date', 'must be earlier than or equal to end_date');
  }
  return [startDate, endDate];
}

export function parseUsageQuery(argumentsValue: unknown): UsageQuery {
  const argumentsObjectValue = argumentsObject(argumentsValue);
  const action = requiredString(argumentsObjectValue, 'action', 32);
  switch (action) {
    case 'summary': {
      ensureAllowedKeys(argumentsObjectValue, ['action', 'start_date', 'end_date']);
      const [startDate, endDate] = requiredRange(argumentsObjectValue);
      return { kind: 'summary', startDate, endDate };
    }
    case 'trends': {
      ensureAllowedKeys(
        argumentsObjectValue, ['action', 'days', 'granularity', 'offset', 'limit'],
      );
      const days = requiredU32(argumentsObjectValue, 'days', 1, MAX_TREND_DAYS);
      const granularity = requiredString(argumentsObjectValue, 'granularity', 16);
      if (granularity !== 'hour' && granularity !== 'day') {
        throw invalidArgument('granularity', 'expected one of hour or day');
      }
      if (granularity === 'hour' && days > MAX_HOURLY_TREND_DAYS) {
        throw invalidArgument(
          'days', `hour granularity supports at most ${MAX_HOURLY_TREND_DAYS} days`,
        );
      }
      return { kind: 'trends', days, granularity, page: parsePage(argumentsObjectValue) };
    }
    case 'by_model': {
      ensureAllowedKeys(
        argumentsObjectValue, ['action', 'start_date', 'end_date', 'offset', 'limit'],
      );
      const [startDate, endDate] = requiredRange(argumentsObjectValue);
      return { kind: 'by_model', startDate, endDate, page: parsePage(argumentsObjectValue) };
    }
    case 'by_caller': {
      ensureAllowedKeys(
        argumentsObjectValue, ['action', 'start_date', 'end_date', 'offset', 'limit'],
      );
      const [startDate, endDate] = requiredRange(argumentsObjectValue);
      return { kind: 'by_caller', startDate, endDate, page: parsePage(argumentsObjectValue) };
    }
    case 'recent':
      ensureAllowedKeys(argumentsObjectValue, ['action', 'offset', 'limit']);
      return { kind: 'recent', page: parsePage(argumentsObjectValue) };
    default:
      throw usageError(
        'UNKNOWN_ACTION',
        `Unknown LLM usage action: ${action}`,
        'Use summary, trends, by_model, by_caller, or recent.',
        false,
      );
  }
}

/** `chrono::DateTime::to_rfc3339()` shape; invalid timestamps pass through. */
function normalizeTimestamp(value: string): string {
  const parsed = parseRfc3339(value);
  return parsed === null ? value : toRfc3339(parsed.epochNanos);
}

function paginate<T>(items: readonly T[], page: PageRequest): T[] {
  return items.slice(page.offset, page.offset + page.limit);
}

function pageJson(page: PageRequest, returned: number, total: number): Record<string, unknown> {
  const consumed = page.offset + returned;
  const hasMore = consumed < total;
  return {
    offset: page.offset,
    limit: page.limit,
    returned,
    total,
    hasMore,
    nextOffset: hasMore ? consumed : null,
  };
}

function emptyCoverage(): PriceCoverageStat {
  return { key: null, totalRequests: 0, pricedRequests: 0, totalTokens: 0, pricedTokens: 0 };
}

function keyedCoverage(stats: readonly PriceCoverageStat[]): Map<string, PriceCoverageStat> {
  const map = new Map<string, PriceCoverageStat>();
  for (const stat of stats) {
    if (stat.key !== null) map.set(stat.key, stat);
  }
  return map;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function costJson(
  estimatedUsd: number | null | undefined,
  coverage: PriceCoverageStat,
): Record<string, unknown> {
  let status: string;
  if (coverage.totalRequests === 0) status = 'not_applicable';
  else if (coverage.pricedRequests === 0) status = 'unavailable';
  else if (coverage.pricedRequests === coverage.totalRequests) status = 'complete';
  else status = 'partial';
  return {
    estimated: true,
    currency: 'USD',
    estimatedUsd: estimatedUsd ?? null,
    priceCoverage: {
      status,
      pricedRequests: coverage.pricedRequests,
      totalRequests: coverage.totalRequests,
      requestRatio: ratio(coverage.pricedRequests, coverage.totalRequests),
      pricedTokens: coverage.pricedTokens,
      totalTokens: coverage.totalTokens,
      tokenRatio: ratio(coverage.pricedTokens, coverage.totalTokens),
    },
  };
}

function trendJson(point: UsageTrendPoint): Record<string, unknown> {
  return {
    timeLabel: point.timeLabel,
    timestamp: point.timestamp,
    requestCount: point.requestCount,
    promptTokens: point.promptTokens,
    completionTokens: point.completionTokens,
    totalTokens: point.totalTokens,
    estimatedCostUsd: point.estimatedCostUsd ?? null,
    successRate: point.successRate ?? null,
  };
}

function modelJson(
  summary: ModelSummary,
  coverage: PriceCoverageStat | undefined,
): Record<string, unknown> {
  const fallback: PriceCoverageStat = {
    key: null,
    totalRequests: summary.requestCount,
    pricedRequests: 0,
    totalTokens: summary.totalTokens,
    pricedTokens: 0,
  };
  const [modelId, truncated] = boundedString(summary.modelId);
  return {
    modelId,
    modelIdTruncated: truncated,
    requestCount: summary.requestCount,
    promptTokens: summary.promptTokens,
    completionTokens: summary.completionTokens,
    totalTokens: summary.totalTokens,
    cost: costJson(summary.estimatedCostUsd, coverage ?? fallback),
  };
}

function callerJson(
  summary: CallerTypeSummary,
  coverage: PriceCoverageStat | undefined,
): Record<string, unknown> {
  const fallback: PriceCoverageStat = {
    key: null,
    totalRequests: summary.requestCount,
    pricedRequests: 0,
    totalTokens: summary.totalTokens,
    pricedTokens: 0,
  };
  const [callerType, callerTypeTruncated] = boundedString(callerTypeToString(summary.callerType));
  const [displayName, displayNameTruncated] = boundedString(summary.displayName);
  return {
    callerType,
    callerTypeTruncated,
    displayName,
    displayNameTruncated,
    requestCount: summary.requestCount,
    totalTokens: summary.totalTokens,
    cost: costJson(summary.estimatedCostUsd, coverage ?? fallback),
  };
}

function recentJson(record: UsageRecord): Record<string, unknown> {
  const [id, idTruncated] = boundedString(record.id);
  const [callerType, callerTypeTruncated] = boundedString(callerTypeToString(record.callerType));
  const [modelId, modelIdTruncated] = boundedString(record.modelId);
  const providerRaw = record.providerId ?? undefined;
  const [providerId, providerIdTruncated] = providerRaw === undefined
    ? [null, false] as const : boundedString(providerRaw);
  const priced = record.estimatedCostUsd !== null && record.estimatedCostUsd !== undefined;
  const coverage: PriceCoverageStat = {
    key: null,
    totalRequests: 1,
    pricedRequests: priced ? 1 : 0,
    totalTokens: record.totalTokens,
    pricedTokens: priced ? record.totalTokens : 0,
  };
  return {
    id,
    idTruncated,
    callerType,
    callerTypeTruncated,
    modelId,
    modelIdTruncated,
    providerId,
    providerIdTruncated,
    promptTokens: record.promptTokens,
    completionTokens: record.completionTokens,
    totalTokens: record.totalTokens,
    reasoningTokens: record.reasoningTokens ?? 0,
    cachedTokens: record.cachedTokens ?? 0,
    durationMs: record.durationMs ?? 0,
    success: record.success,
    hadError: record.errorMessage !== null && record.errorMessage !== undefined,
    createdAt: normalizeTimestamp(record.createdAt),
    cost: costJson(record.estimatedCostUsd, coverage),
  };
}

function boundedString(value: string): [string, boolean] {
  const chars = [...value];
  if (chars.length <= MAX_TEXT_FIELD_CHARS) return [value, false];
  return [chars.slice(0, MAX_TEXT_FIELD_CHARS).join(''), true];
}

function sumTrendCosts(items: readonly UsageTrendPoint[]): number | null {
  const values = items
    .map(item => item.estimatedCostUsd)
    .filter((value): value is number => value !== null && value !== undefined);
  return values.length === 0 ? null : values.reduce((left, right) => left + right, 0);
}

function querySummary(db: SqlExecutor, startDate: string, endDate: string): Record<string, unknown> {
  const summary = getUsageSummary(db, startDate, endDate);
  const coverage = getPriceCoverage(db, startDate, endDate, 'overall')[0] ?? emptyCoverage();
  return {
    action: 'summary',
    requestedRange: { startDate, endDate },
    resolvedRange: {
      start: normalizeTimestamp(summary.startDate),
      end: normalizeTimestamp(summary.endDate),
    },
    totalRequests: summary.totalRequests,
    successRequests: summary.successRequests,
    errorRequests: summary.errorRequests,
    promptTokens: summary.totalPromptTokens,
    completionTokens: summary.totalCompletionTokens,
    totalTokens: summary.totalTokens,
    reasoningTokens: summary.totalReasoningTokens ?? 0,
    cachedTokens: summary.totalCachedTokens ?? 0,
    averageTokensPerRequest: summary.avgTokensPerRequest ?? null,
    averageDurationMs: summary.avgDurationMs ?? null,
    cost: costJson(summary.totalEstimatedCostUsd, coverage),
  };
}

function queryTrends(
  db: SqlExecutor,
  days: number,
  granularity: UsageGranularity,
  page: PageRequest,
): Record<string, unknown> {
  const points = getUsageTrends(db, days, granularity);
  const coverage = getRecentPriceCoverage(db, days);
  const estimatedCostUsd = sumTrendCosts(points);
  const total = points.length;
  const items = paginate(points, page).map(trendJson);
  return {
    action: 'trends',
    requestedWindow: { days, granularity },
    items,
    page: pageJson(page, items.length, total),
    cost: costJson(estimatedCostUsd, coverage),
  };
}

function queryByModel(
  db: SqlExecutor,
  startDate: string,
  endDate: string,
  page: PageRequest,
): Record<string, unknown> {
  const summaries = getUsageByModel(db, startDate, endDate);
  const coverage = keyedCoverage(getPriceCoverage(db, startDate, endDate, 'model'));
  const total = summaries.length;
  const items = paginate(summaries, page)
    .map(summary => modelJson(summary, coverage.get(summary.modelId)));
  return {
    action: 'by_model',
    requestedRange: { startDate, endDate },
    items,
    page: pageJson(page, items.length, total),
  };
}

function queryByCaller(
  db: SqlExecutor,
  startDate: string,
  endDate: string,
  page: PageRequest,
): Record<string, unknown> {
  const summaries = getUsageByCaller(db, startDate, endDate);
  const coverage = keyedCoverage(
    getPriceCoverage(db, startDate, endDate, 'caller_type'),
  );
  const total = summaries.length;
  const items = paginate(summaries, page)
    .map(summary => callerJson(summary, coverage.get(callerTypeToString(summary.callerType))));
  return {
    action: 'by_caller',
    requestedRange: { startDate, endDate },
    items,
    page: pageJson(page, items.length, total),
  };
}

function queryRecent(db: SqlExecutor, page: PageRequest): Record<string, unknown> {
  const records = getRecentUsagePage(db, page.offset, page.limit + 1);
  const hasMore = records.length > page.limit;
  const items = records.slice(0, page.limit).map(recentJson);
  return {
    action: 'recent',
    items,
    page: {
      offset: page.offset,
      limit: page.limit,
      returned: items.length,
      hasMore,
      nextOffset: hasMore ? page.offset + items.length : null,
    },
    redaction: {
      callerId: 'omitted',
      configId: 'omitted',
      errorMessage: 'omitted',
      maxStringFieldChars: MAX_TEXT_FIELD_CHARS,
    },
  };
}

export function runUsageQuery(db: SqlExecutor, query: UsageQuery): Record<string, unknown> {
  switch (query.kind) {
    case 'summary': return querySummary(db, query.startDate, query.endDate);
    case 'trends': return queryTrends(db, query.days, query.granularity, query.page);
    case 'by_model': return queryByModel(db, query.startDate, query.endDate, query.page);
    case 'by_caller': return queryByCaller(db, query.startDate, query.endDate, query.page);
    case 'recent': return queryRecent(db, query.page);
  }
}

export interface LlmUsageLogger {
  error?(message: string): void;
}

/** Parse + run; database failures map to the stable `USAGE_QUERY_FAILED` error. */
export function executeUsageQuery(
  db: SqlExecutor,
  argumentsValue: unknown,
  logger: LlmUsageLogger = {},
): Record<string, unknown> {
  const query = parseUsageQuery(argumentsValue);
  try {
    return runUsageQuery(db, query);
  } catch (error) {
    logger.error?.(`[LlmUsageToolExecutor] Query failed: ${error instanceof Error ? error.message : String(error)}`);
    throw usageError(
      'USAGE_QUERY_FAILED',
      'The LLM usage database query failed.',
      'Retry after the local usage database is available.',
      true,
    );
  }
}

export class LlmUsageToolExecutor {
  canHandle(toolName: string): boolean {
    const stripped = toolName.startsWith('builtin-') ? toolName.slice(8)
      : toolName.startsWith('mcp_') ? toolName.slice(4) : toolName;
    return stripped === LLM_USAGE_TOOL_NAME;
  }

  sensitivityLevel(_toolName: string): 'low' { return 'low'; }
  concurrencyClass(_toolName: string): 'read_only' { return 'read_only'; }
  name(): string { return 'LlmUsageToolExecutor'; }

  executeQuery(
    db: SqlExecutor,
    argumentsValue: unknown,
    logger: LlmUsageLogger = {},
  ): Record<string, unknown> {
    return executeUsageQuery(db, argumentsValue, logger);
  }
}
