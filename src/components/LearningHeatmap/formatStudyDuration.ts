import { splitDuration } from '@/features/study-time/studyLog';
import type { TFunction } from 'i18next';

/** 秒 → 「1 小时 05 分」/「38 分钟」/「不到 1 分钟」 */
export function formatStudyDuration(seconds: number, t: TFunction): string {
  if (!(seconds > 0)) return t('heatmap.duration.zero');
  const { hours, minutes } = splitDuration(seconds);
  if (hours === 0 && minutes === 0) return t('heatmap.duration.lessThanMinute');
  if (hours === 0) return t('heatmap.duration.minutes', { minutes });
  if (minutes === 0) return t('heatmap.duration.hours', { hours });
  return t('heatmap.duration.hoursMinutes', { hours, minutes: String(minutes).padStart(2, '0') });
}
