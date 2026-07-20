import { describe, expect, it } from 'vitest';
import {
  formatAbsoluteTime,
  formatDuration,
  formatRelativeTime,
} from '../automationFormat';

// 固定 now，避免测试对真实时间敏感
const NOW = Date.parse('2026-07-19T12:00:00Z');

const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('formatRelativeTime', () => {
  it('returns empty string for missing or invalid input', () => {
    expect(formatRelativeTime(undefined, 'zh-CN', NOW)).toBe('');
    expect(formatRelativeTime('', 'zh-CN', NOW)).toBe('');
    expect(formatRelativeTime('not-a-date', 'zh-CN', NOW)).toBe('');
  });

  it('returns 刚刚 for near-now timestamps in Chinese', () => {
    expect(formatRelativeTime(iso(0), 'zh-CN', NOW)).toBe('刚刚');
    expect(formatRelativeTime(iso(-5_000), 'zh-CN', NOW)).toBe('刚刚');
    expect(formatRelativeTime(iso(3_000), 'zh-CN', NOW)).toBe('刚刚');
  });

  it('uses second granularity below one minute', () => {
    expect(formatRelativeTime(iso(-30_000), 'zh-CN', NOW)).toBe('30秒钟前');
    expect(formatRelativeTime(iso(-30_000), 'en-US', NOW)).toBe('30 seconds ago');
  });

  it('uses minute granularity below one hour', () => {
    expect(formatRelativeTime(iso(-2 * 60_000), 'zh-CN', NOW)).toBe('2分钟前');
    expect(formatRelativeTime(iso(-2 * 60_000), 'en-US', NOW)).toBe('2 minutes ago');
  });

  it('uses hour granularity below one day, including future times', () => {
    expect(formatRelativeTime(iso(3 * 3_600_000), 'zh-CN', NOW)).toBe('3小时后');
    expect(formatRelativeTime(iso(3 * 3_600_000), 'en-US', NOW)).toBe('in 3 hours');
  });

  it('uses day granularity below one week', () => {
    expect(formatRelativeTime(iso(-3 * 86_400_000), 'en-US', NOW)).toBe('3 days ago');
  });

  it('falls back to an absolute date at one week or beyond', () => {
    const result = formatRelativeTime(iso(-10 * 86_400_000), 'en-US', NOW);
    expect(result).toBe(
      new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(NOW - 10 * 86_400_000),
    );
    expect(result).not.toMatch(/ago/);
  });
});

describe('formatAbsoluteTime', () => {
  it('returns empty string for missing or invalid input', () => {
    expect(formatAbsoluteTime(undefined, 'en-US')).toBe('');
    expect(formatAbsoluteTime('nope', 'en-US')).toBe('');
  });

  it('formats with medium date and short time', () => {
    const ts = '2026-07-19T12:34:00Z';
    expect(formatAbsoluteTime(ts, 'en-US')).toBe(
      new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' })
        .format(Date.parse(ts)),
    );
  });
});

describe('formatDuration', () => {
  const start = '2026-07-19T12:00:00Z';

  it('returns empty string when either endpoint is missing or invalid', () => {
    expect(formatDuration(undefined, start)).toBe('');
    expect(formatDuration(start, undefined)).toBe('');
    expect(formatDuration('bad', start)).toBe('');
    expect(formatDuration()).toBe('');
  });

  it('returns empty string for negative intervals', () => {
    expect(formatDuration('2026-07-19T12:01:00Z', start)).toBe('');
  });

  it('formats seconds-only durations', () => {
    expect(formatDuration(start, '2026-07-19T12:00:45Z')).toBe('45 秒');
    expect(formatDuration(start, '2026-07-19T12:00:45Z', 'en-US')).toBe('45s');
  });

  it('formats minute + second durations', () => {
    expect(formatDuration(start, '2026-07-19T12:01:23Z')).toBe('1 分 23 秒');
    expect(formatDuration(start, '2026-07-19T12:01:23Z', 'en-US')).toBe('1m 23s');
  });
});
