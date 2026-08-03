import { describe, expect, it } from 'vitest';
import { escapeRegExp, highlightRanges } from '../highlightRanges';

describe('highlightRanges', () => {
  it('returns empty for empty query or empty text', () => {
    expect(highlightRanges('hello', '')).toEqual([]);
    expect(highlightRanges('hello', '   ')).toEqual([]);
    expect(highlightRanges('', 'hello')).toEqual([]);
  });

  it('matches case-insensitively', () => {
    expect(highlightRanges('Hello World', 'hello')).toEqual([{ start: 0, end: 5 }]);
    expect(highlightRanges('HELLO', 'ell')).toEqual([{ start: 1, end: 4 }]);
  });

  it('highlights each query token separately', () => {
    expect(highlightRanges('alpha beta gamma', 'alpha gamma')).toEqual([
      { start: 0, end: 5 },
      { start: 11, end: 16 },
    ]);
  });

  it('merges overlapping or adjacent ranges', () => {
    expect(highlightRanges('abcde', 'abc bcd')).toEqual([{ start: 0, end: 4 }]);
    // Adjacent identical hits collapse into one mark span.
    expect(highlightRanges('foofoo', 'foo')).toEqual([{ start: 0, end: 6 }]);
    expect(highlightRanges('foo bar foo', 'foo')).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it('matches CJK substrings directly', () => {
    expect(highlightRanges('线性代数笔记', '代数')).toEqual([{ start: 2, end: 4 }]);
    expect(highlightRanges('高等数学与线性代数', '数学 代数')).toEqual([
      { start: 2, end: 4 },
      { start: 7, end: 9 },
    ]);
  });

  it('treats regex metacharacters as literals', () => {
    expect(escapeRegExp('(a+b*)')).toBe('\\(a\\+b\\*\\)');
    expect(highlightRanges('price is (a+b*) today', '(a+b*)')).toEqual([
      { start: 9, end: 15 },
    ]);
    expect(highlightRanges('a.b', 'a.b')).toEqual([{ start: 0, end: 3 }]);
    expect(highlightRanges('axb', 'a.b')).toEqual([]);
  });
});
