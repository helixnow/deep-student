/**
 * Chat V2 - 正文块渲染插件
 *
 * 渲染 AI 的主要回复内容
 * 自执行注册：import 即注册
 */

import React, { useMemo, useCallback } from 'react';
import { cn } from '@/utils/cn';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { StreamingMarkdownRenderer } from '../../components/renderers';
import { makeCitationRemarkPlugin } from '../../utils/citationRemarkPlugin';
import { citationEvents } from '../../utils/citationEvents';
import type { RetrievalSourceType } from './components/types';
import { useMessageBlocks } from '../../hooks/useChatStore';
import { extractSourcesFromMessageBlocks } from '../../components/panels/sourceAdapter';

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

  // 使用 useMemo 创建引用解析插件（稳定引用，避免重复创建）
  const citationPlugins = useMemo(() => [makeCitationRemarkPlugin()], []);

  // 🆕 引用点击处理：发射事件到来源面板
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
        'prose-p:text-[15px] prose-p:leading-relaxed prose-p:tracking-wide',
        'prose-li:text-[15px] prose-li:leading-relaxed',
        'prose-headings:tracking-tight'
        // 🔔 注意：不要在外层添加 streaming-cursor 类！
        // StreamingMarkdownRenderer 内部已有正确的光标实现
        // streaming-cursor CSS 定义了 width: 2px，会破坏容器布局
      )}
    >
      <StreamingMarkdownRenderer
        content={content}
        isStreaming={isStreaming ?? false}
        extraRemarkPlugins={citationPlugins}
        onCitationClick={handleCitationClick}
        resolveCitationImage={resolveCitationImage}
      />
    </div>
  );
};

const ContentBlockWithStore: React.FC<BlockComponentProps> = ({ block, isStreaming, store }) => {
  const messageBlocks = useMessageBlocks(store!, block.messageId);
  const sourceBundle = useMemo(() => {
    return extractSourcesFromMessageBlocks(messageBlocks);
  }, [messageBlocks]);

  const resolveCitationImage = useCallback((type: RetrievalSourceType, index: number) => {
    if (!sourceBundle || index <= 0) return null;
    const groupKey = type;
    const groupItems = sourceBundle.groups
      .filter((group) => group.group === groupKey)
      .flatMap((group) => group.items);
    const item = groupItems[index - 1];
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
  }, [sourceBundle]);

  return (
    <ContentBlockBase
      block={block}
      isStreaming={isStreaming}
      resolveCitationImage={resolveCitationImage}
    />
  );
};

const ContentBlock: React.FC<BlockComponentProps> = ({ store, ...rest }) => {
  if (!store) {
    return <ContentBlockBase {...rest} />;
  }
  return <ContentBlockWithStore store={store} {...rest} />;
};

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
