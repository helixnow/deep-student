import { describe, expect, it } from 'vitest';

import { chapterIndexAt, normalizeChapters } from '../mediaChapters';

describe('media chapters', () => {
  it('keeps valid chapters in time order', () => {
    expect(normalizeChapters([
      { title: '二、正则化', seconds: 750 },
      { title: '  一、过拟合 ', seconds: 30 },
      { title: '', seconds: 900 },
      { title: '坏数据', seconds: 'x' },
      null,
    ])).toEqual([
      { title: '一、过拟合', seconds: 30 },
      { title: '二、正则化', seconds: 750 },
    ]);
    expect(normalizeChapters('nope')).toEqual([]);
  });

  it('finds the chapter containing a moment', () => {
    const chapters = [{ title: 'a', seconds: 30 }, { title: 'b', seconds: 750 }];
    expect(chapterIndexAt(chapters, 10)).toBe(-1);
    expect(chapterIndexAt(chapters, 30)).toBe(0);
    expect(chapterIndexAt(chapters, 749.9)).toBe(0);
    expect(chapterIndexAt(chapters, 3600)).toBe(1);
    expect(chapterIndexAt([], 100)).toBe(-1);
  });
});
