/**
 * BlockedMarkdownRenderer
 *
 * 流式 Markdown 渲染优化版：将文本切分为 markdown 块，每块用 React.memo 缓存。
 * - 已完成块（非最后一块）使用稳定 key（基于内容 hash），命中 memo 后跳过重渲
 * - 仅最后一块在流式期间标记 isStreaming=true，词淡入只作用于活跃块
 * - 数学块、代码块、表格独立渲染，避免整段重跑 KaTeX
 *
 * 这是 production 默认渲染路径（自 v3 起）。
 * 如需回到旧整段渲染路径，显式传 streamRenderingMode="legacy"。
 */

import React, { memo, useMemo } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { splitMarkdownBlocks, type MarkdownBlock } from './splitMarkdownBlocks';
import type { RetrievalSourceType } from '../../plugins/blocks/components/types';
import type { CitationImageInfo } from './MarkdownRenderer';

interface BlockedMarkdownRendererProps {
  content: string;
  isStreaming: boolean;
  onLinkClick?: (url: string) => void;
  extraRemarkPlugins?: any[];
  onCitationClick?: (type: string, index: number) => void;
  resolveCitationImage?: (
    type: RetrievalSourceType,
    index: number,
  ) => CitationImageInfo | null | undefined;
}

interface SingleBlockProps {
  block: MarkdownBlock;
  isStreamingBlock: boolean;
  onLinkClick?: (url: string) => void;
  extraRemarkPlugins?: any[];
  onCitationClick?: (type: string, index: number) => void;
  resolveCitationImage?: (
    type: RetrievalSourceType,
    index: number,
  ) => CitationImageInfo | null | undefined;
}

const SingleBlock: React.FC<SingleBlockProps> = memo(
  ({
    block,
    isStreamingBlock,
    onLinkClick,
    extraRemarkPlugins,
    onCitationClick,
    resolveCitationImage,
  }) => {
    return (
      <MarkdownRenderer
        content={block.raw}
        isStreaming={isStreamingBlock}
        onLinkClick={onLinkClick}
        extraRemarkPlugins={extraRemarkPlugins}
        onCitationClick={onCitationClick}
        resolveCitationImage={resolveCitationImage}
        className={`block-type-${block.type}`}
      />
    );
  },
  (prev, next) => {
    // memo 比较：完成的块 raw 不变 → 跳过重渲
    // 流式块 raw 变化时必须重渲
    return (
      prev.block.id === next.block.id &&
      prev.block.raw === next.block.raw &&
      prev.isStreamingBlock === next.isStreamingBlock &&
      prev.onLinkClick === next.onLinkClick &&
      prev.extraRemarkPlugins === next.extraRemarkPlugins &&
      prev.onCitationClick === next.onCitationClick &&
      prev.resolveCitationImage === next.resolveCitationImage
    );
  },
);
SingleBlock.displayName = 'BlockedMarkdownRenderer.SingleBlock';

export const BlockedMarkdownRenderer: React.FC<BlockedMarkdownRendererProps> = memo(
  ({
    content,
    isStreaming,
    onLinkClick,
    extraRemarkPlugins,
    onCitationClick,
    resolveCitationImage,
  }) => {
    const blocks = useMemo(
      () => splitMarkdownBlocks(content, isStreaming),
      [content, isStreaming],
    );

    if (blocks.length === 0) {
      return null;
    }

    const lastIndex = blocks.length - 1;

    return (
      <div className="blocked-markdown" data-streaming={isStreaming ? 'true' : 'false'}>
        {blocks.map((block, idx) => {
          // 仅最后一块 + 整体处于流式 → 视为流式块（开启词淡入 + 平滑）
          const isStreamingBlock = isStreaming && idx === lastIndex;
          return (
            <SingleBlock
              key={block.id}
              block={block}
              isStreamingBlock={isStreamingBlock}
              onLinkClick={onLinkClick}
              extraRemarkPlugins={extraRemarkPlugins}
              onCitationClick={onCitationClick}
              resolveCitationImage={resolveCitationImage}
            />
          );
        })}
      </div>
    );
  },
);

BlockedMarkdownRenderer.displayName = 'BlockedMarkdownRenderer';
