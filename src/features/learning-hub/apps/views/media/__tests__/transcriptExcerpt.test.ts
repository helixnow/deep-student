import { describe, expect, it } from 'vitest';

import type { TranscriptSegment } from '../mediaTranscriptApi';
import {
  buildMediaGenerationMaterial,
  buildTranscriptQuote,
  formatTranscriptLines,
  segmentsInWindow,
} from '../transcriptExcerpt';

const seg = (idx: number, startS: number, endS: number, text: string, status: TranscriptSegment['status'] = 'done'): TranscriptSegment => ({
  idx,
  startMs: startS * 1000,
  endMs: endS * 1000,
  text,
  status,
});

const segments: TranscriptSegment[] = [
  seg(0, 0, 5, '梯度下降的直觉'),
  seg(1, 5, 9, '学习率太大会震荡'),
  seg(2, 9, 12, '', 'failed'),
  seg(3, 12, 15, '待转写', 'pending'),
  seg(4, 65, 70, '动量法加速收敛'),
];

describe('transcript excerpt', () => {
  it('keeps done lines overlapping the window, in time order', () => {
    expect(segmentsInWindow(segments, 4_000, 66_000).map((s) => s.idx)).toEqual([0, 1, 4]);
    expect(segmentsInWindow(segments, 70_000, 90_000)).toEqual([]);
  });

  it('formats [mm:ss] lines and keeps the latest ones when over the limit', () => {
    expect(formatTranscriptLines(segments)).toBe('[00:00] 梯度下降的直觉\n[00:05] 学习率太大会震荡\n[01:05] 动量法加速收敛');
    expect(formatTranscriptLines(segments, 30)).toBe('[01:05] 动量法加速收敛');
    expect(formatTranscriptLines([])).toBe('');
  });

  it('builds a quote anchored at the first line', () => {
    expect(buildTranscriptQuote('file_lec', [segments[4], segments[1]])).toEqual({
      startSeconds: 5,
      marker: '[媒体@file_lec:00:05]',
      quote: '> [00:05] 学习率太大会震荡\n> [01:05] 动量法加速收敛',
    });
    expect(buildTranscriptQuote('file_lec', [segments[2], segments[3]])).toBeNull();
  });

  it('slices generation material every 10 minutes with anchors and a recap', () => {
    const long = [
      seg(0, 0, 4, '第一句'),
      seg(1, 300, 304, '第二句'),
      seg(2, 610, 615, '第三句'),
      seg(3, 3700, 3705, '第四句'),
    ];
    expect(buildMediaGenerationMaterial('file_lec', long)).toBe([
      '## 片段 1/3 · [媒体@file_lec:00:00] 起',
      '[00:00] 第一句',
      '[05:00] 第二句',
      '',
      '## 片段 2/3 · [媒体@file_lec:10:10] 起',
      '> 上文回顾（仅帮助理解语境，不要针对它制卡/出题）：',
      '> [00:00] 第一句',
      '> [05:00] 第二句',
      '[10:10] 第三句',
      '',
      '## 片段 3/3 · [媒体@file_lec:1:01:40] 起',
      '> 上文回顾（仅帮助理解语境，不要针对它制卡/出题）：',
      '> [10:10] 第三句',
      '[1:01:40] 第四句',
    ].join('\n'));
    expect(buildMediaGenerationMaterial('file_lec', [])).toBe('');
  });
});
