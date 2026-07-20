/**
 * PomodoroPanel - 嵌入 Todo 页面的番茄钟面板
 *
 * 视觉规则（设计系统白名单，本区所有改动必须遵守）：
 * - 按钮一律 NotionButton（variant: primary/utility/ghost）；禁大号 rounded-full 圆形主按钮
 * - 颜色走语义 token：--primary/--success/--warning/--info/--destructive；扁平布局忌盒中盒
 * - 分隔用 divide-border/[0.08]；边框/分隔走 --shell-workspace-border / --shell-inspector-border
 * - 动效克制：ui-rise-in / 200ms 级过渡，尊重 prefers-reduced-motion
 * - 触控用 [@media(pointer:coarse)] 扩 hit area（≥44px）；等宽计时 font-mono tabular-nums
 * - 设置/统计浮层走 src/components/ui/shad/Popover（portal + 碰撞处理 + ui-zoom-fade-in），
 *   浮层外壳统一 --radius-shell-panel + --composer-panel-* 表面 token
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
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { NotionButton } from '@/components/ui/NotionButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
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

// ============================================================================
// 浮层外壳 —— 统一 composer-panel 表面 token（inline style 保证覆盖 Popover 基础类）
// ============================================================================

const panelSurfaceStyle: React.CSSProperties = {
  borderRadius: 'var(--radius-shell-panel)',
  borderColor: 'var(--composer-panel-border)',
  background: 'var(--composer-panel-surface)',
  boxShadow: 'var(--composer-panel-shadow)',
  color: 'var(--composer-panel-foreground)',
};

// ============================================================================
// PomodoroSettingsContent — 时长/间隔/自动开始设置（内容主体）
// 桌面端由面板内 Popover 承载；移动端由 Todo 页 inline 子屏承载
// size='md' 用于移动端子屏：行高/控件放大到触控友好尺寸
// ============================================================================

type SettingsRowSize = 'sm' | 'md';

/** 分区标题：11px 大写 muted（与 ComposerPanel.Section 的骨架语言一致） */
const SettingsSection: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div>
    <div className="pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
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
  const { settings, updateSettings } = usePomodoroStore();

  // 另一代理正在给 settings 增加 noiseAutoWithFocus 字段；此处向后兼容读取
  const noiseAutoWithFocus =
    (settings as { noiseAutoWithFocus?: boolean }).noiseAutoWithFocus ?? false;
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
          onChange={(v) =>
            updateSettings({ noiseAutoWithFocus: v } as Parameters<typeof updateSettings>[0])
          }
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
          <span className={cn('text-muted-foreground', size === 'md' ? 'text-sm' : 'text-xs')}>
            {t('pomodoro.settings.noiseVolume')}
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
            <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
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
    streakDays,
    noiseEnabled,
    setNoiseEnabled,
    start,
    pause,
    resume,
    stop,
    skipBreak,
    completeCurrentSession,
    setImmersive,
  } = usePomodoroStore();

  const [todayStats, setTodayStats] = useState<PomodoroTodayStats | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);

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

  const handleStop = useCallback(() => {
    stop(true);
  }, [stop]);

  // 正计时阶段：会话锁定的计时模式（store 的 sessionCountUp 是唯一事实来源）
  const isCountUpWork = mode === 'work' && sessionCountUp;

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

  // 每日目标进度（后端统计优先，store 计数兜底）
  const todayCount = todayStats?.completedCount ?? completedPomodorosToday;
  const goalReached = settings.dailyGoal > 0 && todayCount >= settings.dailyGoal;

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
  // 宿主页提供 inline 子屏回调时直开子屏，否则锚定 Popover
  const renderStatsControl = (btnClass: string, iconSize: number) =>
    onOpenStatsSubView ? (
      <NotionButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={onOpenStatsSubView}
        title={statsLabel}
        aria-label={statsLabel}
        className={btnClass}
      >
        <ChartBar size={iconSize} />
      </NotionButton>
    ) : (
      <Popover open={statsOpen} onOpenChange={setStatsOpen}>
        <PopoverTrigger asChild>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            title={statsLabel}
            aria-label={statsLabel}
            className={btnClass}
          >
            <ChartBar size={iconSize} />
          </NotionButton>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="w-80 p-3"
          style={panelSurfaceStyle}
          aria-label={statsLabel}
        >
          <PomodoroStatsContent />
        </PopoverContent>
      </Popover>
    );

  const renderSettingsControl = (btnClass: string, iconSize: number) =>
    onOpenSettingsSubView ? (
      <NotionButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={onOpenSettingsSubView}
        title={settingsLabel}
        aria-label={settingsLabel}
        className={btnClass}
      >
        <GearSix size={iconSize} />
      </NotionButton>
    ) : (
      <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
        <PopoverTrigger asChild>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            title={settingsLabel}
            aria-label={settingsLabel}
            className={btnClass}
          >
            <GearSix size={iconSize} />
          </NotionButton>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="w-72 p-3"
          style={panelSurfaceStyle}
          aria-label={settingsLabel}
        >
          <div className="mb-2 flex items-center gap-2">
            <GearSix
              size={16}
              weight="bold"
              className="shrink-0 text-[color:var(--composer-panel-foreground)]"
              aria-hidden="true"
            />
            <span className="text-[13px] font-semibold text-[color:var(--composer-panel-foreground)]">
              {settingsLabel}
            </span>
          </div>
          <div className="-mr-1 max-h-[min(60vh,520px)] overflow-y-auto overscroll-contain pr-1">
            <PomodoroSettingsContent />
          </div>
        </PopoverContent>
      </Popover>
    );

  /** 移动横滑区次要按钮统一 44px 触控标准 */
  const mobileIconBtnClass = '!h-11 !w-11 flex-shrink-0 transition-colors duration-150 ease-standard';

  return (
    // 面板是 Todo 中屏最底部元素：预留移动端安全区，避免手势条遮挡统计行（桌面端变量为 0）
    <div className="flex-shrink-0 pb-[var(--mobile-safe-area-bottom,0px)]">
      {isMobile ? (
        // ===== 移动端布局：空闲 = 单行迷你条；运行中 = 大号等宽时间 + 进度 + 横滑区 =====
        <div className="flex flex-col gap-1.5 px-4 py-2 sm:px-6">
          {/* 行 1：模式 + 任务 +（空闲态小号时间）+ 主 CTA + ⋯ */}
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'inline-flex flex-shrink-0 items-center gap-1.5 text-xs font-medium transition-colors duration-150 ease-standard',
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
                    <span className="cursor-default px-1 text-[11px] text-muted-foreground/60">
                      {t('pomodoro.strictBadge')}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t('pomodoro.strictHint')}</TooltipContent>
                </Tooltip>
              )}
              {/* 单一主 CTA：开始/暂停/继续（44px 触控） */}
              {!(pauseLocked && isRunning) && (
                <NotionButton
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
                  <span>{isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.start') : t('pomodoro.controls.resume')}</span>
                </NotionButton>
              )}
              {/* 次要操作收纳开关（运行中横滑区常显，此开关只在空闲态生效） */}
              <NotionButton
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
              </NotionButton>
            </div>
          </div>

          {/* 行 2：运行中展开——大号等宽时间 + 进度条 */}
          {mode !== 'idle' && (
            <>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-3xl font-semibold leading-none tabular-nums text-foreground">
                  {formatTime(timeLeft)}
                </span>
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
              <div className="h-1 overflow-hidden rounded-full bg-[color:var(--shell-workspace-border)]">
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
            <div className="ui-rise-in -mx-1 flex items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {mode !== 'idle' && (
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={handleStop}
                  title={t('pomodoro.controls.stop')}
                  aria-label={t('pomodoro.controls.stop')}
                  className={mobileIconBtnClass}
                >
                  <Square size={16} />
                </NotionButton>
              )}
              {isCountUpWork && isRunning && (
                <NotionButton
                  variant="utility"
                  size="sm"
                  onClick={() => completeCurrentSession()}
                  title={t('pomodoro.controls.finish')}
                  aria-label={t('pomodoro.controls.finish')}
                  className="h-11 flex-shrink-0 gap-1.5 !px-3 text-xs transition-colors duration-150 ease-standard"
                >
                  <CheckCircle size={16} />
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
                  className={mobileIconBtnClass}
                >
                  <SkipForward size={16} />
                </NotionButton>
              )}
              <NotionButton
                variant="ghost"
                size="icon"
                iconOnly
                onClick={toggleNoise}
                title={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
                aria-label={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
                className={cn(mobileIconBtnClass, noiseEnabled && 'text-primary')}
              >
                <IconSwap
                  active={noiseEnabled}
                  a={<SpeakerSlash size={16} />}
                  b={<SpeakerHigh size={16} />}
                />
              </NotionButton>
              {mode !== 'idle' && (
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={() => setImmersive(true)}
                  title={t('pomodoro.controls.enterImmersive')}
                  aria-label={t('pomodoro.controls.enterImmersive')}
                  className={mobileIconBtnClass}
                >
                  <ArrowsOut size={16} />
                </NotionButton>
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

        {/* 计时 + 进度 */}
        <div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <span
              className={cn(
                'font-mono font-semibold tabular-nums transition-colors duration-150 ease-standard',
                mode === 'idle'
                  ? 'text-base text-muted-foreground'
                  : 'text-lg text-foreground',
              )}
            >
              {formatTime(timeLeft)}
            </span>
            {mode !== 'idle' && !isCountUpWork && (
              <span className="text-[11px] tabular-nums text-muted-foreground">
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
              className="!h-7 !w-7 transition-colors duration-150 ease-standard"
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
              className="h-7 gap-1.5 !px-3 text-xs transition-colors duration-150 ease-standard"
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
              className="h-7 gap-1.5 !px-3 text-xs transition-colors duration-150 ease-standard"
            >
              <IconSwap
                active={isRunning}
                a={<Play size={14} />}
                b={<Pause size={14} />}
              />
              <span>{isRunning ? t('pomodoro.controls.pause') : mode === 'idle' ? t('pomodoro.controls.start') : t('pomodoro.controls.resume')}</span>
            </NotionButton>
          )}
          {pauseLocked && isRunning && !isCountUpWork && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-default px-1.5 text-[11px] text-muted-foreground/60">
                  {t('pomodoro.strictBadge')}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{t('pomodoro.strictHint')}</TooltipContent>
            </Tooltip>
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

          {/* 环境音开关（全局状态收敛在 store：noiseEnabled/setNoiseEnabled） */}
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={toggleNoise}
            title={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
            aria-label={noiseEnabled ? t('pomodoro.controls.noiseOff') : t('pomodoro.controls.noiseOn')}
            className={cn(
              '!h-7 !w-7 transition-colors duration-150 ease-standard',
              noiseEnabled && 'text-primary',
            )}
          >
            <IconSwap
              active={noiseEnabled}
              a={<SpeakerSlash size={14} />}
              b={<SpeakerHigh size={14} />}
            />
          </NotionButton>

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

          {/* 统计趋势 / 设置（移动端交给宿主页 inline 子屏，桌面端 portal Popover） */}
          {renderStatsControl('!h-7 !w-7 transition-colors duration-150 ease-standard', 14)}
          {renderSettingsControl('!h-7 !w-7 transition-colors duration-150 ease-standard', 14)}
        </div>
      </div>
      )}

      {/* 今日统计 + 每日目标 + 连续达标 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-2.5 sm:px-6">
        <div className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
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
        {/* 连续 N 天达成每日目标 */}
        {streakDays >= 2 && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[color:hsl(var(--warning))]">
            <Fire size={12} weight="fill" aria-hidden="true" />
            {t('pomodoro.stats.streak', { count: streakDays })}
          </span>
        )}
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
