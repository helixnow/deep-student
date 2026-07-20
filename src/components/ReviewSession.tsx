/**
 * 复习会话组件
 *
 * 卡片式题目展示，支持：
 * - 显示/隐藏答案切换
 * - 评分按钮：Again(0)/Hard(2)/Good(3)/Easy(5)
 * - 复习进度指示器
 * - 复习完成统计（本次复习数、通过率）
 * - 键盘流：空格/回车翻面，1-4 评分，→ 跳过（高频操作免鼠标）
 *
 * 🆕 2026-01 新增
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/features/chat/components/renderers';
import { NotionButton } from '@/components/ui/NotionButton';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Card } from '@/components/ui/shad/Card';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  X,
  Eye,
  EyeSlash,
  ArrowCounterClockwise,
  CaretLeft,
  CaretRight,
  Clock,
  CheckCircle,
  XCircle,
  Trophy,
  SmileySad,
  Smiley,
  Smiley as SmileyIcon,
  Timer,
  Lightning,
  Target,
  TrendUp,
  ArrowRight,
  SkipForward,
  WarningCircle,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  useReviewPlanStore,
  type ReviewItemWithQuestion,
  type ReviewQuality,
} from '@/stores/reviewPlanStore';

// ============================================================================
// 类型定义
// ============================================================================

interface ReviewSessionProps {
  className?: string;
  onClose?: () => void;
  onComplete?: (stats: SessionStats) => void;
}

interface SessionStats {
  completed: number;
  correct: number;
  accuracy: number;
  totalTime: number;
}

interface RatingButtonProps {
  quality: ReviewQuality;
  label: string;
  sublabel: string;
  icon: React.ReactNode;
  color: string;
  onClick: () => void;
  disabled?: boolean;
  /** 键盘快捷键角标（如 "1"） */
  shortcutKey?: string;
}

// ============================================================================
// 评分按钮组件
// ============================================================================

const RatingButton: React.FC<RatingButtonProps> = ({
  quality,
  label,
  sublabel,
  icon,
  color,
  onClick,
  disabled,
  shortcutKey,
}) => (
  <NotionButton
    variant="ghost" size="sm"
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'relative !p-2 !h-auto min-h-11 !rounded-md flex-col !items-center !gap-1',
      'border',
      'disabled:opacity-50 disabled:cursor-not-allowed',
      color
    )}
  >
    {shortcutKey && (
      <kbd className="absolute top-1.5 right-1.5 hidden sm:inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded border border-current/30 text-[10px] font-mono leading-none opacity-50">
        {shortcutKey}
      </kbd>
    )}
    <div className="text-current">{icon}</div>
    <span className="text-sm font-semibold">{label}</span>
    <span className="text-[10px] opacity-70">{sublabel}</span>
  </NotionButton>
);

// ============================================================================
// 完成统计组件
// ============================================================================

interface CompletionStatsProps {
  stats: SessionStats;
  onClose: () => void;
  onRestart?: () => void;
}

const CompletionStats: React.FC<CompletionStatsProps> = ({
  stats,
  onClose,
  onRestart,
}) => {
  const { t } = useTranslation(['review']);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const performanceMessage = useMemo(() => {
    if (stats.accuracy >= 90) {
      return {
        icon: <CheckCircle size={28} className="text-success" />,
        title: t('review:complete.excellent'),
        message: t('review:complete.excellentMsg'),
      };
    }
    if (stats.accuracy >= 70) {
      return {
        icon: <Trophy size={28} className="text-success" />,
        title: t('review:complete.good'),
        message: t('review:complete.goodMsg'),
      };
    }
    if (stats.accuracy >= 50) {
      return {
        icon: <Target size={28} className="text-primary" />,
        title: t('review:complete.keepGoing'),
        message: t('review:complete.keepGoingMsg'),
      };
    }
    return {
      icon: <TrendUp size={28} className="text-warning" />,
        title: t('review:complete.needsPractice'),
        message: t('review:complete.needsPracticeMsg'),
    };
  }, [stats.accuracy, t]);

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center p-4 text-center">
      <div className="mb-3">{performanceMessage.icon}</div>

      {/* 标题 */}
      <h2 className="text-lg font-semibold text-foreground mb-1">
        {performanceMessage.title}
      </h2>
      <p className="text-sm text-muted-foreground mb-5">{performanceMessage.message}</p>

      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-2 w-full max-w-md mb-5">
        <Card className="p-3 text-center bg-success/10 border-success/20">
          <CheckCircle size={16} className="text-success mx-auto mb-1" />
          <p className="text-lg font-semibold text-success">
            {stats.correct}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('review:complete.correct')}
          </p>
        </Card>

        <Card className="p-3 text-center bg-primary/10 border-primary/20">
          <Target size={16} className="text-primary mx-auto mb-1" />
          <p className="text-lg font-semibold text-primary">
            {stats.accuracy}%
          </p>
          <p className="text-xs text-muted-foreground">
            {t('review:complete.accuracy')}
          </p>
        </Card>

        <Card className="p-3 text-center bg-muted/40 border-border/50">
          <Timer size={16} className="text-muted-foreground mx-auto mb-1" />
          <p className="text-lg font-semibold text-foreground">
            {formatTime(stats.totalTime)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('review:complete.time')}
          </p>
        </Card>
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-3">
        {onRestart && (
          <NotionButton variant="ghost" onClick={onRestart} className="gap-2">
            <ArrowCounterClockwise size={16} />
            {t('review:complete.reviewAgain')}
          </NotionButton>
        )}
        <NotionButton onClick={onClose} className="gap-2">
          {t('review:complete.finish')}
          <ArrowRight size={16} />
        </NotionButton>
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ReviewSession: React.FC<ReviewSessionProps> = ({
  className,
  onClose,
  onComplete,
}) => {
  const { t } = useTranslation(['review', 'common']);

  // Store
  const {
    session,
    isProcessing,
    submitReview,
    skipCurrentQuestion,
    getCurrentItem,
    getSessionProgress,
    getSessionStats,
    endSession,
  } = useReviewPlanStore();

  // 本地状态
  const [showAnswer, setShowAnswer] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  // 退出改行内二次确认（无模态框）：首次点击进入待确认态，超时自动回退
  const [exitArmed, setExitArmed] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 窄屏计时器默认折叠为图标，点按展开
  const [timerExpanded, setTimerExpanded] = useState(false);
  const ratingInFlightRef = useRef(false);

  useEffect(() => () => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
  }, []);

  // 当前题目
  const currentItem = getCurrentItem();
  const progress = getSessionProgress();
  const sessionStats = getSessionStats();

  // 计时器
  useEffect(() => {
    if (!session.isActive || !session.startTime) return;

    const interval = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - session.startTime!) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [session.isActive, session.startTime]);

  // 重置答案显示状态
  useEffect(() => {
    setShowAnswer(false);
  }, [session.currentIndex]);

  // 处理评分
  const handleRate = useCallback(
    async (quality: ReviewQuality) => {
      if (isProcessing || !currentItem || ratingInFlightRef.current) return;
      ratingInFlightRef.current = true;

      try {
        await submitReview(quality);

        // Read latest state after async update to avoid stale closure values
        const latestSession = useReviewPlanStore.getState().session;

        // 检查是否完成
        if (latestSession.currentIndex >= latestSession.queue.length) {
          const finalStats: SessionStats = {
            completed: latestSession.completedCount,
            correct: latestSession.correctCount,
            accuracy:
              latestSession.completedCount > 0
                ? Math.round(
                    (latestSession.correctCount / latestSession.completedCount) *
                      100
                  )
                : 0,
            totalTime: elapsedTime,
          };
          onComplete?.(finalStats);
        }
      } catch (err: unknown) {
        console.error('Failed to submit review:', err);
        showGlobalNotification(
          'error',
          err instanceof Error && err.message
            ? err.message
            : t('review:session.submitFailed'),
          t('review:session.submitFailedTitle'),
        );
      } finally {
        ratingInFlightRef.current = false;
      }
    },
    [isProcessing, currentItem, submitReview, elapsedTime, onComplete, t]
  );

  // 处理跳过
  const handleSkip = useCallback(() => {
    skipCurrentQuestion();
  }, [skipCurrentQuestion]);

  // 键盘流：空格/回车翻面，1-4 评分，→ 跳过
  useEffect(() => {
    if (!session.isActive || !currentItem) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 输入控件聚焦或带修饰键时不拦截
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (!showAnswer) {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          setShowAnswer(true);
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          handleSkip();
        }
        return;
      }

      // 答案已显示：1-4 评分（映射 Again/Hard/Good/Easy）
      const qualityByKey: Record<string, ReviewQuality> = { '1': 0, '2': 2, '3': 3, '4': 5 };
      if (e.key in qualityByKey) {
        e.preventDefault();
        void handleRate(qualityByKey[e.key]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session.isActive, currentItem, showAnswer, handleRate, handleSkip]);

  const finishSession = useCallback(() => {
    endSession();
    onClose?.();
  }, [endSession, onClose]);

  // 中途离开会丢弃剩余队列的本地进度；已提交的评分已持久化，
  // 用行内二次确认（点击一次进入待确认态，4s 后回退；再次点击真正退出）。
  const handleClose = useCallback(() => {
    const hasRemainingItems =
      session.isActive && session.currentIndex < session.queue.length;
    if (!hasRemainingItems) {
      finishSession();
      return;
    }
    if (!exitArmed) {
      setExitArmed(true);
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
      exitTimerRef.current = setTimeout(() => setExitArmed(false), 4000);
      return;
    }
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    setExitArmed(false);
    finishSession();
  }, [exitArmed, finishSession, session.currentIndex, session.isActive, session.queue.length]);

  // 格式化时间
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // 如果会话完成，显示统计
  if (
    session.isActive &&
    session.currentIndex >= session.queue.length &&
    session.queue.length > 0
  ) {
    return (
      <div className={cn('h-full min-h-0 bg-background', className)}>
        <CompletionStats
          stats={{
            completed: session.completedCount,
            correct: session.correctCount,
            accuracy: sessionStats.accuracy,
            totalTime: elapsedTime,
          }}
          onClose={finishSession}
/>
      </div>
    );
  }

  // 如果没有活动会话或没有题目
  if (!session.isActive || !currentItem) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center min-h-[60vh]',
          className
        )}
      >
        <p className="text-muted-foreground">
          {t('review:session.noItems')}
        </p>
        <NotionButton variant="ghost" onClick={handleClose} className="mt-4">
          {t('common:close')}
        </NotionButton>
      </div>
    );
  }

  const { plan, question } = currentItem;

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* 顶部导航栏（窄屏：进度条弹性宽度，计时可折叠） */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-border/50">
        {exitArmed ? (
          <NotionButton
            variant="warning"
            size="sm"
            onClick={handleClose}
            title={t('review:session.exitDescription')}
            className="min-h-11 shrink-0 gap-1.5 text-xs"
          >
            <WarningCircle size={14} />
            {t('review:session.exitConfirm')}
          </NotionButton>
        ) : (
          <NotionButton
            variant="ghost"
            iconOnly
            size="sm"
            onClick={handleClose}
            aria-label={t('review:session.exitTitle')}
            className="h-11 w-11 shrink-0 sm:h-auto sm:w-auto"
          >
            <X size={20} />
          </NotionButton>
        )}

        {/* 进度指示器 */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-3">
          <span className="shrink-0 text-sm font-medium tabular-nums">
            {progress.current} / {progress.total}
          </span>
          <div className="min-w-0 flex-1 max-w-[8rem]">
            <Progress
              value={(progress.current / progress.total) * 100}
              className="h-1.5"
/>
          </div>
        </div>

        {/* 计时器：<sm 折叠为图标，点按展开 */}
        <button
          type="button"
          onClick={() => setTimerExpanded((v) => !v)}
          aria-label={`${t('review:complete.time')}: ${formatTime(elapsedTime)}`}
          aria-expanded={timerExpanded}
          className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md text-sm text-muted-foreground tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pointer-events-none sm:min-h-0"
        >
          <Clock size={16} />
          <span className={cn(!timerExpanded && 'hidden', 'sm:inline')}>
            {formatTime(elapsedTime)}
          </span>
        </button>
      </div>

      {/* 状态栏 */}
      <div className="flex-shrink-0 flex items-center justify-center gap-3 px-4 py-2 bg-muted/30">
        <Badge
          variant="secondary"
          className={cn(
            'text-xs',
            plan.is_difficult
              ? 'bg-warning/10 text-warning'
              : 'bg-primary/10 text-primary'
          )}
        >
          {plan.is_difficult
            ? t('review:status.difficult')
            : t(`review:status.${plan.status}`, plan.status)}
        </Badge>
        <span className="text-xs text-muted-foreground">
            {t('review:interval')}: {plan.interval_days}
          {t('review:days')}
        </span>
        {plan.total_reviews > 0 && (
          <span className="text-xs text-muted-foreground">
            {t('review:totalReviews')}: {plan.total_reviews}
            {t('review:times')}
          </span>
        )}
      </div>

      {/* 卡片内容区 */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <Card className="max-w-2xl mx-auto p-4 shadow-sm">
          {/* 题目内容 */}
          <div className="mb-4">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">
              {t('review:card.question')}
            </h3>
            <div className="prose prose-sm dark:prose-invert max-w-none text-base leading-relaxed">
              <MarkdownRenderer
                content={question?.content || t('review:unknownQuestion')}
/>
            </div>
          </div>

          {/* 答案区域：grid-rows 技巧实现 0 → auto 高度的 200ms 展开动画 */}
          <div
            className={cn(
              'grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
              showAnswer
                ? 'grid-rows-[1fr] opacity-100 border-t border-border/50 pt-4'
                : 'grid-rows-[0fr] opacity-0'
            )}
          >
            <div className="min-h-0 overflow-hidden">
            {showAnswer && (
              <>
                {/* 答案 */}
                {question?.answer && (
                  <div className="mb-4">
                    <h3 className="text-xs font-medium text-success mb-2">
                      {t('review:card.answer')}
                    </h3>
                    <div className="p-3 rounded-md bg-success/5 border border-success/20 text-foreground">
                      <MarkdownRenderer
                        content={question.answer}
/>
                    </div>
                  </div>
                )}

                {/* 解析 */}
                {question?.explanation && (
                  <div>
                    <h3 className="text-xs font-medium text-primary mb-2">
                      {t('review:card.explanation')}
                    </h3>
                    <div className="p-3 rounded-md bg-primary/5 border border-primary/20 text-muted-foreground text-sm">
                      <MarkdownRenderer
                        content={question.explanation}
/>
                    </div>
                  </div>
                )}
              </>
            )}
            </div>
          </div>
        </Card>
      </div>

      {/* 底部操作区（移动端手势导航安全区） */}
      <div className="flex-shrink-0 border-t border-border/50 bg-muted/20 p-4 pb-[calc(1rem+var(--mobile-safe-area-bottom,0px))]">
        {!showAnswer ? (
          /* 显示答案按钮 */
          <div className="flex items-center justify-center gap-3">
            <NotionButton
              variant="outline"
              onClick={handleSkip}
              className="min-h-11 gap-2"
            >
              <SkipForward size={16} />
              {t('review:action.skip')}
            </NotionButton>
            <NotionButton
              size="sm"
              onClick={() => setShowAnswer(true)}
              className="min-h-11 gap-2 min-w-[160px]"
            >
              <Eye size={16} />
              {t('review:action.showAnswer')}
              <kbd className="hidden sm:inline-flex items-center justify-center h-4 px-1.5 rounded border border-current/30 text-[10px] font-mono leading-none opacity-60">
                {t('review:keyboard.space')}
              </kbd>
            </NotionButton>
          </div>
        ) : (
          /* 评分按钮 */
          <div className="max-w-lg mx-auto">
            <p className="text-xs text-center text-muted-foreground mb-3">
              {t('review:rating.prompt')}
              <span className="hidden sm:inline text-muted-foreground/60 ml-2">
                {t('review:keyboard.ratingHint')}
              </span>
            </p>
            <div className="grid grid-cols-4 gap-2">
              <RatingButton
                quality={0}
                label={t('review:rating.again')}
                sublabel={t('review:rating.againDesc')}
                icon={<SmileySad size={18} />}
                color="border-destructive/50 bg-destructive/5 text-destructive hover:bg-destructive/10 hover:border-destructive"
                onClick={() => handleRate(0)}
                disabled={isProcessing}
                shortcutKey="1"
/>
              <RatingButton
                quality={2}
                label={t('review:rating.hard')}
                sublabel={t('review:rating.hardDesc')}
                icon={<Smiley size={18} />}
                color="border-warning/50 bg-warning/5 text-warning hover:bg-warning/10 hover:border-warning"
                onClick={() => handleRate(2)}
                disabled={isProcessing}
                shortcutKey="2"
/>
              <RatingButton
                quality={3}
                label={t('review:rating.good')}
                sublabel={t('review:rating.goodDesc')}
                icon={<Smiley size={18} />}
                color="border-success/50 bg-success/5 text-success hover:bg-success/10 hover:border-success"
                onClick={() => handleRate(3)}
                disabled={isProcessing}
                shortcutKey="3"
/>
              <RatingButton
                quality={5}
                label={t('review:rating.easy')}
                sublabel={t('review:rating.easyDesc')}
                icon={<Lightning size={18} />}
                color="border-primary/50 bg-primary/5 text-primary hover:bg-primary/10 hover:border-primary"
                onClick={() => handleRate(5)}
                disabled={isProcessing}
                shortcutKey="4"
/>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ReviewSession;
