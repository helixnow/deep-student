/**
 * Chat V2 - 正文块渲染插件
 *
 * 渲染 AI 的主要回复内容
 * 自执行注册：import 即注册
 */

import React, { useMemo, useCallback } from 'react';
import { cn } from '@/utils/cn';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { StreamingBlockRenderer } from '../../components/renderers';
import { citationEvents } from '../../utils/citationEvents';
import { CitationSourceContext } from '../../utils/citationSourceContext';
import type { RetrievalSource, RetrievalSourceType } from './components/types';
import { useMessageBlocks } from '../../hooks/useChatStore';
import { extractSourcesFromMessageBlocks, resolveCitationSource as resolveSourceByCitation } from '../../components/panels/sourceAdapter';
import type { UnifiedSourceItem } from '../../components/panels/sourceTypes';

// ============================================================================
// 正文块组件
// ============================================================================

/**
 * ContentBlock - 正文块渲染组件
 *
 * 功能：
 * 1. 流式 Markdown 渲染
 * 2. 代码高亮
 * 3. LaTeX 公式支持
 * 4. 暗色/亮色主题支持
 */
type ContentBlockBaseProps = Pick<BlockComponentProps, 'block' | 'isStreaming'> & {
  resolveCitationImage?: (type: RetrievalSourceType, index: number) => { url: string; title?: string } | null | undefined;
};

const ContentBlockBase: React.FC<ContentBlockBaseProps> = ({ block, isStreaming, resolveCitationImage }) => {
  const content = block.content || '';

  // P2-5：不再在这里额外挂 makeCitationRemarkPlugin。
  // MarkdownRenderer 检测到 onCitationClick/resolveCitationImage 后会自动注册
  // 同一插件，双份注册只会白跑一次 AST 遍历。

  // 🆕 引用点击处理：发射事件到来源面板（带 messageId，面板侧按消息过滤）
  const handleCitationClick = useCallback((type: string, index: number) => {
    citationEvents.emit({
      type: type as RetrievalSourceType,
      index,
      messageId: block.messageId,
    });
  }, [block.messageId]);

  // 无内容时显示占位符
  if (!content && !isStreaming) {
    return null;
  }

  return (
    <div
      className={cn(
        'prose prose-sm dark:prose-invert max-w-none',
        'text-foreground',
        // 优化聊天字体：更大的字号、更舒适的行高
        'prose-p:text-md prose-p:leading-relaxed prose-p:tracking-wide',
        'prose-li:text-md prose-li:leading-relaxed',
        'prose-headings:tracking-tight'
      )}
    >
      <StreamingBlockRenderer
        content={content}
        isStreaming={isStreaming ?? false}
        onCitationClick={handleCitationClick}
        resolveCitationImage={resolveCitationImage}
        blockId={block.id}
        messageId={block.messageId}
      />
    </div>
  );
};

const ContentBlockWithStore: React.FC<BlockComponentProps> = ({ block, isStreaming, store }) => {
  const messageBlocks = useMessageBlocks(store!, block.messageId);
  const sourceBundle = useMemo(() => {
    return extractSourcesFromMessageBlocks(messageBlocks);
  }, [messageBlocks]);

  // 按"类型内 1-based 序号"（[类型-N] 的 N，契约不可变）查找来源项。
  // 使用 adapter 的 resolveCitationSource（基于 typeIndex，按全局出现顺序计数），
  // 与来源面板卡片编号完全对齐；多 provider 结果交错时不会与扁平下标错位。
  const findSourceItem = useCallback((type: RetrievalSourceType, index: number): UnifiedSourceItem | null => {
    return resolveSourceByCitation(sourceBundle, type, index);
  }, [sourceBundle]);

  const resolveCitationImage = useCallback((type: RetrievalSourceType, index: number) => {
    const item = findSourceItem(type, index);
    if (!item) return null;
    
    // 🔧 修复：优先使用后端返回的 imageUrl 字段，支持 RAG 和多模态检索结果
    const url = item.imageUrl || item.multimodal?.thumbnailBase64 || item.raw?.url || item.link;
    
    // 🔧 新增：如果没有直接的图片 URL，但有 resourceId + pageIndex，返回用于异步加载
    // 支持 PDF 页面图片的按需获取（textbook/attachment/exam 类型）
    const canLoadPdfPage = item.resourceId && item.pageIndex !== undefined && item.pageIndex !== null;
    
    if (!url && !canLoadPdfPage) return null;
    
    return { 
      url, 
      title: item.title,
      // PDF 页面图片异步加载所需字段
      resourceId: item.resourceId,
      pageIndex: item.pageIndex,
      resourceType: item.resourceType,
    };
  }, [findSourceItem]);

  // 🆕 P0-2：正文徽章 hover 即时预览所需的来源数据（标题/snippet/score/url），
  // 经 CitationSourceContext 跨过中间渲染层直达 CitationBadgeWithPopover
  const resolveCitationSource = useCallback((type: RetrievalSourceType, index: number): RetrievalSource | null => {
    const item = findSourceItem(type, index);
    if (!item) return null;
    return {
      id: item.id,
      type,
      title: item.title,
      snippet: item.snippet || item.raw?.chunk_text || '',
      url: item.link || item.raw?.url,
      score: item.score,
    };
  }, [findSourceItem]);

  return (
    <CitationSourceContext.Provider value={resolveCitationSource}>
      <ContentBlockBase
        block={block}
        isStreaming={isStreaming}
        resolveCitationImage={resolveCitationImage}
      />
    </CitationSourceContext.Provider>
  );
};

const ContentBlock: React.FC<BlockComponentProps> = React.memo(({ store, ...rest }) => {
  if (!store) {
    return <ContentBlockBase {...rest} />;
  }
  return <ContentBlockWithStore store={store} {...rest} />;
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('content', {
  type: 'content',
  component: ContentBlock,
  onAbort: 'keep-content', // 中断时保留已生成内容
});

// 导出组件（可选，用于测试）
export { ContentBlock };
