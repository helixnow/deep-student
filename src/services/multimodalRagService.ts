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
  parseRetrievalProvenance,
  type VfsMultimodalIndexInput,
  type VfsMultimodalIndexOutput,
  type VfsMultimodalSearchInput,
  type VfsMultimodalSearchOutput,
  type VfsMultimodalDetailedSearchOutput,
  type VfsMultimodalQueryMode,
  type VfsMultimodalStats,
  type VfsCapabilityState,
  type VfsRetrievalHitProvenance,
  type VfsMultimodalIndexResourceOutput,
} from '@/api/vfsRagApi';

// 供调用方直接复用后端 DTO 类型，避免在服务层重复声明形状。
export type { VfsMultimodalIndexResourceOutput, VfsCapabilityState } from '@/api/vfsRagApi';

// ============================================================================
// 类型定义
// ============================================================================

/** 来源类型 */
export type SourceType = 'attachment' | 'exam' | 'textbook' | 'image' | 'file';

/** 检索结果来源 */
export type RetrievalSource = 'multimodal_page' | 'text_chunk';

/**
 * 多模态检索结果
 *
 * 与后端 `VfsMultimodalSearchOutput`（扁平命中 DTO）一一对应的 snake_case 视图。
 */
export interface MultimodalRetrievalResult {
  /** 来源类型 */
  source_type: SourceType;
  /**
   * 来源资源 ID。
   *
   * 注意：后端扁平 DTO 只提供 resourceId（VFS 资源 ID），不携带业务 sourceId
   * （如 textbook_xxx）；需要业务 ID 时请改用 vfsSearchDetailed。
   */
  source_id: string;
  /** Lance 嵌入记录 ID */
  embedding_id: string;
  /** 页码（0-indexed） */
  page_index?: number;
  /** 文本内容 */
  text_content?: string;
  /** Blob 哈希（用于加载原图/缩略图） */
  blob_hash?: string;
  /** 所属文件夹 ID */
  folder_id?: string;
  /** 相关性分数（RRF 融合分） */
  score: number;
  /** 结果来源（依据检索路由推导：全部为文本路由时为 text_chunk） */
  source: RetrievalSource;
  /** 参与融合的检索路由及各自贡献（运行时守卫后的结果） */
  retrieval_provenance: VfsRetrievalHitProvenance[];
}

/**
 * 检索配置
 *
 * 仅保留后端 `vfs_multimodal_search`（VfsMultimodalSearchInput）真实支持的字段。
 * 旧的 mm_top_k/text_top_k/enable_reranking 后端从未消费，已删除。
 */
export interface RetrievalConfig {
  /** 返回的最大结果数（映射到后端 topK） */
  topK?: number;
  /** 文件夹 ID 过滤（映射到后端 folderIds） */
  folderIds?: string[];
  /** 资源 ID 过滤 */
  resourceIds?: string[];
  /** 资源类型过滤 */
  resourceTypes?: string[];
}

export type MultimodalCapabilityReason =
  | 'ready'
  | 'not_configured'
  | 'unavailable'
  /** 能力探测（IPC）本身失败，配置状态未知，不代表"已配置但不可用"。 */
  | 'probe_failed';

/** 一次性运行时能力快照；不缓存临时错误。 */
export interface MultimodalCapabilityStatus {
  /** 能力探测是否成功返回。false 时 configured/available 均为保守值，状态未知。 */
  probed: boolean;
  configured: boolean;
  available: boolean;
  reason: MultimodalCapabilityReason;
  error?: string;
  /** 后端同一时刻冻结的 ME 路由状态（probe_failed 时缺省）。 */
  capability?: VfsCapabilityState;
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
    topK: config?.topK,
    folderIds: config?.folderIds,
    resourceIds: config?.resourceIds,
    resourceTypes: config?.resourceTypes,
  });

  return results.map(toRetrievalResult);
}

function toRetrievalResult(result: VfsMultimodalSearchOutput): MultimodalRetrievalResult {
  const provenance = parseRetrievalProvenance(result.retrievalProvenance);
  return {
    source_type: normalizeSourceType(result.resourceType),
    source_id: result.resourceId,
    embedding_id: result.embeddingId,
    page_index: result.pageIndex,
    text_content: result.textContent,
    blob_hash: result.blobHash,
    folder_id: result.folderId,
    score: result.score,
    source: deriveRetrievalSource(provenance),
    retrieval_provenance: provenance,
  };
}

/** 命中全部来自文本路由时视为 text_chunk；含多模态路由或无来源信息时保守视为页面级命中。 */
function deriveRetrievalSource(provenance: VfsRetrievalHitProvenance[]): RetrievalSource {
  if (provenance.length === 0) return 'multimodal_page';
  const textOnly = provenance.every(
    (entry) => entry.routeKind === 'text_embedding' || entry.routeKind === 'full_text'
  );
  return textOnly ? 'text_chunk' : 'multimodal_page';
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
      return { probed: true, configured: false, available: false, reason: 'not_configured', capability };
    }

    const available = capability.healthy
      && !capability.circuitOpen
      && capability.protocolCompatible
      && capability.indexCompatible;
    return {
      probed: true,
      configured: true,
      available,
      reason: available ? 'ready' : 'unavailable',
      capability,
      ...(available || !capability.reason ? {} : { error: capability.reason }),
    };
  } catch (error: unknown) {
    // IPC/探测失败 ≠ "已配置但不可用"：configured 状态未知，用 probe_failed 区分。
    return {
      probed: false,
      configured: false,
      available: false,
      reason: 'probe_failed',
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
  folderId?: string,
  forceRebuild?: boolean
): Promise<VfsMultimodalIndexResourceOutput> {
  return vfsIndexResourceBySource('exam', examId, folderId, forceRebuild);
}

/**
 * 索引教材
 */
export async function indexTextbook(
  textbookId: string,
  folderId?: string,
  forceRebuild?: boolean
): Promise<VfsMultimodalIndexResourceOutput> {
  return vfsIndexResourceBySource('textbook', textbookId, folderId, forceRebuild);
}

/**
 * 索引附件
 */
export async function indexAttachment(
  attachmentId: string,
  folderId?: string,
  forceRebuild?: boolean
): Promise<VfsMultimodalIndexResourceOutput> {
  return vfsIndexResourceBySource('attachment', attachmentId, folderId, forceRebuild);
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
