import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatedMarkdown } from '@nvq/flowtoken';
import '@nvq/flowtoken/dist/styles.css';
import { openUrl } from '@/utils/urlOpener';
import { escapeHtmlTagsForFlowToken } from './flowTokenEligibility';

interface FlowTokenMarkdownRendererProps {
  content: string;
  isStreaming: boolean;
  onLinkClick?: (url: string) => void;
  blockId?: string;
  messageId?: string;
}

const FLOWTOKEN_ANIMATION = 'fadeIn';
const FLOWTOKEN_DURATION = '0.35s';
const FLOWTOKEN_TIMING = 'ease-out';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// flowtoken 的动画通过内联 style（animation-name: ft-fadeIn）注入，
// CSS 媒体查询无法覆盖内联样式，因此必须在源头尊重 prefers-reduced-motion。
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try {
      return window.matchMedia(REDUCED_MOTION_QUERY).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql.removeEventListener?.('change', onChange);
  }, []);

  return reduced;
}

export const FlowTokenMarkdownRenderer: React.FC<FlowTokenMarkdownRendererProps> = memo(({
  content,
  isStreaming,
  onLinkClick,
  blockId,
  messageId,
}) => {
  const handleClick = useCallback(async (event: React.MouseEvent<HTMLDivElement>) => {
    const rawTarget = event.target as EventTarget | null;
    const target = rawTarget instanceof Element
      ? rawTarget.closest('a[href]') as HTMLAnchorElement | null
      : null;
    const href = target?.getAttribute('href');
    if (!target || !href) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (onLinkClick) {
      onLinkClick(href);
      return;
    }

    await openUrl(href);
  }, [onLinkClick]);

  // 🔒 P1 (2026-07-08 审阅 21 P1-1)：flowtoken 内部只有 rehype-raw、无 sanitize，
  // 入口处强制把疑似 HTML 的 `<` 转义为纯文本，与主 Markdown 管线的消毒边界对齐。
  // 上游门禁（canUseDirectFlowTokenMarkdown / containsHtmlTagLikeContent）已保证
  // 正常路径内容不含此类序列，这里是纵深防御的最后一道。
  const safeContent = useMemo(() => escapeHtmlTagsForFlowToken(content), [content]);
  const prefersReducedMotion = usePrefersReducedMotion();

  return (
    <div className="markdown-content flowtoken-markdown" onClick={handleClick}>
      <AnimatedMarkdown
        content={safeContent}
        animation={isStreaming && !prefersReducedMotion ? FLOWTOKEN_ANIMATION : null}
        animationDuration={FLOWTOKEN_DURATION}
        animationTimingFunction={FLOWTOKEN_TIMING}
        sep="diff"
        isStreaming={isStreaming}
      />
    </div>
  );
});

FlowTokenMarkdownRenderer.displayName = 'FlowTokenMarkdownRenderer';
