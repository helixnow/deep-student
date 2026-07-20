/**
 * 知识点掌握度雷达图组件
 *
 * 2026-01 新增：时间维度统计与趋势可视化
 * 2026-07 重构：自绘 SVG 雷达图
 *
 * 功能特性：
 * - 自绘 SVG 雷达图（无图表库），绘制入场动画（尊重 prefers-reduced-motion）
 * - 各维度 hover 高亮（辐条/顶点/标签联动）+ 内联自绘 tooltip
 * - 掌握度配色分级（语义色，支持暗色模式）
 * - 知识点详情列表与雷达图 hover 联动
 * - ResizeObserver 自适应宽度，卸载时清理；维度 <3 时降级为条形列表
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Brain, ArrowsClockwise, BookOpen } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import {
  useKnowledgeStats,
  useLoadingKnowledge,
  type KnowledgePoint,
} from '@/stores/questionBankStore';
import { useShallow } from 'zustand/react/shallow';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { clampPercent, normalizePercent } from './percent';

// ============================================================================
// 类型定义
// ============================================================================

export interface KnowledgeRadarProps {
  examId?: string;
  className?: string;
  showDetailList?: boolean;
}

interface RadarDatum {
  tag: string;
  fullTag: string;
  mastery_rate: number;
  correct_rate: number;
  total: number;
  mastered: number;
}

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

/** 掌握度配色分级（语义 token，主题/暗色模式感知） */
function masteryTone(rate: number): { text: string; bg: string; stroke: string } {
  if (rate >= 80) return { text: 'text-success', bg: 'bg-success/10', stroke: 'hsl(var(--success))' };
  if (rate >= 60) return { text: 'text-info', bg: 'bg-info/10', stroke: 'hsl(var(--info))' };
  if (rate >= 40) return { text: 'text-warning', bg: 'bg-warning/10', stroke: 'hsl(var(--warning))' };
  return { text: 'text-destructive', bg: 'bg-destructive/10', stroke: 'hsl(var(--destructive))' };
}

// ============================================================================
// 自绘雷达图
// ============================================================================

const RADAR_HEIGHT = 256;
const GRID_LEVELS = [0.25, 0.5, 0.75, 1];

interface RadarSvgProps {
  data: RadarDatum[];
  hoverIndex: number | null;
  onHoverIndexChange: (index: number | null) => void;
}

const RadarSvg: React.FC<RadarSvgProps> = ({ data, hoverIndex, onHoverIndexChange }) => {
  const { t } = useTranslation('stats');
  const [containerRef, width] = useContainerWidth<HTMLDivElement>();
  // 入场动画：从中心缩放 + 淡入
  const [entered, setEntered] = useState(() => prefersReducedMotion());

  useEffect(() => {
    if (prefersReducedMotion()) {
      setEntered(true);
      return;
    }
    setEntered(false);
    const rafIds: number[] = [];
    rafIds.push(requestAnimationFrame(() => {
      rafIds.push(requestAnimationFrame(() => setEntered(true)));
    }));
    return () => rafIds.forEach(cancelAnimationFrame);
  }, [data]);

  const n = data.length;
  const cx = width / 2;
  const cy = RADAR_HEIGHT / 2 + 4;
  const radius = Math.max(Math.min(width, RADAR_HEIGHT) / 2 - 42, 30);

  // 各维度顶点坐标（含除零守卫：n 在调用方保证 >= 3）
  const geometry = useMemo(() => {
    if (n < 3 || width <= 0) return null;

    const angleAt = (i: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const pointAt = (i: number, r: number) => ({
      x: cx + r * Math.cos(angleAt(i)),
      y: cy + r * Math.sin(angleAt(i)),
    });

    const axes = data.map((d, i) => {
      const outer = pointAt(i, radius);
      const label = pointAt(i, radius + 16);
      // *_rate 后端量纲为 0-100，几何映射只做守卫截断（clampPercent）
      const mastery = pointAt(i, (clampPercent(d.mastery_rate) / 100) * radius);
      const correct = pointAt(i, (clampPercent(d.correct_rate) / 100) * radius);
      const cos = Math.cos(angleAt(i));
      const anchor: 'start' | 'middle' | 'end' = cos > 0.35 ? 'start' : cos < -0.35 ? 'end' : 'middle';
      return { outer, label, mastery, correct, anchor, datum: d, index: i };
    });

    const toPoints = (pts: Array<{ x: number; y: number }>) =>
      pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

    const gridPolygons = GRID_LEVELS.map(level =>
      toPoints(data.map((_, i) => pointAt(i, radius * level)))
    );

    // hover 捕获扇形（从圆心到外圈，覆盖该维度 ±半步角度）
    const halfStep = Math.PI / n;
    const wedges = data.map((_, i) => {
      const a = angleAt(i);
      const r = radius + 24;
      const p1 = { x: cx + r * Math.cos(a - halfStep), y: cy + r * Math.sin(a - halfStep) };
      const p2 = { x: cx + r * Math.cos(a + halfStep), y: cy + r * Math.sin(a + halfStep) };
      return `M${cx},${cy} L${p1.x.toFixed(1)},${p1.y.toFixed(1)} A${r},${r} 0 0 1 ${p2.x.toFixed(1)},${p2.y.toFixed(1)} Z`;
    });

    return {
      axes,
      gridPolygons,
      masteryPolygon: toPoints(axes.map(a => a.mastery)),
      correctPolygon: toPoints(axes.map(a => a.correct)),
      wedges,
    };
  }, [data, n, width, cx, cy, radius]);

  // 注意：宽度未知（首帧）时也渲染同一个 ref 容器，保证 ResizeObserver 持续生效
  if (!geometry) {
    return <div ref={containerRef} className="relative h-64 select-none" />;
  }

  const hoveredAxis = hoverIndex !== null && hoverIndex < n ? geometry.axes[hoverIndex] : null;
  const tooltipFlip = hoveredAxis ? hoveredAxis.mastery.x > width * 0.6 : false;

  return (
    <div ref={containerRef} className="relative h-64 select-none">
      <svg
        width="100%"
        height={RADAR_HEIGHT}
        viewBox={`0 0 ${Math.max(width, 1)} ${RADAR_HEIGHT}`}
        role="img"
        aria-label={t('knowledgeRadar.title')}
        onMouseLeave={() => onHoverIndexChange(null)}
      >
        {/* 网格环 */}
        {geometry.gridPolygons.map((points, i) => (
          <polygon
            key={`grid-${i}`}
            points={points}
            fill={i === GRID_LEVELS.length - 1 ? 'hsl(var(--muted) / 0.25)' : 'none'}
            stroke="hsl(var(--border))"
            strokeDasharray="3 3"
            strokeOpacity={0.7}
          />
        ))}

        {/* 辐条 */}
        {geometry.axes.map((axis, i) => (
          <line
            key={`spoke-${i}`}
            x1={cx}
            y1={cy}
            x2={axis.outer.x}
            y2={axis.outer.y}
            stroke={hoverIndex === i ? 'hsl(var(--primary))' : 'hsl(var(--border))'}
            strokeOpacity={hoverIndex === i ? 0.9 : 0.6}
            strokeWidth={hoverIndex === i ? 1.5 : 1}
            style={{ transition: 'stroke 150ms ease, stroke-width 150ms ease' }}
          />
        ))}

        {/* 数据多边形（入场：中心缩放 + 淡入） */}
        <g
          style={{
            transformOrigin: `${cx}px ${cy}px`,
            transform: entered ? 'scale(1)' : 'scale(0.4)',
            opacity: entered ? 1 : 0,
            transition: 'transform 600ms cubic-bezier(0.22, 1, 0.36, 1), opacity 500ms ease',
          }}
        >
          {/* 正确率（虚线，衬底） */}
          <polygon
            points={geometry.correctPolygon}
            fill="hsl(var(--success))"
            fillOpacity={0.12}
            stroke="hsl(var(--success))"
            strokeWidth={1.5}
            strokeDasharray="5 4"
          />
          {/* 掌握度（主面） */}
          <polygon
            points={geometry.masteryPolygon}
            fill="hsl(var(--primary))"
            fillOpacity={0.28}
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {/* 顶点：按掌握度分级着色 */}
          {geometry.axes.map((axis, i) => (
            <circle
              key={`dot-${i}`}
              cx={axis.mastery.x}
              cy={axis.mastery.y}
              r={hoverIndex === i ? 5 : 3}
              fill={masteryTone(normalizePercent(axis.datum.mastery_rate)).stroke}
              stroke="hsl(var(--card))"
              strokeWidth={1.5}
              style={{ transition: 'r 150ms ease' }}
            />
          ))}
        </g>

        {/* 维度标签 */}
        {geometry.axes.map((axis, i) => (
          <text
            key={`label-${i}`}
            x={axis.label.x}
            y={axis.label.y + 3.5}
            textAnchor={axis.anchor}
            fontSize={11}
            fontWeight={hoverIndex === i ? 600 : 400}
            fill={hoverIndex === i ? 'hsl(var(--foreground))' : 'hsl(var(--muted-foreground))'}
            style={{ transition: 'fill 150ms ease' }}
          >
            {axis.datum.tag}
          </text>
        ))}

        {/* hover 捕获扇形（透明，置于最上层）；触屏 tap 切换高亮，重复 tap 收起 */}
        {geometry.wedges.map((d, i) => (
          <path
            key={`wedge-${i}`}
            d={d}
            fill="transparent"
            style={{ touchAction: 'pan-y' }}
            onMouseEnter={() => onHoverIndexChange(i)}
            onPointerDown={(e) => {
              if (e.pointerType === 'touch') {
                onHoverIndexChange(hoverIndex === i ? null : i);
              }
            }}
          />
        ))}
      </svg>

      {/* 内联自绘 tooltip（跟随高亮顶点，防边缘溢出） */}
      {hoveredAxis && (
        <div
          className="absolute z-10 pointer-events-none rounded-lg border border-border bg-popover px-3 py-2 shadow-lg ui-tooltip-in min-w-[150px]"
          style={{
            left: tooltipFlip ? undefined : Math.round(hoveredAxis.mastery.x) + 12,
            right: tooltipFlip ? Math.round(width - hoveredAxis.mastery.x) + 12 : undefined,
            top: Math.min(Math.max(Math.round(hoveredAxis.mastery.y) - 16, 0), RADAR_HEIGHT - 120),
          }}
        >
          <div className="text-xs font-medium text-foreground mb-1.5 pb-1.5 border-b border-border/50 max-w-[180px] truncate">
            {hoveredAxis.datum.fullTag}
          </div>
          <div className="space-y-1 text-xs whitespace-nowrap">
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('knowledgeRadar.mastery')}</span>
              <span className={cn('font-medium tabular-nums', masteryTone(normalizePercent(hoveredAxis.datum.mastery_rate)).text)}>
                {normalizePercent(hoveredAxis.datum.mastery_rate)}%
              </span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('knowledgeRadar.correctRate')}</span>
              <span className="font-medium tabular-nums text-success">{normalizePercent(hoveredAxis.datum.correct_rate)}%</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('knowledgeRadar.questionCount')}</span>
              <span className="font-medium tabular-nums">{t('knowledgeRadar.questionUnit', { count: hoveredAxis.datum.total })}</span>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">{t('knowledgeRadar.mastered')}</span>
              <span className="font-medium tabular-nums">{t('knowledgeRadar.questionUnit', { count: hoveredAxis.datum.mastered })}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// 知识点详情列表项
// ============================================================================

interface KnowledgeItemProps {
  item: KnowledgePoint;
  index: number;
  highlighted: boolean;
  onHover: (index: number | null) => void;
}

const KnowledgeItem: React.FC<KnowledgeItemProps> = ({ item, index, highlighted, onHover }) => {
  const { t } = useTranslation('stats');
  const rate = normalizePercent(item.mastery_rate);
  const tone = masteryTone(rate);

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 rounded-lg transition-colors ui-rise-in',
        highlighted ? 'bg-[var(--interactive-hover)]' : 'hover:bg-[var(--interactive-hover)]'
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      onMouseEnter={() => onHover(index)}
      onMouseLeave={() => onHover(null)}
    >
      {/* 序号 */}
      <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground flex-shrink-0">
        {index + 1}
      </div>

      {/* 知识点名称 */}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{item.tag}</div>
        <div className="text-xs text-muted-foreground">
          {t('knowledgeRadar.itemDetail', { total: item.total, mastered: item.mastered })}
        </div>
      </div>

      {/* 掌握度 */}
      <div className={cn('px-2 py-1 rounded-md text-sm font-medium tabular-nums flex-shrink-0', tone.text, tone.bg)}>
        {rate}%
      </div>

      {/* 进度条 */}
      <div className="w-20 hidden sm:block flex-shrink-0">
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${rate}%`, backgroundColor: tone.stroke }}
          />
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 骨架屏组件
// ============================================================================

const RadarSkeleton: React.FC = () => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="w-8 h-8" />
    </div>
    <Skeleton className="h-64 w-full rounded-lg" />
    <div className="space-y-2">
      {[1, 2, 3].map(i => (
        <Skeleton key={i} className="h-14 rounded-lg" />
      ))}
    </div>
  </div>
);

// ============================================================================
// 空状态组件
// ============================================================================

const EmptyState: React.FC<{ onRefresh?: () => void }> = ({ onRefresh }) => {
  const { t } = useTranslation('stats');

  return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <Brain size={48} className="text-muted-foreground/30 mb-3" weight="light" />
      <p className="text-muted-foreground mb-4">
        {t('knowledgeRadar.noData')}
      </p>
      <p className="text-xs text-muted-foreground mb-4">
        {t('knowledgeRadar.noDataHint')}
      </p>
      {onRefresh && (
        <NotionButton variant="ghost" size="sm" onClick={onRefresh}>
          <ArrowsClockwise size={16} className="mr-2" />
          {t('knowledgeRadar.refreshData')}
        </NotionButton>
      )}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const KnowledgeRadar: React.FC<KnowledgeRadarProps> = ({
  examId,
  className,
  showDetailList = true,
}) => {
  const { t } = useTranslation('stats');

  // Store hooks
  const knowledgeStats = useKnowledgeStats();
  const isLoading = useLoadingKnowledge();
  const { loadKnowledgeStats } = useQuestionBankStore(
    useShallow((state) => ({
      loadKnowledgeStats: state.loadKnowledgeStats,
    }))
  );

  // 雷达图与详情列表联动的 hover 维度（仅前 8 个进入雷达图）
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // 加载数据
  useEffect(() => {
    loadKnowledgeStats(examId).catch(console.error);
  }, [examId, loadKnowledgeStats]);

  // 刷新数据
  const handleRefresh = () => {
    loadKnowledgeStats(examId).catch(console.error);
  };

  // 准备雷达图数据
  const radarData = useMemo<RadarDatum[]>(() => {
    if (!knowledgeStats?.current || knowledgeStats.current.length === 0) {
      return [];
    }

    // 取前 8 个知识点用于雷达图展示
    return knowledgeStats.current.slice(0, 8).map(item => ({
      tag: item.tag.length > 6 ? `${item.tag.slice(0, 6)}…` : item.tag,
      fullTag: item.tag,
      mastery_rate: item.mastery_rate,
      correct_rate: item.correct_rate,
      total: item.total,
      mastered: item.mastered,
    }));
  }, [knowledgeStats]);

  // 计算总体统计
  const overallStats = useMemo(() => {
    if (!knowledgeStats?.current || knowledgeStats.current.length === 0) {
      return { avgMastery: 0, avgCorrectRate: 0, totalKnowledgePoints: 0 };
    }

    const items = knowledgeStats.current;
    // *_rate 已是 0-100，平均后仅做守卫取整（normalizePercent），不再 ×100
    const avgMastery = normalizePercent(
      items.reduce((sum, item) => sum + clampPercent(item.mastery_rate), 0) / items.length
    );
    const avgCorrectRate = normalizePercent(
      items.reduce((sum, item) => sum + clampPercent(item.correct_rate), 0) / items.length
    );

    return {
      avgMastery,
      avgCorrectRate,
      totalKnowledgePoints: items.length,
    };
  }, [knowledgeStats]);

  if (isLoading) {
    return (
      <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
        <RadarSkeleton />
      </div>
    );
  }

  const hasData = radarData.length > 0;

  return (
    <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Brain size={20} className="text-primary" />
          <h3 className="font-semibold">{t('knowledgeRadar.title')}</h3>
        </div>

        <NotionButton
          variant="ghost"
          size="icon"
          className="w-8 h-8"
          onClick={handleRefresh}
          aria-label={t('knowledgeRadar.refreshData')}
        >
          <ArrowsClockwise size={16} />
        </NotionButton>
      </div>

      {/* 总体统计 */}
      {hasData && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-lg bg-primary/10 p-3 text-center transition-transform duration-200 hover:-translate-y-0.5">
            <div className="text-xl font-bold text-primary tabular-nums">
              {overallStats.avgMastery}%
            </div>
            <div className="text-xs text-muted-foreground">{t('knowledgeRadar.avgMastery')}</div>
          </div>
          <div className="rounded-lg bg-success/10 p-3 text-center transition-transform duration-200 hover:-translate-y-0.5">
            <div className="text-xl font-bold text-success tabular-nums">
              {overallStats.avgCorrectRate}%
            </div>
            <div className="text-xs text-muted-foreground">{t('knowledgeRadar.avgCorrectRate')}</div>
          </div>
          <div className="rounded-lg bg-info/10 p-3 text-center transition-transform duration-200 hover:-translate-y-0.5">
            <div className="text-xl font-bold text-info tabular-nums">
              {overallStats.totalKnowledgePoints}
            </div>
            <div className="text-xs text-muted-foreground">{t('knowledgeRadar.knowledgePoints')}</div>
          </div>
        </div>
      )}

      {/* 雷达图（维度不足 3 个时不画雷达，仅展示图例与详情列表） */}
      {!hasData ? (
        <EmptyState onRefresh={handleRefresh} />
      ) : radarData.length >= 3 ? (
        <div className="mb-2">
          <RadarSvg
            data={radarData}
            hoverIndex={hoverIndex}
            onHoverIndexChange={setHoverIndex}
          />
          {/* 图例 */}
          <div className="flex items-center justify-center gap-5 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-primary" />
              {t('knowledgeRadar.mastery')}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-4 border-t-2 border-dashed border-success" />
              {t('knowledgeRadar.correctRate')}
            </span>
          </div>
          {/* 维度过多降级说明：雷达只画 top8，其余走下方列表 */}
          {(knowledgeStats?.current.length ?? 0) > radarData.length && (
            <p className="text-center text-xs text-muted-foreground/80 mt-1.5">
              {t('knowledgeRadar.topHint', {
                shown: radarData.length,
                rest: (knowledgeStats?.current.length ?? 0) - radarData.length,
              })}
            </p>
          )}
        </div>
      ) : null}

      {/* 知识点详情列表 */}
      {showDetailList && hasData && (
        <div className="border-t border-border/50 pt-4 mt-4">
          <div className="flex items-center gap-2 mb-3">
            <BookOpen size={16} className="text-muted-foreground" />
            <span className="text-sm font-medium">{t('knowledgeRadar.details')}</span>
          </div>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {knowledgeStats?.current.map((item, index) => (
              <KnowledgeItem
                key={item.tag}
                item={item}
                index={index}
                highlighted={hoverIndex === index && index < radarData.length}
                onHover={(i) => setHoverIndex(i !== null && i < radarData.length ? i : null)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default KnowledgeRadar;
