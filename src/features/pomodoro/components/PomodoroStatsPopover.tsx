/**
 * PomodoroStatsPopover — 专注趋势内容（PomodoroStatsContent）+ 兼容外壳
 *
 * 数据源：pomodoro_daily_stats（按本地日期聚合，无记录天补零）+
 * pomodoro_list_range（时段分布原始记录）。
 * 内容分区：
 * - 今日快照：今日专注时长 + 连续达标天数（streak，来自 store）
 * - 趋势：近 7/14/30 天的每日专注柱状图 + 汇总（番茄数/专注时长/日均）
 * - 热力图：近 12 周 GitHub 风格活跃格子
 * - 时段分布：24 小时手写 SVG 迷你直方图（高峰时段高亮）
 * - 周对比叙事卡：本周 vs 上周同期（↑↓百分比 + 一句话）
 *
 * 设计系统：范围切换走 SegmentedControl、加载态走 Skeleton、
 * 柱状/热力颜色走 --primary 透明度梯度、hover/键盘聚焦数值走 Tooltip。
 * 承载方式：桌面在 PomodoroPanel 内联展开区、移动在 Todo 页子屏、
 * workbench 在番茄钟窗子视图——一律内联，不做浮层。
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flame, TrendDown, TrendUp } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { usePomodoroStore } from '../stores/usePomodoroStore';
import { getPomodoroDailyStats, listPomodorosInRange, type PomodoroDailyStat } from '../api';

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
  const streakDays = usePomodoroStore((s) => s.streakDays);
  const [mode, setMode] = useState<ViewMode>(7);
  const [stats, setStats] = useState<PomodoroDailyStat[] | null>(null);
  // 触屏明细：hover Tooltip 在 coarse 指针上不可达，tap 选中后在图表下方
  // 固定明细行展示当日数值（再次 tap 取消选中）
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const days = mode === 'heatmap' ? HEATMAP_DAYS : mode;

  useEffect(() => {
    let cancelled = false;
    setStats(null);
    setSelectedDate(null);
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

  // ===== 时段分布：本范围内工作记录按开始小时分桶（秒），手写 SVG 直方图 =====
  const [hourDist, setHourDist] = useState<number[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHourDist(null);
    const end = new Date();
    const start = shiftDays(end, -(days - 1));
    listPomodorosInRange(fmtLocalDate(start), fmtLocalDate(end))
      .then((records) => {
        if (cancelled) return;
        const bins = new Array<number>(24).fill(0);
        for (const r of records) {
          if (r.type !== 'work') continue;
          const dt = new Date(r.startTime);
          if (!Number.isNaN(dt.getTime())) bins[dt.getHours()] += r.actualDuration;
        }
        setHourDist(bins);
      })
      .catch(() => {
        if (!cancelled) setHourDist(new Array<number>(24).fill(0));
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

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

  // 今日快照（日聚合序列末位 = 今天）
  const todayStat = stats && stats.length > 0 ? stats[stats.length - 1] : null;

  const hourSummary = useMemo(() => {
    if (!hourDist) return null;
    const total = hourDist.reduce((acc, s) => acc + s, 0);
    if (total <= 0) return null;
    let peakHour = 0;
    let max = 0;
    hourDist.forEach((s, h) => {
      if (s > max) {
        max = s;
        peakHour = h;
      }
    });
    return { total, max, peakHour };
  }, [hourDist]);

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
          itemClassName="!h-6 !px-2 text-xs [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-2.5"
        />
      </div>

      {/* 今日快照：今日专注时长 + 连续达标 streak（有数据才显示，避免空态噪音） */}
      {(Boolean(todayStat && todayStat.focusSeconds > 0) || streakDays > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {todayStat && todayStat.focusSeconds > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium tabular-nums text-primary">
              {t('pomodoro.statsPopover.today', { defaultValue: '今日' })}{' '}
              {formatFocus(Math.round(todayStat.focusSeconds / 60))}
              {todayStat.completedCount > 0 && (
                <span className="text-primary/70">
                  · {t('pomodoro.statsPopover.pomodoroCount', { count: todayStat.completedCount })}
                </span>
              )}
            </span>
          )}
          {streakDays > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-[color:hsl(var(--warning))]/10 px-2 py-0.5 text-xs font-medium tabular-nums text-[color:hsl(var(--warning))]">
              <Flame size={12} weight="fill" aria-hidden="true" />
              {t('pomodoro.stats.streak', { count: streakDays })}
            </span>
          )}
        </div>
      )}

      {/* 汇总（本范围）：番茄数 / 专注总时长 / 日均 */}
      {stats === null ? (
        <div className="mb-2 flex items-center gap-3" role="status" aria-label={t('pomodoro.statsPopover.loading')}>
          <Skeleton className="h-3.5 w-16" />
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ) : (
        <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
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
        // 空数据态：手写番茄钟表盘插画 + 主文案 + 一句引导
        <div className="flex h-28 flex-col items-center justify-center gap-2 text-center">
          <svg viewBox="0 0 48 48" className="h-11 w-11 text-muted-foreground/40" aria-hidden="true">
            {/* 外圈虚线表盘 */}
            <circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="3.5 4" strokeLinecap="round" />
            {/* 内圈进度弧（primary 低透明度，暗示未来的专注环） */}
            <circle
              cx="24"
              cy="24"
              r="13"
              fill="none"
              stroke="hsl(var(--primary))"
              strokeOpacity="0.4"
              strokeWidth="3"
              strokeDasharray="58 82"
              strokeLinecap="round"
              transform="rotate(-90 24 24)"
            />
            {/* 指针 */}
            <line x1="24" y1="24" x2="24" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <line x1="24" y1="24" x2="29.5" y2="26.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="24" cy="24" r="1.6" fill="currentColor" />
          </svg>
          <span className="text-xs text-muted-foreground/70">
            {t('pomodoro.statsPopover.empty')}
          </span>
          <span className="text-xs text-muted-foreground/50">
            {t('pomodoro.statsPopover.emptyHint')}
          </span>
        </div>
      ) : heatmapWeeks ? (
        <div className="flex justify-center gap-[3px] py-1">
          {heatmapWeeks.map((week, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {week.map((d, di) =>
                d ? (
                  <Tooltip key={d.date}>
                    <TooltipTrigger asChild>
                      {/* tap 选中：触屏无 hover，选中后数值显示在图表下方明细行 */}
                      <button
                        type="button"
                        aria-label={dayDetail(d)}
                        aria-pressed={selectedDate === d.date}
                        onClick={() =>
                          setSelectedDate((prev) => (prev === d.date ? null : d.date))
                        }
                        className={cn(
                          'h-2.5 w-2.5 [@media(pointer:coarse)]:h-3.5 [@media(pointer:coarse)]:w-3.5 rounded-[2px] border-0 p-0 transition-colors duration-150 ease-standard',
                          HEAT_CLASSES[heatLevel(d.focusSeconds)],
                          selectedDate === d.date && 'ring-1 ring-primary ring-offset-1',
                        )}
                      />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="tabular-nums">
                      {dayDetail(d)}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <div key={`pad-${wi}-${di}`} className="h-2.5 w-2.5 [@media(pointer:coarse)]:h-3.5 [@media(pointer:coarse)]:w-3.5" />
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
                    {/* 可聚焦柱：Tab 走查每日数值，focus 与 hover 同样弹 Tooltip；
                        触屏 tap 选中后数值固定显示在图表下方明细行 */}
                    <div
                      tabIndex={0}
                      role="button"
                      aria-label={dayDetail(d)}
                      aria-pressed={selectedDate === d.date}
                      onClick={() =>
                        setSelectedDate((prev) => (prev === d.date ? null : d.date))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelectedDate((prev) => (prev === d.date ? null : d.date));
                        }
                      }}
                      className={cn(
                        'group flex h-full w-full cursor-default flex-col items-center justify-end rounded-sm outline-none',
                        'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:ring-offset-1',
                        selectedDate === d.date && 'ring-1 ring-primary/60 ring-offset-1',
                      )}
                    >
                      {d.focusSeconds > 0 ? (
                        <div
                          className="w-full rounded-sm bg-primary transition-[filter] duration-150 ease-standard group-hover:brightness-110 group-focus-visible:brightness-110"
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

      {/* 触屏选中明细行：tap 柱/热力格后固定展示当日数值（替代 hover Tooltip） */}
      {stats && selectedDate && (() => {
        const selected = stats.find((d) => d.date === selectedDate);
        return selected ? (
          <div className="mt-1.5 rounded-md bg-[color:var(--interactive-hover)] px-2 py-1 text-xs tabular-nums text-foreground">
            {dayDetail(selected)}
          </div>
        ) : null;
      })()}

      {/* 横轴首尾标签 */}
      {stats && stats.length > 0 && summary.focusMinutes > 0 && (
        <div className="mt-1 flex justify-between text-2xs text-muted-foreground/50">
          <span>{dayLabel(stats[0].date)}</span>
          <span>{dayLabel(stats[stats.length - 1].date)}</span>
        </div>
      )}

      {/* 时段分布：本范围内 24 小时手写 SVG 直方图（高峰时段实心高亮） */}
      {hourSummary && hourDist && summary.focusMinutes > 0 && (
        <div className="mt-2 border-t border-[color:var(--shell-workspace-border)] pt-2">
          <div className="mb-1 flex items-center justify-between text-2xs text-muted-foreground/70">
            <span>{t('pomodoro.statsPopover.hourDist', { defaultValue: '时段分布' })}</span>
            <span className="tabular-nums">
              {t('pomodoro.statsPopover.peakHour', {
                hour: String(hourSummary.peakHour).padStart(2, '0'),
                defaultValue: '高峰 {{hour}}:00',
              })}
            </span>
          </div>
          <svg
            viewBox="0 0 240 36"
            className="h-9 w-full"
            role="img"
            aria-label={t('pomodoro.statsPopover.hourDist', { defaultValue: '时段分布' })}
          >
            {hourDist.map((seconds, hour) => {
              const ratio = seconds / hourSummary.max;
              const barH = seconds > 0 ? Math.max(3, ratio * 30) : 1.5;
              const isPeak = hour === hourSummary.peakHour && seconds > 0;
              return (
                <rect
                  key={hour}
                  x={hour * 10 + 1.5}
                  y={32 - barH}
                  width={7}
                  height={barH}
                  rx={1.5}
                  fill={seconds > 0 ? 'hsl(var(--primary))' : 'var(--shell-workspace-border)'}
                  fillOpacity={seconds > 0 ? (isPeak ? 1 : 0.3 + 0.5 * ratio) : 0.8}
                >
                  {/* 原生 SVG title：hover 即见当时段专注分钟数 */}
                  <title>
                    {t('pomodoro.statsPopover.hourDetail', {
                      hour: String(hour).padStart(2, '0'),
                      minutes: Math.round(seconds / 60),
                      defaultValue: '{{hour}}:00 · {{minutes}} 分钟',
                    })}
                  </title>
                </rect>
              );
            })}
          </svg>
          <div className="flex justify-between text-2xs text-muted-foreground/50 tabular-nums">
            <span>0:00</span>
            <span>12:00</span>
            <span>24:00</span>
          </div>
        </div>
      )}

      {/* 周对比：本周总时长 / 日均 / 较上周同期趋势 */}
      {weekCompare && (weekCompare.thisWeekSeconds > 0 || weekCompare.lastWeekSeconds > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[color:var(--shell-workspace-border)] pt-2 text-xs text-muted-foreground">
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
      // w-80 在 <352px 视口会横向溢出，加 max-w 兜底（当前仓内无调用方，保留导出兼容）
      className="absolute bottom-full right-0 z-50 mb-2 w-80 max-w-[calc(100vw-2rem)] border p-3 ui-zoom-fade-in"
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
