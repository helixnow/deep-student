import { describe, expect, it } from 'vitest';

import {
  consumePathsDropHandledFlag,
  partitionMarkdownNoteImports,
  splitLeadingMarkdownHeading,
  summarizeFailedMarkdownFiles,
} from './dragDropRouting';

describe('dragDropRouting', () => {
  it('routes markdown files to note import only in notes view', () => {
    const { markdownItems, otherItems } = partitionMarkdownNoteImports(
      ['chapter1.md', 'diagram.png', 'summary.markdown', 'paper.pdf'],
      (item) => item,
      true,
    );

    expect(markdownItems).toEqual(['chapter1.md', 'summary.markdown']);
    expect(otherItems).toEqual(['diagram.png', 'paper.pdf']);
  });

  it('keeps markdown files in original chain outside notes view', () => {
    const items = ['chapter1.md', 'paper.pdf'];
    const { markdownItems, otherItems } = partitionMarkdownNoteImports(
      items,
      (item) => item,
      false,
    );

    expect(markdownItems).toEqual([]);
    expect(otherItems).toEqual(items);
  });

  it('consumes path-drop handled flag exactly once', () => {
    const flagRef = { current: true };

    expect(consumePathsDropHandledFlag(flagRef)).toBe(true);
    expect(flagRef.current).toBe(false);
    expect(consumePathsDropHandledFlag(flagRef)).toBe(false);
  });

  it('summarizes failed markdown files for notifications', () => {
    expect(summarizeFailedMarkdownFiles([])).toBeNull();
    expect(summarizeFailedMarkdownFiles(['a.md', 'b.md'])).toBe('a.md、b.md');
    expect(summarizeFailedMarkdownFiles(['a.md', 'b.md', 'c.md', 'd.md'])).toBe('a.md、b.md、c.md +1');
  });
});

describe('splitLeadingMarkdownHeading', () => {
  it('uses the leading H1 as title and drops it from the body', () => {
    expect(splitLeadingMarkdownHeading('\n# 语法笔记 · 虚拟语气\n\n> 引言\n## 1. 条件句')).toEqual({
      title: '语法笔记 · 虚拟语气',
      body: '> 引言\n## 1. 条件句',
    });
  });

  it('keeps content untouched without a leading H1', () => {
    expect(splitLeadingMarkdownHeading('## 小节\n正文')).toEqual({ title: null, body: '## 小节\n正文' });
    expect(splitLeadingMarkdownHeading('正文\n# 后面的标题')).toEqual({ title: null, body: '正文\n# 后面的标题' });
  });
});
