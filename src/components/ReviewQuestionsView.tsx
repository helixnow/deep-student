/**
 * 错题本视图 - Notion 风格
 */

import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from './custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  Check,
  X,
  CaretRight as CaretRight,
  Trash as Trash,
  ArrowsClockwise as ArrowClockwise,
  Lightning as Lightning,
  Trophy as Award,
  Warning as Warning,
} from '@phosphor-icons/react';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useTranslation, Trans } from 'react-i18next';
import type { Question, QuestionBankStats, Difficulty } from '@/api/questionBankApi';

export interface ReviewQuestionsViewProps {
  /** 所有题目（组件内部会过滤出 review 状态的） */
  questions: Question[];
  /** 统计信息 */
  stats?: QuestionBankStats;
  /** 点击题目进入练习 */
  onQuestionClick?: (index: number) => void;
  /** 开始复习（进入 review_first 练习模式） */
  onStartReview?: () => void;
  /** 重置题目进度（将 review 状态重置为 new） */
  onResetProgress?: (questionIds: string[]) => Promise<void>;
  /** 删除题目 */
  onDelete?: (questionIds: string[]) => Promise<void>;
  className?: string;
}

const DIFFICULTY_CONFIG: Record<Difficulty, { color: string }> = {
  easy: { color: 'text-success' },
  medium: { color: 'text-warning' },
  hard: { color: 'text-destructive/80' },
  very_hard: { color: 'text-destructive' },
};

/**
 * 错题统计卡片
 */
const ReviewStatsCard: React.FC<{
  reviewQuestions: Question[];
  totalQuestions: number;
  stats?: QuestionBankStats;
}> = ({ reviewQuestions, totalQuestions, stats }) => {
  const { t } = useTranslation(['review']);
  // 计算复习相关统计
  const reviewCount = reviewQuestions.length;
  const totalAttempts = reviewQuestions.reduce((sum, q) => sum + (q.attemptCount || 0), 0);
  const avgAttempts = reviewCount > 0 ? (totalAttempts / reviewCount).toFixed(1) : '0';
  
  // 按难度分组
  const byDifficulty = useMemo(() => {
    const counts: Record<string, number> = { easy: 0, medium: 0, hard: 0, very_hard: 0, unknown: 0 };
    reviewQuestions.forEach(q => {
      const diff = q.difficulty || 'unknown';
      counts[diff] = (counts[diff] || 0) + 1;
    });
    return counts;
  }, [reviewQuestions]);

  // 计算复习进度（已掌握 / (已掌握 + 待复习)）
  const masteredCount = stats?.mastered || 0;
  const progressPercent = (masteredCount + reviewCount) > 0 
    ? (masteredCount / (masteredCount + reviewCount)) * 100 
    : 100;

  return (
    <div className="flex items-center justify-between gap-6 px-1">
      <div className="flex items-center gap-6">
        {/* 待复习数 */}
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 relative">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/20" />
              <circle
                cx="20" cy="20" r="16"
                fill="none" stroke="currentColor" strokeWidth="3"
                strokeDasharray={`${(1 - progressPercent / 100) * 100.5} 100.5`}
                className="text-warning"
                strokeLinecap="round"
/>
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs font-semibold text-warning">{reviewCount}</span>
            </div>
          </div>
          <div className="text-sm">
            <span className="text-muted-foreground">{t('review:questions.toReview')}</span>
          </div>
        </div>
        
        {/* 已掌握 */}
        <div className="text-sm">
          <span className="font-medium text-success">{masteredCount}</span>
          <span className="text-muted-foreground ml-1">{t('review:questions.mastered')}</span>
        </div>
        
        {/* 平均尝试 */}
        <div className="text-sm text-muted-foreground hidden sm:block">
          <Trans i18nKey="review:questions.avgAttempts" values={{ count: avgAttempts }} components={{ bold: <span className="font-medium text-foreground" /> }} />
        </div>
        
        {/* 掌握率 */}
        <div className="text-sm">
          <span className="font-medium">{Math.round(progressPercent)}%</span>
          <span className="text-muted-foreground ml-1">{t('review:questions.masteryRate')}</span>
        </div>
      </div>
      
      {/* 难度分布 - 简化 */}
      {reviewCount > 0 && (
        <div className="hidden md:flex items-center gap-2 text-xs">
          {byDifficulty.easy > 0 && (
            <span className="flex items-center gap-1 text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              {byDifficulty.easy}
            </span>
          )}
          {byDifficulty.medium > 0 && (
            <span className="flex items-center gap-1 text-warning">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
              {byDifficulty.medium}
            </span>
          )}
          {byDifficulty.hard > 0 && (
            <span className="flex items-center gap-1 text-destructive/80">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive/80" />
              {byDifficulty.hard}
            </span>
          )}
          {byDifficulty.very_hard > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
              {byDifficulty.very_hard}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * 错题卡片
 */
const ReviewQuestionCard: React.FC<{
  question: Question;
  originalIndex: number;
  isSelected: boolean;
  onSelect: (selected: boolean) => void;
  onClick?: () => void;
}> = ({ question, originalIndex, isSelected, onSelect, onClick }) => {
  const { t } = useTranslation(['review']);
  const attemptCount = question.attemptCount || 0;
  const correctCount = question.correctCount || 0;
  const errorRate = attemptCount > 0 ? ((attemptCount - correctCount) / attemptCount * 100).toFixed(0) : '100';
  
  // 格式化最后尝试时间
  const lastAttemptText = useMemo(() => {
    if (!question.lastAttemptAt) return t('review:questions.neverPracticed');
    const date = new Date(question.lastAttemptAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    if (diffDays === 0) return t('review:questions.today');
    if (diffDays === 1) return t('review:questions.yesterday');
    if (diffDays < 7) return t('review:questions.daysAgo', { count: diffDays });
    if (diffDays < 30) return t('review:questions.weeksAgo', { count: Math.floor(diffDays / 7) });
    return t('review:questions.monthsAgo', { count: Math.floor(diffDays / 30) });
  }, [question.lastAttemptAt]);

  return (
    <div
      className={cn(
        'group flex min-h-11 items-center gap-2 rounded-md px-2 py-1.5 transition-colors sm:min-h-0',
        !isSelected && 'hover:bg-accent',
        isSelected && 'bg-warning/10'
      )}
    >
      {/* 复选框：触控命中区 ≥44px（移动端），视觉盒保持 16px */}
      <button
        type="button"
        role="checkbox"
        aria-checked={isSelected}
        aria-label={t('review:questions.selectQuestion', { label: question.questionLabel || `Q${originalIndex + 1}` })}
        className="flex h-11 w-11 -my-2 -ml-2 shrink-0 items-center justify-center sm:h-6 sm:w-6 sm:-my-0 sm:-ml-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(!isSelected);
        }}
      >
        <span
          aria-hidden="true"
          className={cn(
            'flex h-4 w-4 items-center justify-center rounded-sm border transition-colors',
            isSelected
              ? 'border-warning bg-warning text-warning-foreground'
              : 'border-muted-foreground/40 text-transparent hover:border-warning'
          )}
        >
          {isSelected && <Check size={10} />}
        </span>
      </button>

      <button type="button" onClick={onClick} disabled={!onClick} className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default">
        {/* 题号 */}
        <span className="w-10 shrink-0 text-sm font-medium text-muted-foreground">
          {question.questionLabel || `Q${originalIndex + 1}`}
        </span>
        {/* 难度指示器 */}
        {question.difficulty && (
          <span className={cn('shrink-0 text-xs font-medium', DIFFICULTY_CONFIG[question.difficulty].color)}>
            {t(`review:questions.difficulty.${question.difficulty}`)}
          </span>
        )}

        {/* 题目内容 */}
        <p className="flex-1 truncate text-sm text-foreground/80">
          {question.content || question.ocrText || t('review:questions.noContent')}
        </p>

        {/* 统计信息 */}
        <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
          <span>{t('review:questions.attemptCount', { count: attemptCount })}</span>
          <span className="font-medium text-destructive">{errorRate}%</span>
          <span className="hidden sm:inline">{lastAttemptText}</span>
        </div>

        <CaretRight size={16} className="shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground/60" />
      </button>
    </div>
  );
};

/**
 * 空状态
 */
const EmptyState: React.FC = () => {
  const { t } = useTranslation(['review']);
  return (
    <div className="flex h-full flex-col items-center justify-center py-12">
      <div className="mb-3 rounded-md bg-muted p-2">
        <Award className="h-7 w-7 text-muted-foreground" />
      </div>
      <h3 className="mb-1 text-sm font-medium">{t('review:questions.emptyTitle')}</h3>
      <p className="max-w-sm text-center text-sm text-muted-foreground">
        <Trans i18nKey="review:questions.emptyDesc" components={{ br: <br /> }} />
      </p>
    </div>
  );
};

export const ReviewQuestionsView: React.FC<ReviewQuestionsViewProps> = ({
  questions,
  stats,
  onQuestionClick,
  onStartReview,
  onResetProgress,
  onDelete,
  className,
}) => {
  const { t } = useTranslation(['review', 'practice', 'common']);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isOperating, setIsOperating] = useState(false);
  // 行内二次确认（无模态框）：首次点击进入待确认态，4s 后自动回退
  const [armedAction, setArmedAction] = useState<'delete' | 'reset' | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
  }, []);

  const disarm = useCallback(() => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    armTimerRef.current = null;
    setArmedAction(null);
  }, []);

  const armAction = useCallback((action: 'delete' | 'reset') => {
    if (armTimerRef.current) clearTimeout(armTimerRef.current);
    setArmedAction(action);
    armTimerRef.current = setTimeout(() => {
      setArmedAction(null);
      armTimerRef.current = null;
    }, 4000);
  }, []);

  // 过滤出需要复习的题目
  const reviewQuestions = useMemo(() => {
    return questions.filter(q => q.status === 'review');
  }, [questions]);

  // 获取原始索引映射
  const originalIndexMap = useMemo(() => {
    const map = new Map<string, number>();
    questions.forEach((q, idx) => map.set(q.id, idx));
    return map;
  }, [questions]);

  // 切换选择（选择集变化时撤销待确认态，避免确认数量与实际不一致）
  const toggleSelect = useCallback((id: string, selected: boolean) => {
    disarm();
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, [disarm]);

  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    disarm();
    if (selectedIds.size === reviewQuestions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(reviewQuestions.map(q => q.id)));
    }
  }, [selectedIds.size, reviewQuestions, disarm]);

  // 重置选中题目进度
  const handleResetProgress = useCallback(async () => {
    if (selectedIds.size === 0 || !onResetProgress) return;
    disarm();
    setIsOperating(true);
    try {
      const questionIds = Array.from(selectedIds);
      await onResetProgress(questionIds);
      setSelectedIds(new Set());
      showGlobalNotification('success', t('practice:questionBank.resetSuccess', { count: questionIds.length }));
    } catch (err: unknown) {
      showGlobalNotification('error', `${t('practice:questionBank.resetFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsOperating(false);
    }
  }, [selectedIds, onResetProgress, disarm, t]);

  // 删除选中题目
  const handleDelete = useCallback(async () => {
    if (selectedIds.size === 0 || !onDelete) return;
    disarm();
    setIsOperating(true);
    try {
      const questionIds = Array.from(selectedIds);
      await onDelete(questionIds);
      setSelectedIds(new Set());
      showGlobalNotification('success', t('practice:questionBank.deleteSuccess', { count: questionIds.length }));
    } catch (err: unknown) {
      showGlobalNotification('error', `${t('practice:questionBank.deleteFailed')}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsOperating(false);
    }
  }, [selectedIds, onDelete, disarm, t]);

  // 点击题目
  const handleQuestionClick = useCallback((questionId: string) => {
    const originalIndex = originalIndexMap.get(questionId);
    if (originalIndex !== undefined) {
      onQuestionClick?.(originalIndex);
    }
  }, [originalIndexMap, onQuestionClick]);

  // 空状态
  if (reviewQuestions.length === 0) {
    return <EmptyState />;
  }

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* 统计摘要 */}
      <div className="flex-shrink-0 px-4 py-3 border-b border-border/40">
        <ReviewStatsCard 
          reviewQuestions={reviewQuestions}
          totalQuestions={questions.length}
          stats={stats}
/>
      </div>

      {/* 操作栏 - 更紧凑 */}
      <div className="flex-shrink-0 px-4 py-2">
        <div className="flex items-center justify-between gap-3">
          {/* 左侧：开始复习按钮 */}
          {onStartReview && (
            <NotionButton variant="warning" size="sm" onClick={onStartReview}>
              <Lightning size={14} />
              {t('review:questions.startReview', { count: reviewQuestions.length })}
            </NotionButton>
          )}

          {/* 右侧：批量操作 */}
          <div className="flex items-center gap-1.5">
            <NotionButton variant="ghost" size="sm" onClick={toggleSelectAll} className="!px-2 !py-1 !h-auto text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]">
              {selectedIds.size === reviewQuestions.length ? t('review:questions.cancel') : t('review:questions.selectAll')}
            </NotionButton>
            
            {selectedIds.size > 0 && (
              <>
                {/* 行内二次确认：首次点击进入待确认态（warning/danger 高亮），再次点击执行 */}
                <NotionButton
                  variant={armedAction === 'reset' ? 'warning' : 'ghost'}
                  size="sm"
                  onClick={() => {
                    if (armedAction === 'reset') void handleResetProgress();
                    else armAction('reset');
                  }}
                  disabled={isOperating || !onResetProgress}
                  title={armedAction === 'reset' ? t('practice:questionBank.confirmResetDescDetail', { count: selectedIds.size }) : undefined}
                  className={cn(
                    '!h-auto min-h-8 !px-2 !py-1 text-xs disabled:opacity-50',
                    armedAction !== 'reset' && 'text-info hover:bg-info/10',
                  )}
                >
                  <ArrowClockwise className={cn('w-3 h-3', isOperating && 'animate-spin')} />
                  {armedAction === 'reset'
                    ? t('review:questions.confirmReset', { count: selectedIds.size })
                    : t('review:questions.reset')}
                </NotionButton>
                <NotionButton
                  variant={armedAction === 'delete' ? 'danger' : 'ghost'}
                  size="sm"
                  onClick={() => {
                    if (armedAction === 'delete') void handleDelete();
                    else armAction('delete');
                  }}
                  disabled={isOperating || !onDelete}
                  title={armedAction === 'delete' ? t('practice:questionBank.confirmDeleteDesc', { count: selectedIds.size }) : undefined}
                  className={cn(
                    '!h-auto min-h-8 !px-2 !py-1 text-xs disabled:opacity-50',
                    armedAction !== 'delete' && 'text-destructive hover:bg-destructive/10',
                  )}
                >
                  <Trash size={12} />
                  {armedAction === 'delete'
                    ? t('review:questions.confirmDelete', { count: selectedIds.size })
                    : t('review:questions.delete')}
                </NotionButton>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 再掌握流程提示 - 更紧凑 */}
      <div className="flex-shrink-0 px-4 py-1.5">
        <div className="flex items-center gap-2 rounded-md bg-info/10 px-3 py-2 text-xs text-muted-foreground">
          <Warning size={14} className="shrink-0 text-info" />
          <span>
            <Trans i18nKey="review:questions.masteryTip" components={{ highlight: <span className="font-medium text-info" /> }} />
          </span>
        </div>
      </div>

      {/* 错题列表 - 紧凑布局 */}
      <CustomScrollArea className="flex-1" viewportClassName="px-4 pb-4">
        <div className="space-y-0.5 pt-1">
          {reviewQuestions.map((q) => (
            <ReviewQuestionCard
              key={q.id}
              question={q}
              originalIndex={originalIndexMap.get(q.id) || 0}
              isSelected={selectedIds.has(q.id)}
              onSelect={(selected) => toggleSelect(q.id, selected)}
              onClick={onQuestionClick ? () => handleQuestionClick(q.id) : undefined}
/>
          ))}
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default ReviewQuestionsView;
