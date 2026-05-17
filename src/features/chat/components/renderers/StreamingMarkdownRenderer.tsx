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
const preprocessStreamingContent = (content: string, _isStreaming: boolean) => {
  if (!content) return { content: '', hasPartialMath: false };
  return { content, hasPartialMath: false };
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
  // 行业最优解：默认 'natural'（零节流，token 即来即显）。
  // Playground 仍可通过 prefs/props 覆盖为 balanced/silky/fluid 做对比。
  const effectivePreset: StreamingSmoothingPreset | string | null =
    streamSmoothingPreset ?? prefs.preset ?? 'natural';
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
      data-stream-preset={String(effectivePreset || 'natural')}
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
