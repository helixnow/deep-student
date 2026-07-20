/**
 * 定时任务运行历史的时间格式化工具。
 * 纯函数、无 i18next 依赖：调用方传入 locale（如 i18n.language）。
 * `now` 可选参数仅用于测试注入，默认取当前时间。
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
/** 小于该阈值视为"刚刚" */
const JUST_NOW_MS = 10 * SECOND_MS;

function parseIso(iso: string | undefined): number | null {
  if (!iso || typeof iso !== 'string' || !iso.trim()) return null;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : ts;
}

function isZh(locale: string): boolean {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('zh');
}

function toMs(now: Date | number): number {
  return typeof now === 'number' ? now : now.getTime();
}

/** 运行环境语言（navigator.language）；非浏览器环境回退 zh-CN */
function defaultLocale(): string {
  if (typeof navigator !== 'undefined' && typeof navigator.language === 'string' && navigator.language) {
    return navigator.language;
  }
  return 'zh-CN';
}

/**
 * 相对时间："3 小时后" / "2 分钟前" / "刚刚"。
 * 粒度自动选择：<60s → 秒/刚刚，<60m → 分，<24h → 时，<7d → 天，否则显示日期。
 * 无效或空输入返回 ''。
 */
export function formatRelativeTime(
  iso: string | undefined,
  locale: string,
  now: Date | number = Date.now(),
): string {
  const ts = parseIso(iso);
  if (ts === null) return '';

  const diffMs = ts - toMs(now);
  const absMs = Math.abs(diffMs);

  try {
    if (absMs >= WEEK_MS) {
      return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ts);
    }

    if (absMs < JUST_NOW_MS) {
      if (isZh(locale)) return '刚刚';
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
    }

    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
    if (absMs < MINUTE_MS) {
      return rtf.format(Math.round(diffMs / SECOND_MS), 'second');
    }
    if (absMs < HOUR_MS) {
      return rtf.format(Math.round(diffMs / MINUTE_MS), 'minute');
    }
    if (absMs < DAY_MS) {
      return rtf.format(Math.round(diffMs / HOUR_MS), 'hour');
    }
    return rtf.format(Math.round(diffMs / DAY_MS), 'day');
  } catch {
    return '';
  }
}

/**
 * 绝对时间：dateStyle medium + timeStyle short。无效或空输入返回 ''。
 */
export function formatAbsoluteTime(iso: string | undefined, locale: string): string {
  const ts = parseIso(iso);
  if (ts === null) return '';
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(ts);
  } catch {
    return '';
  }
}

/**
 * 运行耗时（起止 ISO 时间 → 人类可读），粒度与 {@link formatDurationMs} 一致
 * （小时以上显示"1 小时 2 分" / "1h 2m"）。任一端缺失、无效或负区间返回 ''。
 * `locale` 可选：缺省时回退运行环境语言（navigator.language）而非固定中文，
 * 避免英文环境渲染出中文时长；调用方仍应显式传入 UI 语言。
 */
export function formatDuration(
  startIso?: string,
  endIso?: string,
  locale?: string,
): string {
  const start = parseIso(startIso);
  const end = parseIso(endIso);
  if (start === null || end === null) return '';
  return formatDurationMs(end - start, locale ?? defaultLocale());
}

/**
 * 本地时区的日历日差：正数表示 ts 在过去（几天前），负数表示未来。
 * 按本地 00:00 对齐后取整，避免"23 小时前但已跨天"被算成同一天。
 */
function calendarDayDiff(ts: number, nowMs: number): number {
  const now = new Date(nowMs);
  const then = new Date(ts);
  const nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const thenStart = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime();
  return Math.round((nowStart - thenStart) / DAY_MS);
}

/** 首字母大写（拉丁语系分组标题用；CJK 无影响） */
function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;
}

/**
 * 时长（毫秒 → 人类可读）："45 秒" / "1 分 23 秒" / "1 小时 2 分"
 * （英文环境 "45s" / "1m 23s" / "1h 2m"）。
 * 负数或非有限值返回 ''。用于运行行的最终耗时与运行中实时计时。
 */
export function formatDurationMs(durationMs: number, locale: string): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '';
  const totalSeconds = Math.round(durationMs / SECOND_MS);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (isZh(locale)) {
    if (hours > 0) return `${hours} 小时 ${minutes} 分`;
    return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * 运行行的细粒度时间："刚刚" / "2 分钟前" / "3 小时前" / "昨天 14:32" /
 * "3 天前"，一周以上回退绝对日期；未来时间对称（"3 小时后" / "明天 08:00"）。
 * 跨天判定基于本地日历日而非 24 小时差。无效或空输入返回 ''。
 */
export function formatRunTime(
  iso: string | undefined,
  locale: string,
  now: Date | number = Date.now(),
): string {
  const ts = parseIso(iso);
  if (ts === null) return '';

  const nowMs = toMs(now);
  const diffMs = ts - nowMs;
  const absMs = Math.abs(diffMs);

  try {
    if (absMs < JUST_NOW_MS) {
      if (isZh(locale)) return '刚刚';
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
    }

    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
    if (absMs < MINUTE_MS) {
      return rtf.format(Math.round(diffMs / SECOND_MS), 'second');
    }
    if (absMs < HOUR_MS) {
      return rtf.format(Math.round(diffMs / MINUTE_MS), 'minute');
    }

    const dayDiff = calendarDayDiff(ts, nowMs);
    if (dayDiff === 0) {
      return rtf.format(Math.round(diffMs / HOUR_MS), 'hour');
    }
    if (Math.abs(dayDiff) === 1) {
      // "昨天 14:32" / "明天 08:00"
      const dayWord = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(-dayDiff, 'day');
      const timeLabel = new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(ts);
      return `${dayWord} ${timeLabel}`;
    }
    if (Math.abs(dayDiff) < 7) {
      return rtf.format(-dayDiff, 'day');
    }
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(ts);
  } catch {
    return '';
  }
}

/**
 * 按天分组的组标题："今天" / "昨天" / "明天"，其余同年显示"7月16日 星期四"
 * 风格（随 locale），跨年补全年份。无效或空输入返回 ''。
 */
export function formatDayLabel(
  iso: string | undefined,
  locale: string,
  now: Date | number = Date.now(),
): string {
  const ts = parseIso(iso);
  if (ts === null) return '';

  try {
    const nowMs = toMs(now);
    const dayDiff = calendarDayDiff(ts, nowMs);
    if (dayDiff >= -1 && dayDiff <= 1) {
      const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
      return capitalizeFirst(rtf.format(-dayDiff, 'day'));
    }
    const sameYear = new Date(ts).getFullYear() === new Date(nowMs).getFullYear();
    return capitalizeFirst(new Intl.DateTimeFormat(
      locale,
      sameYear ? { month: 'long', day: 'numeric', weekday: 'long' } : { dateStyle: 'long' },
    ).format(ts));
  } catch {
    return '';
  }
}
