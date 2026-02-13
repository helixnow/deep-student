/**
 * 复习会话组件
 *
 * 卡片式题目展示，支持：
 * - 显示/隐藏答案切换
 * - 评分按钮：Again(0)/Hard(2)/Good(3)/Easy(5)
 * - 复习进度指示器
 * - 复习完成统计（本次复习数、通过率）
 *
 * 🆕 2026-01 新增
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/chat-v2/components/renderers';
import { NotionButton } from '@/components/ui/NotionButton';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Card } from '@/components/ui/shad/Card';
import {
  X,
  Eye,
  EyeOff,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Clock,
  CheckCircle,
  XCircle,
  Award,
  Frown,
  Meh,
  Smile,
  PartyPopper,
  Timer,
  Zap,
  Target,
  TrendingUp,
  ArrowRight,
  SkipForward,
} from 'lucide-react';
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
}) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={cn(
      'flex flex-col items-center gap-1.5 p-3 rounded-xl',
      'border-2 transition-all duration-200',
      'hover:scale-105 active:scale-95',
      'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100',
      color
    )}
  >
    <div className="text-current">{icon}</div>
    <span className="text-sm font-semibold">{label}</span>
    <span className="text-[10px] opacity-70">{sublabel}</span>
  </button>
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
        icon: <PartyPopper className="w-16 h-16 text-amber-500" />,
        title: t('review:complete.excellent'),
        message: t('review:complete.excellentMsg'),
      };
    }
    if (stats.accuracy >= 70) {
      return {
        icon: <Award className="w-16 h-16 text-emerald-500" />,
        title: t('review:complete.good'),
        message: t('review:complete.goodMsg'),
      };
    }
    if (stats.accuracy >= 50) {
      return {
        icon: <Target className="w-16 h-16 text-sky-500" />,
        title: t('review:complete.keepGoing'),
        message: t('review:complete.keepGoingMsg'),
      };
    }
    return {
      icon: <TrendingUp className="w-16 h-16 text-purple-500" />,
        title: t('review:complete.needsPractice'),
        message: t('review:complete.needsPracticeMsg'),
    };
  }, [stats.accuracy, t]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] p-6 text-center">
      {/* 动画图标 */}
      <div className="animate-bounce mb-6">{performanceMessage.icon}</div>

      {/* 标题 */}
      <h2 className="text-2xl font-bold text-foreground mb-2">
        {performanceMessage.title}
      </h2>
      <p className="text-muted-foreground mb-8">{performanceMessage.message}</p>

      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-4 w-full max-w-md mb-8">
        <Card className="p-4 text-center bg-emerald-500/10 border-emerald-500/20">
          <CheckCircle className="w-6 h-6 text-emerald-500 mx-auto mb-2" />
          <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">
            {stats.correct}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('review:complete.correct')}
          </p>
        </Card>

        <Card className="p-4 text-center bg-sky-500/10 border-sky-500/20">
          <Target className="w-6 h-6 text-sky-500 mx-auto mb-2" />
          <p className="text-2xl font-bold text-sky-600 dark:text-sky-400">
            {stats.accuracy}%
          </p>
          <p className="text-xs text-muted-foreground">
            {t('review:complete.accuracy')}
          </p>
        </Card>

        <Card className="p-4 text-center bg-purple-500/10 border-purple-500/20">
          <Timer className="w-6 h-6 text-purple-500 mx-auto mb-2" />
          <p className="text-2xl font-bold text-purple-600 dark:text-purple-400">
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
            <RotateCcw className="w-4 h-4" />
            {t('review:complete.reviewAgain')}
          </NotionButton>
        )}
        <NotionButton onClick={onClose} className="gap-2">
          {t('review:complete.finish')}
          <ArrowRight className="w-4 h-4" />
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
      if (isProcessing || !currentItem) return;

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
      }
    },
    [isProcessing, currentItem, submitReview, elapsedTime, onComplete]
  );

  // 处理跳过
  const handleSkip = useCallback(() => {
    skipCurrentQuestion();
  }, [skipCurrentQuestion]);

  // 处理关闭
  const handleClose = useCallback(() => {
    endSession();
    onClose?.();
  }, [endSession, onClose]);

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
      <div className={cn('min-h-screen bg-background', className)}>
        <CompletionStats
          stats={{
            completed: session.completedCount,
            correct: session.correctCount,
            accuracy: sessionStats.accuracy,
            totalTime: elapsedTime,
          }}
          onClose={handleClose}
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
      {/* 顶部导航栏 */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-border/50">
        <NotionButton variant="ghost" iconOnly size="sm" onClick={handleClose}>
          <X className="w-5 h-5" />
        </NotionButton>

        {/* 进度指示器 */}
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium">
            {progress.current} / {progress.total}
          </span>
          <div className="w-32">
            <Progress
              value={(progress.current / progress.total) * 100}
              className="h-1.5"
            />
          </div>
        </div>

        {/* 计时器 */}
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Clock className="w-4 h-4" />
          {formatTime(elapsedTime)}
        </div>
      </div>

      {/* 状态栏 */}
      <div className="flex-shrink-0 flex items-center justify-center gap-3 px-4 py-2 bg-muted/30">
        <Badge
          variant="secondary"
          className={cn(
            'text-xs',
            plan.is_difficult
              ? 'bg-amber-500/10 text-amber-600'
              : 'bg-sky-500/10 text-sky-600'
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
        <Card className="max-w-2xl mx-auto p-6 shadow-lg">
          {/* 题目内容 */}
          <div className="mb-6">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
              {t('review:card.question')}
            </h3>
            <div className="prose prose-sm dark:prose-invert max-w-none text-lg leading-relaxed">
              <MarkdownRenderer
                content={question?.content || t('review:unknownQuestion')}
              />
            </div>
          </div>

          {/* 答案区域 */}
          <div
            className={cn(
              'border-t border-border/50 pt-6 transition-all duration-300',
              showAnswer ? 'opacity-100' : 'opacity-0 h-0 overflow-hidden pt-0 border-t-0'
            )}
          >
            {showAnswer && (
              <>
                {/* 答案 */}
                {question?.answer && (
                  <div className="mb-4">
                    <h3 className="text-xs font-medium text-emerald-600 dark:text-emerald-400 uppercase tracking-wider mb-2">
                      {t('review:card.answer')}
                    </h3>
                    <div className="p-4 rounded-lg bg-emerald-500/5 border border-emerald-500/20 text-foreground">
                      <MarkdownRenderer
                        content={question.answer}
                      />
                    </div>
                  </div>
                )}

                {/* 解析 */}
                {question?.explanation && (
                  <div>
                    <h3 className="text-xs font-medium text-sky-600 dark:text-sky-400 uppercase tracking-wider mb-2">
                      {t('review:card.explanation')}
                    </h3>
                    <div className="p-4 rounded-lg bg-sky-500/5 border border-sky-500/20 text-muted-foreground text-sm">
                      <MarkdownRenderer
                        content={question.explanation}
                      />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </Card>
      </div>

      {/* 底部操作区 */}
      <div className="flex-shrink-0 border-t border-border/50 bg-muted/20 p-4">
        {!showAnswer ? (
          /* 显示答案按钮 */
          <div className="flex items-center justify-center gap-3">
            <NotionButton
              variant="outline"
              onClick={handleSkip}
              className="gap-2"
            >
              <SkipForward className="w-4 h-4" />
              {t('review:action.skip')}
            </NotionButton>
            <NotionButton
              size="lg"
              onClick={() => setShowAnswer(true)}
              className="gap-2 min-w-[200px]"
            >
              <Eye className="w-5 h-5" />
              {t('review:action.showAnswer')}
            </NotionButton>
          </div>
        ) : (
          /* 评分按钮 */
          <div className="max-w-lg mx-auto">
            <p className="text-xs text-center text-muted-foreground mb-3">
              {t('review:rating.prompt')}
            </p>
            <div className="grid grid-cols-4 gap-2">
              <RatingButton
                quality={0}
                label={t('review:rating.again')}
                sublabel={t('review:rating.againDesc')}
                icon={<Frown className="w-6 h-6" />}
                color="border-red-500/50 bg-red-500/5 text-red-600 hover:bg-red-500/10 hover:border-red-500"
                onClick={() => handleRate(0)}
                disabled={isProcessing}
              />
              <RatingButton
                quality={2}
                label={t('review:rating.hard')}
                sublabel={t('review:rating.hardDesc')}
                icon={<Meh className="w-6 h-6" />}
                color="border-amber-500/50 bg-amber-500/5 text-amber-600 hover:bg-amber-500/10 hover:border-amber-500"
                onClick={() => handleRate(2)}
                disabled={isProcessing}
              />
              <RatingButton
                quality={3}
                label={t('review:rating.good')}
                sublabel={t('review:rating.goodDesc')}
                icon={<Smile className="w-6 h-6" />}
                color="border-emerald-500/50 bg-emerald-500/5 text-emerald-600 hover:bg-emerald-500/10 hover:border-emerald-500"
                onClick={() => handleRate(3)}
                disabled={isProcessing}
              />
              <RatingButton
                quality={5}
                label={t('review:rating.easy')}
                sublabel={t('review:rating.easyDesc')}
                icon={<Zap className="w-6 h-6" />}
                color="border-sky-500/50 bg-sky-500/5 text-sky-600 hover:bg-sky-500/10 hover:border-sky-500"
                onClick={() => handleRate(5)}
                disabled={isProcessing}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ReviewSession;
