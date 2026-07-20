import React, { useEffect, useCallback, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Play, Pause, Square, X, Coffee, Brain, SpeakerHigh, SpeakerSlash, SkipForward, CheckCircle, Flame, LockSimple } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { usePomodoroStore } from '../stores/usePomodoroStore';
import { noiseEngine, NOISE_TYPES } from '../noiseEngine';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';

/**
 * 沉浸式专注模式 —— 全屏覆盖视图
 *
 * 设计理念（对标 Forest / Tide / Flow）：
 * - 背景随主题（语义 token），不再硬编码暗色
 * - 大号圆形进度 + 数字倒计时居中，进度环颜色随阶段语义色
 *   （work = primary，short_break = success，long_break = info）
 * - 含蓄呼吸光晕暗示"活跃计时"（prefers-reduced-motion 下停用）
 * - 影院模式：鼠标静止 3s 后控制栏淡出，移动唤醒
 * - ESC / 右上角关闭回到正常界面；严格模式下 Space no-op + 轻微 shake 反馈
 * - 完成一个番茄时的一次性全屏庆祝微动效
 * - 环境音状态收敛进 store（noiseEnabled / setNoiseEnabled），与面板共享
 */

// 局部动效 keyframes：只动 opacity / translate / scale，与 ui-motion 约定一致；
// reduced-motion 下全部退化（JS 侧同时用 useMediaQuery 二重保险）
const IMMERSIVE_MOTION_CSS = `
@keyframes pomodoro-kf-breathe {
  0%, 100% { opacity: 0.06; scale: 0.94; }
  50% { opacity: 0.14; scale: 1.05; }
}
@keyframes pomodoro-kf-strict-shake {
  0%, 100% { translate: 0 0; }
  20% { translate: -5px 0; }
  40% { translate: 4px 0; }
  60% { translate: -3px 0; }
  80% { translate: 2px 0; }
}
@keyframes pomodoro-kf-celebrate-ring {
  from { opacity: 0.45; scale: 0.75; }
  to { opacity: 0; scale: 1.4; }
}
@keyframes pomodoro-kf-celebrate-pop {
  0% { opacity: 0; translate: 0 10px; }
  15% { opacity: 1; translate: 0 0; }
  82% { opacity: 1; translate: 0 0; }
  100% { opacity: 0; translate: 0 -4px; }
}
@keyframes pomodoro-kf-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.pomodoro-breathe { animation: pomodoro-kf-breathe 6s ease-in-out infinite; }
.pomodoro-strict-shake { animation: pomodoro-kf-strict-shake 400ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.pomodoro-celebrate-ring { animation: pomodoro-kf-celebrate-ring 1200ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.pomodoro-celebrate-pop { animation: pomodoro-kf-celebrate-pop 1600ms cubic-bezier(0.22, 1, 0.36, 1) both; }
@media (prefers-reduced-motion: reduce) {
  .pomodoro-breathe, .pomodoro-strict-shake, .pomodoro-celebrate-ring { animation: none; }
  .pomodoro-celebrate-pop { animation: pomodoro-kf-fade-in 250ms cubic-bezier(0.22, 1, 0.36, 1) both; }
}
`;

// ============================================================================
// 圆形进度环组件（语义色随阶段，由父级 --focus-accent 注入）
// ============================================================================

const CircularProgress: React.FC<{
  progress: number; // 0–1
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** 响应式渲染尺寸（CSS 长度，如 'min(280px, 70vw)'）；坐标系仍按 size 计算 */
  cssSize?: string;
}> = ({ progress, size = 280, strokeWidth = 4, className, cssSize }) => {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - Math.min(1, Math.max(0, progress)));

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      style={cssSize ? { width: cssSize, height: cssSize } : { width: size, height: size }}
      className={cn('transform -rotate-90', className)}
      aria-hidden="true"
    >
      {/* 背景圆 */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-border"
      />
      {/* 进度弧 */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--focus-accent)"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
      />
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
    currentTaskTitle,
    settings,
    completedPomodorosToday,
    streakDays,
    sessionCountUp,
    noiseEnabled,
    setNoiseEnabled,
    pause,
    resume,
    stop,
    start,
    skipBreak,
    completeCurrentSession,
    updateSettings,
  } = usePomodoroStore();

  const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  const containerRef = useRef<HTMLDivElement>(null);

  // ⚠️ tick interval 由父组件 GlobalPomodoroWidget 统一驱动，此处不再重复注册

  const isCountUpWork = mode === 'work' && sessionCountUp;
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

  // 严格模式下 Space no-op 的轻反馈：badge shake + 短暂提示文案
  const [strictNudge, setStrictNudge] = useState(0);
  const [strictHintVisible, setStrictHintVisible] = useState(false);
  const strictTimerRef = useRef<number | null>(null);
  const triggerStrictNudge = useCallback(() => {
    setStrictNudge((n) => n + 1);
    setStrictHintVisible(true);
    if (strictTimerRef.current) window.clearTimeout(strictTimerRef.current);
    strictTimerRef.current = window.setTimeout(() => setStrictHintVisible(false), 1800);
  }, []);
  useEffect(() => {
    return () => {
      if (strictTimerRef.current) window.clearTimeout(strictTimerRef.current);
    };
  }, []);

  // ESC 退出 / Space 暂停恢复（严格模式专注中 no-op + shake 反馈）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
      if (e.key === ' ' && e.target === document.body) {
        e.preventDefault();
        if (mode === 'idle') return;
        if (pauseLocked) {
          triggerStrictNudge();
          return;
        }
        if (status === 'running') {
          pause();
        } else {
          resume();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, mode, status, pause, resume, pauseLocked, triggerStrictNudge]);

  // 影院模式：运行中鼠标静止 3s 后控制栏淡出，任何指针/按键活动唤醒
  // （触屏无 hover 语义，不自动隐藏）
  const [chromeVisible, setChromeVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);
  const wakeChrome = useCallback(() => {
    setChromeVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setChromeVisible(false), 3000);
  }, []);
  useEffect(() => {
    if (isTouchPrimary || status !== 'running') {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
      setChromeVisible(true);
      return;
    }
    wakeChrome();
    const onActivity = () => wakeChrome();
    window.addEventListener('pointermove', onActivity);
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);
    return () => {
      window.removeEventListener('pointermove', onActivity);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [isTouchPrimary, status, wakeChrome]);

  // 完成一个番茄时的一次性庆祝微动效（今日计数增长即触发；跨午夜重置不会误触发）
  const prevCompletedRef = useRef(completedPomodorosToday);
  const [celebrating, setCelebrating] = useState(false);
  useEffect(() => {
    const prev = prevCompletedRef.current;
    prevCompletedRef.current = completedPomodorosToday;
    if (completedPomodorosToday > prev) {
      setCelebrating(true);
      const id = window.setTimeout(() => setCelebrating(false), prefersReducedMotion ? 1200 : 1700);
      return () => window.clearTimeout(id);
    }
  }, [completedPomodorosToday, prefersReducedMotion]);

  // 退出沉浸模式不再强停环境音（面板与沉浸共享引擎，由用户显式控制）

  const toggleNoise = useCallback(() => {
    setNoiseEnabled(!noiseEnabled);
  }, [noiseEnabled, setNoiseEnabled]);

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

  // 触屏：轻触屏幕空白处暂停/恢复（按钮/滑杆等交互元素除外；严格模式给 shake 反馈）
  const handleBackdropTap = useCallback(
    (e: React.MouseEvent) => {
      if (!isTouchPrimary || mode === 'idle') return;
      const target = e.target as Element | null;
      if (target?.closest('button, input, a, [role="slider"], [role="progressbar"]')) return;
      if (pauseLocked) {
        triggerStrictNudge();
        return;
      }
      if (status === 'running') {
        pause();
      } else {
        resume();
      }
    },
    [isTouchPrimary, mode, pauseLocked, status, pause, resume, triggerStrictNudge],
  );

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

  // 阶段语义色：work = primary，short_break = success，long_break = info
  const focusAccent = (() => {
    switch (mode) {
      case 'work': return 'hsl(var(--primary))';
      case 'short_break': return 'hsl(var(--success))';
      case 'long_break': return 'hsl(var(--info))';
      default: return 'hsl(var(--muted-foreground))';
    }
  })();

  const getModeInfo = () => {
    switch (mode) {
      case 'work':
        return { label: t('pomodoro.modes.focusing'), icon: <Brain size={20} /> };
      case 'short_break':
        return { label: t('pomodoro.modes.shortBreak'), icon: <Coffee size={20} /> };
      case 'long_break':
        return { label: t('pomodoro.modes.longBreak'), icon: <Coffee size={20} /> };
      default:
        return { label: t('pomodoro.modes.ready'), icon: <Brain size={20} /> };
    }
  };

  const modeInfo = getModeInfo();

  // 控制栏淡出（影院模式）：只动 opacity；淡出后禁止误点
  const chromeClass = cn(
    'transition-opacity duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
    !chromeVisible && 'opacity-0 pointer-events-none'
  );

  // 统一控制按钮语言：次级 = 描边卡片圆钮，主级 = 语义实心圆钮（无 hover scale）
  const secondaryControlClass =
    'flex items-center justify-center w-12 h-12 rounded-full border border-border bg-card text-muted-foreground transition-colors duration-150 hover:text-foreground hover:bg-[var(--interactive-hover)] motion-reduce:transition-none';

  return (
    <div
      ref={containerRef}
      className={cn(
        'fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background select-none',
        !chromeVisible && 'cursor-none'
      )}
      style={{ '--focus-accent': focusAccent } as React.CSSProperties}
      onClick={handleBackdropTap}
    >
      <style>{IMMERSIVE_MOTION_CSS}</style>

      {/* 含蓄呼吸光晕背景（reduced-motion 下不渲染） */}
      {status === 'running' && !prefersReducedMotion && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden="true">
          <div
            className="pomodoro-breathe w-[420px] h-[420px] rounded-full blur-[120px]"
            style={{ backgroundColor: 'var(--focus-accent)' }}
          />
        </div>
      )}

      {/* 一次性完成庆祝（reduced-motion 退化为纯淡入淡出徽章） */}
      {celebrating && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center pointer-events-none" aria-hidden="true">
          {!prefersReducedMotion && (
            <div
              className="pomodoro-celebrate-ring absolute w-[320px] h-[320px] rounded-full border-2"
              style={{ borderColor: 'hsl(var(--success))' }}
            />
          )}
          <div className="pomodoro-celebrate-pop flex items-center gap-2 rounded-full border border-border bg-card px-4 py-2 shadow-lg">
            <CheckCircle size={18} weight="fill" className="text-success" />
            <span className="text-sm font-medium text-foreground">
              {t('pomodoro.notifications.workCompleteTitle')}
            </span>
          </div>
        </div>
      )}

      {/* 顶部栏（预留移动端安全区，避免刘海/状态栏遮挡） */}
      <div
        className={cn('absolute top-0 left-0 right-0 flex items-center justify-between px-6 pb-4', chromeClass)}
        style={{ paddingTop: 'calc(1rem + var(--mobile-safe-area-top, 0px))' }}
      >
        <div className="flex items-center gap-3">
          <span
            className="flex items-center gap-2 text-sm font-medium"
            style={{ color: mode === 'idle' ? undefined : 'var(--focus-accent)' }}
          >
            {modeInfo.icon}
            {modeInfo.label}
          </span>
          {completedPomodorosToday > 0 && (
            <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              {t('pomodoro.stats.todayCount', { value: completedPomodorosToday })}
            </span>
          )}
          {streakDays > 1 && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
              <Flame size={12} weight="fill" className="text-warning" />
              {t('pomodoro.stats.streakDays', { value: streakDays, defaultValue: '连续专注 {{value}} 天' })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* 噪音类型（开启时显示，点击循环切换音色） */}
          {noiseEnabled && (
            <button
              onClick={cycleNoiseType}
              className="px-2 py-1 rounded-lg text-[11px] text-muted-foreground bg-muted hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150 motion-reduce:transition-none"
              title={t('pomodoro.controls.noiseCycle')}
              aria-label={t('pomodoro.controls.noiseCycle')}
            >
              {t(`pomodoro.noise.${settings.noiseType}`)}
            </button>
          )}
          {/* 环境音切换 */}
          <button
            onClick={toggleNoise}
            className={cn(
              'p-2 rounded-lg transition-colors duration-150 motion-reduce:transition-none',
              noiseEnabled
                ? 'bg-muted text-foreground hover:bg-[var(--interactive-hover)]'
                : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
            )}
            title={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
            aria-label={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
            aria-pressed={noiseEnabled}
          >
            {noiseEnabled ? <SpeakerHigh size={16} /> : <SpeakerSlash size={16} />}
          </button>
          {/* 音量滑杆（开启时显示） */}
          {noiseEnabled && (
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
              className="h-1 w-20 cursor-pointer accent-primary"
              aria-label={t('pomodoro.settings.noiseVolume')}
            />
          )}
          {/* 关闭按钮（触屏放大到 44px 触控目标） */}
          <button
            onClick={onClose}
            className="p-2 [@media(pointer:coarse)]:p-3 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)] transition-colors duration-150 motion-reduce:transition-none"
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
        <div
          className="relative"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.min(1, Math.max(0, progress)) * 100)}
          aria-label={modeInfo.label}
        >
          {/* 窄屏（如竖屏手机）圆环收缩到 70vw，避免溢出 */}
          <CircularProgress progress={progress} size={280} strokeWidth={4} cssSize="min(280px, 70vw)" />
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span
              className={cn(
                'font-mono font-light tabular-nums transition-colors duration-150 motion-reduce:transition-none',
                mode === 'idle' ? 'text-5xl text-muted-foreground' : 'text-6xl text-foreground'
              )}
            >
              {formatTime(timeLeft)}
            </span>
          </div>
        </div>

        {/* 当前任务 */}
        {currentTaskTitle && (
          <div className="text-center max-w-md px-4">
            <p className="text-muted-foreground/70 text-xs uppercase tracking-widest mb-1">{t('pomodoro.immersive.currentTask')}</p>
            <p className="text-foreground/90 text-lg font-medium truncate" title={currentTaskTitle}>
              {currentTaskTitle}
            </p>
          </div>
        )}

        {/* 控制按钮 */}
        <div className={cn('flex flex-col items-center', chromeClass)}>
          <div className="flex items-center gap-5 mt-4">
            {/* 停止 */}
            {mode !== 'idle' && (
              <button
                onClick={handleStop}
                className={cn(secondaryControlClass, 'hover:text-destructive hover:bg-destructive/10')}
                title={t('pomodoro.controls.stop')}
                aria-label={t('pomodoro.controls.stop')}
              >
                <Square size={20} />
              </button>
            )}

            {/* 正计时专注中：完成按钮 */}
            {isCountUpWork && status === 'running' && (
              <button
                onClick={() => completeCurrentSession()}
                className="flex items-center justify-center w-16 h-16 rounded-full bg-success text-success-foreground shadow-lg hover:bg-success/90 transition-colors duration-150 motion-reduce:transition-none"
                title={t('pomodoro.controls.finish')}
                aria-label={t('pomodoro.controls.finish')}
              >
                <CheckCircle size={26} />
              </button>
            )}

            {/* 播放/暂停（严格模式专注中隐藏暂停） */}
            {!pauseLocked && (
              <button
                onClick={handleTogglePlay}
                className={cn(
                  'flex items-center justify-center w-16 h-16 rounded-full transition-colors duration-150 motion-reduce:transition-none',
                  status === 'running'
                    ? 'border border-border bg-card text-foreground hover:bg-[var(--interactive-hover)]'
                    : 'bg-primary text-primary-foreground shadow-lg hover:bg-primary/90'
                )}
                title={status === 'running' ? t('pomodoro.controls.pauseSpace') : t('pomodoro.controls.startSpace')}
                aria-label={status === 'running' ? t('pomodoro.controls.pause') : t('pomodoro.controls.resume')}
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
                key={strictNudge}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-muted text-muted-foreground text-xs',
                  strictNudge > 0 && !prefersReducedMotion && 'pomodoro-strict-shake'
                )}
                title={t('pomodoro.strictHint')}
              >
                <LockSimple size={12} />
                {t('pomodoro.strictBadge')}
              </span>
            )}

            {/* 跳过（休息阶段可用） */}
            {(mode === 'short_break' || mode === 'long_break') && (
              <button
                onClick={() => skipBreak()}
                className={secondaryControlClass}
                title={t('pomodoro.controls.skipBreak')}
                aria-label={t('pomodoro.controls.skipBreak')}
              >
                <SkipForward size={20} />
              </button>
            )}
          </div>

          {/* 严格模式 Space no-op 提示（固定高度避免布局跳动） */}
          <div className="h-5 mt-3" aria-live="polite">
            {strictHintVisible && (
              <p className="text-xs text-muted-foreground ui-rise-in">{t('pomodoro.strictHint')}</p>
            )}
          </div>
        </div>
      </div>

      {/* 底部提示（预留手势条安全区）：
          触屏无键盘，换成「轻触屏幕暂停」；桌面保留 ESC/Space 快捷键提示 */}
      <div
        className={cn('absolute left-0 right-0 text-center', chromeClass)}
        style={{ bottom: 'calc(1.5rem + var(--mobile-safe-area-bottom, 0px))' }}
      >
        {isTouchPrimary ? (
          mode !== 'idle' && !pauseLocked && (
            <p className="text-muted-foreground/60 text-xs">
              {t('pomodoro.immersive.tapToPause', '轻触屏幕暂停 / 恢复')}
            </p>
          )
        ) : (
          <p className="text-muted-foreground/60 text-xs">
            {t('pomodoro.immersive.hintEscPrefix')}
            <kbd className="px-1.5 py-0.5 bg-muted rounded text-muted-foreground text-[10px] font-mono">ESC</kbd>
            {t('pomodoro.immersive.hintEscSuffix')}
            {!pauseLocked && (
              <>
                {' '}·{' '}
                {t('pomodoro.immersive.hintSpacePrefix')}
                <kbd className="px-1.5 py-0.5 bg-muted rounded text-muted-foreground text-[10px] font-mono">Space</kbd>
                {t('pomodoro.immersive.hintSpaceSuffix')}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
};
