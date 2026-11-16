/**
 * 题目集复习的四档评分（UX 审计 D2：调度改用 FSRS，与闪卡同一实现）。
 *
 * quality 沿用 0-5 口径（命令 / 智能体工具 / 每日冲刺都按它传），后端映射：
 * 0-2 → 重来 · 3 → 困难（算答对）· 4 → 良好 · 5 → 简单。
 * 间隔预演由后端随计划返回（`rating_previews`），前端只负责格式化。
 */
import type { ReviewPlan, ReviewQuality } from '@/stores/reviewPlanStore';

export type ReviewRatingKey = 'again' | 'hard' | 'good' | 'easy';

export const REVIEW_RATING_QUALITY: Record<ReviewRatingKey, ReviewQuality> = {
  again: 0,
  hard: 3,
  good: 4,
  easy: 5,
};

/** 键盘 1-4 → quality。 */
export const REVIEW_QUALITY_BY_KEY: Record<string, ReviewQuality> = {
  '1': REVIEW_RATING_QUALITY.again,
  '2': REVIEW_RATING_QUALITY.hard,
  '3': REVIEW_RATING_QUALITY.good,
  '4': REVIEW_RATING_QUALITY.easy,
};

type Translate = (key: string, options: { count: number }) => string;

/** 「1分钟 / 10分钟 / 1天 / 4天 / 2周 / 3个月」：分钟级学习步与按日间隔同一套标签。 */
export function formatReviewInterval(t: Translate, minutes: number): string {
  const safe = Number.isFinite(minutes) ? Math.max(0, minutes) : 0;
  if (safe < 60) return t('review:estimate.minutes', { count: Math.max(1, Math.round(safe)) });
  if (safe < 1440) return t('review:estimate.hours', { count: Math.max(1, Math.round(safe / 60)) });
  const days = Math.round(safe / 1440);
  if (days < 7) return t('review:estimate.days', { count: Math.max(1, days) });
  if (days < 30) return t('review:estimate.weeks', { count: Math.max(1, Math.round(days / 7)) });
  if (days < 365) return t('review:estimate.months', { count: Math.max(1, Math.round(days / 30)) });
  return t('review:estimate.years', { count: Math.max(1, Math.round(days / 365)) });
}

/** 四档按钮下方的间隔标签；后端没给预演（旧后端 / 演示数据）时为空串，按钮只显示评分名。 */
export function reviewIntervalLabels(t: Translate, plan: Pick<ReviewPlan, 'rating_previews'>): Record<ReviewRatingKey, string> {
  const previews = plan.rating_previews;
  const label = (key: ReviewRatingKey) => (previews ? formatReviewInterval(t, previews[key].interval_minutes) : '');
  return { again: label('again'), hard: label('hard'), good: label('good'), easy: label('easy') };
}
