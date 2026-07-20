import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Square, Coffee, Brain, ArrowsOut, PictureInPicture, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { usePomodoroStore } from '../stores/usePomodoroStore';
import { useViewStore } from '@/stores/viewStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { ImmersiveFocusMode } from './ImmersiveFocusMode';
import {
  openPomodoroMiniWindow,
  closePomodoroMiniWindow,
  broadcastPomodoroState,
  EVT_MINI_COMMAND,
  EVT_MINI_READY,
  type PomodoroMiniCommand,
} from '../miniWindow';

/**
 * GlobalPomodoroWidget
 *
 * 职责：
 * 1. 全局 tick 驱动（唯一的 setInterval 来源）
 * 2. 沉浸式专注模式渲染
 * 3. 离开 Todo 页面时的悬浮药丸（仅在有活跃会话时显示）
 *
 * 空闲态不显示任何浮动 UI——番茄钟主入口在 Todo 页面内的 PomodoroPanel。
 *
 * 药丸交互（桌面）：默认紧凑（环形微进度 + 倒计时），hover / 键盘聚焦时
 * 展开任务名与快捷控制；点击药丸主体进入沉浸模式。
 * 触屏保持原有"收起/展开"开关（无 hover 语义）。
 */

/** 当前阶段进度 0–1（正计时相对设定工作时长封顶） */
const phaseProgress = (
  mode: string,
  timeLeft: number,
  countUp: boolean,
  settings: { workDuration: number; shortBreak: number; longBreak: number },
): number => {
  if (mode === 'idle') return 0;
  const total =
    mode === 'work' ? settings.workDuration
      : mode === 'short_break' ? settings.shortBreak
        : settings.longBreak;
  if (total <= 0) return 0;
  const raw = mode === 'work' && countUp ? timeLeft / total : 1 - timeLeft / total;
  return Math.min(1, Math.max(0, raw));
};

/** 环形微进度（包裹模式图标） */
const MicroRing: React.FC<{ progress: number; children: React.ReactNode }> = ({ progress, children }) => {
  const size = 26;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  return (
    <span className="relative flex h-[26px] w-[26px] flex-shrink-0 items-center justify-center">
      <svg width={size} height={size} className="absolute inset-0 -rotate-90" aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-border"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          className="transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
        />
      </svg>
      {children}
    </span>
  );
};

export const GlobalPomodoroWidget: React.FC = () => {
  const { t } = useTranslation('todo');
  const { mode, status, timeLeft, currentTaskTitle, settings, sessionCountUp, pause, resume, stop, tick, syncWallClock, isImmersive, setImmersive } = usePomodoroStore();
  const currentView = useViewStore((s) => s.currentView);
  // P-1/P-2: 触屏上抬高药丸避开底部停靠的输入栏，并放大控制按钮触控目标
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  // 移动端可收起：小屏上完整药丸接近整屏宽，收起后只留图标+倒计时，减少对底部内容的遮挡
  const [collapsed, setCollapsed] = useState(false);
  // 桌面 hover/聚焦展开（任务名 + 快捷控制）
  const [hovered, setHovered] = useState(false);

  // 启动时墙钟矫正：恢复持久化的进行中会话（重启期间计时照常流逝，
  // 已超时的阶段会被立即按完成处理）
  useEffect(() => {
    syncWallClock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 全局唯一 tick 驱动（tick 内部以 phaseEndsAt 墙钟为准，
  // 定时器被后台节流也不会让计时变慢——恢复前台后一次 tick 即矫正）
  useEffect(() => {
    let intervalId: number;
    if (status === 'running') {
      intervalId = window.setInterval(() => tick(), 1000);
    }
    return () => { if (intervalId) window.clearInterval(intervalId); };
  }, [status, tick]);

  // 窗口重新可见 / 聚焦 / 系统唤醒后立即矫正剩余时间
  useEffect(() => {
    const handleSync = () => syncWallClock();
    document.addEventListener('visibilitychange', handleSync);
    window.addEventListener('focus', handleSync);
    return () => {
      document.removeEventListener('visibilitychange', handleSync);
      window.removeEventListener('focus', handleSync);
    };
  }, [syncWallClock]);

  // ★ 3.2 置顶小窗：状态广播（每次 tick / 状态变化时同步给小窗；
  // progress / countUp 为向后兼容的可选扩展字段）
  useEffect(() => {
    broadcastPomodoroState({
      mode,
      status,
      timeLeft,
      taskTitle: currentTaskTitle,
      strictMode: settings.strictMode,
      progress: phaseProgress(mode, timeLeft, sessionCountUp, settings),
      countUp: sessionCountUp,
    });
  }, [mode, status, timeLeft, currentTaskTitle, settings, sessionCountUp]);

  // ★ 3.2 置顶小窗：监听小窗命令 + ready 请求；停止时收回小窗
  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<PomodoroMiniCommand>(EVT_MINI_COMMAND, (event) => {
        const { pause: doPause, resume: doResume, stop: doStop, completeCurrentSession } = usePomodoroStore.getState();
        switch (event.payload.action) {
          case 'pause': doPause(); break;
          case 'resume': doResume(); break;
          case 'stop': doStop(true); break;
          case 'finish': completeCurrentSession(); break;
        }
      }).then((fn) => { if (disposed) fn(); else unlisteners.push(fn); });

      listen(EVT_MINI_READY, () => {
        const s = usePomodoroStore.getState();
        broadcastPomodoroState({
          mode: s.mode,
          status: s.status,
          timeLeft: s.timeLeft,
          taskTitle: s.currentTaskTitle,
          strictMode: s.settings.strictMode,
          progress: phaseProgress(s.mode, s.timeLeft, s.sessionCountUp, s.settings),
          countUp: s.sessionCountUp,
        });
      }).then((fn) => { if (disposed) fn(); else unlisteners.push(fn); });
    });

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // 番茄停止后小窗失去意义，主动收回
  useEffect(() => {
    if (mode === 'idle') {
      void closePomodoroMiniWindow();
    }
  }, [mode]);

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

  const progress = phaseProgress(mode, timeLeft, sessionCountUp, settings);

  // 阶段语义色（与沉浸模式一致：work = primary，short_break = success，long_break = info）
  const modeColorClass =
    mode === 'work' ? 'text-primary' : mode === 'short_break' ? 'text-success' : 'text-info';

  const getModeIcon = () => {
    switch (mode) {
      case 'work': return <Brain size={14} className={modeColorClass} />;
      case 'short_break': return <Coffee size={14} className={modeColorClass} />;
      case 'long_break': return <Coffee size={14} className={modeColorClass} />;
      default: return null;
    }
  };

  const handleTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === 'running') pause(); else resume();
  };

  const handlePopOut = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const ok = await openPomodoroMiniWindow();
    if (!ok) {
      showGlobalNotification(
        'error',
        t('pomodoro.miniWindow.openFailed', { defaultValue: '置顶小窗打开失败，请重试' }),
      );
    }
  };

  // 悬浮药丸：仅在有活跃会话 + 不在 Todo 页面时显示
  const controlButtonClass = isTouchPrimary
    ? 'flex h-10 w-10 items-center justify-center rounded-full transition-colors motion-reduce:transition-none'
    : 'p-1.5 rounded-full transition-colors motion-reduce:transition-none';
  const controlIconSize = isTouchPrimary ? 16 : 14;

  const showCollapsedPill = isTouchPrimary && collapsed;
  // 触屏：沿用收起/展开开关；桌面：hover / 键盘聚焦时展开
  const expanded = isTouchPrimary ? !collapsed : hovered;

  return (
    <div
      className={cn(
        'fixed right-6 z-50 bg-background border border-border shadow-xl rounded-full flex items-center gap-2 px-3 cursor-default ui-rise-in',
        isTouchPrimary ? 'h-14 max-w-[calc(100vw-3rem)]' : 'h-12',
        expanded && !showCollapsedPill && 'pr-2',
        showCollapsedPill && 'gap-2 px-3'
      )}
      style={{
        // 触屏上避开底部停靠的聊天输入栏（约 88px）+ 安全区
        // （Android env() 不可靠，统一走 --android-safe-area-bottom 兜底，SA-1 注入真实值）
        bottom: isTouchPrimary
          ? 'calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 96px)'
          : '1.5rem',
      }}
      onMouseEnter={isTouchPrimary ? undefined : () => setHovered(true)}
      onMouseLeave={isTouchPrimary ? undefined : () => setHovered(false)}
      onFocus={isTouchPrimary ? undefined : () => setHovered(true)}
      onBlur={
        isTouchPrimary
          ? undefined
          : (e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHovered(false);
          }
      }
    >
      {/* 触屏：收起/展开开关（左端，44px 高触控带） */}
      {isTouchPrimary && (
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="-mx-2 flex h-11 w-8 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground"
          title={collapsed ? t('common:actions.expand') : t('common:actions.collapse')}
          aria-label={collapsed ? t('common:actions.expand') : t('common:actions.collapse')}
          aria-expanded={!collapsed}
        >
          {collapsed ? <CaretLeft size={14} /> : <CaretRight size={14} />}
        </button>
      )}

      {/* 药丸主体：环形微进度 + 倒计时（+ 展开时任务名）；点击进入沉浸模式 */}
      <button
        onClick={() => setImmersive(true)}
        className="flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-1 text-left"
        title={t('pomodoro.controls.enterImmersive')}
        aria-label={t('pomodoro.controls.enterImmersive')}
      >
        <span className={modeColorClass}>
          <MicroRing progress={progress}>{getModeIcon()}</MicroRing>
        </span>
        <span className="font-mono font-medium tabular-nums tracking-wider text-sm text-foreground flex-shrink-0">
          {formatTime(timeLeft)}
        </span>
        {currentTaskTitle && expanded && !showCollapsedPill && (
          <span className="text-xs text-muted-foreground truncate min-w-0 max-w-[120px] ui-rise-in" title={currentTaskTitle}>
            {currentTaskTitle}
          </span>
        )}
      </button>

      {expanded && !showCollapsedPill && (
        <div className="flex items-center gap-1 flex-shrink-0 ui-rise-in">
          {/* 严格模式专注中不显示暂停（store 同样拦截） */}
          {!(settings.strictMode && mode === 'work' && status === 'running') && (
            <button
              onClick={handleTogglePlay}
              className={cn(controlButtonClass, 'hover:bg-[var(--interactive-hover)]')}
              title={status === 'running' ? t('pomodoro.controls.pause') : t('pomodoro.controls.resume')}
              aria-label={status === 'running' ? t('pomodoro.controls.pause') : t('pomodoro.controls.resume')}
            >
              {status === 'running' ? <Pause size={controlIconSize} /> : <Play size={controlIconSize} />}
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); stop(true); }}
            className={cn(controlButtonClass, 'hover:bg-destructive/10 text-muted-foreground hover:text-destructive')}
            title={t('pomodoro.controls.stop')}
            aria-label={t('pomodoro.controls.stop')}
          >
            <Square size={controlIconSize} />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setImmersive(true); }}
            className={cn(controlButtonClass, 'hover:bg-[var(--interactive-hover)] text-muted-foreground hover:text-foreground')}
            title={t('pomodoro.controls.immersive')}
            aria-label={t('pomodoro.controls.immersive')}
          >
            <ArrowsOut size={controlIconSize} />
          </button>
          {/* ★ 3.2 弹出置顶小窗（仅桌面端） */}
          {!isTouchPrimary && (window as any).__TAURI_INTERNALS__ && (
            <button
              onClick={(e) => { void handlePopOut(e); }}
              className={cn(controlButtonClass, 'hover:bg-[var(--interactive-hover)] text-muted-foreground hover:text-foreground')}
              title={t('pomodoro.controls.popOut')}
              aria-label={t('pomodoro.controls.popOut')}
            >
              <PictureInPicture size={controlIconSize} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
