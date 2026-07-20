/**
 * quickOptions — 详情面板日期/提醒快捷选项计算
 *
 * 日期预设与 RescheduleMenu 的语义一致（今天/明天/周末/下周一）；
 * 提醒预设基于截止日期 + 时间（缺省 09:00）推算 datetime-local 字符串。
 */

import { addDays, formatLocalDate, mondayWeekStart } from '../../../types';

export interface QuickDateOption {
  /** i18n 复用 todo:reschedule.* 的 key */
  key: 'today' | 'tomorrow' | 'weekend' | 'nextMonday';
  date: string;
}

/** 今天/明天/周末（即将到来的周六，今天已是周末则省略）/下周一 */
export function getQuickDateOptions(now: Date = new Date()): QuickDateOption[] {
  const day = now.getDay();
  const weekend =
    day === 6 || day === 0 ? null : formatLocalDate(addDays(now, (6 - day + 7) % 7));
  const options: QuickDateOption[] = [
    { key: 'today', date: formatLocalDate(now) },
    { key: 'tomorrow', date: formatLocalDate(addDays(now, 1)) },
  ];
  if (weekend) options.push({ key: 'weekend', date: weekend });
  options.push({ key: 'nextMonday', date: formatLocalDate(addDays(mondayWeekStart(now), 7)) });
  return options;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 提醒时间缺省锚点（未设截止时间时按 09:00 提醒） */
const REMINDER_DEFAULT_TIME = '09:00';

/**
 * 由截止日期/时间推出提醒时刻（datetime-local：YYYY-MM-DDTHH:mm）。
 * offsetMinutes 为提前分钟数（0 = 准点）。
 */
export function reminderFromDue(
  dueDate: string,
  dueTime: string | undefined,
  offsetMinutes: number,
): string {
  const [y, m, d] = dueDate.split('-').map(Number);
  const time = dueTime && /^\d{1,2}:\d{2}/.test(dueTime) ? dueTime : REMINDER_DEFAULT_TIME;
  const [hh, mm] = time.split(':').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1, hh ?? 9, (mm ?? 0) - offsetMinutes);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

/**
 * 归一化提醒值为 datetime-local 可接受的 YYYY-MM-DDTHH:mm。
 * 旧数据/外部写入可能带秒或毫秒（YYYY-MM-DDTHH:mm:ss），原样塞给
 * <input type="datetime-local"> 会显示为空——统一裁到分钟精度。
 */
export function normalizeReminderValue(value?: string | null): string {
  if (!value) return '';
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(value);
  return m ? m[1] : value;
}

/** 提醒快捷偏移：准点 / 提前 15 分钟 / 提前 1 小时（key 对应 todo:detail.* 文案） */
export const REMINDER_QUICK_OFFSETS = [
  { key: 'reminderAtTime', minutes: 0 },
  { key: 'reminderBefore15', minutes: 15 },
  { key: 'reminderBefore60', minutes: 60 },
] as const;
