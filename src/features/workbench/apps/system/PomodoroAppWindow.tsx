/**
 * 番茄钟应用窗口（P9 薄包装 → O18 投射窗打磨 → 控制坞自绘改版）
 *
 * 投射目标：专注开始 → 投射源自动开窗，结束 → 关闭；也可从 Dock 手动打开。
 *
 * 布局（自上而下）：
 * - Hero 计时盘：SVG 进度环（模式语义色：专注=warning、短休=success、
 *   长休=info）+ 大字等宽计时 + 模式/暂停/严格徽章 + 任务徽章 +
 *   长休息周期圆点 + 运行呼吸光晕（opacity/transform，reduced-motion /
 *   minimal 档静态化，isVisible=false 或拖窗降频时挂起动画）；
 * - 今日条：今日番茄/每日目标进度/专注时长，整行可点 → 全窗统计面板；
 * - 控制坞：自绘传输控制（开始/暂停/继续/停止/完成/跳过休息）+
 *   环境音/沉浸模式/设置入口，不再复用 legacy PomodoroPanel
 *   （其原生控件表单与本窗口视觉密度不匹配）；
 * - 设置/统计：全窗 Sheet（translate+opacity 滑入，Esc 关闭，焦点进出管理），
 *   设置项全部走设计系统控件（Slider/Switch/SegmentedControl）。
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
  CaretRight,
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
import { noiseEngine } from '@/features/pomodoro/noiseEngine';
import { PomodoroStatsContent } from '@/features/pomodoro/components/PomodoroStatsPopover';
import type { AppWindowProps } from '../../core/types';
import { useWbSysSize } from './useWbSysSize';
import { PomodoroWindowSettings } from './PomodoroWindowSettings';
import './PomodoroAppWindow.css';

/** 进度环几何（viewBox 220 固定，显示尺寸由 CSS 缩放） */
const DIAL_SIZE = 220;
const DIAL_RADIUS = 100;
const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ============================================================================
// 全窗 Sheet（设置 / 统计共用壳）
// ============================================================================

const PomoSheet: React.FC<{
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ title, onClose, children }) => {
  const { t } = useTranslation('common');
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开即聚焦面板（aria-modal 对话框契约）；关闭时焦点由父级还给触发钮
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Esc 关闭（capture：先于 workbench 全局快捷键消费）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className="wb-sys-pomo-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
      data-wb-sys-pomo-sheet
    >
      <div className="wb-sys-pomo-sheet-head">
        <button
          type="button"
          className="wb-sys-pomo-sheet-back"
          onClick={onClose}
          aria-label={t('back')}
          title={t('back')}
        >
          <CaretLeft size={14} weight="bold" aria-hidden />
        </button>
        <span className="wb-sys-pomo-sheet-title">{title}</span>
      </div>
      <div className="wb-sys-pomo-sheet-body">{children}</div>
    </div>
  );
};

type SheetKind = 'settings' | 'stats';

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
  const phaseStartedAt = usePomodoroStore((s) => s.phaseStartedAt);
  const settings = usePomodoroStore((s) => s.settings);
  const currentTaskTitle = usePomodoroStore((s) => s.currentTaskTitle);
  const completedPomodorosToday = usePomodoroStore((s) => s.completedPomodorosToday);
  const start = usePomodoroStore((s) => s.start);
  const pause = usePomodoroStore((s) => s.pause);
  const resume = usePomodoroStore((s) => s.resume);
  const stop = usePomodoroStore((s) => s.stop);
  const completeCurrentSession = usePomodoroStore((s) => s.completeCurrentSession);
  const setImmersive = usePomodoroStore((s) => s.setImmersive);

  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [todayStats, setTodayStats] = useState<PomodoroTodayStats | null>(null);
  const [noiseOn, setNoiseOn] = useState(noiseEngine.playing);
  const settingsBtnRef = useRef<HTMLButtonElement>(null);
  const statsBtnRef = useRef<HTMLButtonElement>(null);
  const lastSheetRef = useRef<SheetKind | null>(null);

  // Sheet 关闭后把焦点还给触发入口
  useEffect(() => {
    if (sheet) {
      lastSheetRef.current = sheet;
      return;
    }
    const last = lastSheetRef.current;
    lastSheetRef.current = null;
    if (last === 'settings') settingsBtnRef.current?.focus();
    else if (last === 'stats') statsBtnRef.current?.focus();
  }, [sheet]);

  // 今日统计：完成数变化 / 阶段切换（含中断停止）时刷新
  useEffect(() => {
    getPomodoroTodayStats().then(setTodayStats).catch(() => {});
  }, [completedPomodorosToday, mode]);

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
    const appName = t('workbench:apps.pomodoro');
    if (mode === 'idle') {
      onTitleChange(appName);
    } else {
      onTitleChange(`${modeLabel} · ${currentTaskTitle || appName}`);
    }
  }, [onTitleChange, t, mode, modeLabel, currentTaskTitle]);

  // 正计时专注（与 legacy PomodoroPanel 同判定）
  const isCountUpWork = mode === 'work' && (phaseStartedAt != null || settings.countUp);

  const totalDuration = (() => {
    switch (mode) {
      case 'short_break':
        return settings.shortBreak;
      case 'long_break':
        return settings.longBreak;
      default:
        return settings.workDuration;
    }
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

  const toggleNoise = useCallback(() => {
    if (noiseEngine.playing) {
      noiseEngine.stop();
      setNoiseOn(false);
    } else {
      noiseEngine.start(settings.noiseType, settings.noiseVolume);
      setNoiseOn(true);
    }
  }, [settings.noiseType, settings.noiseVolume]);

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

  const cycleLength = settings.longBreakInterval;
  const cycleDone = mode === 'long_break' ? cycleLength : todayCount % cycleLength;

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
    >
      {/* ==== Hero 计时盘 ==== */}
      <div className="wb-sys-pomo-hero" role="timer" aria-label={`${modeLabel} ${formatClock(timeLeft)}`}>
        <div className="wb-sys-pomo-badges">
          <span className="wb-sys-pomo-chip wb-sys-pomo-chip-mode">
            {modeIcon}
            {modeLabel}
          </span>
          {isPaused && (
            <span className="wb-sys-pomo-chip wb-sys-pomo-chip-paused">
              <Pause size={12} weight="fill" aria-hidden />
              {t('workbench:apps.system.paused')}
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
                ? t('workbench:apps.system.idleHint')
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
        {/* 今日条（整行按钮 → 统计面板） */}
        <button
          ref={statsBtnRef}
          type="button"
          className="wb-sys-pomo-today"
          onClick={() => setSheet('stats')}
          aria-label={t('pomodoro.statsTitle')}
          title={t('pomodoro.statsTitle')}
        >
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
          <CaretRight size={13} className="wb-sys-pomo-today-chevron" aria-hidden />
        </button>

        {/* 传输控制行 */}
        <div className="wb-sys-pomo-controls">
          <div className="wb-sys-pomo-controls-side">
            <NotionButton
              ref={settingsBtnRef}
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => setSheet('settings')}
              title={t('pomodoro.settingsTitle')}
              aria-label={t('pomodoro.settingsTitle')}
              className="!h-7 !w-7"
            >
              <GearSix size={15} />
            </NotionButton>
          </div>

          <div className="wb-sys-pomo-controls-main">
            {mode !== 'idle' && (
              <NotionButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={() => stop(true)}
                title={t('pomodoro.controls.stop')}
                aria-label={t('pomodoro.controls.stop')}
                className="!h-7 !w-7"
              >
                <Square size={14} />
              </NotionButton>
            )}

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
                  className="wb-sys-pomo-play h-8 gap-1.5 !px-4 text-xs"
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
                className="h-8 gap-1.5 !px-3 text-xs"
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
                onClick={() => stop(false)}
                title={t('pomodoro.controls.skipBreak')}
                aria-label={t('pomodoro.controls.skipBreak')}
                className="!h-7 !w-7"
              >
                <SkipForward size={14} />
              </NotionButton>
            )}
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
                className="!h-7 !w-7"
              >
                <ArrowsOut size={14} />
              </NotionButton>
            )}
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={toggleNoise}
              title={noiseOn ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
              aria-label={noiseOn ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
              className={cn('!h-7 !w-7', noiseOn && 'text-[color:hsl(var(--primary))]')}
            >
              {noiseOn ? <SpeakerHigh size={15} /> : <SpeakerSlash size={15} />}
            </NotionButton>
          </div>
        </div>
      </div>

      {/* ==== 全窗 Sheet：设置 / 统计 ==== */}
      {sheet === 'settings' && (
        <PomoSheet title={t('pomodoro.settingsTitle')} onClose={() => setSheet(null)}>
          <PomodoroWindowSettings />
        </PomoSheet>
      )}
      {sheet === 'stats' && (
        <PomoSheet title={t('pomodoro.statsTitle')} onClose={() => setSheet(null)}>
          <PomodoroStatsContent showTitle={false} />
        </PomoSheet>
      )}
    </div>
  );
};

export default PomodoroAppWindow;
