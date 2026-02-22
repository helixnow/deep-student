/**
 * 限时练习模式组件
 * 
 * 功能：
 * - 倒计时显示（分:秒）
 * - 时间到自动提交
 * - 暂停/继续功能
 * - 进度追踪
 */

import React, { useState, useCallback } from 'react';
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
  AlertCircle,
  CheckCircle,
  Timer,
  Target,
  Loader2,
} from 'lucide-react';
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
  
  // 配置状态
  const [durationMinutes, setDurationMinutes] = useState(30);
  const [questionCount, setQuestionCount] = useState(20);
  
  // 计时器状态 — 基于绝对时间戳的高精度倒计时
  const [targetEndTime, setTargetEndTime] = useState<number | null>(null);
  const isStarted = targetEndTime != null;
  
  const { remaining: remainingSeconds, isPaused, pause, resume, reset: resetCountdown } = useCountdown(
    targetEndTime,
    onTimeout,
  );
  
  // 计算进度
  const progress = timedSession
    ? (timedSession.answered_count / timedSession.question_count) * 100
    : 0;
  
  // 开始练习
  const handleStart = useCallback(async () => {
    try {
      const session = await startTimedPractice(examId, durationMinutes, questionCount);
      setTargetEndTime(Date.now() + durationMinutes * 60 * 1000);
      onStart?.(session);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showGlobalNotification('error', msg, t('timed.startError', '启动限时练习失败'));
    }
  }, [examId, durationMinutes, questionCount, startTimedPractice, onStart]);
  
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
    const totalSeconds = durationMinutes * 60;
    const ratio = remainingSeconds / totalSeconds;
    
    if (ratio > 0.5) return 'text-emerald-600';
    if (ratio > 0.25) return 'text-amber-600';
    return 'text-rose-600';
  };
  
  // 配置界面
  if (!isStarted) {
    return (
      <Card className={cn('bg-transparent border-transparent shadow-none', className)}>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Timer className="w-5 h-5 text-sky-500" />
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
                onChange={(e) => setDurationMinutes(Number(e.target.value))}
                className="text-center text-lg font-medium"
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
                onChange={(e) => setQuestionCount(Number(e.target.value))}
                className="text-center text-lg font-medium"
              />
            </div>
          </div>
          
          <div className="flex items-center justify-center gap-4 p-4 rounded-lg bg-muted/30">
            <div className="text-center">
              <div className="text-sm text-muted-foreground">{t('timed.estimated')}</div>
              <div className="text-2xl font-bold text-sky-600">{formatTime(durationMinutes * 60)}</div>
            </div>
            <div className="w-px h-10 bg-border" />
            <div className="text-center">
              <div className="text-sm text-muted-foreground">{t('timed.perQuestion')}</div>
              <div className="text-2xl font-bold text-amber-600">
                {Math.floor((durationMinutes * 60) / questionCount)}s
              </div>
            </div>
          </div>
          
          <NotionButton
            onClick={handleStart}
            disabled={isLoadingPractice}
            className="w-full h-12 text-lg"
          >
            {isLoadingPractice ? (
              <>
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
                {t('timed.loading')}
              </>
            ) : (
              <>
                <Play className="w-5 h-5 mr-2" />
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
    <Card className={cn('', className)}>
      <CardContent className="pt-6 space-y-6">
        {/* 倒计时显示 */}
        <div className="flex flex-col items-center justify-center py-6">
          <div className={cn(
            'text-6xl font-mono font-bold tabular-nums transition-colors',
            getTimeColor()
          )}>
            {formatTime(remainingSeconds)}
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {isPaused ? (
              <Badge variant="secondary" className="gap-1">
                <Pause className="w-3 h-3" />
                {t('timed.paused')}
              </Badge>
            ) : (
              <span className="flex items-center gap-1">
                <Clock className="w-4 h-4" />
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
              {timedSession?.answered_count || 0} / {timedSession?.question_count || questionCount}
            </span>
          </div>
          <Progress value={progress} className="h-2" />
        </div>
        
        {/* 统计信息 */}
        {timedSession && (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-emerald-500/10">
              <CheckCircle className="w-5 h-5 text-emerald-500" />
              <div>
                <div className="text-sm text-muted-foreground">{t('timed.correct')}</div>
                <div className="text-xl font-bold text-emerald-600">{timedSession.correct_count}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 p-3 rounded-lg bg-sky-500/10">
              <Target className="w-5 h-5 text-sky-500" />
              <div>
                <div className="text-sm text-muted-foreground">{t('timed.rate')}</div>
                <div className="text-xl font-bold text-sky-600">
                  {timedSession.answered_count > 0
                    ? Math.round((timedSession.correct_count / timedSession.answered_count) * 100)
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
                <Play className="w-4 h-4 mr-2" />
                {t('timed.resume')}
              </>
            ) : (
              <>
                <Pause className="w-4 h-4 mr-2" />
                {t('timed.pause')}
              </>
            )}
          </NotionButton>
          <NotionButton
            variant="default"
            onClick={handleSubmit}
            className="flex-1"
          >
            <StopCircle className="w-4 h-4 mr-2" />
            {t('timed.submit')}
          </NotionButton>
        </div>
        
        {/* 警告提示 */}
        {remainingSeconds < 60 && remainingSeconds > 0 && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-500/10 text-rose-600">
            <AlertCircle className="w-5 h-5" />
            <span className="text-sm font-medium">{t('timed.warning')}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default TimedPracticeMode;
