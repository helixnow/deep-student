/**
 * PomodoroStatsPopover — 专注趋势弹层
 *
 * 数据源：pomodoro_daily_stats（按本地日期聚合，无记录天补零）。
 * 两种模式：
 * - 趋势：近 7/14/30 天的每日专注柱状图 + 汇总（番茄数/专注时长/日均）
 * - 热力图：近 12 周 GitHub 风格活跃格子
 *
 * 设计系统：范围切换走 SegmentedControl、加载态走 Skeleton、
 * 柱状/热力颜色走 --primary 透明度梯度、hover 数值走 Tooltip。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { TrendDown, TrendUp } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { getPomodoroDailyStats, type PomodoroDailyStat } from '../api';

const RANGES = [7, 14, 30] as const;
type RangeDays = (typeof RANGES)[number];
type ViewMode = RangeDays | 'heatmap';
type ViewModeValue = '7' | '14' | '30' | 'heatmap';

/** 热力图覆盖天数（12 周） */
const HEATMAP_DAYS = 84;

const fmtLocalDate = (d: Date): string => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

const shiftDays = (d: Date, n: number): Date => {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
};

/** 加载骨架的柱高（确定性伪随机，避免每次渲染跳动） */
const SKELETON_BAR_HEIGHTS = [42, 68, 30, 84, 55, 24, 73, 48, 62, 36, 90, 52, 28, 66];

/**
 * 统计内容主体：桌面端由 PomodoroPanel 内的 Popover 承载，
 * 移动端由 Todo 页 inline 子屏承载（showTitle=false 时标题走统一顶栏）。
 */
export const PomodoroStatsContent: React.FC<{ showTitle?: boolean }> = ({ showTitle = true }) => {
  const { t, i18n } = useTranslation('todo');
  const [mode, setMode] = useState<ViewMode>(7);
  const [stats, setStats] = useState<PomodoroDailyStat[] | null>(null);
  const days = mode === 'heatmap' ? HEATMAP_DAYS : mode;

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    getPomodoroDailyStats(days)
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {
        if (!cancelled) setStats([]);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  // ===== 周对比：本周至今 vs 上周同期（固定取近 14 天，与展示模式无关） =====
  const [weekCompare, setWeekCompare] = useState<{
    thisWeekSeconds: number;
    lastWeekSeconds: number;
    /** 本周已过天数（含今天），用于日均 */
    elapsedDays: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPomodoroDailyStats(14)
      .then((data) => {
        if (cancelled) return;
        const byDate = new Map(data.map((d) => [d.date, d.focusSeconds]));
        const now = new Date();
        const dayIdx = (now.getDay() + 6) % 7; // 0 = 周一
        const monday = shiftDays(now, -dayIdx);
        let thisWeekSeconds = 0;
        let lastWeekSeconds = 0;
        for (let i = 0; i <= dayIdx; i++) {
          thisWeekSeconds += byDate.get(fmtLocalDate(shiftDays(monday, i))) ?? 0;
          lastWeekSeconds += byDate.get(fmtLocalDate(shiftDays(monday, i - 7))) ?? 0;
        }
        setWeekCompare({ thisWeekSeconds, lastWeekSeconds, elapsedDays: dayIdx + 1 });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const summary = useMemo(() => {
    if (!stats || stats.length === 0) {
      return { pomodoros: 0, focusMinutes: 0, avgMinutes: 0, activeDays: 0 };
    }
    const pomodoros = stats.reduce((acc, d) => acc + d.completedCount, 0);
    const focusMinutes = Math.round(stats.reduce((acc, d) => acc + d.focusSeconds, 0) / 60);
    const activeDays = stats.filter((d) => d.focusSeconds > 0).length;
    return {
      pomodoros,
      focusMinutes,
      avgMinutes: activeDays > 0 ? Math.round(focusMinutes / activeDays) : 0,
      activeDays,
    };
  }, [stats]);

  const maxFocus = useMemo(
    () => Math.max(1, ...(stats ?? []).map((d) => d.focusSeconds)),
    [stats],
  );

  const formatFocus = (minutes: number) =>
    minutes < 60
      ? t('pomodoro.stats.minutes', { value: minutes })
      : t('pomodoro.stats.hours', { value: (minutes / 60).toFixed(1) });

  const dayLabel = (date: string) => {
    try {
      return new Date(`${date}T00:00:00`).toLocaleDateString(
        i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US',
        { month: 'numeric', day: 'numeric' },
      );
    } catch {
      return date.slice(5);
    }
  };

  /** Tooltip 正文：日期 · 专注时长 · N 个番茄 */
  const dayDetail = (d: PomodoroDailyStat) =>
    `${dayLabel(d.date)} · ${formatFocus(Math.round(d.focusSeconds / 60))} · ${t(
      'pomodoro.statsPopover.pomodoroCount',
      { count: d.completedCount },
    )}`;

  // ===== 热力图：按周分列（列=周，行=周一..周日），强度按当日专注分钟分档 =====
  const heatmapWeeks = useMemo(() => {
    if (mode !== 'heatmap' || !stats || stats.length === 0) return null;
    const weeks: (PomodoroDailyStat | null)[][] = [];
    let week: (PomodoroDailyStat | null)[] = [];
    // 首列补齐：周一=0 … 周日=6
    const firstDay = new Date(`${stats[0].date}T00:00:00`).getDay();
    const mondayIndex = (firstDay + 6) % 7;
    for (let i = 0; i < mondayIndex; i++) week.push(null);
    for (const d of stats) {
      week.push(d);
      if (week.length === 7) {
        weeks.push(week);
        week = [];
      }
    }
    if (week.length > 0) {
      while (week.length < 7) week.push(null);
      weeks.push(week);
    }
    return weeks;
  }, [mode, stats]);

  /** 0=无记录，1-4=强度（15/30/60 分钟阈值） */
  const heatLevel = (focusSeconds: number): number => {
    const minutes = focusSeconds / 60;
    if (minutes <= 0) return 0;
    if (minutes < 15) return 1;
    if (minutes < 30) return 2;
    if (minutes < 60) return 3;
    return 4;
  };

  /** primary 透明度梯度（0 档保持中性底色） */
  const HEAT_CLASSES = [
    'bg-[color:var(--shell-workspace-border)]/60',
    'bg-primary/25',
    'bg-primary/45',
    'bg-primary/70',
    'bg-primary',
  ];

  const rangeOptions: Array<{ value: ViewModeValue; label: React.ReactNode }> = [
    ...RANGES.map((r) => ({
      value: String(r) as ViewModeValue,
      label: t('pomodoro.statsPopover.rangeDays', { count: r }),
    })),
    { value: 'heatmap' as ViewModeValue, label: t('pomodoro.statsPopover.heatmap') },
  ];

  return (
    <>
      <div className="mb-2 flex items-center justify-between gap-2">
        {showTitle ? (
          <span className="text-xs font-semibold text-foreground">
            {t('pomodoro.statsPopover.title')}
          </span>
        ) : (
          <span />
        )}
        <SegmentedControl<ViewModeValue>
          ariaLabel={t('pomodoro.statsPopover.title')}
          size="compact"
          value={mode === 'heatmap' ? 'heatmap' : (String(mode) as ViewModeValue)}
          onValueChange={(v) => setMode(v === 'heatmap' ? 'heatmap' : (Number(v) as RangeDays))}
          options={rangeOptions}
          itemClassName="!h-6 !px-2 text-[11px] [@media(pointer:coarse)]:!h-9 [@media(pointer:coarse)]:!px-2.5"
        />
      </div>

      {/* 汇总（本范围）：番茄数 / 专注总时长 / 日均 */}
      {stats === null ? (
        <div className="mb-2 flex items-center gap-3" role="status" aria-label={t('pomodoro.statsPopover.loading')}>
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>
            {t('pomodoro.statsPopover.totalPomodoros')}{' '}
            <strong className="font-semibold tabular-nums text-foreground">{summary.pomodoros}</strong>
          </span>
          <span>
            {t('pomodoro.stats.focusLabel')}{' '}
            <strong className="font-semibold tabular-nums text-foreground">
              {formatFocus(summary.focusMinutes)}
            </strong>
          </span>
          {summary.activeDays > 0 && (
            <span>
              {t('pomodoro.statsPopover.dailyAvg')}{' '}
              <strong className="font-semibold tabular-nums text-foreground">
                {formatFocus(summary.avgMinutes)}
              </strong>
            </span>
          )}
        </div>
      )}

      {/* 图表区 */}
      {stats === null ? (
        mode === 'heatmap' ? (
          <Skeleton className="h-24 w-full rounded-md" />
        ) : (
          <div className="flex h-24 items-end gap-[2px]" aria-hidden="true">
            {Array.from({ length: Math.min(days, SKELETON_BAR_HEIGHTS.length * 3) }, (_, i) => (
              <Skeleton
                key={i}
                variant="pulse"
                className="min-w-0 flex-1 rounded-sm"
                style={{ height: `${SKELETON_BAR_HEIGHTS[i % SKELETON_BAR_HEIGHTS.length]}%` }}
              />
            ))}
          </div>
        )
      ) : summary.focusMinutes === 0 ? (
        <div className="flex h-24 items-center justify-center text-xs text-muted-foreground/50">
          {t('pomodoro.statsPopover.empty')}
        </div>
      ) : heatmapWeeks ? (
        <div className="flex justify-center gap-[3px] py-1">
          {heatmapWeeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {week.map((d, di) =>
                d ? (
                  <Tooltip key={d.date}>
                    <TooltipTrigger asChild>
                      <div
                        className={cn(
                          'h-2.5 w-2.5 rounded-[2px] transition-colors duration-150 ease-standard',
                          HEAT_CLASSES[heatLevel(d.focusSeconds)],
                        )}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="tabular-nums">
                      {dayDetail(d)}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <div key={`pad-${wi}-${di}`} className="h-2.5 w-2.5" />
                ),
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex h-24 items-end gap-[2px]">
          {stats.map((d) => {
            const ratio = d.focusSeconds / maxFocus;
            const h = d.focusSeconds > 0 ? Math.max(6, ratio * 100) : 0;
            // primary 透明度梯度：强度越高越实
            const alpha = 0.35 + 0.65 * ratio;
            return (
              <div
                key={d.date}
                className="h-full min-w-0 flex-1 [&>span]:h-full [&>span]:w-full"
              >
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="group flex h-full w-full cursor-default flex-col items-center justify-end">
                      {d.focusSeconds > 0 ? (
                        <div
                          className="w-full rounded-sm bg-primary transition-[filter] duration-150 ease-standard group-hover:brightness-110"
                          style={{ height: `${h}%`, opacity: alpha }}
                        />
                      ) : (
                        <div className="h-[3px] w-full rounded-sm bg-[color:var(--shell-workspace-border)]" />
                      )}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="tabular-nums">
                    {dayDetail(d)}
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      )}

      {/* 横轴首尾标签 */}
      {stats && stats.length > 0 && summary.focusMinutes > 0 && (
        <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/50">
          <span>{dayLabel(stats[0].date)}</span>
          <span>{dayLabel(stats[stats.length - 1].date)}</span>
        </div>
      )}

      {/* 周对比：本周总时长 / 日均 / 较上周同期趋势 */}
      {weekCompare && (weekCompare.thisWeekSeconds > 0 || weekCompare.lastWeekSeconds > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[color:var(--shell-workspace-border)] pt-2 text-[11px] text-muted-foreground">
          <span>
            {t('pomodoro.statsPopover.thisWeek')}{' '}
            <strong className="font-semibold tabular-nums text-foreground">
              {formatFocus(Math.round(weekCompare.thisWeekSeconds / 60))}
            </strong>
          </span>
          <span>
            {t('pomodoro.statsPopover.dailyAvg')}{' '}
            <strong className="font-semibold tabular-nums text-foreground">
              {formatFocus(Math.round(weekCompare.thisWeekSeconds / 60 / weekCompare.elapsedDays))}
            </strong>
          </span>
          {weekCompare.lastWeekSeconds > 0 ? (
            (() => {
              const delta =
                (weekCompare.thisWeekSeconds - weekCompare.lastWeekSeconds) /
                weekCompare.lastWeekSeconds;
              const pct = Math.round(Math.abs(delta) * 100);
              if (pct === 0) {
                return (
                  <span className="text-muted-foreground/70">
                    {t('pomodoro.statsPopover.weekFlat')}
                  </span>
                );
              }
              return (
                <span
                  className={cn(
                    'inline-flex items-center gap-1 font-medium tabular-nums',
                    delta > 0
                      ? 'text-[color:hsl(var(--success))]'
                      : 'text-[color:hsl(var(--destructive))]',
                  )}
                >
                  {delta > 0 ? (
                    <TrendUp size={12} weight="bold" aria-hidden="true" />
                  ) : (
                    <TrendDown size={12} weight="bold" aria-hidden="true" />
                  )}
                  {t(delta > 0 ? 'pomodoro.statsPopover.weekUp' : 'pomodoro.statsPopover.weekDown', {
                    value: pct,
                  })}
                </span>
              );
            })()
          ) : (
            <span className="text-muted-foreground/70">
              {t('pomodoro.statsPopover.weekNoBase')}
            </span>
          )}
        </div>
      )}
    </>
  );
};

/**
 * 锚定弹层兜底外壳（保留导出兼容）。
 * PomodoroPanel 桌面端已改用 shad Popover（portal + 碰撞处理）直接承载
 * PomodoroStatsContent；此组件供仍以锚定方式挂载的调用方使用。
 */
export const PomodoroStatsPopover: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation('todo');
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
      className="absolute bottom-full right-0 z-50 mb-2 w-80 border p-3 ui-zoom-fade-in"
      style={{
        borderRadius: 'var(--radius-shell-panel)',
        borderColor: 'var(--composer-panel-border)',
        background: 'var(--composer-panel-surface)',
        boxShadow: 'var(--composer-panel-shadow)',
        color: 'var(--composer-panel-foreground)',
      }}
      role="dialog"
      aria-label={t('pomodoro.statsPopover.title')}
    >
      <PomodoroStatsContent />
    </div>
  );
};
