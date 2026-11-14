import { describe, expect, it, vi } from 'vitest';
import { parseTimestamp, validateFileSize } from '../src/resources.ts';
import { resolveMultimodalQuery } from '../src/search.ts';
import { parseOcrPagesForDisplay } from '../repository/media-cache.ts';
import { parseOcrPagesJson, joinOcrPagesText } from '../repository/refs.ts';

describe('Rust string/time behavior through production paths', () => {
  it('uses Rust White_Space rather than JavaScript trim', () => {
    expect(() => resolveMultimodalQuery({ query: '\u0085' })).toThrow('text search requires');
    expect(resolveMultimodalQuery({ query: '\ufeff' }).text).toBe('\ufeff');
    expect(parseOcrPagesJson('["\u0085","\ufeff"]', { warn: vi.fn() })).toEqual([null, '\ufeff']);
    expect(joinOcrPagesText(['\u0085正文\u0085'])).toBe('--- 第 1 页 ---\n正文');
    expect(parseOcrPagesForDisplay('["\u0085","\ufeff"]')).toEqual([
      { pageIndex: 0, text: '\u0085', charCount: 2, isFailed: true },
      { pageIndex: 1, text: '\ufeff', charCount: 3, isFailed: false },
    ]);
  });
  it('parses chrono RFC3339 leap seconds and rejects invalid dates', () => {
    expect(parseTimestamp('2016-12-31T23:59:60Z')).toBe(1483228800000);
    expect(parseTimestamp('2026-02-30T00:00:00Z')).toBe(0);
    expect(parseTimestamp('2026-01-02 03:04:05')).toBe(0);
    expect(parseTimestamp('2026-01-02T03:04:05.123+00:00')).toBe(1767323045123);
  });
  it('validates file size using UTF-8 bytes', () => {
    expect(() => validateFileSize('translation', '中'.repeat(Math.floor(10 * 1024 * 1024 / 3) + 1))).toThrow();
  });
});
