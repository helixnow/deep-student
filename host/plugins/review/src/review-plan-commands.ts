/**
 * `review_plan_*` 命令层（Rust `src-tauri/src/cmd` 中的薄包装）。
 *
 * Rust 这些命令返回 `Result<_, String>`：错误值就是纯字符串，不经过 AppError。
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { errorText } from './errors.ts';
import { ReviewPlanService, defaultReviewPlanConfig } from './review-plan.ts';
import type { DueReviewsFilter } from './review-plan-types.ts';

function service(ctx: Context): ReviewPlanService {
  const repos = ctx.get('vfsRepo') as VfsReposService | undefined;
  if (repos === undefined) throw new Error('vfsRepo service is not available');
  return new ReviewPlanService(
    ctx.storage.database('vfs'),
    repos,
    ctx.mastery,
    defaultReviewPlanConfig(),
    message => ctx.logger('review').warn(message),
    message => ctx.logger('review').info(message),
  );
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new CommandError(errorText(error));
  }
}

interface CreateArgs { questionId: string; examId: string }
interface ProcessArgs {
  planId: string;
  quality: number;
  userAnswer?: string | null;
  timeSpentSeconds?: number | null;
}
interface DueArgs { examId?: string | null; untilDate?: string | null }
interface FilterArgs { filter: DueReviewsFilter }
interface ExamArgs { examId?: string | null }
interface PlanArgs { planId: string }
interface QuestionArgs { questionId: string }
interface HistoryArgs { planId: string; limit?: number | null }
interface BatchArgs { questionIds: string[]; examId: string }
interface ListArgs { examId: string; limit?: number | null; offset?: number | null }
interface CalendarArgs { startDate?: string | null; endDate?: string | null; examId?: string | null }

export function registerReviewPlanCommands(ctx: Context): void {
  ctx.commands.register<CreateArgs>('review_plan_create', ({ questionId, examId }) =>
    wrap(() => service(ctx).createReviewPlan(questionId, examId)));

  ctx.commands.register<ProcessArgs>('review_plan_process', ({ planId, quality, userAnswer, timeSpentSeconds }) => {
    if (quality > 5) throw new CommandError('Quality must be between 0 and 5');
    return wrap(() => service(ctx).processReview(
      planId, quality, userAnswer ?? null, timeSpentSeconds ?? null,
    ));
  });

  ctx.commands.register<DueArgs>('review_plan_get_due', ({ examId, untilDate }) =>
    wrap(() => service(ctx).getDueReviews(examId ?? null, untilDate ?? null)));

  ctx.commands.register<FilterArgs>('review_plan_get_due_with_filter', ({ filter }) =>
    wrap(() => service(ctx).getDueReviewsWithFilter(filter)));

  ctx.commands.register<ExamArgs>('review_plan_get_stats', ({ examId }) =>
    wrap(() => service(ctx).getReviewStats(examId ?? null)));

  ctx.commands.register<ExamArgs>('review_plan_refresh_stats', ({ examId }) =>
    wrap(() => service(ctx).refreshReviewStats(examId ?? null)));

  ctx.commands.register<QuestionArgs>('review_plan_get_by_question', ({ questionId }) =>
    wrap(() => service(ctx).getPlanByQuestion(questionId)));

  ctx.commands.register<PlanArgs>('review_plan_get', ({ planId }) =>
    wrap(() => service(ctx).getPlan(planId)));

  ctx.commands.register<PlanArgs>('review_plan_suspend', ({ planId }) =>
    wrap(() => service(ctx).suspendPlan(planId)));

  ctx.commands.register<PlanArgs>('review_plan_resume', ({ planId }) =>
    wrap(() => service(ctx).resumePlan(planId)));

  ctx.commands.register<PlanArgs>('review_plan_delete', ({ planId }) =>
    wrap(() => { service(ctx).deletePlan(planId); return null; }));

  ctx.commands.register<HistoryArgs>('review_plan_get_history', ({ planId, limit }) =>
    wrap(() => service(ctx).getReviewHistory(planId, limit ?? null)));

  ctx.commands.register<BatchArgs>('review_plan_batch_create', ({ questionIds, examId }) =>
    wrap(() => service(ctx).batchCreateFromQuestions(questionIds, examId)));

  ctx.commands.register<ExamArgs & { examId: string }>('review_plan_create_for_exam', ({ examId }) =>
    wrap(() => service(ctx).createPlansForExam(examId)));

  ctx.commands.register<ListArgs>('review_plan_list_by_exam', ({ examId, limit, offset }) =>
    wrap(() => service(ctx).listPlansByExam(examId, limit ?? null, offset ?? null)));

  ctx.commands.register<CreateArgs>('review_plan_get_or_create', ({ questionId, examId }) =>
    wrap(() => service(ctx).getOrCreatePlan(questionId, examId)));

  ctx.commands.register<CalendarArgs>('review_plan_get_calendar_data', ({ startDate, endDate, examId }) =>
    wrap(() => service(ctx).getCalendarData(startDate ?? null, endDate ?? null, examId ?? null)));
}
