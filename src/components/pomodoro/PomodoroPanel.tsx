/**
 * PomodoroPanel - 嵌入 Todo 页面的番茄钟面板
 *
 * 放置在 TodoMainPanel 底部，作为番茄钟的主入口。
 * 支持：
 * - 不关联待办直接启动
 * - 关联待办启动（从 TodoItemRow 触发后同步显示）
 * - 今日统计
 * - 进入沉浸式专注模式
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  Play, Pause, Square, BrainCircuit, Coffee,
  Maximize2, SkipForward, Timer, Flame,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePomodoroStore } from './usePomodoroStore';
import { getPomodoroTodayStats, type PomodoroTodayStats } from './api';

export const PomodoroPanel: React.FC = () => {
  const {
    mode, status, timeLeft,
    currentTaskId, currentTaskTitle,
    settings, completedPomodorosToday,
    start, pause, resume, stop,
    setImmersive,
  } = usePomodoroStore();

  const [todayStats, setTodayStats] = useState<PomodoroTodayStats | null>(null);

  // ⚠️ tick interval 由 GlobalPomodoroWidget 统一驱动，此处不注册

  // 加载今日统计（进入页面时 + 完成会话后刷新）
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
      start(); // 不关联任务直接启动
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
      case 'work': return settings.workDuration;
      case 'short_break': return settings.shortBreak;
      case 'long_break': return settings.longBreak;
      default: return settings.workDuration;
    }
  })();
  const progress = mode === 'idle' ? 0 : 1 - timeLeft / totalDuration;

  const getModeInfo = () => {
    switch (mode) {
      case 'work':
        return { label: '专注中', icon: <BrainCircuit className="w-4 h-4" />, color: 'text-orange-500', bg: 'bg-orange-500' };
      case 'short_break':
        return { label: '短休息', icon: <Coffee className="w-4 h-4" />, color: 'text-emerald-500', bg: 'bg-emerald-500' };
      case 'long_break':
        return { label: '长休息', icon: <Coffee className="w-4 h-4" />, color: 'text-blue-500', bg: 'bg-blue-500' };
      default:
        return { label: '番茄钟', icon: <Timer className="w-4 h-4" />, color: 'text-muted-foreground', bg: 'bg-muted-foreground' };
    }
  };

  const modeInfo = getModeInfo();

  return (
    <div className="border-t border-border/40 bg-muted/10">
      <div className="px-6 py-4">
        {/* 标题行 */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className={cn('flex items-center gap-1.5 text-sm font-medium', modeInfo.color)}>
              {modeInfo.icon}
              {modeInfo.label}
            </span>
            {currentTaskTitle && mode !== 'idle' && (
              <span className="text-xs text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-md truncate max-w-[180px]" title={currentTaskTitle}>
                {currentTaskTitle}
              </span>
            )}
          </div>
          {mode !== 'idle' && (
            <button
              onClick={() => setImmersive(true)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              title="进入沉浸式专注模式"
            >
              <Maximize2 className="w-3 h-3" />
              专注模式
            </button>
          )}
        </div>

        {/* 计时器 + 控制 */}
        <div className="flex items-center gap-4">
          {/* 进度条 + 时间 */}
          <div className="flex-1">
            <div className="flex items-baseline gap-3 mb-2">
              <span className={cn(
                'font-mono font-bold tracking-wider transition-all',
                mode === 'idle' ? 'text-2xl text-muted-foreground/60' : 'text-3xl text-foreground'
              )}>
                {formatTime(timeLeft)}
              </span>
              {mode !== 'idle' && (
                <span className="text-xs text-muted-foreground">
                  / {formatTime(totalDuration)}
                </span>
              )}
            </div>
            {/* 进度条 */}
            <div className="h-1.5 bg-muted/50 rounded-full overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all duration-1000 ease-linear', modeInfo.bg)}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          </div>

          {/* 控制按钮 */}
          <div className="flex items-center gap-2">
            {/* 停止 */}
            {mode !== 'idle' && (
              <button
                onClick={handleStop}
                className="flex items-center justify-center w-9 h-9 rounded-full bg-muted/50 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                title="停止"
              >
                <Square className="w-4 h-4" />
              </button>
            )}

            {/* 播放/暂停 */}
            <button
              onClick={handleTogglePlay}
              className={cn(
                'flex items-center justify-center w-11 h-11 rounded-full transition-all',
                status === 'running'
                  ? 'bg-muted text-foreground hover:bg-muted/80'
                  : 'bg-orange-500 text-white hover:bg-orange-400 shadow-md shadow-orange-500/20'
              )}
              title={status === 'running' ? '暂停' : mode === 'idle' ? '开始专注' : '继续'}
            >
              {status === 'running' ? (
                <Pause className="w-5 h-5" />
              ) : (
                <Play className="w-5 h-5 ml-0.5" />
              )}
            </button>

            {/* 跳过休息 */}
            {(mode === 'short_break' || mode === 'long_break') && (
              <button
                onClick={() => stop(false)}
                className="flex items-center justify-center w-9 h-9 rounded-full bg-muted/50 text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
                title="跳过休息"
              >
                <SkipForward className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {/* 今日统计 */}
        <div className="flex items-center gap-4 mt-3 pt-3 border-t border-border/30">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Flame className="w-3.5 h-3.5 text-orange-400" />
            <span>今日 <strong className="text-foreground">{todayStats?.completedCount ?? completedPomodorosToday}</strong> 个番茄</span>
          </div>
          {todayStats && todayStats.totalFocusSeconds > 0 && (
            <div className="text-xs text-muted-foreground">
              专注 <strong className="text-foreground">{formatMinutes(todayStats.totalFocusSeconds)}</strong>
            </div>
          )}
          {todayStats && todayStats.interruptedCount > 0 && (
            <div className="text-xs text-muted-foreground/60">
              中断 {todayStats.interruptedCount} 次
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
