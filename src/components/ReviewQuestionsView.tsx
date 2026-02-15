/**
 * 错题本视图 - Notion 风格
 */

import React, { useState, useMemo, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from './custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  Check,
  X,
  ChevronRight,
  Trash2,
  RefreshCw,
  BookOpen,
  Zap,
  History,
  ArrowUpDown,
  ChevronDown,
  Target,
  Clock,
  Award,
  AlertTriangle,
} from 'lucide-react';
import { Badge } from '@/components/ui/shad/Badge';
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
  easy: { color: 'text-emerald-600' },
  medium: { color: 'text-amber-600' },
  hard: { color: 'text-orange-600' },
  very_hard: { color: 'text-rose-600' },
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
          <div className="relative w-10 h-10">
            <svg className="w-full h-full transform -rotate-90" viewBox="0 0 40 40">
              <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/20" />
              <circle
                cx="20" cy="20" r="16"
                fill="none" stroke="currentColor" strokeWidth="3"
                strokeDasharray={`${(1 - progressPercent / 100) * 100.5} 100.5`}
                className="text-amber-500"
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs font-semibold text-amber-600">{reviewCount}</span>
            </div>
          </div>
          <div className="text-sm">
            <span className="text-muted-foreground">{t('review:questions.toReview')}</span>
          </div>
        </div>
        
        {/* 已掌握 */}
        <div className="text-sm">
          <span className="font-medium text-emerald-500">{masteredCount}</span>
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
            <span className="flex items-center gap-1 text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {byDifficulty.easy}
            </span>
          )}
          {byDifficulty.medium > 0 && (
            <span className="flex items-center gap-1 text-amber-600">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              {byDifficulty.medium}
            </span>
          )}
          {byDifficulty.hard > 0 && (
            <span className="flex items-center gap-1 text-orange-600">
              <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
              {byDifficulty.hard}
            </span>
          )}
          {byDifficulty.very_hard > 0 && (
            <span className="flex items-center gap-1 text-rose-600">
              <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
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
  onClick: () => void;
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
        'group flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all cursor-pointer',
        'hover:bg-muted/40',
        isSelected && 'bg-amber-500/5'
      )}
      onClick={onClick}
    >
      {/* 复选框 */}
      <div 
        className="flex-shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onSelect(!isSelected);
        }}
      >
        <div className={cn(
          'w-4 h-4 rounded border flex items-center justify-center transition-colors',
          isSelected 
            ? 'bg-amber-500 border-amber-500' 
            : 'border-muted-foreground/30 hover:border-amber-500'
        )}>
          {isSelected && <Check className="w-2.5 h-2.5 text-white" />}
        </div>
      </div>

      {/* 题号 */}
      <span className="text-sm font-medium text-muted-foreground w-10 flex-shrink-0">
        {question.questionLabel || `Q${originalIndex + 1}`}
      </span>
      
      {/* 难度指示器 */}
      {question.difficulty && (
        <span className={cn('text-xs font-medium flex-shrink-0', DIFFICULTY_CONFIG[question.difficulty].color)}>
          {t(`review:questions.difficulty.${question.difficulty}`)}
        </span>
      )}

      {/* 题目内容 */}
      <p className="flex-1 text-sm text-foreground/80 truncate">
        {question.content || question.ocrText || t('review:questions.noContent')}
      </p>

      {/* 统计信息 */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-shrink-0">
        <span>{t('review:questions.attemptCount', { count: attemptCount })}</span>
        <span className="text-rose-500 font-medium">{errorRate}%</span>
        <span className="hidden sm:inline">{lastAttemptText}</span>
      </div>

      <ChevronRight className="w-4 h-4 text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-all flex-shrink-0" />
    </div>
  );
};

/**
 * 空状态
 */
const EmptyState: React.FC = () => {
  const { t } = useTranslation(['review']);
  return (
    <div className="flex flex-col items-center justify-center h-full py-16">
      <div className="p-6 rounded-3xl bg-gradient-to-br from-emerald-500/10 to-sky-500/10 mb-6">
        <Award className="w-16 h-16 text-emerald-500" />
      </div>
      <h3 className="text-xl font-semibold mb-2">{t('review:questions.emptyTitle')}</h3>
      <p className="text-muted-foreground text-center max-w-sm">
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
  const { t } = useTranslation(['review']);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isOperating, setIsOperating] = useState(false);

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

  // 切换选择
  const toggleSelect = useCallback((id: string, selected: boolean) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (selected) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  // 全选/取消全选
  const toggleSelectAll = useCallback(() => {
    if (selectedIds.size === reviewQuestions.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(reviewQuestions.map(q => q.id)));
    }
  }, [selectedIds.size, reviewQuestions]);

  // 重置选中题目进度
  const handleResetProgress = useCallback(async () => {
    if (selectedIds.size === 0 || !onResetProgress) return;
    setIsOperating(true);
    try {
      await onResetProgress(Array.from(selectedIds));
      setSelectedIds(new Set());
    } finally {
      setIsOperating(false);
    }
  }, [selectedIds, onResetProgress]);

  // 删除选中题目
  const handleDelete = useCallback(async () => {
    if (selectedIds.size === 0 || !onDelete) return;
    setIsOperating(true);
    try {
      await onDelete(Array.from(selectedIds));
      setSelectedIds(new Set());
    } finally {
      setIsOperating(false);
    }
  }, [selectedIds, onDelete]);

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
          <NotionButton variant="ghost" size="sm" onClick={onStartReview} className="text-sm font-medium text-amber-600 hover:bg-amber-500/10">
            <Zap className="w-3.5 h-3.5" />
            {t('review:questions.startReview', { count: reviewQuestions.length })}
          </NotionButton>

          {/* 右侧：批量操作 */}
          <div className="flex items-center gap-1.5">
            <NotionButton variant="ghost" size="sm" onClick={toggleSelectAll} className="!px-2 !py-1 !h-auto text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50">
              {selectedIds.size === reviewQuestions.length ? t('review:questions.cancel') : t('review:questions.selectAll')}
            </NotionButton>
            
            {selectedIds.size > 0 && (
              <>
                <NotionButton variant="ghost" size="sm" onClick={handleResetProgress} disabled={isOperating || !onResetProgress} className="!px-2 !py-1 !h-auto text-xs text-sky-600 hover:bg-sky-500/10 disabled:opacity-50">
                  <RefreshCw className={cn('w-3 h-3', isOperating && 'animate-spin')} />
                  {t('review:questions.reset')}
                </NotionButton>
                <NotionButton variant="ghost" size="sm" onClick={handleDelete} disabled={isOperating || !onDelete} className="!px-2 !py-1 !h-auto text-xs text-rose-600 hover:bg-rose-500/10 disabled:opacity-50">
                  <Trash2 className="w-3 h-3" />
                  {t('review:questions.delete')}
                </NotionButton>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 再掌握流程提示 - 更紧凑 */}
      <div className="flex-shrink-0 px-4 py-1.5">
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/30 text-xs text-muted-foreground">
          <AlertTriangle className="w-3.5 h-3.5 text-sky-500 flex-shrink-0" />
          <span>
            <Trans i18nKey="review:questions.masteryTip" components={{ highlight: <span className="font-medium text-sky-600" /> }} />
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
              onClick={() => handleQuestionClick(q.id)}
            />
          ))}
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default ReviewQuestionsView;
