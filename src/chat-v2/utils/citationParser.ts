/**
 * Chat V2 - 引用解析工具
 *
 * 解析 LLM 回复中的引用标记（如 [知识库-1]、[记忆-2] 等）
 * 与后端 prompt_builder.rs 中的 CITATION_GUIDE 格式对应
 */

import i18next from 'i18next';
import type { RetrievalSourceType } from '../plugins/blocks/components/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 解析后的引用信息
 */
export interface ParsedCitation {
  /** 完整匹配文本，如 "[知识库-1]" 或 "[知识库-1:图片]" */
  fullMatch: string;
  /** 来源类型文本，如 "知识库" */
  typeText: string;
  /** 来源类型枚举 */
  type: RetrievalSourceType;
  /** 引用索引（从 1 开始） */
  index: number;
  /** 在原文中的起始位置 */
  start: number;
  /** 在原文中的结束位置 */
  end: number;
  /** 是否显示图片（当引用格式为 [类型-N:图片] 时为 true） */
  showImage?: boolean;
}

/**
 * 引用渲染回调参数
 */
export interface CitationRenderInfo {
  /** 引用信息 */
  citation: ParsedCitation;
  /** React key */
  key: string;
}

// ============================================================================
// 常量定义
// ============================================================================

/**
 * 引用类型文本到枚举的映射
 * 与后端 prompt_builder.rs 中的 SourceType::label() 对应
 * 
 * ★ 2026-01 清理：移除"错题"映射（错题系统废弃）
 */
export const CITATION_TYPE_MAP: Record<string, RetrievalSourceType> = {
  '知识库': 'rag',
  '记忆': 'memory',
  '搜索': 'web_search',
  '图片': 'multimodal',
  // 英文支持
  'knowledge': 'rag',
  'Knowledge Base': 'rag',
  'knowledge base': 'rag',
  'memory': 'memory',
  'Memory': 'memory',
  'search': 'web_search',
  'Search': 'web_search',
  'web': 'web_search',
  'Web': 'web_search',
  'image': 'multimodal',
  'Image': 'multimodal',
};

/**
 * 引用正则表达式
 * 匹配格式：[类型-数字] 或 [类型-数字:图片]
 * 支持中文和英文类型名称
 * 可选的 :图片/:image 后缀用于显式请求渲染图片
 * 
 * ★ 2026-01 清理：移除"错题/graph/Knowledge Graph"匹配（错题系统废弃）
 */
const CITATION_PATTERN = /\[(知识库|记忆|搜索|图片|knowledge|Knowledge Base|memory|Memory|search|Search|web|Web|image|Image)-(\d+)(?::(图片|image))?\]/gi;

// ============================================================================
// 核心解析函数
// ============================================================================

/**
 * 解析文本中的所有引用标记
 *
 * @param text - 待解析的文本
 * @returns 解析出的引用列表（按位置排序）
 */
export function parseCitations(text: string): ParsedCitation[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const citations: ParsedCitation[] = [];
  let match: RegExpExecArray | null;

  // 重置正则表达式状态
  CITATION_PATTERN.lastIndex = 0;

  while ((match = CITATION_PATTERN.exec(text)) !== null) {
    const typeText = match[1];
    const type = CITATION_TYPE_MAP[typeText];
    const imageSuffix = match[3]; // 可选的 :图片 或 :image 后缀

    if (type) {
      citations.push({
        fullMatch: match[0],
        typeText,
        type,
        index: parseInt(match[2], 10),
        start: match.index,
        end: match.index + match[0].length,
        showImage: !!imageSuffix, // 有 :图片/:image 后缀时为 true
      });
    }
  }

  // 按位置排序
  return citations.sort((a, b) => a.start - b.start);
}

/**
 * 检查文本是否包含引用标记
 *
 * @param text - 待检查的文本
 * @returns 是否包含引用
 */
export function hasCitations(text: string): boolean {
  if (!text || typeof text !== 'string') {
    return false;
  }
  // 重置正则表达式状态
  CITATION_PATTERN.lastIndex = 0;
  return CITATION_PATTERN.test(text);
}

/**
 * 统计文本中的引用数量
 *
 * @param text - 待统计的文本
 * @returns 引用数量
 */
export function countCitations(text: string): number {
  return parseCitations(text).length;
}

// ============================================================================
// 文本分段函数
// ============================================================================

/**
 * 文本段类型
 */
export type TextSegment =
  | { type: 'text'; content: string; key: string }
  | { type: 'citation'; citation: ParsedCitation; key: string };

/**
 * 将文本按引用标记分段
 *
 * @param text - 待分段的文本
 * @returns 分段列表（交替的文本段和引用段）
 */
export function segmentTextByCitations(text: string): TextSegment[] {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const citations = parseCitations(text);
  if (citations.length === 0) {
    return [{ type: 'text', content: text, key: 'text-0' }];
  }

  const segments: TextSegment[] = [];
  let lastEnd = 0;

  citations.forEach((citation, index) => {
    // 添加引用前的文本
    if (citation.start > lastEnd) {
      const textContent = text.slice(lastEnd, citation.start);
      if (textContent) {
        segments.push({
          type: 'text',
          content: textContent,
          key: `text-${index}`,
        });
      }
    }

    // 添加引用段
    segments.push({
      type: 'citation',
      citation,
      key: `cite-${index}`,
    });

    lastEnd = citation.end;
  });

  // 添加最后的文本
  if (lastEnd < text.length) {
    const remainingText = text.slice(lastEnd);
    if (remainingText) {
      segments.push({
        type: 'text',
        content: remainingText,
        key: `text-last`,
      });
    }
  }

  return segments;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 获取引用类型的显示名称
 *
 * @param type - 引用类型
 * @param t - i18n 翻译函数
 * @returns 显示名称
 */
export function getCitationTypeLabel(
  type: RetrievalSourceType,
  t?: (key: string) => string
): string {
  if (t) {
    const i18nKey = `chatV2:citation.${type}`;
    const translated = t(i18nKey);
    if (translated !== i18nKey) {
      return translated;
    }
  }

  // Fallback labels using i18n
  // ★ 2026-01 清理：移除 graph 标签（错题系统废弃）
  const labels: Record<RetrievalSourceType, string> = {
    rag: i18next.t('chatV2:citation.rag'),
    memory: i18next.t('chatV2:citation.memory'),
    web_search: i18next.t('chatV2:citation.web_search'),
    multimodal: i18next.t('chatV2:citation.multimodal'),
  };

  return labels[type] || type;
}

/**
 * 生成引用 ID
 * 用于在 DOM 中定位引用对应的来源
 *
 * @param type - 引用类型
 * @param index - 引用索引
 * @returns 引用 ID
 */
export function generateCitationId(type: RetrievalSourceType, index: number): string {
  return `citation-${type}-${index}`;
}

/**
 * 从引用 ID 解析类型和索引
 *
 * @param citationId - 引用 ID
 * @returns 类型和索引，如果无效返回 null
 */
export function parseCitationId(citationId: string): { type: RetrievalSourceType; index: number } | null {
  const match = citationId.match(/^citation-(\w+)-(\d+)$/);
  if (!match) return null;

  const type = match[1] as RetrievalSourceType;
  const index = parseInt(match[2], 10);

  // 验证类型是否有效
  // ★ 2026-01 清理：移除 graph 类型（错题系统废弃）
  const validTypes: RetrievalSourceType[] = ['rag', 'memory', 'web_search', 'multimodal'];
  if (!validTypes.includes(type)) return null;

  return { type, index };
}
