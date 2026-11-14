/**
 * 答题/改判事务提交后的 SM-2 复习计划副作用。
 *
 * Rust 在 `submit_answer`、`regrade_submission_in_tx`、`submit_draft` 提交后
 * 创建/复用错题计划，并用“今日到期”的答对推进计划；全部失败只告警，不阻塞
 * 答题结果。计划本身属于 L15 review，qbank 只经 `ReviewPlanPort` 调用。
 */
import { localDate } from '../repository/questions.ts';
import type { QbankLogger } from './ports.ts';
import type { ReviewPlanPort } from './practice-grading-queue.ts';

export interface ReviewPlanHost {
  readonly reviewPlan?: ReviewPlanPort;
  readonly log?: QbankLogger;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface EnsureReviewPlanOptions {
  /** Rust submit_answer 成功创建后写 info；regrade 路径不写。 */
  readonly logSuccess: boolean;
  /** Rust 的失败前缀，例如 "Failed to auto-create review plan for"。 */
  readonly failureLabel: string;
  readonly tag?: string;
}

export function ensureReviewPlan(host: ReviewPlanHost, questionId: string, examId: string,
  options: EnsureReviewPlanOptions): void {
  const review = host.reviewPlan;
  if (review === undefined) return;
  try {
    const plan = review.getOrCreatePlan(questionId, examId) as { id?: unknown } | null;
    if (options.logSuccess) {
      const planId = plan !== null && typeof plan === 'object' && typeof plan.id === 'string'
        ? plan.id : '';
      host.log?.info?.(
        `[QuestionBankService] Auto review plan for wrong answer: question_id=${questionId}, plan_id=${planId}`);
    }
  } catch (error) {
    host.log?.warn(
      `[QuestionBankService] ${options.failureLabel} question_id=${questionId}: ${errorText(error)}`);
  }
}

/** 答对且已有到期计划时，把本次练习当作一次回忆正确的复习推进计划。 */
export function advanceDueReviewPlan(host: ReviewPlanHost, questionId: string): void {
  const review = host.reviewPlan;
  if (review === undefined) return;
  let plan: { id: string; next_review_date: string } | null;
  try {
    // Rust `if let Ok(Some(plan))`：查询失败静默跳过，只告警推进失败。
    plan = review.getPlanByQuestion(questionId);
  } catch {
    return;
  }
  if (plan === null || plan.next_review_date > localDate()) return;
  try {
    review.advanceFromPractice(plan.id);
  } catch (error) {
    host.log?.warn(
      `[QuestionBankService] Failed to advance review plan for question_id=${questionId}: ${errorText(error)}`);
  }
}
