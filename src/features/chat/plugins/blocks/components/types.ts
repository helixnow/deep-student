/**
 * Chat V2 - 知识检索块类型定义
 *
 * 定义检索块共享的数据类型
 */

// ============================================================================
// 后端来源类型（与后端 SourceInfo 对齐）
// ============================================================================

/**
 * 后端 SourceInfo 类型（与 Rust types.rs 中的 SourceInfo 对齐）
 * 注意：后端没有 id 和 type 字段
 */
export interface BackendSourceInfo {
  title?: string;
  url?: string;
  snippet?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 通用来源类型
// ============================================================================

/**
 * 检索来源类型
 * ★ 2026-01 清理：移除 'graph' 类型（错题系统废弃）
 */
export type RetrievalSourceType = 'rag' | 'memory' | 'web_search' | 'multimodal';

/**
 * 检索来源（前端使用）
 */
export interface RetrievalSource {
  /** 来源 ID */
  id: string;
  /** 来源类型 */
  type: RetrievalSourceType;
  /** 来源标题 */
  title: string;
  /** 内容片段 */
  snippet: string;
  /** URL 或文件路径 */
  url?: string;
  /** 相关度分数 (0-1) */
  score?: number;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// 数据转换工具
// ============================================================================

/**
 * 将后端 SourceInfo 转换为前端 RetrievalSource
 *
 * 补充缺失的 id 和 type 字段
 *
 * @param source - 后端 SourceInfo
 * @param type - 来源类型（从块类型推断）
 * @param blockId - 块 ID（用于生成稳定的来源 ID）
 * @param index - 来源索引（从 0 开始）
 */
export function convertBackendSource(
  source: BackendSourceInfo,
  type: RetrievalSourceType,
  blockId: string,
  index: number
): RetrievalSource {
  return {
    id: `${blockId}-source-${index}`,
    type,
    // 标题为空时，由 SourceCard 组件使用 i18n 显示默认标题
    // 传递 _fallbackIndex 供组件使用（从 1 开始，用户友好）
    title: source.title || '',
    snippet: source.snippet || '',
    url: source.url,
    score: source.score,
    metadata: {
      ...source.metadata,
      _fallbackIndex: index + 1, // 用于在 UI 层显示默认标题
    },
  };
}

/**
 * 批量转换后端 SourceInfo 数组
 *
 * @param sources - 后端 SourceInfo 数组（可能为空或 undefined）
 * @param type - 来源类型
 * @param blockId - 块 ID
 */
export function convertBackendSources(
  sources: BackendSourceInfo[] | undefined,
  type: RetrievalSourceType,
  blockId: string
): RetrievalSource[] {
  if (!sources || !Array.isArray(sources)) {
    return [];
  }
  return sources
    .filter((source): source is BackendSourceInfo => source != null) // 过滤 null/undefined 元素
    .map((source, index) => convertBackendSource(source, type, blockId, index));
}

// ============================================================================
// RAG 块数据
// ============================================================================

/**
 * RAG 文档知识库块数据
 */
export interface RagBlockData {
  /** 检索到的来源列表 */
  sources: RetrievalSource[];
  /** 检索查询 */
  query: string;
  /** 总结果数（可能被截断） */
  totalResults: number;
}

// ============================================================================
// Memory 块数据
// ============================================================================

/**
 * 记忆类型
 */
export type MemoryType = 'conversation' | 'long_term' | 'user_profile';

/**
 * 用户记忆块数据
 */
export interface MemoryBlockData {
  /** 检索到的来源列表 */
  sources: RetrievalSource[];
  /** 记忆类型 */
  memoryType: MemoryType;
}

// ============================================================================
// WebSearch 块数据
// ============================================================================

/**
 * 网络搜索块数据
 */
export interface WebSearchBlockData {
  /** 检索到的来源列表 */
  sources: RetrievalSource[];
  /** 搜索引擎 */
  searchEngine: string;
  /** 搜索查询 */
  query: string;
  /** 总结果数 */
  totalResults: number;
}
