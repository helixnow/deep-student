/**
 * 调度配置更新的校验（拆分自 `review.ts`）。
 *
 * 字段范围与错误文案逐条对应 Rust `validate_config_update`。
 */
import { checkParametersUsable, MAX_STEP_MINUTES, MAX_STEPS } from './fsrs-scheduler.ts';
import type { FsrsSchedulerConfigUpdate } from './fsrs-types.ts';
import { appError } from './errors.ts';

export const REVIEW_ORDERS = ['due', 'retrievability', 'random'] as const;
export const NEW_REVIEW_ORDERS = ['after', 'before', 'mix'] as const;
export const MAX_ANSWER_SECONDS_LIMIT = 3600;

export function validateSchedulerConfigUpdate(update: FsrsSchedulerConfigUpdate): void {
  if (update.learnAheadMinutes != null && update.learnAheadMinutes > 60) {
    throw appError('Validation', 'learnAheadMinutes must be within [0, 60]');
  }
  if (update.desiredRetention != null) {
    const value = update.desiredRetention;
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      throw appError('Validation', 'desiredRetention must be within (0, 1)');
    }
  }
  if (update.leechAction != null && update.leechAction !== 'suspend' && update.leechAction !== 'mark') {
    throw appError('Validation', "leechAction must be 'suspend' or 'mark'");
  }
  for (const [name, steps] of [
    ['learningSteps', update.learningSteps],
    ['relearningSteps', update.relearningSteps],
  ] as const) {
    if (steps == null) continue;
    if (steps.length > MAX_STEPS || steps.some(minutes => !Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_STEP_MINUTES)) {
      throw appError('Validation', `${name} must contain at most ${MAX_STEPS} positive minute values up to ${MAX_STEP_MINUTES}`);
    }
  }
  if (update.maximumInterval != null
    && (update.maximumInterval === 0 || update.maximumInterval > 36_500)) {
    throw appError('Validation', 'maximumInterval must be within [1, 36500]');
  }
  if (update.dayRolloverHour != null && update.dayRolloverHour > 23) {
    throw appError('Validation', 'dayRolloverHour must be within [0, 23]');
  }
  if (update.reviewOrder != null && !(REVIEW_ORDERS as readonly string[]).includes(update.reviewOrder)) {
    throw appError('Validation', "reviewOrder must be 'due', 'retrievability' or 'random'");
  }
  if (update.newReviewOrder != null && !(NEW_REVIEW_ORDERS as readonly string[]).includes(update.newReviewOrder)) {
    throw appError('Validation', "newReviewOrder must be 'after', 'before' or 'mix'");
  }
  if (update.maxAnswerSeconds != null
    && (update.maxAnswerSeconds === 0 || update.maxAnswerSeconds > MAX_ANSWER_SECONDS_LIMIT)) {
    throw appError('Validation', `maxAnswerSeconds must be within [1, ${MAX_ANSWER_SECONDS_LIMIT}]`);
  }
  if (update.fsrsParams != null && update.fsrsParams.length > 0
    && !checkParametersUsable(update.fsrsParams)) {
    throw appError('Validation', 'fsrsParams must contain 17, 19 or 21 finite values');
  }
}
