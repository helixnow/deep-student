/**
 * 复习计划主视图
 *
 * Notion 风格 UI，包含：
 * - 今日复习卡片：显示今日到期复习数、已完成数
 * - 复习队列列表：显示待复习题目，按到期时间排序
 * - 复习进度条
 * - 开始复习按钮
 *
 * 🆕 2026-01 新增
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Card } from '@/components/ui/shad/Card';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import {
  Play,
  Clock,
  CheckCircle,
  Warning as Warning,
  Calendar,
  Target,
  TrendUp as TrendingUp,
  ArrowCounterClockwise as ArrowCounterClockwise,
  CaretRight as CaretRight,
  CircleNotch as CircleNotch,
  BookOpen,
  Fire as Flame,
  Lightning as Lightning,
  Trophy as Award,
  ArrowsClockwise as ArrowClockwise,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  useReviewPlanStore,
  type ReviewPlan,
  type ReviewStats,
  type ReviewItemWithQuestion,
} from '@/stores/reviewPlanStore';
import { useShallow } from 'zustand/react/shallow';
import { useQuestionBankStore, type Question } from '../stores/questionBankStore';

// ============================================================================
// 类型定义
// ============================================================================

interface ReviewPlanViewProps {
  examId?: string;
  className?: string;
  onStartReview?: (items: ReviewItemWithQuestion[]) => void;
  onViewCalendar?: () => void;
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
  description?: string;
  color?: string;
  className?: string;
}

// ============================================================================
// 统计卡片组件
// ============================================================================

const StatCard: React.FC<StatCardProps> = ({
  icon,
  label,
  value,
  description,
  color = 'text-primary',
  className,
}) => (
  <div
    className={cn(
      'group relative flex flex-col gap-2 p-4 rounded-xl',
      'bg-gradient-to-br from-background to-muted/30',
      'border border-border/50 hover:border-border',
      'transition-[background-color,border-color,color,box-shadow] duration-300 hover:shadow-md',
      className
    )}
  >
    <div className="flex items-center justify-between">
      <div className={cn('p-2 rounded-lg bg-muted/50', color)}>{icon}</div>
      <span className={cn('text-2xl font-bold tracking-tight', color)}>{value}</span>
    </div>
    <div>
      <p className="text-sm font-medium text-foreground">{label}</p>
      {description && (
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      )}
    </div>
  </div>
);

// ============================================================================
// 复习队列项组件
// ============================================================================

interface ReviewQueueItemProps {
  plan: ReviewPlan;
  question?: Question;
  isOverdue: boolean;
  onClick?: () => void;
}

const ReviewQueueItem: React.FC<ReviewQueueItemProps> = ({
  plan,
  question,
  isOverdue,
  onClick,
}) => {
  const { t } = useTranslation(['review']);

  const statusColor = useMemo(() => {
    if (isOverdue) return 'text-red-500 bg-red-500/10';
    if (plan.is_difficult) return 'text-amber-500 bg-amber-500/10';
    switch (plan.status) {
      case 'new':
        return 'text-blue-500 bg-blue-500/10';
      case 'learning':
        return 'text-amber-500 bg-amber-500/10';
      case 'reviewing':
        return 'text-emerald-500 bg-emerald-500/10';
      case 'graduated':
        return 'text-purple-500 bg-purple-500/10';
      default:
        return 'text-muted-foreground bg-muted';
    }
  }, [plan.status, plan.is_difficult, isOverdue]);

  const statusLabel = useMemo(() => {
    if (isOverdue) return t('review:status.overdue');
    if (plan.is_difficult) return t('review:status.difficult');
    switch (plan.status) {
      case 'new':
        return t('review:status.new');
      case 'learning':
        return t('review:status.learning');
      case 'reviewing':
        return t('review:status.reviewing');
      case 'graduated':
        return t('review:status.graduated');
      default:
        return plan.status;
    }
  }, [plan.status, plan.is_difficult, isOverdue, t]);

  return (
    <div
      onClick={onClick}
      className={cn(
        'group flex items-center gap-3 p-3 rounded-lg',
        'bg-muted/20 hover:bg-[var(--interactive-hover)]',
        'border border-transparent hover:border-border/50',
        'cursor-pointer transition-[background-color,border-color,color,box-shadow] duration-200',
        isOverdue && 'border-red-500/30 bg-red-500/5'
      )}
    >
      {/* 状态指示器 */}
      <div
        className={cn(
          'flex-shrink-0 w-2 h-8 rounded-full',
          isOverdue ? 'bg-red-500' : plan.is_difficult ? 'bg-amber-500' : 'bg-emerald-500'
        )}
/>

      {/* 题目信息 */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground line-clamp-2">
          {question?.content?.slice(0, 80) || t('review:unknownQuestion')}
          {(question?.content?.length || 0) > 80 && '...'}
        </p>
        <div className="flex items-center gap-2 mt-1">
          <Badge variant="secondary" className={cn('text-xs px-1.5 py-0', statusColor)}>
            {statusLabel}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {t('review:interval')}: {plan.interval_days}
            {t('review:days')}
          </span>
          {plan.total_reviews > 0 && (
            <span className="text-xs text-muted-foreground">
              {t('review:accuracy')}:{' '}
              {Math.round((plan.total_correct / plan.total_reviews) * 100)}%
            </span>
          )}
        </div>
      </div>

      {/* 箭头 */}
      <CaretRight size={16} className="flex-shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ReviewPlanView: React.FC<ReviewPlanViewProps> = ({
  examId,
  className,
  onStartReview,
  onViewCalendar,
}) => {
  const { t } = useTranslation(['review', 'common']);

  // Store
  const {
    dueReviews,
    stats,
    isLoading,
    loadDueReviews,
    loadStats,
    refreshStats,
    startSession,
  } = useReviewPlanStore();

  const { questions, loadQuestions } = useQuestionBankStore(
    useShallow((state) => ({
      questions: state.questions,
      loadQuestions: state.loadQuestions,
    }))
  );

  // 本地状态
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 加载数据
  useEffect(() => {
    loadDueReviews(examId);
    loadStats(examId);
    if (examId) {
      loadQuestions(examId);
    }
  }, [examId, loadDueReviews, loadStats, loadQuestions]);

  // 刷新数据
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await loadDueReviews(examId);
      await refreshStats(examId);
    } finally {
      setIsRefreshing(false);
    }
  }, [examId, loadDueReviews, refreshStats]);

  // 计算统计数据
  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  const overdueCount = useMemo(
    () => dueReviews.filter((p) => p.next_review_date < today).length,
    [dueReviews, today]
  );

  const todayCount = useMemo(
    () => dueReviews.filter((p) => p.next_review_date === today).length,
    [dueReviews, today]
  );

  const difficultCount = useMemo(
    () => dueReviews.filter((p) => p.is_difficult).length,
    [dueReviews]
  );

  // 计算进度
  const progressPercent = useMemo(() => {
    if (!stats || stats.total_plans === 0) return 0;
    return Math.round((stats.graduated_count / stats.total_plans) * 100);
  }, [stats]);

  // 获取题目内容的映射
  const questionMap = useMemo(() => {
    const map = new Map<string, Question>();
    questions.forEach((q, id) => map.set(id, q));
    return map;
  }, [questions]);

  // 开始复习
  const handleStartReview = useCallback(() => {
    const items: ReviewItemWithQuestion[] = dueReviews.map((plan) => ({
      plan,
      question: questionMap.get(plan.question_id) as ReviewItemWithQuestion['question'],
    }));

    if (onStartReview) {
      onStartReview(items);
    } else {
      startSession(items);
    }
  }, [dueReviews, questionMap, onStartReview, startSession]);

  // 加载状态
  if (isLoading && !stats) {
    return (
      <div className={cn('space-y-6 p-4', className)}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-32 rounded-xl" />
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-6', className)}>
      {/* 头部标题和刷新按钮 */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {t('review:title')}
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t('review:subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <NotionButton
            variant="outline"
            size="sm"
            onClick={onViewCalendar}
            className="gap-1.5"
          >
            <Calendar size={16} />
            {t('review:calendar')}
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            disabled={isRefreshing}
 className="w-8 h-8"           >
            <ArrowClockwise
              className={cn('w-4 h-4', isRefreshing && 'animate-spin')}
/>
          </NotionButton>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<Clock size={20} />}
          label={t('review:stats.dueToday')}
          value={todayCount}
          description={
            overdueCount > 0
              ? t('review:stats.overdueHint', {
                  count: overdueCount,
                })
              : undefined
          }
          color={overdueCount > 0 ? 'text-red-500' : 'text-sky-500'}
/>
        <StatCard
          icon={<Flame size={20} />}
          label={t('review:stats.totalDue')}
          value={dueReviews.length}
          description={
            difficultCount > 0
              ? t('review:stats.difficultHint', {
                  count: difficultCount,
                })
              : undefined
          }
          color="text-amber-500"
/>
        <StatCard
          icon={<Award size={20} />}
          label={t('review:stats.mastered')}
          value={stats?.graduated_count || 0}
          description={`${progressPercent}% ${t('review:stats.ofTotal')}`}
          color="text-emerald-500"
/>
        <StatCard
          icon={<TrendingUp size={20} />}
          label={t('review:stats.accuracy')}
          value={`${Math.round((stats?.avg_correct_rate || 0) * 100)}%`}
          description={`${stats?.total_reviews || 0} ${t(
            'review:stats.totalReviews'
          )}`}
          color="text-purple-500"
/>
      </div>

      {/* 今日复习卡片 */}
      <Card className="p-5 bg-gradient-to-br from-primary/5 to-primary/10 border-primary/20">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-primary/10">
              <Target size={24} className="text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">
                {t('review:todayReview.title')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {dueReviews.length > 0
                  ? t('review:todayReview.hasDue', {
                      count: dueReviews.length,
                    })
                  : t('review:todayReview.noDue')}
              </p>
            </div>
          </div>

          {dueReviews.length > 0 && (
            <NotionButton
              size="lg"
              onClick={handleStartReview}
              className="gap-2 bg-primary hover:bg-primary/90 shadow-lg shadow-primary/25"
            >
              <Play size={20} />
              {t('review:startReview')}
            </NotionButton>
          )}
        </div>

        {/* 进度条 */}
        {stats && stats.total_plans > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {t('review:progress.label')}
              </span>
              <span className="font-medium">
                {stats.graduated_count} / {stats.total_plans}
              </span>
            </div>
            <Progress value={progressPercent} className="h-2" />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-blue-500" />
                  {t('review:status.new')} {stats.new_count}
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-amber-500" />
                  {t('review:status.learning')} {stats.learning_count}
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-emerald-500" />
                  {t('review:status.reviewing')} {stats.reviewing_count}
                </span>
              </div>
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-purple-500" />
                {t('review:status.graduated')} {stats.graduated_count}
              </span>
            </div>
          </div>
        )}
      </Card>

      {/* 复习队列 */}
      {dueReviews.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-foreground">
              {t('review:queue.title')}
            </h3>
            <span className="text-xs text-muted-foreground">
              {t('review:queue.sortedByDue')}
            </span>
          </div>

          <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
            {dueReviews.slice(0, 20).map((plan) => (
              <ReviewQueueItem
                key={plan.id}
                plan={plan}
                question={questionMap.get(plan.question_id)}
                isOverdue={plan.next_review_date < today}
/>
            ))}
            {dueReviews.length > 20 && (
              <div className="text-center py-2">
                <span className="text-xs text-muted-foreground">
                  {t('review:queue.andMore', {
                    count: dueReviews.length - 20,
                  })}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 空状态 */}
      {dueReviews.length === 0 && !isLoading && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="p-4 rounded-full bg-emerald-500/10 mb-4">
            <CheckCircle size={48} className="text-emerald-500" />
          </div>
          <h3 className="text-lg font-medium text-foreground mb-1">
            {t('review:empty.title')}
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            {t('review:empty.description')}
          </p>
        </div>
      )}
    </div>
  );
};

export default ReviewPlanView;
