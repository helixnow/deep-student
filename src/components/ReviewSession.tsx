/**
 * 复习会话组件
 *
 * 卡片式题目展示，支持：
 * - 显示/隐藏答案切换（展开动画）
 * - 评分按钮：Again(0)/Hard(2)/Good(3)/Easy(5)，展示配色与预估间隔
 * - 复习进度指示器
 * - 复习完成统计（对勾描画动画 + 本次复习数、通过率）
 * - 键盘流：空格/回车翻面，1-4 评分，→ 跳过（高频操作免鼠标）
 *
 * 🆕 2026-01 新增；2026-07 复习体验改造
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/features/chat/components/renderers';
import { DsButton } from '@/components/ui/DsButton';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Card } from '@/components/ui/shad/Card';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import {
  X,
  Eye,
  ArrowCounterClockwise,
  Clock,
  CheckCircle,
  SmileySad,
  Smiley,
  Timer,
  Lightning,
  Target,
  ArrowRight,
  SkipForward,
  WarningCircle,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import {
  useReviewPlanStore,
  type ReviewPlan,
  type ReviewQuality,
  type ReviewSessionQuestion,
} from '@/stores/reviewPlanStore';
import { getReviewQuestionTypeMeta } from '@/components/review/reviewQuestionTypeMeta';
import {
  parseMatchingData,
  parseOrderingData,
  parseNumericData,
  formatNumericAnswer,
} from '@/components/question-types/structured';

// ============================================================================
// 类型定义
// ============================================================================

interface ReviewSessionProps {
  className?: string;
  /**
   * 本视图所属题目集。传入后组件只渲染/操作属于该题目集的会话；
   * 会话属于其他题目集时显示内联提示（多窗口隔离）。不传时行为同旧版（跟随全局会话）。
   */
  examId?: string;
  /**
   * 宿主窗口/标签页是否处于激活态。false 时不注册全局键盘监听，
   * 避免后台窗口的评分快捷键(1-4)与前台做题快捷键互扰。不传视为激活。
   */
  isActive?: boolean;
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
// SM-2 预估间隔（与后端 src-tauri/src/spaced_repetition.rs 保持同一公式）
// ============================================================================

const SM2_MIN_EF = 1.3;
const SM2_FIRST_INTERVAL = 1;
const SM2_SECOND_INTERVAL = 6;
const SM2_MAX_INTERVAL = 730;
const SM2_PASSING_GRADE = 3;

/** 预演某个评分后的下次间隔（天），用于评分按钮上的 Anki 式间隔标签 */
const previewNextInterval = (quality: ReviewQuality, plan: ReviewPlan): number => {
  const currentEf = Math.max(plan.ease_factor, SM2_MIN_EF);
  if (quality < SM2_PASSING_GRADE) {
    return SM2_FIRST_INTERVAL;
  }
  const q = Math.min(quality, 5);
  const delta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02);
  const newEf = Math.max(currentEf + delta, SM2_MIN_EF);
  const newReps = plan.repetitions + 1;
  if (newReps === 1) return SM2_FIRST_INTERVAL;
  if (newReps === 2) return SM2_SECOND_INTERVAL;
  const calculated = Math.round(plan.interval_days * newEf);
  return Math.min(Math.max(calculated, plan.interval_days + 1), SM2_MAX_INTERVAL);
};

// ============================================================================
// 结构化题型答案降级显示（matching/ordering/numeric）
//
// 复习会话是"回忆-对照"流，不做交互作答；对结构化新题型把 structured_data
// 渲染成可读的答案对照（配对列表 / 正确顺序 / 数值±容差），
// 数据缺失或解析失败时回退 Markdown answer 文本。
// 完整交互作答组件由答题界面（QuestionBankEditor 侧）提供，此处仅降级展示。
// ============================================================================

/** 读取 structured_data 原始值（兼容对象与 JSON 字符串两种形态） */
const readStructuredData = (question: ReviewSessionQuestion): unknown => {
  const raw = question.structured_data;
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return raw;
};

/**
 * 渲染结构化题型的答案对照；不适用（非结构化题型 / 数据非法）时返回 null，
 * 由调用方回退 Markdown answer。
 */
const renderStructuredAnswer = (
  question: ReviewSessionQuestion,
  t: (key: string) => string
): React.ReactNode => {
  const raw = readStructuredData(question);

  if (question.question_type === 'matching') {
    const data = parseMatchingData(raw);
    if (!data || data.pairs.length === 0) return null;
    const leftMap = new Map(data.left.map((item) => [item.key, item.content]));
    const rightMap = new Map(data.right.map((item) => [item.key, item.content]));
    return (
      <ul className="space-y-1.5">
        {data.pairs.map((pair) => (
          <li
            key={`${pair.left}-${pair.right}`}
            className="flex flex-wrap items-center gap-1.5 text-sm"
          >
            <span className="rounded bg-muted/60 px-1.5 py-0.5">
              {leftMap.get(pair.left) || pair.left}
            </span>
            <ArrowRight size={12} className="shrink-0 text-muted-foreground" />
            <span className="rounded bg-muted/60 px-1.5 py-0.5">
              {rightMap.get(pair.right) || pair.right}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  if (question.question_type === 'ordering') {
    const data = parseOrderingData(raw);
    if (!data || data.correct_order.length === 0) return null;
    const itemMap = new Map(data.items.map((item) => [item.key, item.content]));
    return (
      <ol className="space-y-1.5">
        {data.correct_order.map((key, index) => (
          <li key={key} className="flex items-center gap-2 text-sm">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-[11px] font-semibold tabular-nums text-success">
              {index + 1}
            </span>
            <span>{itemMap.get(key) || key}</span>
          </li>
        ))}
      </ol>
    );
  }

  if (question.question_type === 'numeric') {
    const data = parseNumericData(raw);
    if (!data) return null;
    return (
      <p className="text-sm font-medium tabular-nums">
        {formatNumericAnswer(data)}
      </p>
    );
  }

  if (question.question_type === 'true_false') {
    // 判断题无 structured_data 也可降级：answer 文本直接展示即可
    const normalized = (question.answer || '').trim().toLowerCase();
    if (normalized === 'true' || normalized === 't' || normalized === '对' || normalized === '正确') {
      return <p className="text-sm font-medium">{t('review:structured.trueLabel')}</p>;
    }
    if (normalized === 'false' || normalized === 'f' || normalized === '错' || normalized === '错误') {
      return <p className="text-sm font-medium">{t('review:structured.falseLabel')}</p>;
    }
    return null;
  }

  return null;
};

// ============================================================================
// 评分按钮组件
// ============================================================================


const RatingButton: React.FC<RatingButtonProps> = ({
  label,
  sublabel,
  icon,
  color,
  onClick,
  disabled,
  shortcutKey,
}) => (
  <DsButton
    variant="ghost" size="sm"
    onClick={onClick}
    disabled={disabled}
    aria-keyshortcuts={shortcutKey}
    className={cn(
      'relative !p-2 !h-auto min-h-11 !rounded-md flex-col !items-center !gap-1',
      // 触屏拇指可达：coarse 指针放大到 ≥56px 命中高度（桌面不受影响）
      '[@media(pointer:coarse)]:min-h-14',
      'border ui-press',
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
    <span className="text-[10px] font-medium tabular-nums opacity-70">{sublabel}</span>
  </DsButton>
);

// ============================================================================
// 完成统计组件（内联庆祝态：对勾描画动画 + 统计摘要）
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
        title: t('review:complete.excellent'),
        message: t('review:complete.excellentMsg'),
      };
    }
    if (stats.accuracy >= 70) {
      return {
        title: t('review:complete.good'),
        message: t('review:complete.goodMsg'),
      };
    }
    if (stats.accuracy >= 50) {
      return {
        title: t('review:complete.keepGoing'),
        message: t('review:complete.keepGoingMsg'),
      };
    }
    return {
      title: t('review:complete.needsPractice'),
      message: t('review:complete.needsPracticeMsg'),
    };
  }, [stats.accuracy, t]);

  return (
    <div className="ui-rise-in flex h-full min-h-0 flex-col items-center justify-center p-4 text-center">
      {/* 组件私有描画动画（无新增依赖 / 文件；reduced-motion 降级为直接终态） */}
      <style>{`
@keyframes rs-kf-draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
  .rs-draw { animation-duration: 0.01ms !important; animation-delay: 0ms !important; }
}
`}</style>

      {/* 对勾描画动画 */}
      <div className="relative mb-4 h-20 w-20" aria-hidden="true">
        <svg viewBox="0 0 64 64" className="h-full w-full">
          <circle
            cx="32" cy="32" r="26"
            fill="none"
            stroke="hsl(var(--success) / 0.15)"
            strokeWidth="4"
          />
          <circle
            cx="32" cy="32" r="26"
            fill="none"
            stroke="hsl(var(--success))"
            strokeWidth="4"
            strokeLinecap="round"
            strokeDasharray="163.4"
            strokeDashoffset="163.4"
            transform="rotate(-90 32 32)"
            className="rs-draw"
            style={{ animation: 'rs-kf-draw 600ms cubic-bezier(0.22, 1, 0.36, 1) 100ms forwards' }}
          />
          <path
            d="M21 33 L29 41 L44 24"
            fill="none"
            stroke="hsl(var(--success))"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="40"
            strokeDashoffset="40"
            className="rs-draw"
            style={{ animation: 'rs-kf-draw 350ms cubic-bezier(0.22, 1, 0.36, 1) 600ms forwards' }}
          />
        </svg>
      </div>

      {/* 标题 */}
      <h2 className="text-lg font-semibold text-foreground mb-1">
        {performanceMessage.title}
      </h2>
      <p className="text-sm text-muted-foreground mb-5">{performanceMessage.message}</p>

      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-2 w-full max-w-md mb-5">
        <Card className="p-3 text-center bg-success/10 border-success/20">
          <CheckCircle size={16} className="text-success mx-auto mb-1" />
          <p className="text-lg font-semibold tabular-nums text-success">
            {stats.correct}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('review:complete.correct')}
          </p>
        </Card>

        <Card className="p-3 text-center bg-primary/10 border-primary/20">
          <Target size={16} className="text-primary mx-auto mb-1" />
          <p className="text-lg font-semibold tabular-nums text-primary">
            {stats.accuracy}%
          </p>
          <p className="text-xs text-muted-foreground">
            {t('review:complete.accuracy')}
          </p>
        </Card>

        <Card className="p-3 text-center bg-muted/40 border-border/50">
          <Timer size={16} className="text-muted-foreground mx-auto mb-1" />
          <p className="text-lg font-semibold tabular-nums text-foreground">
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
          <DsButton variant="ghost" onClick={onRestart} className="gap-2">
            <ArrowCounterClockwise size={16} />
            {t('review:complete.reviewAgain')}
          </DsButton>
        )}
        <DsButton onClick={onClose} className="gap-2">
          {t('review:complete.finish')}
          <ArrowRight size={16} />
        </DsButton>
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ReviewSession: React.FC<ReviewSessionProps> = ({
  className,
  examId,
  isActive,
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
    startSession,
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

  // ★ 多窗口隔离：全局会话属于另一个题目集时，本窗口不渲染/不操作该会话
  const belongsToOtherExam =
    !!examId && session.isActive && !!session.examId && session.examId !== examId;

  // 当前题目
  const currentItem = getCurrentItem();
  const progress = getSessionProgress();
  const sessionStats = getSessionStats();

  const isSessionComplete =
    session.isActive &&
    session.queue.length > 0 &&
    session.currentIndex >= session.queue.length;

  // 计时器（完成后冻结，避免完成页统计数字持续跳动）
  useEffect(() => {
    if (!session.isActive || !session.startTime || belongsToOtherExam) return;
    // 新会话开始（startTime 变化）时立即校正显示，不等 1s tick
    setElapsedTime(Math.floor((Date.now() - session.startTime) / 1000));
    if (isSessionComplete) return;

    const interval = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - session.startTime!) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [session.isActive, session.startTime, isSessionComplete, belongsToOtherExam]);

  // 重置答案显示状态
  useEffect(() => {
    setShowAnswer(false);
  }, [session.currentIndex, session.startTime]);

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
  // ★ 多窗口隔离：会话属于其他题目集、或宿主窗口非激活时不注册全局键盘监听，避免按键互扰
  useEffect(() => {
    if (!session.isActive || !currentItem || belongsToOtherExam || isActive === false) return;

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

      // 答案已显示：1-4 评分（映射 Again/Hard/Good/Easy）；
      // 空格/回车 = 良好（Anki 同款高频路径：一路空格过卡）
      const qualityByKey: Record<string, ReviewQuality> = { '1': 0, '2': 2, '3': 3, '4': 5 };
      if (e.key in qualityByKey) {
        e.preventDefault();
        void handleRate(qualityByKey[e.key]);
      } else if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        void handleRate(3);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [session.isActive, currentItem, showAnswer, handleRate, handleSkip, belongsToOtherExam, isActive]);

  const finishSession = useCallback(() => {
    endSession();
    onClose?.();
  }, [endSession, onClose]);

  // 完成页「再复习一次」：用同一队列重开会话（评分已持久化，重开不丢数据）
  const handleRestart = useCallback(() => {
    if (session.queue.length === 0) return;
    startSession(session.queue, session.examId ?? undefined);
  }, [session.queue, session.examId, startSession]);

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

  // Anki 式预估间隔标签："1天 / 6天 / 2周 / 3个月"
  const formatIntervalLabel = useCallback(
    (days: number): string => {
      if (days < 7) return t('review:estimate.days', { count: days });
      if (days < 30) return t('review:estimate.weeks', { count: Math.max(1, Math.round(days / 7)) });
      if (days < 365) return t('review:estimate.months', { count: Math.max(1, Math.round(days / 30)) });
      return t('review:estimate.years', { count: Math.max(1, Math.round(days / 365)) });
    },
    [t]
  );

  // ★ 多窗口隔离：全局会话属于另一个题目集时显示内联提示，不接管该会话
  if (belongsToOtherExam) {
    return (
      <div
        className={cn(
          'flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center',
          className
        )}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-warning/10">
          <WarningCircle size={24} className="text-warning" />
        </div>
        <p className="text-sm font-medium text-foreground">
          {t('review:session.otherExamTitle')}
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {t('review:session.otherExamDescription')}
        </p>
        {onClose && (
          <DsButton variant="ghost" size="sm" onClick={onClose} className="mt-1">
            {t('common:close')}
          </DsButton>
        )}
      </div>
    );
  }

  // 如果会话完成，显示统计
  if (isSessionComplete) {
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
          onRestart={handleRestart}
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
        <DsButton variant="ghost" onClick={handleClose} className="mt-4">
          {t('common:close')}
        </DsButton>
      </div>
    );
  }

  const { plan, question } = currentItem;

  // 题型徽章（穷举映射，含 true_false/matching/ordering/numeric 新题型）
  const typeMeta = getReviewQuestionTypeMeta(question?.question_type);
  const TypeIcon = typeMeta.Icon;

  // 结构化题型的答案对照降级显示（不适用时为 null，回退 Markdown answer）
  const structuredAnswer = question ? renderStructuredAnswer(question, t) : null;

  // 四档评分的预估间隔（当前题的 plan 参数变化时重算）
  const intervalPreview: Record<'again' | 'hard' | 'good' | 'easy', string> = {
    again: formatIntervalLabel(previewNextInterval(0, plan)),
    hard: formatIntervalLabel(previewNextInterval(2, plan)),
    good: formatIntervalLabel(previewNextInterval(3, plan)),
    easy: formatIntervalLabel(previewNextInterval(5, plan)),
  };

  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* 顶部导航栏（窄屏：进度条弹性宽度，计时可折叠） */}
      <div className="flex-shrink-0 flex items-center justify-between gap-2 px-4 py-3 border-b border-border/50">
        {exitArmed ? (
          <DsButton
            variant="warning"
            size="sm"
            onClick={handleClose}
            title={t('review:session.exitDescription')}
            className="min-h-11 shrink-0 gap-1.5 text-xs"
          >
            <WarningCircle size={14} />
            {t('review:session.exitConfirm')}
          </DsButton>
        ) : (
          <DsButton
            variant="ghost"
            iconOnly
            size="sm"
            onClick={handleClose}
            aria-label={t('review:session.exitTitle')}
            className="h-11 w-11 shrink-0 sm:h-auto sm:w-auto"
          >
            <X size={20} />
          </DsButton>
        )}

        {/* 进度指示器 */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-3">
          <span className="shrink-0 text-sm font-medium tabular-nums">
            {progress.current} / {progress.total}
          </span>
          <div className="min-w-0 flex-1 max-w-[8rem]">
            <Progress
              value={(session.currentIndex / progress.total) * 100}
              className="h-1.5 [&>.bar]:duration-300 [&>.bar]:ease-standard"
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
      <div className="flex-shrink-0 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 bg-muted/30">
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
        {question && (
          <Badge
            variant="secondary"
            className="gap-1 bg-muted text-xs text-muted-foreground"
          >
            <TypeIcon size={12} />
            {t(typeMeta.labelKey)}
          </Badge>
        )}
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

      {/* 卡片内容区（切题时轻入场，key 驱动重挂载） */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <Card
          key={`${session.startTime ?? 0}-${session.currentIndex}`}
          className="ui-rise-in max-w-2xl mx-auto p-4 shadow-sm"
        >
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

          {/* 答案区域：grid-rows 技巧实现 0 → auto 高度的展开动画 */}
          <div
            className={cn(
              'grid transition-[grid-template-rows,opacity] duration-200 ease-standard motion-reduce:transition-none',
              showAnswer
                ? 'grid-rows-[1fr] opacity-100 border-t border-border/50 pt-4'
                : 'grid-rows-[0fr] opacity-0'
            )}
          >
            <div className="min-h-0 overflow-hidden">
            {showAnswer && (
              <div className="ui-rise-in">
                {/* 答案（结构化题型优先渲染答案对照，否则回退 Markdown 文本） */}
                {(structuredAnswer || question?.answer) && (
                  <div className="mb-4">
                    <h3 className="text-xs font-medium text-success mb-2">
                      {t('review:card.answer')}
                    </h3>
                    <div className="p-3 rounded-md bg-success/5 border border-success/20 text-foreground">
                      {structuredAnswer ?? (
                        <MarkdownRenderer content={question?.answer || ''} />
                      )}
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
              </div>
            )}
            </div>
          </div>
        </Card>
      </div>

      {/* 底部操作区（移动端手势导航安全区） */}
      <div className="flex-shrink-0 border-t border-border/50 bg-muted/20 p-4 pb-[calc(1rem+var(--mobile-safe-area-bottom,0px))]">
        {!showAnswer ? (
          /* 显示答案按钮（窄屏主按钮弹性铺满，拇指可达） */
          <div className="mx-auto flex max-w-lg items-center justify-center gap-3">
            <DsButton
              variant="outline"
              onClick={handleSkip}
              className="min-h-11 shrink-0 gap-2 [@media(pointer:coarse)]:min-h-12"
            >
              <SkipForward size={16} />
              {t('review:action.skip')}
            </DsButton>
            <DsButton
              variant="primary"
              size="sm"
              onClick={() => setShowAnswer(true)}
              className="min-h-11 flex-1 gap-2 min-w-[160px] sm:flex-initial [@media(pointer:coarse)]:min-h-12"
            >
              <Eye size={16} />
              {t('review:action.showAnswer')}
              <kbd className="hidden sm:inline-flex items-center justify-center h-4 px-1.5 rounded border border-current/30 text-[10px] font-mono leading-none opacity-60">
                {t('review:keyboard.space')}
              </kbd>
            </DsButton>
          </div>
        ) : (
          /* 评分按钮：Anki 配色（红/橙/绿/蓝）+ 预估间隔标签 */
          <div className="max-w-lg mx-auto">
            <p
              className="text-xs text-center text-muted-foreground mb-3"
              title={`${t('review:tips.ratingTitle')} ${t('review:tips.ratingDesc')}`}
            >
              {t('review:rating.prompt')}
              <span className="hidden sm:inline text-muted-foreground/60 ml-2">
                {t('review:keyboard.ratingHint')} · {t('review:keyboard.spaceGood')}
              </span>
            </p>
            {/* 评分指南：首题翻面后展示一次完整说明，之后收进上方 title */}
            {session.completedCount === 0 && (
              <p className="text-[11px] text-center text-muted-foreground/70 mb-3 max-w-md mx-auto">
                {t('review:tips.ratingDesc')}
              </p>
            )}
            <div className="grid grid-cols-4 gap-2">
              <RatingButton
                quality={0}
                label={t('review:rating.again')}
                sublabel={intervalPreview.again}
                icon={<SmileySad size={18} />}
                color="border-destructive/50 bg-destructive/5 text-destructive hover:bg-destructive/10 hover:border-destructive"
                onClick={() => handleRate(0)}
                disabled={isProcessing}
                shortcutKey="1"
              />
              <RatingButton
                quality={2}
                label={t('review:rating.hard')}
                sublabel={intervalPreview.hard}
                icon={<Smiley size={18} />}
                color="border-warning/50 bg-warning/5 text-warning hover:bg-warning/10 hover:border-warning"
                onClick={() => handleRate(2)}
                disabled={isProcessing}
                shortcutKey="2"
              />
              <RatingButton
                quality={3}
                label={t('review:rating.good')}
                sublabel={intervalPreview.good}
                icon={<CheckCircle size={18} />}
                color="border-success/50 bg-success/5 text-success hover:bg-success/10 hover:border-success"
                onClick={() => handleRate(3)}
                disabled={isProcessing}
                shortcutKey="3"
              />
              <RatingButton
                quality={5}
                label={t('review:rating.easy')}
                sublabel={intervalPreview.easy}
                icon={<Lightning size={18} />}
                color="border-info/50 bg-info/5 text-info hover:bg-info/10 hover:border-info"
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
