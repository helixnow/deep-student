import { describe, expect, it } from 'vitest';

import {
  findWikiLinksInText,
  formatWikiLink,
  parseWikiLinkInner,
  parseWikiLinkText,
} from '../format';

describe('wikilink format', () => {
  it('formats target and optional label', () => {
    expect(formatWikiLink('Note')).toBe('[[Note]]');
    expect(formatWikiLink('目标', '别名')).toBe('[[目标|别名]]');
    expect(formatWikiLink(' 带 空格 ', '')).toBe('[[带 空格]]');
    expect(formatWikiLink('')).toBe('');
  });

  it('parses inner and full text compatibly with notes/wikilinks rules', () => {
    expect(parseWikiLinkInner('note_1')).toEqual({ target: 'note_1', label: '' });
    expect(parseWikiLinkInner('Calculus|the calculus note')).toEqual({
      target: 'Calculus',
      label: 'the calculus note',
    });
    expect(parseWikiLinkInner('final|label|with pipe')).toEqual({
      target: 'final',
      label: 'label|with pipe',
    });
    expect(parseWikiLinkInner('  ')).toBeNull();
    expect(parseWikiLinkText('[[带 空格的标题]]')).toEqual({
      target: '带 空格的标题',
      label: '',
    });
    expect(parseWikiLinkText('[[目标|别名]]')).toEqual({
      target: '目标',
      label: '别名',
    });
  });

  it('finds multiple links in plain text', () => {
    expect(findWikiLinksInText('[[a|b]] and [[c]]')).toEqual([
      { target: 'a', label: 'b', raw: '[[a|b]]', start: 0, end: 7 },
      { target: 'c', label: '', raw: '[[c]]', start: 12, end: 17 },
    ]);
  });
});
