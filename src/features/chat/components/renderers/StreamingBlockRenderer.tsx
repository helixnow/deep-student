import React, { useMemo, memo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from './MarkdownRenderer';
import { shallowEqualSpans, makeUncertaintyHighlightPlugin } from './rendererUtils';
import type { RetrievalSourceType } from '../../plugins/blocks/components/types';
import {
  useSmoothedStreamingContent,
  type StreamingSmoothingPreset,
} from './streamingSmoothing';
import { splitMarkdownBlocks, type MarkdownBlock } from './splitMarkdownBlocks';
import './streamingBlocks.css';
import './streamingWordFade.css';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StreamingBlockRendererProps {
  content: string;
  isStreaming: boolean;
  chainOfThought?: {
    enabled: boolean;
    details?: any;
  };
  onLinkClick?: (url: string) => void;
  highlightSpans?: Array<{ start: number; end: number; reason?: string }>;
  extraRemarkPlugins?: any[];
  onCitationClick?: (type: string, index: number) => void;
  resolveCitationImage?: (type: RetrievalSourceType, index: number) => { url: string; title?: string } | null | undefined;
  streamSmoothingPreset?: StreamingSmoothingPreset | string | null;
  blockId?: string;
  messageId?: string;
}

interface MemoizedBlockProps {
  block: MarkdownBlock;
  isNew: boolean;
  isActive: boolean;
  isStreaming: boolean;
  onLinkClick?: (url: string) => void;
  extraRemarkPlugins?: any[];
  onCitationClick?: (type: string, index: number) => void;
  resolveCitationImage?: (type: RetrievalSourceType, index: number) => { url: string; title?: string } | null | undefined;
}

// ─── MemoizedBlock ───────────────────────────────────────────────────────────

/**
 * 单个 markdown 块的 memo 渲染器。
 * - 已完成块：只要 raw 不变就跳过重渲染
 * - 活跃块（流式中最后一个块）：每次内容变化都重渲染
 */
const MemoizedBlock = memo<MemoizedBlockProps>(({
  block,
  isNew,
  isActive,
  isStreaming,
  onLinkClick,
  extraRemarkPlugins,
  onCitationClick,
  resolveCitationImage,
}) => {
  return (
    <div
      className="stream-block"
      data-complete={block.isComplete ? 'true' : 'false'}
      data-new={isNew ? 'true' : 'false'}
      data-active={isActive ? 'true' : 'false'}
      data-block-type={block.type}
    >
      <MarkdownRenderer
        content={block.raw}
        isStreaming={isActive && isStreaming}
        onLinkClick={onLinkClick}
        extraRemarkPlugins={extraRemarkPlugins}
        onCitationClick={onCitationClick}
        resolveCitationImage={resolveCitationImage}
      />
    </div>
  );
}, (prev, next) => {
  // 已完成块：只要 raw 不变就跳过
  if (prev.block.isComplete && next.block.isComplete && prev.block.raw === next.block.raw) {
    return (
      prev.isNew === next.isNew &&
      prev.onLinkClick === next.onLinkClick &&
      prev.extraRemarkPlugins === next.extraRemarkPlugins
    );
  }
  // 活跃块或状态变化：重渲染
  return false;
});

// ─── Chain of Thought Parser ─────────────────────────────────────────────────

type ParsedContent = {
  thinkingContent: string;
  mainContent: string;
};

function parseChainOfThought(content: string): ParsedContent | null {
  if (!content) return null;
  const tryMatch = (src: string, tag: 'thinking' | 'think') =>
    src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>\\s*`, 'i'));

  let thinkingMatch = tryMatch(content, 'thinking');
  if (!thinkingMatch) thinkingMatch = tryMatch(content, 'think');
  if (thinkingMatch) {
    const thinkingContent = (thinkingMatch[1] || '').trim();
    const mainContent = content.replace(thinkingMatch[0], '').trim();
    return { thinkingContent, mainContent };
  }
  return null;
}

// ─── Incomplete Math Trimming (reused from StreamingMarkdownRenderer) ────────

const trimTrailingIncompleteMath = (text: string): { trimmed: string; wasTrimmed: boolean } => {
  if (!text) return { trimmed: text, wasTrimmed: false };

  let result = text;
  let wasTrimmed = false;

  const cutFrom = (idx: number) => {
    if (idx >= 0) {
      result = result.slice(0, idx);
      wasTrimmed = true;
      return true;
    }
    return false;
  };

  // \sqrt 未闭合
  const sqrtRegex = /\\sqrt(\[.*?\])?(?!\{)$/;
  const sqrtMatch = result.match(sqrtRegex);
  if (sqrtMatch) {
    const sqrtIndex = sqrtMatch.index ?? -1;
    if (cutFrom(sqrtIndex)) return { trimmed: result, wasTrimmed };
  }
  const sqrtBracesRegex = /\\sqrt(\[.*?\])?\{[^{}]*$/;
  const sqrtBracesMatch = result.match(sqrtBracesRegex);
  if (sqrtBracesMatch) {
    const sqrtIndex = sqrtBracesMatch.index ?? -1;
    if (cutFrom(sqrtIndex)) return { trimmed: result, wasTrimmed };
  }

  // $$ 显示数学
  const displayCount = (result.match(/\$\$/g) || []).length;
  if (displayCount % 2 === 1) {
    const last = result.lastIndexOf('$$');
    if (cutFrom(last)) return { trimmed: result, wasTrimmed };
  }

  // 行内 $ 数学
  const noDisplay = result.replace(/\$\$/g, '');
  const inlineCount = (noDisplay.match(/\$/g) || []).length;
  if (inlineCount % 2 === 1) {
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i] === '$') {
        const prev = i > 0 ? result[i - 1] : '';
        const next = i + 1 < result.length ? result[i + 1] : '';
        const isDouble = prev === '$' || next === '$';
        let isEscaped = false;
        if (prev === '\\') {
          let cnt = 0;
          for (let k = i - 1; k >= 0 && result[k] === '\\'; k--) cnt++;
          isEscaped = cnt % 2 === 1;
        }
        if (!isDouble && !isEscaped) {
          cutFrom(i);
          return { trimmed: result, wasTrimmed };
        }
      }
    }
  }

  // \( ... \) 与 \[ ... \]
  const openParenCount = (result.match(/\\\(/g) || []).length;
  const closeParenCount = (result.match(/\\\)/g) || []).length;
  if (openParenCount > closeParenCount) {
    const last = result.lastIndexOf('\\(');
    if (cutFrom(last)) return { trimmed: result, wasTrimmed };
  }
  const openBracketCount = (result.match(/\\\[/g) || []).length;
  const closeBracketCount = (result.match(/\\\]/g) || []).length;
  if (openBracketCount > closeBracketCount) {
    const last = result.lastIndexOf('\\[');
    if (cutFrom(last)) return { trimmed: result, wasTrimmed };
  }

  // \begin{env} ... \end{env}
  const beginMatches = [...result.matchAll(/\\begin\{([^}]+)\}/g)];
  if (beginMatches.length > 0) {
    const lastBegin = beginMatches[beginMatches.length - 1];
    const env = lastBegin[1];
    const beginIndex = lastBegin.index ?? -1;
    const afterBegin = result.slice(beginIndex + lastBegin[0].length);
    const hasEnd = new RegExp(`\\\\end\\{${env.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`).test(afterBegin);
    if (!hasEnd) {
      if (cutFrom(beginIndex)) return { trimmed: result, wasTrimmed };
    }
  }

  return { trimmed: result, wasTrimmed };
};

// ─── StreamingBlockRenderer ──────────────────────────────────────────────────

/**
 * 块级增量流式 Markdown 渲染器。
 *
 * 核心优化：将 markdown 按块级元素拆分，已完成的块通过 React.memo 缓存，
 * 只有最后一个活跃块随 token 到达而重渲染。对于 2000+ 字符的长回复，
 * 渲染帧耗时从 ~12ms（全量 re-parse）降至 ~3ms（仅活跃块）。
 */
export const StreamingBlockRenderer: React.FC<StreamingBlockRendererProps> = memo(({
  content,
  isStreaming,
  onLinkClick,
  highlightSpans,
  extraRemarkPlugins,
  onCitationClick,
  resolveCitationImage,
  streamSmoothingPreset = 'fluid',
  blockId,
  messageId,
}) => {
  const { t } = useTranslation('chatV2');

  // 流式平滑
  const smoothedContent = useSmoothedStreamingContent(content, isStreaming, {
    preset: streamSmoothingPreset,
    blockId,
    messageId,
  });

  // 流式期间剪裁未闭合数学
  const processedContent = useMemo(() => {
    if (!smoothedContent) return '';
    if (!isStreaming) return smoothedContent;

    const { trimmed } = trimTrailingIncompleteMath(smoothedContent);
    return trimmed;
  }, [smoothedContent, isStreaming]);

  // 解析思维链
  const parsedContent = useMemo(() => parseChainOfThought(processedContent), [processedContent]);
  const mainContent = parsedContent ? parsedContent.mainContent : processedContent;

  // 拆分为块
  const blocks = useMemo(
    () => splitMarkdownBlocks(mainContent, isStreaming),
    [mainContent, isStreaming],
  );

  // 追踪新出现的块（用于淡入动画）
  const prevBlockCountRef = useRef(0);
  const newBlockStartIndex = isStreaming ? prevBlockCountRef.current : blocks.length;
  useEffect(() => {
    if (blocks.length > prevBlockCountRef.current) {
      prevBlockCountRef.current = blocks.length;
    }
    // 流式结束时重置
    if (!isStreaming) {
      prevBlockCountRef.current = blocks.length;
    }
  }, [blocks.length, isStreaming]);

  // 高亮插件（仅非流式时）
  const highlightSpansRef = useRef(highlightSpans);
  if (!shallowEqualSpans(highlightSpansRef.current, highlightSpans)) {
    highlightSpansRef.current = highlightSpans;
  }
  const stableHighlightSpans = highlightSpansRef.current;

  const allRemarkPlugins = useMemo(() => {
    const highlightPlugins = (!isStreaming && Array.isArray(stableHighlightSpans) && stableHighlightSpans.length > 0)
      ? [makeUncertaintyHighlightPlugin(mainContent, stableHighlightSpans, t('renderer.uncertain'))]
      : [];
    return [...(extraRemarkPlugins || []), ...highlightPlugins];
  }, [isStreaming, stableHighlightSpans, extraRemarkPlugins, mainContent, t]);

  const hasVisibleContent = mainContent.trim().length > 0;

  return (
    <div
      className="streaming-block-renderer"
      data-streaming={isStreaming ? 'true' : 'false'}
      data-has-visible-content={hasVisibleContent ? 'true' : 'false'}
      data-stream-preset={streamSmoothingPreset || 'balanced'}
    >
      {/* 思维链内容 */}
      {parsedContent?.thinkingContent && (
        <div className="chain-of-thought">
          <div className="chain-header">
            <span className="chain-icon">🧠</span>
            <span className="chain-title">{t('renderer.aiThinkingProcess')}</span>
          </div>
          <div className="thinking-content">
            <MarkdownRenderer
              content={parsedContent.thinkingContent}
              isStreaming={isStreaming}
              onLinkClick={onLinkClick}
              onCitationClick={onCitationClick}
              resolveCitationImage={resolveCitationImage}
            />
          </div>
        </div>
      )}

      {/* 块级增量渲染 */}
      <div className="streaming-blocks">
        {blocks.map((block, i) => (
          <MemoizedBlock
            key={block.id}
            block={block}
            isNew={i >= newBlockStartIndex && isStreaming}
            isActive={isStreaming && i === blocks.length - 1}
            isStreaming={isStreaming}
            onLinkClick={onLinkClick}
            extraRemarkPlugins={allRemarkPlugins}
            onCitationClick={onCitationClick}
            resolveCitationImage={resolveCitationImage}
          />
        ))}
      </div>
    </div>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.content === nextProps.content &&
    prevProps.isStreaming === nextProps.isStreaming &&
    shallowEqualSpans(prevProps.highlightSpans, nextProps.highlightSpans) &&
    prevProps.extraRemarkPlugins === nextProps.extraRemarkPlugins &&
    prevProps.streamSmoothingPreset === nextProps.streamSmoothingPreset &&
    prevProps.blockId === nextProps.blockId &&
    prevProps.messageId === nextProps.messageId
  );
});
