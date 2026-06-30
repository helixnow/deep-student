import { describe, expect, it } from 'vitest';

import {
  DEFAULT_INITIAL_LINE_WINDOW,
  DEFAULT_LOAD_MORE_PRELOAD_PX,
  MAX_INITIAL_LINE_WINDOW,
  MIN_INITIAL_LINE_WINDOW,
  clampInitialLineWindow,
  composeWindowedSave,
  createMarkdownWindow,
  expandMarkdownWindow,
  getLoadMoreLineChunk,
  shouldRequestLoadMore,
  shouldWindowMarkdown,
} from '@/features/notes/markdownWindow';

const numberedMarkdown = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

const numberedLines = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`);

describe('markdownWindow helpers', () => {
  it('clamps initial line window settings to safe bounds', () => {
    expect(clampInitialLineWindow(undefined)).toBe(DEFAULT_INITIAL_LINE_WINDOW);
    expect(clampInitialLineWindow(null)).toBe(DEFAULT_INITIAL_LINE_WINDOW);
    expect(clampInitialLineWindow('abc')).toBe(DEFAULT_INITIAL_LINE_WINDOW);
    expect(clampInitialLineWindow(0)).toBe(DEFAULT_INITIAL_LINE_WINDOW);
    expect(clampInitialLineWindow(-10)).toBe(DEFAULT_INITIAL_LINE_WINDOW);
    expect(clampInitialLineWindow(42)).toBe(MIN_INITIAL_LINE_WINDOW);
    expect(clampInitialLineWindow(123.9)).toBe(123);
    expect(clampInitialLineWindow(999999)).toBe(MAX_INITIAL_LINE_WINDOW);
  });

  it('creates a bounded prefix window for large markdown', () => {
    const markdown = numberedMarkdown(1000);
    const window = createMarkdownWindow(markdown, 600);

    expect(window.loadedLineCount).toBeLessThanOrEqual(600);
    expect(window.totalLineCount).toBe(1000);
    expect(window.hasMore).toBe(true);
    expect(window.loadedMarkdown.split('\n')).toHaveLength(window.loadedLineCount);
  });

  it('only enables windowing when a note exceeds the initial window and load chunk', () => {
    expect(getLoadMoreLineChunk(600)).toBe(300);
    expect(shouldWindowMarkdown(900, 600)).toBe(false);
    expect(shouldWindowMarkdown(901, 600)).toBe(true);
  });

  it('does not cut inside fenced code blocks', () => {
    const markdown = [
      ...numberedLines(99),
      '```ts',
      'const value = 1;',
      '```',
      'after',
    ].join('\n');

    const window = createMarkdownWindow(markdown, 100);

    expect(window.loadedMarkdown).toContain('```ts');
    expect(window.loadedMarkdown).toContain('const value = 1;');
    expect(window.loadedMarkdown).toContain('```');
    expect(window.loadedLineCount).toBe(102);
    expect(window.loadedMarkdown).not.toContain('after');
  });

  it('does not cut inside tilde fences or display math blocks', () => {
    const tilde = createMarkdownWindow([...numberedLines(99), '~~~', 'code', '~~~', 'after'].join('\n'), 100);
    expect(tilde.loadedLineCount).toBe(102);

    const displayMath = createMarkdownWindow([...numberedLines(99), '$$', 'x = y', '$$', 'after'].join('\n'), 100);
    expect(displayMath.loadedMarkdown).toContain('x = y');
    expect(displayMath.loadedLineCount).toBe(102);
    expect(displayMath.loadedMarkdown).not.toContain('after');
  });

  it('does not cut inside HTML blocks', () => {
    const markdown = [
      ...numberedLines(99),
      '<section>',
      '<p>content</p>',
      '</section>',
      '',
      'after',
    ].join('\n');

    const window = createMarkdownWindow(markdown, 100);

    expect(window.loadedMarkdown).toContain('</section>');
    expect(window.loadedLineCount).toBe(102);
    expect(window.loadedMarkdown).not.toContain('after');
  });

  it('does not cut inside table rows', () => {
    const markdown = [
      ...numberedLines(99),
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '| 3 | 4 |',
      'after',
    ].join('\n');

    const window = createMarkdownWindow(markdown, 100);

    expect(window.loadedMarkdown).toContain('| 3 | 4 |');
    expect(window.loadedLineCount).toBe(103);
    expect(window.loadedMarkdown).not.toContain('after');
  });

  it('extends through blockquote and list continuation lines', () => {
    const blockquote = createMarkdownWindow([...numberedLines(99), '> one', '> two', 'after'].join('\n'), 100);
    expect(blockquote.loadedLineCount).toBe(101);
    expect(blockquote.loadedMarkdown).not.toContain('after');

    const list = createMarkdownWindow([...numberedLines(99), '- item', '  continuation', '- next', 'after'].join('\n'), 100);
    expect(list.loadedMarkdown).toContain('  continuation');
    expect(list.loadedMarkdown).toContain('- next');
    expect(list.loadedLineCount).toBe(102);
    expect(list.loadedMarkdown).not.toContain('after');
  });

  it('expands by appending the next original chunk to the edited prefix', () => {
    const original = ['a', 'b', 'c', 'd', 'e'].join('\n');
    const result = expandMarkdownWindow(original, 'edited a\nedited b', 2, 2);

    expect(result.loadedMarkdown).toBe('edited a\nedited b\nc\nd');
    expect(result.loadedLineCount).toBe(4);
    expect(result.hasMore).toBe(true);
  });

  it('composes partial saves with the hidden suffix and preserves final newline semantics', () => {
    const original = ['a', 'b', 'hidden', 'tail', ''].join('\n');
    const composed = composeWindowedSave('edited a\nedited b', original, 2, true);

    expect(composed).toBe('edited a\nedited b\nhidden\ntail\n');
  });

  it('returns editor markdown exactly for full-window saves', () => {
    expect(composeWindowedSave('edited only', 'original\nsuffix', 1, false)).toBe('edited only');
  });

  it('detects scroll threshold for loading more', () => {
    expect(shouldRequestLoadMore({ scrollTop: 300, clientHeight: 500, scrollHeight: 2000 }, DEFAULT_LOAD_MORE_PRELOAD_PX)).toBe(true);
    expect(shouldRequestLoadMore({ scrollTop: 100, clientHeight: 500, scrollHeight: 2000 }, 1200)).toBe(false);
    expect(shouldRequestLoadMore({ scrollTop: 800, clientHeight: 500, scrollHeight: 2000 }, 1200)).toBe(true);
  });
});
