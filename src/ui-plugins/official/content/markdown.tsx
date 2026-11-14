import React from 'react';
import type { MarkdownCodeBlockContribution, MarkdownCodeBlockProps } from '@/ui-kernel/contracts/content';

function MathCodeBlock({ codeContent, className = '', inline, placement, renderMath }: MarkdownCodeBlockProps) {
  const display = placement === 'pre'
    ? /math-display/i.test(className) || !/math-inline/i.test(className)
    : inline === false;
  return <>{renderMath(codeContent, display)}</>;
}

/** The regex boundaries intentionally retain the original class matching, including case. */
export const mathCodeBlock: MarkdownCodeBlockContribution = {
  matches: ({ className = '', placement }) => placement === 'pre'
    ? /(?:^|\s)(math|math-display|math-inline)(?:\s|$)/i.test(className) || /language-math(?![\w-])/i.test(className)
    : /language-math(?![\w-])/i.test(className),
  component: MathCodeBlock,
};

export const latexCodeBlock: MarkdownCodeBlockContribution = {
  matches: ({ className = '' }) => /language-latex(?![\w-])/i.test(className),
  component: MathCodeBlock,
};
