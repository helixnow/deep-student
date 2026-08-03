/**
 * 到期日期展示层工具（TodoMainPanel 及其子组件共用）
 *
 * formatDueDateLabel 的语义被 tests/vitest/todo/formatDueDateLabel.test.ts 钉死：
 * 今天/明天/昨天 → todo:dates.* 键；近 7 天 → 星期；其余 → 短日期。
 */

import type { TodoItem } from '../../types';
import { addDays, formatLocalDate, isOverdue, localToday } from '../../types';

export function formatDueDateLabel(
  dueDate: string,
  t: (key: string) => string,
  lang?: string,
): string {
  const now = new Date();
  const today = formatLocalDate(now);
  if (dueDate === today) return t('todo:dates.today');
  if (dueDate === formatLocalDate(addDays(now, 1))) return t('todo:dates.tomorrow');
  if (dueDate === formatLocalDate(addDays(now, -1))) return t('todo:dates.yesterday');
  const d = new Date(`${dueDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dueDate;
  const locale = lang?.startsWith('zh') ? 'zh-CN' : 'en-US';
  try {
    // 未来 6 天内：星期几（如「周五」/ "Fri"）
    if (dueDate > today && dueDate <= formatLocalDate(addDays(now, 6))) {
      return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(d);
    }
    const sameYear = d.getFullYear() === now.getFullYear();
    return new Intl.DateTimeFormat(
      locale,
      sameYear
        ? { month: 'short', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric' },
    ).format(d);
  } catch {
    return dueDate;
  }
}

/**
 * 展示层逾期判断：在 types.isOverdue（仅比较日期）的基础上，
 * 今天到期且带 dueTime 的任务在时间已过后也按逾期高亮。
 * 不改变 isOverdue 本身的语义（分组/角标等仍按日期口径）。
 */
export function isDisplayOverdue(item: TodoItem): boolean {
  if (isOverdue(item)) return true;
  if (item.status !== 'pending' || !item.dueDate || !item.dueTime) return false;
  if (item.dueDate !== localToday()) return false;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return item.dueTime < hhmm;
}
