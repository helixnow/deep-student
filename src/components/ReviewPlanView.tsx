/**
 * 复习计划主视图
 *
 * 简洁风格 UI（与题目集管理页 QuestionBankManageView 同一设计语言），包含：
 * - 今日复习卡片：醒目但不焦虑的到期数量呈现 + 开始复习引导
 * - 复习队列列表：显示待复习题目，按到期时间排序
 * - 复习进度条
 * - 空状态：今日无复习时的纯 CSS 完成态插画
 *
 * 🆕 2026-01 新增；2026-07 复习体验改造；2026-07 美术对齐管理页
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Progress } from '@/components/ui/shad/Progress';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { CustomScrollArea } from './custom-scroll-area';
import {
  Play,
  Clock,
  CheckCircle,
  Calendar,
  Target,
  TrendUp as TrendingUp,
  CaretRight as CaretRight,
  Fire as Flame,
  Trophy as Award,
  ArrowsClockwise as ArrowClockwise,
  Sparkle,
  Star,
  WarningCircle,
  Info,
  Pause,
  ListPlus,
} from '@phosphor-icons/react';
import { getReviewQuestionTypeMeta } from '@/components/review/reviewQuestionTypeMeta';
import { ReviewStatTile } from '@/components/review/ReviewStatTile';
import { useTranslation } from 'react-i18next';
import {
  useReviewPlanStore,
  type ReviewPlan,
  type ReviewItemWithQuestion,
} from '@/stores/reviewPlanStore';
import { useShallow } from 'zustand/react/shallow';
import { useQuestionBankStore, type Question } from '../stores/questionBankStore';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { registerDomainListener } from '@/features/workbench/agent/domainEvents';

// ============================================================================
// 类型定义
// ============================================================================

// ★ P1 修复：改用本地日期。之前 toISOString()（UTC）在 UTC+8 本地 00:00-08:00
// 会得到前一天，导致"今日到期/已逾期"判断整天级错位。
const formatLocalDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

/** 列表进入 stagger：延迟随索引递增，封顶避免长列表尾部等待过久（与管理页同节奏） */
const staggerStyle = (index: number): React.CSSProperties => ({
  animationDelay: `${Math.min(index, 16) * 20}ms`,
});

interface ReviewPlanViewProps {
  /**
   * 本视图所属题目集。传入后视图数据与会话操作以该题目集为准（多窗口隔离）：
   * 其他窗口把全局 dueReviews 刷成别的题目集时，本视图仍只展示自己的计划。
   */
  examId?: string;
  className?: string;
  onStartReview?: (items: ReviewItemWithQuestion[]) => void;
  onViewCalendar?: () => void;
  onReviewItemClick?: (item: ReviewItemWithQuestion) => void;
}

// ============================================================================
// 复习队列项组件
// ============================================================================

interface ReviewQueueItemProps {
  plan: ReviewPlan;
  question?: Question;
  isOverdue: boolean;
  /** 逾期天数（isOverdue 时 > 0），用于"逾期 N 天"高亮标签 */
  overdueDays?: number;
  onClick?: () => void;
  /** 暂停该计划（可选；提供时行尾显示暂停按钮） */
  onSuspend?: () => void;
  suspendDisabled?: boolean;
  /** 列表入场 stagger 索引 */
  index?: number;
}

const ReviewQueueItem: React.FC<ReviewQueueItemProps> = ({
  plan,
  question,
  isOverdue,
  overdueDays = 0,
  onClick,
  onSuspend,
  suspendDisabled,
  index = 0,
}) => {
  const { t } = useTranslation(['review']);
  const typeMeta = getReviewQuestionTypeMeta(question?.question_type);
  const TypeIcon = typeMeta.Icon;

  const statusTone = useMemo(() => {
    if (isOverdue) return { text: 'text-destructive', bar: 'bg-destructive' };
    if (plan.is_difficult) return { text: 'text-warning', bar: 'bg-warning' };
    switch (plan.status) {
      case 'new':
        return { text: 'text-primary', bar: 'bg-primary' };
      case 'learning':
        return { text: 'text-warning', bar: 'bg-warning' };
      case 'reviewing':
        return { text: 'text-success', bar: 'bg-success' };
      case 'graduated':
      default:
        return { text: 'text-muted-foreground', bar: 'bg-muted-foreground/50' };
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
      style={staggerStyle(index)}
      className={cn(
        'ui-rise-in group flex w-full items-center gap-1 rounded-lg border bg-card',
        'transition-[background-color,border-color,box-shadow] duration-200 ease-standard motion-reduce:transition-none',
        isOverdue
          ? 'border-destructive/30 bg-destructive/5 hover:border-destructive/50'
          : 'border-border/60 hover:border-border hover:bg-[var(--interactive-hover)]'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-3 rounded-lg p-3 text-left',
          'cursor-pointer disabled:cursor-default',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
        )}
      >
        {/* 状态指示条 */}
        <div className={cn('h-9 w-1 flex-shrink-0 rounded-full', statusTone.bar)} />

        {/* 题目信息 */}
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm leading-snug text-foreground">
            {question?.content?.slice(0, 80) || t('review:unknownQuestion')}
            {(question?.content?.length || 0) > 80 && '...'}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            <span className={cn('font-medium', statusTone.text)}>{statusLabel}</span>
            {question && (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <TypeIcon size={12} className="opacity-70" />
                {t(typeMeta.labelKey)}
              </span>
            )}
            {/* 逾期高亮：显示逾期天数 */}
            {isOverdue && overdueDays > 0 && (
              <span className="font-medium tabular-nums text-destructive">
                {t('review:queue.overdueDays', { count: overdueDays })}
              </span>
            )}
            <span className="tabular-nums text-muted-foreground/80">
              {t('review:interval')}: {plan.interval_days}
              {t('review:days')}
            </span>
            {plan.total_reviews > 0 && (
              <span className="hidden tabular-nums text-muted-foreground/80 sm:inline">
                {t('review:accuracy')}:{' '}
                {Math.round((plan.total_correct / plan.total_reviews) * 100)}%
              </span>
            )}
          </div>
        </div>

        {/* 箭头 */}
        <CaretRight
          size={14}
          className="flex-shrink-0 text-muted-foreground/50 transition-[color,transform] duration-200 ease-standard group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none"
        />
      </button>

      {/* 暂停计划（内联操作，暂停可随时恢复，无需二次确认） */}
      {onSuspend && (
        <DsButton
          variant="ghost"
          iconOnly
          size="sm"
          onClick={onSuspend}
          disabled={suspendDisabled}
          aria-label={t('review:actions.suspend')}
          title={t('review:actions.suspend')}
          className="mr-1.5 h-9 w-9 shrink-0 text-muted-foreground opacity-60 hover:bg-[var(--interactive-hover)] hover:text-foreground hover:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
        >
          <Pause size={14} />
        </DsButton>
      )}
    </div>
  );
};

// ============================================================================
// 完成态空状态（纯 CSS / 图标插画，不引图片资源）
// ============================================================================

const AllDoneState: React.FC<{
  masteredCount: number;
  onViewCalendar?: () => void;
}> = ({ masteredCount, onViewCalendar }) => {
  const { t } = useTranslation(['review']);

  return (
    <div className="ui-rise-in flex flex-col items-center justify-center rounded-lg border border-border/50 bg-muted/10 px-6 py-14 text-center">
      {/* 同心圆 + 对勾 + 星点插画 */}
      <div className="relative mb-6 h-24 w-24" aria-hidden="true">
        <div className="absolute inset-0 rounded-full bg-success/10" />
        <div className="absolute inset-3 rounded-full bg-success/15" />
        <div className="absolute inset-6 flex items-center justify-center rounded-full bg-success/20">
          <CheckCircle size={36} weight="fill" className="text-success" />
        </div>
        <Sparkle
          size={15}
          weight="fill"
          className="absolute -top-1 right-3 text-warning motion-safe:animate-pulse"
        />
        <Star
          size={11}
          weight="fill"
          className="absolute bottom-2 -left-2 text-primary/60 motion-safe:animate-pulse [animation-delay:400ms]"
        />
        <Sparkle
          size={11}
          weight="fill"
          className="absolute top-8 -right-3 text-success/70 motion-safe:animate-pulse [animation-delay:800ms]"
        />
      </div>

      <h3 className="mb-1.5 text-base font-semibold text-foreground">
        {t('review:empty.title')}
      </h3>
      <p className="max-w-sm text-sm text-muted-foreground">
        {t('review:empty.description')}
      </p>

      <div className="mt-5 flex items-center gap-3">
        {masteredCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-success/20 bg-success/10 px-3 py-1 text-xs font-medium text-success">
            <Award size={13} weight="fill" />
            {t('review:empty.masteredChip', { count: masteredCount })}
          </span>
        )}
        {onViewCalendar && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onViewCalendar}
            className="gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]"
          >
            <Calendar size={14} />
            {t('review:empty.viewCalendar')}
          </DsButton>
        )}
      </div>
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
  onReviewItemClick,
}) => {
  const { t } = useTranslation(['review', 'common']);

  // Store
  const {
    dueReviews: rawDueReviews,
    stats: rawStats,
    isLoading,
    isProcessing,
    loadDueReviews,
    loadStats,
    refreshStats,
    startSession,
    session,
    suspendPlan,
    createPlansForExam,
  } = useReviewPlanStore();

  // ★ 多窗口隔离：dueReviews 是全局单槽位，另一窗口按别的题目集刷新后，
  // 本视图若不过滤会把别人的计划当成自己的队列（开始复习会跨题目集打分）。
  const dueReviews = useMemo(
    () => (examId ? rawDueReviews.filter((p) => p.exam_id === examId) : rawDueReviews),
    [rawDueReviews, examId]
  );

  // stats 同为全局单槽位：属于别的题目集时按"未加载"处理，等本视图的 loadStats 回写
  const stats =
    examId && rawStats?.exam_id && rawStats.exam_id !== examId ? null : rawStats;

  // ★ 多窗口隔离：另一题目集的复习会话进行中，在此开始复习会替换并结束该会话，
  // 用内联提示告知（不阻断操作：已提交的评分已持久化，仅丢失其本地队列进度）。
  const otherExamSessionActive =
    !!examId &&
    session.isActive &&
    !!session.examId &&
    session.examId !== examId &&
    session.currentIndex < session.queue.length;

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

  useEffect(() => {
    return registerDomainListener('review://changed', () => {
      void Promise.all([
        loadDueReviews(examId),
        refreshStats(examId),
      ]);
    });
  }, [examId, loadDueReviews, refreshStats]);

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
  const today = useMemo(() => formatLocalDate(new Date()), []);

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

  // 预计用时（每题约 30 秒，向上取整到分钟，最低 1 分钟）
  const estimatedMinutes = useMemo(
    () => Math.max(1, Math.ceil(dueReviews.length * 0.5)),
    [dueReviews.length]
  );

  // 获取题目内容的映射
  const questionMap = useMemo(() => {
    const map = new Map<string, Question>();
    questions.forEach((q, id) => map.set(id, q));
    return map;
  }, [questions]);

  const createReviewItem = useCallback((plan: ReviewPlan): ReviewItemWithQuestion | null => {
    const question = questionMap.get(plan.question_id);
    if (!question) return null;
    // questionBankStore.Question 是 ReviewSessionQuestion 的结构超集，直接赋值即可
    return { plan, question };
  }, [questionMap]);

  // 开始复习
  const handleStartReview = useCallback(() => {
    const items = dueReviews.flatMap((plan) => {
      const item = createReviewItem(plan);
      return item ? [item] : [];
    });

    if (items.length === 0) {
      showGlobalNotification(
        'warning',
        t('review:queue.questionUnavailable'),
      );
      return;
    }

    if (onStartReview) {
      onStartReview(items);
    } else {
      startSession(items, examId);
    }
  }, [createReviewItem, dueReviews, examId, onStartReview, startSession, t]);

  // 暂停单个计划（暂停可随时恢复，直接执行 + 通知，无需确认）
  const handleSuspendPlan = useCallback(async (planId: string) => {
    try {
      await suspendPlan(planId);
      showGlobalNotification('success', t('review:toast.suspendSuccess'));
    } catch (err: unknown) {
      showGlobalNotification(
        'error',
        err instanceof Error && err.message ? err.message : String(err),
      );
    }
  }, [suspendPlan, t]);

  // 一键为本题目集创建复习计划（无计划时的内联引导入口）
  const [isCreatingPlans, setIsCreatingPlans] = useState(false);
  const handleCreatePlansForExam = useCallback(async () => {
    if (!examId || isCreatingPlans) return;
    setIsCreatingPlans(true);
    try {
      const result = await createPlansForExam(examId);
      showGlobalNotification(
        'success',
        t('review:toast.createSuccess', { count: result.created }),
      );
      await loadDueReviews(examId);
    } catch (err: unknown) {
      showGlobalNotification(
        'error',
        `${t('review:toast.createFailed')}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsCreatingPlans(false);
    }
  }, [examId, isCreatingPlans, createPlansForExam, loadDueReviews, t]);

  // 逾期天数（本地日界，用于队列行"逾期 N 天"标签）
  const overdueDaysOf = useCallback((plan: ReviewPlan): number => {
    if (plan.next_review_date >= today) return 0;
    const [y1, m1, d1] = plan.next_review_date.split('-').map(Number);
    const [y2, m2, d2] = today.split('-').map(Number);
    const due = new Date(y1, (m1 || 1) - 1, d1 || 1).getTime();
    const now = new Date(y2, (m2 || 1) - 1, d2 || 1).getTime();
    return Math.max(0, Math.round((now - due) / 86400000));
  }, [today]);

  const handleReviewItemClick = useCallback((plan: ReviewPlan) => {
    const item = createReviewItem(plan);
    if (!item) {
      showGlobalNotification(
        'warning',
        t('review:queue.questionUnavailable'),
      );
      return;
    }
    if (onReviewItemClick) {
      onReviewItemClick(item);
    } else {
      startSession([item], examId);
    }
  }, [createReviewItem, examId, onReviewItemClick, startSession, t]);

  // 加载状态：骨架模拟真实布局（统计卡 / 今日卡 / 队列行），避免整屏转圈闪切
  if (isLoading && !stats) {
    return (
      <div className={cn('space-y-5 p-4', className)} role="status" aria-busy>
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="h-3.5 w-44" />
          </div>
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-[86px] rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-32 rounded-lg" />
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <Skeleton key={i} className="h-[68px] rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const hasDue = dueReviews.length > 0;

  return (
    <div className={cn('space-y-5 p-4', className)}>
      {/* 头部标题和刷新按钮 */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">
            {t('review:title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('review:subtitle')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onViewCalendar}
            className="!h-auto !px-2.5 !py-1.5 [@media(pointer:coarse)]:!min-h-[44px] gap-1.5 text-xs text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
          >
            <Calendar size={14} />
            {t('review:calendar.title')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="icon"
            onClick={handleRefresh}
            disabled={isRefreshing}
            aria-label={t('common:refresh', 'Refresh')}
            className="h-8 w-8 [@media(pointer:coarse)]:!min-h-[44px] [@media(pointer:coarse)]:!min-w-[44px] text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
          >
            <ArrowClockwise
              className={cn('h-4 w-4', isRefreshing && 'animate-spin')}
            />
          </DsButton>
        </div>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <ReviewStatTile
          className="ui-rise-in"
          style={staggerStyle(0)}
          icon={<Clock size={16} />}
          label={t('review:stats.dueToday')}
          value={todayCount}
          description={
            overdueCount > 0
              ? t('review:stats.overdueHint', {
                  count: overdueCount,
                })
              : undefined
          }
          color={overdueCount > 0 ? 'text-destructive' : 'text-primary'}
        />
        <ReviewStatTile
          className="ui-rise-in"
          style={staggerStyle(1)}
          icon={<Flame size={16} />}
          label={t('review:stats.totalDue')}
          value={dueReviews.length}
          description={
            difficultCount > 0
              ? t('review:stats.difficultHint', {
                  count: difficultCount,
                })
              : undefined
          }
          color="text-warning"
        />
        <ReviewStatTile
          className="ui-rise-in"
          style={staggerStyle(2)}
          icon={<Award size={16} />}
          label={t('review:stats.mastered')}
          value={stats?.graduated_count || 0}
          description={`${progressPercent}% ${t('review:stats.ofTotal')}`}
          color="text-success"
        />
        <ReviewStatTile
          className="ui-rise-in"
          style={staggerStyle(3)}
          icon={<TrendingUp size={16} />}
          label={t('review:stats.accuracy')}
          value={`${Math.round((stats?.avg_correct_rate || 0) * 100)}%`}
          description={`${stats?.total_reviews || 0} ${t(
            'review:stats.totalReviews'
          )}`}
          color="text-primary"
        />
      </div>

      {/* 今日复习卡片 */}
      <div
        className={cn(
          'ui-rise-in relative overflow-hidden rounded-lg border p-4 sm:p-5',
          hasDue
            ? 'border-primary/20 bg-primary/5'
            : 'border-border/50 bg-muted/20'
        )}
      >
        {/* 装饰性光晕（纯 CSS） */}
        {hasDue && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-primary/10 blur-2xl"
          />
        )}

        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3.5">
            <div
              className={cn(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border',
                hasDue
                  ? 'border-primary/20 bg-primary/10'
                  : 'border-success/20 bg-success/10'
              )}
            >
              {hasDue ? (
                <Target size={20} className="text-primary" />
              ) : (
                <CheckCircle size={20} weight="fill" className="text-success" />
              )}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-foreground">
                {t('review:todayReview.title')}
              </h3>
              {hasDue ? (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  <span className="mr-1 align-middle text-2xl font-semibold tabular-nums text-primary">
                    {dueReviews.length}
                  </span>
                  {t('review:todayReview.itemsUnit')}
                  <span className="mx-1.5 text-border">·</span>
                  {t('review:todayReview.estimatedTime', { count: estimatedMinutes })}
                </p>
              ) : (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {t('review:todayReview.noDue')}
                </p>
              )}
            </div>
          </div>

          {hasDue && (
            <DsButton
              variant="primary"
              onClick={handleStartReview}
              className="min-h-10 gap-2 px-4 shadow-soft"
            >
              <Play size={16} weight="fill" />
              {t('review:startReview')}
              <CaretRight size={14} className="opacity-70" />
            </DsButton>
          )}
        </div>

        {/* ★ 多窗口隔离：另一题目集的会话进行中，开始复习会替换它（内联提示，无弹窗） */}
        {otherExamSessionActive && hasDue && (
          <div className="ui-rise-in relative mt-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2">
            <WarningCircle size={14} className="mt-0.5 shrink-0 text-warning" />
            <p className="text-xs text-warning">
              {t('review:queue.otherSessionNotice')}
            </p>
          </div>
        )}

        {/* 进度条 + SM-2 状态分布 */}
        {stats && stats.total_plans > 0 && (
          <div className="relative mt-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {t('review:progress.label')}
              </span>
              <span className="font-medium tabular-nums text-foreground">
                {stats.graduated_count}
                <span className="text-muted-foreground/70"> / {stats.total_plans}</span>
              </span>
            </div>
            <Progress value={progressPercent} className="h-1.5" />
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-0.5 text-[11px] text-muted-foreground">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  {t('review:status.new')}
                  <span className="tabular-nums text-foreground/80">{stats.new_count}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning" />
                  {t('review:status.learning')}
                  <span className="tabular-nums text-foreground/80">{stats.learning_count}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-success" />
                  {t('review:status.reviewing')}
                  <span className="tabular-nums text-foreground/80">{stats.reviewing_count}</span>
                </span>
              </div>
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />
                {t('review:status.graduated')}
                <span className="tabular-nums text-foreground/80">{stats.graduated_count}</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 复习队列 */}
      {hasDue && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between px-0.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t('review:queue.title')}
            </h3>
            <span className="text-[11px] text-muted-foreground/70">
              {t('review:queue.sortedByDue')}
            </span>
          </div>

          <CustomScrollArea
            className="max-h-[400px]"
            viewportClassName="space-y-2 pr-1"
            fullHeight={false}
          >
            {/* 视觉分组：逾期在前（列表本身按到期日排序，逾期天然靠前） */}
            {overdueCount > 0 && (
              <p className="flex items-center gap-1.5 px-1 pt-1 text-xs font-medium text-destructive">
                <WarningCircle size={13} />
                {t('review:queue.overdueGroup', { count: overdueCount })}
              </p>
            )}
            {dueReviews.slice(0, 20).map((plan, index) => {
              const isOverdue = plan.next_review_date < today;
              const prevPlan = index > 0 ? dueReviews[index - 1] : null;
              const isFirstDueToday =
                !isOverdue && (!prevPlan || prevPlan.next_review_date < today);
              return (
                <React.Fragment key={plan.id}>
                  {/* 分组标题：逾期段之后的今日到期段 */}
                  {isFirstDueToday && overdueCount > 0 && (
                    <p className="flex items-center gap-1.5 px-1 pt-2 text-xs font-medium text-muted-foreground">
                      <Clock size={13} />
                      {t('review:queue.todayGroup')}
                    </p>
                  )}
                  <ReviewQueueItem
                    plan={plan}
                    question={questionMap.get(plan.question_id)}
                    isOverdue={isOverdue}
                    overdueDays={overdueDaysOf(plan)}
                    onClick={() => handleReviewItemClick(plan)}
                    onSuspend={() => void handleSuspendPlan(plan.id)}
                    suspendDisabled={isProcessing}
                    index={index}
                  />
                </React.Fragment>
              );
            })}
            {dueReviews.length > 20 && (
              <div className="py-2 text-center">
                <span className="text-xs text-muted-foreground/70">
                  {t('review:queue.andMore', {
                    count: dueReviews.length - 20,
                  })}
                </span>
              </div>
            )}
          </CustomScrollArea>
        </div>
      )}

      {/* 空状态：无任何计划时显示内联创建引导（而非误导性的"全部完成"），
          否则显示今日无复习的完成态 */}
      {!hasDue && !isLoading && (
        examId && stats && stats.total_plans === 0 ? (
          <div className="ui-rise-in flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 bg-muted/10 p-8 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-primary/20 bg-primary/10">
              <ListPlus size={20} className="text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {t('review:setup.title')}
              </h3>
              <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                {t('review:setup.description')}
              </p>
            </div>
            <DsButton
              variant="primary"
              size="sm"
              onClick={() => void handleCreatePlansForExam()}
              disabled={isCreatingPlans}
              className="min-h-10 gap-2"
            >
              <ArrowClockwise
                size={14}
                className={cn(isCreatingPlans ? 'animate-spin' : 'hidden')}
              />
              {!isCreatingPlans && <Play size={14} weight="fill" />}
              {t('review:setup.createAll')}
            </DsButton>
          </div>
        ) : (
          <AllDoneState
            masteredCount={stats?.graduated_count || 0}
            onViewCalendar={onViewCalendar}
          />
        )
      )}

      {/* 间隔重复原理说明：帮助新用户理解"间隔/状态"从哪来 */}
      <div className="flex items-start gap-2 rounded-lg border border-info/15 bg-info/5 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        <Info size={14} className="mt-0.5 shrink-0 text-info" />
        <span>
          <span className="font-medium text-info">{t('review:tips.sm2Title')}</span>{' '}
          {t('review:tips.sm2Desc')}
        </span>
      </div>
    </div>
  );
};

export default ReviewPlanView;
