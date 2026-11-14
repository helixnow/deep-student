/**
 * 虚拟滚动题目列表
 * 
 * P2-4 功能：大量题目的高性能渲染
 * 
 * 🆕 2026-01 新增
 */

import React, { useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/shad/Badge';
import { DsButton } from '@/components/ui/DsButton';
import {
  CheckCircle,
  XCircle,
  Star,
  CaretRight,
  BookOpen,
} from '@phosphor-icons/react';
import type { Question, QuestionStatus, Difficulty } from '@/api/questionBankApi';
import { CustomScrollArea } from './custom-scroll-area';

interface VirtualQuestionListProps {
  questions: Question[];
  currentIndex?: number;
  onSelect?: (question: Question, index: number) => void;
  onToggleFavorite?: (questionId: string) => void;
  className?: string;
  estimateSize?: number;
}

// 语义色圆点 token：跟随主题深浅模式，与做题视图状态配色一致
const statusDots: Record<QuestionStatus, string> = {
  new: 'bg-muted-foreground/35',
  in_progress: 'bg-primary',
  mastered: 'bg-success',
  review: 'bg-warning',
};

// Status labels are resolved via i18n at render time
const STATUS_KEYS: Record<QuestionStatus, string> = {
  new: 'new',
  in_progress: 'in_progress',
  mastered: 'mastered',
  review: 'review',
};

// 语义色圆点 token：与做题视图的难度指示一致
const difficultyDots: Record<Difficulty, string> = {
  easy: 'bg-success/75',
  medium: 'bg-warning/75',
  hard: 'bg-warning',
  very_hard: 'bg-destructive/80',
};

export const VirtualQuestionList: React.FC<VirtualQuestionListProps> = ({
  questions,
  currentIndex = -1,
  onSelect,
  onToggleFavorite,
  className,
  estimateSize = 80,
}) => {
  const { t } = useTranslation('exam_sheet');
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: questions.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan: 5,
  });

  const virtualItems = virtualizer.getVirtualItems();

  const handleSelect = useCallback((question: Question, index: number) => {
    onSelect?.(question, index);
  }, [onSelect]);

  const handleFavorite = useCallback((e: React.MouseEvent, questionId: string) => {
    e.stopPropagation();
    onToggleFavorite?.(questionId);
  }, [onToggleFavorite]);

  if (questions.length === 0) {
    return (
      <div className={cn('flex flex-col items-center justify-center gap-2 h-full text-muted-foreground', className)}>
        <div className="rounded-md bg-muted/50 p-2.5">
          <BookOpen size={20} aria-hidden />
        </div>
        <span className="text-sm">{t('questionBank.noQuestions')}</span>
      </div>
    );
  }

  return (
    <CustomScrollArea
      viewportRef={parentRef}
      viewportProps={{ style: { contain: 'strict' } }}
      className={className}
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {virtualItems.map((virtualItem) => {
          const question = questions[virtualItem.index];
          const isActive = virtualItem.index === currentIndex;
          // Question.status 为可选字段，缺失时按"新题"渲染，避免 undefined 索引产生空样式/空文案
          const status: QuestionStatus = question.status ?? 'new';

          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
            >
              <div
                className={cn(
                  // 触屏：整行命中高度 ≥44px（桌面精确指针保持紧凑行高）
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors [@media(pointer:coarse)]:min-h-11',
                  isActive
                    ? 'bg-primary/[0.06]'
                    : 'hover:bg-foreground/[0.035]',
                )}
                onClick={() => handleSelect(question, virtualItem.index)}
              >
                {/* 序号 */}
                <div className="w-8 text-center font-mono text-xs tabular-nums text-muted-foreground">
                  {virtualItem.index + 1}
                </div>

                {/* 内容 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {question.questionLabel || `${t('questionBank.content')} ${virtualItem.index + 1}`}
                    </span>
                    {question.isCorrect === true && (
                      <CheckCircle size={14} className="text-success flex-shrink-0" />
                    )}
                    {question.isCorrect === false && (
                      <XCircle size={14} className="text-destructive flex-shrink-0" />
                    )}
                    {question.difficulty && (
                      <span
                        className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', difficultyDots[question.difficulty])}
                        aria-hidden="true"
                      />
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {question.content.slice(0, 60)}
                    {question.content.length > 60 && '...'}
                  </p>
                </div>

                {/* 状态 */}
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground flex-shrink-0">
                  <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', statusDots[status])} aria-hidden="true" />
                  <span>{t(`questionBank.status.${STATUS_KEYS[status]}`)}</span>
                </span>

                {/* 操作 */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  {/* 触屏：收藏钮命中区放大到 44px，负 margin 抵消占位保持行高稳定 */}
                  <DsButton
                    variant="ghost"
                    size="icon"
                    aria-label={t('questionBank.favorite', { defaultValue: 'favorite' })}
                    className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:-m-2"
                    onClick={(e) => handleFavorite(e, question.id)}
                  >
                    <Star
                      className={cn(
                        'w-3.5 h-3.5',
                        question.isFavorite ? 'fill-warning text-warning' : 'text-muted-foreground'
                      )}
/>
                  </DsButton>
                </div>

                <CaretRight size={16} className="text-muted-foreground flex-shrink-0" />
              </div>
            </div>
          );
        })}
      </div>
    </CustomScrollArea>
  );
};

export default VirtualQuestionList;
