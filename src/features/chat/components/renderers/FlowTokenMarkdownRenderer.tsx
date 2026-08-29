import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
// 本地修补版样式：原版含 [class*="language-"] * 宽键失效集选择器（性能坑），
// 见 flowtoken-patched.css 头部注释。
import '../../styles/flowtoken-patched.css';
import { openUrl } from '@/utils/urlOpener';
import { escapeHtmlTagsForFlowToken } from './flowTokenEligibility';

interface FlowTokenMarkdownRendererProps {
  content: string;
  isStreaming: boolean;
  onLinkClick?: (url: string) => void;
  blockId?: string;
  messageId?: string;
}

type AnimatedMarkdownComponent = typeof import('@nvq/flowtoken')['AnimatedMarkdown'];

// ★ 依赖收敛（optimization0824 R4）：@nvq/flowtoken 连带 react-syntax-highlighter /
// @tabler/icons-react / 独立 react-markdown@9，体积可观且仅流式渲染需要。
// 动态 import 切出独立 chunk；模块级缓存保证加载完成后的渲染保持同步（无 Suspense 抖动）。
let cachedAnimatedMarkdown: AnimatedMarkdownComponent | null = null;
let flowtokenLoadPromise: Promise<AnimatedMarkdownComponent> | null = null;

export function preloadFlowToken(): Promise<AnimatedMarkdownComponent> {
  flowtokenLoadPromise ??= import('@nvq/flowtoken').then((mod) => {
    cachedAnimatedMarkdown = mod.AnimatedMarkdown;
    return mod.AnimatedMarkdown;
  });
  return flowtokenLoadPromise;
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

  const [AnimatedMarkdown, setAnimatedMarkdown] = useState<AnimatedMarkdownComponent | null>(
    () => cachedAnimatedMarkdown,
  );

  useEffect(() => {
    if (AnimatedMarkdown) return;
    let cancelled = false;
    void preloadFlowToken().then((component) => {
      if (!cancelled) setAnimatedMarkdown(() => component);
    });
    return () => {
      cancelled = true;
    };
  }, [AnimatedMarkdown]);

  return (
    <div className="markdown-content flowtoken-markdown" onClick={handleClick}>
      {AnimatedMarkdown ? (
        <AnimatedMarkdown
          content={safeContent}
          animation={isStreaming && !prefersReducedMotion ? FLOWTOKEN_ANIMATION : null}
          animationDuration={FLOWTOKEN_DURATION}
          animationTimingFunction={FLOWTOKEN_TIMING}
          sep="diff"
          isStreaming={isStreaming}
        />
      ) : (
        // chunk 加载期间（通常仅首个流式块的头几十毫秒）先按纯文本展示，避免内容空窗
        <div style={{ whiteSpace: 'pre-wrap' }}>{safeContent}</div>
      )}
    </div>
  );
});

FlowTokenMarkdownRenderer.displayName = 'FlowTokenMarkdownRenderer';
