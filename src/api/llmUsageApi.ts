import { invoke } from '@tauri-apps/api/core';

export interface UsageTrendPoint {
  timeLabel: string;
  timestamp: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  requestCount: number;
  estimatedCostUsd?: number;
  successRate?: number;
}

export interface ModelSummary {
  modelId: string;
  requestCount: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd?: number;
  percentage?: number;
  avgTokensPerRequest?: number;
}

export interface CallerTypeSummary {
  callerType: string;
  displayName: string;
  requestCount: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  percentage?: number;
}

export interface DailySummary {
  dateKey: string;
  model: string;
  callerType: string;
  callCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  successCount: number;
  errorCount: number;
  totalCostEstimate?: number;
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
  totalReasoningTokens?: number;
  totalCachedTokens?: number;
  totalEstimatedCostUsd?: number;
  avgTokensPerRequest?: number;
  avgDurationMs?: number;
  byCallerType?: CallerTypeSummary[];
  byModel?: ModelSummary[];
  trendPoints?: UsageTrendPoint[];
}

export interface UsageRecord {
  id: string;
  callerType: string;
  callerId?: string;
  modelId: string;
  configId?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  estimatedCostUsd?: number;
  durationMs?: number;
  success: boolean;
  errorMessage?: string;
  createdAt: string;
  workspaceId?: string;
}

export type TimeGranularity = 'hour' | 'day' | 'week' | 'month';

export const LlmUsageApi = {
  getTrends: (days: number, granularity: TimeGranularity = 'day'): Promise<UsageTrendPoint[]> =>
    invoke<UsageTrendPoint[]>('llm_usage_get_trends', { days, granularity }),

  getByModel: (startDate: string, endDate: string): Promise<ModelSummary[]> =>
    invoke<ModelSummary[]>('llm_usage_by_model', { startDate, endDate }),

  getByCaller: (startDate: string, endDate: string): Promise<CallerTypeSummary[]> =>
    invoke<CallerTypeSummary[]>('llm_usage_by_caller', { startDate, endDate }),

  getSummary: (startDate?: string, endDate?: string): Promise<UsageSummary> =>
    invoke<UsageSummary>('llm_usage_summary', { startDate, endDate }),

  getRecent: (limit?: number): Promise<UsageRecord[]> =>
    invoke<UsageRecord[]>('llm_usage_recent', { limit }),

  getDaily: (startDate: string, endDate: string): Promise<DailySummary[]> =>
    invoke<DailySummary[]>('llm_usage_daily', { startDate, endDate }),

  cleanup: (beforeDate: string): Promise<number> =>
    invoke<number>('llm_usage_cleanup', { beforeDate }),
};

export default LlmUsageApi;
