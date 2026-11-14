import React, { useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain } from '@phosphor-icons/react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { BlockedMarkdownRenderer } from './BlockedMarkdownRenderer';
import { shallowEqualSpans, makeUncertaintyHighlightPlugin, parseChainOfThought } from './rendererUtils';
import { useSuspendedStreamContent } from './StreamPreferencesContext';
import { filterStreamingTableRows } from '@/features/chat/utils/streamingMarkdownTable';
import type { RetrievalSourceType } from '../../plugins/blocks/components/types';
import './streaming.css';

/**
 * 流式渲染模式：
 * - legacy: 整段一次性丢给 MarkdownRenderer（旧行为，兼容/排障用）
 * - blocked: 切分为 markdown 块，每块独立 memo，仅最后一块流式（默认值）
 */
export type StreamRenderingMode = 'legacy' | 'blocked';

interface StreamingMarkdownRendererProps {
  content: string;
  isStreaming: boolean;
  enableChainOfThought?: boolean;
  chainOfThought?: {
    enabled: boolean;
    details?: any;
  };
  onLinkClick?: (url: string) => void;
  // 可选：不确定性高亮区间（基于 content 的字符索引，0-based, end-exclusive）
  highlightSpans?: Array<{ start: number; end: number; reason?: string }>;
  // 可选：额外的 remark 插件（如引用处理）
  extraRemarkPlugins?: any[];
  // 可选：引用标记点击回调（type: rag/memory/web_search/multimodal, index: 从1开始的编号）
  onCitationClick?: (type: string, index: number) => void;
  // 引用图片解析器：根据引用类型与序号返回图片 URL
  resolveCitationImage?: (type: RetrievalSourceType, index: number) => { url: string; title?: string } | null | undefined;
  // 流式渲染模式：legacy（整段）或 blocked（按 markdown 块独立 memo，默认）
  streamRenderingMode?: StreamRenderingMode;
  // 调试/Profiler 关联信息
  blockId?: string;
  messageId?: string;
}

// 模块级空数组：保持引用稳定，避免每个 token 生成新数组击穿下游 memo。
const EMPTY_REMARK_PLUGINS: any[] = [];

// parseChainOfThought 已抽到 rendererUtils（预编译正则 + 无标签快速路径，
// 消除流式期间每次 flush 对全量文本的重复扫描）

// 流式内容预处理函数
//
// 行业最优解（2026，对齐 ChatGPT / Claude.ai）
//
// 历史方案：流式期间裁剪未闭合的数学片段（`$x^2 +` / `\begin{...}`），
// 等闭合后整段"pop"出来。视觉上是"打字 → 等待 → 公式爆出"，体验突兀。
//
// 新方案：不裁剪。
// - remark-math v6 解析未闭合 `$` 时不会生成 math 节点，会作为普通文本流入，
//   用户看到的是原文 `$x^2 +`，自然过渡
// - 当闭合 `$` 到达时，remark-math 才创建 math 节点，KaTeX 接管渲染
// - 在 natural preset 下文本以 API 原生速度流出，partial text 仅短暂可见
//
// KaTeX 已有 `throwOnError: false` 兜底，单点解析失败不会让组件崩。
function isTableDelimiterLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  return /^\|?(?:\s*:?-{1,}:?\s*\|)+\s*(?::?-{1,}:?\s*\|?)?$/.test(trimmed);
}

function isClosedTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|') && !trimmed.endsWith('\\|');
}

function splitMarkdownTableCells(line: string): string[] {
  const trimmed = line.trim();
  const withoutLeading = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutTrailing =
    withoutLeading.endsWith('|') && !withoutLeading.endsWith('\\|')
      ? withoutLeading.slice(0, -1)
      : withoutLeading;
  return withoutTrailing.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/**
 * 流式 Markdown 表格防抖与行稳定器：
 * - 当 `isStreaming === false` 时原样返回；
 * - 当 `isStreaming === true` 时，剥离末尾未闭合的半截表格行，并对已闭合但缺失单元格的行自动补齐缺失单元格。
 */
export function stabilizeStreamingMarkdownTables(
  content: string,
  isStreaming: boolean = true,
): string {
  if (!isStreaming || !content || !content.includes('|')) {
    return content;
  }

  const normalized = content.includes('\r') ? content.replace(/\r\n/g, '\n') : content;
  const lines = normalized.split('\n');
  const output: string[] = [];
  let inCodeFence = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s{0,3}(?:```|~~~)/.test(line)) {
      inCodeFence = !inCodeFence;
      output.push(line);
      i += 1;
      continue;
    }

    if (inCodeFence || !line.includes('|')) {
      output.push(line);
      i += 1;
      continue;
    }

    // 检查是否构成 Markdown 表格起始（当前行为表头，下一行为分隔行或末尾半截分隔行）
    const nextLine = lines[i + 1];
    const headerCells = splitMarkdownTableCells(line);
    const colCount = headerCells.length;

    if (colCount === 0 || nextLine === undefined) {
      // 若位于全文末尾且是以 | 开头的未闭合半截表格行，剥离之
      if (i === lines.length - 1 && line.trim().startsWith('|') && !isClosedTableLine(line)) {
        i += 1;
        continue;
      }
      output.push(line);
      i += 1;
      continue;
    }

    const nextTrimmed = nextLine.trim();
    const isNextPartialDelimiter =
      i + 1 === lines.length - 1 &&
      nextTrimmed.startsWith('|') &&
      /^[\s|:-]+$/.test(nextTrimmed) &&
      !isClosedTableLine(nextLine);

    if (isNextPartialDelimiter) {
      // 表头后紧跟末尾未闭合的分隔行，保留表头、剥离半截分隔行
      output.push(line);
      i += 2;
      continue;
    }

    if (!isTableDelimiterLine(nextLine)) {
      output.push(line);
      i += 1;
      continue;
    }

    // 确认进入表格块：输出表头与补齐后的分隔行
    output.push(line);
    const delimiterCells = splitMarkdownTableCells(nextLine);
    if (delimiterCells.length < colCount) {
      const paddedDelims = [...delimiterCells];
      while (paddedDelims.length < colCount) {
        paddedDelims.push('---');
      }
      output.push(`| ${paddedDelims.join(' | ')} |`);
    } else {
      output.push(nextLine);
    }

    i += 2;

    // 处理表格数据行
    while (i < lines.length) {
      const rowLine = lines[i];
      const rowTrimmed = rowLine.trim();
      if (!rowTrimmed || /^\s{0,3}(?:```|~~~)/.test(rowLine) || !rowLine.includes('|')) {
        break;
      }

      const isLastLineOfStream = i === lines.length - 1;
      const isClosed = isClosedTableLine(rowLine);

      // 末尾未闭合的半截表格行：直接剥离
      if (isLastLineOfStream && !isClosed) {
        i += 1;
        continue;
      }

      const rawCells = splitMarkdownTableCells(rowLine);
      const paddedCells = rawCells.slice(0, colCount);
      while (paddedCells.length < colCount) {
        paddedCells.push('');
      }

      // 复用 filterStreamingTableRows 剔除流式期间全空白占坑行
      const validRows = filterStreamingTableRows(
        headerCells,
        [{ cells: paddedCells }],
        true,
      );
      if (validRows.length === 0) {
        i += 1;
        continue;
      }

      if (rawCells.length === colCount && isClosed) {
        output.push(rowLine);
      } else {
        output.push(`| ${paddedCells.join(' | ')} |`);
      }
      i += 1;
    }
  }

  return output.join('\n');
}

const preprocessStreamingContent = (content: string, isStreaming: boolean) => {
  if (!content) return { content: '', hasPartialMath: false };
  const stabilized =
    isStreaming && content.includes('|')
      ? stabilizeStreamingMarkdownTables(content, true)
      : content;
  return { content: stabilized, hasPartialMath: false };
};

// P1修复：StreamingMarkdownRenderer memo化，减少不必要重渲染
export const StreamingMarkdownRenderer: React.FC<StreamingMarkdownRendererProps> = memo(({
  content,
  isStreaming,
  enableChainOfThought,
  chainOfThought,
  onLinkClick,
  highlightSpans,
  extraRemarkPlugins,
  onCitationClick,
  resolveCitationImage,
  streamRenderingMode,
}) => {
  // 默认按块渲染，完成态沿用同一 Markdown 管线。
  // legacy 保留给兼容性排查与 A/B 对比。
  const effectiveMode: 'legacy' | 'blocked' =
    streamRenderingMode ?? 'blocked';
  const { t } = useTranslation('chatV2');
  // 原始 content 直通渲染器，不再经过平滑层。
  // OS 模式 background 窗（壳层已停绘）：冻结提交内容，回可见立即补渲。
  const suspendableContent = useSuspendedStreamContent(content, isStreaming);
  const processedContent = useMemo(
    () => preprocessStreamingContent(suspendableContent, isStreaming),
    [suspendableContent, isStreaming]
  );
  const displayContent = processedContent.content;

  // 🔧 P1修复：使用稳定引用比较替代 JSON.stringify
  const highlightSpansRef = React.useRef(highlightSpans);
  if (!shallowEqualSpans(highlightSpansRef.current, highlightSpans)) {
    highlightSpansRef.current = highlightSpans;
  }

  const isChainOfThoughtEnabled = enableChainOfThought ?? chainOfThought?.enabled ?? true;
  const parsedContent = useMemo(() => {
    if (!isChainOfThoughtEnabled) return null;
    const rawParsed = parseChainOfThought(suspendableContent);
    if (!rawParsed) return null;
    return {
      thinkingContent: preprocessStreamingContent(rawParsed.thinkingContent, isStreaming).content,
      mainContent: preprocessStreamingContent(rawParsed.mainContent, isStreaming).content,
    };
  }, [isChainOfThoughtEnabled, suspendableContent, isStreaming]);
  const hasVisibleContent = parsedContent
    ? parsedContent.thinkingContent.trim().length > 0 || parsedContent.mainContent.trim().length > 0
    : displayContent.trim().length > 0;
  const stableHighlightSpans = highlightSpansRef.current;
  const thinkingContent = parsedContent?.thinkingContent ?? '';

  // 高亮插件仅在非流式时构建；流式期间直接复用外部插件数组的引用，
  // 避免每个 token 生成新数组击穿 BlockedMarkdownRenderer 内部已完成块的 memo。
  const parsedMainPlugins = useMemo(() => {
    const mainContent = parsedContent?.mainContent ?? '';
    const needsHighlight =
      !isStreaming &&
      Boolean(mainContent) &&
      Array.isArray(stableHighlightSpans) &&
      stableHighlightSpans.length > 0;
    if (!needsHighlight) {
      return extraRemarkPlugins ?? EMPTY_REMARK_PLUGINS;
    }
    return [
      ...(extraRemarkPlugins || []),
      makeUncertaintyHighlightPlugin(mainContent, stableHighlightSpans, t('renderer.uncertain')),
    ];
  }, [parsedContent, isStreaming, stableHighlightSpans, extraRemarkPlugins, t]);

  // P1修复：大文本memo化 - 流式渲染优化
  const renderedContent = useMemo(() => {
    if (!displayContent) return null;
    // 合并高亮插件和外部传入的插件（高亮仅在非流式时启用）
    const needsHighlight =
      !isStreaming && Array.isArray(stableHighlightSpans) && stableHighlightSpans.length > 0;
    const allPlugins = needsHighlight
      ? [
          ...(extraRemarkPlugins || []),
          makeUncertaintyHighlightPlugin(displayContent, stableHighlightSpans, t('renderer.uncertain')),
        ]
      : (extraRemarkPlugins ?? EMPTY_REMARK_PLUGINS);

    if (effectiveMode === 'blocked') {
      return (
        <BlockedMarkdownRenderer
          content={displayContent}
          isStreaming={isStreaming}
          onLinkClick={onLinkClick}
          extraRemarkPlugins={allPlugins}
          onCitationClick={onCitationClick}
          resolveCitationImage={resolveCitationImage}
        />
      );
    }

    return (
      <MarkdownRenderer
        content={displayContent}
        isStreaming={isStreaming}
        onLinkClick={onLinkClick}
        extraRemarkPlugins={allPlugins}
        onCitationClick={onCitationClick}
        resolveCitationImage={resolveCitationImage}
      />
    );
  }, [
    displayContent,
    isStreaming,
    onLinkClick,
    stableHighlightSpans,
    extraRemarkPlugins,
    t,
    onCitationClick,
    resolveCitationImage,
    effectiveMode,
  ]);

  return (
    <div
      className="streaming-markdown"
      data-streaming={isStreaming ? 'true' : 'false'}
      data-has-visible-content={hasVisibleContent ? 'true' : 'false'}
      data-stream-preset="flowtoken-direct"
      data-stream-mode={effectiveMode}
    >
      {parsedContent ? (
        <>
          {/* 渲染思维链内容 */}
          {parsedContent.thinkingContent && (
            <div className="chain-of-thought">
              <div className="chain-header">
                <span className="chain-icon" aria-hidden="true"><Brain size={15} weight="duotone" /></span>
                <span className="chain-title">{t('renderer.aiThinkingProcess')}</span>
              </div>
              <div className="thinking-content">
                <MarkdownRenderer
                  content={thinkingContent}
                  isStreaming={isStreaming}
                  onLinkClick={onLinkClick}
                  extraRemarkPlugins={extraRemarkPlugins}
                  onCitationClick={onCitationClick}
                  resolveCitationImage={resolveCitationImage}
                />
              </div>
            </div>
          )}

          {/* 渲染主要内容 */}
          <div className="main-content">
            {parsedContent.mainContent ? (
              effectiveMode === 'blocked' ? (
                <BlockedMarkdownRenderer
                  content={parsedContent.mainContent}
                  isStreaming={isStreaming}
                  onLinkClick={onLinkClick}
                  extraRemarkPlugins={parsedMainPlugins}
                  onCitationClick={onCitationClick}
                  resolveCitationImage={resolveCitationImage}
                />
              ) : (
                <MarkdownRenderer
                  content={parsedContent.mainContent}
                  isStreaming={isStreaming}
                  onLinkClick={onLinkClick}
                  extraRemarkPlugins={parsedMainPlugins}
                  onCitationClick={onCitationClick}
                  resolveCitationImage={resolveCitationImage}
                />
              )
            ) : (
              renderedContent
            )}
          </div>
        </>
      ) : (
        <div className="normal-content">
          {renderedContent}
        </div>
      )}
    </div>
  );
}, (prevProps: StreamingMarkdownRendererProps, nextProps: StreamingMarkdownRendererProps) => {
  // 🔧 B4: 补齐回调 props 比较，避免子树持有过期闭包（与 StreamingBlockRenderer 一致）
  return (
    prevProps.content === nextProps.content &&
    prevProps.isStreaming === nextProps.isStreaming &&
    prevProps.enableChainOfThought === nextProps.enableChainOfThought &&
    prevProps.chainOfThought?.enabled === nextProps.chainOfThought?.enabled &&
    shallowEqualSpans(prevProps.highlightSpans, nextProps.highlightSpans) &&
    prevProps.extraRemarkPlugins === nextProps.extraRemarkPlugins &&
    prevProps.streamRenderingMode === nextProps.streamRenderingMode &&
    prevProps.blockId === nextProps.blockId &&
    prevProps.messageId === nextProps.messageId &&
    prevProps.onLinkClick === nextProps.onLinkClick &&
    prevProps.onCitationClick === nextProps.onCitationClick &&
    prevProps.resolveCitationImage === nextProps.resolveCitationImage
  );
});
