import React, { useEffect } from 'react';
import { Pause, Play, Square, Coffee, BrainCircuit, Maximize2 } from 'lucide-react';
import { usePomodoroStore } from './usePomodoroStore';
import { useViewStore } from '@/stores/viewStore';
import { ImmersiveFocusMode } from './ImmersiveFocusMode';

/**
 * GlobalPomodoroWidget
 *
 * 职责：
 * 1. 全局 tick 驱动（唯一的 setInterval 来源）
 * 2. 沉浸式专注模式渲染
 * 3. 离开 Todo 页面时的悬浮药丸（仅在有活跃会话时显示）
 *
 * 空闲态不显示任何浮动 UI——番茄钟主入口在 Todo 页面内的 PomodoroPanel。
 */
export const GlobalPomodoroWidget: React.FC = () => {
  const { mode, status, timeLeft, currentTaskTitle, pause, resume, stop, tick, isImmersive, setImmersive } = usePomodoroStore();
  const currentView = useViewStore((s) => s.currentView);

  // 全局唯一 tick 驱动
  useEffect(() => {
    let intervalId: number;
    if (status === 'running') {
      intervalId = window.setInterval(() => tick(), 1000);
    }
    return () => { if (intervalId) window.clearInterval(intervalId); };
  }, [status, tick]);

  // 沉浸式专注模式
  if (isImmersive) {
    return <ImmersiveFocusMode onClose={() => setImmersive(false)} />;
  }

  // 空闲态或在 Todo 页面时不显示悬浮球（Todo 页面有内嵌 PomodoroPanel）
  if (mode === 'idle' || currentView === 'todo') {
    return null;
  }

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getModeIcon = () => {
    switch (mode) {
      case 'work': return <BrainCircuit className="w-4 h-4 text-orange-500" />;
      case 'short_break': return <Coffee className="w-4 h-4 text-green-500" />;
      case 'long_break': return <Coffee className="w-4 h-4 text-blue-500" />;
      default: return null;
    }
  };

  const handleTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    status === 'running' ? pause() : resume();
  };

  // 悬浮药丸：仅在有活跃会话 + 不在 Todo 页面时显示
  return (
    <div
      className="fixed bottom-6 right-6 z-50 bg-background border border-border shadow-xl rounded-full h-12 flex items-center gap-3 px-4 pr-2 cursor-default animate-in fade-in slide-in-from-bottom-4 duration-300"
    >
      {getModeIcon()}
      <span className="font-mono font-medium tracking-wider text-sm text-foreground">
        {formatTime(timeLeft)}
      </span>
      {currentTaskTitle && (
        <span className="text-xs text-muted-foreground truncate max-w-[120px]" title={currentTaskTitle}>
          {currentTaskTitle}
        </span>
      )}
      <div className="flex items-center gap-1 ml-1">
        <button
          onClick={handleTogglePlay}
          className="p-1.5 rounded-full hover:bg-muted transition-colors"
          title={status === 'running' ? '暂停' : '继续'}
        >
          {status === 'running' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); stop(true); }}
          className="p-1.5 rounded-full hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
          title="停止"
        >
          <Square className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setImmersive(true); }}
          className="p-1.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="沉浸模式"
        >
          <Maximize2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};
