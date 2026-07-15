/**
 * 多模态 RAG 服务
 *
 * 封装多模态知识库的 Tauri 命令调用，提供类型安全的接口。
 *
 * 设计文档: docs/multimodal-user-memory-design.md (Section 8.3)
 */

/** 当前构建包含 VFS 多模态索引能力。实际可用性由运行时能力探测决定。 */
export const MULTIMODAL_INDEX_SUPPORTED = true;
/** @deprecated 使用 MULTIMODAL_INDEX_SUPPORTED 或 getCapabilityStatus。 */
export const MULTIMODAL_INDEX_ENABLED = MULTIMODAL_INDEX_SUPPORTED;

import {
  vfsMultimodalIndex,
  vfsInspectRetrievalCapabilities,
  vfsMultimodalSearch,
  vfsMultimodalSearchDetailed,
  vfsMultimodalStats,
  vfsMultimodalDelete,
  vfsMultimodalIndexResource,
  type VfsMultimodalIndexInput,
  type VfsMultimodalIndexOutput,
  type VfsMultimodalSearchInput,
  type VfsMultimodalSearchOutput,
  type VfsMultimodalDetailedSearchOutput,
  type VfsMultimodalQueryMode,
  type VfsMultimodalStats,
  type VfsCapabilityState,
  type VfsMultimodalIndexResourceInput,
  type VfsMultimodalIndexResourceOutput,
} from '@/api/vfsRagApi';

// ============================================================================
// 类型定义
// ============================================================================

/** 来源类型 */
export type SourceType = 'attachment' | 'exam' | 'textbook' | 'image' | 'file';

/** 索引结果 */
export interface IndexResult {
  /** 索引的页面数 */
  pages_indexed: number;
  /** 跳过的页面数（已存在） */
  pages_skipped: number;
  /** 向量维度 */
  embedding_dim: number;
  /** 耗时（毫秒） */
  duration_ms: number;
}

/** 批量索引结果 */
export interface BatchIndexResult {
  success_count: number;
  failure_count: number;
  errors: string[];
}

/** 检索结果来源 */
export type RetrievalSource = 'multimodal_page' | 'text_chunk';

/** 多模态检索结果 */
export interface MultimodalRetrievalResult {
  /** 来源类型 */
  source_type: SourceType;
  /** 来源资源 ID */
  source_id: string;
  /** 页码（页面级结果） */
  page_index?: number;
  /** 块索引（段落级结果） */
  chunk_index?: number;
  /** 文本内容 */
  text_content?: string;
  /** 图片 Base64（可选，精排后加载） */
  image_base64?: string;
  /** Blob 哈希（用于加载原图） */
  blob_hash?: string;
  /** 相关性分数 */
  score: number;
  /** 结果来源 */
  source: RetrievalSource;
}

/** 检索配置 */
export interface RetrievalConfig {
  /** 多模态召回数量 */
  mm_top_k?: number;
  /** 文本召回数量 */
  text_top_k?: number;
  /** 最终返回数量 */
  final_top_k?: number;
  /** 是否启用精排 */
  enable_reranking?: boolean;
  /** 知识库过滤 */
  sub_library_ids?: string[];
}

export type MultimodalCapabilityReason = 'ready' | 'not_configured' | 'unavailable';

/** 一次性运行时能力快照；不缓存临时错误。 */
export interface MultimodalCapabilityStatus {
  configured: boolean;
  available: boolean;
  reason: MultimodalCapabilityReason;
  dimension?: number;
  modelConfigId?: string;
  error?: string;
  /** 后端同一时刻冻结的 ME 路由状态。 */
  capability?: VfsCapabilityState;
}

/** 维度状态（与后端 DimensionStatus 枚举对应） */
export type DimensionStatus = 'active' | 'empty' | 'model_missing' | 'unregistered';

/** 维度摘要（与后端 DimensionSummary 结构对应） */
export interface DimensionSummary {
  /** 向量维度 */
  dimension: number;
  /** 关联的模型配置 ID */
  model_config_id: string;
  /** 模型名称 */
  model_name: string;
  /** 表前缀 */
  table_prefix: string;
  /** 是否为多模态模型 */
  is_multimodal: boolean;
  /** 记录数量 */
  record_count: number;
  /** 估算存储大小（字节） */
  estimated_bytes: number;
  /** 状态 */
  status: DimensionStatus;
}

/** 索引任务 */
export interface PageIndexTask {
  source_type: SourceType;
  source_id: string;
  sub_library_id?: string;
  force_rebuild?: boolean;
}

// ============================================================================
// 旧签名兼容层：调用真实 VFS API，避免旧入口静默失效。
// ============================================================================

/**
 * @deprecated 新调用方请直接使用 vfsSearch。
 */
export async function retrieve(
  queryText?: string,
  queryImageBase64?: string,
  queryImageMediaType?: string,
  config?: RetrievalConfig
): Promise<MultimodalRetrievalResult[]> {
  const hasText = Boolean(queryText?.trim());
  const hasImage = Boolean(queryImageBase64?.trim());
  if (!hasText && !hasImage) {
    throw new Error('检索请求必须包含文本、图片或两者');
  }

  const queryMode: VfsMultimodalQueryMode = hasText && hasImage
    ? 'mixed'
    : hasImage ? 'image' : 'text';
  const results = await vfsSearch({
    query: queryText ?? '',
    queryText,
    queryImageBase64,
    queryImageMediaType,
    queryMode,
    topK: config?.final_top_k ?? config?.mm_top_k ?? config?.text_top_k,
    folderIds: config?.sub_library_ids,
  });

  return results.map((result) => ({
    source_type: normalizeSourceType(result.resourceType),
    source_id: result.resourceId,
    page_index: result.pageIndex,
    text_content: result.textContent,
    blob_hash: result.blobHash,
    score: result.score,
    source: 'multimodal_page',
  }));
}

function normalizeSourceType(resourceType: string): SourceType {
  switch (resourceType) {
    case 'attachment':
    case 'exam':
    case 'textbook':
    case 'image':
    case 'file':
      return resourceType;
    default:
      return 'file';
  }
}

/** 获取当前多模态 embedding 路线的运行时状态。 */
export async function getCapabilityStatus(): Promise<MultimodalCapabilityStatus> {
  try {
    const snapshot = await vfsInspectRetrievalCapabilities();
    const capability = snapshot.multimodalEmbedding;
    if (!capability.configured) {
      return { configured: false, available: false, reason: 'not_configured' };
    }

    const available = capability.healthy
      && !capability.circuitOpen
      && capability.protocolCompatible
      && capability.indexCompatible;
    return {
      configured: true,
      available,
      reason: available ? 'ready' : 'unavailable',
      capability,
      ...(available || !capability.reason ? {} : { error: capability.reason }),
    };
  } catch (error: unknown) {
    return {
      configured: true,
      available: false,
      reason: 'unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function isConfigured(): Promise<boolean> {
  const status = await getCapabilityStatus();
  return status.configured && status.available;
}

// ============================================================================
// 便捷函数
// ============================================================================

/**
 * 文本检索（纯文本查询）
 */
export async function searchByText(
  text: string,
  config?: RetrievalConfig
): Promise<MultimodalRetrievalResult[]> {
  return retrieve(text, undefined, undefined, config);
}

/**
 * 图片检索（纯图片查询）
 */
export async function searchByImage(
  imageBase64: string,
  mediaType: string = 'image/png',
  config?: RetrievalConfig
): Promise<MultimodalRetrievalResult[]> {
  return retrieve(undefined, imageBase64, mediaType, config);
}

/**
 * 混合检索（文本+图片查询）
 */
export async function searchByTextAndImage(
  text: string,
  imageBase64: string,
  mediaType: string = 'image/png',
  config?: RetrievalConfig
): Promise<MultimodalRetrievalResult[]> {
  return retrieve(text, imageBase64, mediaType, config);
}

/**
 * 索引题目集识别
 */
export async function indexExamSheet(
  examId: string,
  subLibraryId?: string,
  forceRebuild?: boolean
): Promise<IndexResult> {
  return vfsIndexResourceBySource('exam', examId, subLibraryId, forceRebuild) as any;
}

/**
 * 索引教材
 */
export async function indexTextbook(
  textbookId: string,
  subLibraryId?: string,
  forceRebuild?: boolean
): Promise<IndexResult> {
  return vfsIndexResourceBySource('textbook', textbookId, subLibraryId, forceRebuild) as any;
}

/**
 * 索引附件
 */
export async function indexAttachment(
  attachmentId: string,
  subLibraryId?: string,
  forceRebuild?: boolean
): Promise<IndexResult> {
  return vfsIndexResourceBySource('attachment', attachmentId, subLibraryId, forceRebuild) as any;
}

// ============================================================================
// VFS 统一多模态 API（2026-01 迁移）
// ============================================================================

/**
 * 使用 VFS 统一多模态服务索引资源
 *
 * ★ 2026-01: 新架构入口，逐步替代 indexResource
 */
export async function vfsIndexResource(
  input: VfsMultimodalIndexInput
): Promise<VfsMultimodalIndexOutput> {
  return vfsMultimodalIndex(input);
}

/**
 * 使用 VFS 统一多模态服务检索
 *
 * ★ 2026-01: 新架构入口，逐步替代 retrieve
 */
export async function vfsSearch(
  input: VfsMultimodalSearchInput
): Promise<VfsMultimodalSearchOutput[]> {
  return vfsMultimodalSearch(input);
}

/** 使用统一检索器并返回路由计划、能力快照和逐路由诊断。 */
export async function vfsSearchDetailed(
  input: VfsMultimodalSearchInput
): Promise<VfsMultimodalDetailedSearchOutput> {
  return vfsMultimodalSearchDetailed(input);
}

/**
 * 获取 VFS 多模态统计
 */
export async function vfsGetStats(): Promise<VfsMultimodalStats> {
  return vfsMultimodalStats();
}

/**
 * 删除 VFS 多模态索引
 */
export async function vfsDeleteIndex(resourceId: string): Promise<void> {
  return vfsMultimodalDelete(resourceId);
}

/**
 * 使用 VFS 按资源类型和 ID 索引资源（兼容旧 API）
 *
 * ★ 2026-01: 兼容 indexResource 的 VFS 版本
 */
export async function vfsIndexResourceBySource(
  sourceType: SourceType,
  sourceId: string,
  folderId?: string,
  forceRebuild?: boolean
): Promise<VfsMultimodalIndexResourceOutput> {
  return vfsMultimodalIndexResource({
    sourceType,
    sourceId,
    folderId,
    forceRebuild,
  });
}

// 默认导出
export const multimodalRagService = {
  // 旧 API（仍有调用方，兼容期间保留）
  retrieve,
  isConfigured,
  getCapabilityStatus,
  // 便捷函数
  searchByText,
  searchByImage,
  searchByTextAndImage,
  indexExamSheet,
  indexTextbook,
  indexAttachment,
  // ★ VFS 统一 API（2026-01）
  vfsIndexResource,
  vfsSearch,
  vfsSearchDetailed,
  vfsGetStats,
  vfsDeleteIndex,
  vfsIndexResourceBySource,
};

export default multimodalRagService;
