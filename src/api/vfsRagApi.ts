/**
 * VFS RAG 向量检索 API
 *
 * 封装 VFS 统一知识管理架构的 RAG 检索功能。
 * 
 * ## 主要功能
 * - `vfsRagSearch` - RAG 向量检索
 * - `getVfsLanceStats` - 获取 Lance 统计信息
 * - `optimizeVfsLance` - 优化 Lance 表
 *
 * @module vfsRagApi
 */

import { invoke } from '@tauri-apps/api/core';
import { debugLog } from '../debug-panel/debugMasterSwitch';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

// ============================================================================
// 类型定义
// ============================================================================

/** 搜索结果项 */
export interface VfsSearchResult {
  /** 嵌入记录 ID */
  embeddingId: string;
  /** 资源 ID */
  resourceId: string;
  /** 块索引 */
  chunkIndex: number;
  /** 块文本 */
  chunkText: string;
  /** 相似度分数 */
  score: number;
  /** 资源标题 */
  resourceTitle?: string;
  /** 资源类型 */
  resourceType?: string;
  /** 页面索引（用于 PDF/教材定位，0-indexed） */
  pageIndex?: number;
  /** 来源 ID（如 textbook_xxx, att_xxx） */
  sourceId?: string;
}

/** RAG 搜索输入参数 */
export interface VfsRagSearchInput {
  /** 查询文本 */
  query: string;
  /** 文件夹 ID 列表（可选，用于范围过滤） */
  folderIds?: string[];
  /** 资源类型列表（可选，如 ["note", "textbook"]） */
  resourceTypes?: string[];
  /** 返回结果数量 */
  topK?: number;
  /** 是否启用重排序 */
  enableReranking?: boolean;
  /** 是否启用跨维度搜索（聚合所有已分配模型的维度） */
  enableCrossDimension?: boolean;
}

/** RAG 搜索输出 */
export interface VfsRagSearchOutput {
  /** 检索结果列表 */
  results: VfsSearchResult[];
  /** 结果数量 */
  count: number;
  /** 检索耗时（毫秒） */
  elapsedMs: number;
}

/** Lance 表统计 */
export type VfsLanceStats = [string, number][];

// ============================================================================
// 废弃类型（已迁移到 vfs-unified-index.ts）
// ============================================================================
// VfsEmbeddingDimension -> EmbeddingDimInfo
// ResourceIndexStatus -> UnitIndexStatus  
// IndexStatusSummary -> IndexStatusSummary (from vfs-unified-index)
// GetIndexStatusParams -> 直接使用 unifiedIndexStore
// ============================================================================

// ============================================================================
// API 函数
// ============================================================================

const LOG_PREFIX = '[VfsRagApi]';

/**
 * VFS RAG 向量检索
 *
 * 使用 VFS 统一知识管理架构进行 RAG 检索。
 *
 * @param input 搜索参数
 * @returns 搜索结果
 *
 * @example
 * ```typescript
 * const result = await vfsRagSearch({
 *   query: '如何求导',
 *   topK: 10,
 *   enableReranking: true
 * });
 * console.log(`Found ${result.count} results in ${result.elapsedMs}ms`);
 * ```
 */
export async function vfsRagSearch(input: VfsRagSearchInput): Promise<VfsRagSearchOutput> {
  console.log(LOG_PREFIX, 'vfsRagSearch:', input);

  try {
    const result = await invoke<VfsRagSearchOutput>('vfs_rag_search', {
      input: {
        query: input.query,
        folderIds: input.folderIds ?? null,
        resourceTypes: input.resourceTypes ?? null,
        topK: input.topK ?? 10,
        enableReranking: input.enableReranking ?? true,
        enableCrossDimension: input.enableCrossDimension ?? true,
      },
    });

    console.log(LOG_PREFIX, `vfsRagSearch completed: ${result.count} results in ${result.elapsedMs}ms`);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'vfsRagSearch failed:', error);
    throw error;
  }
}

/**
 * 简化的 RAG 搜索
 *
 * 使用默认参数进行 RAG 搜索。
 *
 * @param query 查询文本
 * @param topK 返回结果数量（默认 10）
 * @returns 搜索结果列表
 */
export async function vfsRagSearchSimple(
  query: string,
  topK: number = 10
): Promise<VfsSearchResult[]> {
  const result = await vfsRagSearch({ query, topK, enableReranking: true });
  return result.results;
}

/**
 * 在指定文件夹范围内进行 RAG 搜索
 *
 * @param query 查询文本
 * @param folderIds 文件夹 ID 列表
 * @param topK 返回结果数量（默认 10）
 * @returns 搜索结果列表
 */
export async function vfsRagSearchInFolders(
  query: string,
  folderIds: string[],
  topK: number = 10
): Promise<VfsSearchResult[]> {
  const result = await vfsRagSearch({ query, folderIds, topK, enableReranking: true });
  return result.results;
}

/**
 * 按资源类型进行 RAG 搜索
 *
 * @param query 查询文本
 * @param resourceTypes 资源类型列表（如 ["note", "textbook", "exam"]）
 * @param topK 返回结果数量（默认 10）
 * @returns 搜索结果列表
 */
export async function vfsRagSearchByTypes(
  query: string,
  resourceTypes: string[],
  topK: number = 10
): Promise<VfsSearchResult[]> {
  const result = await vfsRagSearch({ query, resourceTypes, topK, enableReranking: true });
  return result.results;
}

/**
 * 获取 Lance 表统计信息
 *
 * @param modality 模态类型（默认 "text"）
 * @returns 表名和记录数的列表
 */
export async function getVfsLanceStats(modality?: string): Promise<VfsLanceStats> {
  console.log(LOG_PREFIX, 'getVfsLanceStats:', modality);

  try {
    const result = await invoke<VfsLanceStats>('vfs_get_lance_stats', {
      modality: modality ?? null,
    });

    console.log(LOG_PREFIX, 'getVfsLanceStats result:', result);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getVfsLanceStats failed:', error);
    throw error;
  }
}

/**
 * 优化 Lance 表
 *
 * 执行 Compact、Prune 和 Index 优化操作。
 *
 * @param modality 模态类型（默认 "text"）
 * @returns 优化的表数量
 */
export async function optimizeVfsLance(modality?: string): Promise<number> {
  console.log(LOG_PREFIX, 'optimizeVfsLance:', modality);

  try {
    const result = await invoke<number>('vfs_optimize_lance', {
      modality: modality ?? null,
    });

    console.log(LOG_PREFIX, 'optimizeVfsLance completed:', result, 'tables optimized');
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'optimizeVfsLance failed:', error);
    throw error;
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 将 VfsSearchResult 转换为 Chat V2 SourceInfo 格式
 *
 * @param result VFS 搜索结果
 * @returns SourceInfo 格式的对象
 */
export function toSourceInfo(result: VfsSearchResult): {
  title?: string;
  url?: string;
  snippet?: string;
  score?: number;
  metadata?: Record<string, unknown>;
} {
  return {
    title: result.resourceTitle ?? result.resourceId,
    snippet: result.chunkText,
    score: result.score,
    metadata: {
      resourceId: result.resourceId,
      resourceType: result.resourceType,
      chunkIndex: result.chunkIndex,
      embeddingId: result.embeddingId,
      sourceType: 'vfs_rag',
    },
  };
}

/**
 * 批量转换搜索结果为 SourceInfo 格式
 */
export function toSourceInfoList(results: VfsSearchResult[]): ReturnType<typeof toSourceInfo>[] {
  return results.map(toSourceInfo);
}

// ============================================================================
// 废弃 API（已迁移到 vfsUnifiedIndexApi.ts）
// ============================================================================
// getAllIndexStatus -> getUnifiedIndexStatus
// reindexResource -> reindexUnit
// batchIndexPending -> batchIndexPending (from vfsUnifiedIndexApi)
// listDimensions -> listEmbeddingDims
// ============================================================================

// ============================================================================
// 索引诊断 API
// ============================================================================

/** 索引状态计数 */
export interface IndexStateCounts {
  pending: number;
  indexing: number;
  indexed: number;
  failed: number;
  disabled: number;
  nullState: number;
}

/** 资源诊断信息 */
export interface ResourceDiagnostic {
  id: string;
  /** 资源名称（用于 UI 显示） */
  name: string | null;
  resourceType: string;
  storageMode: string;
  indexState: string | null;
  indexError: string | null;
  dataLen: number;
  hasOcrText: boolean;
  /** unit 数量（统一索引架构） */
  unitCount: number;
  /** segment 数量（统一索引架构） */
  segmentCount: number;
  /** Unit 的 text_state */
  unitTextState: string | null;
  /** Unit 的 mm_state */
  unitMmState: string | null;
  /** 文本嵌入维度 */
  textEmbeddingDim: number | null;
  /** 文本分块数量 */
  textChunkCount: number | null;
  updatedAt: number;
}

/** vfs_index_units 表统计（统一索引架构） */
export interface UnitsStats {
  totalCount: number;
  distinctResources: number;
  textPending: number;
  textIndexing: number;
  textIndexed: number;
  textFailed: number;
  textDisabled: number;
  mmPending: number;
  mmIndexing: number;
  mmIndexed: number;
  mmFailed: number;
  mmDisabled: number;
}

/** vfs_index_segments 表统计 */
export interface SegmentsStats {
  totalCount: number;
  distinctUnits: number;
  textModalityCount: number;
  mmModalityCount: number;
  avgSegmentsPerUnit: number;
}

/** 维度统计 */
export interface DimensionStats {
  dimension: number;
  modality: string;
  recordCount: number;
  actualCount: number;
}

/** 一致性检查 */
export interface ConsistencyCheck {
  checkName: string;
  passed: boolean;
  details: string;
}

/** 索引诊断信息（统一索引架构版本） */
export interface IndexDiagnosticInfo {
  timestamp: string;
  /** 架构版本 */
  architectureVersion: string;
  totalResources: number;
  stateCounts: IndexStateCounts;
  /** 抽样资源（最多15条，用于快速预览） */
  sampleResources: ResourceDiagnostic[];
  /** 所有资源详情（用于完整对比） */
  allResources: ResourceDiagnostic[];
  /** vfs_index_units 表统计 */
  unitsStats: UnitsStats;
  /** vfs_index_segments 表统计 */
  segmentsStats: SegmentsStats;
  dimensionsStats: DimensionStats[];
  consistencyChecks: ConsistencyCheck[];
}

/**
 * 获取索引诊断信息
 * 
 * @param resourceId 可选，指定资源 ID 查看详情
 * @returns 诊断信息
 */
export async function getIndexDiagnostic(resourceId?: string): Promise<IndexDiagnosticInfo> {
  console.log(LOG_PREFIX, 'getIndexDiagnostic:', resourceId);

  try {
    const result = await invoke<IndexDiagnosticInfo>('vfs_debug_index_status', {
      resourceId,
    });
    console.log(LOG_PREFIX, 'getIndexDiagnostic:', result);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getIndexDiagnostic failed:', error);
    throw error;
  }
}

/**
 * 重置所有 disabled 资源为 pending 状态
 * 
 * @returns 重置的资源数量
 */
export async function resetDisabledToPending(): Promise<number> {
  console.log(LOG_PREFIX, 'resetDisabledToPending');

  try {
    const result = await invoke<number>('vfs_reset_disabled_to_pending');
    console.log(LOG_PREFIX, `resetDisabledToPending: ${result} resources reset`);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'resetDisabledToPending failed:', error);
    throw error;
  }
}

/**
 * 重置所有 indexed 但无 embeddings 的资源为 pending 状态
 * 
 * @returns 重置的资源数量
 */
export async function resetIndexedWithoutEmbeddings(): Promise<number> {
  console.log(LOG_PREFIX, 'resetIndexedWithoutEmbeddings');

  try {
    const result = await invoke<number>('vfs_reset_indexed_without_embeddings');
    console.log(LOG_PREFIX, `resetIndexedWithoutEmbeddings: ${result} resources reset`);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'resetIndexedWithoutEmbeddings failed:', error);
    throw error;
  }
}

/**
 * 重置所有索引状态（用于调试/重新索引）
 * 
 * 将所有资源的索引状态重置为 pending，并清空 segments、units 和维度统计
 * 
 * @returns 重置的资源数量
 */
export async function resetAllIndexState(): Promise<number> {
  console.log(LOG_PREFIX, 'resetAllIndexState');

  try {
    const result = await invoke<number>('vfs_reset_all_index_state');
    console.log(LOG_PREFIX, `resetAllIndexState: ${result} resources reset`);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'resetAllIndexState failed:', error);
    throw error;
  }
}

// ============================================================================
// VFS 多模态统一管理 API（2026-01）
// ============================================================================

/** 多模态页面输入 */
export interface VfsMultimodalPageInput {
  /** 页面索引（0-based） */
  pageIndex: number;
  /** 图片 Base64 数据 */
  imageBase64?: string;
  /** 图片 MIME 类型 */
  imageMime?: string;
  /** OCR 文本或 VLM 摘要 */
  textContent?: string;
  /** 图片 Blob 哈希 */
  blobHash?: string;
}

/** 多模态索引输入 */
export interface VfsMultimodalIndexInput {
  /** 资源 ID */
  resourceId: string;
  /** 资源类型 */
  resourceType: string;
  /** 文件夹 ID（可选） */
  folderId?: string;
  /** 待索引的页面列表 */
  pages: VfsMultimodalPageInput[];
}

/** 多模态索引结果 */
export interface VfsMultimodalIndexOutput {
  /** 成功索引的页面数 */
  indexedPages: number;
  /** 向量维度 */
  dimension: number;
  /** 失败的页面索引列表 */
  failedPages: number[];
}

/** 多模态检索输入 */
export interface VfsMultimodalSearchInput {
  /** 查询文本 */
  query: string;
  /** 返回的最大结果数 */
  topK?: number;
  /** 文件夹 ID 过滤 */
  folderIds?: string[];
  /** 资源类型过滤 */
  resourceTypes?: string[];
}

/** 多模态检索结果 */
export interface VfsMultimodalSearchOutput {
  /** 资源 ID */
  resourceId: string;
  /** 资源类型 */
  resourceType: string;
  /** 页面索引 */
  pageIndex: number;
  /** 文本内容 */
  textContent?: string;
  /** 图片 Blob 哈希 */
  blobHash?: string;
  /** 相关度分数 */
  score: number;
  /** 文件夹 ID */
  folderId?: string;
}

/** 多模态索引统计 */
export interface VfsMultimodalStats {
  /** 总记录数 */
  totalRecords: number;
  /** 向量维度列表 */
  dimensions: number[];
}

/**
 * 索引资源的多模态页面
 * 
 * ★ 2026-01: VFS 统一多模态索引
 * 
 * @param input 多模态索引输入参数
 * @returns 索引结果
 */
export async function vfsMultimodalIndex(
  input: VfsMultimodalIndexInput
): Promise<VfsMultimodalIndexOutput> {
  console.log(LOG_PREFIX, 'vfsMultimodalIndex:', input.resourceId, input.pages.length, 'pages');

  try {
    const result = await invoke<VfsMultimodalIndexOutput>('vfs_multimodal_index', {
      params: input,
    });
    console.log(LOG_PREFIX, `vfsMultimodalIndex: ${result.indexedPages} pages indexed`);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'vfsMultimodalIndex failed:', error);
    throw error;
  }
}

/**
 * 多模态向量检索
 * 
 * ★ 2026-01: VFS 统一多模态检索
 * 
 * @param input 多模态检索输入参数
 * @returns 检索结果列表
 */
export async function vfsMultimodalSearch(
  input: VfsMultimodalSearchInput
): Promise<VfsMultimodalSearchOutput[]> {
  console.log(LOG_PREFIX, 'vfsMultimodalSearch:', input.query);

  try {
    const result = await invoke<VfsMultimodalSearchOutput[]>('vfs_multimodal_search', {
      params: input,
    });
    console.log(LOG_PREFIX, `vfsMultimodalSearch: ${result.length} results`);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'vfsMultimodalSearch failed:', error);
    throw error;
  }
}

/**
 * 获取 VFS 多模态索引统计
 * 
 * @returns 多模态索引统计信息
 */
export async function vfsMultimodalStats(): Promise<VfsMultimodalStats> {
  console.log(LOG_PREFIX, 'vfsMultimodalStats');

  try {
    const result = await invoke<VfsMultimodalStats>('vfs_multimodal_stats');
    console.log(LOG_PREFIX, `vfsMultimodalStats: ${result.totalRecords} records`);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'vfsMultimodalStats failed:', error);
    throw error;
  }
}

/**
 * 删除资源的多模态索引
 * 
 * @param resourceId 资源 ID
 */
export async function vfsMultimodalDelete(resourceId: string): Promise<void> {
  console.log(LOG_PREFIX, 'vfsMultimodalDelete:', resourceId);

  try {
    await invoke<void>('vfs_multimodal_delete', { resourceId });
    console.log(LOG_PREFIX, 'vfsMultimodalDelete: success');
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'vfsMultimodalDelete failed:', error);
    throw error;
  }
}

/** VFS 多模态资源索引输入（兼容旧 API） */
export interface VfsMultimodalIndexResourceInput {
  /** 资源类型 (exam/textbook/attachment/image) */
  sourceType: string;
  /** 资源业务 ID */
  sourceId: string;
  /** 文件夹 ID（可选） */
  folderId?: string;
  /** 是否强制重建 */
  forceRebuild?: boolean;
}

/** VFS 多模态资源索引输出 */
export interface VfsMultimodalIndexResourceOutput {
  /** 成功索引的页面数 */
  indexedPages: number;
  /** 向量维度 */
  dimension: number;
  /** 失败的页面索引列表 */
  failedPages: number[];
}

/**
 * VFS 多模态资源索引（兼容旧 API）
 * 
 * ★ 2026-01: 兼容 mm_index_resource 的 VFS 版本
 * 
 * @param input 索引输入
 * @returns 索引结果
 */
export async function vfsMultimodalIndexResource(
  input: VfsMultimodalIndexResourceInput
): Promise<VfsMultimodalIndexResourceOutput> {
  console.log(LOG_PREFIX, 'vfsMultimodalIndexResource:', input);

  try {
    const result = await invoke<VfsMultimodalIndexResourceOutput>('vfs_multimodal_index_resource', {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      folderId: input.folderId,
      forceRebuild: input.forceRebuild,
    });
    console.log(LOG_PREFIX, `vfsMultimodalIndexResource: ${result.indexedPages} pages indexed`);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'vfsMultimodalIndexResource failed:', error);
    throw error;
  }
}

// ============================================================================
// PDF 页面图片获取（支持 RAG 引用渲染）
// ============================================================================

/** PDF 页面图片结果 */
export interface PdfPageImageResult {
  /** Base64 编码的图片数据（不含 data: 前缀） */
  base64: string;
  /** MIME 类型（如 "image/png"） */
  mimeType: string;
  /** 文件大小（字节） */
  size: number;
}

/**
 * 获取 PDF 指定页面的预渲染图片
 *
 * 根据资源 ID 和页码获取 PDF 页面的预渲染图片。
 * 支持 textbook、attachment、exam_sheet 类型的 PDF 资源。
 *
 * @param resourceId 资源 ID（RAG 结果中的 metadata.resourceId）
 * @param pageIndex 页码（0-indexed，RAG 结果中的 metadata.pageIndex）
 * @returns 图片的 base64 数据和 MIME 类型
 *
 * @example
 * ```typescript
 * const result = await getPdfPageImage('resource-id', 0);
 * const dataUrl = `data:${result.mimeType};base64,${result.base64}`;
 * ```
 */
export async function getPdfPageImage(
  resourceId: string,
  pageIndex: number
): Promise<PdfPageImageResult> {
  console.log(LOG_PREFIX, 'getPdfPageImage:', { resourceId, pageIndex });

  try {
    const result = await invoke<PdfPageImageResult>('vfs_get_pdf_page_image', {
      resourceId,
      pageIndex,
    });

    console.log(LOG_PREFIX, `getPdfPageImage: ${result.size} bytes, ${result.mimeType}`);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'getPdfPageImage failed:', error);
    throw error;
  }
}

/**
 * 获取 PDF 页面图片的 Data URL
 *
 * 便捷方法，直接返回可用于 img.src 的 Data URL。
 *
 * @param resourceId 资源 ID
 * @param pageIndex 页码（0-indexed）
 * @returns Data URL 字符串
 */
export async function getPdfPageImageDataUrl(
  resourceId: string,
  pageIndex: number
): Promise<string> {
  const result = await getPdfPageImage(resourceId, pageIndex);
  return `data:${result.mimeType};base64,${result.base64}`;
}

export interface LanceTableDiagnostic {
  tableName: string;
  dimension: number;
  rowCount: number;
  columns: string[];
  hasMetadataColumn: boolean;
  hasEmbeddingIdColumn: boolean;
  hasResourceIdColumn: boolean;
  hasTextColumn: boolean;
  sampleMetadata: (string | null)[];
  metadataWithPageIndex: number;
  metadataNullCount: number;
  schemaValid: boolean;
  issueDescription: string | null;
}

export async function diagnoseLanceSchema(modality?: string): Promise<LanceTableDiagnostic[]> {
  console.log(LOG_PREFIX, 'diagnoseLanceSchema:', modality);

  try {
    const result = await invoke<LanceTableDiagnostic[]>('vfs_diagnose_lance_schema', {
      modality: modality ?? null,
    });
    console.log(LOG_PREFIX, 'diagnoseLanceSchema result:', result);
    return result;
  } catch (error: unknown) {
    console.error(LOG_PREFIX, 'diagnoseLanceSchema failed:', error);
    throw error;
  }
}
