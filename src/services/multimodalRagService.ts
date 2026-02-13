/**
 * 多模态 RAG 服务
 *
 * 封装多模态知识库的 Tauri 命令调用，提供类型安全的接口。
 *
 * 设计文档: docs/multimodal-user-memory-design.md (Section 8.3)
 */

// ============================================================================
// ★ 多模态索引功能开关
// 当前禁用。设为 true 可启用多模态向量化索引（需配合 VL-Embedding 模型）。
// 相关 UI 和逻辑通过此开关统一控制。
// ============================================================================
export const MULTIMODAL_INDEX_ENABLED = false;

import { invoke } from '@tauri-apps/api/core';
import {
  vfsMultimodalIndex,
  vfsMultimodalSearch,
  vfsMultimodalStats,
  vfsMultimodalDelete,
  vfsMultimodalIndexResource,
  type VfsMultimodalIndexInput,
  type VfsMultimodalIndexOutput,
  type VfsMultimodalSearchInput,
  type VfsMultimodalSearchOutput,
  type VfsMultimodalStats,
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
// ★ 旧 API 已废弃（2026-01），请使用 VFS API
// 保留部分仍有调用方的函数（isConfigured / retrieve），其余已移除
// ============================================================================

/**
 * @deprecated 已废弃，请使用 vfsSearch
 */
export async function retrieve(
  _queryText?: string,
  _queryImageBase64?: string,
  _queryImageMediaType?: string,
  _config?: RetrievalConfig
): Promise<MultimodalRetrievalResult[]> {
  throw new Error('[DEPRECATED] retrieve 已废弃，请使用 vfsSearch');
}

/**
 * @deprecated 已废弃
 */
export async function isConfigured(): Promise<boolean> {
  throw new Error('[DEPRECATED] isConfigured 已废弃');
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
  // ★ 多模态索引已禁用，静默返回空结果
  if (!MULTIMODAL_INDEX_ENABLED) {
    return { indexedPages: 0, dimension: 0, failedPages: [] };
  }
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
  // ★ 多模态索引已禁用，静默返回空结果
  if (!MULTIMODAL_INDEX_ENABLED) {
    return [];
  }
  return vfsMultimodalSearch(input);
}

/**
 * 获取 VFS 多模态统计
 */
export async function vfsGetStats(): Promise<VfsMultimodalStats> {
  // ★ 多模态索引已禁用，静默返回空结果
  if (!MULTIMODAL_INDEX_ENABLED) {
    return { totalRecords: 0, dimensions: [] };
  }
  return vfsMultimodalStats();
}

/**
 * 删除 VFS 多模态索引
 */
export async function vfsDeleteIndex(resourceId: string): Promise<void> {
  // ★ 多模态索引已禁用，静默跳过
  if (!MULTIMODAL_INDEX_ENABLED) {
    return;
  }
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
  // ★ 多模态索引已禁用，静默返回空结果
  if (!MULTIMODAL_INDEX_ENABLED) {
    return { indexedPages: 0, dimension: 0, failedPages: [] };
  }
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
  vfsGetStats,
  vfsDeleteIndex,
  vfsIndexResourceBySource,
};

export default multimodalRagService;
