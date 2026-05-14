/**
 * PomodoroPanel - 嵌入 Todo 页面的番茄钟面板
 *
 * 严格使用设计系统白名单：
 * - 所有按钮走 NotionButton（variant: primary/utility/ghost）
 * - 无 rounded-full 大号圆形按钮
 * - 颜色走语义令牌（--primary/--success/--warning/--info/--destructive）
 * - 边框/分隔走 --shell-workspace-border / --shell-inspector-border
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Play,
  Pause,
  Square,
  Brain,
  Coffee,
  ArrowsOut,
  SkipForward,
  Timer,
  Flame,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { usePomodoroStore } from '../stores/usePomodoroStore';
import { getPomodoroTodayStats, type PomodoroTodayStats } from '../api';

interface ModeInfo {
  label: string;
  icon: React.ReactNode;
  colorClass: string;
  progressClass: string;
}

export const PomodoroPanel: React.FC = () => {
  const {
    mode,
    status,
    timeLeft,
    currentTaskTitle,
    settings,
    completedPomodorosToday,
    start,
    pause,
    resume,
    stop,
    setImmersive,
  } = usePomodoroStore();

  const [todayStats, setTodayStats] = useState<PomodoroTodayStats | null>(null);

  useEffect(() => {
    getPomodoroTodayStats().then(setTodayStats).catch(() => {});
  }, [completedPomodorosToday]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const formatMinutes = (s: number) => {
    const m = Math.round(s / 60);
    return m < 60 ? `${m} 分钟` : `${(m / 60).toFixed(1)} 小时`;
  };

  const handleTogglePlay = useCallback(() => {
    if (mode === 'idle') {
      start();
    } else if (status === 'running') {
      pause();
    } else {
      resume();
    }
  }, [mode, status, start, pause, resume]);

  const handleStop = useCallback(() => {
    stop(true);
  }, [stop]);

  const totalDuration = (() => {
    switch (mode) {
      case 'work':
        return settings.workDuration;
      case 'short_break':
        return settings.shortBreak;
      case 'long_break':
        return settings.longBreak;
      default:
        return settings.workDuration;
    }
  })();
  const progress = mode === 'idle' ? 0 : 1 - timeLeft / totalDuration;

  const getModeInfo = (): ModeInfo => {
    switch (mode) {
      case 'work':
        return {
          label: '专注中',
          icon: <Brain size={14} />,
          colorClass: 'text-[color:hsl(var(--warning))]',
          progressClass: 'bg-[color:hsl(var(--warning))]',
        };
      case 'short_break':
        return {
          label: '短休息',
          icon: <Coffee size={14} />,
          colorClass: 'text-[color:hsl(var(--success))]',
          progressClass: 'bg-[color:hsl(var(--success))]',
        };
      case 'long_break':
        return {
          label: '长休息',
          icon: <Coffee size={14} />,
          colorClass: 'text-[color:hsl(var(--info))]',
          progressClass: 'bg-[color:hsl(var(--info))]',
        };
      default:
        return {
          label: '番茄钟',
          icon: <Timer size={14} />,
          colorClass: 'text-muted-foreground',
          progressClass: 'bg-[color:var(--shell-workspace-border)]',
        };
    }
  };

  const modeInfo = getModeInfo();
  const isRunning = status === 'running';

  return (
    <div className="flex-shrink-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6">
        {/* 模式 + 任务 */}
        <div className="flex min-w-0 flex-shrink-0 items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-xs font-medium',
              modeInfo.colorClass,
            )}
          >
            {modeInfo.icon}
            {modeInfo.label}
          </span>
          {currentTaskTitle && mode !== 'idle' && (
            <span
              className="study-shell-badge max-w-[160px] truncate"
              title={currentTaskTitle}
            >
              {currentTaskTitle}
            </span>
          )}
        </div>

        {/* 计时 + 进度 */}
        <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'font-mono font-semibold tabular-nums transition-colors',
                mode === 'idle'
                  ? 'text-base text-muted-foreground'
                  : 'text-lg text-foreground',
              )}
            >
              {formatTime(timeLeft)}
            </span>
            {mode !== 'idle' && (
              <span className="text-[11px] text-muted-foreground">
                / {formatTime(totalDuration)}
              </span>
            )}
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-[color:var(--shell-workspace-border)]">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-1000 ease-linear',
                modeInfo.progressClass,
              )}
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>

        {/* 控制按钮组 */}
        <div className="flex flex-shrink-0 items-center gap-1">
          {mode !== 'idle' && (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={handleStop}
              title="停止"
              aria-label="stop"
              className="!h-7 !w-7"
            >
              <Square size={14} />
            </NotionButton>
          )}

          <NotionButton
            variant={mode === 'idle' || !isRunning ? 'primary' : 'utility'}
            size="sm"
            onClick={handleTogglePlay}
            title={isRunning ? '暂停' : mode === 'idle' ? '开始专注' : '继续'}
            aria-label={isRunning ? '暂停' : mode === 'idle' ? '开始专注' : '继续'}
            className="h-7 gap-1.5 !px-3 text-xs"
          >
            {isRunning ? <Pause size={14} /> : <Play size={14} />}
            <span>{isRunning ? '暂停' : mode === 'idle' ? '开始' : '继续'}</span>
          </NotionButton>

          {(mode === 'short_break' || mode === 'long_break') && (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => stop(false)}
              title="跳过休息"
              aria-label="skip"
              className="!h-7 !w-7"
            >
              <SkipForward size={14} />
            </NotionButton>
          )}

          {mode !== 'idle' && (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => setImmersive(true)}
              title="进入沉浸式专注模式"
              aria-label="immersive"
              className="!h-7 !w-7"
            >
              <ArrowsOut size={14} />
            </NotionButton>
          )}
        </div>
      </div>

      {/* 今日统计 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2.5 sm:px-6">
        <div className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Flame size={12} className="text-[color:hsl(var(--warning))]" />
          <span>
            今日{' '}
            <strong className="font-semibold text-foreground">
              {todayStats?.completedCount ?? completedPomodorosToday}
            </strong>{' '}
            个番茄
          </span>
        </div>
        {todayStats && todayStats.totalFocusSeconds > 0 && (
          <div className="text-[11px] text-muted-foreground">
            专注{' '}
            <strong className="font-semibold text-foreground">
              {formatMinutes(todayStats.totalFocusSeconds)}
            </strong>
          </div>
        )}
        {todayStats && todayStats.interruptedCount > 0 && (
          <div className="text-[11px] text-muted-foreground/60">
            中断 {todayStats.interruptedCount} 次
          </div>
        )}
      </div>
    </div>
  );
};
