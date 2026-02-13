/**
 * User Memory API
 *
 * 提供用户记忆管理的前端接口。
 */

import { invoke } from '@tauri-apps/api/core';

const LOG_PREFIX = '[UserMemory:API]';

// ============================================================================
// 类型定义
// ============================================================================

export interface UserMemory {
  id: string;
  userId: string;
  agentId?: string;
  sessionId?: string;
  category: string;
  subCategory?: string;
  content: string;
  importance: number;
  accessCount: number;
  lastAccessedAt?: string;
  createdAt: string;
  updatedAt?: string;
  expiresAt?: string;
  source?: string;
  sourceId?: string;
  isImmutable: boolean;
  isDeleted: boolean;
  version: number;
}

export interface UserMemoryHistory {
  id: string;
  memoryId: string;
  oldContent?: string;
  newContent?: string;
  event: string;
  actorId?: string;
  createdAt: string;
}

export interface CategoryInfo {
  category: string;
  count: number;
}

export interface MemoryStats {
  totalCount: number;
  activeCount: number;
  deletedCount: number;
  expiredCount: number;
  categoryCounts: CategoryInfo[];
  avgImportance: number;
}

export interface StoreOutput {
  success: boolean;
  memoryId?: string;
  event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';
  similarMemories?: SimilarMemory[];
  message?: string;
  confidence: number;
  reason: string;
}

export interface SimilarMemory {
  id: string;
  content: string;
  similarity: number;
}

export interface SearchResult {
  memory: UserMemory;
  similarity: number;
  finalScore: number;
  reasoning?: string;
}

export interface SearchOutput {
  mode: string;
  results: SearchResult[];
  categorySummaries?: CategorySummary[];
  rewrittenQuery?: string;
}

export interface CategorySummary {
  id: string;
  userId: string;
  category: string;
  summary?: string;
  memoryCount: number;
  lastUpdated?: string;
}

export interface PruneResult {
  expiredRemoved: number;
  deletedRemoved: number;
  totalFreed: number;
}

export interface RebuildIndexResult {
  totalProcessed: number;
  successCount: number;
  failedCount: number;
  skippedCount: number;
  failedIds: string[];
  durationMs: number;
}

export interface ReconcileResult {
  sqliteValidCount: number;
  lanceVectorCount: number;
  orphanVectorsRemoved: number;
  missingVectorsCount: number;
  summariesRebuilt: number;
  durationMs: number;
}

export interface LatencySnapshot {
  count: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
}

export interface MetricsSnapshot {
  storeCount: number;
  storeAddCount: number;
  storeUpdateCount: number;
  storeDeleteCount: number;
  storeNoneCount: number;
  updateCount: number;
  deleteCount: number;
  searchCount: number;
  pruneCount: number;
  rebuildCount: number;
  reconcileCount: number;
  errorCount: number;
  embeddingErrorCount: number;
  llmErrorCount: number;
  storeLatency: LatencySnapshot;
  searchLatency: LatencySnapshot;
  embeddingLatency: LatencySnapshot;
  llmDecisionLatency: LatencySnapshot;
}

// ============================================================================
// 请求类型
// ============================================================================

export interface ListMemoriesRequest {
  userId?: string;
  category?: string;
  categories?: string[];
  subCategory?: string;
  minImportance?: number;
  limit?: number;
  includeDeleted?: boolean;
  includeExpired?: boolean;
}

export interface StoreMemoryRequest {
  userId?: string;
  content: string;
  category: string;
  subCategory?: string;
  importance?: number;
  immutable?: boolean;
  expiresAt?: string;
  forceEvent?: 'ADD' | 'UPDATE' | 'DELETE';
}

export interface UpdateMemoryRequest {
  memoryId: string;
  content: string;
  importance?: number;
}

export interface SearchMemoriesRequest {
  userId?: string;
  query: string;
  retrievalMode?: 'rag' | 'llm' | 'hybrid';
  categories?: string[];
  minImportance?: number;
  limit?: number;
  rewriteQuery?: boolean;
}

// ============================================================================
// API 函数
// ============================================================================

/**
 * 列出用户记忆
 */
export async function listMemories(request: ListMemoriesRequest = {}): Promise<{
  success: boolean;
  memories: UserMemory[];
  count: number;
}> {
  try {
    const result = await invoke<{
      success: boolean;
      memories: UserMemory[];
      count: number;
    }>('user_memory_list', { request });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'listMemories() failed:', error);
    throw error;
  }
}

/**
 * 获取单条记忆
 */
export async function getMemory(memoryId: string): Promise<UserMemory | null> {
  try {
    const result = await invoke<UserMemory | null>('user_memory_get', { memoryId });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getMemory() failed:', error);
    throw error;
  }
}

/**
 * 存储记忆（LLM 决策）
 */
export async function storeMemory(request: StoreMemoryRequest): Promise<StoreOutput> {
  try {
    const result = await invoke<StoreOutput>('user_memory_store', { request });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'storeMemory() failed:', error);
    throw error;
  }
}

/**
 * 更新记忆
 */
export async function updateMemory(request: UpdateMemoryRequest): Promise<boolean> {
  try {
    const result = await invoke<boolean>('user_memory_update', { request });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'updateMemory() failed:', error);
    throw error;
  }
}

/**
 * 删除记忆（软删除）
 */
export async function deleteMemory(memoryId: string): Promise<boolean> {
  try {
    const result = await invoke<boolean>('user_memory_delete', { memoryId });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'deleteMemory() failed:', error);
    throw error;
  }
}

/**
 * 搜索记忆
 */
export async function searchMemories(request: SearchMemoriesRequest): Promise<SearchOutput> {
  try {
    const result = await invoke<SearchOutput>('user_memory_search', { request });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'searchMemories() failed:', error);
    throw error;
  }
}

/**
 * 获取记忆历史
 */
export async function getMemoryHistory(memoryId: string, limit?: number): Promise<UserMemoryHistory[]> {
  try {
    const result = await invoke<UserMemoryHistory[]>('user_memory_history', { memoryId, limit });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getMemoryHistory() failed:', error);
    throw error;
  }
}

/**
 * 获取记忆统计
 */
export async function getMemoryStats(userId?: string): Promise<MemoryStats> {
  try {
    const result = await invoke<MemoryStats>('user_memory_stats', { userId });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getMemoryStats() failed:', error);
    throw error;
  }
}

/**
 * 清理过期和已删除的记忆
 */
export async function pruneMemories(userId?: string): Promise<PruneResult> {
  try {
    const result = await invoke<PruneResult>('user_memory_prune', { userId });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'pruneMemories() failed:', error);
    throw error;
  }
}

/**
 * 获取所有类别
 */
export async function getCategories(userId?: string): Promise<CategoryInfo[]> {
  try {
    const result = await invoke<CategoryInfo[]>('user_memory_categories', { userId });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getCategories() failed:', error);
    throw error;
  }
}

/**
 * 重建向量索引
 *
 * 遍历 SQLite 中所有有效记忆，重新生成 embedding 并更新 LanceDB。
 * 用于修复索引损坏或模型切换后的索引重建。
 */
export async function rebuildIndex(userId?: string): Promise<RebuildIndexResult> {
  try {
    const result = await invoke<RebuildIndexResult>('user_memory_rebuild_index', { userId });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'rebuildIndex() failed:', error);
    throw error;
  }
}

/**
 * 数据一致性校验与自愈
 *
 * 清理孤儿向量，重建类别摘要。
 */
export async function reconcile(userId?: string): Promise<ReconcileResult> {
  try {
    const result = await invoke<ReconcileResult>('user_memory_reconcile', { userId });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'reconcile() failed:', error);
    throw error;
  }
}

/**
 * 完整修复（索引重建 + 一致性校验）
 */
export async function fullRepair(userId?: string): Promise<[RebuildIndexResult, ReconcileResult]> {
  try {
    const result = await invoke<[RebuildIndexResult, ReconcileResult]>('user_memory_full_repair', { userId });
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'fullRepair() failed:', error);
    throw error;
  }
}

/**
 * 获取用户记忆模块指标快照
 *
 * 返回操作计数、延迟统计等可观测性指标
 */
export async function getMetrics(): Promise<MetricsSnapshot> {
  try {
    const result = await invoke<MetricsSnapshot>('user_memory_get_metrics');
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getMetrics() failed:', error);
    throw error;
  }
}

/**
 * 重置用户记忆模块指标
 */
export async function resetMetrics(): Promise<void> {
  try {
    await invoke('user_memory_reset_metrics');
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'resetMetrics() failed:', error);
    throw error;
  }
}

export interface HealthCheckResult {
  sqliteCount: number;
  lanceCount: number;
  missingCount: number;
  orphanCount: number;
}

export interface AutoRecoverResult {
  didRebuild: boolean;
  didReconcile: boolean;
  healthReport: string;
}

/**
 * 检查索引健康状态
 *
 * 返回 SQLite 记录数、LanceDB 向量数、缺失数、孤儿数
 */
export async function checkHealth(userId?: string): Promise<HealthCheckResult> {
  try {
    const [sqliteCount, lanceCount, missingCount, orphanCount] = await invoke<[number, number, number, number]>(
      'user_memory_check_health',
      { userId }
    );
    return { sqliteCount, lanceCount, missingCount, orphanCount };
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'checkHealth() failed:', error);
    throw error;
  }
}

/**
 * 自动恢复（如需要）
 *
 * 检查索引健康状态，如果发现问题自动触发恢复
 */
export async function autoRecover(
  userId?: string,
  missingThreshold?: number,
  orphanThreshold?: number
): Promise<AutoRecoverResult> {
  try {
    const [didRebuild, didReconcile, healthReport] = await invoke<[boolean, boolean, string]>(
      'user_memory_auto_recover',
      { userId, missingThreshold, orphanThreshold }
    );
    return { didRebuild, didReconcile, healthReport };
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'autoRecover() failed:', error);
    throw error;
  }
}

// ============================================================================
// 导出
// ============================================================================

export const userMemoryApi = {
  listMemories,
  getMemory,
  storeMemory,
  updateMemory,
  deleteMemory,
  searchMemories,
  getMemoryHistory,
  getMemoryStats,
  pruneMemories,
  getCategories,
  rebuildIndex,
  reconcile,
  fullRepair,
  getMetrics,
  resetMetrics,
  checkHealth,
  autoRecover,
};

export default userMemoryApi;
