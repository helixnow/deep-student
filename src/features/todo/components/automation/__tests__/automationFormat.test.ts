import { describe, expect, it } from 'vitest';
import {
  formatAbsoluteTime,
  formatDayLabel,
  formatDuration,
  formatDurationMs,
  formatRelativeTime,
  formatRunTime,
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
    expect(formatDuration(start, '2026-07-19T12:00:45Z', 'zh-CN')).toBe('45 秒');
    expect(formatDuration(start, '2026-07-19T12:00:45Z', 'en-US')).toBe('45s');
  });

  it('formats minute + second durations', () => {
    expect(formatDuration(start, '2026-07-19T12:01:23Z', 'zh-CN')).toBe('1 分 23 秒');
    expect(formatDuration(start, '2026-07-19T12:01:23Z', 'en-US')).toBe('1m 23s');
  });

  it('formats hour-scale durations instead of overflowing minutes', () => {
    expect(formatDuration(start, '2026-07-19T14:05:00Z', 'zh-CN')).toBe('2 小时 5 分');
    expect(formatDuration(start, '2026-07-19T14:05:00Z', 'en-US')).toBe('2h 5m');
  });

  it('falls back to the runtime language instead of hardcoded Chinese when locale is omitted', () => {
    // jsdom 的 navigator.language 为 en-US：省略 locale 不应输出中文时长
    expect(formatDuration(start, '2026-07-19T12:00:45Z')).toBe(
      formatDuration(start, '2026-07-19T12:00:45Z', navigator.language),
    );
  });
});

describe('formatDurationMs', () => {
  it('returns empty string for negative or non-finite durations', () => {
    expect(formatDurationMs(-1, 'zh-CN')).toBe('');
    expect(formatDurationMs(Number.NaN, 'zh-CN')).toBe('');
    expect(formatDurationMs(Number.POSITIVE_INFINITY, 'en-US')).toBe('');
  });

  it('formats seconds-only durations', () => {
    expect(formatDurationMs(45_000, 'zh-CN')).toBe('45 秒');
    expect(formatDurationMs(45_000, 'en-US')).toBe('45s');
    expect(formatDurationMs(0, 'en-US')).toBe('0s');
  });

  it('formats minute + second durations', () => {
    expect(formatDurationMs(83_000, 'zh-CN')).toBe('1 分 23 秒');
    expect(formatDurationMs(83_000, 'en-US')).toBe('1m 23s');
  });

  it('formats hour + minute durations, dropping seconds', () => {
    expect(formatDurationMs(3_725_000, 'zh-CN')).toBe('1 小时 2 分');
    expect(formatDurationMs(3_725_000, 'en-US')).toBe('1h 2m');
  });
});

// 用本地时区正午做基准：偏移几小时也不跨本地日历日，测试与运行机器时区解耦
const LOCAL_NOON = new Date(2026, 6, 19, 12, 0, 0).getTime();
const localIso = (offsetMs: number) => new Date(LOCAL_NOON + offsetMs).toISOString();

describe('formatRunTime', () => {
  it('returns empty string for missing or invalid input', () => {
    expect(formatRunTime(undefined, 'zh-CN', LOCAL_NOON)).toBe('');
    expect(formatRunTime('not-a-date', 'en-US', LOCAL_NOON)).toBe('');
  });

  it('returns 刚刚 for near-now timestamps', () => {
    expect(formatRunTime(localIso(0), 'zh-CN', LOCAL_NOON)).toBe('刚刚');
    expect(formatRunTime(localIso(-5_000), 'zh-CN', LOCAL_NOON)).toBe('刚刚');
  });

  it('uses minute granularity below one hour', () => {
    expect(formatRunTime(localIso(-2 * 60_000), 'zh-CN', LOCAL_NOON)).toBe('2分钟前');
    expect(formatRunTime(localIso(-2 * 60_000), 'en-US', LOCAL_NOON)).toBe('2 minutes ago');
  });

  it('uses hour granularity within the same local day', () => {
    expect(formatRunTime(localIso(-3 * 3_600_000), 'zh-CN', LOCAL_NOON)).toBe('3小时前');
    expect(formatRunTime(localIso(-3 * 3_600_000), 'en-US', LOCAL_NOON)).toBe('3 hours ago');
    expect(formatRunTime(localIso(3 * 3_600_000), 'en-US', LOCAL_NOON)).toBe('in 3 hours');
  });

  it('shows yesterday with a clock time for the previous local day', () => {
    const ts = LOCAL_NOON - 24 * 3_600_000;
    const time = (locale: string) =>
      new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(ts);
    expect(formatRunTime(localIso(-24 * 3_600_000), 'zh-CN', LOCAL_NOON)).toBe(`昨天 ${time('zh-CN')}`);
    expect(formatRunTime(localIso(-24 * 3_600_000), 'en-US', LOCAL_NOON)).toBe(`yesterday ${time('en-US')}`);
  });

  it('uses day granularity between two and six days', () => {
    expect(formatRunTime(localIso(-3 * 86_400_000), 'zh-CN', LOCAL_NOON)).toBe('3天前');
    expect(formatRunTime(localIso(-3 * 86_400_000), 'en-US', LOCAL_NOON)).toBe('3 days ago');
  });

  it('falls back to an absolute date at one week or beyond', () => {
    const ts = LOCAL_NOON - 10 * 86_400_000;
    expect(formatRunTime(localIso(-10 * 86_400_000), 'en-US', LOCAL_NOON)).toBe(
      new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(ts),
    );
  });
});

describe('formatDayLabel', () => {
  it('returns empty string for missing or invalid input', () => {
    expect(formatDayLabel(undefined, 'en-US', LOCAL_NOON)).toBe('');
    expect(formatDayLabel('nope', 'en-US', LOCAL_NOON)).toBe('');
  });

  it('labels today and yesterday with capitalized relative words', () => {
    expect(formatDayLabel(localIso(0), 'zh-CN', LOCAL_NOON)).toBe('今天');
    expect(formatDayLabel(localIso(-24 * 3_600_000), 'zh-CN', LOCAL_NOON)).toBe('昨天');
    expect(formatDayLabel(localIso(0), 'en-US', LOCAL_NOON)).toBe('Today');
    expect(formatDayLabel(localIso(-24 * 3_600_000), 'en-US', LOCAL_NOON)).toBe('Yesterday');
  });

  it('labels older same-year dates with month, day and weekday', () => {
    const ts = LOCAL_NOON - 3 * 86_400_000;
    expect(formatDayLabel(localIso(-3 * 86_400_000), 'en-US', LOCAL_NOON)).toBe(
      new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', weekday: 'long' }).format(ts),
    );
  });

  it('labels cross-year dates with the full date', () => {
    const ts = new Date(2025, 6, 10, 12, 0, 0).getTime();
    expect(formatDayLabel(new Date(ts).toISOString(), 'en-US', LOCAL_NOON)).toBe(
      new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(ts),
    );
  });
});
