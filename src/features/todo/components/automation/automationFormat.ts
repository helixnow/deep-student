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
 * 运行耗时："1 分 23 秒" / "45 秒"（英文环境为 "1m 23s" / "45s"）。
 * 任一端缺失、无效或负区间返回 ''。
 * `locale` 为可选扩展参数，默认中文以匹配契约示例。
 */
export function formatDuration(
  startIso?: string,
  endIso?: string,
  locale = 'zh-CN',
): string {
  const start = parseIso(startIso);
  const end = parseIso(endIso);
  if (start === null || end === null) return '';

  const diffMs = end - start;
  if (diffMs < 0) return '';

  const totalSeconds = Math.round(diffMs / SECOND_MS);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (isZh(locale)) {
    return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
