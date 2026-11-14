import { expect, it } from 'vitest';
import { normalizeIds, parseClock, parseHandoutChapters } from '../src/ledger.ts';

it('parses_handout_sections_into_chapters', () => {
  const markdown = '# 第 3 讲 讲义\n\n课程概述\n\n## 一、过拟合\n\n[媒体@file_lec:00:30]\n\n要点\n\n'
    + '## 二、正则化 [媒体@file_lec:12:30]\n\n### 小标题\n\n## 三、没有锚点\n\n普通段落\n\n'
    + '## 四、别的课\n\n[媒体@file_other:05:00]\n\n## 五、重复时刻\n\n[媒体@file_lec:00:30]';
  expect(parseHandoutChapters(markdown, 'file_lec')).toEqual([
    { title: '一、过拟合', seconds: 30 },
    { title: '二、正则化', seconds: 750 },
  ]);
  expect(parseHandoutChapters('没有标题', 'file_lec')).toEqual([]);
});

it('clock_and_id_helpers_follow_rust_bounds', () => {
  expect(parseClock('00:30')).toBe(30);
  expect(parseClock('12:30')).toBe(750);
  expect(parseClock('1:02:03')).toBe(3723);
  expect(parseClock('1:60')).toBeNull();
  expect(parseClock('1:2:60')).toBeNull();
  expect(parseClock('1234:00')).toBeNull();
  expect(parseClock('1::2')).toBeNull();
  expect(normalizeIds([' a ', 'a', '', 'b', 'b'])).toEqual(['a', 'b']);
});
