/** 复习计划（SM-2）服务结果类型；仓储类型直接复用 L11 `vfs.repo.core@1` 的公开契约。 */
export type {
  CalendarHeatmapData, DueReviewsFilter, DueReviewsResult, ReviewHistory, ReviewPlan,
  ReviewPlanStatus, ReviewStats,
} from '../../vfs-repos/api.ts';

import type { ReviewHistory, ReviewPlan } from '../../vfs-repos/api.ts';

export interface ProcessReviewResult {
  plan: ReviewPlan;
  passed: boolean;
  new_interval: number;
  next_review_date: string;
  history: ReviewHistory;
}

export interface BatchCreateResult {
  created: number;
  skipped: number;
  failed: number;
  plans: ReviewPlan[];
}
