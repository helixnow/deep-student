import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Square, Coffee, Brain, ArrowsOut, PictureInPicture, CaretLeft, CaretRight } from '@phosphor-icons/react';
import { usePomodoroStore } from '../stores/usePomodoroStore';
import { useViewStore } from '@/stores/viewStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
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
 */
export const GlobalPomodoroWidget: React.FC = () => {
  const { t } = useTranslation('todo');
  const { mode, status, timeLeft, currentTaskTitle, settings, pause, resume, stop, tick, syncWallClock, isImmersive, setImmersive } = usePomodoroStore();
  const currentView = useViewStore((s) => s.currentView);
  // P-1/P-2: 触屏上抬高药丸避开底部停靠的输入栏，并放大控制按钮触控目标
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  // 移动端可收起：小屏上完整药丸接近整屏宽，收起后只留图标+倒计时，减少对底部内容的遮挡
  const [collapsed, setCollapsed] = useState(false);

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

  // ★ 3.2 置顶小窗：状态广播（每次 tick / 状态变化时同步给小窗）
  useEffect(() => {
    broadcastPomodoroState({
      mode,
      status,
      timeLeft,
      taskTitle: currentTaskTitle,
      strictMode: settings.strictMode,
    });
  }, [mode, status, timeLeft, currentTaskTitle, settings.strictMode]);

  // ★ 3.2 置顶小窗：监听小窗命令 + ready 请求；停止时收回小窗
  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).__TAURI_INTERNALS__) return;

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<PomodoroMiniCommand>(EVT_MINI_COMMAND, (event) => {
        const { pause: doPause, resume: doResume, stop: doStop } = usePomodoroStore.getState();
        switch (event.payload.action) {
          case 'pause': doPause(); break;
          case 'resume': doResume(); break;
          case 'stop': doStop(true); break;
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

  const getModeIcon = () => {
    switch (mode) {
      case 'work': return <Brain size={16} className="text-orange-500" />;
      case 'short_break': return <Coffee size={16} className="text-green-500" />;
      case 'long_break': return <Coffee size={16} className="text-blue-500" />;
      default: return null;
    }
  };

  const handleTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === 'running') pause(); else resume();
  };

  // 悬浮药丸：仅在有活跃会话 + 不在 Todo 页面时显示
  const controlButtonClass = isTouchPrimary
    ? 'flex h-10 w-10 items-center justify-center rounded-full transition-colors'
    : 'p-1.5 rounded-full transition-colors';
  const controlIconSize = isTouchPrimary ? 16 : 14;

  const showCollapsedPill = isTouchPrimary && collapsed;

  return (
    <div
      className={cn(
        'fixed right-6 z-50 bg-background border border-border shadow-xl rounded-full flex items-center gap-3 px-4 pr-2 cursor-default ui-rise-in',
        isTouchPrimary ? 'h-14 max-w-[calc(100vw-3rem)]' : 'h-12',
        showCollapsedPill && 'gap-2 px-3 pr-3'
      )}
      style={{
        // 触屏上避开底部停靠的聊天输入栏（约 88px）+ 安全区
        // （Android env() 不可靠，统一走 --android-safe-area-bottom 兜底，SA-1 注入真实值）
        bottom: isTouchPrimary
          ? 'calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + 96px)'
          : '1.5rem',
      }}
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
      {getModeIcon()}
      <span className="font-mono font-medium tracking-wider text-sm text-foreground flex-shrink-0">
        {formatTime(timeLeft)}
      </span>
      {currentTaskTitle && !showCollapsedPill && (
        <span className="text-xs text-muted-foreground truncate min-w-0 max-w-[120px]" title={currentTaskTitle}>
          {currentTaskTitle}
        </span>
      )}
      {!showCollapsedPill && (
      <div className="flex items-center gap-1 ml-1 flex-shrink-0">
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
            onClick={(e) => { e.stopPropagation(); void openPomodoroMiniWindow(); }}
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
