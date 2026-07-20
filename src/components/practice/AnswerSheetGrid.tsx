/**
 * 答题卡宫格（限时练习 / 模拟考试共用）
 *
 * - 题号宫格：已答 / 未答 / 标记 三种状态色 + 当前题高亮
 * - 点击题号通过 QBANK_FOCUS_EVENT 跳转到对应题目（ExamContentView 监听后
 *   切换到做题视图并导航），同时双写 store.currentQuestionId 兜底
 * - 触控目标 ≥44px，窄容器自适应列数，无横向溢出
 */

import React, { useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { BookmarkSimple } from '@phosphor-icons/react';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import {
  QBANK_FOCUS_EVENT,
  type QbankFocusEventDetail,
} from '@/features/workbench/agent/drivers/qbankDriver';

export interface AnswerSheetGridProps {
  /** 会话内的题目 ID（按出题顺序） */
  questionIds: string[];
  /** 当前题目集，用于限定跳转事件的目标资源 */
  examId: string;
  /** 已作答题目 ID 集合 */
  answeredIds: ReadonlySet<string>;
  /** 标记待查的题目 ID 集合（如收藏标记），可选 */
  markedIds?: ReadonlySet<string>;
  className?: string;
}

export const AnswerSheetGrid: React.FC<AnswerSheetGridProps> = ({
  questionIds,
  examId,
  answeredIds,
  markedIds,
  className,
}) => {
  const { t } = useTranslation('practice');
  const currentQuestionId = useQuestionBankStore((state) => state.currentQuestionId);

  const answeredCount = useMemo(
    () => questionIds.reduce((acc, id) => acc + (answeredIds.has(id) ? 1 : 0), 0),
    [questionIds, answeredIds],
  );

  const handleNavigate = useCallback((questionId: string) => {
    // 双写：事件驱动视图切换 + store 当前题目，事件未被处理时下次进入做题视图也能定位
    useQuestionBankStore.getState().setCurrentQuestion(questionId);
    window.dispatchEvent(
      new CustomEvent<QbankFocusEventDetail>(QBANK_FOCUS_EVENT, {
        detail: { questionId, targetResourceId: examId },
      }),
    );
  }, [examId]);

  if (questionIds.length === 0) return null;

  return (
    <div className={cn('ui-rise-in space-y-2', className)}>
      {/* 图例 + 进度摘要 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm bg-success/70" />
          {t('answerSheet.answered')}
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2.5 w-2.5 rounded-sm border border-border bg-muted" />
          {t('answerSheet.unanswered')}
        </span>
        {markedIds && markedIds.size > 0 && (
          <span className="flex items-center gap-1">
            <BookmarkSimple size={12} weight="fill" className="text-warning" />
            {t('answerSheet.marked')}
          </span>
        )}
        <span className="ml-auto tabular-nums">
          {t('answerSheet.progress', { answered: answeredCount, total: questionIds.length })}
        </span>
      </div>

      {/* 题号宫格：最小 44px 触控目标，窄容器自动换列 */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1.5">
        {questionIds.map((id, idx) => {
          const answered = answeredIds.has(id);
          const marked = markedIds?.has(id) ?? false;
          const isCurrent = currentQuestionId === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleNavigate(id)}
              aria-label={t('answerSheet.jumpTo', { index: idx + 1 })}
              aria-current={isCurrent ? 'true' : undefined}
              className={cn(
                'relative flex min-h-11 items-center justify-center rounded-md border text-sm font-medium tabular-nums',
                'ui-press transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                answered
                  ? 'border-success/30 bg-success/15 text-success'
                  : 'border-border/60 bg-muted/60 text-muted-foreground hover:bg-[var(--interactive-hover)]',
                isCurrent && 'ring-2 ring-primary',
              )}
            >
              {idx + 1}
              {marked && (
                <BookmarkSimple
                  size={10}
                  weight="fill"
                  className="absolute right-0.5 top-0.5 text-warning"
                />
              )}
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground">{t('answerSheet.jumpHint')}</p>
    </div>
  );
};

export default AnswerSheetGrid;
