import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INITIAL_LINE_WINDOW,
  composeWindowedSave,
  createMarkdownWindow,
  expandMarkdownWindow,
  getLoadMoreLineChunk,
} from '@/features/notes/markdownWindow';

function makeLargeMarkdown(lineCount: number): string {
  const lines = Array.from({ length: lineCount }, (_, index) => `Line ${index + 1}`);
  const boundaryStart = DEFAULT_INITIAL_LINE_WINDOW - 4;
  lines[boundaryStart] = '```ts';
  lines[boundaryStart + 1] = 'const boundary = true;';
  lines[boundaryStart + 2] = '```';
  lines[boundaryStart + 3] = '| A | B |';
  lines[boundaryStart + 4] = '| --- | --- |';
  lines[boundaryStart + 5] = '| 1 | 2 |';
  lines[0] = '# Heading 0';
  lines[lineCount - 1] = 'tail sentinel';
  return lines.join('\n');
}

describe('windowed markdown performance contracts', () => {
  it('bounds initial loaded markdown for a 50000 line note', () => {
    const markdown = makeLargeMarkdown(50000);
    const window = createMarkdownWindow(markdown, DEFAULT_INITIAL_LINE_WINDOW);

    expect(window.loadedLineCount).toBeLessThan(50000);
    expect(window.loadedLineCount).toBeGreaterThanOrEqual(DEFAULT_INITIAL_LINE_WINDOW);
    expect(window.loadedMarkdown.length).toBeLessThan(markdown.length / 5);
    expect(window.hasMore).toBe(true);
  });

  it('expands by a bounded chunk instead of loading all remaining lines', () => {
    const markdown = makeLargeMarkdown(50000);
    const initial = createMarkdownWindow(markdown, DEFAULT_INITIAL_LINE_WINDOW);
    const expanded = expandMarkdownWindow(
      markdown,
      initial.loadedMarkdown,
      initial.loadedLineCount,
      getLoadMoreLineChunk(DEFAULT_INITIAL_LINE_WINDOW),
    );

    expect(expanded.loadedLineCount).toBeGreaterThan(initial.loadedLineCount);
    expect(expanded.loadedLineCount).toBeLessThan(
      DEFAULT_INITIAL_LINE_WINDOW + getLoadMoreLineChunk(DEFAULT_INITIAL_LINE_WINDOW) + 100,
    );
    expect(expanded.loadedLineCount).toBeLessThan(50000);
    expect(expanded.hasMore).toBe(true);
  });

  it('partial save keeps a tail sentinel line from the original document', () => {
    const markdown = makeLargeMarkdown(50000);
    const initial = createMarkdownWindow(markdown, DEFAULT_INITIAL_LINE_WINDOW);
    const composed = composeWindowedSave(
      'edited loaded prefix',
      markdown,
      initial.loadedLineCount,
      initial.hasMore,
    );

    expect(composed).toContain('edited loaded prefix');
    expect(composed).toContain('tail sentinel');
    expect(composed).not.toContain('# Heading 0\nLine 2');
  });
});
