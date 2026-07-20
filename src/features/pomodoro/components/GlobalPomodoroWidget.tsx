import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useMotionValue, animate } from 'framer-motion';
import { Pause, Play, Square, Coffee, Brain, ArrowsOut, PictureInPicture, CaretLeft, CaretRight, SkipForward } from '@phosphor-icons/react';
import { usePomodoroStore } from '../stores/usePomodoroStore';
import { useViewStore } from '@/stores/viewStore';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { springSoft, tweenFast, motionSafe } from '@/styles/motion-springs';
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
 * 2. 沉浸式专注模式渲染（AnimatePresence 转场）
 * 3. 离开 Todo 页面时的悬浮药丸（仅在有活跃会话时显示）
 *
 * 空闲态不显示任何浮动 UI——番茄钟主入口在 Todo 页面内的 PomodoroPanel。
 *
 * 药丸交互（桌面）：
 * - 默认紧凑（环形微进度 + 倒计时），hover / 键盘聚焦时横向展开任务名与快捷控制
 *   （grid-template-columns 0fr→1fr，与 InlineReveal 同一质感）
 * - 可拖拽重新定位：松手后左右边缘吸附 + 垂直方向收回视口（springSoft 轻惯性）
 * - 专注进行中点「放弃」需内联二次确认（3s 后自动还原），防误触
 * - 休息阶段展开区提供「跳过休息」
 * - 点击药丸主体进入沉浸模式
 * 触屏保持原有"收起/展开"开关（无 hover 语义，不可拖拽）。
 */

/** 当前阶段进度 0–1（正计时相对设定工作时长封顶；extraSeconds = extendPhase 累计加时） */
const phaseProgress = (
  mode: string,
  timeLeft: number,
  countUp: boolean,
  settings: { workDuration: number; shortBreak: number; longBreak: number },
  extraSeconds = 0,
): number => {
  if (mode === 'idle') return 0;
  const base =
    mode === 'work' ? settings.workDuration
      : mode === 'short_break' ? settings.shortBreak
        : settings.longBreak;
  // 正计时无目标时长，加时不参与分母
  const total = mode === 'work' && countUp ? base : base + Math.max(0, extraSeconds);
  if (total <= 0) return 0;
  const raw = mode === 'work' && countUp ? timeLeft / total : 1 - timeLeft / total;
  return Math.min(1, Math.max(0, raw));
};

/** 拖拽偏移在组件卸载/重挂（切页）间保留（会话级，不持久化） */
const pillOffset = { x: 0, y: 0 };

/** 视口边距（拖拽吸附/收回目标） */
const PILL_MARGIN = 24;

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

/** 横向内联展开容器（InlineReveal 的水平版：grid-cols [0fr]→[1fr]）。
 *  用 span 承载以便合法嵌入 <button>（display 由 grid/flex 类接管）。 */
const InlineRevealX: React.FC<{ open: boolean; children: React.ReactNode; className?: string }> = ({
  open,
  children,
  className,
}) => (
  <span
    aria-hidden={!open}
    className={cn(
      'grid transition-[grid-template-columns,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
      open ? 'grid-cols-[1fr] opacity-100' : 'pointer-events-none grid-cols-[0fr] opacity-0',
      className,
    )}
  >
    <span className="flex min-w-0 items-center overflow-hidden">{children}</span>
  </span>
);

export const GlobalPomodoroWidget: React.FC = () => {
  const { t } = useTranslation('todo');
  const { mode, status, timeLeft, currentTaskTitle, settings, sessionCountUp, phaseExtraSeconds, pause, resume, stop, skipBreak, tick, syncWallClock, isImmersive, setImmersive } = usePomodoroStore();
  const currentView = useViewStore((s) => s.currentView);
  // P-1/P-2: 触屏上抬高药丸避开底部停靠的输入栏，并放大控制按钮触控目标
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  // 移动端可收起：小屏上完整药丸接近整屏宽，收起后只留图标+倒计时，减少对底部内容的遮挡
  const [collapsed, setCollapsed] = useState(false);
  // 桌面 hover/聚焦展开（任务名 + 快捷控制）
  const [hovered, setHovered] = useState(false);
  // 放弃专注的内联二次确认（3s 无操作自动还原）
  const [confirmAbandon, setConfirmAbandon] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);

  // 拖拽定位：偏移量挂在 motion value 上，松手吸附边缘
  const x = useMotionValue(pillOffset.x);
  const y = useMotionValue(pillOffset.y);
  const pillRef = useRef<HTMLDivElement>(null);
  // 拖拽后抑制紧随而来的 click（避免拖完误触发按钮/进入沉浸）
  const dragMovedRef = useRef(false);

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
  // 会话锁定的计时模式优先；旧持久化会话无该字段时回退设置
  //（与 PomodoroPanel / ImmersiveFocusMode / PomodoroAppWindow 同口径）
  const countUpWork = sessionCountUp ?? settings.countUp;

  useEffect(() => {
    broadcastPomodoroState({
      mode,
      status,
      timeLeft,
      taskTitle: currentTaskTitle,
      strictMode: settings.strictMode,
      progress: phaseProgress(mode, timeLeft, countUpWork, settings, phaseExtraSeconds),
      countUp: countUpWork,
    });
  }, [mode, status, timeLeft, currentTaskTitle, settings, countUpWork, phaseExtraSeconds]);

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
        const cu = s.sessionCountUp ?? s.settings.countUp;
        broadcastPomodoroState({
          mode: s.mode,
          status: s.status,
          timeLeft: s.timeLeft,
          taskTitle: s.currentTaskTitle,
          strictMode: s.settings.strictMode,
          progress: phaseProgress(s.mode, s.timeLeft, cu, s.settings, s.phaseExtraSeconds),
          countUp: cu,
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

  // 二次确认定时器清理
  useEffect(() => {
    return () => {
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
    };
  }, []);

  // 视口尺寸变化时把药丸收回可视范围（避免吸附偏移悬在窗外）
  const clampIntoViewport = useCallback((snapX: boolean) => {
    const el = pillRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let targetLeft = rect.left;
    if (snapX) {
      // 左右边缘吸附：按药丸中心决定归属侧
      const snapLeft = rect.left + rect.width / 2 < vw / 2;
      targetLeft = snapLeft ? PILL_MARGIN : vw - PILL_MARGIN - rect.width;
    } else {
      targetLeft = Math.min(Math.max(rect.left, PILL_MARGIN), vw - PILL_MARGIN - rect.width);
    }
    const targetTop = Math.min(Math.max(rect.top, PILL_MARGIN), vh - PILL_MARGIN - rect.height);

    const targetX = x.get() + (targetLeft - rect.left);
    const targetY = y.get() + (targetTop - rect.top);
    if (targetX !== x.get()) animate(x, targetX, motionSafe(springSoft));
    if (targetY !== y.get()) animate(y, targetY, motionSafe(springSoft));
    pillOffset.x = targetX;
    pillOffset.y = targetY;
  }, [x, y]);

  useEffect(() => {
    if (isTouchPrimary) return;
    const onResize = () => clampIntoViewport(false);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isTouchPrimary, clampIntoViewport]);

  // 药丸右锚定，hover 展开向左增宽：吸附在左缘时展开可能探出视口，
  // 等展开过渡（200ms）走完后轻推回可视范围
  const hoveredForClamp = !isTouchPrimary && hovered;
  useEffect(() => {
    if (!hoveredForClamp) return;
    const id = window.setTimeout(() => clampIntoViewport(false), 230);
    return () => window.clearTimeout(id);
  }, [hoveredForClamp, clampIntoViewport]);

  const handleDragStart = useCallback(() => {
    dragMovedRef.current = true;
  }, []);

  const handleDragEnd = useCallback(() => {
    clampIntoViewport(true);
    // 拖拽结束的同一轮事件里可能派发 click，下一帧再解除抑制
    window.setTimeout(() => { dragMovedRef.current = false; }, 0);
  }, [clampIntoViewport]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const progress = phaseProgress(mode, timeLeft, countUpWork, settings, phaseExtraSeconds);

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

  const resetConfirmAbandon = useCallback(() => {
    if (confirmTimerRef.current) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmAbandon(false);
  }, []);

  const handleTogglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dragMovedRef.current) return;
    if (status === 'running') pause(); else resume();
  };

  const handleStop = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dragMovedRef.current) return;
    // 专注阶段放弃（含暂停中）= 这一段专注记为 interrupted，误触成本高，
    // 需要内联二次确认（与 PomodoroPanel / PomodoroAppWindow 同口径）；休息阶段停止无损，直接停
    if (mode === 'work' && !confirmAbandon) {
      setConfirmAbandon(true);
      if (confirmTimerRef.current) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => setConfirmAbandon(false), 3000);
      return;
    }
    resetConfirmAbandon();
    stop(true);
  };

  const handleSkipBreak = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dragMovedRef.current) return;
    skipBreak();
  };

  const handleEnterImmersive = () => {
    if (dragMovedRef.current) return;
    setImmersive(true);
  };

  const handlePopOut = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (dragMovedRef.current) return;
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

  // 触屏：沿用收起/展开开关；桌面：hover / 键盘聚焦时展开
  const expanded = isTouchPrimary ? !collapsed : hovered;

  // 收起时顺带取消未确认的「放弃」
  useEffect(() => {
    if (!expanded) resetConfirmAbandon();
  }, [expanded, resetConfirmAbandon]);

  const showPill = !isImmersive && mode !== 'idle' && currentView !== 'todo';
  const isBreak = mode === 'short_break' || mode === 'long_break';

  return (
    <>
      <AnimatePresence>
        {isImmersive && (
          <ImmersiveFocusMode key="immersive" onClose={() => setImmersive(false)} />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showPill && (
          <motion.div
            key="pill"
            ref={pillRef}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1, transition: motionSafe(springSoft) }}
            exit={{ opacity: 0, scale: 0.9, transition: motionSafe(tweenFast) }}
            drag={!isTouchPrimary}
            dragMomentum={false}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            className={cn(
              'fixed right-6 z-50 flex items-center gap-2 rounded-full border border-border bg-background px-3 shadow-xl',
              'transition-shadow duration-200 motion-reduce:transition-none',
              isTouchPrimary ? 'h-14 max-w-[calc(100vw-3rem)]' : 'h-12 cursor-grab active:cursor-grabbing hover:shadow-2xl',
              expanded && 'pr-2',
            )}
            style={{
              x,
              y,
              // 触屏上避开底部停靠的聊天输入栏 + 安全区：输入栏实际高度由输入栏侧
              // 写入 --composer-dock-height（未写入时回退 96px），避免硬编码与实际高度脱节
              // （Android env() 不可靠，统一走 --android-safe-area-bottom 兜底，SA-1 注入真实值）
              bottom: isTouchPrimary
                ? 'calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + var(--composer-dock-height, 96px))'
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
            {/* 触屏：收起/展开开关（左端，44×44 触控带） */}
            {isTouchPrimary && (
              <button
                onClick={() => setCollapsed((v) => !v)}
                className="-mx-2 flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground"
                title={collapsed ? t('common:actions.expand') : t('common:actions.collapse')}
                aria-label={collapsed ? t('common:actions.expand') : t('common:actions.collapse')}
                aria-expanded={!collapsed}
              >
                {collapsed ? <CaretLeft size={14} /> : <CaretRight size={14} />}
              </button>
            )}

            {/* 药丸主体：环形微进度 + 倒计时（+ 展开时任务名）；点击进入沉浸模式 */}
            <button
              onClick={handleEnterImmersive}
              className="flex min-w-0 items-center gap-2.5 rounded-full py-1 pr-1 text-left"
              title={t('pomodoro.controls.enterImmersive')}
              aria-label={t('pomodoro.controls.enterImmersive')}
            >
              <span className={modeColorClass}>
                <MicroRing progress={progress}>{getModeIcon()}</MicroRing>
              </span>
              <span
                className={cn(
                  'flex-shrink-0 font-mono text-sm font-medium tabular-nums tracking-wider transition-colors duration-200 motion-reduce:transition-none',
                  status === 'running' ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {formatTime(timeLeft)}
              </span>
              {currentTaskTitle && (
                <InlineRevealX open={expanded}>
                  <span
                    className="block max-w-[140px] truncate pr-0.5 text-xs text-muted-foreground"
                    title={currentTaskTitle}
                  >
                    {currentTaskTitle}
                  </span>
                </InlineRevealX>
              )}
            </button>

            {/* 快捷控制（hover / 展开时横向滑出） */}
            <InlineRevealX open={expanded} className="flex-shrink-0">
              <span className="flex items-center gap-1">
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
                {/* 休息阶段：跳过休息 */}
                {isBreak && (
                  <button
                    onClick={handleSkipBreak}
                    className={cn(controlButtonClass, 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground')}
                    title={t('pomodoro.controls.skipBreak')}
                    aria-label={t('pomodoro.controls.skipBreak')}
                  >
                    <SkipForward size={controlIconSize} />
                  </button>
                )}
                {/* 停止/放弃：专注进行中需内联二次确认 */}
                {confirmAbandon ? (
                  <button
                    onClick={handleStop}
                    className={cn(
                      'ui-rise-in flex-shrink-0 rounded-full bg-destructive px-2.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 motion-reduce:transition-none',
                      isTouchPrimary ? 'h-10' : 'h-7',
                    )}
                    title={t('pomodoro.controls.stop')}
                    aria-label={t('pomodoro.controls.stop')}
                  >
                    {t('pomodoro.controls.abandonConfirmShort', { defaultValue: '放弃？' })}
                  </button>
                ) : (
                  <button
                    onClick={handleStop}
                    className={cn(controlButtonClass, 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive')}
                    title={t('pomodoro.controls.stop')}
                    aria-label={t('pomodoro.controls.stop')}
                  >
                    <Square size={controlIconSize} />
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); handleEnterImmersive(); }}
                  className={cn(controlButtonClass, 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground')}
                  title={t('pomodoro.controls.immersive')}
                  aria-label={t('pomodoro.controls.immersive')}
                >
                  <ArrowsOut size={controlIconSize} />
                </button>
                {/* ★ 3.2 弹出置顶小窗（仅桌面端） */}
                {!isTouchPrimary && (window as any).__TAURI_INTERNALS__ && (
                  <button
                    onClick={(e) => { void handlePopOut(e); }}
                    className={cn(controlButtonClass, 'text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground')}
                    title={t('pomodoro.controls.popOut')}
                    aria-label={t('pomodoro.controls.popOut')}
                  >
                    <PictureInPicture size={controlIconSize} />
                  </button>
                )}
              </span>
            </InlineRevealX>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
