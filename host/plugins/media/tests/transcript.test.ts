import { expect, it } from 'vitest';
import { buildTranscriptText, formatTimestamp, parseTimestamp } from '../src/transcript.ts';
import type { MediaSegmentRow } from '../api.ts';

function seg(idx: number, start: number, text: string, status: number): MediaSegmentRow {
  return { idx, start_ms: start, end_ms: start + 1000, text, status, source: 'asr', plan_version: 1 };
}

it('timestamps_roundtrip', () => {
  expect(formatTimestamp(0)).toBe('00:00');
  expect(formatTimestamp(65_999)).toBe('01:05');
  expect(formatTimestamp(3_600_000 + 61_000)).toBe('1:01:01');
  expect(parseTimestamp('01:05')).toBe(65_000);
  expect(parseTimestamp('1:01:01')).toBe(3_661_000);
  expect(parseTimestamp('1:61')).toBeNull();
  expect(parseTimestamp('abc')).toBeNull();
});

it('transcript_text_skips_pending_and_empty', () => {
  expect(buildTranscriptText([
    seg(0, 0, '你好\n世界', 1), seg(1, 5_000, '', 1),
    seg(2, 9_000, 'pending', 0), seg(3, 3_725_000, 'late', 1),
  ])).toBe('[00:00] 你好 世界\n[1:02:05] late');
});
