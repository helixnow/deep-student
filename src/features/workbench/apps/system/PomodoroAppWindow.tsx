/**
 * 番茄钟应用窗口（P9 薄包装 → O18 投射窗打磨 → 控制坞自绘改版 → 视图内联化）
 *
 * 投射目标：专注开始 → 投射源自动开窗，结束 → 关闭；也可从 Dock 手动打开。
 *
 * 布局（自上而下）：
 * - Hero 计时盘：SVG 进度环（模式语义色：专注=primary、短休=success、
 *   长休=info，与沉浸模式/全局药丸同映射）+ 大字等宽计时 + 模式/暂停/严格徽章 +
 *   任务徽章 + 长休息周期圆点 + 运行呼吸光晕（opacity/transform，
 *   reduced-motion / minimal 档静态化，isVisible=false 或拖窗降频时挂起动画）+
 *   完成瞬间的一次性环闪光；
 * - 今日条：数字展示区（不可点）+ 独立「统计」按钮 → 统计视图；含 streak 展示；
 * - 控制坞：自绘传输控制（开始/暂停/继续/停止/完成/跳过休息）+
 *   环境音/沉浸模式/设置入口，环境音与跳过休息全部收敛到 store action；
 * - 设置/统计：窗内同层视图切换（非模态——主视图与子视图同为窗体子层，
 *   transform/opacity 过渡，Esc/返回键退回主视图，焦点进出管理保留）。
 *
 * 计时数据全部来自 usePomodoroStore（tick 由全局 GlobalPomodoroWidget 驱动）；
 * 进度环的 stroke-dashoffset 以 1s linear 过渡衔接秒级更新（与 legacy
 * 进度条 width 过渡同策略，属状态过渡而非装饰动画——报 O20 备案）。
 *
 * 窗口标题带模式语义（「专注中 · 写论文」），Dock 弹层/切换器一眼可读；
 * 仅在模式/任务变化时更新，不做每秒标题刷新（避免 store 高频写）。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsOut,
  Brain,
  CaretLeft,
  ChartLineUp,
  CheckCircle,
  Coffee,
  Flame,
  GearSix,
  Pause,
  Play,
  ShieldCheck,
  SkipForward,
  SpeakerHigh,
  SpeakerSlash,
  Square,
  Timer,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import { getPomodoroTodayStats, type PomodoroTodayStats } from '@/features/pomodoro/api';
import { PomodoroStatsContent } from '@/features/pomodoro/components/PomodoroStatsPopover';
import type { AppWindowProps } from '../../core/types';
import { useWbSysSize } from './useWbSysSize';
import { PomodoroWindowSettings } from './PomodoroWindowSettings';
import './PomodoroAppWindow.css';

/** 进度环几何（viewBox 220 固定，显示尺寸由 CSS 缩放） */
const DIAL_SIZE = 220;
const DIAL_RADIUS = 100;
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;

/** 子视图退场过渡时长（与 CSS 的 320ms 过渡对齐，留 40ms 余量再卸载） */
const VIEW_EXIT_MS = 360;

/** 完成闪光动画时长（与 CSS keyframes 对齐） */
const FLASH_MS = 720;

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ============================================================================
// 窗内子视图（设置 / 统计共用壳）——同层视图切换，非模态
// ============================================================================

const PomoSubView: React.FC<{
  title: string;
  /** 是否处于前台；false 时保持挂载走退场过渡，由父级延迟卸载 */
  active: boolean;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ title, active, onClose, children }) => {
  const { t } = useTranslation('common');
  const panelRef = useRef<HTMLDivElement>(null);

  // 切入即聚焦面板；退回主视图时焦点由父级还给触发钮
  useEffect(() => {
    if (active) panelRef.current?.focus();
  }, [active]);

  // Esc 退回主视图（capture：先于 workbench 全局快捷键消费）
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active, onClose]);

  return (
    <div
      ref={panelRef}
      className="wb-sys-pomo-view-sub"
      role="region"
      aria-label={title}
      aria-hidden={active ? undefined : true}
      tabIndex={-1}
      data-active={active ? 'true' : 'false'}
    >
      <div className="wb-sys-pomo-view-head">
        <button
          type="button"
          className="wb-sys-pomo-view-back"
          onClick={onClose}
          aria-label={t('back')}
          title={t('back')}
        >
          <CaretLeft size={14} weight="bold" aria-hidden />
        </button>
        <span className="wb-sys-pomo-view-title">{title}</span>
      </div>
      <div className="wb-sys-pomo-view-body">{children}</div>
    </div>
  );
};

type SubViewKind = 'settings' | 'stats';
type PomoView = 'main' | SubViewKind;

// ============================================================================
// 窗口主体
// ============================================================================

const PomodoroAppWindow: React.FC<AppWindowProps> = ({
  onTitleChange,
  isVisible,
  renderThrottleMs = 0,
}) => {
  // 窗口 chrome 文案全部走 workbench 命名空间（与 todo ns 的对应键保持镜像），
  // 避免窗口层依赖 legacy Todo 页的翻译资源
  const { t } = useTranslation('workbench');
  const { ref } = useWbSysSize();

  const mode = usePomodoroStore((s) => s.mode);
  const status = usePomodoroStore((s) => s.status);
  const timeLeft = usePomodoroStore((s) => s.timeLeft);
  const sessionCountUp = usePomodoroStore((s) => s.sessionCountUp);
  const phaseExtraSeconds = usePomodoroStore((s) => s.phaseExtraSeconds);
  const settings = usePomodoroStore((s) => s.settings);
  const currentTaskTitle = usePomodoroStore((s) => s.currentTaskTitle);
  const completedPomodorosToday = usePomodoroStore((s) => s.completedPomodorosToday);
  const streakDays = usePomodoroStore((s) => s.streakDays);
  const noiseEnabled = usePomodoroStore((s) => s.noiseEnabled);
  const setNoiseEnabled = usePomodoroStore((s) => s.setNoiseEnabled);
  const start = usePomodoroStore((s) => s.start);
  const pause = usePomodoroStore((s) => s.pause);
  const resume = usePomodoroStore((s) => s.resume);
  const stop = usePomodoroStore((s) => s.stop);
  const skipBreak = usePomodoroStore((s) => s.skipBreak);
  const extendPhase = usePomodoroStore((s) => s.extendPhase);
  const completeCurrentSession = usePomodoroStore((s) => s.completeCurrentSession);
  const setImmersive = usePomodoroStore((s) => s.setImmersive);

  // 视图切换：view 为目标视图；renderedSub 让子视图在退场过渡期间保持挂载
  const [view, setView] = useState<PomoView>('main');
  const [renderedSub, setRenderedSub] = useState<SubViewKind | null>(null);
  const [todayStats, setTodayStats] = useState<PomodoroTodayStats | null>(null);
  const [flash, setFlash] = useState(false);
  // 放弃确认（内联二次确认，非弹窗）：专注中断会记 interrupted，误触成本高
  const [confirmingStop, setConfirmingStop] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const statsBtnRef = useRef<HTMLButtonElement>(null);
  const lastViewRef = useRef<PomoView>('main');
  const prevCompletedRef = useRef(completedPomodorosToday);

  const openSubView = useCallback((kind: SubViewKind) => {
    setRenderedSub(kind);
    setView(kind);
  }, []);

  const closeSubView = useCallback(() => {
    setView('main');
  }, []);

  // 子视图退场过渡结束后卸载（reduced-motion 下过渡为 0ms，延迟卸载无副作用）
  useEffect(() => {
    if (view !== 'main' || !renderedSub) return;
    const timer = setTimeout(() => setRenderedSub(null), VIEW_EXIT_MS);
    return () => clearTimeout(timer);
  }, [view, renderedSub]);

  // 退回主视图后把焦点还给触发入口
  useEffect(() => {
    const last = lastViewRef.current;
    lastViewRef.current = view;
    if (view !== 'main') return;
    if (last === 'settings') settingsBtnRef.current?.focus();
    else if (last === 'stats') statsBtnRef.current?.focus();
  }, [view]);

  // 今日统计：完成数变化 / 阶段切换（含中断停止）时刷新
  useEffect(() => {
    getPomodoroTodayStats().then(setTodayStats).catch(() => {});
  }, [completedPomodorosToday, mode]);

  // 完成瞬间：进度环一次性闪光（仅计数上升时触发，日切归零不闪）
  useEffect(() => {
    const prev = prevCompletedRef.current;
    prevCompletedRef.current = completedPomodorosToday;
    if (completedPomodorosToday <= prev) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), FLASH_MS);
    return () => clearTimeout(timer);
  }, [completedPomodorosToday]);

  const modeLabel = (() => {
    switch (mode) {
      case 'work':
        return t('pomodoro.modes.focusing');
      case 'short_break':
        return t('pomodoro.modes.shortBreak');
      case 'long_break':
        return t('pomodoro.modes.longBreak');
      default:
        return t('pomodoro.modes.idle');
    }
  })();

  // 标题：运行中带模式语义；仅模式/任务变化触发（无每秒写）
  useEffect(() => {
    const appName = t('apps.pomodoro');
    if (mode === 'idle') {
      onTitleChange(appName);
    } else {
      onTitleChange(`${modeLabel} · ${currentTaskTitle || appName}`);
    }
  }, [onTitleChange, t, mode, modeLabel, currentTaskTitle]);

  // 正计时专注：以会话锁定的 sessionCountUp 为准（null = 无进行中的会话，回退设置）
  const isCountUpWork = mode === 'work' && (sessionCountUp ?? settings.countUp);

  const totalDuration = (() => {
    const base = (() => {
      switch (mode) {
        case 'short_break':
          return settings.shortBreak;
        case 'long_break':
          return settings.longBreak;
        default:
          return settings.workDuration;
      }
    })();
    // 倒计时阶段的计划总时长含 extendPhase 加时（进度环分母同步伸长）
    return mode !== 'idle' && !isCountUpWork ? base + phaseExtraSeconds : base;
  })();

  const progress =
    mode === 'idle'
      ? 0
      : isCountUpWork
        ? Math.min(1, timeLeft / totalDuration)
        : Math.max(0, Math.min(1, 1 - timeLeft / totalDuration));

  const dashOffset = DIAL_CIRCUMFERENCE * (1 - progress);

  const isRunning = mode !== 'idle' && status === 'running';
  const isPaused = mode !== 'idle' && status === 'paused';
  const strictLocked = settings.strictMode && mode === 'work' && isRunning;

  // ---- 控制行为（与 legacy PomodoroPanel 一致） ----

  const handleTogglePlay = useCallback(() => {
    if (mode === 'idle') {
      start();
    } else if (status === 'running') {
      pause();
    } else {
      resume();
    }
  }, [mode, status, start, pause, resume]);

  // 环境音开关收敛到 store（noiseEnabled/setNoiseEnabled 内部驱动 noiseEngine）
  const toggleNoise = useCallback(() => {
    setNoiseEnabled(!noiseEnabled);
  }, [noiseEnabled, setNoiseEnabled]);

  const cancelStopConfirm = useCallback(() => {
    if (confirmTimerRef.current != null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmingStop(false);
  }, []);

  // 停止：专注阶段先进入内联确认态（4s 超时自动回退），休息阶段直接停（无记录损失）
  const handleStop = useCallback(() => {
    if (mode === 'work' && !confirmingStop) {
      setConfirmingStop(true);
      if (confirmTimerRef.current != null) window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = window.setTimeout(() => {
        confirmTimerRef.current = null;
        setConfirmingStop(false);
      }, 4000);
      return;
    }
    cancelStopConfirm();
    stop(true);
  }, [mode, confirmingStop, cancelStopConfirm, stop]);

  // 阶段切换（含自然完成）后残留的确认态失效；卸载时清掉回退定时器
  useEffect(() => {
    cancelStopConfirm();
    return () => {
      if (confirmTimerRef.current != null) window.clearTimeout(confirmTimerRef.current);
    };
  }, [mode, cancelStopConfirm]);

  // ---- 今日条数据（后端统计优先，store 计数兜底） ----

  const todayCount = todayStats?.completedCount ?? completedPomodorosToday;
  const goalReached = settings.dailyGoal > 0 && todayCount >= settings.dailyGoal;
  const focusSeconds = todayStats?.totalFocusSeconds ?? 0;
  const interruptedCount = todayStats?.interruptedCount ?? 0;
  const focusLabel = (() => {
    const m = Math.round(focusSeconds / 60);
    return m < 60
      ? t('pomodoro.today.minutes', { value: m })
      : t('pomodoro.today.hours', { value: (m / 60).toFixed(1) });
  })();

  // ---- 长休息周期圆点 ----
  //
  // 周期位置以 store 的 completedPomodorosToday 推导——store 用同一计数决定
  // 长休触发（newCount % longBreakInterval === 0 → long_break），二者天然同步；
  // 不用后端 todayStats.completedCount（含口径差异，会与长休节奏漂移）。
  // - work / short_break / idle：count % interval = 本轮已完成的番茄数；
  // - long_break：count % interval 刚归零，语义上是「整轮完成」→ 圆点全满；
  // - 中断（stop(true)）不推进计数，圆点原地不动，与长休节奏一致。
  const cycleLength = settings.longBreakInterval;
  const cycleDone =
    mode === 'long_break' ? cycleLength : completedPomodorosToday % cycleLength;

  const modeIcon =
    mode === 'work' ? (
      <Brain size={13} weight="fill" aria-hidden />
    ) : mode === 'short_break' || mode === 'long_break' ? (
      <Coffee size={13} weight="fill" aria-hidden />
    ) : (
      <Timer size={13} weight="fill" aria-hidden />
    );

  return (
    <div
      ref={ref}
      className="wb-sys-pomo flex h-full w-full min-w-0 flex-col overflow-hidden"
      data-wb-sys-app="pomodoro"
      data-mode={mode}
      data-status={mode === 'idle' ? 'idle' : status}
      data-anim={isRunning && isVisible && renderThrottleMs <= 0 ? 'on' : 'off'}
      data-view={view}
      data-flash={flash ? 'true' : undefined}
    >
      {/* ==== 主视图（Hero + 控制坞）==== */}
      <div className="wb-sys-pomo-view-main" aria-hidden={view !== 'main' ? true : undefined}>
        {/* ==== Hero 计时盘（data-agent-entity：agent 控制成功后的实体级 flash 锚点） ==== */}
        <div
          className="wb-sys-pomo-hero"
          role="timer"
          aria-label={`${modeLabel} ${formatClock(timeLeft)}`}
          data-agent-entity="pomodoro:timer"
        >
          <div className="wb-sys-pomo-badges">
            <span className="wb-sys-pomo-chip wb-sys-pomo-chip-mode">
              {modeIcon}
              {modeLabel}
            </span>
            {isPaused && (
              <span className="wb-sys-pomo-chip wb-sys-pomo-chip-paused">
                <Pause size={12} weight="fill" aria-hidden />
                {t('apps.system.paused')}
              </span>
            )}
            {strictLocked && (
              <span
                className="wb-sys-pomo-chip wb-sys-pomo-chip-strict"
                title={t('pomodoro.strictHint')}
              >
                <ShieldCheck size={12} weight="fill" aria-hidden />
                {t('pomodoro.strictBadge')}
              </span>
            )}
          </div>

          <div className="wb-sys-pomo-dial-wrap">
            <span className="wb-sys-pomo-glow" aria-hidden />
            <span className="wb-sys-pomo-flash" aria-hidden />
            <svg
              className="wb-sys-pomo-dial"
              viewBox={`0 0 ${DIAL_SIZE} ${DIAL_SIZE}`}
              aria-hidden
              focusable="false"
            >
              <circle
                className="wb-sys-pomo-track"
                cx={DIAL_SIZE / 2}
                cy={DIAL_SIZE / 2}
                r={DIAL_RADIUS}
              />
              {/* key=mode：切阶段时重挂载，避免 dashoffset 跨模式反向长扫 */}
              <circle
                key={mode}
                className="wb-sys-pomo-progress"
                cx={DIAL_SIZE / 2}
                cy={DIAL_SIZE / 2}
                r={DIAL_RADIUS}
                strokeDasharray={DIAL_CIRCUMFERENCE}
                strokeDashoffset={dashOffset}
              />
            </svg>
            <div className="wb-sys-pomo-readout">
              <span className="wb-sys-pomo-time" data-wb-sys-pomo-time>
                {formatClock(timeLeft)}
              </span>
              <span className="wb-sys-pomo-sub">
                {mode === 'idle'
                  ? t('apps.system.idleHint')
                  : isCountUpWork
                    ? t('pomodoro.countUpLabel')
                    : `/ ${formatClock(totalDuration)}`}
              </span>
            </div>
          </div>

          {currentTaskTitle && mode !== 'idle' && (
            <span className="wb-sys-pomo-task" title={currentTaskTitle}>
              {currentTaskTitle}
            </span>
          )}

          {/* 长休息周期圆点（间隔 >1 才有周期可言） */}
          {cycleLength > 1 && (
            <div
              className="wb-sys-pomo-cycles"
              role="img"
              aria-label={t('pomodoro.progressTitle', { done: cycleDone, total: cycleLength })}
              title={t('pomodoro.progressTitle', { done: cycleDone, total: cycleLength })}
            >
              {Array.from({ length: cycleLength }, (_, i) => (
                <span
                  key={i}
                  className="wb-sys-pomo-cycle"
                  data-filled={i < cycleDone ? 'true' : 'false'}
                  data-current={i === cycleDone && mode === 'work' ? 'true' : 'false'}
                />
              ))}
            </div>
          )}
        </div>

        {/* ==== 控制坞 ==== */}
        <div className="wb-sys-pomo-dock">
          {/* 今日条：数字展示区（不可点）+ 独立统计按钮 */}
          <div className="wb-sys-pomo-today">
            <span className="wb-sys-pomo-today-info">
              <Flame
                size={13}
                weight={goalReached ? 'fill' : 'regular'}
                className={cn(
                  'wb-sys-pomo-today-flame',
                  goalReached && 'is-goal',
                )}
                aria-hidden
              />
              <span className="wb-sys-pomo-today-text">
                {t('pomodoro.today.label')}{' '}
                <strong>
                  {todayCount}
                  {settings.dailyGoal > 0 && <span>/{settings.dailyGoal}</span>}
                </strong>{' '}
                {t('pomodoro.today.unit')}
              </span>
              {settings.dailyGoal > 0 && (
                <span
                  className="wb-sys-pomo-today-goalbar"
                  aria-hidden
                >
                  <span
                    className={cn('wb-sys-pomo-today-goalbar-fill', goalReached && 'is-goal')}
                    style={{
                      width: `${Math.min(100, (todayCount / settings.dailyGoal) * 100)}%`,
                    }}
                  />
                </span>
              )}
              {goalReached && (
                <span className="wb-sys-pomo-today-goal-done">
                  {t('pomodoro.today.goalReached')}
                </span>
              )}
              {streakDays >= 2 && (
                <span className="wb-sys-pomo-today-streak">
                  {t('pomodoro.today.streak', { count: streakDays })}
                </span>
              )}
              {focusSeconds > 0 && (
                <span className="wb-sys-pomo-today-meta">
                  {t('pomodoro.today.focus')} {focusLabel}
                </span>
              )}
              {interruptedCount > 0 && (
                <span className="wb-sys-pomo-today-meta is-dim">
                  {t('pomodoro.today.interrupted', { value: interruptedCount })}
                </span>
              )}
            </span>
            <button
              ref={statsBtnRef}
              type="button"
              className="wb-sys-pomo-today-stats"
              onClick={() => openSubView('stats')}
              aria-label={t('pomodoro.statsTitle')}
              title={t('pomodoro.statsTitle')}
            >
              <ChartLineUp size={13} aria-hidden />
              <span>{t('pomodoro.today.statsButton')}</span>
            </button>
          </div>

          {/* 传输控制行 */}
          <div className="wb-sys-pomo-controls">
            <div className="wb-sys-pomo-controls-side">
              <NotionButton
                ref={settingsBtnRef}
                variant="ghost"
                size="icon"
                iconOnly
                onClick={() => openSubView('settings')}
                title={t('pomodoro.settingsTitle')}
                aria-label={t('pomodoro.settingsTitle')}
                className="!h-7 !w-7 transition-colors duration-150 ease-standard"
              >
                <GearSix size={15} />
              </NotionButton>
            </div>

            <div className="wb-sys-pomo-controls-main">
              {mode !== 'idle' &&
                (confirmingStop ? (
                  <span
                    className="wb-sys-pomo-stop-confirm"
                    role="alertdialog"
                    aria-label={t('pomodoro.controls.abandonConfirm', {
                      ns: 'todo',
                      defaultValue: '放弃本次专注？',
                    })}
                  >
                    <NotionButton
                      variant="utility"
                      size="sm"
                      onClick={handleStop}
                      title={t('pomodoro.controls.abandon', { ns: 'todo', defaultValue: '放弃' })}
                      aria-label={t('pomodoro.controls.abandon', { ns: 'todo', defaultValue: '放弃' })}
                      className="h-7 !px-2.5 text-xs font-medium text-[color:hsl(var(--destructive))] transition-colors duration-150 ease-standard"
                    >
                      {t('pomodoro.controls.abandon', { ns: 'todo', defaultValue: '放弃' })}
                    </NotionButton>
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      onClick={cancelStopConfirm}
                      title={t('pomodoro.controls.keepGoing', { ns: 'todo', defaultValue: '继续专注' })}
                      aria-label={t('pomodoro.controls.keepGoing', { ns: 'todo', defaultValue: '继续专注' })}
                      className="h-7 !px-2 text-xs transition-colors duration-150 ease-standard"
                    >
                      {t('pomodoro.controls.keepGoing', { ns: 'todo', defaultValue: '继续专注' })}
                    </NotionButton>
                  </span>
                ) : (
                  <NotionButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    onClick={handleStop}
                    title={t('pomodoro.controls.stop')}
                    aria-label={t('pomodoro.controls.stop')}
                    className="!h-7 !w-7 transition-colors duration-150 ease-standard"
                  >
                    <Square size={14} />
                  </NotionButton>
                ))}

              {/* 严格模式专注中：暂停位换成严格提示（store 同样拦截，双保险） */}
              {strictLocked && !isCountUpWork ? (
                <span
                  className="wb-sys-pomo-controls-strict"
                  title={t('pomodoro.strictHint')}
                >
                  <ShieldCheck size={13} weight="fill" aria-hidden />
                  {t('pomodoro.strictBadge')}
                </span>
              ) : (
                !(strictLocked && isRunning) && (
                  <NotionButton
                    variant={isRunning ? 'utility' : 'primary'}
                    size="sm"
                    onClick={handleTogglePlay}
                    title={
                      isRunning
                        ? t('pomodoro.controls.pause')
                        : mode === 'idle'
                          ? t('pomodoro.controls.startFocus')
                          : t('pomodoro.controls.resume')
                    }
                    aria-label={
                      isRunning
                        ? t('pomodoro.controls.pause')
                        : mode === 'idle'
                          ? t('pomodoro.controls.startFocus')
                          : t('pomodoro.controls.resume')
                    }
                    className="wb-sys-pomo-play h-8 gap-1.5 !px-4 text-xs transition-colors duration-150 ease-standard"
                  >
                    {isRunning ? <Pause size={14} /> : <Play size={14} weight="fill" />}
                    <span>
                      {isRunning
                        ? t('pomodoro.controls.pause')
                        : mode === 'idle'
                          ? t('pomodoro.controls.startFocus')
                          : t('pomodoro.controls.resume')}
                    </span>
                  </NotionButton>
                )
              )}

              {/* 正计时专注中：手动「完成」收尾 */}
              {isCountUpWork && isRunning && (
                <NotionButton
                  variant="primary"
                  size="sm"
                  onClick={() => completeCurrentSession()}
                  title={t('pomodoro.controls.finish')}
                  aria-label={t('pomodoro.controls.finish')}
                  className="h-8 gap-1.5 !px-3 text-xs transition-colors duration-150 ease-standard"
                >
                  <CheckCircle size={14} />
                  <span>{t('pomodoro.controls.finish')}</span>
                </NotionButton>
              )}

              {(mode === 'short_break' || mode === 'long_break') && (
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={() => skipBreak()}
                  title={t('pomodoro.controls.skipBreak')}
                  aria-label={t('pomodoro.controls.skipBreak')}
                  className="!h-7 !w-7 transition-colors duration-150 ease-standard"
                >
                  <SkipForward size={14} />
                </NotionButton>
              )}

              {/* 延长阶段：休息中常显；专注倒计时剩余 <2min 时也给机会 */}
              {(mode === 'short_break' ||
                mode === 'long_break' ||
                (mode === 'work' && !isCountUpWork && timeLeft > 0 && timeLeft <= 120)) &&
                [1, 5].map((minutes) => (
                  <NotionButton
                    key={minutes}
                    variant="utility"
                    size="sm"
                    onClick={() => extendPhase(minutes * 60)}
                    title={t('pomodoro.controls.extendTitle', { ns: 'todo', count: minutes })}
                    aria-label={t('pomodoro.controls.extendTitle', { ns: 'todo', count: minutes })}
                    className="h-7 gap-0 !px-2 text-xs font-medium tabular-nums transition-colors duration-150 ease-standard"
                  >
                    {t('pomodoro.controls.extendMinutes', { ns: 'todo', count: minutes })}
                  </NotionButton>
                ))}
            </div>

            <div className="wb-sys-pomo-controls-side is-right">
              {mode !== 'idle' && (
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={() => setImmersive(true)}
                  title={t('pomodoro.controls.enterImmersive')}
                  aria-label={t('pomodoro.controls.enterImmersive')}
                  className="!h-7 !w-7 transition-colors duration-150 ease-standard"
                >
                  <ArrowsOut size={14} />
                </NotionButton>
              )}
              <NotionButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={toggleNoise}
                title={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
                aria-label={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
                aria-pressed={noiseEnabled}
                className={cn(
                  '!h-7 !w-7 transition-colors duration-150 ease-standard',
                  noiseEnabled && 'text-[color:hsl(var(--primary))]',
                )}
              >
                {noiseEnabled ? <SpeakerHigh size={15} /> : <SpeakerSlash size={15} />}
              </NotionButton>
            </div>
          </div>
        </div>
      </div>

      {/* ==== 子视图：设置 / 统计（同层切换，退场期间保持挂载） ==== */}
      {renderedSub && (
        <PomoSubView
          title={
            renderedSub === 'settings'
              ? t('pomodoro.settingsTitle')
              : t('pomodoro.statsTitle')
          }
          active={view === renderedSub}
          onClose={closeSubView}
        >
          {renderedSub === 'settings' ? (
            <PomodoroWindowSettings />
          ) : (
            <PomodoroStatsContent showTitle={false} />
          )}
        </PomoSubView>
      )}
    </div>
  );
};

export default PomodoroAppWindow;
