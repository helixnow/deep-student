/**
 * Chat V2 - 上下文类型定义 - 检索结果 (Retrieval)
 *
 * 系统检索结果类型，包括 RAG、Memory、Graph、Web Search
 *
 * 优先级: 50（最低）
 * XML 标签: <reference>
 * 关联工具: 无（检索工具由系统管理，不通过上下文关联）
 */

import type { ContextTypeDefinition, Resource, ContentBlock } from '../types';
import { createXmlTextBlock, createTextBlock } from '../types';
import { t } from '@/utils/i18n';

/**
 * 检索来源类型
 */
export type RetrievalSource = 'rag' | 'memory' | 'graph' | 'web_search';

/**
 * 检索结果元数据类型
 */
export interface RetrievalMetadata {
  /** 检索来源 */
  source?: RetrievalSource;
  /** 标题 */
  title?: string;
  /** URL（网页搜索结果） */
  url?: string;
  /** 相关度分数 */
  score?: number;
  /** 文档 ID */
  documentId?: string;
  /** 片段索引 */
  chunkIndex?: number;
}

/**
 * 获取来源的显示标签
 */
function getSourceLabel(source?: RetrievalSource): string {
  switch (source) {
    case 'rag':
      return 'Knowledge Base';
    case 'memory':
      return 'Memory';
    case 'graph':
      return 'Knowledge Graph';
    case 'web_search':
      return 'Web Search';
    default:
      return 'Reference';
  }
}

/**
 * 检索结果类型定义
 */
export const retrievalDefinition: ContextTypeDefinition = {
  typeId: 'retrieval',
  xmlTag: 'reference',
  get label() { return t('contextDef.retrieval.label', {}, 'chatV2'); },
  labelEn: 'Reference',
  priority: 50,
  tools: [], // 检索工具由系统管理

  // System Prompt 中的标签格式说明
  // 注意：RAG 检索结果通常由后端直接注入 System Prompt 的 <context> 块
  // 此 hint 用于前端手动添加 retrieval 类型上下文的场景
  systemPromptHint:
    '<reference source="..." title="..." relevance="...">参考内容</reference> - ' +
    '检索到的参考资料，可能来自知识库、记忆、知识图谱或网络搜索',

  formatToBlocks(resource: Resource): ContentBlock[] {
    const metadata = resource.metadata as RetrievalMetadata | undefined;
    const source = metadata?.source;
    const title = metadata?.title;
    const url = metadata?.url;
    const score = metadata?.score;

    // 构建属性
    const attrs: Record<string, string | undefined> = {};

    if (source) {
      attrs.source = getSourceLabel(source);
    }
    if (title) {
      attrs.title = title;
    }
    if (url) {
      attrs.url = url;
    }
    if (score !== undefined) {
      attrs.relevance = `${Math.round(score * 100)}%`;
    }
    if (resource.sourceId) {
      attrs['source-id'] = resource.sourceId;
    }

    // 检查数据是否为空
    if (!resource.data) {
      return [createTextBlock(`<reference title="${title || 'Unknown'}">[Content not available]</reference>`)];
    }

    return [createXmlTextBlock('reference', resource.data, attrs)];
  },
};

/**
 * 检索类型 ID 常量
 */
export const RETRIEVAL_TYPE_ID = 'retrieval' as const;

/**
 * 检索来源列表
 */
export const RETRIEVAL_SOURCES: RetrievalSource[] = ['rag', 'memory', 'graph', 'web_search'];

/**
 * 检查是否为有效的检索来源
 */
export function isValidRetrievalSource(source: string): source is RetrievalSource {
  return RETRIEVAL_SOURCES.includes(source as RetrievalSource);
}
