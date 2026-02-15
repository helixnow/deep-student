/**
 * Chat V2 - Source Adapter
 *
 * 将 V2 块数据转换为 UnifiedSourcePanel 期望的 UnifiedSourceBundle 格式。
 * 实现 V2 Store 与旧展示组件的数据桥接。
 *
 * 设计原则：
 * - 仅在块 status === 'success' 时提取来源
 * - 按 origin + providerId 分组，支持多 provider 场景
 * - ID 基于块 ID 生成，保证稳定性
 */

import type { Block, Citation } from '../../core/types/block';
// 使用本地类型定义，与 UnifiedSourcePanel 保持一致
import type {
  UnifiedSourceBundle,
  UnifiedSourceGroup,
  UnifiedSourceItem,
  RagSourceInfo,
  MultimodalSourceType,
  MultimodalRetrievalSource,
} from './sourceTypes';

// ============================================================================
// Citation 类型到 Group 类型映射
// ============================================================================

/**
 * V2 Citation type 到 UnifiedSourceGroup group 的映射
 * ★ 2026-01 扩展：支持多模态和搜索引用类型
 */
const CITATION_TYPE_TO_GROUP: Record<Citation['type'], string> = {
  rag: 'rag',
  memory: 'memory',
  web: 'web_search',
  multimodal: 'multimodal',
  image: 'multimodal',
  search: 'web_search',
};

/**
 * 知识检索块类型列表
 */
const KNOWLEDGE_RETRIEVAL_BLOCK_TYPES = ['rag', 'memory', 'web_search', 'multimodal_rag', 'academic_search'] as const;

/**
 * 检查是否为知识检索块类型
 */
function isKnowledgeRetrievalBlock(blockType: string): boolean {
  return KNOWLEDGE_RETRIEVAL_BLOCK_TYPES.includes(blockType as typeof KNOWLEDGE_RETRIEVAL_BLOCK_TYPES[number]);
}

/**
 * Provider Label 的 i18n 键映射
 * 实际翻译由调用方通过 t() 函数完成
 */
export const PROVIDER_LABEL_I18N_KEYS: Record<string, string> = {
  rag: 'common:chat.sources.providers.localRag',
  memory: 'common:chat.sources.providers.userMemory',
  web_search: 'common:chat.sources.providers.webSearch',
  mcp_tool: 'common:chat.sources.providers.mcpTool',
  multimodal_rag: 'common:chat.sources.providers.multimodalRag',
  unified_search: 'common:chat.sources.providers.unifiedSearch',
  academic_search: 'common:chat.sources.providers.academicSearch',
};

// ============================================================================
// 核心转换函数
// ============================================================================

/**
 * 将 V2 块数组转换为 UnifiedSourceBundle
 *
 * @param blocks - V2 块数组（通常是单条消息的所有块）
 * @returns UnifiedSourceBundle 或 null（无来源时）
 */
export function blocksToSourceBundle(blocks: Block[]): UnifiedSourceBundle | null {
  // 收集所有来源项
  const allItems: UnifiedSourceItem[] = [];

  for (const block of blocks) {
    // 1. 从 citations 字段提取（数据契约的正确方式）
    if (block.citations && block.citations.length > 0) {
      const items = citationsToSourceItems(block.citations, block.id, block.type);
      allItems.push(...items);
    }
    // 2. 从 toolOutput 提取（当前 retrieval.ts 的实现方式）
    // 知识检索块（rag, memory, web_search, multimodal_rag）的结果可能存在 toolOutput 中
    else if (isKnowledgeRetrievalBlock(block.type) && block.toolOutput) {
      const items = retrievalOutputToSourceItems(block);
      allItems.push(...items);
    }

    // 3. 从 toolOutput 提取（MCP 工具块可能包含来源）
    if (block.type === 'mcp_tool' && block.toolOutput) {
      const items = toolOutputToSourceItems(block);
      allItems.push(...items);
    }
  }

  // 无来源时返回 null
  if (allItems.length === 0) {
    return null;
  }

  // 按来源类型分组
  const groups = groupSourceItems(allItems);

  return {
    total: allItems.length,
    groups,
  };
}

/**
 * 将 V2 Citation 数组转换为 UnifiedSourceItem 数组
 *
 * @param citations - Citation 数组
 * @param blockId - 块 ID（用于生成稳定的 item ID）
 * @param blockType - 块类型（用于在 citation.type 缺失时推断类型）
 */
function citationsToSourceItems(
  citations: Citation[],
  blockId: string,
  blockType: string
): UnifiedSourceItem[] {
  return citations.map((citation, index) => {
    // 🔧 防御性处理：如果 citation.type 缺失，从 blockType 推断
    // 这可以处理后端 SourceInfo 被错误地当作 Citation 使用的情况
    let groupType: string;
    if (citation.type && CITATION_TYPE_TO_GROUP[citation.type]) {
      groupType = CITATION_TYPE_TO_GROUP[citation.type];
    } else {
      // 从 blockType 推断
      groupType = blockType;
    }
    const providerId = getProviderIdFromBlockType(blockType);
    // 注意：providerLabel 返回 i18n key，由 UI 组件翻译
    const providerLabelKey = getProviderLabelKey(blockType);

    // 构造原始 RagSourceInfo（用于兼容旧 UnifiedSourcePanel）
    const raw: RagSourceInfo = {
      document_id: groupType === 'memory' ? '' : `${blockId}-${index}`,
      file_name: citation.title || '',
      chunk_text: citation.snippet || '',
      score: citation.score || 0,
      chunk_index: index,
      origin: groupType,
      provider_id: providerId,
      provider_label: providerLabelKey,
      url: citation.url,
    };

    return {
      // 使用 blockId + index 生成稳定 ID，避免重渲染问题
      id: `${blockId}-citation-${index}`,
      title: citation.title || getDefaultTitleKey(blockType, index),
      snippet: citation.snippet || '',
      score: citation.score,
      link: citation.url,
      origin: groupType as UnifiedSourceItem['origin'],
      providerId,
      providerLabel: providerLabelKey,
      raw,
    };
  });
}

/**
 * 从知识检索块的 toolOutput 提取来源项
 *
 * 后端 retrieval.ts 将检索结果存储在 toolOutput 中（而非 citations）
 * 这是一个兼容层，处理多种可能的数据格式：
 * 1. { citations: Citation[] } - 包含 citations 数组
 * 2. SourceInfo[] - 直接是来源数组
 * 3. { items: SourceInfo[] } - 包含 items 数组
 *
 * @param block - 知识检索块（rag, memory, web_search, multimodal_rag）
 */
function retrievalOutputToSourceItems(block: Block): UnifiedSourceItem[] {
  const items: UnifiedSourceItem[] = [];
  const output = block.toolOutput;

  if (!output) {
    return items;
  }

  // 提取来源数据（支持多种格式）
  let sources: Array<{
    title?: string;
    snippet?: string;
    url?: string;
    score?: number;
    type?: string;
    metadata?: Record<string, unknown>; // 包含 cardId 等信息
    // 兼容旧 memory_search 结果字段
    note_id?: string;
    note_title?: string;
    chunk_text?: string;
    // 多模态结果扩展字段
    source_type?: MultimodalSourceType;
    source_id?: string;
    page_index?: number;
    chunk_index?: number;
    text_content?: string;
    thumbnail_base64?: string;
    blob_hash?: string;
    source?: MultimodalRetrievalSource;
    imageUrl?: string;
    imageCitation?: string;
    // 🔧 P18 修复：VfsSearchResult 顶层字段（用于 PDF 页面图片获取）
    resourceId?: string;
    resourceType?: string;
    pageIndex?: number;
  }> = [];

  if (Array.isArray(output)) {
    // 格式 2: 直接是数组
    sources = output;
  } else if (typeof output === 'object') {
    const outputObj = output as Record<string, unknown>;
    if (Array.isArray(outputObj.citations)) {
      // 格式 1: { citations: [...] }
      sources = outputObj.citations;
    } else if (Array.isArray(outputObj.items)) {
      // 格式 3: { items: [...] }
      sources = outputObj.items;
    } else if (Array.isArray(outputObj.sources)) {
      // 格式 4: { sources: [...] }（备用）
      sources = outputObj.sources;
    } else if (Array.isArray(outputObj.results)) {
      // 格式 5: { results: [...] }（多模态检索结果）
      sources = outputObj.results;
    }
  }

  // 多模态块统一映射到 multimodal 分组
  const defaultGroupType = block.type === 'multimodal_rag' ? 'multimodal' : block.type;

  // 过滤 null/undefined 元素，增强边界情况处理
  const validSources = sources.filter((s) => s != null);

  validSources.forEach((source, index) => {
    // 从 metadata 中提取 cardId（用于图谱定位）
    const cardId = (source.metadata?.cardId as string) || '';
    
    // 🔧 修复：从 metadata 中提取多模态信息（后端将这些字段放在 metadata 中）
    const metadata = source.metadata || {};
    const sourceType =
      source.source_type
      || (metadata.source_type as MultimodalSourceType)
      || (metadata.sourceType as MultimodalSourceType);

    // unified_search 的 rag 块里可能混有 multimodal/memory 结果，按 sourceType 动态分组
    const groupType = resolveSourceGroupType(defaultGroupType, sourceType);
    const providerId = getProviderIdFromBlockType(block.type, groupType);
    const providerLabelKey = getProviderLabelKey(block.type, groupType);

    const memoryDocumentId = groupType === 'memory'
      ? source.note_id
        || (metadata.note_id as string)
        || (metadata.noteId as string)
        || (metadata.document_id as string)
        || (metadata.memory_id as string)
        || undefined
      : undefined;
    const sourceId = source.source_id
      || (metadata.source_id as string)
      || (metadata.sourceId as string)
      || cardId
      || memoryDocumentId
      || undefined;
    // 🔧 P18 修复：优先使用 camelCase（VfsSearchResult），回退到 snake_case（多模态结果）
    const pageIndex = source.pageIndex ?? source.page_index ?? (metadata.pageIndex as number | undefined);
    const blobHash = source.blob_hash || (metadata.blobHash as string | undefined);
    const thumbnailBase64 = source.thumbnail_base64 || (metadata.imageBase64 as string | undefined);
    const retrievalSource = source.source || (metadata.retrievalSource as string | undefined);
    // 🔧 修复：提取图片 URL（后端返回的 imageUrl 字段）
    const imageUrl = source.imageUrl || (metadata.imageUrl as string | undefined);
    const imageCitation = source.imageCitation || (metadata.imageCitation as string | undefined);
    // 🔧 P18 修复：优先从顶层提取 resourceId/resourceType（VfsSearchResult 格式）
    // 回退到 metadata 中提取（兼容其他格式）
    const resourceId = source.resourceId || (metadata.resourceId as string | undefined);
    const resourceType = source.resourceType || (metadata.resourceType as string | undefined);
    
    const resolvedTitle = source.title || source.note_title || '';
    const resolvedSnippet = source.snippet || source.chunk_text || source.text_content || '';

    const raw: RagSourceInfo = {
      document_id: groupType === 'memory' ? memoryDocumentId || '' : `${block.id}-${index}`,
      file_name: resolvedTitle,
      chunk_text: resolvedSnippet,
      score: source.score || 0,
      chunk_index: source.chunk_index ?? index,
      origin: groupType,
      provider_id: providerId,
      provider_label: providerLabelKey,
      url: source.url,
      // 添加 source_id 用于图谱定位或多模态资源定位
      source_id: sourceId,
      source_type: sourceType,
    };

    // 构建基础 item
    const item: UnifiedSourceItem = {
      id: `${block.id}-source-${index}`,
      // 使用 i18n 键作为默认标题，格式与 chatV2.json 中的 blocks.retrieval.defaultSourceTitle 一致
      // UnifiedSourcePanel 会在渲染时翻译
      title: resolvedTitle || getDefaultTitleKey(getProviderContextType(block.type, groupType), index),
      snippet: resolvedSnippet,
      score: source.score,
      link: source.url,
      origin: groupType as UnifiedSourceItem['origin'],
      providerId,
      providerLabel: providerLabelKey,
      raw,
      // 🔧 修复：添加图片 URL 字段
      imageUrl,
      imageCitation,
      // 🔧 新增：添加 PDF 页面图片获取所需字段
      resourceId,
      // ★ 2026-01-22: 添加 sourceId 用于打开预览器（DSTU 资源 ID 如 tb_xxx）
      sourceId,
      pageIndex,
      resourceType,
    };

    // 多模态结果：填充 multimodal 扩展字段
    // 🔧 修复：使用从 metadata 中提取的变量
    if (groupType === 'multimodal' && isMultimodalSourceType(sourceType)) {
      item.multimodal = {
        sourceType,
        sourceId: sourceId || '',
        pageIndex: pageIndex,
        thumbnailBase64: thumbnailBase64,
        blobHash: blobHash,
        retrievalSource: (retrievalSource as MultimodalRetrievalSource) || 'multimodal_page',
      };
    }

    items.push(item);
  });

  return items;
}

/**
 * 从工具块的 toolOutput 提取来源项
 *
 * @param block - MCP 工具块
 */
function toolOutputToSourceItems(block: Block): UnifiedSourceItem[] {
  const items: UnifiedSourceItem[] = [];
  const output = block.toolOutput;

  if (!output || typeof output !== 'object') {
    return items;
  }

  // 检查 toolOutput 是否包含 citations 字段
  const outputObj = output as Record<string, unknown>;
  if (Array.isArray(outputObj.citations)) {
    const citations = outputObj.citations as Array<{
      title?: string;
      snippet?: string;
      url?: string;
      score?: number;
    }>;

    const toolProviderId = block.toolName || 'mcp_tool';
    // 工具名称作为 label，如果没有则使用 i18n key
    const toolProviderLabel = block.toolName || PROVIDER_LABEL_I18N_KEYS.mcp_tool;

    citations.forEach((cite, index) => {
      const raw: RagSourceInfo = {
        document_id: `${block.id}-tool-${index}`,
        file_name: cite.title || '',
        chunk_text: cite.snippet || '',
        score: cite.score || 0,
        chunk_index: index,
        origin: 'tool',
        provider_id: toolProviderId,
        provider_label: toolProviderLabel,
        url: cite.url,
      };

      items.push({
        // 使用 blockId + index 生成稳定 ID
        id: `${block.id}-tool-${index}`,
        title: cite.title || `Result ${index + 1}`,
        snippet: cite.snippet || '',
        score: cite.score,
        link: cite.url,
        origin: 'tool',
        providerId: toolProviderId,
        providerLabel: toolProviderLabel,
        raw,
      });
    });
  }

  return items;
}

/**
 * 将来源项按 origin + providerId 分组
 *
 * 支持多 provider 场景（如多个不同知识库的 RAG 结果）
 */
function groupSourceItems(items: UnifiedSourceItem[]): UnifiedSourceGroup[] {
  // 使用 origin + providerId 作为分组键
  const groupMap = new Map<string, UnifiedSourceItem[]>();

  for (const item of items) {
    // 分组键：origin::providerId
    const groupKey = `${item.origin}::${item.providerId}`;
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, []);
    }
    groupMap.get(groupKey)!.push(item);
  }

  // 转换为 UnifiedSourceGroup 数组
  const groups: UnifiedSourceGroup[] = [];
  for (const [, groupItems] of groupMap.entries()) {
    // 从第一个 item 获取 provider 信息（同组 item 的 provider 信息相同）
    const firstItem = groupItems[0];
    groups.push({
      group: firstItem.origin as UnifiedSourceGroup['group'],
      providerId: firstItem.providerId,
      providerLabel: firstItem.providerLabel,
      providerIcon: firstItem.providerIcon,
      count: groupItems.length,
      items: groupItems,
    });
  }

  return groups;
}

// ============================================================================
// 辅助函数
// ============================================================================

function getProviderContextType(blockType: string, groupType?: string): string {
  if (groupType === 'multimodal') {
    return 'multimodal_rag';
  }
  if (groupType === 'memory') {
    return 'memory';
  }
  if (groupType === 'web_search') {
    return 'web_search';
  }
  if (groupType === 'rag') {
    return 'rag';
  }
  return blockType;
}

function getProviderIdFromBlockType(blockType: string, groupType?: string): string {
  return getProviderIdByContextType(getProviderContextType(blockType, groupType));
}

function getProviderIdByContextType(contextType: string): string {
  switch (contextType) {
    case 'rag':
      return 'local_rag';
    case 'memory':
      return 'user_memory';
    case 'web_search':
      return 'web_search';
    case 'multimodal_rag':
      return 'multimodal_rag';
    default:
      return contextType;
  }
}

function getProviderLabelKeyByContextType(contextType: string): string {
  return PROVIDER_LABEL_I18N_KEYS[contextType] || contextType;
}

function getProviderLabelKey(blockType: string, groupType?: string): string {
  return getProviderLabelKeyByContextType(getProviderContextType(blockType, groupType));
}

function isMultimodalSourceType(value: unknown): value is MultimodalSourceType {
  return value === 'attachment' || value === 'exam' || value === 'textbook';
}

function resolveSourceGroupType(defaultGroupType: string, sourceType: unknown): string {
  if (defaultGroupType !== 'rag' || typeof sourceType !== 'string') {
    return defaultGroupType;
  }
  if (sourceType === 'memory') {
    return 'memory';
  }
  if (sourceType.includes('multimodal')) {
    return 'multimodal';
  }
  return defaultGroupType;
}

/**
 * 默认标题的 i18n key 映射
 */
const DEFAULT_TITLE_I18N_KEYS: Record<string, string> = {
  rag: 'common:chat.sources.defaultTitles.document',
  memory: 'common:chat.sources.defaultTitles.memory',
  web_search: 'common:chat.sources.defaultTitles.searchResult',
  multimodal_rag: 'common:chat.sources.defaultTitles.multimodalPage',
};

/**
 * 获取默认标题（返回带序号的 i18n key 或 fallback）
 *
 * 注意：由于 i18n 的 interpolation 需要在 UI 层处理，
 * 这里返回格式化后的字符串（如 "Document 1"）作为 fallback
 */
function getDefaultTitleKey(blockType: string, index: number): string {
  const fallbackLabels: Record<string, string> = {
    rag: 'Document',
    memory: 'Memory',
    web_search: 'Search Result',
    multimodal_rag: 'Page',
  };
  const label = fallbackLabels[blockType] || 'Source';
  return `${label} ${index + 1}`;
}

// ============================================================================
// 消息级别的来源提取
// ============================================================================

/**
 * 从单条消息的块中提取来源（便捷函数）
 *
 * @param messageBlocks - 消息关联的所有块
 * @returns UnifiedSourceBundle 或 null
 */
export function extractSourcesFromMessageBlocks(
  messageBlocks: Block[]
): UnifiedSourceBundle | null {
  // 只处理成功状态的块
  const successBlocks = messageBlocks.filter((block) => block.status === 'success');
  return blocksToSourceBundle(successBlocks);
}

/**
 * 从 SharedContext 提取来源（多变体消息使用）
 *
 * SharedContext 是多变体消息共享的检索结果，包含：
 * - ragSources: 文档 RAG 来源
 * - memorySources: 用户记忆来源
 * - graphSources: 知识图谱来源
 * - webSearchSources: 网络搜索来源
 * - multimodalSources: 多模态知识库来源
 *
 * @param sharedContext - SharedContext 对象
 * @returns UnifiedSourceBundle 或 null
 */
export function extractSourcesFromSharedContext(
  sharedContext: {
    ragSources?: Array<{
      title?: string;
      snippet?: string;
      url?: string;
      score?: number;
      metadata?: Record<string, unknown>;
      sourceId?: string;
      resourceId?: string;
      resourceType?: string;
      pageIndex?: number;
      imageUrl?: string;
      imageCitation?: string;
      chunkIndex?: number;
      sourceType?: string;
    }>;
    memorySources?: Array<{
      title?: string;
      snippet?: string;
      url?: string;
      score?: number;
      metadata?: Record<string, unknown>;
      sourceId?: string;
      resourceId?: string;
      resourceType?: string;
      pageIndex?: number;
      imageUrl?: string;
      imageCitation?: string;
      chunkIndex?: number;
      sourceType?: string;
    }>;
    graphSources?: Array<{
      title?: string;
      snippet?: string;
      url?: string;
      score?: number;
      metadata?: Record<string, unknown>;
      sourceId?: string;
      resourceId?: string;
      resourceType?: string;
      pageIndex?: number;
      imageUrl?: string;
      imageCitation?: string;
      chunkIndex?: number;
      sourceType?: string;
    }>;
    webSearchSources?: Array<{
      title?: string;
      snippet?: string;
      url?: string;
      score?: number;
      metadata?: Record<string, unknown>;
      sourceId?: string;
      resourceId?: string;
      resourceType?: string;
      pageIndex?: number;
      imageUrl?: string;
      imageCitation?: string;
      chunkIndex?: number;
      sourceType?: string;
    }>;
    multimodalSources?: Array<{
      title?: string;
      snippet?: string;
      url?: string;
      score?: number;
      metadata?: Record<string, unknown>;
      sourceId?: string;
      resourceId?: string;
      resourceType?: string;
      pageIndex?: number;
      imageUrl?: string;
      imageCitation?: string;
      chunkIndex?: number;
      sourceType?: string;
    }>;
  } | undefined
): UnifiedSourceBundle | null {
  if (!sharedContext) {
    return null;
  }

  const allItems: UnifiedSourceItem[] = [];

  // 处理每种来源类型
  const sourceTypeMap: Array<{
    sources:
      | Array<{
          title?: string;
          snippet?: string;
          url?: string;
          score?: number;
          metadata?: Record<string, unknown>;
          sourceId?: string;
          resourceId?: string;
          resourceType?: string;
          pageIndex?: number;
          imageUrl?: string;
          imageCitation?: string;
          chunkIndex?: number;
          sourceType?: string;
        }>
      | undefined;
    origin: string;
    providerId: string;
    providerLabelKey: string;
  }> = [
    {
      sources: sharedContext.ragSources,
      origin: 'rag',
      providerId: 'local_rag',
      providerLabelKey: PROVIDER_LABEL_I18N_KEYS.rag,
    },
    {
      sources: sharedContext.memorySources,
      origin: 'memory',
      providerId: 'user_memory',
      providerLabelKey: PROVIDER_LABEL_I18N_KEYS.memory,
    },
    {
      sources: sharedContext.graphSources,
      origin: 'graph',
      providerId: 'graph_rag',
      providerLabelKey: 'common:chat.sources.providers.graphRag',
    },
    {
      sources: sharedContext.webSearchSources,
      origin: 'web_search',
      providerId: 'web_search',
      providerLabelKey: PROVIDER_LABEL_I18N_KEYS.web_search,
    },
    {
      sources: sharedContext.multimodalSources,
      origin: 'multimodal',
      providerId: 'multimodal_rag',
      providerLabelKey: PROVIDER_LABEL_I18N_KEYS.multimodal_rag,
    },
  ];

  for (const { sources, origin, providerId, providerLabelKey } of sourceTypeMap) {
    if (!sources || sources.length === 0) continue;

    sources.forEach((source, index) => {
      const metadata = source.metadata || {};
      const sourceId = source.sourceId
        || (metadata.sourceId as string | undefined)
        || (metadata.source_id as string | undefined);
      const resourceId = source.resourceId
        || (metadata.resourceId as string | undefined)
        || (metadata.resource_id as string | undefined);
      const resourceType = source.resourceType
        || (metadata.resourceType as string | undefined)
        || (metadata.resource_type as string | undefined);
      const pageIndex = source.pageIndex
        ?? (metadata.pageIndex as number | undefined)
        ?? (metadata.page_index as number | undefined);
      const imageUrl = source.imageUrl
        || (metadata.imageUrl as string | undefined)
        || (metadata.image_url as string | undefined);
      const imageCitation = source.imageCitation
        || (metadata.imageCitation as string | undefined)
        || (metadata.image_citation as string | undefined);
      const chunkIndex = source.chunkIndex
        ?? (metadata.chunkIndex as number | undefined)
        ?? (metadata.chunk_index as number | undefined);
      const sourceType = source.sourceType
        || (metadata.sourceType as string | undefined)
        || (metadata.source_type as string | undefined);
      const memoryDocumentId =
        origin === 'memory'
          ? sourceId
            || (metadata.note_id as string | undefined)
            || (metadata.noteId as string | undefined)
            || (metadata.document_id as string | undefined)
            || (metadata.memory_id as string | undefined)
          : undefined;
      const documentId =
        origin === 'memory'
          ? memoryDocumentId || ''
          : sourceId
            || resourceId
            || (metadata.document_id as string | undefined)
            || (metadata.documentId as string | undefined)
            || `shared-${origin}-${index}`;

      const raw: RagSourceInfo = {
        document_id: documentId,
        file_name: source.title || '',
        chunk_text: source.snippet || '',
        score: source.score || 0,
        chunk_index: chunkIndex ?? index,
        origin,
        provider_id: providerId,
        provider_label: providerLabelKey,
        url: source.url,
        source_id: sourceId,
        source_type: sourceType,
      };

      allItems.push({
        id: `shared-${origin}-${index}`,
        title: source.title || `${origin} ${index + 1}`,
        snippet: source.snippet || '',
        score: source.score,
        link: source.url,
        origin: origin as UnifiedSourceItem['origin'],
        providerId,
        providerLabel: providerLabelKey,
        raw,
        sourceId,
        resourceId,
        resourceType,
        pageIndex,
        imageUrl,
        imageCitation,
      });
    });
  }

  if (allItems.length === 0) {
    return null;
  }

  const groups = groupSourceItems(allItems);
  return {
    total: allItems.length,
    groups,
  };
}

/**
 * 检查消息是否有来源（只检查 success 状态的块）
 *
 * @param messageBlocks - 消息关联的所有块
 * @returns 是否有来源
 *
 * 注意：只检查 success 状态的块，与 extractSourcesFromMessageBlocks 保持一致
 * 流式进行中的块不计入，避免 UI 闪烁
 */
export function hasSourcesInBlocks(messageBlocks: Block[]): boolean {
  return messageBlocks.some((block) => {
    if (block.status !== 'success') {
      return false;
    }

    // 1. 检查 citations 字段（数据契约的正确方式）
    if (block.citations && block.citations.length > 0) {
      return true;
    }

    // 2. 检查知识检索块的 toolOutput（当前实现方式）
    if (isKnowledgeRetrievalBlock(block.type) && block.toolOutput) {
      return true;
    }

    // 3. 检查 MCP 工具块
    if (block.type === 'mcp_tool' && block.toolOutput) {
      return true;
    }

    return false;
  });
}
