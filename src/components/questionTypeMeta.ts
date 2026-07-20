/**
 * 题型元数据（浏览/管理类视图共享）
 *
 * 统一题型的图标、徽章配色与 i18n 文案 key，避免各视图各自穷举。
 * 覆盖既有 9 种题型 + 2026-07 新增的 true_false / matching / ordering / numeric。
 *
 * 注意：ExtendedQuestionType 在后端子代理把新题型并入
 * `QuestionType`（src/api/questionBankApi.ts）之前保持前向兼容 ——
 * 联合类型合并后重复成员会自动收敛，无需再改本文件。
 */

import type { Icon } from '@phosphor-icons/react';
import {
  RadioButton,
  CheckSquare,
  ListChecks,
  TextAa,
  ChatText,
  Article,
  Calculator,
  MathOperations,
  ToggleLeft,
  ArrowsLeftRight,
  ListNumbers,
  NumberSquareOne,
  Question as QuestionIcon,
} from '@phosphor-icons/react';
import type { QuestionType } from '@/api/questionBankApi';

export type ExtendedQuestionType =
  | QuestionType
  | 'true_false'
  | 'matching'
  | 'ordering'
  | 'numeric';

export interface QuestionTypeMeta {
  /** 完整 i18n key（含命名空间），如 learningHub:exam.library.type.single_choice */
  labelKey: string;
  /** phosphor 图标组件 */
  icon: Icon;
  /** 徽章配色（Tailwind 语义 token，深浅色模式通用） */
  pill: string;
}

const typeLabelKey = (type: string) => `learningHub:exam.library.type.${type}`;

/** 选择类 → primary，文字类 → info，计算类 → warning，结构类 → success，其他 → muted */
export const QUESTION_TYPE_META: Record<ExtendedQuestionType, QuestionTypeMeta> = {
  single_choice: { labelKey: typeLabelKey('single_choice'), icon: RadioButton, pill: 'bg-primary/10 text-primary' },
  multiple_choice: { labelKey: typeLabelKey('multiple_choice'), icon: CheckSquare, pill: 'bg-primary/10 text-primary' },
  indefinite_choice: { labelKey: typeLabelKey('indefinite_choice'), icon: ListChecks, pill: 'bg-primary/10 text-primary' },
  true_false: { labelKey: typeLabelKey('true_false'), icon: ToggleLeft, pill: 'bg-primary/10 text-primary' },
  fill_blank: { labelKey: typeLabelKey('fill_blank'), icon: TextAa, pill: 'bg-info/10 text-info' },
  short_answer: { labelKey: typeLabelKey('short_answer'), icon: ChatText, pill: 'bg-info/10 text-info' },
  essay: { labelKey: typeLabelKey('essay'), icon: Article, pill: 'bg-info/10 text-info' },
  calculation: { labelKey: typeLabelKey('calculation'), icon: Calculator, pill: 'bg-warning/10 text-warning' },
  numeric: { labelKey: typeLabelKey('numeric'), icon: NumberSquareOne, pill: 'bg-warning/10 text-warning' },
  proof: { labelKey: typeLabelKey('proof'), icon: MathOperations, pill: 'bg-warning/10 text-warning' },
  matching: { labelKey: typeLabelKey('matching'), icon: ArrowsLeftRight, pill: 'bg-success/10 text-success' },
  ordering: { labelKey: typeLabelKey('ordering'), icon: ListNumbers, pill: 'bg-success/10 text-success' },
  other: { labelKey: typeLabelKey('other'), icon: QuestionIcon, pill: 'bg-muted/60 text-muted-foreground' },
};

/** 筛选器等 UI 的稳定展示顺序 */
export const QUESTION_TYPE_ORDER: ExtendedQuestionType[] = [
  'single_choice',
  'multiple_choice',
  'indefinite_choice',
  'true_false',
  'fill_blank',
  'short_answer',
  'essay',
  'calculation',
  'numeric',
  'proof',
  'matching',
  'ordering',
  'other',
];

/** 未知/缺失题型统一回退到 other，保证渲染兜底 */
export function getQuestionTypeMeta(type?: string | null): QuestionTypeMeta {
  if (type && Object.prototype.hasOwnProperty.call(QUESTION_TYPE_META, type)) {
    return QUESTION_TYPE_META[type as ExtendedQuestionType];
  }
  return QUESTION_TYPE_META.other;
}
