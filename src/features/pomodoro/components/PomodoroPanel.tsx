/**
 * PomodoroPanel - 嵌入 Todo 页面的番茄钟面板
 *
 * 严格使用设计系统白名单：
 * - 所有按钮走 NotionButton（variant: primary/utility/ghost）
 * - 无 rounded-full 大号圆形按钮
 * - 颜色走语义令牌（--primary/--success/--warning/--info/--destructive）
 * - 边框/分隔走 --shell-workspace-border / --shell-inspector-border
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Play,
  Pause,
  Square,
  Brain,
  Coffee,
  ArrowsOut,
  SkipForward,
  Timer,
  Flame,
  GearSix,
  CheckCircle,
  SpeakerHigh,
  SpeakerSlash,
  ChartBar,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '@/components/ui/shad/Input';
import { usePomodoroStore } from '../stores/usePomodoroStore';
import { getPomodoroTodayStats, type PomodoroTodayStats } from '../api';
import { noiseEngine, NOISE_TYPES, type NoiseType } from '../noiseEngine';
import { PomodoroStatsPopover } from './PomodoroStatsPopover';

// ============================================================================
// PomodoroSettingsPopover — 时长/间隔/自动开始设置
// ============================================================================

const SettingsNumberRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, unit, onChange }) => (
  <div className="flex items-center justify-between gap-3 py-1">
    <span className="text-xs text-muted-foreground">{label}</span>
    <div className="flex items-center gap-1.5">
      <Input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
        }}
        className="h-7 w-16 text-xs text-right"
      />
      {unit && <span className="w-8 text-[11px] text-muted-foreground">{unit}</span>}
    </div>
  </div>
);

const SettingsToggleRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, checked, onChange }) => (
  <label className="flex cursor-pointer items-center justify-between gap-3 py-1">
    <span className="text-xs text-muted-foreground">{label}</span>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
    />
  </label>
);

const PomodoroSettingsPopover: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation('todo');
  const { settings, updateSettings } = usePomodoroStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-[var(--radius-shell-control)] border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root,var(--background))] p-3 shadow-xl"
      role="dialog"
      aria-label={t('pomodoro.settings.title')}
    >
      <div className="mb-2 text-xs font-semibold text-foreground">
        {t('pomodoro.settings.title')}
      </div>
      <SettingsNumberRow
        label={t('pomodoro.settings.workDuration')}
        value={Math.round(settings.workDuration / 60)}
        min={1}
        max={120}
        unit={t('pomodoro.settings.minutesUnit')}
        onChange={(v) => updateSettings({ workDuration: v * 60 })}
      />
      <SettingsNumberRow
        label={t('pomodoro.settings.shortBreak')}
        value={Math.round(settings.shortBreak / 60)}
        min={1}
        max={60}
        unit={t('pomodoro.settings.minutesUnit')}
        onChange={(v) => updateSettings({ shortBreak: v * 60 })}
      />
      <SettingsNumberRow
        label={t('pomodoro.settings.longBreak')}
        value={Math.round(settings.longBreak / 60)}
        min={1}
        max={90}
        unit={t('pomodoro.settings.minutesUnit')}
        onChange={(v) => updateSettings({ longBreak: v * 60 })}
      />
      <SettingsNumberRow
        label={t('pomodoro.settings.longBreakInterval')}
        value={settings.longBreakInterval}
        min={1}
        max={12}
        unit={t('pomodoro.settings.pomodorosUnit')}
        onChange={(v) => updateSettings({ longBreakInterval: v })}
      />
      <div className="my-1.5 h-px bg-[color:var(--shell-workspace-border)]" />
      <SettingsToggleRow
        label={t('pomodoro.settings.autoStartBreaks')}
        checked={settings.autoStartBreaks}
        onChange={(v) => updateSettings({ autoStartBreaks: v })}
      />
      <SettingsToggleRow
        label={t('pomodoro.settings.autoStartWork')}
        checked={settings.autoStartWork}
        onChange={(v) => updateSettings({ autoStartWork: v })}
      />
      <div className="my-1.5 h-px bg-[color:var(--shell-workspace-border)]" />
      <SettingsToggleRow
        label={t('pomodoro.settings.strictMode')}
        checked={settings.strictMode}
        onChange={(v) => updateSettings({ strictMode: v })}
      />
      <SettingsToggleRow
        label={t('pomodoro.settings.countUp')}
        checked={settings.countUp}
        onChange={(v) => updateSettings({ countUp: v })}
      />
      <SettingsNumberRow
        label={t('pomodoro.settings.endReminder')}
        value={Math.round(settings.endReminderSeconds / 60)}
        min={0}
        max={10}
        unit={t('pomodoro.settings.minutesUnit')}
        onChange={(v) => updateSettings({ endReminderSeconds: v * 60 })}
      />
      <SettingsNumberRow
        label={t('pomodoro.settings.dailyGoal')}
        value={settings.dailyGoal}
        min={0}
        max={99}
        unit={t('pomodoro.settings.pomodorosUnit')}
        onChange={(v) => updateSettings({ dailyGoal: v })}
      />
      <div className="my-1.5 h-px bg-[color:var(--shell-workspace-border)]" />
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-xs text-muted-foreground">{t('pomodoro.settings.noiseType')}</span>
        <select
          value={settings.noiseType}
          onChange={(e) => {
            const type = e.target.value as NoiseType;
            updateSettings({ noiseType: type });
            noiseEngine.setType(type);
          }}
          className="h-7 rounded-md border border-[color:var(--shell-workspace-border)] bg-transparent px-1.5 text-xs text-foreground focus:outline-none"
        >
          {NOISE_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(`pomodoro.noise.${type}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex items-center justify-between gap-3 py-1">
        <span className="text-xs text-muted-foreground">{t('pomodoro.settings.noiseVolume')}</span>
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
          className="h-1.5 w-28 cursor-pointer accent-[hsl(var(--primary))]"
          aria-label={t('pomodoro.settings.noiseVolume')}
        />
      </div>
    </div>
  );
};

interface ModeInfo {
  label: string;
  icon: React.ReactNode;
  colorClass: string;
  progressClass: string;
}

export const PomodoroPanel: React.FC = () => {
  const { t } = useTranslation('todo');
  const {
    mode,
    status,
    timeLeft,
    phaseStartedAt,
    currentTaskTitle,
    settings,
    completedPomodorosToday,
    start,
    pause,
    resume,
    stop,
    completeCurrentSession,
    setImmersive,
  } = usePomodoroStore();

  const [todayStats, setTodayStats] = useState<PomodoroTodayStats | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [noiseOn, setNoiseOn] = useState(noiseEngine.playing);

  useEffect(() => {
    getPomodoroTodayStats().then(setTodayStats).catch(() => {});
    // mode 变化（含中断停止）也刷新今日统计，保证中断计数及时显示
  }, [completedPomodorosToday, mode]);

  const toggleNoise = useCallback(() => {
    if (noiseEngine.playing) {
      noiseEngine.stop();
      setNoiseOn(false);
    } else {
      noiseEngine.start(settings.noiseType, settings.noiseVolume);
      setNoiseOn(true);
    }
  }, [settings.noiseType, settings.noiseVolume]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  };

  const formatMinutes = (s: number) => {
    const m = Math.round(s / 60);
    return m < 60
      ? t('pomodoro.stats.minutes', { value: m })
      : t('pomodoro.stats.hours', { value: (m / 60).toFixed(1) });
  };

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

  // 正计时阶段：timeLeft 为已专注秒数（运行中 phaseStartedAt 非空；暂停时由 settings 推断）
  const isCountUpWork = mode === 'work' && (phaseStartedAt != null || settings.countUp);

  const totalDuration = (() => {
    switch (mode) {
      case 'work':
        return settings.workDuration;
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
        : 1 - timeLeft / totalDuration;

  // 严格模式下专注阶段隐藏暂停（store 同样拦截，双保险）
  const pauseLocked = settings.strictMode && mode === 'work' && status === 'running';

  const getModeInfo = (): ModeInfo => {
    switch (mode) {
      case 'work':
        return {
          label: t('pomodoro.modes.focusing'),
          icon: <Brain size={14} />,
          colorClass: 'text-[color:hsl(var(--warning))]',
          progressClass: 'bg-[color:hsl(var(--warning))]',
        };
      case 'short_break':
        return {
          label: t('pomodoro.modes.shortBreak'),
          icon: <Coffee size={14} />,
          colorClass: 'text-[color:hsl(var(--success))]',
          progressClass: 'bg-[color:hsl(var(--success))]',
        };
      case 'long_break':
        return {
          label: t('pomodoro.modes.longBreak'),
          icon: <Coffee size={14} />,
          colorClass: 'text-[color:hsl(var(--info))]',
          progressClass: 'bg-[color:hsl(var(--info))]',
        };
      default:
        return {
          label: t('pomodoro.modes.idle'),
          icon: <Timer size={14} />,
          colorClass: 'text-muted-foreground',
          progressClass: 'bg-[color:var(--shell-workspace-border)]',
        };
    }
  };

  const modeInfo = getModeInfo();
  const isRunning = status === 'running';

  // 每日目标进度（后端统计优先，store 计数兜底）
  const todayCount = todayStats?.completedCount ?? completedPomodorosToday;
  const goalReached = settings.dailyGoal > 0 && todayCount >= settings.dailyGoal;

  return (
    <div className="flex-shrink-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6">
        {/* 模式 + 任务 */}
        <div className="flex min-w-0 flex-shrink-0 items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-xs font-medium',
              modeInfo.colorClass,
            )}
          >
            {modeInfo.icon}
            {modeInfo.label}
          </span>
          {currentTaskTitle && mode !== 'idle' && (
            <span
              className="study-shell-badge max-w-[160px] truncate"
              title={currentTaskTitle}
            >
              {currentTaskTitle}
            </span>
          )}
        </div>

        {/* 计时 + 进度 */}
        <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'font-mono font-semibold tabular-nums transition-colors',
                mode === 'idle'
                  ? 'text-base text-muted-foreground'
                  : 'text-lg text-foreground',
              )}
            >
              {formatTime(timeLeft)}
            </span>
            {mode !== 'idle' && !isCountUpWork && (
              <span className="text-[11px] text-muted-foreground">
                / {formatTime(totalDuration)}
              </span>
            )}
            {isCountUpWork && (
              <span className="text-[11px] text-muted-foreground">
                {t('pomodoro.countUpLabel')}
              </span>
            )}
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-[color:var(--shell-workspace-border)]">
            <div
              className={cn(
                'h-full rounded-full transition-all duration-1000 ease-linear',
                modeInfo.progressClass,
              )}
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        </div>

        {/* 控制按钮组 */}
        <div className="flex flex-shrink-0 items-center gap-1">
          {mode !== 'idle' && (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={handleStop}
              title={t('pomodoro.controls.stop')}
              aria-label={t('pomodoro.controls.stop')}
              className="!h-7 !w-7"
            >
              <Square size={14} />
            </NotionButton>
          )}

          {/* 正计时专注中：手动「完成」收尾 */}
          {isCountUpWork && isRunning && (
            <NotionButton
              variant="primary"
              size="sm"
              onClick={() => completeCurrentSession()}
              title={t('pomodoro.controls.finish')}
              aria-label={t('pomodoro.controls.finish')}
              className="h-7 gap-1.5 !px-3 text-xs"
            >
              <CheckCircle size={14} />
              <span>{t('pomodoro.controls.finish')}</span>
            </NotionButton>
          )}

          {/* 严格模式专注中不可暂停 */}
          {!(pauseLocked && isRunning) && (
            <NotionButton
              variant={mode === 'idle' || !isRunning ? 'primary' : 'utility'}
              size="sm"
              onClick={handleTogglePlay}
              title={isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.startFocus') : t('pomodoro.controls.resume')}
              aria-label={isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.startFocus') : t('pomodoro.controls.resume')}
              className="h-7 gap-1.5 !px-3 text-xs"
            >
              {isRunning ? <Pause size={14} /> : <Play size={14} />}
              <span>{isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.start') : t('pomodoro.controls.resume')}</span>
            </NotionButton>
          )}
          {pauseLocked && isRunning && !isCountUpWork && (
            <span
              className="px-1.5 text-[11px] text-muted-foreground/60"
              title={t('pomodoro.strictHint')}
            >
              {t('pomodoro.strictBadge')}
            </span>
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

          {/* 环境音开关 */}
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={toggleNoise}
            title={noiseOn ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
            aria-label={noiseOn ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
            className={cn('!h-7 !w-7', noiseOn && 'text-[color:hsl(var(--primary))]')}
          >
            {noiseOn ? <SpeakerHigh size={14} /> : <SpeakerSlash size={14} />}
          </NotionButton>

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

          {/* 统计趋势 */}
          <div className="relative">
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => setStatsOpen((v) => !v)}
              title={t('pomodoro.statsPopover.title')}
              aria-label={t('pomodoro.statsPopover.title')}
              className="!h-7 !w-7"
            >
              <ChartBar size={14} />
            </NotionButton>
            {statsOpen && <PomodoroStatsPopover onClose={() => setStatsOpen(false)} />}
          </div>

          <div className="relative">
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => setSettingsOpen((v) => !v)}
              title={t('pomodoro.settings.title')}
              aria-label={t('pomodoro.settings.title')}
              className="!h-7 !w-7"
            >
              <GearSix size={14} />
            </NotionButton>
            {settingsOpen && <PomodoroSettingsPopover onClose={() => setSettingsOpen(false)} />}
          </div>
        </div>
      </div>

      {/* 今日统计 + 每日目标 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2.5 sm:px-6">
        <div className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Flame
            size={12}
            weight={goalReached ? 'fill' : 'regular'}
            className={cn(
              'text-[color:hsl(var(--warning))]',
              goalReached && 'text-[color:hsl(var(--success))]',
            )}
          />
          <span>
            {t('pomodoro.stats.todayLabel')}{' '}
            <strong className="font-semibold text-foreground">
              {todayCount}
              {settings.dailyGoal > 0 && (
                <span className="font-normal text-muted-foreground">/{settings.dailyGoal}</span>
              )}
            </strong>{' '}
            {t('pomodoro.stats.pomodoroUnit')}
          </span>
          {/* 目标进度（设置了目标才显示） */}
          {settings.dailyGoal > 0 && (
            <span
              className="ml-1 inline-flex h-1 w-16 overflow-hidden rounded-full bg-[color:var(--shell-workspace-border)]"
              title={
                goalReached
                  ? t('pomodoro.stats.goalReached')
                  : t('pomodoro.stats.goalProgress', {
                      done: todayCount,
                      goal: settings.dailyGoal,
                    })
              }
            >
              <span
                className={cn(
                  'h-full rounded-full transition-all duration-500',
                  goalReached
                    ? 'bg-[color:hsl(var(--success))]'
                    : 'bg-[color:hsl(var(--warning))]',
                )}
                style={{
                  width: `${Math.min(100, (todayCount / settings.dailyGoal) * 100)}%`,
                }}
              />
            </span>
          )}
          {goalReached && (
            <span className="text-[11px] font-medium text-[color:hsl(var(--success))]">
              {t('pomodoro.stats.goalReached')}
            </span>
          )}
        </div>
        {todayStats && todayStats.totalFocusSeconds > 0 && (
          <div className="text-[11px] text-muted-foreground">
            {t('pomodoro.stats.focusLabel')}{' '}
            <strong className="font-semibold text-foreground">
              {formatMinutes(todayStats.totalFocusSeconds)}
            </strong>
          </div>
        )}
        {todayStats && todayStats.interruptedCount > 0 && (
          <div className="text-[11px] text-muted-foreground/60">
            {t('pomodoro.stats.interrupted', { value: todayStats.interruptedCount })}
          </div>
        )}
      </div>
    </div>
  );
};
