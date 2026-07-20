/**
 * 评分卡片组件 - Notion 风格设计
 * 简洁、留白、细线边框、语义色 token
 * 支持：圆环动画、分数滚动、维度条加载动画、维度雷达图（≥3 维）
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { ParsedScore, DimensionScore } from '../../essay-grading/streamingMarkerParser';
import type { GradeCode } from '../../essay-grading/types';
import { ChartBar, ChartPolar } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';

interface ScoreCardProps {
  score: ParsedScore;
  className?: string;
}

const clampPct = (value: number) => Math.max(0, Math.min(100, value));

/** maxTotal/maxScore 非法（<=0 / NaN / Infinity）时返回 0，避免 NaN 传染到 SVG/样式 */
const safePercentage = (value: number, max: number): number => {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return clampPct((value / max) * 100);
};

const getGradeCodeFromPercentage = (pct: number): GradeCode => {
  if (pct >= 90) return 'excellent';
  if (pct >= 75) return 'good';
  if (pct >= 60) return 'pass';
  return 'fail';
};

/** 等级 → 语义色（excellent=success、good=primary、pass=warning、fail=destructive） */
const GRADE_TEXT_CLASS: Record<GradeCode, string> = {
  excellent: 'text-success',
  good: 'text-primary',
  pass: 'text-warning',
  fail: 'text-destructive',
};

const GRADE_BADGE_CLASS: Record<GradeCode, string> = {
  excellent: 'bg-success/10 text-success',
  good: 'bg-primary/10 text-primary',
  pass: 'bg-warning/10 text-warning',
  fail: 'bg-destructive/10 text-destructive',
};

const GRADE_BAR_CLASS: Record<GradeCode, string> = {
  excellent: 'bg-success',
  good: 'bg-primary',
  pass: 'bg-warning',
  fail: 'bg-destructive',
};

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** 分数数字滚动（rAF 缓动，尊重 prefers-reduced-motion） */
function useCountUp(target: number, duration = 700): number {
  const valueRef = useRef(0);
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!Number.isFinite(target)) {
      valueRef.current = 0;
      setValue(0);
      return;
    }
    if (prefersReducedMotion()) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    const from = valueRef.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = from + (target - from) * eased;
      valueRef.current = next;
      setValue(next);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

/** 目标为整数时取整显示，否则保留一位小数 */
const formatScore = (animated: number, target: number): string =>
  Number.isInteger(target) ? String(Math.round(animated)) : animated.toFixed(1);

const RING_RADIUS = 28;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 维度雷达图（纯 SVG，无外部依赖，≥3 维时使用） */
const RadarChart: React.FC<{ dimensions: DimensionScore[]; mounted: boolean }> = ({ dimensions, mounted }) => {
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const radius = 70;
  const labelRadius = 88;
  const n = dimensions.length;

  const angleAt = (i: number) => ((-90 + (360 / n) * i) * Math.PI) / 180;
  const pointAt = (i: number, r: number): [number, number] => [
    cx + r * Math.cos(angleAt(i)),
    cy + r * Math.sin(angleAt(i)),
  ];

  const gridLevels = [0.25, 0.5, 0.75, 1];
  const gridPolygons = gridLevels.map((level) =>
    dimensions.map((_, i) => pointAt(i, radius * level).join(',')).join(' ')
  );

  const valuePoints = dimensions.map((dim, i) => {
    const ratio = safePercentage(dim.score, dim.maxScore) / 100;
    return pointAt(i, radius * ratio);
  });
  const valuePolygon = valuePoints.map((p) => p.join(',')).join(' ');

  const truncateLabel = (name: string) => (name.length > 6 ? `${name.slice(0, 6)}…` : name);

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      className="w-full max-w-[260px] mx-auto"
      aria-hidden="true"
    >
      {/* 网格 */}
      {gridPolygons.map((points, i) => (
        <polygon
          key={i}
          points={points}
          className={cn('fill-none', i === gridPolygons.length - 1 ? 'stroke-border/60' : 'stroke-border/30')}
          strokeWidth={1}
        />
      ))}
      {/* 轴线 */}
      {dimensions.map((_, i) => {
        const [x, y] = pointAt(i, radius);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            className="stroke-border/30"
            strokeWidth={1}
          />
        );
      })}
      {/* 数值多边形（挂载后缩放淡入） */}
      <g
        className="transition-[transform,opacity] duration-500 ease-out motion-reduce:transition-none"
        style={{
          transformOrigin: `${cx}px ${cy}px`,
          transform: mounted ? 'scale(1)' : 'scale(0.6)',
          opacity: mounted ? 1 : 0,
        }}
      >
        <polygon
          points={valuePolygon}
          className="fill-primary/15 stroke-primary"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {valuePoints.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={2.5} className="fill-primary" />
        ))}
      </g>
      {/* 维度标签 */}
      {dimensions.map((dim, i) => {
        const [x, y] = pointAt(i, labelRadius);
        const cos = Math.cos(angleAt(i));
        const anchor = Math.abs(cos) < 0.3 ? 'middle' : cos > 0 ? 'start' : 'end';
        return (
          <text
            key={i}
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-muted-foreground text-[10px]"
          >
            {truncateLabel(dim.name)}
          </text>
        );
      })}
    </svg>
  );
};

export const ScoreCard: React.FC<ScoreCardProps> = ({ score, className }) => {
  const { t } = useTranslation('essay_grading');

  const percentage = safePercentage(score.total, score.maxTotal);
  const gradeText = GRADE_TEXT_CLASS[score.grade] ?? GRADE_TEXT_CLASS.fail;

  // 挂载后触发进入动画（圆环、进度条、雷达）
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const safeTotal = Number.isFinite(score.total) ? score.total : 0;
  const animatedTotal = useCountUp(safeTotal);
  const displayTotal = formatScore(animatedTotal, safeTotal);
  // maxTotal 非法时显示占位符而不是 NaN
  const displayMaxTotal = Number.isFinite(score.maxTotal) && score.maxTotal > 0 ? score.maxTotal : '—';

  const canShowRadar = score.dimensions.length >= 3;
  const [chartMode, setChartMode] = useState<'bars' | 'radar'>('radar');
  const showRadar = canShowRadar && chartMode === 'radar';

  const ringOffset = mounted
    ? RING_CIRCUMFERENCE * (1 - percentage / 100)
    : RING_CIRCUMFERENCE;

  return (
    <div className={cn('mb-6', className)}>
      {/* 总分区域 */}
      <div className="flex items-start justify-between mb-5">
        <div className="flex items-center gap-4">
          {/* 分数圆环 */}
          <div className="relative w-16 h-16">
            <svg className="w-16 h-16 -rotate-90" viewBox="0 0 64 64">
              <circle
                cx="32"
                cy="32"
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                className="text-muted/20"
              />
              <circle
                cx="32"
                cy="32"
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={ringOffset}
                className={cn(
                  'transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none',
                  gradeText
                )}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className={cn('text-xl font-semibold tabular-nums', gradeText)}>
                {displayTotal}
              </span>
            </div>
          </div>

          <div>
            <div className="flex items-baseline gap-1.5 mb-0.5">
              <span className="text-sm text-muted-foreground">{t('score.total')}</span>
            </div>
            <div className="flex items-baseline gap-0.5">
              <span className={cn('text-3xl font-semibold tabular-nums', gradeText)}>
                {displayTotal}
              </span>
              <span className="text-base text-muted-foreground/60">
                /{displayMaxTotal}
              </span>
            </div>
          </div>
        </div>

        {/* 等级徽章 - 语义色 */}
        <div className={cn(
          'px-3 py-1.5 rounded-md text-sm font-medium',
          GRADE_BADGE_CLASS[score.grade] ?? GRADE_BADGE_CLASS.fail
        )}>
          {t(`score.grade.${score.grade}`)}
        </div>
      </div>

      {/* 总进度条 */}
      <div className="h-1 bg-muted/30 rounded-full overflow-hidden mb-5">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none',
            GRADE_BAR_CLASS[getGradeCodeFromPercentage(percentage)]
          )}
          style={{ width: mounted ? `${percentage}%` : '0%' }}
        />
      </div>

      {/* 分项评分 */}
      {score.dimensions.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide">
              {t('score.dimensions')}
            </div>
            {canShowRadar && (
              <div className="flex items-center gap-0.5 rounded-md border border-border/40 p-0.5">
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  aria-label={t('score.view_bars')}
                  aria-pressed={chartMode === 'bars'}
                  onClick={() => setChartMode('bars')}
                  className={cn(
                    'w-6 h-6',
                    chartMode === 'bars'
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground/50 hover:text-foreground'
                  )}
                >
                  <ChartBar size={13} />
                </NotionButton>
                <NotionButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  aria-label={t('score.view_radar')}
                  aria-pressed={chartMode === 'radar'}
                  onClick={() => setChartMode('radar')}
                  className={cn(
                    'w-6 h-6',
                    chartMode === 'radar'
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground/50 hover:text-foreground'
                  )}
                >
                  <ChartPolar size={13} />
                </NotionButton>
              </div>
            )}
          </div>

          {showRadar ? (
            <div className="space-y-3">
              <RadarChart dimensions={score.dimensions} mounted={mounted} />
              {/* 雷达模式下的分数速览 + 评语 */}
              <div className="space-y-1.5">
                {score.dimensions.map((dim, index) => {
                  const dimPct = safePercentage(dim.score, dim.maxScore);
                  const dimGrade = getGradeCodeFromPercentage(dimPct);
                  return (
                    <div key={index} className="text-xs leading-relaxed">
                      <span className="text-foreground/80">{dim.name}</span>
                      <span className="tabular-nums ml-1.5">
                        <span className={cn('font-medium', GRADE_TEXT_CLASS[dimGrade])}>{dim.score}</span>
                        <span className="text-muted-foreground/50">/{dim.maxScore}</span>
                      </span>
                      {dim.comment && (
                        <span className="text-muted-foreground/60 ml-2">{dim.comment}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {score.dimensions.map((dim, index) => {
                const dimPct = safePercentage(dim.score, dim.maxScore);
                const dimGrade = getGradeCodeFromPercentage(dimPct);
                return (
                  <div key={index} className="group">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm text-foreground/80">{dim.name}</span>
                      <span className="text-sm tabular-nums">
                        <span className={cn('font-medium', GRADE_TEXT_CLASS[dimGrade])}>
                          {dim.score}
                        </span>
                        <span className="text-muted-foreground/50 mx-0.5">/</span>
                        <span className="text-muted-foreground/50">{dim.maxScore}</span>
                      </span>
                    </div>
                    <div className="h-0.5 bg-muted/20 rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
                          GRADE_BAR_CLASS[dimGrade]
                        )}
                        style={{ width: mounted ? `${dimPct}%` : '0%' }}
                      />
                    </div>
                    {dim.comment && (
                      <div className="mt-1.5 text-xs text-muted-foreground/60 leading-relaxed">
                        {dim.comment}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ScoreCard;
