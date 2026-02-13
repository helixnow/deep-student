/**
 * VFS 统一索引 API
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  IndexStatusSummary,
  UnitIndexStatus,
  BatchIndexResult,
  EmbeddingDimInfo,
  IndexMode,
  SyncUnitsParams,
} from '../types/vfs-unified-index';
import { debugLog } from '../debug-panel/debugMasterSwitch';

// ============================================================================
// 资源级别类型（兼容 IndexStatusView）
// ============================================================================

/** 向量维度信息（资源级别视图） */
export interface VfsEmbeddingDimension {
  dimension: number;
  modality: string;
  /** 绑定的模型配置 ID */
  modelConfigId?: string;
  /** 绑定的模型名称 */
  modelName?: string;
  recordCount: number;
  lanceTableName: string;
  createdAt: number;
  lastUsedAt: number;
}

/** 单个资源的向量化状态 */
export interface ResourceIndexStatus {
  resourceId: string;
  sourceId?: string;
  resourceType: string;
  name: string;
  hasOcr: boolean;
  ocrCount: number;
  textIndexState: string;
  textIndexedAt?: number;
  textIndexError?: string;
  textChunkCount: number;
  nativeTextChunkCount: number;
  ocrTextChunkCount: number;
  textEmbeddingDim?: number;
  textIndexSource?: string;
  mmIndexState: string;
  mmIndexedPages: number;
  mmEmbeddingDim?: number;
  mmIndexingMode?: string;
  mmIndexError?: string;
  embeddingDim?: number;
  modality?: string;
  updatedAt: number;
  isStale: boolean;
}

/** 向量化状态统计（资源级别视图） */
export interface ResourceIndexStatusSummary {
  totalResources: number;
  indexedCount: number;
  pendingCount: number;
  indexingCount: number;
  failedCount: number;
  disabledCount: number;
  staleCount: number;
  mmTotalResources: number;
  mmIndexedCount: number;
  mmPendingCount: number;
  mmIndexingCount: number;
  mmFailedCount: number;
  mmDisabledCount: number;
  resources: ResourceIndexStatus[];
}

/** 获取向量化状态的查询参数 */
export interface GetIndexStatusParams {
  folderId?: string;
  resourceType?: string;
  stateFilter?: string;
  limit?: number;
  offset?: number;
}

/**
 * 获取索引状态总览
 */
export async function getUnifiedIndexStatus(): Promise<IndexStatusSummary> {
  return invoke<IndexStatusSummary>('vfs_unified_index_status');
}

/**
 * 获取资源的 Units 列表
 */
export async function getResourceUnits(resourceId: string): Promise<UnitIndexStatus[]> {
  return invoke<UnitIndexStatus[]>('vfs_get_resource_units', { resourceId });
}

/**
 * 重新索引 Unit
 */
export async function reindexUnit(unitId: string, mode: IndexMode = 'both'): Promise<boolean> {
  return invoke<boolean>('vfs_reindex_unit', { unitId, mode });
}

/**
 * 批量索引待处理 Units
 */
export async function batchIndexPending(
  mode: IndexMode = 'both',
  batchSize?: number
): Promise<BatchIndexResult> {
  return invoke<BatchIndexResult>('vfs_unified_batch_index', { mode, batchSize });
}

/**
 * 同步资源的 Units
 */
export async function syncResourceUnits(params: SyncUnitsParams): Promise<UnitIndexStatus[]> {
  return invoke<UnitIndexStatus[]>('vfs_sync_resource_units', {
    resourceId: params.resourceId,
    resourceType: params.resourceType,
    data: params.data,
    ocrText: params.ocrText,
    ocrPagesJson: params.ocrPagesJson,
    blobHash: params.blobHash,
    pageCount: params.pageCount,
    extractedText: params.extractedText,
    previewJson: params.previewJson,
  });
}

/** 删除索引操作的结构化结果 */
export interface DeleteIndexResult {
  /** SQLite 记录是否删除成功 */
  sqliteOk: boolean;
  /** Lance text 向量是否删除成功 */
  lanceTextOk: boolean;
  /** Lance multimodal 向量是否删除成功 */
  lanceMmOk: boolean;
  /** 警告信息列表 */
  warnings: string[];
  /** 是否可重试（Lance 失败时为 true） */
  retryable: boolean;
}

/**
 * 删除资源索引
 */
export async function deleteResourceIndex(resourceId: string): Promise<DeleteIndexResult> {
  return invoke<DeleteIndexResult>('vfs_delete_resource_index', { resourceId });
}

/**
 * 获取已注册的向量维度
 */
export async function listEmbeddingDims(): Promise<EmbeddingDimInfo[]> {
  return invoke<EmbeddingDimInfo[]>('vfs_list_embedding_dims');
}

// ============================================================================
// 资源级别 API（兼容 IndexStatusView）
// ============================================================================

const LOG_PREFIX = '[VfsUnifiedIndexApi]';
const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

/**
 * 获取所有资源的向量化状态
 */
export async function getAllIndexStatus(params?: GetIndexStatusParams): Promise<ResourceIndexStatusSummary> {
  console.log(LOG_PREFIX, 'getAllIndexStatus:', params);
  
  const result = await invoke<ResourceIndexStatusSummary>('vfs_get_all_index_status', {
    folderId: params?.folderId ?? null,
    resourceType: params?.resourceType ?? null,
    stateFilter: params?.stateFilter ?? null,
    limit: params?.limit ?? 100,
    offset: params?.offset ?? 0,
  });
  
  console.log(LOG_PREFIX, `getAllIndexStatus: ${result.totalResources} resources`);
  return result;
}

/**
 * 重新索引单个资源
 */
export async function reindexResource(resourceId: string): Promise<number> {
  console.log(LOG_PREFIX, 'reindexResource:', resourceId);
  return invoke<number>('vfs_reindex_resource', { resourceId });
}

/**
 * 批量索引待处理资源（旧 API，调用 vfs_batch_index_pending）
 */
export async function batchIndexPendingLegacy(batchSize?: number): Promise<{ successCount: number; failCount: number; total: number }> {
  console.log(LOG_PREFIX, 'batchIndexPendingLegacy:', batchSize);
  return invoke('vfs_batch_index_pending', { batchSize: batchSize ?? 10 });
}

/**
 * 获取所有可用的向量维度信息（资源级别视图）
 */
export async function listDimensions(): Promise<VfsEmbeddingDimension[]> {
  console.log(LOG_PREFIX, 'listDimensions');
  return invoke<VfsEmbeddingDimension[]>('vfs_list_dimensions');
}

/**
 * 为维度分配模型（用于跨维度检索）
 * 
 * 模型分配是配置项，不是数据绑定。用户可以随时更改维度使用的模型。
 * 更改后，跨维度检索时会使用新分配的模型生成查询向量。
 */
export async function assignDimensionModel(
  dimension: number,
  modality: string,
  modelConfigId: string,
  modelName: string
): Promise<boolean> {
  console.log(LOG_PREFIX, 'assignDimensionModel:', { dimension, modality, modelConfigId, modelName });
  return invoke<boolean>('vfs_assign_dimension_model', {
    dimension,
    modality,
    modelConfigId,
    modelName,
  });
}

export interface CreateDimensionResult {
  dimension: number;
  modality: string;
  lanceTableName: string;
  recordCount: number;
  createdAt: number;
  lastUsedAt: number;
  modelConfigId: string | null;
  modelName: string | null;
}

export async function createDimension(
  dimension: number,
  modality: string,
  modelConfigId?: string,
  modelName?: string
): Promise<CreateDimensionResult> {
  console.log(LOG_PREFIX, 'createDimension:', { dimension, modality, modelConfigId, modelName });
  return invoke<CreateDimensionResult>('vfs_create_dimension', {
    dimension,
    modality,
    modelConfigId: modelConfigId ?? null,
    modelName: modelName ?? null,
  });
}

export interface DeleteDimensionResult {
  deletedSegments: number;
  dimension: number;
  modality: string;
}

export async function deleteDimension(
  dimension: number,
  modality: string
): Promise<DeleteDimensionResult> {
  console.log(LOG_PREFIX, 'deleteDimension:', { dimension, modality });
  return invoke<DeleteDimensionResult>('vfs_delete_dimension', {
    dimension,
    modality,
  });
}

export async function getPresetDimensions(): Promise<number[]> {
  console.log(LOG_PREFIX, 'getPresetDimensions');
  return invoke<number[]>('vfs_get_preset_dimensions');
}

export async function getDimensionRange(): Promise<[number, number]> {
  console.log(LOG_PREFIX, 'getDimensionRange');
  return invoke<[number, number]>('vfs_get_dimension_range');
}

// ============================================================================
// 默认嵌入维度管理 API
// ============================================================================

/**
 * 设置默认嵌入维度
 * 
 * @param dimension 维度值
 * @param modality 模态类型 ("text" | "multimodal")
 */
export async function setDefaultEmbeddingDimension(
  dimension: number,
  modality: 'text' | 'multimodal'
): Promise<boolean> {
  console.log(LOG_PREFIX, 'setDefaultEmbeddingDimension:', { dimension, modality });
  return invoke<boolean>('vfs_set_default_embedding_dimension', {
    dimension,
    modality,
  });
}

/**
 * 获取默认嵌入维度信息
 * 
 * @param modality 模态类型 ("text" | "multimodal")
 * @returns 默认维度信息，如果未设置则返回 null
 */
export async function getDefaultEmbeddingDimension(
  modality: 'text' | 'multimodal'
): Promise<VfsEmbeddingDimension | null> {
  console.log(LOG_PREFIX, 'getDefaultEmbeddingDimension:', modality);
  return invoke<VfsEmbeddingDimension | null>('vfs_get_default_embedding_dimension', {
    modality,
  });
}

/**
 * 清除默认嵌入维度设置
 * 
 * @param modality 模态类型 ("text" | "multimodal")
 */
export async function clearDefaultEmbeddingDimension(
  modality: 'text' | 'multimodal'
): Promise<boolean> {
  console.log(LOG_PREFIX, 'clearDefaultEmbeddingDimension:', modality);
  return invoke<boolean>('vfs_clear_default_embedding_dimension', {
    modality,
  });
}

// 导出所有 API
export const vfsUnifiedIndexApi = {
  // Unit-based API
  getUnifiedIndexStatus,
  getResourceUnits,
  reindexUnit,
  batchIndexPending,
  syncResourceUnits,
  deleteResourceIndex,
  listEmbeddingDims,
  // Resource-based API (for IndexStatusView)
  getAllIndexStatus,
  reindexResource,
  batchIndexPendingLegacy,
  listDimensions,
  // Dimension management
  assignDimensionModel,
  createDimension,
  deleteDimension,
  getPresetDimensions,
  getDimensionRange,
  // Default embedding dimension management
  setDefaultEmbeddingDimension,
  getDefaultEmbeddingDimension,
  clearDefaultEmbeddingDimension,
};

export default vfsUnifiedIndexApi;
