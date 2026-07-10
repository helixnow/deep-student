/**
 * 番茄钟应用窗口（P9 薄包装 → O18 投射窗打磨）
 *
 * 投射目标：专注开始 → 投射源自动开窗，结束 → 关闭；也可从 Dock 手动打开。
 *
 * O18 精致计时视觉（设计文档 §4.4 投射呈现）：
 * - 上半区自绘 hero 计时盘：SVG 进度环（模式语义色：专注=warning、
 *   短休=success、长休=info）+ 大字等宽计时 + 模式徽章 + 任务徽章 +
 *   暂停/严格模式状态徽章 + 运行呼吸光晕（opacity/transform，
 *   reduced-motion / minimal 档静态化，isVisible=false 或拖窗降频时挂起动画）；
 * - 下半区复用 legacy `PomodoroPanel` 作为控制坞（开始/暂停/停止/环境音/
 *   统计/设置全量能力，不复刻不漂移）；
 * - 窗口标题带模式语义（「专注中 · 写论文」），Dock 弹层/切换器一眼可读；
 *   仅在模式/任务变化时更新，不做每秒标题刷新（避免 store 高频写）。
 *
 * 计时数据全部来自 usePomodoroStore（tick 由全局 GlobalPomodoroWidget 驱动）；
 * 进度环的 stroke-dashoffset 以 1s linear 过渡衔接秒级更新（与 legacy
 * 进度条 width 过渡同策略，属状态过渡而非装饰动画——报 O20 备案）。
 */
import React, { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Coffee, Pause, ShieldCheck, Timer } from '@phosphor-icons/react';
import { PomodoroPanel } from '@/features/pomodoro';
import { usePomodoroStore } from '@/features/pomodoro/stores/usePomodoroStore';
import type { AppWindowProps } from '../../core/types';
import { useWbSysSize } from './useWbSysSize';
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

const PomodoroAppWindow: React.FC<AppWindowProps> = ({
  onTitleChange,
  isVisible,
  renderThrottleMs = 0,
}) => {
  const { t } = useTranslation(['workbench', 'todo']);
  const { ref } = useWbSysSize();

  const mode = usePomodoroStore((s) => s.mode);
  const status = usePomodoroStore((s) => s.status);
  const timeLeft = usePomodoroStore((s) => s.timeLeft);
  const phaseStartedAt = usePomodoroStore((s) => s.phaseStartedAt);
  const settings = usePomodoroStore((s) => s.settings);
  const currentTaskTitle = usePomodoroStore((s) => s.currentTaskTitle);

  const modeLabel = useMemo(() => {
    switch (mode) {
      case 'work':
        return t('todo:pomodoro.modes.focusing', '专注中');
      case 'short_break':
        return t('todo:pomodoro.modes.shortBreak', '短休息');
      case 'long_break':
        return t('todo:pomodoro.modes.longBreak', '长休息');
      default:
        return t('todo:pomodoro.modes.idle', '番茄钟');
    }
  }, [mode, t]);

  // 标题：运行中带模式语义；仅模式/任务变化触发（无每秒写）
  useEffect(() => {
    const appName = t('workbench:apps.pomodoro', '番茄钟');
    if (mode === 'idle') {
      onTitleChange(appName);
    } else {
      onTitleChange(`${modeLabel} · ${currentTaskTitle || appName}`);
    }
  }, [onTitleChange, t, mode, modeLabel, currentTaskTitle]);

  // 正计时专注（与 legacy PomodoroPanel 同判定）
  const isCountUpWork = mode === 'work' && (phaseStartedAt != null || settings.countUp);

  const totalDuration = useMemo(() => {
    switch (mode) {
      case 'short_break':
        return settings.shortBreak;
      case 'long_break':
        return settings.longBreak;
      default:
        return settings.workDuration;
    }
  }, [mode, settings.shortBreak, settings.longBreak, settings.workDuration]);

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
      className="wb-sys-pomo flex h-full w-full min-w-0 flex-col overflow-hidden bg-background"
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
              {t('workbench:apps.system.paused', '已暂停')}
            </span>
          )}
          {strictLocked && (
            <span
              className="wb-sys-pomo-chip wb-sys-pomo-chip-strict"
              title={t('todo:pomodoro.strictHint', '严格模式下专注不可暂停')}
            >
              <ShieldCheck size={12} weight="fill" aria-hidden />
              {t('todo:pomodoro.strictBadge', '严格模式')}
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
                ? t('workbench:apps.system.idleHint', '在下方开始一段专注')
                : isCountUpWork
                  ? t('todo:pomodoro.countUpLabel', '正计时')
                  : `/ ${formatClock(totalDuration)}`}
            </span>
          </div>
        </div>

        {currentTaskTitle && mode !== 'idle' && (
          <span className="wb-sys-pomo-task" title={currentTaskTitle}>
            {currentTaskTitle}
          </span>
        )}
      </div>

      {/* ==== 控制坞（legacy 全量控制/统计/设置） ==== */}
      <div className="wb-sys-pomo-dock">
        <PomodoroPanel />
      </div>
    </div>
  );
};

export default PomodoroAppWindow;
