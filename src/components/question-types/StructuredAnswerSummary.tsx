/**
 * 结构化题型标准答案的只读摘要展示
 *
 * 用于编辑模式答案面板 / 提交结果卡片中，把 matching/ordering/numeric/true_false
 * 的标准答案渲染成人类可读形式（替代原始 JSON 文本）。
 *
 * 2026-07 题库题型扩展
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ArrowRight, Check, X } from '@phosphor-icons/react';
import { LatexText } from '@/components/LatexText';
import type {
  ExtendedQuestionType,
  MatchingStructuredData,
  OrderingStructuredData,
  NumericStructuredData,
} from './structured';
import { formatNumericAnswer } from './structured';

export interface StructuredAnswerSummaryProps {
  questionType: ExtendedQuestionType;
  matching?: MatchingStructuredData | null;
  ordering?: OrderingStructuredData | null;
  numeric?: NumericStructuredData | null;
  /** true_false 题：answer 字段（"true" | "false"） */
  trueFalseAnswer?: string | null;
  className?: string;
}

export const StructuredAnswerSummary: React.FC<StructuredAnswerSummaryProps> = ({
  questionType,
  matching,
  ordering,
  numeric,
  trueFalseAnswer,
  className,
}) => {
  const { t } = useTranslation('practice');

  if (questionType === 'true_false' && (trueFalseAnswer === 'true' || trueFalseAnswer === 'false')) {
    const isTrue = trueFalseAnswer === 'true';
    return (
      <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', isTrue ? 'text-success' : 'text-destructive', className)}>
        {isTrue ? <Check size={14} weight="bold" /> : <X size={14} />}
        {isTrue ? t('editor.trueFalse.true') : t('editor.trueFalse.false')}
      </span>
    );
  }

  if (questionType === 'numeric' && numeric) {
    return (
      <span className={cn('text-sm font-medium tabular-nums', className)}>
        {formatNumericAnswer(numeric)}
      </span>
    );
  }

  if (questionType === 'matching' && matching && matching.pairs.length > 0) {
    const leftByKey = new Map(matching.left.map((item) => [item.key, item.content]));
    const rightByKey = new Map(matching.right.map((item) => [item.key, item.content]));
    return (
      <div className={cn('space-y-1', className)}>
        {matching.pairs.map((pair) => (
          <div key={`${pair.left}-${pair.right}`} className="flex items-center gap-1.5 text-sm">
            <LatexText content={leftByKey.get(pair.left) || pair.left} className="min-w-0" />
            <ArrowRight size={12} className="flex-shrink-0 text-muted-foreground" aria-hidden />
            <LatexText content={rightByKey.get(pair.right) || pair.right} className="min-w-0" />
          </div>
        ))}
      </div>
    );
  }

  if (questionType === 'ordering' && ordering && ordering.correct_order.length > 0) {
    const contentByKey = new Map(ordering.items.map((item) => [item.key, item.content]));
    return (
      <ol className={cn('space-y-1', className)}>
        {ordering.correct_order.map((key, index) => (
          <li key={key} className="flex items-center gap-2 text-sm">
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
              {index + 1}
            </span>
            <LatexText content={contentByKey.get(key) || key} className="min-w-0" />
          </li>
        ))}
      </ol>
    );
  }

  return null;
};

export default StructuredAnswerSummary;
