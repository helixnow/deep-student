import React, { useEffect, useCallback, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Pause, Square, X, Coffee, Brain, SpeakerHigh, SpeakerSlash, SkipForward, CheckCircle } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { usePomodoroStore } from '../stores/usePomodoroStore';
import { noiseEngine, NOISE_TYPES } from '../noiseEngine';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

/**
 * 沉浸式专注模式 —— 全屏覆盖视图
 *
 * 设计理念（对标 Forest / Tide / Flow）：
 * - 极简深色背景，减少视觉干扰
 * - 大号圆形进度 + 数字倒计时居中
 * - 呼吸灯动画暗示"活跃计时"
 * - ESC / 右上角关闭回到正常界面
 * - 环境音（多音色 + 音量随设置），引擎与面板共享
 */

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
  const { t } = useTranslation('todo');
  const {
    mode,
    status,
    timeLeft,
    phaseStartedAt,
    currentTaskTitle,
    settings,
    completedPomodorosToday,
    pause,
    resume,
    stop,
    start,
    completeCurrentSession,
    updateSettings,
  } = usePomodoroStore();

  const [noiseOn, setNoiseOn] = useState(noiseEngine.playing);
  const containerRef = useRef<HTMLDivElement>(null);

  // ⚠️ tick interval 由父组件 GlobalPomodoroWidget 统一驱动，此处不再重复注册

  const isCountUpWork = mode === 'work' && (phaseStartedAt != null || settings.countUp);
  const pauseLocked = settings.strictMode && mode === 'work' && status === 'running';

  // Android 系统返回键 = 退出沉浸模式（与 ESC 同语义；桌面端无 Android 桥接，零影响）
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    return registerBackHandler(() => {
      onCloseRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, []);

  // ESC 退出
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
      // 空格键暂停/恢复（严格模式专注中忽略）
      if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        if (mode === 'idle') return;
        if (status === 'running') {
          pause();
        } else {
          resume();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, mode, status, pause, resume]);

  // 退出沉浸模式不再强停环境音（面板与沉浸共享引擎，由用户显式控制）

  const toggleNoise = useCallback(() => {
    if (noiseEngine.playing) {
      noiseEngine.stop();
      setNoiseOn(false);
    } else {
      noiseEngine.start(settings.noiseType, settings.noiseVolume);
      setNoiseOn(true);
    }
  }, [settings.noiseType, settings.noiseVolume]);

  const cycleNoiseType = useCallback(() => {
    const idx = NOISE_TYPES.indexOf(settings.noiseType);
    const next = NOISE_TYPES[(idx + 1) % NOISE_TYPES.length];
    updateSettings({ noiseType: next });
    noiseEngine.setType(next);
  }, [settings.noiseType, updateSettings]);

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

  // 计算进度（正计时：相对设定工作时长封顶）
  const totalDuration = (() => {
    switch (mode) {
      case 'work': return settings.workDuration;
      case 'short_break': return settings.shortBreak;
      case 'long_break': return settings.longBreak;
      default: return settings.workDuration;
    }
  })();
  const progress =
    mode === 'idle'
      ? 0
      : isCountUpWork
        ? Math.min(1, timeLeft / totalDuration)
        : 1 - timeLeft / totalDuration;

  const getModeInfo = () => {
    switch (mode) {
      case 'work':
        return { label: t('pomodoro.modes.focusing'), icon: <Brain size={20} />, color: 'text-orange-400' };
      case 'short_break':
        return { label: t('pomodoro.modes.shortBreak'), icon: <Coffee size={20} />, color: 'text-emerald-400' };
      case 'long_break':
        return { label: t('pomodoro.modes.longBreak'), icon: <Coffee size={20} />, color: 'text-blue-400' };
      default:
        return { label: t('pomodoro.modes.ready'), icon: <Brain size={20} />, color: 'text-white/60' };
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
              {t('pomodoro.stats.todayCount', { value: completedPomodorosToday })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 噪音类型（开启时显示，点击循环切换音色） */}
          {noiseOn && (
            <button
              onClick={cycleNoiseType}
              className="px-2 py-1 rounded-lg text-[11px] text-white/50 bg-white/5 hover:text-white/80 hover:bg-[var(--overlay-control-hover)] transition-colors"
              title={t('pomodoro.controls.noiseCycle')}
            >
              {t(`pomodoro.noise.${settings.noiseType}`)}
            </button>
          )}
          {/* 环境音切换 */}
          <button
            onClick={toggleNoise}
            className={cn(
              'p-2 rounded-lg transition-colors',
              noiseOn
                ? 'bg-white/10 text-white/80 hover:bg-[var(--overlay-control-hover)]'
                : 'text-white/30 hover:text-white/50 hover:bg-[var(--overlay-control-hover)]'
            )}
            title={noiseOn ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
          >
            {noiseOn ? <SpeakerHigh size={16} /> : <SpeakerSlash size={16} />}
          </button>
          {/* 音量滑杆（开启时显示） */}
          {noiseOn && (
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(settings.noiseVolume * 100)}
              onChange={(e) => {
                const volume = Number(e.target.value) / 100;
                updateSettings({ noiseVolume: volume });
                noiseEngine.setVolume(volume);
              }}
              className="h-1 w-20 cursor-pointer accent-white/70"
              aria-label={t('pomodoro.settings.noiseVolume')}
            />
          )}
          {/* 关闭按钮（触屏放大到 44px 触控目标） */}
          <button
            onClick={onClose}
            className="p-2 [@media(pointer:coarse)]:p-3 rounded-lg text-white/30 hover:text-white/60 hover:bg-[var(--overlay-control-hover)] transition-colors"
            title={t('pomodoro.controls.exitImmersive')}
            aria-label={t('pomodoro.controls.exitImmersive')}
          >
            <X size={20} />
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
            <p className="text-white/40 text-xs uppercase tracking-widest mb-1">{t('pomodoro.immersive.currentTask')}</p>
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
              title={t('pomodoro.controls.stop')}
            >
              <Square size={20} />
            </button>
          )}

          {/* 正计时专注中：完成按钮 */}
          {isCountUpWork && status === 'running' && (
            <button
              onClick={() => completeCurrentSession()}
              className="flex items-center justify-center w-16 h-16 rounded-full bg-emerald-500 text-white hover:bg-emerald-400 shadow-lg shadow-emerald-500/20 transition-all"
              title={t('pomodoro.controls.finish')}
            >
              <CheckCircle size={26} />
            </button>
          )}

          {/* 播放/暂停（严格模式专注中隐藏暂停） */}
          {!pauseLocked && (
            <button
              onClick={handleTogglePlay}
              className={cn(
                'flex items-center justify-center w-16 h-16 rounded-full transition-all',
                status === 'running'
                  ? 'bg-white/10 text-white hover:bg-[var(--overlay-control-hover)]'
                  : 'bg-orange-500 text-white hover:bg-orange-400 shadow-lg shadow-orange-500/20'
              )}
              title={status === 'running' ? t('pomodoro.controls.pauseSpace') : t('pomodoro.controls.startSpace')}
            >
              {status === 'running' ? (
                <Pause size={24} />
              ) : (
                <Play size={24} className="ml-1" />
              )}
            </button>
          )}
          {pauseLocked && !isCountUpWork && (
            <span
              className="px-3 py-1 rounded-full bg-white/5 text-white/40 text-xs"
              title={t('pomodoro.strictHint')}
            >
              {t('pomodoro.strictBadge')}
            </span>
          )}

          {/* 跳过（休息阶段可用） */}
          {(mode === 'short_break' || mode === 'long_break') && (
            <button
              onClick={() => {
                stop(false);
              }}
              className="flex items-center justify-center w-12 h-12 rounded-full bg-white/5 text-white/40 hover:text-white/70 hover:bg-[var(--overlay-control-hover)] transition-all"
              title={t('pomodoro.controls.skipBreak')}
            >
              <SkipForward size={20} />
            </button>
          )}
        </div>
      </div>

      {/* 底部提示 */}
      <div className="absolute bottom-6 left-0 right-0 text-center">
        <p className="text-white/20 text-xs">
          {t('pomodoro.immersive.hintEscPrefix')}
          <kbd className="px-1.5 py-0.5 bg-white/5 rounded text-white/30 text-[10px] font-mono">ESC</kbd>
          {t('pomodoro.immersive.hintEscSuffix')}
          {' '}·{' '}
          {t('pomodoro.immersive.hintSpacePrefix')}
          <kbd className="px-1.5 py-0.5 bg-white/5 rounded text-white/30 text-[10px] font-mono">Space</kbd>
          {t('pomodoro.immersive.hintSpaceSuffix')}
        </p>
      </div>
    </div>
  );
};
