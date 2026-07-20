/**
 * MessageItem 派生数据纯函数集
 *
 * 从 MessageItem.tsx 抽出的无副作用逻辑：
 * - Token 用量聚合（多变体）
 * - 共享上下文来源判断
 * - 消息文本 / 笔记标题提取
 * - 助手消息块的分段（时间线段 vs 内容段）
 *
 * 保持纯函数形态，便于单测与复用（MessageItem / ParallelVariantView）。
 */

import type { Block, TokenUsage } from '../../core/types';
import { isTimelineBlockType } from '../ActivityTimeline';

// ============================================================================
// Token 用量聚合
// ============================================================================

/**
 * 聚合多个变体的 Token 使用统计
 * @param variants 变体列表
 * @returns 聚合后的 TokenUsage 或 undefined
 */
export function aggregateVariantUsage(
  variants: { usage?: TokenUsage }[]
): TokenUsage | undefined {
  const usages = variants.map((v) => v.usage).filter((u): u is TokenUsage => !!u);
  if (usages.length === 0) return undefined;

  return {
    promptTokens: usages.reduce((sum, u) => sum + u.promptTokens, 0),
    completionTokens: usages.reduce((sum, u) => sum + u.completionTokens, 0),
    totalTokens: usages.reduce((sum, u) => sum + u.totalTokens, 0),
    reasoningTokens: usages.some((u) => u.reasoningTokens !== undefined)
      ? usages.reduce((sum, u) => sum + (u.reasoningTokens ?? 0), 0)
      : undefined,
    cachedTokens: usages.some((u) => u.cachedTokens !== undefined)
      ? usages.reduce((sum, u) => sum + (u.cachedTokens ?? 0), 0)
      : undefined,
    source: usages.length > 1 ? 'mixed' : usages[0].source,
  };
}

// ============================================================================
// 共享上下文来源
// ============================================================================

/**
 * 检查消息是否有共享上下文来源（多变体使用）
 */
export function hasSharedContextSources(message: {
  sharedContext?: {
    ragSources?: unknown[];
    memorySources?: unknown[];
    graphSources?: unknown[];
    webSearchSources?: unknown[];
    multimodalSources?: unknown[];
  };
}): boolean {
  const ctx = message.sharedContext;
  if (!ctx) return false;
  return !!(
    (ctx.ragSources && ctx.ragSources.length > 0) ||
    (ctx.memorySources && ctx.memorySources.length > 0) ||
    (ctx.graphSources && ctx.graphSources.length > 0) ||
    (ctx.webSearchSources && ctx.webSearchSources.length > 0) ||
    (ctx.multimodalSources && ctx.multimodalSources.length > 0)
  );
}

// ============================================================================
// 文本提取
// ============================================================================

/**
 * 提取消息内容文本（content 块优先；为空时回退 thinking + mcp_tool）
 */
export function extractMessageContentFromBlocks(blocks: Block[]): string {
  const contentBlocks = blocks.filter((b) => b.type === 'content');
  let text = contentBlocks.map((b) => b.content || '').join('\n').trim();
  if (!text) {
    const parts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'thinking' && b.content) {
        parts.push(`<thinking>\n${b.content}\n</thinking>`);
      } else if (b.type === 'mcp_tool' && b.content) {
        parts.push(b.content);
      }
    }
    text = parts.join('\n\n').trim();
  }
  return text;
}

/**
 * 从内容中提取笔记标题（剥离 XML 标签，防止 <thinking> 作为标题）
 */
export function extractNoteTitle(content: string): string {
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim().slice(0, 100);
  const firstLine = content.split('\n')[0].replace(/<\/?[^>]+>/g, '').trim();
  if (firstLine.length > 0) return firstLine.slice(0, 60) + (firstLine.length > 60 ? '...' : '');
  return `Chat Note ${new Date().toLocaleDateString()}`;
}

// ============================================================================
// 助手消息块分段
// ============================================================================

/**
 * 渲染段落：一段连续的时间线块，或一个独立内容块
 */
export interface AssistantRenderSegment {
  type: 'timeline' | 'content';
  /** 段内的 blockId 列表（content 段恒为单元素） */
  blockIds: string[];
  key: string;
  /** 附加的流式空 content 块：需要单独渲染但不分割时间线 */
  streamingEmptyBlockIds?: string[];
}

/**
 * paper_save 工具使用专用 PaperSaveBlock 渲染进度条，
 * 不进时间线分组，走 BlockRendererWithStore → McpToolBlockComponent → PaperSaveBlock 路径
 */
function isPaperSaveToolBlock(block: Block): boolean {
  return (
    block.type === 'mcp_tool' &&
    (block.toolName === 'paper_save' ||
      block.toolName === 'builtin-paper_save' ||
      block.toolName?.replace(/^builtin[-:]/, '').replace(/^mcp_/, '') === 'paper_save')
  );
}

/**
 * 把助手消息的块列表分组为渲染段落（时间线段 / 内容段）。
 *
 * 规则（与历史行为逐条对齐）：
 * - 连续的时间线类型块累积为一个 timeline 段
 * - 空 content 块不分割时间线；其中流式进行中（pending/running）的空块
 *   附加到当前时间线段（保证 BlockRenderer 挂载以订阅后续 chunk）
 * - 没有时间线块但有流式空 content 块时，空块降级为独立 content 段
 */
export function buildAssistantSegments(blocks: Block[]): AssistantRenderSegment[] {
  const segments: AssistantRenderSegment[] = [];
  let currentTimelineBlockIds: string[] = [];
  // 收集流式空 content 块，附加到当前时间线 segment
  let currentStreamingEmptyBlockIds: string[] = [];

  for (const block of blocks) {
    if (isTimelineBlockType(block.type) && !isPaperSaveToolBlock(block)) {
      // 时间线类型块，累积
      currentTimelineBlockIds.push(block.id);
      continue;
    }

    // 非时间线类型块
    // content 块内容为空或只有空白时视为时间线块的一部分，
    // 避免 LLM 在工具调用之间返回的空内容分隔时间线
    const isEmptyContent =
      block.type === 'content' && (!block.content || block.content.trim() === '');
    // 流式进行中的块（pending/running）即使内容为空也必须渲染，
    // 否则 BlockRenderer 不会挂载，无法订阅后续 chunk 更新
    const isStreamingBlock = block.status === 'pending' || block.status === 'running';

    if (isEmptyContent) {
      if (isStreamingBlock) {
        currentStreamingEmptyBlockIds.push(block.id);
      }
      // 空 content 块不分隔时间线
      continue;
    }

    // 1. 先把累积的时间线块作为一个段落
    if (currentTimelineBlockIds.length > 0) {
      segments.push({
        type: 'timeline',
        blockIds: currentTimelineBlockIds,
        key: `timeline-${currentTimelineBlockIds[0]}`,
        streamingEmptyBlockIds:
          currentStreamingEmptyBlockIds.length > 0 ? currentStreamingEmptyBlockIds : undefined,
      });
      currentTimelineBlockIds = [];
      currentStreamingEmptyBlockIds = [];
    }
    // 2. 当前块作为单独段落
    segments.push({
      type: 'content',
      blockIds: [block.id],
      key: `content-${block.id}`,
    });
  }

  // 处理末尾可能残留的时间线块
  if (currentTimelineBlockIds.length > 0) {
    segments.push({
      type: 'timeline',
      blockIds: currentTimelineBlockIds,
      key: `timeline-${currentTimelineBlockIds[0]}`,
      streamingEmptyBlockIds:
        currentStreamingEmptyBlockIds.length > 0 ? currentStreamingEmptyBlockIds : undefined,
    });
  } else if (currentStreamingEmptyBlockIds.length > 0) {
    // 没有时间线块但有流式空 content 块时，直接作为 content segment 渲染，
    // 确保 BlockRendererWithStore 挂载，订阅后续 chunk 更新
    for (const blockId of currentStreamingEmptyBlockIds) {
      segments.push({
        type: 'content',
        blockIds: [blockId],
        key: `streaming-content-${blockId}`,
      });
    }
  }

  return segments;
}
