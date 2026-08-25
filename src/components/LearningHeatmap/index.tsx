/**
 * 学习热力图组件 — 完全自绘实现（不依赖 @uiw/react-heat-map）
 *
 * 2026-07 重做：对齐 macOS 原生质感
 * - CSS Grid 自绘单元格，颜色直接走 hsl(var(--primary) / alpha)，主题切换零 JS
 * - 单例毛玻璃 tooltip（事件委托），替代逐格包裹的 CommonTooltip
 * - 细腻的 hover 缩放 / 今日光环 / 骨架屏
 */

import React, { useMemo, useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import { useLearningHeatmap, type LearningActivity } from '../../hooks/useLearningHeatmap';
import { ArrowsClockwise, TrendUp, Calendar, Lightning, Pulse } from '@phosphor-icons/react';
import { cn } from '../../lib/utils';
import { CustomScrollArea } from '../custom-scroll-area';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import './LearningHeatmap.css';

// ============================================================================
// 类型定义
// ============================================================================

export interface LearningHeatmapProps {
  months?: number;
  className?: string;
  showLegend?: boolean;
  showStats?: boolean;
  /** 隐藏内部标题（由外层分组容器提供标题时使用） */
  hideTitle?: boolean;
}

// ============================================================================
// 布局常量
// ============================================================================

const CELL = 11;
const GAP = 3;
/** 📱 触屏：11px 格子无法点准，coarse 指针下放大格子/间距 */
const CELL_COARSE = 15;
const GAP_COARSE = 4;
/** 月份标签行高度 */
const MONTH_ROW_H = 18;
/** tooltip 半宽，用于水平方向 clamp（防止贴视口边缘被裁） */
const TOOLTIP_HALF_W = 110;

// ============================================================================
// 日期工具（全部本地时区，避免 ISO 字符串按 UTC 解析漂移一天）
// ============================================================================

function toDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 后端返回 "YYYY-MM-DD"；宽容处理斜杠 / 不补零的变体 */
function normalizeDateKey(raw: string): string {
  const parts = raw.split(/[-/]/).map(Number);
  if (parts.length < 3 || parts.some(p => !Number.isFinite(p) || p <= 0)) return raw;
  const [y, m, d] = parts;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function formatDate(dateKey: string, locale: string): string {
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return date.toLocaleDateString(locale || 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  });
}

// ============================================================================
// 网格模型：周日为每列首行（与 GitHub 一致），列 = 周
// ============================================================================

interface GridModel {
  /** weeks[weekIndex][dayOfWeek] */
  weeks: Date[][];
  /** 每月第一天所在的周列索引 */
  monthMarks: Array<{ weekIndex: number; month: number }>;
  today: Date;
}

function buildGrid(months: number): GridModel {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(today);
  start.setMonth(start.getMonth() - months);
  start.setDate(start.getDate() - start.getDay()); // 回退到周日对齐

  const weeks: Date[][] = [];
  const monthMarks: Array<{ weekIndex: number; month: number }> = [];
  const cursor = new Date(start);

  while (cursor <= today) {
    const week: Date[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cursor));
      if (cursor.getDate() === 1 && cursor <= today) {
        monthMarks.push({ weekIndex: weeks.length, month: cursor.getMonth() });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  return { weeks, monthMarks, today };
}

// ============================================================================
// Tooltip
// ============================================================================

interface HoverState {
  dateKey: string;
  activity: LearningActivity | null;
  /** 视口坐标（tooltip 走 portal + fixed，避免被滚动容器裁剪） */
  left: number;
  top: number;
  placement: 'above' | 'below';
}

const DETAIL_KEYS = [
  'chatSessions',
  'chatMessages',
  'notesEdited',
  'textbooksOpened',
  'examsCreated',
  'translationsCreated',
  'essaysCreated',
  'ankiCardsCreated',
  'questionsAnswered',
] as const;

function HeatmapTooltip({ hover }: { hover: HoverState }) {
  const { t, i18n } = useTranslation('stats');
  const { activity, dateKey } = hover;
  const count = activity?.count ?? 0;

  return createPortal(
    <div
      className={cn('lh-tooltip', hover.placement === 'below' && 'lh-tooltip-below')}
      style={{ left: hover.left, top: hover.top }}
      role="tooltip"
    >
      <div className="lh-tooltip-header">
        <span className="lh-tooltip-date">{formatDate(dateKey, i18n.language)}</span>
        {count > 0 && <span className="lh-tooltip-badge">{count}</span>}
      </div>
      {count > 0 && activity ? (
        <div className="lh-tooltip-details">
          {DETAIL_KEYS.map(key =>
            activity.details[key] > 0 ? (
              <div key={key} className="lh-tooltip-row">
                <span>{t(`heatmap.details.${key}`)}</span>
                <span className="lh-tooltip-value">{activity.details[key]}</span>
              </div>
            ) : null
          )}
        </div>
      ) : (
        <div className="lh-tooltip-empty">{t('heatmap.noActivity')}</div>
      )}
    </div>,
    document.body
  );
}

// ============================================================================
// 统计卡片
// ============================================================================

interface StatsCardProps {
  icon: React.ReactNode;
  label: string;
  value: number | string;
}

function StatsCard({ icon, label, value }: StatsCardProps) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-md hover:bg-[var(--interactive-hover)] transition-colors">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="opacity-70">{icon}</span>
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="text-2xl font-semibold tracking-tight text-foreground tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

// ============================================================================
// 骨架屏 — 用同规格网格做呼吸占位，避免加载完成后布局跳动
// ============================================================================

function HeatmapSkeleton({ weeksCount, cell, gap }: { weeksCount: number; cell: number; gap: number }) {
  return (
    <div className="lh-skeleton" style={{ paddingTop: MONTH_ROW_H }}>
      <div
        className="lh-grid"
        style={{
          gridTemplateRows: `repeat(7, ${cell}px)`,
          gridAutoColumns: `${cell}px`,
          gap,
        }}
      >
        {Array.from({ length: weeksCount * 7 }, (_, i) => (
          <div key={i} className="lh-cell lh-cell-skeleton" style={{ animationDelay: `${(i % 28) * 30}ms` }} />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// 主组件
// ============================================================================

export function LearningHeatmap({
  months = 12,
  className = '',
  showLegend = true,
  showStats = true,
  hideTitle = false,
}: LearningHeatmapProps) {
  const { t } = useTranslation('stats');
  const {
    data,
    loading,
    error,
    totalActivities,
    activeDays,
    maxCount,
    refresh,
  } = useLearningHeatmap(months);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  // 📱 触屏：格子/间距放大便于点按；tooltip 改为点击显示（无 hover）
  const isCoarse = useMediaQuery('(pointer: coarse)');
  const cell = isCoarse ? CELL_COARSE : CELL;
  const gap = isCoarse ? GAP_COARSE : GAP;
  const step = cell + gap;

  const grid = useMemo(() => buildGrid(months), [months]);
  const todayKey = toDateKey(grid.today);

  // 日期 → 活动索引
  const byDate = useMemo(() => {
    const map = new Map<string, LearningActivity>();
    for (const item of data) map.set(normalizeDateKey(item.date), item);
    return map;
  }, [data]);

  /** 色阶：0 = 空，1-4 按当日活动量相对峰值分档 */
  const levelOf = useCallback(
    (count: number) => {
      if (count <= 0 || maxCount <= 0) return 0;
      return Math.min(4, Math.max(1, Math.ceil((count / maxCount) * 4)));
    },
    [maxCount]
  );

  const contentWidth = grid.weeks.length * step - gap;

  // 初始滚动到最新日期
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && !loading) el.scrollLeft = el.scrollWidth;
  }, [loading, contentWidth]);

  /** 按单元格定位单例 tooltip（视口坐标 + portal，不受滚动容器裁剪） */
  const showTooltipFor = useCallback(
    (target: HTMLElement, dateKey: string) => {
      const rect = target.getBoundingClientRect();
      const rawLeft = rect.left + rect.width / 2;
      const left = Math.min(
        Math.max(rawLeft, TOOLTIP_HALF_W + 8),
        window.innerWidth - TOOLTIP_HALF_W - 8
      );
      // 贴近视口顶部时翻转到下方
      const placement: HoverState['placement'] = rect.top < 180 ? 'below' : 'above';
      setHover({
        dateKey,
        activity: byDate.get(dateKey) ?? null,
        left,
        top: placement === 'above' ? rect.top - 8 : rect.bottom + 8,
        placement,
      });
    },
    [byDate]
  );

  // 事件委托：hover 单元格显示 tooltip（触屏无 hover，改走下方 click 切换，避免 tap 合成 mouseover 与 click 互相打架）
  const handleGridOver = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (isCoarse) return;
      const target = e.target as HTMLElement;
      const dateKey = target.dataset?.date;
      if (!dateKey) return;
      showTooltipFor(target, dateKey);
    },
    [isCoarse, showTooltipFor]
  );

  const clearHover = useCallback(() => setHover(null), []);

  // 📱 触屏：点格子显示 tooltip，再点同格或空白处关闭
  const handleGridClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isCoarse) return;
      const target = e.target as HTMLElement;
      const dateKey = target.dataset?.date;
      if (!dateKey || hover?.dateKey === dateKey) {
        setHover(null);
        return;
      }
      showTooltipFor(target, dateKey);
    },
    [isCoarse, hover?.dateKey, showTooltipFor]
  );

  // 触屏下点击网格外任意处关闭 tooltip
  useEffect(() => {
    if (!hover || !isCoarse) return;
    const onDocPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.('.lh-grid') || target?.closest?.('.lh-tooltip')) return;
      setHover(null);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [hover, isCoarse]);

  const weekLabels: Array<string | null> = [
    null, t('calendar.weekMon'), null, t('calendar.weekWed'), null, t('calendar.weekFri'), null,
  ];

  if (error) {
    return (
      <div className={cn('py-8 flex flex-col items-center justify-center text-muted-foreground/50', className)}>
        <span className="text-xs mb-3">{t('heatmap.error', { error })}</span>
        <DsButton
          variant="ghost"
          size="sm"
          onClick={refresh}
          className="!px-3 !py-1.5 !h-auto [@media(pointer:coarse)]:!min-h-11 text-xs font-medium hover:bg-[var(--interactive-hover)]"
        >
          <ArrowsClockwise size={12} />
          {t('heatmap.retry')}
        </DsButton>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col', className)}>
      {/* 标题 */}
      {!hideTitle && (
        <div className="flex items-center gap-2 mb-4 pl-1">
          <Pulse size={16} className="text-muted-foreground/70" />
          <h3 className="font-medium text-sm text-foreground/80">{t('heatmap.title')}</h3>
        </div>
      )}

      {/* 统计卡片 */}
      {showStats && !loading && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
          <StatsCard icon={<TrendUp size={16} />} label={t('heatmap.stats.totalActivities')} value={totalActivities} />
          <StatsCard icon={<Calendar size={16} />} label={t('heatmap.stats.activeDays')} value={activeDays} />
          <StatsCard icon={<Lightning size={16} />} label={t('heatmap.stats.maxDaily')} value={maxCount} />
        </div>
      )}

      {/* 热力图主体：左侧固定星期标签 + 右侧可横滚网格 */}
      <div className="flex items-start gap-2 min-w-0">
        {/* 星期标签（不随内容滚动） */}
        <div
          className="lh-week-labels shrink-0 flex flex-col"
          style={{ paddingTop: MONTH_ROW_H, gap }}
          aria-hidden="true"
        >
          {weekLabels.map((label, i) => (
            <div key={i} style={{ height: cell, lineHeight: `${cell}px` }}>
              {label ?? ''}
            </div>
          ))}
        </div>

        <CustomScrollArea
          viewportRef={scrollRef}
          viewportProps={{ onScroll: clearHover }}
          className="lh-scroll min-w-0 flex-1"
          viewportClassName="pb-1.5"
          orientation="horizontal"
        >
          {loading ? (
            <HeatmapSkeleton weeksCount={grid.weeks.length} cell={cell} gap={gap} />
          ) : (
            <div className="lh-content relative w-max" style={{ width: contentWidth }}>
              {/* 月份标签 */}
              <div className="lh-month-labels" style={{ height: MONTH_ROW_H }} aria-hidden="true">
                {grid.monthMarks.map(({ weekIndex, month }) => (
                  <span key={`${weekIndex}-${month}`} style={{ left: weekIndex * step }}>
                    {t(`calendar.month${month + 1}`)}
                  </span>
                ))}
              </div>

              {/* 网格 */}
              <div
                className="lh-grid"
                style={{
                  gridTemplateRows: `repeat(7, ${cell}px)`,
                  gridAutoColumns: `${cell}px`,
                  gap,
                }}
                onMouseOver={handleGridOver}
                onMouseLeave={clearHover}
                onClick={handleGridClick}
                role="img"
                aria-label={t('heatmap.totalActivities', { count: totalActivities })}
              >
                {grid.weeks.map(week =>
                  week.map(day => {
                    if (day > grid.today) {
                      return <div key={day.getTime()} className="lh-cell lh-cell-future" />;
                    }
                    const dateKey = toDateKey(day);
                    const count = byDate.get(dateKey)?.count ?? 0;
                    return (
                      <div
                        key={dateKey}
                        className={cn('lh-cell', dateKey === todayKey && 'is-today')}
                        data-level={levelOf(count)}
                        data-date={dateKey}
                      />
                    );
                  })
                )}
              </div>

              {/* 单例 tooltip */}
              {hover && <HeatmapTooltip hover={hover} />}
            </div>
          )}
        </CustomScrollArea>
      </div>

      {/* 图例 */}
      {showLegend && !loading && (
        <div className="flex items-center justify-end gap-2 mt-3 px-1">
          <span className="lh-legend-label">{t('heatmap.legend.less', 'Less')}</span>
          <div className="flex" style={{ gap }}>
            {[0, 1, 2, 3, 4].map(level => (
              <div key={level} className="lh-cell lh-cell-static" data-level={level} />
            ))}
          </div>
          <span className="lh-legend-label">{t('heatmap.legend.more', 'More')}</span>
        </div>
      )}
    </div>
  );
}

export default LearningHeatmap;
