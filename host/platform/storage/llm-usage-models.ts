/**
 * LLM usage 的数据类型（`dstu-storage/src/llm_usage/models.rs`）：serde 线上形状（`camelCase`，`CallerType::Other` 为
 * `{ other: string }`）、`UsageRecordBuilder` 与各汇总结构。
 */
import { rfc3339FromMillis, rfc3339Now } from './time.ts';

// ------------------------------------------------------------------ CallerType

export type CallerType =
  | 'chat_v2'
  | 'translation'
  | 'anki'
  | 'analysis'
  | 'exam_sheet'
  | 'memory'
  | 'vfs_indexing'
  | 'embedding'
  | 'reranker'
  | 'voice_input'
  | 'media_transcription'
  | { other: string };

export const CallerType = {
  ChatV2: 'chat_v2' as const,
  Translation: 'translation' as const,
  Anki: 'anki' as const,
  Analysis: 'analysis' as const,
  ExamSheet: 'exam_sheet' as const,
  Memory: 'memory' as const,
  VfsIndexing: 'vfs_indexing' as const,
  Embedding: 'embedding' as const,
  Reranker: 'reranker' as const,
  VoiceInput: 'voice_input' as const,
  MediaTranscription: 'media_transcription' as const,
  Other: (value: string): CallerType => ({ other: value }),
};

/** `CallerType::from_str`（types.rs:104）。 */
export function callerTypeFromStr(value: string): CallerType {
  switch (value) {
    case 'chat_v2': return 'chat_v2';
    case 'translation': return 'translation';
    case 'anki': return 'anki';
    case 'analysis': return 'analysis';
    case 'exam_sheet': return 'exam_sheet';
    case 'memory': return 'memory';
    case 'vfs_indexing': return 'vfs_indexing';
    case 'embedding': return 'embedding';
    case 'reranker': return 'reranker';
    case 'voice_input': return 'voice_input';
    case 'media_transcription': return 'media_transcription';
    default:
      return { other: value.startsWith('other:') ? value.slice('other:'.length) : value };
  }
}

/** `Display for CallerType`（types.rs:64）。 */
export function callerTypeToString(value: CallerType): string {
  return typeof value === 'string' ? value : `other:${value.other}`;
}

/** `CallerType::display_name`（types.rs:135）。 */
export function callerTypeDisplayName(value: CallerType): string {
  if (typeof value !== 'string') return '其他';
  switch (value) {
    case 'chat_v2': return '对话系统';
    case 'translation': return '智能翻译';
    case 'anki': return 'Anki 制卡';
    case 'analysis': return '错题分析';
    case 'exam_sheet': return '整卷识别';
    case 'memory': return '智能记忆';
    case 'vfs_indexing': return '文件索引';
    case 'embedding': return '文本嵌入';
    case 'reranker': return '重排序';
    case 'voice_input': return '语音输入';
    case 'media_transcription': return '音视频转写';
  }
}

// ------------------------------------------------------------------ records

export interface UsageRecord {
  id: string;
  callerType: CallerType;
  callerId?: string | null;
  variantId?: string | null;
  runId?: string | null;
  modelId: string;
  configId?: string | null;
  providerId?: string | null;
  adapter?: string | null;
  tokenSource?: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  estimatedCostUsd?: number | null;
  durationMs?: number | null;
  success: boolean;
  errorMessage?: string | null;
  createdAt: string;
}

/** `UsageRecord::generate_id`（types.rs:243）。 */
export function generateUsageId(): string {
  return `usage_${globalThis.crypto.randomUUID()}`;
}

/** `UsageRecord::new` + builder methods（types.rs:248-340）。 */
export class UsageRecordBuilder {
  private readonly record: UsageRecord;

  constructor(callerType: CallerType, modelId: string, promptTokens: number, completionTokens: number) {
    this.record = {
      id: generateUsageId(),
      callerType,
      modelId,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      success: true,
      createdAt: rfc3339Now(),
    };
  }

  withCallerId(callerId: string): this { this.record.callerId = callerId; return this; }
  withVariantId(variantId: string): this { this.record.variantId = variantId; return this; }
  withRunId(runId: string): this { this.record.runId = runId; return this; }
  withConfigId(configId: string): this { this.record.configId = configId; return this; }
  withProviderId(providerId: string): this { this.record.providerId = providerId; return this; }
  withAdapter(adapter: string): this { this.record.adapter = adapter; return this; }
  withTokenSource(tokenSource: string): this { this.record.tokenSource = tokenSource; return this; }
  withReasoningTokens(tokens: number): this { this.record.reasoningTokens = tokens; return this; }
  withCachedTokens(tokens: number): this { this.record.cachedTokens = tokens; return this; }
  withCacheWriteTokens(tokens: number): this { this.record.cacheWriteTokens = tokens; return this; }
  withEstimatedCost(costUsd: number): this { this.record.estimatedCostUsd = costUsd; return this; }
  withDuration(durationMs: number): this { this.record.durationMs = durationMs; return this; }
  withError(error: string): this { this.record.success = false; this.record.errorMessage = error; return this; }

  build(): UsageRecord { return this.record; }
}

export function newUsageRecord(
  callerType: CallerType,
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): UsageRecordBuilder {
  return new UsageRecordBuilder(callerType, modelId, promptTokens, completionTokens);
}

// ------------------------------------------------------------------ summaries

export interface DailySummary {
  date: string;
  callerType?: CallerType | null;
  modelId?: string | null;
  requestCount: number;
  successCount: number;
  errorCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalReasoningTokens?: number | null;
  totalCachedTokens?: number | null;
  totalEstimatedCostUsd?: number | null;
  avgDurationMs?: number | null;
}

/** `DailySummary::new`（types.rs:437）。 */
export function newDailySummary(date: string): DailySummary {
  return {
    date,
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
  };
}

/** `DailySummary::accumulate`（types.rs:453）。 */
export function accumulateDailySummary(summary: DailySummary, record: UsageRecord): void {
  summary.requestCount += 1;
  if (record.success) summary.successCount += 1;
  else summary.errorCount += 1;

  summary.totalPromptTokens += record.promptTokens;
  summary.totalCompletionTokens += record.completionTokens;
  summary.totalTokens += record.totalTokens;

  if (record.reasoningTokens !== null && record.reasoningTokens !== undefined) {
    summary.totalReasoningTokens = (summary.totalReasoningTokens ?? 0) + record.reasoningTokens;
  }
  if (record.cachedTokens !== null && record.cachedTokens !== undefined) {
    summary.totalCachedTokens = (summary.totalCachedTokens ?? 0) + record.cachedTokens;
  }
  if (record.estimatedCostUsd !== null && record.estimatedCostUsd !== undefined) {
    summary.totalEstimatedCostUsd = (summary.totalEstimatedCostUsd ?? 0) + record.estimatedCostUsd;
  }
}

export type TimeGranularity = 'hour' | 'day' | 'week' | 'month';

/** `Display for TimeGranularity`（types.rs:497）。 */
export function timeGranularityDisplay(value: TimeGranularity): string {
  return value;
}

export interface UsageTrendPoint {
  timeLabel: string;
  timestamp: number;
  requestCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd?: number | null;
  successRate?: number | null;
}

export function newUsageTrendPoint(timeLabel: string, timestamp: number): UsageTrendPoint {
  return { timeLabel, timestamp, requestCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
}

export interface SessionUsageSummary {
  sessionId: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number | null;
}

export interface CallerTypeSummary {
  callerType: CallerType;
  displayName: string;
  requestCount: number;
  totalTokens: number;
  estimatedCostUsd?: number | null;
  percentage?: number | null;
}

/** `CallerTypeSummary::new`（types.rs:723）。 */
export function newCallerTypeSummary(callerType: CallerType): CallerTypeSummary {
  return { callerType, displayName: callerTypeDisplayName(callerType), requestCount: 0, totalTokens: 0 };
}

export interface ModelSummary {
  modelId: string;
  requestCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd?: number | null;
  percentage?: number | null;
  avgTokensPerRequest?: number | null;
}

/** `ModelSummary::new`（types.rs:757）。 */
export function newModelSummary(modelId: string): ModelSummary {
  return { modelId, requestCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 };
}

/** `ModelSummary::compute_averages`（types.rs:775）。 */
export function computeModelAverages(summary: ModelSummary): void {
  if (summary.requestCount > 0) summary.avgTokensPerRequest = summary.totalTokens / summary.requestCount;
}

export interface UsageSummary {
  startDate: string;
  endDate: string;
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalReasoningTokens?: number | null;
  totalCachedTokens?: number | null;
  totalEstimatedCostUsd?: number | null;
  avgTokensPerRequest?: number | null;
  avgDurationMs?: number | null;
  byCallerType?: CallerTypeSummary[] | null;
  byModel?: ModelSummary[] | null;
  trendPoints?: UsageTrendPoint[] | null;
}

/** `UsageSummary::new`（types.rs:643）。 */
export function newUsageSummary(startDate: string, endDate: string): UsageSummary {
  return {
    startDate,
    endDate,
    totalRequests: 0,
    successRequests: 0,
    errorRequests: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
  };
}

/** `UsageSummary::compute_averages`（types.rs:676）。 */
export function computeUsageAverages(summary: UsageSummary): void {
  if (summary.totalRequests > 0) summary.avgTokensPerRequest = summary.totalTokens / summary.totalRequests;
}

export interface UsageQueryParams {
  startDate?: string | null;
  endDate?: string | null;
  callerType?: CallerType | null;
  modelId?: string | null;
  successOnly?: boolean | null;
  offset?: number | null;
  limit?: number | null;
  granularity?: TimeGranularity | null;
}

/** `UsageQueryParams::last_30_days`（types.rs:817）。 */
export function last30DaysQuery(): UsageQueryParams {
  const end = Date.now();
  return { startDate: rfc3339FromMillis(end - 30 * 24 * 60 * 60 * 1000), endDate: rfc3339FromMillis(end) };
}
