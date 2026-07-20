/**
 * PomodoroPanel - 嵌入 Todo 页面的番茄钟面板
 *
 * 视觉规则（设计系统白名单，本区所有改动必须遵守）：
 * - 按钮一律 DsButton（variant: primary/utility/ghost）；禁大号 rounded-full 圆形主按钮
 * - 颜色走语义 token：--primary/--success/--warning/--info/--destructive；扁平布局忌盒中盒
 * - 分隔用 divide-border/[0.08]；边框/分隔走 --shell-workspace-border / --shell-inspector-border
 * - 动效克制：ui-rise-in / 200ms 级过渡，尊重 prefers-reduced-motion
 * - 触控用 [@media(pointer:coarse)] 扩 hit area（≥44px）；等宽计时 font-mono tabular-nums
 * - 设置/统计不走浮层：桌面端在面板内内联展开（grid 0fr→1fr，200ms，
 *   参考 ComposerInlinePanel 金标准写法），移动端交给宿主页全屏子屏
 * - 设置表单复用 SnappySlider / Switch / SegmentedControl / Slider，不用原生 number/checkbox/select
 *
 * 移动端（isSmallScreen 或 coarse 指针）重排：大号等宽时间 + 单一主 CTA（≥44px）
 * + 次要操作收进「⋯」内联横滑区；空闲态折叠为单行迷你条，运行中展开。
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
  Fire,
  GearSix,
  CheckCircle,
  SpeakerHigh,
  SpeakerSlash,
  ChartBar,
  DotsThree,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { Switch } from '@/components/ui/shad/Switch';
import { Slider } from '@/components/ui/shad/Slider';
import { SnappySlider } from '@/components/ui/SnappySlider';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { IconSwap } from '@/components/ui/IconSwap';
import { usePomodoroStore } from '../stores/usePomodoroStore';
import { getPomodoroTodayStats, type PomodoroTodayStats } from '../api';
import { noiseEngine, NOISE_TYPES, type NoiseType } from '../noiseEngine';
import { PomodoroStatsContent } from './PomodoroStatsPopover';
import { RollingTime } from './RollingTime';
import '../styles/pomodoro-panel.css';

/** 空闲态时长快捷预设（分钟）；内联自定义走设置区滑杆 */
const DURATION_PRESETS = [15, 25, 45, 60] as const;

/** 放弃确认的自动回退时长（ms）：超时未确认视为取消 */
const STOP_CONFIRM_TIMEOUT_MS = 4000;

/** 延长阶段 chips：+1min / +5min（休息阶段常显；专注倒计时临近结束时显示） */
const ExtendChips: React.FC<{
  onExtend: (seconds: number) => void;
  /** 触控友好尺寸（≥44px hit area） */
  touch?: boolean;
  className?: string;
}> = ({ onExtend, touch = false, className }) => {
  const { t } = useTranslation('todo');
  return (
    <>
      {[1, 5].map((minutes) => (
        <DsButton
          key={minutes}
          variant="utility"
          size="sm"
          onClick={() => onExtend(minutes * 60)}
          title={t('pomodoro.controls.extendTitle', { count: minutes })}
          aria-label={t('pomodoro.controls.extendTitle', { count: minutes })}
          className={cn(
            'gap-0 !px-2 text-xs font-medium tabular-nums transition-colors duration-150 ease-standard',
            touch ? 'h-11 flex-shrink-0 !px-3 text-xs' : 'h-6',
            className,
          )}
        >
          {t('pomodoro.controls.extendMinutes', { count: minutes })}
        </DsButton>
      ))}
    </>
  );
};

/** 环境音播放态呼吸圆点（挂在扬声器按钮角上；样式见 pomodoro-panel.css） */
const NoisePlayingDot: React.FC = () => <span className="pomodoro-noise-dot" aria-hidden="true" />;

// ============================================================================
// 紧凑 hero 环 —— 桌面行内布局用的 44px SVG 进度环（阶段语义色 + 中心模式图标）
// ============================================================================

const HERO_RING_SIZE = 44;
const HERO_RING_STROKE = 3.5;
const HERO_RING_RADIUS = (HERO_RING_SIZE - HERO_RING_STROKE) / 2;
const HERO_RING_CIRCUMFERENCE = 2 * Math.PI * HERO_RING_RADIUS;

const HeroRing: React.FC<{
  /** 0–1 */
  progress: number;
  /** 阶段语义色（hsl(var(--primary)) 等） */
  accent: string;
  paused: boolean;
  idle: boolean;
  /** 阶段切换时重挂进度弧，避免 dashoffset 跨模式反向长扫 */
  arcKey: string;
  children: React.ReactNode;
}> = ({ progress, accent, paused, idle, arcKey, children }) => {
  const clamped = Math.min(1, Math.max(0, progress));
  const offset = HERO_RING_CIRCUMFERENCE * (1 - clamped);
  return (
    <div
      className="relative flex-shrink-0"
      style={{ width: HERO_RING_SIZE, height: HERO_RING_SIZE }}
      aria-hidden="true"
    >
      <svg
        viewBox={`0 0 ${HERO_RING_SIZE} ${HERO_RING_SIZE}`}
        className="h-full w-full -rotate-90"
        focusable="false"
      >
        <circle
          cx={HERO_RING_SIZE / 2}
          cy={HERO_RING_SIZE / 2}
          r={HERO_RING_RADIUS}
          fill="none"
          stroke="var(--shell-workspace-border)"
          strokeWidth={HERO_RING_STROKE}
        />
        <circle
          key={arcKey}
          cx={HERO_RING_SIZE / 2}
          cy={HERO_RING_SIZE / 2}
          r={HERO_RING_RADIUS}
          fill="none"
          stroke={accent}
          strokeWidth={HERO_RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={HERO_RING_CIRCUMFERENCE}
          strokeDashoffset={offset}
          className={cn(
            'motion-reduce:transition-none',
            paused && 'opacity-50',
            idle && 'opacity-0',
          )}
          style={{
            // 秒级更新间的平滑衔接（状态过渡）；阶段色切换 200ms 缓动
            transition:
              'stroke-dashoffset 1s linear, stroke 200ms cubic-bezier(0.22,1,0.36,1), opacity 200ms cubic-bezier(0.22,1,0.36,1)',
          }}
        />
      </svg>
      {/* 中心模式图标（随阶段语义色，150ms 微交互过渡） */}
      <span
        className="absolute inset-0 flex items-center justify-center transition-colors duration-150 ease-standard"
        style={{ color: idle ? 'hsl(var(--muted-foreground))' : accent }}
      >
        {children}
      </span>
    </div>
  );
};

// ============================================================================
// PomodoroSettingsContent — 时长/间隔/自动开始设置（内容主体）
// 桌面端由面板内内联展开区承载；移动端由 Todo 页 inline 子屏承载
// size='md' 用于移动端子屏：行高/控件放大到触控友好尺寸
// ============================================================================

type SettingsRowSize = 'sm' | 'md';

/** 分区标题：11px 大写 muted（与 ComposerPanel.Section 的骨架语言一致） */
const SettingsSection: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div>
    <div className="pb-1 text-xs font-semibold uppercase tracking-[0.04em] text-muted-foreground">
      {label}
    </div>
    <div className="space-y-0.5">{children}</div>
  </div>
);

const SettingsSliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  /** 中间刻度（min/max 自动并入），双击滑轨回到 defaultValue */
  snapValues: number[];
  defaultValue: number;
  unit?: string;
  onChange: (v: number) => void;
  size?: SettingsRowSize;
}> = ({ label, value, min, max, snapValues, defaultValue, unit, onChange, size = 'sm' }) => (
  <SnappySlider
    label={label}
    values={[min, ...snapValues, max]}
    defaultValue={defaultValue}
    value={value}
    min={min}
    max={max}
    step={1}
    suffix={unit || undefined}
    snapping
    config={{ snappingThreshold: Math.max(1, Math.round((max - min) * 0.02)) }}
    onChange={onChange}
    className={cn(size === 'md' && 'py-1.5')}
  />
);

const SettingsToggleRow: React.FC<{
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  size?: SettingsRowSize;
}> = ({ label, checked, onChange, size = 'sm' }) => (
  <label
    className={cn(
      'flex cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-shell-control)]',
      size === 'md' ? 'min-h-[2.75rem] py-1.5' : 'py-1',
    )}
  >
    <span className={cn('text-muted-foreground', size === 'md' ? 'text-sm' : 'text-xs')}>{label}</span>
    <Switch
      size={size === 'md' ? 'default' : 'sm'}
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
    />
  </label>
);

export const PomodoroSettingsContent: React.FC<{ size?: SettingsRowSize }> = ({ size = 'sm' }) => {
  const { t } = useTranslation('todo');
  const { settings, updateSettings, noiseEnabled } = usePomodoroStore();

  const noiseAutoWithFocus = settings.noiseAutoWithFocus;
  const volumePct = Math.round(settings.noiseVolume * 100);

  return (
    <div className={cn('flex flex-col', size === 'md' ? 'gap-4' : 'gap-3')}>
      <SettingsSection label={t('pomodoro.settings.sections.duration')}>
        <SettingsSliderRow
          size={size}
          label={t('pomodoro.settings.workDuration')}
          value={Math.round(settings.workDuration / 60)}
          min={1}
          max={120}
          snapValues={[15, 25, 45, 60, 90]}
          defaultValue={25}
          unit={t('pomodoro.settings.minutesUnit')}
          onChange={(v) => updateSettings({ workDuration: v * 60 })}
        />
        <SettingsSliderRow
          size={size}
          label={t('pomodoro.settings.shortBreak')}
          value={Math.round(settings.shortBreak / 60)}
          min={1}
          max={60}
          snapValues={[5, 10, 15, 30]}
          defaultValue={5}
          unit={t('pomodoro.settings.minutesUnit')}
          onChange={(v) => updateSettings({ shortBreak: v * 60 })}
        />
        <SettingsSliderRow
          size={size}
          label={t('pomodoro.settings.longBreak')}
          value={Math.round(settings.longBreak / 60)}
          min={1}
          max={90}
          snapValues={[10, 15, 20, 30, 45]}
          defaultValue={15}
          unit={t('pomodoro.settings.minutesUnit')}
          onChange={(v) => updateSettings({ longBreak: v * 60 })}
        />
        <SettingsSliderRow
          size={size}
          label={t('pomodoro.settings.longBreakInterval')}
          value={settings.longBreakInterval}
          min={1}
          max={12}
          snapValues={[2, 4, 6, 8]}
          defaultValue={4}
          unit={t('pomodoro.settings.pomodorosUnit')}
          onChange={(v) => updateSettings({ longBreakInterval: v })}
        />
      </SettingsSection>

      <SettingsSection label={t('pomodoro.settings.sections.automation')}>
        <SettingsToggleRow
          size={size}
          label={t('pomodoro.settings.autoStartBreaks')}
          checked={settings.autoStartBreaks}
          onChange={(v) => updateSettings({ autoStartBreaks: v })}
        />
        <SettingsToggleRow
          size={size}
          label={t('pomodoro.settings.autoStartWork')}
          checked={settings.autoStartWork}
          onChange={(v) => updateSettings({ autoStartWork: v })}
        />
      </SettingsSection>

      <SettingsSection label={t('pomodoro.settings.sections.focus')}>
        <SettingsToggleRow
          size={size}
          label={t('pomodoro.settings.strictMode')}
          checked={settings.strictMode}
          onChange={(v) => updateSettings({ strictMode: v })}
        />
        <SettingsToggleRow
          size={size}
          label={t('pomodoro.settings.countUp')}
          checked={settings.countUp}
          onChange={(v) => updateSettings({ countUp: v })}
        />
        <SettingsSliderRow
          size={size}
          label={t('pomodoro.settings.endReminder')}
          value={Math.round(settings.endReminderSeconds / 60)}
          min={0}
          max={10}
          snapValues={[1, 2, 3, 5]}
          defaultValue={2}
          unit={t('pomodoro.settings.minutesUnit')}
          onChange={(v) => updateSettings({ endReminderSeconds: v * 60 })}
        />
      </SettingsSection>

      <SettingsSection label={t('pomodoro.settings.sections.goal')}>
        <SettingsSliderRow
          size={size}
          label={t('pomodoro.settings.dailyGoal')}
          value={settings.dailyGoal}
          min={0}
          max={99}
          snapValues={[4, 8, 12, 16, 25, 50]}
          defaultValue={8}
          unit={t('pomodoro.settings.pomodorosUnit')}
          onChange={(v) => updateSettings({ dailyGoal: v })}
        />
      </SettingsSection>

      <SettingsSection label={t('pomodoro.settings.sections.sound')}>
        <SettingsToggleRow
          size={size}
          label={t('pomodoro.settings.noiseAutoWithFocus')}
          checked={noiseAutoWithFocus}
          onChange={(v) => updateSettings({ noiseAutoWithFocus: v })}
        />
        <div className={cn(size === 'md' ? 'py-1.5' : 'py-1')}>
          <SegmentedControl<NoiseType>
            ariaLabel={t('pomodoro.settings.noiseType')}
            size="compact"
            value={settings.noiseType}
            onValueChange={(type) => {
              updateSettings({ noiseType: type });
              noiseEngine.setType(type);
            }}
            className="w-full"
            itemClassName="min-w-0 flex-1 px-1"
            options={NOISE_TYPES.map((type) => ({
              value: type,
              label: (
                <span className="min-w-0 truncate">{t(`pomodoro.noise.${type}`)}</span>
              ),
              ariaLabel: t(`pomodoro.noise.${type}`),
            }))}
          />
        </div>
        <div
          className={cn(
            'flex items-center justify-between gap-3',
            size === 'md' ? 'min-h-[2.75rem] py-1.5' : 'py-1',
          )}
        >
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-muted-foreground',
              size === 'md' ? 'text-sm' : 'text-xs',
            )}
          >
            {t('pomodoro.settings.noiseVolume')}
            {/* 播放态指示：细微声波柱（reduced-motion 下静态） */}
            {noiseEnabled && (
              <span className="pomodoro-noise-eq" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Slider
              className={size === 'md' ? 'w-40' : 'w-28'}
              value={[volumePct]}
              min={0}
              max={100}
              step={5}
              onValueChange={([v]) => {
                const volume = (v ?? 0) / 100;
                updateSettings({ noiseVolume: volume });
                noiseEngine.setVolume(volume);
              }}
              aria-label={t('pomodoro.settings.noiseVolume')}
            />
            <span className="w-9 text-right text-xs tabular-nums text-muted-foreground">
              {volumePct}%
            </span>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
};

interface ModeInfo {
  label: string;
  icon: React.ReactNode;
  colorClass: string;
  progressClass: string;
}

interface PomodoroPanelProps {
  /**
   * 移动端：外部承载「设置」inline 子屏时传入。
   * 提供后设置按钮不再弹锚定弹层，而是交给宿主页面全屏展示。
   */
  onOpenSettingsSubView?: () => void;
  /** 移动端：外部承载「统计」inline 子屏时传入（同上） */
  onOpenStatsSubView?: () => void;
}

export const PomodoroPanel: React.FC<PomodoroPanelProps> = ({
  onOpenSettingsSubView,
  onOpenStatsSubView,
}) => {
  const { t } = useTranslation('todo');
  const {
    mode,
    status,
    timeLeft,
    currentTaskTitle,
    settings,
    completedPomodorosToday,
    sessionCountUp,
    phaseExtraSeconds,
    streakDays,
    noiseEnabled,
    setNoiseEnabled,
    isImmersive,
    start,
    pause,
    resume,
    stop,
    skipBreak,
    extendPhase,
    completeCurrentSession,
    updateSettings,
    setImmersive,
  } = usePomodoroStore();

  const [todayStats, setTodayStats] = useState<PomodoroTodayStats | null>(null);

  // 内联展开区（设置/统计）：inlinePanel 为目标态，renderedPanel 让内容在
  // 0fr 收起过渡（200ms）期间保持挂载，过渡结束后再卸载
  type InlinePanelKind = 'settings' | 'stats';
  const [inlinePanel, setInlinePanel] = useState<InlinePanelKind | null>(null);
  const [renderedPanel, setRenderedPanel] = useState<InlinePanelKind | null>(null);

  const toggleInlinePanel = useCallback((kind: InlinePanelKind) => {
    setInlinePanel((cur) => {
      const next = cur === kind ? null : kind;
      if (next) setRenderedPanel(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (inlinePanel !== null || renderedPanel === null) return;
    const id = window.setTimeout(() => setRenderedPanel(null), 240);
    return () => window.clearTimeout(id);
  }, [inlinePanel, renderedPanel]);

  // 移动端布局：小屏或触屏主输入设备时重排（大号时间 + 单主 CTA + 「⋯」横滑区）
  const { isSmallScreen } = useBreakpoint();
  const isTouchPrimary = useMediaQuery('(pointer: coarse)');
  const isMobile = isSmallScreen || isTouchPrimary;
  // 空闲态折叠为单行迷你条；「⋯」展开次要操作横滑区
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);

  useEffect(() => {
    getPomodoroTodayStats().then(setTodayStats).catch(() => {});
    // mode 变化（含中断停止）也刷新今日统计，保证中断计数及时显示
  }, [completedPomodorosToday, mode]);

  const toggleNoise = useCallback(() => {
    setNoiseEnabled(!noiseEnabled);
  }, [noiseEnabled, setNoiseEnabled]);

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

  // ==== 放弃确认（内联二次确认，非弹窗）====
  // 专注阶段进度会被记为 interrupted，误触成本高 → 停止先变确认态；
  // 休息阶段停止无损（不写记录），直接停。超时/失焦自动回退。
  const [confirmingStop, setConfirmingStop] = useState(false);
  const confirmTimerRef = useRef<number | null>(null);

  const clearConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current != null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
  }, []);

  const cancelStopConfirm = useCallback(() => {
    clearConfirmTimer();
    setConfirmingStop(false);
  }, [clearConfirmTimer]);

  const handleStop = useCallback(() => {
    if (mode === 'work' && !confirmingStop) {
      setConfirmingStop(true);
      clearConfirmTimer();
      confirmTimerRef.current = window.setTimeout(() => {
        confirmTimerRef.current = null;
        setConfirmingStop(false);
      }, STOP_CONFIRM_TIMEOUT_MS);
      return;
    }
    cancelStopConfirm();
    stop(true);
  }, [mode, confirmingStop, clearConfirmTimer, cancelStopConfirm, stop]);

  // 阶段切换（含自然完成）后残留的确认态失效
  useEffect(() => {
    cancelStopConfirm();
  }, [mode, cancelStopConfirm]);

  useEffect(() => clearConfirmTimer, [clearConfirmTimer]);

  // 正计时阶段：会话锁定的计时模式优先；旧持久化会话无该字段时回退设置
  //（严格真值判断会让旧数据下「完成」按钮消失）
  const isCountUpWork = mode === 'work' && (sessionCountUp ?? settings.countUp);

  const totalDuration = (() => {
    const base = (() => {
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
    // 倒计时阶段的计划总时长含 extendPhase 加时（进度环分母同步伸长）
    return mode !== 'idle' && !isCountUpWork ? base + phaseExtraSeconds : base;
  })();
  const progress =
    mode === 'idle'
      ? 0
      : isCountUpWork
        ? Math.min(1, timeLeft / totalDuration)
        : 1 - timeLeft / totalDuration;

  // 严格模式下专注阶段隐藏暂停（store 同样拦截，双保险）
  const pauseLocked = settings.strictMode && mode === 'work' && status === 'running';

  // ==== 键盘快捷键（面板挂载期间全局生效；沉浸模式有自己的处理器，避让）====
  // Space = 开始/暂停/继续；B = 跳过休息；M = 环境音开关。
  // 输入场景（可编辑元素 / 组合输入 / 修饰键）一律放行不拦截。
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      if (target.isContentEditable) return true;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isImmersive) return;
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      // 焦点在按钮上时空格是原生激活语义，不重复触发；
      // 焦点在滑杆/开关等 ARIA 控件上时空格属于控件交互，同样放行
      if (
        e.key === ' ' &&
        e.target instanceof HTMLElement &&
        e.target.closest('button, [role="slider"], [role="switch"], [role="checkbox"]')
      ) {
        return;
      }

      const s = usePomodoroStore.getState();
      if (e.key === ' ') {
        e.preventDefault();
        if (s.mode === 'idle') {
          s.start();
        } else if (s.status === 'running') {
          s.pause(); // 严格模式下 store 内部拦截，无副作用
        } else {
          s.resume();
        }
      } else if (e.key === 'b' || e.key === 'B') {
        if (s.mode === 'short_break' || s.mode === 'long_break') {
          e.preventDefault();
          s.skipBreak();
        }
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        s.setNoiseEnabled(!s.noiseEnabled);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isImmersive]);

  const getModeInfo = (): ModeInfo => {
    switch (mode) {
      case 'work':
        return {
          label: t('pomodoro.modes.focusing'),
          icon: <Brain size={14} />,
          colorClass: 'text-primary',
          progressClass: 'bg-primary',
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

  // 阶段语义色（work=primary / short_break=success / long_break=info），
  // 供 hero 环 stroke 等需要具体色值的地方消费
  const modeAccent = (() => {
    switch (mode) {
      case 'work':
        return 'hsl(var(--primary))';
      case 'short_break':
        return 'hsl(var(--success))';
      case 'long_break':
        return 'hsl(var(--info))';
      default:
        return 'hsl(var(--muted-foreground))';
    }
  })();

  // 延长阶段 chips：休息阶段常显；专注倒计时剩余 <2min 时也给一次「再来一分钟」的机会
  const isBreakMode = mode === 'short_break' || mode === 'long_break';
  const showExtendChips =
    isBreakMode || (mode === 'work' && !isCountUpWork && timeLeft > 0 && timeLeft <= 120);

  // 每日目标进度（后端统计优先，store 计数兜底）
  const todayCount = todayStats?.completedCount ?? completedPomodorosToday;
  const goalReached = settings.dailyGoal > 0 && todayCount >= settings.dailyGoal;

  // 严格模式徽章说明：触屏无 hover（Tooltip 不可达），tap 徽章切换内联提示行
  const [showStrictHint, setShowStrictHint] = useState(false);

  // 目标达成瞬间的一次性微庆祝（150-400ms，reduced-motion 下自动跳过动画）
  const prevGoalReachedRef = useRef(goalReached);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    const was = prevGoalReachedRef.current;
    prevGoalReachedRef.current = goalReached;
    if (goalReached && !was) {
      setCelebrate(true);
      const id = window.setTimeout(() => setCelebrate(false), 400);
      return () => window.clearTimeout(id);
    }
    return undefined;
  }, [goalReached]);

  const statsLabel = t('pomodoro.statsPopover.title');
  const settingsLabel = t('pomodoro.settings.title');

  // 统计/设置入口在桌面控制行与移动横滑区共用；
  // 宿主页提供 inline 子屏回调时直开子屏，否则切换面板内内联展开区（禁浮层承载主内容）
  const renderStatsControl = (btnClass: string, iconSize: number) => (
    <DsButton
      variant="ghost"
      size="icon"
      iconOnly
      onClick={onOpenStatsSubView ?? (() => toggleInlinePanel('stats'))}
      title={statsLabel}
      aria-label={statsLabel}
      aria-expanded={onOpenStatsSubView ? undefined : inlinePanel === 'stats'}
      className={cn(btnClass, !onOpenStatsSubView && inlinePanel === 'stats' && 'text-primary')}
    >
      <ChartBar size={iconSize} />
    </DsButton>
  );

  const renderSettingsControl = (btnClass: string, iconSize: number) => (
    <DsButton
      variant="ghost"
      size="icon"
      iconOnly
      onClick={onOpenSettingsSubView ?? (() => toggleInlinePanel('settings'))}
      title={settingsLabel}
      aria-label={settingsLabel}
      aria-expanded={onOpenSettingsSubView ? undefined : inlinePanel === 'settings'}
      className={cn(
        btnClass,
        !onOpenSettingsSubView && inlinePanel === 'settings' && 'text-primary',
      )}
    >
      <GearSix size={iconSize} />
    </DsButton>
  );

  // ===== 内联展开区（设置/统计）——grid 0fr→1fr 200ms（ComposerInlinePanel 金标准） =====
  const inlinePanelTitle = renderedPanel === 'settings' ? settingsLabel : statsLabel;
  const inlineExpandArea = (
    <div
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[grid-template-rows]',
        'motion-reduce:transition-none',
        inlinePanel !== null && inlinePanel === renderedPanel
          ? 'grid-rows-[1fr] opacity-100'
          : 'grid-rows-[0fr] opacity-0',
      )}
    >
      {/* 0fr→1fr 动画要求直接子元素 min-h-0 + overflow-hidden 才能被裁切 */}
      <div className="min-h-0 overflow-hidden">
        {renderedPanel && (
          <div
            role="region"
            aria-label={inlinePanelTitle}
            className="border-b border-[color:var(--shell-workspace-border)] px-4 pb-3 pt-2.5 sm:px-6"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setInlinePanel(null);
              }
            }}
          >
            <div className="mb-2 flex items-center gap-2">
              {renderedPanel === 'settings' ? (
                <GearSix size={16} weight="bold" className="shrink-0 text-foreground" aria-hidden="true" />
              ) : (
                <ChartBar size={16} weight="bold" className="shrink-0 text-foreground" aria-hidden="true" />
              )}
              <span className="text-ui font-semibold text-foreground">{inlinePanelTitle}</span>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={() => setInlinePanel(null)}
                title={t('close', { ns: 'common' })}
                aria-label={t('close', { ns: 'common' })}
                className="ml-auto !h-6 !w-6 transition-colors duration-150 ease-standard"
              >
                <X size={14} />
              </DsButton>
            </div>
            <CustomScrollArea
              className="-mr-1 max-h-[min(48vh,420px)] min-h-0"
              viewportClassName="overscroll-contain"
              fullHeight={false}
              trackOffsetRight={1}
            >
              <div className="pr-1">
                {renderedPanel === 'settings' ? (
                  <div className="mx-auto max-w-xl">
                    <PomodoroSettingsContent />
                  </div>
                ) : (
                  <div className="mx-auto max-w-xl">
                    <PomodoroStatsContent showTitle={false} />
                  </div>
                )}
              </div>
            </CustomScrollArea>
          </div>
        )}
      </div>
    </div>
  );

  /** 移动横滑区次要按钮统一 44px 触控标准 */
  const mobileIconBtnClass = '!h-11 !w-11 flex-shrink-0 transition-colors duration-150 ease-standard';

  // ==== 停止 / 放弃确认（内联二次确认，随处复用）====
  const abandonConfirmLabel = t('pomodoro.controls.abandonConfirm', '放弃本次专注？');
  const abandonLabel = t('pomodoro.controls.abandon', '放弃');
  const keepGoingLabel = t('pomodoro.controls.keepGoing', '继续专注');
  const renderStopControl = (touch: boolean) => {
    if (mode === 'idle') return null;
    if (confirmingStop) {
      return (
        <span
          className="ui-rise-in inline-flex flex-shrink-0 items-center gap-1"
          role="alertdialog"
          aria-label={abandonConfirmLabel}
        >
          <span
            className={cn(
              'text-xs font-medium text-[color:hsl(var(--destructive))]',
              touch ? 'px-1' : 'pl-1',
            )}
          >
            {abandonConfirmLabel}
          </span>
          <DsButton
            variant="utility"
            size="sm"
            onClick={handleStop}
            title={abandonLabel}
            aria-label={abandonLabel}
            className={cn(
              '!px-2.5 text-xs font-medium text-[color:hsl(var(--destructive))] transition-colors duration-150 ease-standard',
              touch ? 'h-11 flex-shrink-0' : 'h-6',
            )}
          >
            {abandonLabel}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={cancelStopConfirm}
            title={keepGoingLabel}
            aria-label={keepGoingLabel}
            className={cn(
              '!px-2 text-xs transition-colors duration-150 ease-standard',
              touch ? 'h-11 flex-shrink-0' : 'h-6',
            )}
          >
            {keepGoingLabel}
          </DsButton>
        </span>
      );
    }
    return (
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={handleStop}
        title={t('pomodoro.controls.stop')}
        aria-label={t('pomodoro.controls.stop')}
        className={touch ? mobileIconBtnClass : '!h-7 !w-7 transition-colors duration-150 ease-standard'}
      >
        <Square size={touch ? 16 : 14} />
      </DsButton>
    );
  };

  // ==== 空闲态时长快捷预设（点选即改工作时长；内联自定义走设置滑杆）====
  const workMinutes = Math.round(settings.workDuration / 60);
  const renderDurationPresets = (touch: boolean) =>
    mode === 'idle' && !settings.countUp ? (
      <span
        className="inline-flex flex-shrink-0 items-center gap-1"
        role="group"
        aria-label={t('pomodoro.presets.label', '时长快捷预设')}
      >
        {DURATION_PRESETS.map((minutes) => (
          <DsButton
            key={minutes}
            variant="ghost"
            size="sm"
            onClick={() => updateSettings({ workDuration: minutes * 60 })}
            title={t('pomodoro.presets.setTitle', {
              count: minutes,
              defaultValue: '将专注时长设为 {{count}} 分钟',
            })}
            aria-label={t('pomodoro.presets.setTitle', {
              count: minutes,
              defaultValue: '将专注时长设为 {{count}} 分钟',
            })}
            aria-pressed={workMinutes === minutes}
            className={cn(
              'gap-0 !px-2 text-xs tabular-nums transition-colors duration-150 ease-standard',
              touch ? 'h-11 flex-shrink-0 !px-3' : 'h-6',
              workMinutes === minutes
                ? 'font-semibold text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {minutes}
          </DsButton>
        ))}
        <span className="text-[10px] text-muted-foreground/60">{t('pomodoro.settings.minutesUnit')}</span>
      </span>
    ) : null;

  // ==== 环境音快速调节行：播放中内联展开（音色 + 音量），关掉即收起 ====
  // 收起后延迟卸载内容：0fr 收起态下控件虽不可见但仍可被 Tab 聚焦
  //（pointer-events-none 拦不住键盘），过渡走完再摘掉，消除隐形 tab 停靠点
  const [noiseRowRendered, setNoiseRowRendered] = useState(noiseEnabled);
  useEffect(() => {
    if (noiseEnabled) {
      setNoiseRowRendered(true);
      return undefined;
    }
    const id = window.setTimeout(() => setNoiseRowRendered(false), 240);
    return () => window.clearTimeout(id);
  }, [noiseEnabled]);

  const noiseQuickRow = (
    <div
      aria-hidden={!noiseEnabled}
      className={cn(
        'grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        noiseEnabled ? 'grid-rows-[1fr] opacity-100' : 'pointer-events-none grid-rows-[0fr] opacity-0',
      )}
    >
      <div className="min-h-0 overflow-hidden">
        {noiseRowRendered && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 pb-1.5 pt-0.5 sm:px-6">
          <SegmentedControl<NoiseType>
            ariaLabel={t('pomodoro.settings.noiseType')}
            size="compact"
            value={settings.noiseType}
            onValueChange={(type) => updateSettings({ noiseType: type })}
            itemClassName="min-w-0 px-2"
            options={NOISE_TYPES.map((type) => ({
              value: type,
              label: <span className="min-w-0 truncate text-xs">{t(`pomodoro.noise.${type}`)}</span>,
              ariaLabel: t(`pomodoro.noise.${type}`),
            }))}
          />
          <span className="flex min-w-[8rem] flex-1 items-center gap-2">
            <Slider
              className="max-w-[10rem] flex-1"
              value={[Math.round(settings.noiseVolume * 100)]}
              min={0}
              max={100}
              step={5}
              onValueChange={([v]) => updateSettings({ noiseVolume: (v ?? 0) / 100 })}
              aria-label={t('pomodoro.settings.noiseVolume')}
            />
            <span className="w-8 text-right text-[10px] tabular-nums text-muted-foreground">
              {Math.round(settings.noiseVolume * 100)}%
            </span>
          </span>
        </div>
        )}
      </div>
    </div>
  );

  return (
    // 面板是 Todo 中屏最底部元素：预留移动端安全区，避免手势条遮挡统计行（桌面端变量为 0）
    <div className="flex-shrink-0 pb-[var(--mobile-safe-area-bottom,0px)]">
      {/* 内联展开区（设置/统计）：面板向上「长出」，不走浮层（宿主提供子屏时按钮直开子屏，此区不会被触发） */}
      {inlineExpandArea}
      {isMobile ? (
        // ===== 移动端布局：空闲 = 单行迷你条；运行中 = 大号等宽时间 + 进度 + 横滑区 =====
        <div className="flex flex-col gap-1.5 px-4 py-2 sm:px-6">
          {/* 行 1：模式 + 任务 +（空闲态小号时间）+ 主 CTA + ⋯ */}
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'inline-flex max-w-[5.5rem] flex-shrink-0 items-center gap-1.5 truncate text-xs font-medium transition-colors duration-150 ease-standard min-[360px]:max-w-none',
                modeInfo.colorClass,
              )}
            >
              {modeInfo.icon}
              {modeInfo.label}
            </span>
            {currentTaskTitle && mode !== 'idle' && (
              <span
                className="study-shell-badge min-w-0 max-w-[8rem] truncate"
                title={currentTaskTitle}
              >
                {currentTaskTitle}
              </span>
            )}
            {mode === 'idle' && (
              <span className="font-mono text-sm font-medium tabular-nums text-muted-foreground">
                {formatTime(timeLeft)}
              </span>
            )}
            <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
              {pauseLocked && isRunning && !isCountUpWork && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    {/* tap 切换内联说明行（触屏无 hover）；桌面 hover Tooltip 照常 */}
                    <button
                      type="button"
                      onClick={() => setShowStrictHint((v) => !v)}
                      aria-expanded={showStrictHint}
                      className="min-h-11 rounded-md px-2 text-xs text-muted-foreground/60"
                    >
                      {t('pomodoro.strictBadge')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('pomodoro.strictHint')}</TooltipContent>
                </Tooltip>
              )}
              {/* 单一主 CTA：开始/暂停/继续（44px 触控） */}
              {!(pauseLocked && isRunning) && (
                <DsButton
                  variant={mode === 'idle' || !isRunning ? 'primary' : 'utility'}
                  size="sm"
                  onClick={handleTogglePlay}
                  title={isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.startFocus') : t('pomodoro.controls.resume')}
                  aria-label={isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.startFocus') : t('pomodoro.controls.resume')}
                  className="h-11 min-w-[2.75rem] gap-1.5 !px-4 text-sm transition-colors duration-150 ease-standard"
                >
                  <IconSwap
                    active={isRunning}
                    a={<Play size={18} />}
                    b={<Pause size={18} />}
                  />
                  <span className="hidden min-[360px]:inline">
                    {isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.start') : t('pomodoro.controls.resume')}
                  </span>
                </DsButton>
              )}
              {/* 次要操作收纳开关（运行中横滑区常显，此开关只在空闲态生效） */}
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={() => setMobileMoreOpen((v) => !v)}
                aria-expanded={mobileMoreOpen || mode !== 'idle'}
                title={t('pomodoro.controls.more', '更多操作')}
                aria-label={t('pomodoro.controls.more', '更多操作')}
                className={cn(
                  '!h-11 !w-11 transition-colors duration-150 ease-standard',
                  mobileMoreOpen && 'text-primary',
                )}
              >
                <DotsThree size={20} weight="bold" />
              </DsButton>
            </div>
          </div>

          {/* 行 2：运行中展开——大号等宽时间 + 进度条（挂载入场走 ui-rise-in，
              与行 3 横滑区同节奏，避免空闲态→运行中的生硬跳变） */}
          {mode !== 'idle' && (
            <>
              <div className="ui-rise-in flex items-baseline gap-2">
                {/* 逐位滚动：每秒仅变化的数字位做 transform 过渡 */}
                <RollingTime
                  text={formatTime(timeLeft)}
                  className="font-mono text-3xl font-semibold leading-none tabular-nums text-foreground"
                />
                {!isCountUpWork && (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    / {formatTime(totalDuration)}
                  </span>
                )}
                {isCountUpWork && (
                  <span className="text-xs text-muted-foreground">
                    {t('pomodoro.countUpLabel')}
                  </span>
                )}
              </div>
              <div className="ui-rise-in h-1 overflow-hidden rounded-full bg-[color:var(--shell-workspace-border)]">
                <div
                  className={cn(
                    'h-full rounded-full transition-all duration-1000 ease-linear',
                    modeInfo.progressClass,
                  )}
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            </>
          )}

          {/* 行 3：次要操作横滑区（运行中常显；空闲态由 ⋯ 展开），全部 ≥44px 触控 */}
          {(mode !== 'idle' || mobileMoreOpen) && (
            <div className="scrollbar-none ui-rise-in -mx-1 flex items-center gap-1 overflow-x-auto px-1">
              {renderStopControl(true)}
              {renderDurationPresets(true)}
              {isCountUpWork && isRunning && (
                <DsButton
                  variant="utility"
                  size="sm"
                  onClick={() => completeCurrentSession()}
                  title={t('pomodoro.controls.finish')}
                  aria-label={t('pomodoro.controls.finish')}
                  className="h-11 flex-shrink-0 gap-1.5 !px-3 text-xs transition-colors duration-150 ease-standard"
                >
                  <CheckCircle size={16} />
                  <span>{t('pomodoro.controls.finish')}</span>
                </DsButton>
              )}
              {(mode === 'short_break' || mode === 'long_break') && (
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={() => skipBreak()}
                  title={t('pomodoro.controls.skipBreak')}
                  aria-label={t('pomodoro.controls.skipBreak')}
                  className={mobileIconBtnClass}
                >
                  <SkipForward size={16} />
                </DsButton>
              )}
              {/* 延长阶段：休息中常显；专注倒计时临近结束时也给机会 */}
              {showExtendChips && <ExtendChips touch onExtend={extendPhase} />}
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={toggleNoise}
                title={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
                aria-label={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
                className={cn(mobileIconBtnClass, 'relative', noiseEnabled && 'text-primary')}
              >
                <IconSwap
                  active={noiseEnabled}
                  a={<SpeakerSlash size={16} />}
                  b={<SpeakerHigh size={16} />}
                />
                {noiseEnabled && <NoisePlayingDot />}
              </DsButton>
              {mode !== 'idle' && (
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={() => setImmersive(true)}
                  title={t('pomodoro.controls.enterImmersive')}
                  aria-label={t('pomodoro.controls.enterImmersive')}
                  className={mobileIconBtnClass}
                >
                  <ArrowsOut size={16} />
                </DsButton>
              )}
              {renderStatsControl(mobileIconBtnClass, 16)}
              {renderSettingsControl(mobileIconBtnClass, 16)}
            </div>
          )}
        </div>
      ) : (
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:px-6">
        {/* 模式 + 任务 */}
        <div className="flex min-w-0 flex-shrink-0 items-center gap-2">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 text-xs font-medium transition-colors duration-150 ease-standard',
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

        {/* 计时：紧凑 hero 环（进度收敛进环）+ 等宽时间 */}
        <div className="flex min-w-[200px] flex-1 items-center gap-3">
          <HeroRing
            progress={progress}
            accent={modeAccent}
            paused={mode !== 'idle' && !isRunning}
            idle={mode === 'idle'}
            arcKey={`${mode}-${isCountUpWork ? 'up' : 'down'}`}
          >
            {modeInfo.icon}
          </HeroRing>
          <div className="flex items-baseline gap-2">
            {/* 逐位滚动：每秒仅变化的数字位做 transform 过渡 */}
            <RollingTime
              text={formatTime(timeLeft)}
              className={cn(
                'font-mono font-semibold tabular-nums transition-[color,opacity] duration-150 ease-standard',
                mode === 'idle'
                  ? 'text-base text-muted-foreground'
                  : 'text-lg text-foreground',
                mode !== 'idle' && !isRunning && 'opacity-60',
              )}
            />
            {mode !== 'idle' && !isCountUpWork && (
              <span className="text-xs tabular-nums text-muted-foreground">
                / {formatTime(totalDuration)}
              </span>
            )}
            {isCountUpWork && (
              <span className="text-xs text-muted-foreground">
                {t('pomodoro.countUpLabel')}
              </span>
            )}
            {/* 空闲态时长快捷预设 */}
            {renderDurationPresets(false)}
          </div>
        </div>

        {/* 控制按钮组 */}
        <div className="flex flex-shrink-0 items-center gap-1">
          {renderStopControl(false)}

          {/* 正计时专注中：手动「完成」收尾 */}
          {isCountUpWork && isRunning && (
            <DsButton
              variant="primary"
              size="sm"
              onClick={() => completeCurrentSession()}
              title={t('pomodoro.controls.finish')}
              aria-label={t('pomodoro.controls.finish')}
              className="h-7 gap-1.5 !px-3 text-xs transition-colors duration-150 ease-standard"
            >
              <CheckCircle size={14} />
              <span>{t('pomodoro.controls.finish')}</span>
            </DsButton>
          )}

          {/* 严格模式专注中不可暂停 */}
          {!(pauseLocked && isRunning) && (
            <DsButton
              variant={mode === 'idle' || !isRunning ? 'primary' : 'utility'}
              size="sm"
              onClick={handleTogglePlay}
              title={isRunning ? t('pomodoro.controls.pauseSpace') : mode === 'idle' ? t('pomodoro.controls.startSpace') : t('pomodoro.controls.resumeSpace', '继续 (Space)')}
              aria-label={isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.startFocus') : t('pomodoro.controls.resume')}
              className="h-7 gap-1.5 !px-3 text-xs transition-colors duration-150 ease-standard"
            >
              <IconSwap
                active={isRunning}
                a={<Play size={14} />}
                b={<Pause size={14} />}
              />
              <span>{isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.start') : t('pomodoro.controls.resume')}</span>
            </DsButton>
          )}
          {pauseLocked && isRunning && !isCountUpWork && (
            <Tooltip>
              <TooltipTrigger asChild>
                {/* tap 切换内联说明行（触屏无 hover）；桌面 hover Tooltip 照常 */}
                <button
                  type="button"
                  onClick={() => setShowStrictHint((v) => !v)}
                  aria-expanded={showStrictHint}
                  className="px-1.5 text-xs text-muted-foreground/60"
                >
                  {t('pomodoro.strictBadge')}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">{t('pomodoro.strictHint')}</TooltipContent>
            </Tooltip>
          )}

          {(mode === 'short_break' || mode === 'long_break') && (
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => skipBreak()}
              title={t('pomodoro.controls.skipBreakKey')}
              aria-label={t('pomodoro.controls.skipBreakKey')}
              className="!h-7 !w-7 transition-colors duration-150 ease-standard"
            >
              <SkipForward size={14} />
            </DsButton>
          )}

          {/* 延长阶段：休息中常显；专注倒计时剩余 <2min 时也显示 */}
          {showExtendChips && <ExtendChips onExtend={extendPhase} />}

          {/* 环境音开关（全局状态收敛在 store：noiseEnabled/setNoiseEnabled） */}
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={toggleNoise}
            title={noiseEnabled ? t('pomodoro.controls.noiseOffKey') : t('pomodoro.controls.noiseOnKey')}
            aria-label={noiseEnabled ? t('pomodoro.controls.noiseOffKey') : t('pomodoro.controls.noiseOnKey')}
            className={cn(
              'relative !h-7 !w-7 transition-colors duration-150 ease-standard',
              noiseEnabled && 'text-primary',
            )}
          >
            <IconSwap
              active={noiseEnabled}
              a={<SpeakerSlash size={14} />}
              b={<SpeakerHigh size={14} />}
            />
            {noiseEnabled && <NoisePlayingDot />}
          </DsButton>

          {mode !== 'idle' && (
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => setImmersive(true)}
              title={t('pomodoro.controls.enterImmersive')}
              aria-label={t('pomodoro.controls.enterImmersive')}
              className="!h-7 !w-7 transition-colors duration-150 ease-standard"
            >
              <ArrowsOut size={14} />
            </DsButton>
          )}

          {/* 统计趋势 / 设置（移动端交给宿主页 inline 子屏，桌面端切换面板内联展开区） */}
          {renderStatsControl('!h-7 !w-7 transition-colors duration-150 ease-standard', 14)}
          {renderSettingsControl('!h-7 !w-7 transition-colors duration-150 ease-standard', 14)}
        </div>
      </div>
      )}

      {/* 环境音快速调节：播放中内联展开（音色/音量即改即生效） */}
      {noiseQuickRow}

      {/* 严格模式说明行：tap 徽章展开（触屏等价物），再次 tap 收起 */}
      {showStrictHint && pauseLocked && isRunning && !isCountUpWork && (
        <div className="px-4 pb-1.5 text-xs text-muted-foreground sm:px-6">
          {t('pomodoro.strictHint')}
        </div>
      )}

      {/* 今日统计 + 每日目标 + 连续达标 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2.5 sm:px-6">
        <div className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="relative inline-flex">
            <Flame
              size={12}
              weight={goalReached ? 'fill' : 'regular'}
              className={cn(
                'transition-transform duration-200 ease-standard motion-reduce:transition-none motion-reduce:transform-none',
                goalReached
                  ? 'text-[color:hsl(var(--success))]'
                  : 'text-[color:hsl(var(--warning))]',
                celebrate && 'scale-125',
              )}
            />
            {celebrate && (
              <Flame
                size={12}
                weight="fill"
                aria-hidden="true"
                className="absolute inset-0 text-[color:hsl(var(--success))] motion-safe:animate-[ping_400ms_ease-out_1] motion-reduce:hidden"
              />
            )}
          </span>
          <span>
            {t('pomodoro.stats.todayLabel')}{' '}
            <strong className="font-semibold tabular-nums text-foreground">
              {/* key 重挂：计数变化时一次性上滚（reduced-motion 下静态） */}
              <span key={todayCount} className="pomodoro-num-roll">
                {todayCount}
              </span>
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
            <span className="text-xs font-medium text-[color:hsl(var(--success))]">
              {t('pomodoro.stats.goalReached')}
            </span>
          )}
        </div>
        {/* 连续 N 天达成每日目标 */}
        {streakDays >= 2 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-[color:hsl(var(--warning))]">
            <Fire size={12} weight="fill" aria-hidden="true" />
            {t('pomodoro.stats.streak', { count: streakDays })}
          </span>
        )}
        {todayStats && todayStats.totalFocusSeconds > 0 && (
          <div className="text-xs text-muted-foreground">
            {t('pomodoro.stats.focusLabel')}{' '}
            <strong className="font-semibold text-foreground">
              {formatMinutes(todayStats.totalFocusSeconds)}
            </strong>
          </div>
        )}
        {todayStats && todayStats.interruptedCount > 0 && (
          <div className="text-xs text-muted-foreground/60">
            {t('pomodoro.stats.interrupted', { value: todayStats.interruptedCount })}
          </div>
        )}
      </div>
    </div>
  );
};
