/**
 * PomodoroStatsPopover — 专注趋势弹层
 *
 * 数据源：pomodoro_daily_stats（按本地日期聚合，无记录天补零）。
 * 两种模式：
 * - 趋势：近 7/14/30 天的每日专注柱状图 + 汇总（番茄数/专注时长/日均）
 * - 热力图：近 12 周 GitHub 风格活跃格子
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { getPomodoroDailyStats, type PomodoroDailyStat } from '../api';

const RANGES = [7, 14, 30] as const;
type RangeDays = (typeof RANGES)[number];
type ViewMode = RangeDays | 'heatmap';

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

export const PomodoroStatsPopover: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t, i18n } = useTranslation('todo');
  const ref = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ViewMode>(7);
  const [stats, setStats] = useState<PomodoroDailyStat[] | null>(null);
  const days = mode === 'heatmap' ? HEATMAP_DAYS : mode;

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
        setWeekCompare({ thisWeekSeconds, lastWeekSeconds });
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

  const HEAT_CLASSES = [
    'bg-[color:var(--shell-workspace-border)]/60',
    'bg-[color:hsl(var(--warning))]/25',
    'bg-[color:hsl(var(--warning))]/45',
    'bg-[color:hsl(var(--warning))]/70',
    'bg-[color:hsl(var(--warning))]',
  ];

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 z-50 mb-2 w-80 rounded-[var(--radius-shell-control)] border border-[color:var(--shell-workspace-border)] bg-[color:var(--surface-root,var(--background))] p-3 shadow-xl"
      role="dialog"
      aria-label={t('pomodoro.statsPopover.title')}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-foreground">
          {t('pomodoro.statsPopover.title')}
        </span>
        <div className="flex items-center gap-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setMode(r)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[11px] transition-colors',
                mode === r
                  ? 'bg-[color:hsl(var(--primary))] text-[color:hsl(var(--primary-foreground))]'
                  : 'text-muted-foreground hover:bg-[color:var(--interactive-hover)]',
              )}
            >
              {t('pomodoro.statsPopover.rangeDays', { count: r })}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setMode('heatmap')}
            className={cn(
              'rounded px-1.5 py-0.5 text-[11px] transition-colors',
              mode === 'heatmap'
                ? 'bg-[color:hsl(var(--primary))] text-[color:hsl(var(--primary-foreground))]'
                : 'text-muted-foreground hover:bg-[color:var(--interactive-hover)]',
            )}
          >
            {t('pomodoro.statsPopover.heatmap')}
          </button>
        </div>
      </div>

      {/* 汇总 */}
      <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>
          {t('pomodoro.statsPopover.totalPomodoros')}{' '}
          <strong className="font-semibold text-foreground">{summary.pomodoros}</strong>
        </span>
        <span>
          {t('pomodoro.stats.focusLabel')}{' '}
          <strong className="font-semibold text-foreground">
            {formatFocus(summary.focusMinutes)}
          </strong>
        </span>
        {summary.activeDays > 0 && (
          <span>
            {t('pomodoro.statsPopover.dailyAvg')}{' '}
            <strong className="font-semibold text-foreground">
              {formatFocus(summary.avgMinutes)}
            </strong>
          </span>
        )}
      </div>

      {/* 图表区 */}
      {stats === null ? (
        <div className="flex h-24 items-center justify-center text-xs text-muted-foreground/50">
          …
        </div>
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
                  <div
                    key={d.date}
                    className={cn('h-2.5 w-2.5 rounded-[2px]', HEAT_CLASSES[heatLevel(d.focusSeconds)])}
                    title={`${dayLabel(d.date)} · ${formatFocus(Math.round(d.focusSeconds / 60))} · ${t(
                      'pomodoro.statsPopover.pomodoroCount',
                      { count: d.completedCount },
                    )}`}
                  />
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
            const h = d.focusSeconds > 0 ? Math.max(6, (d.focusSeconds / maxFocus) * 100) : 0;
            return (
              <div
                key={d.date}
                className="group relative flex h-full flex-1 flex-col items-center justify-end"
                title={`${dayLabel(d.date)} · ${formatFocus(Math.round(d.focusSeconds / 60))} · ${t(
                  'pomodoro.statsPopover.pomodoroCount',
                  { count: d.completedCount },
                )}`}
              >
                {d.focusSeconds > 0 ? (
                  <div
                    className="w-full rounded-sm bg-[color:hsl(var(--warning))]/80 transition-colors group-hover:bg-[color:hsl(var(--warning))]"
                    style={{ height: `${h}%` }}
                  />
                ) : (
                  <div className="h-[3px] w-full rounded-sm bg-[color:var(--shell-workspace-border)]" />
                )}
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

      {/* 周对比：本周至今 vs 上周同期 */}
      {weekCompare && (weekCompare.thisWeekSeconds > 0 || weekCompare.lastWeekSeconds > 0) && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-[color:var(--shell-workspace-border)] pt-2 text-[11px] text-muted-foreground">
          <span>
            {t('pomodoro.statsPopover.thisWeek')}{' '}
            <strong className="font-semibold text-foreground">
              {formatFocus(Math.round(weekCompare.thisWeekSeconds / 60))}
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
                    'font-medium',
                    delta > 0
                      ? 'text-[color:hsl(var(--success))]'
                      : 'text-[color:hsl(var(--destructive))]',
                  )}
                >
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
    </div>
  );
};
