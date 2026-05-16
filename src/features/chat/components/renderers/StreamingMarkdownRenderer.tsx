import React, { useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from './MarkdownRenderer';
import { BlockedMarkdownRenderer } from './BlockedMarkdownRenderer';
import { shallowEqualSpans, makeUncertaintyHighlightPlugin } from './rendererUtils';
import type { RetrievalSourceType } from '../../plugins/blocks/components/types';
import {
  useSmoothedStreamingContent,
  type StreamingSmoothingPreset,
} from './streamingSmoothing';
import { useStreamPreferences } from './StreamPreferencesContext';
import './streaming.css';

/**
 * 流式渲染模式：
 * - legacy: 整段一次性丢给 MarkdownRenderer（旧行为，默认值）
 * - blocked: 切分为 markdown 块，每块独立 memo，仅最后一块流式
 */
export type StreamRenderingMode = 'legacy' | 'blocked';

interface StreamingMarkdownRendererProps {
  content: string;
  isStreaming: boolean;
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
  // 流式平滑预设：参考 Lobe 的 realtime / balanced / silky 模型，默认 balanced
  streamSmoothingPreset?: StreamingSmoothingPreset | string | null;
  // 流式渲染模式：legacy（整段，默认）或 blocked（按 markdown 块独立 memo）
  streamRenderingMode?: StreamRenderingMode;
  // 调试/Profiler 关联信息
  blockId?: string;
  messageId?: string;
}

type ParsedContent = {
  thinkingContent: string;
  mainContent: string;
}

/**
 * 在流式输出中，剪裁结尾处不完整的数学片段，避免 KaTeX 在未闭合的情况下报错。
 * - 处理未闭合的 $$...$$（显示数学）
 * - 处理未闭合的 $...$（行内数学，忽略已成对的 $$）
 * - 处理未闭合的 \( ... \) 与 \[ ... \]
 * - 简单处理未闭合的 \begin{env} ... \end{env}
 * - 处理未闭合的 \sqrt 命令
 */
const trimTrailingIncompleteMath = (text: string): { trimmed: string; wasTrimmed: boolean } => {
  if (!text) return { trimmed: text, wasTrimmed: false };

  let result = text;
  let wasTrimmed = false;

  // 帮助函数：移除从 lastIndex 起到末尾的内容
  const cutFrom = (idx: number) => {
    if (idx >= 0) {
      result = result.slice(0, idx);
      wasTrimmed = true;
      return true;
    }
    return false;
  };

  // 处理未闭合的 \sqrt 命令
  const sqrtRegex = /\\sqrt(\[.*?\])?(?!\{)$/;
  const sqrtMatch = result.match(sqrtRegex);
  if (sqrtMatch) {
    const sqrtIndex = sqrtMatch.index ?? -1;
    if (cutFrom(sqrtIndex)) return { trimmed: result, wasTrimmed };
  }
  
  // 处理未闭合的 \sqrt{...} 命令
  const sqrtBracesRegex = /\\sqrt(\[.*?\])?\{[^{}]*$/;
  const sqrtBracesMatch = result.match(sqrtBracesRegex);
  if (sqrtBracesMatch) {
    const sqrtIndex = sqrtBracesMatch.index ?? -1;
    if (cutFrom(sqrtIndex)) return { trimmed: result, wasTrimmed };
  }

  // 1) $$ 显示数学：若数量为奇数，则从最后一个 $$ 起剪裁
  const displayCount = (result.match(/\$\$/g) || []).length;
  if (displayCount % 2 === 1) {
    const last = result.lastIndexOf('$$');
    if (cutFrom(last)) return { trimmed: result, wasTrimmed };
  }

  // 2) 行内 $ 数学：忽略 $$ 后检查剩余 $ 数量是否为奇数
  const noDisplay = result.replace(/\$\$/g, '');
  const inlineCount = (noDisplay.match(/\$/g) || []).length;
  if (inlineCount % 2 === 1) {
    // 自右向左寻找不属于 $$ 的最后一个单独 $
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i] === '$') {
        const prev = i > 0 ? result[i - 1] : '';
        const next = i + 1 < result.length ? result[i + 1] : '';
        const isDouble = prev === '$' || next === '$';
        // 处理转义：忽略 \$
        let isEscaped = false;
        if (prev === '\\') {
          // 计算连续反斜杠数量，奇数表示被转义
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

  // 3) \( ... \) 与 \[ ... \]
  // 注意：以下代码仅用于清理流式输出中的不完整片段，不用于实际渲染
  // 当前渲染器（remark-math + KaTeX）不支持 \(...\) 和 \[...\] 格式，只支持 $...$ 和 $$...$$
  // 保留此代码是为了防止流式输出时显示不完整的转义序列，避免视觉干扰
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

  // 4) \begin{env} ... \end{env}
  // 简化策略：若最后一个 \begin{xxx} 之后不存在匹配的 \end{xxx}，从该 \begin 起剪裁
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

// 流式内容预处理函数
const preprocessStreamingContent = (content: string, isStreaming: boolean) => {
  if (!content) return { content: '', hasPartialMath: false };
  
  let processed = content;
  let hasPartialMath = false;
  
  // 检测不完整的数学公式
  const incompletePatterns = [
    /\$[^$]*$/,  // 以$结尾但没有关闭$
    /\$\$[^$]*$/,  // 以$$结尾但没有关闭$$
    /\\begin\{[^}]*\}[^\\]*$/,  // 不完整的环境
    /\\[a-zA-Z]+\{[^}]*$/,  // 不完整的命令
  ];
  
  if (isStreaming) {
    // 更精确地检测不完整的数学公式
    hasPartialMath = incompletePatterns.some(pattern => pattern.test(processed));
    
    // 不要隐藏不完整的公式，而是保持原样并添加指示符
    // 让用户看到正在输入的数学内容，即使还不完整
    if (hasPartialMath) {
      // 检查是否是真正的不完整公式（而不是正常的LaTeX语法）
      const hasOpenMath = (processed.match(/\$/g) || []).length % 2 !== 0;
      const hasOpenDisplayMath = (processed.match(/\$\$/g) || []).length % 2 !== 0;
      
      // 只有当确实存在未闭合的数学公式时才标记为不完整
      if (hasOpenMath || hasOpenDisplayMath) {
        // 剪裁末尾未闭合的数学片段，避免 KaTeX 报错，同时保留『正在输入』指示
        const { trimmed, wasTrimmed } = trimTrailingIncompleteMath(processed);
        if (wasTrimmed) {
          processed = trimmed;
        }
        hasPartialMath = true;
      } else {
        hasPartialMath = false;
      }
    }
  }
  
  return { content: processed, hasPartialMath };
};

// P1修复：StreamingMarkdownRenderer memo化，减少不必要重渲染
export const StreamingMarkdownRenderer: React.FC<StreamingMarkdownRendererProps> = memo(({
  content,
  isStreaming,
  onLinkClick,
  highlightSpans,
  extraRemarkPlugins,
  onCitationClick,
  resolveCitationImage,
  streamSmoothingPreset,
  streamRenderingMode,
  blockId,
  messageId,
}) => {
  // 业务侧未指定时回退到 context（Playground/DevTool 全局覆盖），最后再回退到默认值
  // 默认 'legacy' 整段渲染：保持与现有 markdown.css 中
  // `.markdown-content > *:first-child` / `p + p` 等假设的兼容性。
  // 'blocked' 模式（按 markdown 块切分独立 memo）作为实验性优化，
  // 当前仍需要对应 CSS 适配，故仅在 Playground 内或显式开启时使用。
  const prefs = useStreamPreferences();
  const effectivePreset: StreamingSmoothingPreset | string | null =
    streamSmoothingPreset ?? prefs.preset ?? 'balanced';
  const effectiveMode: 'legacy' | 'blocked' =
    streamRenderingMode ?? prefs.mode ?? 'legacy';
  const { t } = useTranslation('chatV2');
  // 流式期间用 preset-based smoothing 代替固定 100ms throttle，
  // 保留 MarkdownRenderer 的业务渲染能力，只改变进入渲染器前的可见文本节奏。
  const smoothedContent = useSmoothedStreamingContent(content, isStreaming, {
    preset: effectivePreset,
    blockId,
    messageId,
  });
  const processedContent = useMemo(
    () => preprocessStreamingContent(smoothedContent, isStreaming),
    [smoothedContent, isStreaming]
  );
  const displayContent = processedContent.content;
  const isPartialMath = processedContent.hasPartialMath;
  const hasVisibleContent = displayContent.trim().length > 0;

  // 🔧 P1修复：使用稳定引用比较替代 JSON.stringify
  const highlightSpansRef = React.useRef(highlightSpans);
  if (!shallowEqualSpans(highlightSpansRef.current, highlightSpans)) {
    highlightSpansRef.current = highlightSpans;
  }

  // 解析思维链内容：同时支持 <thinking>…</thinking> 与 <think>…</think>
  // 🔔 V2 兼容性说明：V2 架构中 thinking 已是独立块，此解析主要用于：
  // 1. 兼容旧架构的遗留数据
  // 2. 处理某些 AI 模型在正文中输出 thinking 标签的情况
  // 正常 V2 流程中，content 块不应包含 thinking 标签
  const parseChainOfThought = (content: string): ParsedContent | null => {
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
  };

  const parsedContent = parseChainOfThought(displayContent);
  const stableHighlightSpans = highlightSpansRef.current;

  // P1修复：大文本memo化 - 流式渲染优化
  const renderedContent = useMemo(() => {
    if (!displayContent) return null;
    // 合并高亮插件和外部传入的插件
    const highlightPlugins = (!isStreaming && Array.isArray(stableHighlightSpans) && stableHighlightSpans.length > 0)
      ? [makeUncertaintyHighlightPlugin(displayContent, stableHighlightSpans, t('renderer.uncertain'))]
      : [];
    const allPlugins = [...(extraRemarkPlugins || []), ...highlightPlugins];

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
      data-stream-preset={String(effectivePreset || 'balanced')}
      data-stream-mode={effectiveMode}
    >
      {parsedContent ? (
        <>
          {/* 渲染思维链内容 */}
          {parsedContent.thinkingContent && (
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

          {/* 渲染主要内容 */}
          <div className="main-content">
            {parsedContent.mainContent ? (
              <MarkdownRenderer
                content={parsedContent.mainContent}
                isStreaming={isStreaming}
                onLinkClick={onLinkClick}
                extraRemarkPlugins={[
                  ...(extraRemarkPlugins || []),
                  ...(highlightSpans?.length
                    ? [makeUncertaintyHighlightPlugin(parsedContent.mainContent, stableHighlightSpans, t('renderer.uncertain'))]
                    : [])
                ]}
                onCitationClick={onCitationClick}
                resolveCitationImage={resolveCitationImage}
              />
            ) : (
              renderedContent
            )}
            {isPartialMath && isStreaming && (
              <span className="partial-math-indicator" title={t('renderer.incompleteMathFormula')} aria-label={t('renderer.incompleteMathFormula')} />
            )}
          </div>
        </>
      ) : (
        <div className="normal-content">
          {renderedContent}
          {isPartialMath && isStreaming && (
            <span className="partial-math-indicator" title={t('renderer.incompleteMathFormula')} aria-label={t('renderer.incompleteMathFormula')} />
          )}
        </div>
      )}
    </div>
  );
}, (prevProps: StreamingMarkdownRendererProps, nextProps: StreamingMarkdownRendererProps) => {
  // P1修复：精确memo比较 - 避免流式过程中的过度重渲染
  return (
    prevProps.content === nextProps.content &&
    prevProps.isStreaming === nextProps.isStreaming &&
    shallowEqualSpans(prevProps.highlightSpans, nextProps.highlightSpans) &&
    prevProps.extraRemarkPlugins === nextProps.extraRemarkPlugins &&
    prevProps.streamSmoothingPreset === nextProps.streamSmoothingPreset &&
    prevProps.streamRenderingMode === nextProps.streamRenderingMode &&
    prevProps.blockId === nextProps.blockId &&
    prevProps.messageId === nextProps.messageId
  );
});
