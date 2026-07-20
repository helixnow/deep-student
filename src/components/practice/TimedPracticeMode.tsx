/**
 * 限时练习模式组件
 * 
 * 功能：
 * - 倒计时进度环（剩余比例变色，最后 60 秒变色脉动）
 * - 时间到自动结算
 * - 暂停/继续（累计暂停时长写回会话，跨视图恢复不丢）
 * - 交卷内联确认（项目惯例：不用模态弹窗）
 * - 答题卡宫格内联抽出（已答/未答/收藏标记，点击跳题）
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import {
  Play,
  Pause,
  StopCircle,
  WarningCircle,
  CheckCircle,
  Timer,
  Target,
  CircleNotch,
  SquaresFour,
  CaretUp,
} from '@phosphor-icons/react';
import { useQuestionBankStore, TimedPracticeSession } from '@/stores/questionBankStore';
import { useTranslation } from 'react-i18next';
import { useCountdown } from '@/hooks/useCountdown';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CountdownRing } from './CountdownRing';
import { AnswerSheetGrid } from './AnswerSheetGrid';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

interface TimedPracticeModeProps {
  examId: string;
  onStart?: (session: TimedPracticeSession) => void;
  onTimeout?: () => void;
  onSubmit?: () => void;
  /** 本地会话的当前题 ID（宿主传入时答题卡高亮以其为准，未传回退全局 store） */
  currentQuestionId?: string | null;
  /** 收藏标记题目 ID 集（宿主传入时优先；未传回退全局 store.questions，该 map 在此流程通常未加载） */
  markedQuestionIds?: ReadonlySet<string>;
  className?: string;
}

// 格式化时间显示
const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

const DURATION_PRESETS = [15, 30, 60, 90];

export const TimedPracticeMode: React.FC<TimedPracticeModeProps> = ({
  examId,
  onStart,
  onTimeout,
  onSubmit,
  currentQuestionId,
  markedQuestionIds,
  className,
}) => {
  const { t } = useTranslation('practice');
  
  // Store
  const {
    timedSession,
    setTimedSession,
    startTimedPractice,
    isLoadingPractice,
  } = useQuestionBankStore();
  const questions = useQuestionBankStore((state) => state.questions);
  const activeSession = useMemo(
    () => (timedSession?.exam_id === examId ? timedSession : null),
    [timedSession, examId],
  );
  
  // 配置状态
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [questionCount, setQuestionCount] = useState(20);

  const normalizeDurationMinutes = useCallback((value: number): number => {
    if (!Number.isFinite(value)) return 30;
    return Math.max(5, Math.min(180, Math.round(value)));
  }, []);

  const normalizeQuestionCount = useCallback((value: number): number => {
    if (!Number.isFinite(value)) return 20;
    return Math.max(5, Math.min(100, Math.round(value)));
  }, []);
  
  // UI 状态（交卷确认为内联面板；答题卡内联抽出）
  const [showSubmitConfirm, setShowSubmitConfirm] = useState(false);
  const [showAnswerSheet, setShowAnswerSheet] = useState(false);

  useEffect(() => {
    if (!showAnswerSheet) return;
    return registerBackHandler(() => {
      setShowAnswerSheet(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [showAnswerSheet]);

  useEffect(() => {
    if (!showSubmitConfirm) return;
    return registerBackHandler(() => {
      setShowSubmitConfirm(false);
      return true;
    }, BACK_PRIORITY.overlay + 1);
  }, [showSubmitConfirm]);
  
  // 计时器状态 — 基于绝对时间戳的高精度倒计时
  const [targetEndTime, setTargetEndTime] = useState<number | null>(null);
  const isStarted = targetEndTime != null;
  // 暂停起点（用于把暂停时长累计写回会话，跨视图/重挂载不丢暂停补偿）
  const pauseStartedAtRef = useRef<number | null>(null);
  const timeoutHandledRef = useRef(false);
  
  // 时间到：结算会话（写回 store，避免下次进入被当作"进行中"恢复）后再通知上层
  const handleTimeout = useCallback(() => {
    if (timeoutHandledRef.current) return;
    timeoutHandledRef.current = true;
    setShowSubmitConfirm(false);
    const session = useQuestionBankStore.getState().timedSession;
    if (session && session.exam_id === examId && !session.is_submitted && !session.is_timeout) {
      setTimedSession({
        ...session,
        ended_at: new Date().toISOString(),
        is_timeout: true,
        is_submitted: true,
      });
    }
    setTargetEndTime(null);
    onTimeout?.();
  }, [examId, onTimeout, setTimedSession]);
  
  const { remaining: remainingSeconds, isPaused, pause, resume, reset: resetCountdown } = useCountdown(
    targetEndTime,
    handleTimeout,
  );
  
  // 计算进度
  const progress = activeSession
    ? (activeSession.answered_count / activeSession.question_count) * 100
    : 0;

  // 答题卡状态：已答来自会话内首答记录，标记复用题目收藏
  const answeredIds = useMemo(
    () => new Set(activeSession?.answered_question_ids ?? []),
    [activeSession],
  );
  // 收藏标记优先取宿主传入的集合；全局 store.questions 在此流程通常未加载，仅作兜底
  const markedIds = useMemo(() => {
    if (markedQuestionIds) return markedQuestionIds;
    const marked = new Set<string>();
    activeSession?.question_ids.forEach((id) => {
      if (questions.get(id)?.is_favorite) marked.add(id);
    });
    return marked;
  }, [markedQuestionIds, activeSession, questions]);
  
  // 开始练习
  const handleStart = useCallback(async () => {
    try {
      const session = await startTimedPractice(examId, durationMinutes, questionCount);
      // 优先以后端 started_at 为基准，避免请求耗时挤占答题时间
      const startedMs = Date.parse(session.started_at);
      const baseMs = Number.isFinite(startedMs) ? startedMs : Date.now();
      timeoutHandledRef.current = false;
      pauseStartedAtRef.current = null;
      setShowSubmitConfirm(false);
      setTargetEndTime(baseMs + session.duration_minutes * 60 * 1000);
      onStart?.(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification('error', msg, t('timed.startError'));
    }
  }, [examId, durationMinutes, questionCount, startTimedPractice, onStart, t]);

  useEffect(() => {
    if (!activeSession || activeSession.is_submitted || activeSession.is_timeout) {
      setTargetEndTime(null);
      return;
    }
    const startedMs = Date.parse(activeSession.started_at);
    if (!Number.isFinite(startedMs)) return;
    const durationMs = activeSession.duration_minutes * 60 * 1000;
    if (durationMs <= 0) return;
    // 恢复会话时补偿已累计的暂停时长
    const pausedMs = Math.max(0, activeSession.paused_seconds) * 1000;
    setTargetEndTime((prev) => prev ?? startedMs + durationMs + pausedMs);
  }, [activeSession]);
  
  // 暂停/继续：暂停时长累计写回会话，恢复计算时能补偿
  const togglePause = useCallback(() => {
    if (isPaused) {
      resume();
      const pausedAt = pauseStartedAtRef.current;
      pauseStartedAtRef.current = null;
      if (activeSession && pausedAt != null) {
        const deltaSeconds = Math.max(0, Math.round((Date.now() - pausedAt) / 1000));
        if (deltaSeconds > 0) {
          setTimedSession({
            ...activeSession,
            paused_seconds: activeSession.paused_seconds + deltaSeconds,
          });
        }
      }
    } else {
      pause();
      pauseStartedAtRef.current = Date.now();
    }
  }, [isPaused, pause, resume, activeSession, setTimedSession]);
  
  // 交卷（内联确认后执行）：结算会话写回 store。
  // 2026-07 修复：此前只清了本地计时器，store 里的会话仍是"进行中"，
  // 下次进入启动页会被自动恢复并继续倒计时。
  const handleSubmit = useCallback(() => {
    setShowSubmitConfirm(false);
    if (activeSession && !activeSession.is_submitted) {
      setTimedSession({
        ...activeSession,
        ended_at: new Date().toISOString(),
        is_submitted: true,
      });
    }
    setTargetEndTime(null);
    resetCountdown();
    onSubmit?.();
  }, [activeSession, onSubmit, resetCountdown, setTimedSession]);
  
  // 未答数（交卷确认提示用）
  const unansweredCount = activeSession
    ? Math.max(0, activeSession.question_count - activeSession.answered_count)
    : 0;

  // 最后 60 秒：变色 + 脉动（暂停时不脉动）
  const isFinalCountdown = isStarted && !isPaused && remainingSeconds > 0 && remainingSeconds <= 60;
  
  // 配置界面
  if (!isStarted) {
    return (
      <Card className={cn('bg-transparent border-transparent shadow-none', className)}>
        <CardHeader className="px-0 pb-4 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base">
            <Timer size={18} className="text-primary" />
            {t('timed.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6 px-0 sm:px-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="duration">{t('timed.duration')}</Label>
              <Input
                id="duration"
                type="number"
                min={5}
                max={180}
                value={durationMinutes}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') return;
                  setDurationMinutes(normalizeDurationMinutes(Number(raw)));
                }}
                onBlur={(e) => setDurationMinutes(normalizeDurationMinutes(Number(e.target.value)))}
                className="text-center font-medium"
/>
              <div className="flex flex-wrap gap-1.5">
                {DURATION_PRESETS.map((preset) => (
                  <DsButton
                    key={preset}
                    variant={durationMinutes === preset ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setDurationMinutes(preset)}
                  >
                    {t('timed.minutesShort', { count: preset })}
                  </DsButton>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="count">{t('timed.questionCount')}</Label>
              <Input
                id="count"
                type="number"
                min={5}
                max={100}
                value={questionCount}
                onChange={(e) => {
                  const raw = e.target.value;
                  if (raw === '') return;
                  setQuestionCount(normalizeQuestionCount(Number(raw)));
                }}
                onBlur={(e) => setQuestionCount(normalizeQuestionCount(Number(e.target.value)))}
                className="text-center font-medium"
/>
            </div>
          </div>
          
          <div className="flex items-center justify-center gap-4 rounded-md bg-muted/30 p-3">
            <div className="text-center">
              <div className="text-sm text-muted-foreground">{t('timed.estimated')}</div>
              <div className="text-xl font-semibold text-primary">{formatTime(durationMinutes * 60)}</div>
            </div>
            <div className="w-px h-10 bg-border" />
            <div className="text-center">
              <div className="text-sm text-muted-foreground">{t('timed.perQuestion')}</div>
              <div className="text-xl font-semibold text-warning">
                {Math.floor((durationMinutes * 60) / questionCount)}s
              </div>
            </div>
          </div>
          
          <DsButton
            onClick={handleStart}
            disabled={isLoadingPractice}
            className="w-full"
          >
            {isLoadingPractice ? (
              <>
                <CircleNotch size={16} className="mr-2 animate-spin" />
                {t('timed.loading')}
              </>
            ) : (
              <>
                <Play size={16} className="mr-2" />
                {t('timed.start')}
              </>
            )}
          </DsButton>
        </CardContent>
      </Card>
    );
  }
  
  // 练习中界面
  return (
    <Card className={cn('border-border/50 shadow-none', className)}>
      <CardContent className="space-y-4 px-3 pt-4 sm:px-6">
        {/* 倒计时进度环 */}
        <div className="flex flex-col items-center justify-center py-2">
          <CountdownRing
            remainingSeconds={remainingSeconds}
            totalSeconds={(activeSession?.duration_minutes ?? durationMinutes) * 60}
            timeText={formatTime(remainingSeconds)}
            isPaused={isPaused}
            subtitle={
              isPaused ? (
                <Badge variant="secondary" className="gap-1">
                  <Pause size={12} />
                  {t('timed.paused')}
                </Badge>
              ) : (
                t('timed.remaining')
              )
            }
/>
        </div>
        
        {/* 进度条 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('timed.progress')}</span>
            <span className="font-medium tabular-nums">
              {activeSession?.answered_count || 0} / {activeSession?.question_count || questionCount}
            </span>
          </div>
          <Progress value={progress} className="h-2" />
        </div>
        
        {/* 统计信息 */}
        {activeSession && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-2 rounded-md bg-success/10 p-2.5">
              <CheckCircle size={16} className="text-success" />
              <div>
                <div className="text-sm text-muted-foreground">{t('timed.correct')}</div>
                <div className="text-lg font-semibold text-success">{activeSession.correct_count}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-md bg-primary/10 p-2.5">
              <Target size={16} className="text-primary" />
              <div>
                <div className="text-sm text-muted-foreground">{t('timed.rate')}</div>
                <div className="text-lg font-semibold text-primary">
                  {activeSession.answered_count > 0
                    ? Math.round((activeSession.correct_count / activeSession.answered_count) * 100)
                    : 0}%
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* 答题卡内联抽出 */}
        {activeSession && (
          <div className="space-y-2">
            <DsButton
              variant="outline"
              size="sm"
              onClick={() => setShowAnswerSheet((prev) => !prev)}
              aria-expanded={showAnswerSheet}
              className="w-full"
            >
              {showAnswerSheet ? (
                <CaretUp size={14} className="mr-1.5" />
              ) : (
                <SquaresFour size={14} className="mr-1.5" />
              )}
              {showAnswerSheet ? t('answerSheet.collapse') : t('answerSheet.expand')}
            </DsButton>
            {showAnswerSheet && (
              <AnswerSheetGrid
                questionIds={activeSession.question_ids}
                examId={examId}
                answeredIds={answeredIds}
                markedIds={markedIds}
                currentQuestionId={currentQuestionId}
/>
            )}
          </div>
        )}
        
        {/* 控制按钮 */}
        <div className="flex flex-col gap-2 min-[360px]:flex-row min-[360px]:gap-3">
          <DsButton
            variant="outline"
            onClick={togglePause}
            className="flex-1"
          >
            {isPaused ? (
              <>
                <Play size={16} className="mr-2" />
                {t('timed.resume')}
              </>
            ) : (
              <>
                <Pause size={16} className="mr-2" />
                {t('timed.pause')}
              </>
            )}
          </DsButton>
          <DsButton
            variant="default"
            onClick={() => setShowSubmitConfirm(true)}
            disabled={showSubmitConfirm}
            className="flex-1"
          >
            <StopCircle size={16} className="mr-2" />
            {t('timed.submit')}
          </DsButton>
        </div>

        {/* 交卷内联确认（替代模态弹窗） */}
        {showSubmitConfirm && (
          <div className="ui-rise-in space-y-2.5 rounded-md border border-warning/30 bg-warning/[0.08] p-3">
            <div className="flex items-start gap-2">
              <WarningCircle size={16} className="mt-0.5 flex-shrink-0 text-warning" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{t('timed.confirmTitle')}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {unansweredCount > 0
                    ? t('timed.confirmWarning', { count: unansweredCount })
                    : t('timed.confirmMessage')}
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <DsButton
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => setShowSubmitConfirm(false)}
              >
                {t('timed.cancel')}
              </DsButton>
              <DsButton
                variant="default"
                size="sm"
                className="flex-1"
                onClick={handleSubmit}
              >
                <CheckCircle size={14} className="mr-1" />
                {t('timed.confirmSubmit')}
              </DsButton>
            </div>
          </div>
        )}
        
        {/* 警告提示 */}
        {isFinalCountdown && (
          <div className="ui-rise-in flex items-center gap-2 rounded-md bg-destructive/10 p-2.5 text-destructive">
            <WarningCircle size={16} className="animate-pulse" />
            <span className="text-sm font-medium">{t('timed.warning')}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default TimedPracticeMode;
