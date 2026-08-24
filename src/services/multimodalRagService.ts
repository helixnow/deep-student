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
import i18n from '@/i18n';

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
 * 后端 `VfsMultimodalSearchOutput`（扁平命中 DTO，src-tauri/src/vfs/handlers.rs）
 * 或 `VfsUnifiedRetrievalHit`（detailed 命中）的 snake_case 视图。
 *
 * ★ 2026-07 语义修正：resource_id 与 source_id 拆分为两个字段，消费方
 * （如 sourceAdapter.ts）应按语义取用，不要再假设 source_id 一定是业务 ID：
 * - resource_id：VFS 资源主键（res_xxx），恒有值，用于 getPdfPageImage 等资源级 API；
 * - source_id：业务来源 ID（textbook_xxx / exam_xxx / att_xxx）。仅 retrieveDetailed /
 *   vfsSearchDetailed 路线能拿到真实业务 ID；扁平路线（retrieve/searchByText 等）
 *   后端 DTO 不携带业务 ID，此时 source_id 回退为 resource_id（与旧行为兼容）。
 */
export interface MultimodalRetrievalResult {
  /** 来源类型 */
  source_type: SourceType;
  /**
   * 业务来源 ID（如 textbook_xxx）。
   *
   * 扁平检索路线（vfs_multimodal_search）后端不携带业务 ID，该字段回退为
   * resource_id；需要保证真实业务 ID 时请使用 retrieveDetailed。
   */
  source_id: string;
  /** ★ VFS 资源主键（res_xxx），恒有值 */
  resource_id: string;
  /** Lance 嵌入记录 ID */
  embedding_id: string;
  /**
   * 页码（0-indexed）。
   *
   * 跨层约定：扁平路线后端为必填 i32，恒有值；detailed 路线的纯文本命中
   * （text_chunk）可能没有页码，此时为 undefined。统一按可选处理。
   */
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

/** 将旧签名参数规整为 VfsMultimodalSearchInput（retrieve/retrieveDetailed 共用）。 */
function buildLegacySearchInput(
  queryText?: string,
  queryImageBase64?: string,
  queryImageMediaType?: string,
  config?: RetrievalConfig
): VfsMultimodalSearchInput {
  const hasText = Boolean(queryText?.trim());
  const hasImage = Boolean(queryImageBase64?.trim());
  if (!hasText && !hasImage) {
    throw new Error(
      i18n.t('enhanced_rag:retrieve.empty_query', { defaultValue: '检索请求必须包含文本、图片或两者' })
    );
  }

  const queryMode: VfsMultimodalQueryMode = hasText && hasImage
    ? 'mixed'
    : hasImage ? 'image' : 'text';
  return {
    query: queryText ?? '',
    queryText,
    queryImageBase64,
    queryImageMediaType,
    queryMode,
    topK: config?.topK,
    folderIds: config?.folderIds,
    resourceIds: config?.resourceIds,
    resourceTypes: config?.resourceTypes,
  };
}

/**
 * @deprecated 新调用方请直接使用 vfsSearch；需要真实业务 source_id 时使用 retrieveDetailed。
 */
export async function retrieve(
  queryText?: string,
  queryImageBase64?: string,
  queryImageMediaType?: string,
  config?: RetrievalConfig
): Promise<MultimodalRetrievalResult[]> {
  const results = await vfsSearch(
    buildLegacySearchInput(queryText, queryImageBase64, queryImageMediaType, config)
  );
  return results.map(toRetrievalResult);
}

/**
 * 与 retrieve 同形的检索入口，但走 detailed 后端命令，能填充真实业务 source_id
 * （textbook_xxx / exam_xxx / att_xxx），并保留 resource_id（res_xxx）。
 *
 * 消费方需要"业务 ID + 资源 ID"双字段语义（如来源面板定位）时使用本函数。
 */
export async function retrieveDetailed(
  queryText?: string,
  queryImageBase64?: string,
  queryImageMediaType?: string,
  config?: RetrievalConfig
): Promise<MultimodalRetrievalResult[]> {
  const detailed = await vfsSearchDetailed(
    buildLegacySearchInput(queryText, queryImageBase64, queryImageMediaType, config)
  );
  return detailed.result.hits.map(({ hit, rrfScore, provenance }) => ({
    source_type: normalizeSourceType(hit.resourceType ?? ''),
    source_id: hit.sourceId ?? hit.identity.resourceId,
    resource_id: hit.identity.resourceId,
    embedding_id: hit.embeddingId,
    // detailed 路线的纯文本命中可能没有页码（见 MultimodalRetrievalResult.page_index）
    page_index: hit.identity.pageIndex,
    text_content: hit.text || undefined,
    blob_hash: hit.blobHash,
    folder_id: hit.folderId,
    score: rrfScore,
    source: deriveRetrievalSource(provenance),
    retrieval_provenance: provenance,
  }));
}

function toRetrievalResult(result: VfsMultimodalSearchOutput): MultimodalRetrievalResult {
  const provenance = parseRetrievalProvenance(result.retrievalProvenance);
  return {
    source_type: normalizeSourceType(result.resourceType),
    // 扁平 DTO 不携带业务 sourceId，source_id 回退为 resource_id（见接口注释）
    source_id: result.resourceId,
    resource_id: result.resourceId,
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

/**
 * 多模态路线是否"就绪可用"。
 *
 * ★ 语义修正：本函数回答的是 ready（已配置且当前可用），不是字面上的
 * "是否已配置"。probe_failed（探测 IPC 失败、状态未知）与 not_configured/
 * unavailable 一样返回 false；需要区分三态的调用方请改用
 * getCapabilityStatus / getCapabilityStatusCached 读取 reason 字段。
 *
 * @deprecated 语义容易误读，新代码请使用 getCapabilityStatusCached。
 */
export async function isConfigured(): Promise<boolean> {
  const status = await getCapabilityStatusCached();
  return status.reason === 'ready';
}

// ============================================================================
// CapabilityStore：能力探测共享缓存（TTL + 事件失效）
// ============================================================================

/** 能力快照缓存 TTL。探测是一次 IPC + 后端只读快照，30s 内复用足够新鲜。 */
const CAPABILITY_CACHE_TTL_MS = 30_000;

interface CapabilityCacheEntry {
  status: MultimodalCapabilityStatus;
  expiresAt: number;
}

let capabilityCache: CapabilityCacheEntry | null = null;
/** 进行中的探测请求：并发调用方共享同一 Promise，避免探测风暴。 */
let capabilityInflight: Promise<MultimodalCapabilityStatus> | null = null;
const capabilityListeners = new Set<(status: MultimodalCapabilityStatus) => void>();

/**
 * 手动失效能力缓存（例如模型分配刚变更、供应商配置刚保存时）。
 *
 * 模块加载后会自动订阅 window 的 `model_assignments_changed` 事件
 * （autoAssignModel/设置页保存后广播），一般无需手动调用。
 */
export function invalidateCapabilityCache(): void {
  capabilityCache = null;
}

/**
 * 订阅能力快照更新（每次真实探测完成后回调，缓存命中不回调）。
 *
 * @returns 取消订阅函数
 */
export function subscribeCapabilityStatus(
  listener: (status: MultimodalCapabilityStatus) => void
): () => void {
  capabilityListeners.add(listener);
  return () => capabilityListeners.delete(listener);
}

/**
 * 带共享缓存的能力探测（推荐入口）。
 *
 * - 30s TTL 内直接返回缓存快照；
 * - 并发调用共享同一 in-flight 探测；
 * - probe_failed（临时 IPC 故障）不进缓存，下次调用会重新探测；
 * - `model_assignments_changed` 事件自动失效缓存。
 *
 * 供 exam 进度自动索引、教材导入、检索 Hook 等多处消费，避免各自
 * 高频调用 vfs_inspect_retrieval_capabilities。
 */
export async function getCapabilityStatusCached(
  options?: { forceRefresh?: boolean }
): Promise<MultimodalCapabilityStatus> {
  if (!options?.forceRefresh && capabilityCache && Date.now() < capabilityCache.expiresAt) {
    return capabilityCache.status;
  }
  if (capabilityInflight) {
    return capabilityInflight;
  }

  capabilityInflight = getCapabilityStatus()
    .then((status) => {
      // 只缓存成功探测的结果；probe_failed 是临时故障，不应粘滞 30s
      if (status.probed) {
        capabilityCache = { status, expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS };
      }
      for (const listener of capabilityListeners) {
        try {
          listener(status);
        } catch {
          // 监听器异常不影响其他消费方
        }
      }
      return status;
    })
    .finally(() => {
      capabilityInflight = null;
    });

  return capabilityInflight;
}

// 模型分配变更（autoAssignModel.broadcastModelAssignmentsChange / 设置页）后
// 能力快照必然过期，自动失效缓存。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('model_assignments_changed', invalidateCapabilityCache);
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
