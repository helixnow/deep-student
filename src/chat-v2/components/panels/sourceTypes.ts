/**
 * Chat V2 - Source Panel 类型定义
 *
 * 本地定义 UnifiedSource 相关类型，消除对 @/chat-core 的依赖
 */

// ============================================================================
// RAG 来源信息（与 chat-core 保持兼容）
// ============================================================================

export interface RagSourceInfo {
  document_id: string;
  file_name: string;
  chunk_text: string;
  score: number;
  chunk_index: number;
  origin?: string;
  provider_id?: string;
  provider_label?: string;
  provider_icon?: string;
  provider_group?: string;
  source_type?: string;
  source_id?: string;
  url?: string;
  problem_id?: string;
  stage?: string;
}

// ============================================================================
// 多模态来源信息（Multimodal RAG）
// ============================================================================

/** 多模态来源类型 */
export type MultimodalSourceType = 'attachment' | 'exam' | 'textbook';

/** 多模态检索结果来源 */
export type MultimodalRetrievalSource = 'multimodal_page' | 'text_chunk';

/** 多模态来源信息 */
export interface MultimodalSourceInfo {
  /** 来源类型 */
  source_type: MultimodalSourceType;
  /** 来源资源 ID */
  source_id: string;
  /** 页码（页面级结果） */
  page_index?: number;
  /** 块索引（段落级结果） */
  chunk_index?: number;
  /** 文本内容 */
  text_content?: string;
  /** 缩略图 Base64（可选） */
  thumbnail_base64?: string;
  /** Blob 哈希（用于加载原图） */
  blob_hash?: string;
  /** 相关性分数 */
  score: number;
  /** 结果来源 */
  retrieval_source: MultimodalRetrievalSource;
}

// ============================================================================
// 统一来源展示类型
// ============================================================================

/**
 * 单个来源项
 */
export interface UnifiedSourceItem {
  id: string;
  title: string;
  snippet: string;
  score?: number;
  link?: string;
  origin: 'rag' | 'memory' | 'web_search' | 'tool' | 'multimodal' | string;
  providerId: string;
  providerLabel: string;
  providerIcon?: string;
  raw: RagSourceInfo;
  /** 图片 URL（后端返回的 imageUrl 字段） */
  imageUrl?: string;
  /** 图片引用 Markdown（后端返回的 imageCitation 字段） */
  imageCitation?: string;
  /** VFS 资源 ID（用于获取 PDF 页面图片，格式 res_xxx） */
  resourceId?: string;
  /** DSTU 资源 ID（用于打开预览器，格式 tb_xxx/note_xxx 等） */
  sourceId?: string;
  /** 页码（0-indexed，用于获取 PDF 页面图片） */
  pageIndex?: number;
  /** 资源类型（textbook/attachment/exam 等） */
  resourceType?: string;
  /** 多模态扩展信息（可选） */
  multimodal?: {
    /** 来源类型 */
    sourceType: MultimodalSourceType;
    /** 来源资源 ID */
    sourceId: string;
    /** 页码 */
    pageIndex?: number;
    /** 缩略图 Base64 */
    thumbnailBase64?: string;
    /** Blob 哈希（用于加载原图） */
    blobHash?: string;
    /** 检索来源 */
    retrievalSource: MultimodalRetrievalSource;
  };
}

/**
 * 来源分组
 */
export interface UnifiedSourceGroup {
  group: 'rag' | 'memory' | 'web_search' | 'tool' | 'multimodal' | string;
  providerId: string;
  providerLabel: string;
  providerIcon?: string;
  count: number;
  items: UnifiedSourceItem[];
}

/**
 * 统一来源包
 */
export interface UnifiedSourceBundle {
  total: number;
  groups: UnifiedSourceGroup[];
  stage?: string;
}
