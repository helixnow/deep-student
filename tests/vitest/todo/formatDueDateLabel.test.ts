/**
 * formatDueDateLabel — 到期日期人性化契约
 *
 * 行内元数据把原始 YYYY-MM-DD 转成「今天/明天/昨天/近 7 天星期/短日期」，
 * 完整日期通过 title 提示保留。此处锁定相对日期与降级行为。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}));

import { formatDueDateLabel } from '@/features/todo/components/TodoMainPanel';
import { addDays, formatLocalDate } from '@/features/todo/types';

const t = (key: string) => key;

describe('formatDueDateLabel', () => {
  const now = new Date();
  const today = formatLocalDate(now);
  const tomorrow = formatLocalDate(addDays(now, 1));
  const yesterday = formatLocalDate(addDays(now, -1));

  it('maps today / tomorrow / yesterday to relative i18n keys', () => {
    expect(formatDueDateLabel(today, t, 'zh-CN')).toBe('todo:dates.today');
    expect(formatDueDateLabel(tomorrow, t, 'zh-CN')).toBe('todo:dates.tomorrow');
    expect(formatDueDateLabel(yesterday, t, 'zh-CN')).toBe('todo:dates.yesterday');
  });

  it('uses weekday label for dates within the next 6 days', () => {
    const inFourDays = addDays(now, 4);
    const label = formatDueDateLabel(formatLocalDate(inFourDays), t, 'zh-CN');
    const expected = new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(inFourDays);
    expect(label).toBe(expected);
  });

  it('uses short month-day for same-year dates beyond a week', () => {
    // 取 30 天后；若跨年则该分支输出含年份，两种断言都接受同一 Intl 输出
    const future = addDays(now, 30);
    const sameYear = future.getFullYear() === now.getFullYear();
    const label = formatDueDateLabel(formatLocalDate(future), t, 'en-US');
    const expected = new Intl.DateTimeFormat(
      'en-US',
      sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' },
    ).format(future);
    expect(label).toBe(expected);
  });

  it('includes year for other-year dates', () => {
    const nextYear = `${now.getFullYear() + 1}-03-15`;
    const label = formatDueDateLabel(nextYear, t, 'en-US');
    expect(label).toContain(String(now.getFullYear() + 1));
  });

  it('falls back to the raw string for invalid input', () => {
    expect(formatDueDateLabel('not-a-date', t, 'zh-CN')).toBe('not-a-date');
  });
});
