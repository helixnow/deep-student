/**
 * Lightweight markdown body for Generative UI panels (notes summary, research report).
 * Avoids Chat `MarkdownRenderer` which pulls citation/search/katex/capability hooks
 * that historically crash outside the chat tree ("正文渲染失败").
 */
import React, { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

export interface GenerativeMarkdownBodyProps {
  content: string;
  className?: string;
  isStreaming?: boolean;
  /** Optional extra remark plugins (e.g. research-report citations). */
  extraRemarkPlugins?: unknown[];
}

export function GenerativeMarkdownBody({
  content,
  className,
  isStreaming = false,
  extraRemarkPlugins,
}: GenerativeMarkdownBodyProps) {
  const remarkPlugins = useMemo(
    () => [remarkGfm, ...((extraRemarkPlugins as unknown[]) ?? [])],
    [extraRemarkPlugins],
  );
  return (
    <div
      className={cn('generative-markdown-body markdown-content text-sm break-words', className)}
      data-generative-markdown-body
      data-streaming={isStreaming || undefined}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins as never}>{content}</ReactMarkdown>
    </div>
  );
}

export default GenerativeMarkdownBody;
