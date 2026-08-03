/**
 * 复习视图题型穷举映射（图标 + i18n 文案 key）
 *
 * 覆盖 ExtendedQuestionType 的全部题型（含 2026-07 新增的
 * true_false / matching / ordering / numeric），复习相关视图
 * （ReviewSession / ReviewPlanView / ReviewQuestionsView / ReviewCalendarView）
 * 统一从这里取图标与文案 key，未知类型降级为 other。
 *
 * 文案 key 均位于 review:questionType.*（zh-CN / en-US 双语言）。
 */

import type { Icon } from '@phosphor-icons/react';
import {
  RadioButton,
  Checks,
  ListChecks,
  Textbox,
  ChatText,
  Article,
  Calculator,
  MathOperations,
  ToggleLeft,
  ArrowsLeftRight,
  ListNumbers,
  Hash,
  Question as QuestionMark,
} from '@phosphor-icons/react';
import type { ExtendedQuestionType } from '@/components/question-types/structured';

export interface ReviewQuestionTypeMeta {
  /** review:questionType.* 文案 key */
  labelKey: string;
  Icon: Icon;
}

const REVIEW_QUESTION_TYPE_META: Record<ExtendedQuestionType, ReviewQuestionTypeMeta> = {
  single_choice: { labelKey: 'review:questionType.single_choice', Icon: RadioButton },
  multiple_choice: { labelKey: 'review:questionType.multiple_choice', Icon: Checks },
  indefinite_choice: { labelKey: 'review:questionType.indefinite_choice', Icon: ListChecks },
  fill_blank: { labelKey: 'review:questionType.fill_blank', Icon: Textbox },
  short_answer: { labelKey: 'review:questionType.short_answer', Icon: ChatText },
  essay: { labelKey: 'review:questionType.essay', Icon: Article },
  calculation: { labelKey: 'review:questionType.calculation', Icon: Calculator },
  proof: { labelKey: 'review:questionType.proof', Icon: MathOperations },
  true_false: { labelKey: 'review:questionType.true_false', Icon: ToggleLeft },
  matching: { labelKey: 'review:questionType.matching', Icon: ArrowsLeftRight },
  ordering: { labelKey: 'review:questionType.ordering', Icon: ListNumbers },
  numeric: { labelKey: 'review:questionType.numeric', Icon: Hash },
  other: { labelKey: 'review:questionType.other', Icon: QuestionMark },
};

/** 取题型映射；未知/缺失类型降级为 other（穷举兜底，不抛错） */
export function getReviewQuestionTypeMeta(
  type: string | null | undefined
): ReviewQuestionTypeMeta {
  if (type && Object.prototype.hasOwnProperty.call(REVIEW_QUESTION_TYPE_META, type)) {
    return REVIEW_QUESTION_TYPE_META[type as ExtendedQuestionType];
  }
  return REVIEW_QUESTION_TYPE_META.other;
}
