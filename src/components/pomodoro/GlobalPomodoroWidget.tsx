import React, { useEffect, useState } from 'react';
import { Play, Pause, Square, Coffee, BrainCircuit, X, Maximize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePomodoroStore } from './usePomodoroStore';
import { ImmersiveFocusMode } from './ImmersiveFocusMode';

export const GlobalPomodoroWidget: React.FC = () => {
  const { mode, status, timeLeft, currentTaskTitle, start, pause, resume, stop, tick, isImmersive, setImmersive } = usePomodoroStore();
  const [isExpanded, setIsExpanded] = useState(false);

  // Setup the tick interval
  useEffect(() => {
    let intervalId: number;
    if (status === 'running') {
      intervalId = window.setInterval(() => {
        tick();
      }, 1000);
    }
    return () => {
      if (intervalId) window.clearInterval(intervalId);
    };
  }, [status, tick]);

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
      default: return <BrainCircuit className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getModeLabel = () => {
    switch (mode) {
      case 'work': return 'Focus';
      case 'short_break': return 'Short Break';
      case 'long_break': return 'Long Break';
      default: return 'Ready';
    }
  };

  const handleTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === 'running') {
      pause();
    } else {
      if (mode === 'idle') {
        start();
      } else {
        resume();
      }
    }
  };

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    stop(true);
    setIsExpanded(false);
  };

  // 沉浸式专注模式
  if (isImmersive) {
    return <ImmersiveFocusMode onClose={() => setImmersive(false)} />;
  }

  if (mode === 'idle' && !isExpanded) {
    return (
      <div 
        className="fixed bottom-6 right-6 z-50 bg-background border border-border shadow-lg rounded-full p-3 cursor-pointer hover:bg-muted transition-colors flex items-center gap-2"
        onClick={() => setIsExpanded(true)}
        title="Open Pomodoro Timer"
      >
        <BrainCircuit className="w-5 h-5 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div 
      className={cn(
        "fixed bottom-6 right-6 z-50 bg-background border border-border shadow-xl transition-all duration-300 overflow-hidden flex flex-col",
        isExpanded ? "rounded-xl w-72" : "rounded-full h-12 flex-row items-center cursor-pointer hover:bg-muted pr-2"
      )}
      onClick={!isExpanded ? () => setIsExpanded(true) : undefined}
    >
      {/* Collapsed State - Just the pill */}
      {!isExpanded && (
        <div className="flex items-center gap-3 px-3 w-full">
          {getModeIcon()}
          <span className="font-mono font-medium tracking-wider text-sm">
            {formatTime(timeLeft)}
          </span>
          <div className="flex-1" />
          <button 
            onClick={handleTogglePlay}
            className="p-1.5 rounded-full hover:bg-background transition-colors"
          >
            {status === 'running' ? (
              <Pause className="w-3.5 h-3.5" />
            ) : (
              <Play className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      )}

      {/* Expanded State - Full Card */}
      {isExpanded && (
        <>
          <div className="flex items-center justify-between p-3 border-b border-border/50 bg-muted/30">
            <div className="flex items-center gap-2">
              {getModeIcon()}
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {getModeLabel()}
              </span>
            </div>
            <button 
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(false);
              }}
              className="p-1 rounded-md hover:bg-muted text-muted-foreground"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5 flex flex-col items-center justify-center gap-4">
            <div className="text-4xl font-mono font-bold tracking-widest text-foreground">
              {formatTime(timeLeft)}
            </div>

            {currentTaskTitle && (
              <div className="text-sm text-center px-4 py-1.5 bg-muted/50 rounded-full w-full truncate" title={currentTaskTitle}>
                {currentTaskTitle}
              </div>
            )}

            <div className="flex items-center gap-3 mt-2">
              <button
                onClick={handleTogglePlay}
                className={cn(
                  "flex items-center justify-center w-12 h-12 rounded-full transition-colors",
                  status === 'running' 
                    ? "bg-muted text-foreground hover:bg-muted/80" 
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                )}
              >
                {status === 'running' ? (
                  <Pause className="w-5 h-5" />
                ) : (
                  <Play className="w-5 h-5 ml-1" />
                )}
              </button>
              
              {mode !== 'idle' && (
                <button
                  onClick={handleStop}
                  title="Stop / Interrupt"
                  className="flex items-center justify-center w-10 h-10 rounded-full bg-muted text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                >
                  <Square className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* 沉浸模式入口 */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                setImmersive(true);
              }}
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1"
              title="进入沉浸式专注模式"
            >
              <Maximize2 className="w-3 h-3" />
              <span>专注模式</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
};
