import type { Question } from '@/api/questionBankApi';

/**
 * 错因标签（由作答统计推导，无需后端字段）：
 * - neverCorrect: 从未答对
 * - repeatedErrors: 反复错（错误 ≥3 次）
 * - highErrorRate: 高错误率（≥60% 且尝试 ≥2 次）
 * - stale: 久未复习（>14 天）
 */
export type ErrorCause = 'neverCorrect' | 'repeatedErrors' | 'highErrorRate' | 'stale';

const STALE_DAYS = 14;

export const ERROR_CAUSE_STYLE: Record<ErrorCause, string> = {
  neverCorrect: 'bg-destructive/10 text-destructive',
  repeatedErrors: 'bg-warning/10 text-warning',
  highErrorRate: 'bg-warning/10 text-warning',
  stale: 'bg-info/10 text-info',
};

export const getErrorCauses = (question: Question): ErrorCause[] => {
  const attempts = question.attemptCount || 0;
  const correct = question.correctCount || 0;
  const errors = attempts - correct;
  const causes: ErrorCause[] = [];

  if (attempts > 0 && correct === 0) {
    causes.push('neverCorrect');
  } else if (errors >= 3) {
    causes.push('repeatedErrors');
  } else if (attempts >= 2 && errors / attempts >= 0.6) {
    causes.push('highErrorRate');
  }

  if (question.lastAttemptAt) {
    const diffDays = (Date.now() - new Date(question.lastAttemptAt).getTime()) / 86400000;
    if (diffDays > STALE_DAYS) causes.push('stale');
  }
  return causes;
};
