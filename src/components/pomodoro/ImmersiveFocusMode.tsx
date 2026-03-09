import React, { useEffect, useCallback, useState, useRef } from 'react';
import { Play, Pause, Square, X, Coffee, BrainCircuit, Volume2, VolumeX, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import { usePomodoroStore } from './usePomodoroStore';

/**
 * 沉浸式专注模式 —— 全屏覆盖视图
 *
 * 设计理念（对标 Forest / Tide / Flow）：
 * - 极简深色背景，减少视觉干扰
 * - 大号圆形进度 + 数字倒计时居中
 * - 呼吸灯动画暗示"活跃计时"
 * - ESC / 右上角关闭回到正常界面
 * - 可选白噪音控制
 */

// ============================================================================
// 白噪音引擎（轻量级，基于 Web Audio API）
// ============================================================================

class WhiteNoiseEngine {
  private ctx: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private noiseNode: AudioBufferSourceNode | null = null;
  private _playing = false;

  get playing() {
    return this._playing;
  }

  start(volume = 0.15) {
    if (this._playing) return;
    try {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const bufferSize = 2 * this.ctx.sampleRate;
      const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      const data = buffer.getChannelData(0);

      // 棕噪音（Brown noise）—— 比白噪音更柔和，更适合专注
      let lastOut = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        data[i] = (lastOut + 0.02 * white) / 1.02;
        lastOut = data[i];
        data[i] *= 3.5; // 增益补偿
      }

      this.noiseNode = this.ctx.createBufferSource();
      this.noiseNode.buffer = buffer;
      this.noiseNode.loop = true;

      this.gainNode = this.ctx.createGain();
      this.gainNode.gain.value = volume;

      this.noiseNode.connect(this.gainNode);
      this.gainNode.connect(this.ctx.destination);
      this.noiseNode.start();
      this._playing = true;
    } catch (e) {
      console.error('[WhiteNoise] Failed to start:', e);
    }
  }

  stop() {
    try {
      this.noiseNode?.stop();
      this.noiseNode?.disconnect();
      this.gainNode?.disconnect();
      this.ctx?.close();
    } catch { /* ignore */ }
    this.noiseNode = null;
    this.gainNode = null;
    this.ctx = null;
    this._playing = false;
  }

  setVolume(v: number) {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, v));
    }
  }
}

const noiseEngine = new WhiteNoiseEngine();

// ============================================================================
// 圆形进度环组件
// ============================================================================

const CircularProgress: React.FC<{
  progress: number; // 0–1
  size?: number;
  strokeWidth?: number;
  className?: string;
}> = ({ progress, size = 280, strokeWidth = 4, className }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - progress);

  return (
    <svg
      width={size}
      height={size}
      className={cn('transform -rotate-90', className)}
    >
      {/* 背景圆 */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-white/10"
      />
      {/* 进度弧 */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="url(#progressGradient)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="transition-[stroke-dashoffset] duration-1000 ease-linear"
      />
      <defs>
        <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f97316" />
          <stop offset="100%" stopColor="#ef4444" />
        </linearGradient>
      </defs>
    </svg>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const ImmersiveFocusMode: React.FC<{
  onClose: () => void;
}> = ({ onClose }) => {
  const {
    mode,
    status,
    timeLeft,
    currentTaskTitle,
    settings,
    completedPomodorosToday,
    pause,
    resume,
    stop,
    start,
  } = usePomodoroStore();

  const [noiseOn, setNoiseOn] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // ⚠️ tick interval 由父组件 GlobalPomodoroWidget 统一驱动，此处不再重复注册

  // ESC 退出
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
      // 空格键暂停/恢复
      if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        if (mode === 'idle') return;
        status === 'running' ? pause() : resume();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, mode, status, pause, resume]);

  // 关闭时停止白噪音
  useEffect(() => {
    return () => {
      noiseEngine.stop();
    };
  }, []);

  const toggleNoise = useCallback(() => {
    if (noiseEngine.playing) {
      noiseEngine.stop();
      setNoiseOn(false);
    } else {
      noiseEngine.start(0.12);
      setNoiseOn(true);
    }
  }, []);

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

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // 计算进度
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
        return { label: '专注中', icon: <BrainCircuit className="w-5 h-5" />, color: 'text-orange-400' };
      case 'short_break':
        return { label: '短休息', icon: <Coffee className="w-5 h-5" />, color: 'text-emerald-400' };
      case 'long_break':
        return { label: '长休息', icon: <Coffee className="w-5 h-5" />, color: 'text-blue-400' };
      default:
        return { label: '准备就绪', icon: <BrainCircuit className="w-5 h-5" />, color: 'text-white/60' };
    }
  };

  const modeInfo = getModeInfo();

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-zinc-950 select-none"
      style={{ cursor: 'default' }}
    >
      {/* 呼吸光晕背景 */}
      {status === 'running' && (
        <>
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div
              className={cn(
                'w-[500px] h-[500px] rounded-full blur-[150px] opacity-20',
                mode === 'work' ? 'bg-orange-500' : mode === 'short_break' ? 'bg-emerald-500' : 'bg-blue-500',
                'animate-pulse'
              )}
              style={{ animationDuration: '4s' }}
            />
          </div>
        </>
      )}

      {/* 顶部栏 */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-6 py-4">
        <div className="flex items-center gap-3">
          <span className={cn('flex items-center gap-2 text-sm font-medium', modeInfo.color)}>
            {modeInfo.icon}
            {modeInfo.label}
          </span>
          {completedPomodorosToday > 0 && (
            <span className="text-xs text-white/40 bg-white/5 px-2 py-0.5 rounded-full">
              今日 {completedPomodorosToday} 个番茄
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 白噪音切换 */}
          <button
            onClick={toggleNoise}
            className={cn(
              'p-2 rounded-lg transition-colors',
              noiseOn
                ? 'bg-white/10 text-white/80 hover:bg-white/15'
                : 'text-white/30 hover:text-white/50 hover:bg-white/5'
            )}
            title={noiseOn ? '关闭环境音' : '开启环境音'}
          >
            {noiseOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
          {/* 关闭按钮 */}
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
            title="退出专注模式 (ESC)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* 中央计时器区域 */}
      <div className="relative flex flex-col items-center gap-8">
        {/* 圆形进度 + 时间 */}
        <div className="relative">
          <CircularProgress progress={progress} size={280} strokeWidth={4} />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span
              className={cn(
                'font-mono font-light tracking-[0.15em] text-white transition-all',
                mode === 'idle' ? 'text-5xl text-white/50' : 'text-6xl'
              )}
            >
              {formatTime(timeLeft)}
            </span>
          </div>
        </div>

        {/* 当前任务 */}
        {currentTaskTitle && (
          <div className="text-center max-w-md px-4">
            <p className="text-white/40 text-xs uppercase tracking-widest mb-1">当前任务</p>
            <p className="text-white/80 text-lg font-medium truncate" title={currentTaskTitle}>
              {currentTaskTitle}
            </p>
          </div>
        )}

        {/* 控制按钮 */}
        <div className="flex items-center gap-5 mt-4">
          {/* 停止 */}
          {mode !== 'idle' && (
            <button
              onClick={handleStop}
              className="flex items-center justify-center w-12 h-12 rounded-full bg-white/5 text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-all"
              title="停止"
            >
              <Square className="w-5 h-5" />
            </button>
          )}

          {/* 播放/暂停 */}
          <button
            onClick={handleTogglePlay}
            className={cn(
              'flex items-center justify-center w-16 h-16 rounded-full transition-all',
              status === 'running'
                ? 'bg-white/10 text-white hover:bg-white/15'
                : 'bg-orange-500 text-white hover:bg-orange-400 shadow-lg shadow-orange-500/20'
            )}
            title={status === 'running' ? '暂停 (Space)' : '开始 (Space)'}
          >
            {status === 'running' ? (
              <Pause className="w-6 h-6" />
            ) : (
              <Play className="w-6 h-6 ml-1" />
            )}
          </button>

          {/* 跳过（休息阶段可用） */}
          {(mode === 'short_break' || mode === 'long_break') && (
            <button
              onClick={() => {
                stop(false);
              }}
              className="flex items-center justify-center w-12 h-12 rounded-full bg-white/5 text-white/40 hover:text-white/70 hover:bg-white/10 transition-all"
              title="跳过休息"
            >
              <SkipForward className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* 底部提示 */}
      <div className="absolute bottom-6 left-0 right-0 text-center">
        <p className="text-white/20 text-xs">
          按 <kbd className="px-1.5 py-0.5 bg-white/5 rounded text-white/30 text-[10px] font-mono">ESC</kbd> 退出
          {' '}·{' '}
          <kbd className="px-1.5 py-0.5 bg-white/5 rounded text-white/30 text-[10px] font-mono">Space</kbd> 暂停/恢复
        </p>
      </div>
    </div>
  );
};
