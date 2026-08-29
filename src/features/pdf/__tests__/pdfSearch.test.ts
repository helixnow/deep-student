import { describe, expect, it } from 'vitest';

import { collectPageSearchMatches, createSearchProgressThrottle } from '../pdfSearch';

describe('collectPageSearchMatches', () => {
  it('returns no matches for empty query or empty items', () => {
    expect(collectPageSearchMatches([], 'foo').matchCount).toBe(0);
    expect(collectPageSearchMatches([{ str: 'foo' }], '').matchCount).toBe(0);
  });

  it('finds matches that span item boundaries (no artificial separators)', () => {
    // pdf.js 常把一个词拆进多个 item：旧 join(' ') 做法会永远搜不到
    const { matchCount, itemRanges } = collectPageSearchMatches(
      [{ str: 'this is im' }, { str: 'portant text' }],
      'important',
    );
    expect(matchCount).toBe(1);
    // 命中区间跨两个 item：item0 的 "im"（[8,10)）与 item1 的 "portant"（[0,7)）
    expect(itemRanges.get(0)).toEqual([{ start: 8, end: 10, matchOrdinal: 0 }]);
    expect(itemRanges.get(1)).toEqual([{ start: 0, end: 7, matchOrdinal: 0 }]);
  });

  it('matches phrases across hasEOL line breaks (newline folded to space)', () => {
    const { matchCount } = collectPageSearchMatches(
      [{ str: 'foo', hasEOL: true }, { str: 'bar' }],
      'foo bar',
    );
    expect(matchCount).toBe(1);
  });

  it('counts repeated matches with sequential ordinals', () => {
    const { matchCount, itemRanges } = collectPageSearchMatches(
      [{ str: 'cat and cat and cat' }],
      'cat',
    );
    expect(matchCount).toBe(3);
    expect(itemRanges.get(0)?.map((r) => r.matchOrdinal)).toEqual([0, 1, 2]);
  });

  it('is case-insensitive against pre-lowercased queries', () => {
    // 调用方约定先 toLowerCase：item 原文保留大小写
    const { matchCount } = collectPageSearchMatches([{ str: 'Hello World' }], 'hello');
    expect(matchCount).toBe(1);
  });

  it('ignores non-string item payloads', () => {
    const { matchCount } = collectPageSearchMatches(
      [{ str: undefined }, { str: 'target' }],
      'target',
    );
    expect(matchCount).toBe(1);
  });
});

describe('createSearchProgressThrottle', () => {
  it('publishes the first chunk immediately, then every Nth chunk', () => {
    const published: number[] = [];
    const throttle = createSearchProgressThrottle((p) => published.push(p.scanned), 5);
    for (let chunk = 1; chunk <= 12; chunk++) {
      throttle.report({ scanned: chunk * 2, total: 100 });
    }
    // 分块 1（首个）、5、10 → scanned 2、10、20
    expect(published).toEqual([2, 10, 20]);
  });

  it('always publishes the final progress even off-interval', () => {
    const published: number[] = [];
    const throttle = createSearchProgressThrottle((p) => published.push(p.scanned), 5);
    throttle.report({ scanned: 2, total: 6 });
    throttle.report({ scanned: 4, total: 6 });
    throttle.report({ scanned: 6, total: 6 });
    // 首块 + 终块（scanned === total）；中间块被抑制
    expect(published).toEqual([2, 6]);
  });

  it('flush emits the latest suppressed progress exactly once', () => {
    const published: number[] = [];
    const throttle = createSearchProgressThrottle((p) => published.push(p.scanned), 5);
    throttle.report({ scanned: 2, total: 100 });
    throttle.report({ scanned: 4, total: 100 });
    throttle.report({ scanned: 6, total: 100 });
    throttle.flush();
    throttle.flush();
    expect(published).toEqual([2, 6]);
  });

  it('clamps the interval to at least 1 (publish every chunk)', () => {
    const published: number[] = [];
    const throttle = createSearchProgressThrottle((p) => published.push(p.scanned), 0);
    throttle.report({ scanned: 2, total: 100 });
    throttle.report({ scanned: 4, total: 100 });
    expect(published).toEqual([2, 4]);
  });
});
