/**
 * 学习趋势图表组件
 *
 * 2026-01 新增：时间维度统计与趋势可视化
 * 2026-07 重构：自绘 SVG 图表（学习统计页观感）
 *
 * 功能特性：
 * - 柱状图显示做题数 + 折线/面积图显示正确率（自绘 SVG，无图表库）
 * - 折线路径描画动画、柱条渐入动画（尊重 prefers-reduced-motion）
 * - hover 十字准线 + 内联自绘 tooltip（不使用弹窗库）
 * - 时间范围切换（今日/本周/本月/全部）平滑过渡：已有数据时不整卡闪骨架屏
 * - ResizeObserver 自适应宽度，卸载时清理
 * - 空数据友好占位
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TrendUp, ArrowsClockwise } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import {
  useQuestionBankStore,
  useLearningTrend,
  useLoadingTrend,
  useSelectedDateRange,
  type DateRange,
  type LearningTrendPoint,
} from '@/stores/questionBankStore';
import { useShallow } from 'zustand/react/shallow';
import { clampPercent, normalizePercent } from './percent';
import { parseLocalDate } from './activityDates';

// ============================================================================
// 类型定义
// ============================================================================

export interface LearningTrendChartProps {
  examId?: string;
  className?: string;
  showDateRangeSelector?: boolean;
  onDateRangeChange?: (range: DateRange) => void;
}

// ============================================================================
// 日期范围配置
// ============================================================================

const DATE_RANGE_OPTIONS: DateRange[] = ['today', 'week', 'month', 'quarter', 'all'];

// ============================================================================
// 小工具
// ============================================================================

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** 监听元素宽度（ResizeObserver，卸载时断开） */
function useContainerWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setWidth(entry.contentRect.width);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/** 取一个"好看"的坐标轴上限（1/2/5 × 10^n） */
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const frac = value / base;
  let nice: number;
  if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

// ============================================================================
// 骨架屏组件
// ============================================================================

const ChartSkeleton: React.FC = () => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-8 w-32" />
    </div>
    <div className="grid grid-cols-3 gap-3">
      {[1, 2, 3].map(i => (
        <Skeleton key={i} className="h-16 rounded-lg" />
      ))}
    </div>
    <Skeleton className="h-56 w-full rounded-lg" />
  </div>
);

// ============================================================================
// 空状态组件
// ============================================================================

const EmptyState: React.FC<{ onRefresh?: () => void }> = ({ onRefresh }) => {
  const { t } = useTranslation('stats');

  return (
    <div className="ui-rise-in flex h-64 flex-col items-center justify-center text-center text-muted-foreground">
      <TrendUp size={28} className="mb-3 opacity-40" />
      <p className="text-sm">{t('trendChart.noRecord')}</p>
      {onRefresh && (
        <DsButton variant="ghost" size="sm" className="mt-3" onClick={onRefresh}>
          <ArrowsClockwise size={14} />
          {t('trendChart.refreshData')}
        </DsButton>
      )}
    </div>
  );
};

// ============================================================================
// 自绘 SVG 趋势图
// ============================================================================

const CHART_HEIGHT = 236;
const PAD_TOP = 14;
const PAD_BOTTOM = 26;
const PAD_LEFT = 34;
const PAD_RIGHT = 40;

interface TrendSvgChartProps {
  data: LearningTrendPoint[];
  formatXAxis: (dateStr: string) => string;
  formatTooltipDate: (dateStr: string) => string;
  /** 用于区分不同时间范围，切换时重放入场动画 */
  animationKey: string;
}

const TrendSvgChart: React.FC<TrendSvgChartProps> = ({
  data,
  formatXAxis,
  formatTooltipDate,
  animationKey,
}) => {
  const { t } = useTranslation('stats');
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  const linePathRef = useRef<SVGPathElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // 柱条入场：先以 0 高度渲染，mount 后过渡到真实高度
  const [entered, setEntered] = useState(() => prefersReducedMotion());

  const innerWidth = Math.max(width - PAD_LEFT - PAD_RIGHT, 0);
  const innerHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

  // 几何计算（含除零守卫）
  const geometry = useMemo(() => {
    const n = data.length;
    if (n === 0 || innerWidth <= 0) return null;

    const maxAttempt = niceCeil(Math.max(1, ...data.map(d => d.attempt_count)));
    const xAt = (i: number) => (n === 1
      ? PAD_LEFT + innerWidth / 2
      : PAD_LEFT + (i / (n - 1)) * innerWidth);
    const yAttempt = (v: number) => PAD_TOP + innerHeight - (Math.max(v, 0) / maxAttempt) * innerHeight;
    // correct_rate 后端量纲为 0-100，几何映射只做守卫截断，不再二次换算
    const yRate = (v: number) => PAD_TOP + innerHeight - (clampPercent(v) / 100) * innerHeight;

    const slot = n === 1 ? innerWidth : innerWidth / (n - 1);
    const barWidth = Math.max(2, Math.min(28, slot * 0.55));

    const points = data.map((d, i) => ({
      x: xAt(i),
      yBarTop: yAttempt(d.attempt_count),
      yLine: yRate(d.correct_rate),
      datum: d,
    }));

    const linePath = points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.yLine.toFixed(1)}`)
      .join(' ');
    const baseline = PAD_TOP + innerHeight;
    const areaPath = n > 1
      ? `${linePath} L${points[n - 1].x.toFixed(1)},${baseline} L${points[0].x.toFixed(1)},${baseline} Z`
      : '';

    // Y 轴刻度（做题数，左侧）
    const yTicks = [0, 0.5, 1].map(f => ({
      value: Math.round(maxAttempt * f),
      y: yAttempt(maxAttempt * f),
    }));

    // X 轴标签：最多 ~6 个，首尾必显
    const maxLabels = Math.max(2, Math.min(6, Math.floor(innerWidth / 64)));
    const step = Math.max(1, Math.ceil(n / maxLabels));
    const xTicks = points
      .map((p, i) => ({ ...p, index: i }))
      .filter((_, i) => i % step === 0 || i === n - 1);

    return { points, linePath, areaPath, barWidth, baseline, yTicks, xTicks, maxAttempt };
  }, [data, innerWidth, innerHeight]);

  // 柱条入场触发（数据/范围变化时重放）
  useEffect(() => {
    if (prefersReducedMotion()) {
      setEntered(true);
      return;
    }
    setEntered(false);
    // 双 rAF：确保 0 高度帧已提交，过渡才会播放
    const rafIds: number[] = [];
    rafIds.push(requestAnimationFrame(() => {
      rafIds.push(requestAnimationFrame(() => setEntered(true)));
    }));
    return () => {
      rafIds.forEach(cancelAnimationFrame);
    };
  }, [animationKey, data]);

  // 折线路径描画动画（stroke-dashoffset）
  useEffect(() => {
    const path = linePathRef.current;
    if (!path || !geometry) return;
    if (prefersReducedMotion()) {
      path.style.strokeDasharray = 'none';
      path.style.strokeDashoffset = '0';
      return;
    }
    const length = path.getTotalLength();
    if (!Number.isFinite(length) || length <= 0) return;
    path.style.transition = 'none';
    path.style.strokeDasharray = `${length}`;
    path.style.strokeDashoffset = `${length}`;
    // 强制 reflow，让起始状态先生效
    path.getBoundingClientRect();
    path.style.transition = 'stroke-dashoffset 900ms cubic-bezier(0.22, 1, 0.36, 1)';
    path.style.strokeDashoffset = '0';
  }, [geometry?.linePath, animationKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // hover/触控：根据指针 x 找最近数据点（pointer 事件同时覆盖鼠标移动与触屏 tap）
  const handlePointerLocate = useCallback((e: React.PointerEvent<SVGRectElement>) => {
    if (!geometry) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + PAD_LEFT;
    let nearest = 0;
    let best = Infinity;
    geometry.points.forEach((p, i) => {
      const dist = Math.abs(p.x - x);
      if (dist < best) {
        best = dist;
        nearest = i;
      }
    });
    setHoverIndex(nearest);
  }, [geometry]);

  const handlePointerLeave = useCallback(() => setHoverIndex(null), []);

  const hovered = geometry && hoverIndex !== null ? geometry.points[hoverIndex] ?? null : null;
  // tooltip 防溢出：靠右侧时翻转到准线左边
  const tooltipFlip = hovered ? hovered.x > width * 0.62 : false;

  // 注意：ref 容器在所有分支保持同一个节点，
  // 否则 ResizeObserver 会绑在已卸载的旧节点上，resize 不再重绘。
  if (!geometry) {
    return <div ref={containerRef} className="relative h-64 select-none" />;
  }

  return (
    <div ref={containerRef} className="relative h-64 select-none">
      <svg
        width="100%"
        height={CHART_HEIGHT}
        viewBox={`0 0 ${Math.max(width, 1)} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('trendChart.title')}
      >
        <defs>
          <linearGradient id="qbank-trend-bar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.75} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
          </linearGradient>
          <linearGradient id="qbank-trend-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity={0.22} />
            <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* 横向网格线 + 左轴刻度（做题数） */}
        {geometry.yTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={PAD_LEFT}
              x2={width - PAD_RIGHT}
              y1={tick.y}
              y2={tick.y}
              stroke="hsl(var(--border))"
              strokeOpacity={0.5}
              strokeDasharray="3 3"
            />
            <text
              x={PAD_LEFT - 6}
              y={tick.y + 3.5}
              textAnchor="end"
              fontSize={10}
              fill="hsl(var(--muted-foreground))"
            >
              {tick.value}
            </text>
          </g>
        ))}

        {/* 右轴刻度（正确率 %） */}
        {[0, 50, 100].map(v => (
          <text
            key={v}
            x={width - PAD_RIGHT + 6}
            y={PAD_TOP + innerHeight - (v / 100) * innerHeight + 3.5}
            textAnchor="start"
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
          >
            {v}%
          </text>
        ))}

        {/* 柱状图：做题数（渐入 + 依次错峰） */}
        {geometry.points.map((p, i) => {
          const fullHeight = Math.max(geometry.baseline - p.yBarTop, 0);
          const h = entered ? fullHeight : 0;
          const isDimmed = hoverIndex !== null && hoverIndex !== i;
          return (
            <rect
              key={`bar-${i}`}
              x={p.x - geometry.barWidth / 2}
              y={geometry.baseline - h}
              width={geometry.barWidth}
              height={h}
              rx={Math.min(3, geometry.barWidth / 2)}
              fill="url(#qbank-trend-bar)"
              opacity={isDimmed ? 0.35 : 1}
              style={{
                transition: `y 500ms cubic-bezier(0.22, 1, 0.36, 1) ${i * 18}ms, height 500ms cubic-bezier(0.22, 1, 0.36, 1) ${i * 18}ms, opacity 150ms ease`,
              }}
            />
          );
        })}

        {/* 面积填充：正确率 */}
        {geometry.areaPath && (
          <path
            d={geometry.areaPath}
            fill="url(#qbank-trend-area)"
            className="ui-fade-in-slow"
          />
        )}

        {/* 折线：正确率（路径描画动画） */}
        {data.length > 1 ? (
          <path
            ref={linePathRef}
            d={geometry.linePath}
            fill="none"
            stroke="hsl(var(--success))"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <circle
            cx={geometry.points[0].x}
            cy={geometry.points[0].yLine}
            r={4}
            fill="hsl(var(--success))"
          />
        )}

        {/* X 轴标签 */}
        {geometry.xTicks.map((tick) => (
          <text
            key={`x-${tick.index}`}
            x={tick.x}
            y={CHART_HEIGHT - 8}
            textAnchor="middle"
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
          >
            {formatXAxis(tick.datum.date)}
          </text>
        ))}

        {/* hover 十字准线 + 高亮点 */}
        {hovered && (
          <g pointerEvents="none">
            <line
              x1={hovered.x}
              x2={hovered.x}
              y1={PAD_TOP}
              y2={geometry.baseline}
              stroke="hsl(var(--foreground))"
              strokeOpacity={0.28}
              strokeDasharray="4 3"
            />
            <line
              x1={PAD_LEFT}
              x2={width - PAD_RIGHT}
              y1={hovered.yLine}
              y2={hovered.yLine}
              stroke="hsl(var(--foreground))"
              strokeOpacity={0.16}
              strokeDasharray="4 3"
            />
            <circle
              cx={hovered.x}
              cy={hovered.yLine}
              r={4.5}
              fill="hsl(var(--success))"
              stroke="hsl(var(--card))"
              strokeWidth={2}
            />
          </g>
        )}

        {/* 指针捕获层（鼠标移动 + 触屏 tap；touch-action 保留纵向滚动） */}
        <rect
          x={PAD_LEFT}
          y={PAD_TOP}
          width={innerWidth}
          height={innerHeight}
          fill="transparent"
          style={{ touchAction: 'pan-y' }}
          onPointerMove={handlePointerLocate}
          onPointerDown={handlePointerLocate}
          onPointerLeave={handlePointerLeave}
        />
      </svg>

      {/* 内联自绘 tooltip（跟随准线，防边缘溢出） */}
      {hovered && (
        <div
          className="absolute z-10 pointer-events-none rounded-lg border border-border bg-popover px-3 py-2 shadow-lg ui-tooltip-in"
          style={{
            left: tooltipFlip ? undefined : Math.round(hovered.x) + 10,
            right: tooltipFlip ? Math.round(width - hovered.x) + 10 : undefined,
            top: Math.min(Math.max(Math.round(hovered.yLine) - 12, 0), CHART_HEIGHT - 108),
          }}
        >
          <div className="text-xs font-medium text-foreground mb-1.5 whitespace-nowrap">
            {formatTooltipDate(hovered.datum.date)}
          </div>
          <div className="space-y-1 text-xs whitespace-nowrap">
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="w-2 h-2 rounded-full bg-primary" />
                {t('trendChart.questionCount')}
              </span>
              <span className="font-medium tabular-nums">{t('trendChart.questionUnit', { count: hovered.datum.attempt_count })}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="w-2 h-2 rounded-full bg-success/60" />
                {t('trendChart.correctCount')}
              </span>
              <span className="font-medium tabular-nums">{t('trendChart.questionUnit', { count: hovered.datum.correct_count })}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span className="w-2 h-2 rounded-full bg-success" />
                {t('trendChart.correctRate')}
              </span>
              <span className="font-medium tabular-nums text-success">{normalizePercent(hovered.datum.correct_rate)}%</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const LearningTrendChart: React.FC<LearningTrendChartProps> = ({
  examId,
  className,
  showDateRangeSelector = true,
  onDateRangeChange,
}) => {
  const { t } = useTranslation('stats');

  // Date range labels
  const dateRangeLabels: Record<DateRange, string> = useMemo(() => ({
    today: t('trendChart.today'),
    week: t('trendChart.week'),
    month: t('trendChart.month'),
    quarter: t('trendChart.quarter'),
    all: t('trendChart.all'),
  }), [t]);

  // Store hooks
  const trendData = useLearningTrend();
  const isLoading = useLoadingTrend();
  const selectedRange = useSelectedDateRange();
  const { loadLearningTrend, setDateRange } = useQuestionBankStore(
    useShallow((state) => ({
      loadLearningTrend: state.loadLearningTrend,
      setDateRange: state.setDateRange,
    }))
  );

  // 区分「初始加载（骨架屏）」和「范围切换（保留图表做透明度过渡）」
  const hasLoadedOnceRef = useRef(false);
  useEffect(() => {
    if (!isLoading) hasLoadedOnceRef.current = true;
  }, [isLoading]);

  // 加载数据
  useEffect(() => {
    loadLearningTrend(examId).catch(console.error);
  }, [examId, selectedRange, loadLearningTrend]);

  // 处理日期范围变化
  const handleDateRangeChange = (range: DateRange) => {
    setDateRange(range);
    onDateRangeChange?.(range);
  };

  // 刷新数据
  const handleRefresh = () => {
    loadLearningTrend(examId).catch(console.error);
  };

  // 格式化 X 轴日期。
  // parseLocalDate：纯日期串按本地时区解析（裸 new Date("YYYY-MM-DD") 是 UTC，
  // 负时区用户 X 轴/tooltip 会整体偏移一天）。
  const formatXAxis = useCallback((dateStr: string) => {
    const date = parseLocalDate(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    // "今日"范围只有带时间戳的数据点才展示钟点；日粒度串仍显示月/日
    if (selectedRange === 'today' && /[T ]\d{2}:/.test(dateStr)) {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  }, [selectedRange]);

  const formatTooltipDate = useCallback((dateStr: string) => {
    const date = parseLocalDate(dateStr);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
    });
  }, []);

  // 计算统计摘要
  const summary = useMemo(() => {
    if (!trendData || trendData.length === 0) {
      return { totalAttempts: 0, avgCorrectRate: 0, activeDays: 0 };
    }

    const totalAttempts = trendData.reduce((sum, d) => sum + d.attempt_count, 0);
    const validDays = trendData.filter(d => d.attempt_count > 0);
    // correct_rate 已是 0-100，平均后仅做守卫取整（normalizePercent），不再 ×100
    const avgCorrectRate = validDays.length > 0
      ? normalizePercent(validDays.reduce((sum, d) => sum + clampPercent(d.correct_rate), 0) / validDays.length)
      : 0;

    return {
      totalAttempts,
      avgCorrectRate,
      activeDays: validDays.length,
    };
  }, [trendData]);

  // 初次加载：整卡骨架屏；已有数据后的重取（如切换范围）：图表区平滑降透明度过渡
  if (isLoading && !hasLoadedOnceRef.current) {
    return (
      <div className={cn('rounded-lg border border-border/50 bg-muted/20 p-4', className)}>
        <ChartSkeleton />
      </div>
    );
  }

  const hasData = trendData && trendData.length > 0 && summary.totalAttempts > 0;

  return (
    <div className={cn('rounded-lg border border-border/50 bg-muted/20 p-4', className)}>
      {/* 标题栏 */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm">
          <TrendUp size={16} className="text-muted-foreground" />
          <span className="font-medium text-foreground">{t('trendChart.title')}</span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* 日期范围选择器（对齐管理页筛选按钮组样式） */}
          {showDateRangeSelector && (
            <div className="flex items-center gap-0.5 rounded-md bg-muted/30 p-0.5">
              {DATE_RANGE_OPTIONS.map((value) => (
                <DsButton
                  key={value}
                  variant="ghost" size="sm"
                  onClick={() => handleDateRangeChange(value)}
                  className={cn(
                    'ui-state-colors !h-auto !px-2 !py-1 text-xs',
                    selectedRange === value
                      ? 'bg-background font-medium shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                  aria-pressed={selectedRange === value}
                >
                  {dateRangeLabels[value]}
                </DsButton>
              ))}
            </div>
          )}

          {/* 刷新按钮 */}
          <DsButton
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleRefresh}
            aria-label={t('trendChart.refreshData')}
          >
            <ArrowsClockwise size={14} className={cn(isLoading && 'animate-spin')} />
          </DsButton>
        </div>
      </div>

      {/* 统计摘要 */}
      {hasData && (
        <div className="mb-4 grid grid-cols-3 gap-2">
          {([
            { value: `${summary.totalAttempts}`, label: t('trendChart.totalQuestions'), dot: 'bg-primary' },
            { value: `${summary.avgCorrectRate}%`, label: t('trendChart.avgCorrectRate'), dot: 'bg-success' },
            { value: `${summary.activeDays}`, label: t('trendChart.activeDays'), dot: 'bg-warning' },
          ] as const).map(({ value, label, dot }) => (
            <div
              key={label}
              className="rounded-md border border-border/40 bg-background/40 p-2.5 transition-colors hover:border-border/80"
            >
              <div className="text-base font-semibold tabular-nums text-foreground">{value}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn('h-1.5 w-1.5 flex-shrink-0 rounded-full', dot)} />
                <span className="truncate">{label}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 图表区域 */}
      {!hasData ? (
        <EmptyState onRefresh={handleRefresh} />
      ) : (
        <div className={cn('transition-opacity duration-200', isLoading && 'opacity-50 pointer-events-none')}>
          <TrendSvgChart
            data={trendData}
            formatXAxis={formatXAxis}
            formatTooltipDate={formatTooltipDate}
            animationKey={selectedRange}
          />
          {/* 图例 */}
          <div className="flex items-center justify-center gap-5 mt-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-primary/60" />
              {t('trendChart.questionCount')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-success" />
              {t('trendChart.correctRate')}
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

export default LearningTrendChart;
