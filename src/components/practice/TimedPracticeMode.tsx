/**
 * 限时练习模式组件
 * 
 * 功能：
 * - 倒计时显示（分:秒）
 * - 时间到自动提交
 * - 暂停/继续功能
 * - 进度追踪
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { Progress } from '@/components/ui/shad/Progress';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import {
  Clock,
  Play,
  Pause,
  StopCircle,
  WarningCircle,
  CheckCircle,
  Timer,
  Target,
  CircleNotch,
} from '@phosphor-icons/react';
import { useQuestionBankStore, TimedPracticeSession } from '@/stores/questionBankStore';
import { useTranslation } from 'react-i18next';
import { useCountdown } from '@/hooks/useCountdown';
import { showGlobalNotification } from '@/components/UnifiedNotification';

interface TimedPracticeModeProps {
  examId: string;
  onStart?: (session: TimedPracticeSession) => void;
  onTimeout?: () => void;
  onSubmit?: () => void;
  className?: string;
}

// 格式化时间显示
const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

export const TimedPracticeMode: React.FC<TimedPracticeModeProps> = ({
  examId,
  onStart,
  onTimeout,
  onSubmit,
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
  
  // 计时器状态 — 基于绝对时间戳的高精度倒计时
  const [targetEndTime, setTargetEndTime] = useState<number | null>(null);
  const isStarted = targetEndTime != null;
  
  const { remaining: remainingSeconds, isPaused, pause, resume, reset: resetCountdown } = useCountdown(
    targetEndTime,
    onTimeout,
  );
  
  // 计算进度
  const progress = activeSession
    ? (activeSession.answered_count / activeSession.question_count) * 100
    : 0;
  
  // 开始练习
  const handleStart = useCallback(async () => {
    try {
      const session = await startTimedPractice(examId, durationMinutes, questionCount);
      setTargetEndTime(Date.now() + durationMinutes * 60 * 1000);
      onStart?.(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification('error', msg, t('timed.startError'));
    }
  }, [examId, durationMinutes, questionCount, startTimedPractice, onStart]);

  useEffect(() => {
    if (!activeSession || activeSession.is_submitted || activeSession.is_timeout) {
      setTargetEndTime(null);
      return;
    }
    const startedMs = Date.parse(activeSession.started_at);
    if (!Number.isFinite(startedMs)) return;
    const durationMs = activeSession.duration_minutes * 60 * 1000;
    if (durationMs <= 0) return;
    setTargetEndTime((prev) => prev ?? startedMs + durationMs);
  }, [activeSession]);
  
  // 暂停/继续
  const togglePause = useCallback(() => {
    if (isPaused) {
      resume();
    } else {
      pause();
    }
  }, [isPaused, pause, resume]);
  
  // 提交
  const handleSubmit = useCallback(() => {
    setTargetEndTime(null);
    resetCountdown();
    onSubmit?.();
  }, [onSubmit, resetCountdown]);
  
  // 重置
  const handleReset = useCallback(() => {
    setTargetEndTime(null);
    resetCountdown();
    setTimedSession(null);
  }, [setTimedSession, resetCountdown]);
  
  // 计算时间状态颜色
  const getTimeColor = () => {
    // 用会话自身的时长（恢复的会话可能与当前配置输入不同）
    const totalSeconds = (activeSession?.duration_minutes ?? durationMinutes) * 60;
    if (totalSeconds <= 0) return 'text-destructive';
    const ratio = remainingSeconds / totalSeconds;
    
    if (ratio > 0.5) return 'text-success';
    if (ratio > 0.25) return 'text-warning';
    return 'text-destructive';
  };
  
  // 配置界面
  if (!isStarted) {
    return (
      <Card className={cn('bg-transparent border-transparent shadow-none', className)}>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Timer size={18} className="text-primary" />
            {t('timed.title')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
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
          
          <NotionButton
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
          </NotionButton>
        </CardContent>
      </Card>
    );
  }
  
  // 练习中界面
  return (
    <Card className={cn('border-border/50 shadow-none', className)}>
      <CardContent className="space-y-4 pt-4">
        {/* 倒计时显示 */}
        <div className="flex flex-col items-center justify-center py-3">
          <div className={cn(
            'text-3xl font-mono font-semibold tabular-nums transition-colors',
            getTimeColor()
          )}>
            {formatTime(remainingSeconds)}
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {isPaused ? (
              <Badge variant="secondary" className="gap-1">
                <Pause size={12} />
                {t('timed.paused')}
              </Badge>
            ) : (
              <span className="flex items-center gap-1">
                <Clock size={16} />
                {t('timed.remaining')}
              </span>
            )}
          </div>
        </div>
        
        {/* 进度条 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('timed.progress')}</span>
            <span className="font-medium">
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
        
        {/* 控制按钮 */}
        <div className="flex gap-3">
          <NotionButton
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
          </NotionButton>
          <NotionButton
            variant="default"
            onClick={handleSubmit}
            className="flex-1"
          >
            <StopCircle size={16} className="mr-2" />
            {t('timed.submit')}
          </NotionButton>
        </div>
        
        {/* 警告提示 */}
        {remainingSeconds < 60 && remainingSeconds > 0 && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-2.5 text-destructive">
            <WarningCircle size={16} />
            <span className="text-sm font-medium">{t('timed.warning')}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default TimedPracticeMode;
