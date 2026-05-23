import React, { memo, useCallback } from 'react';
import { AnimatedMarkdown } from '@nvq/flowtoken';
import '@nvq/flowtoken/dist/styles.css';
import { openUrl } from '@/utils/urlOpener';

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

  return (
    <div className="markdown-content flowtoken-markdown" onClick={handleClick}>
      <AnimatedMarkdown
        content={content}
        animation={isStreaming ? FLOWTOKEN_ANIMATION : null}
        animationDuration={FLOWTOKEN_DURATION}
        animationTimingFunction={FLOWTOKEN_TIMING}
        sep="diff"
        isStreaming={isStreaming}
      />
    </div>
  );
});

FlowTokenMarkdownRenderer.displayName = 'FlowTokenMarkdownRenderer';
