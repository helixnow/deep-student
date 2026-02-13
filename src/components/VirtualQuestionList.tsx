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
import { NotionButton } from '@/components/ui/NotionButton';
import {
  CheckCircle,
  XCircle,
  Star,
  ChevronRight,
} from 'lucide-react';
import type { Question, QuestionStatus, Difficulty } from '@/api/questionBankApi';

interface VirtualQuestionListProps {
  questions: Question[];
  currentIndex?: number;
  onSelect?: (question: Question, index: number) => void;
  onToggleFavorite?: (questionId: string) => void;
  className?: string;
  estimateSize?: number;
}

const statusColors: Record<QuestionStatus, string> = {
  new: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
  in_progress: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  mastered: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  review: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
};

// Status labels are resolved via i18n at render time
const STATUS_KEYS: Record<QuestionStatus, string> = {
  new: 'new',
  in_progress: 'in_progress',
  mastered: 'mastered',
  review: 'review',
};

const difficultyColors: Record<Difficulty, string> = {
  easy: 'text-emerald-500',
  medium: 'text-amber-500',
  hard: 'text-red-500',
  very_hard: 'text-purple-500',
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
      <div className={cn('flex items-center justify-center h-full text-muted-foreground', className)}>
        {t('questionBank.noQuestions')}
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      className={cn('overflow-auto', className)}
      style={{ contain: 'strict' }}
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
                  'flex items-center gap-3 px-3 py-2 border-b border-border/50 cursor-pointer transition-colors',
                  isActive
                    ? 'bg-primary/10 border-l-2 border-l-primary'
                    : 'hover:bg-muted/50',
                )}
                onClick={() => handleSelect(question, virtualItem.index)}
              >
                {/* 序号 */}
                <div className="w-8 text-center text-sm text-muted-foreground font-mono">
                  {virtualItem.index + 1}
                </div>

                {/* 内容 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {question.questionLabel || `${t('questionBank.content')} ${virtualItem.index + 1}`}
                    </span>
                    {question.isCorrect === true && (
                      <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                    )}
                    {question.isCorrect === false && (
                      <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                    )}
                    {question.difficulty && (
                      <span className={cn('text-xs', difficultyColors[question.difficulty])}>
                        ●
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {question.content.slice(0, 60)}
                    {question.content.length > 60 && '...'}
                  </p>
                </div>

                {/* 状态 */}
                <Badge className={cn('text-xs flex-shrink-0', statusColors[question.status])}>
                  {t(`questionBank.status.${STATUS_KEYS[question.status]}`)}
                </Badge>

                {/* 操作 */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={(e) => handleFavorite(e, question.id)}
                  >
                    <Star
                      className={cn(
                        'w-3.5 h-3.5',
                        question.isCorrect ? 'fill-yellow-500 text-yellow-500' : 'text-muted-foreground'
                      )}
                    />
                  </NotionButton>
                </div>

                <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default VirtualQuestionList;
