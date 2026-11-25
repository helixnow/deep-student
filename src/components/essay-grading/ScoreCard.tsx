/**
 * 评分卡片组件 - 简洁风格设计
 * 简洁、留白、细线边框、语义色 token
 * 支持：圆环动画、分数滚动、维度条加载动画、维度雷达图（≥3 维）
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { ParsedScore, DimensionScore } from '../../essay-grading/streamingMarkerParser';
import type { GradeCode } from '../../essay-grading/types';
import { wrapRadarLabel } from './radarLabel';
import { getDimensionDisplayName } from '../../essay-grading/modeI18n';
import { ChartBar, ChartPolar, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import {
  formatStaleScoreBadgeText,
  useEssayRubricResultContext,
  type StaleRubricInfo,
} from './rubricResultContext';

interface ScoreCardProps {
  score: ParsedScore;
  className?: string;
  /** 当前批阅模式 ID：预置模式的维度名按界面语言显示（仅展示，不改评分数据） */
  gradingModeId?: string | null;
  /** 可选：显式传入过期标准信息（未传时自动读取 ResultPanel 提供的上下文） */
  staleRubric?: StaleRubricInfo | null;
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

function roundScoreTenth(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/** 统一分值舍入与展示口径：保留至多 1 位小数（若为 .25/.75 等精确分制上限则保留 2 位），避免 IEEE-754 浮点误差或双重舍入漂移 */
export function formatEssayScore(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded2 = Math.round((value + Number.EPSILON) * 100) / 100;
  const rounded1 = roundScoreTenth(value);
  if (Math.abs(rounded2 * 4 - Math.round(rounded2 * 4)) < 1e-6 && Math.abs(rounded2 - rounded1) >= 0.04) {
    return Number.isInteger(rounded2) ? String(rounded2) : String(rounded2);
  }
  return Number.isInteger(rounded1) ? String(rounded1) : rounded1.toFixed(1);
}

const IELTS_MODE_IDS = new Set([
  'ielts',
  'ielts_task1',
  'ielts_task_1',
  'ielts_task2',
  'ielts_writing',
]);

/** 判定是否为雅思 9 分制 Band 评分模式 */
export function isIeltsNineBandMode(gradingModeId?: string | null, maxTotal?: number): boolean {
  const trimmed = gradingModeId?.trim() ?? '';
  if (IELTS_MODE_IDS.has(trimmed)) return true;
  if (!trimmed && typeof maxTotal === 'number' && Number.isFinite(maxTotal) && Math.abs(maxTotal - 9) < 0.01) {
    return true;
  }
  return false;
}

/**
 * 统一总分与分项维度的舍入口径（消除 18.5 vs 18.4 双重舍入或 0.1 算术漂移）：
 * - 对求和制分制（各维满分之和 == maxTotal）：以分项实得总和（四舍五入至 0.1）为准，并用最大余数法保证展示的各维 0.1 分值相加严格等于展示总分。
 * - 非求和制（如雅思 9 分制各维满分均为 9）：保持总分与各维各自精确到 0.1。
 */
export function reconcileEssayScore(score: ParsedScore, isIeltsBand: boolean): ParsedScore {
  const maxTotal = Number.isFinite(score.maxTotal) && score.maxTotal > 0 ? score.maxTotal : 0;
  const rawTotal = Number.isFinite(score.total) ? Math.max(0, Math.min(score.total, maxTotal || score.total)) : 0;
  if (isIeltsBand || score.dimensions.length < 2 || maxTotal <= 0) {
    const roundedTotal = roundScoreTenth(rawTotal);
    const pct = safePercentage(roundedTotal, maxTotal);
    return {
      ...score,
      total: roundedTotal,
      grade: maxTotal > 0 ? getGradeCodeFromPercentage(pct) : score.grade,
      dimensions: score.dimensions.map((d) => ({
        ...d,
        score: roundScoreTenth(Math.max(0, Math.min(d.score, d.maxScore))),
      })),
    };
  }

  const dimsMaxSum = score.dimensions.reduce((sum, dim) => sum + (Number.isFinite(dim.maxScore) ? dim.maxScore : 0), 0);
  const isAdditiveRubric = Math.abs(dimsMaxSum - maxTotal) < 0.05;
  const clampedRawDims = score.dimensions.map((d) => ({
    ...d,
    rawScore: Number.isFinite(d.score) ? Math.max(0, Math.min(d.score, d.maxScore)) : 0,
  }));

  if (!isAdditiveRubric) {
    const roundedTotal = roundScoreTenth(rawTotal);
    const pct = safePercentage(roundedTotal, maxTotal);
    return {
      ...score,
      total: roundedTotal,
      grade: getGradeCodeFromPercentage(pct),
      dimensions: clampedRawDims.map(({ rawScore, ...rest }) => ({
        ...rest,
        score: roundScoreTenth(rawScore),
      })),
    };
  }

  const rawDimSum = clampedRawDims.reduce((sum, d) => sum + d.rawScore, 0);
  const authoritativeTenths = Math.max(
    0,
    Math.min(Math.round((maxTotal + Number.EPSILON) * 10), Math.round((rawDimSum + Number.EPSILON) * 10)),
  );
  const dimTenths = clampedRawDims.map((d) => Math.round((d.rawScore + Number.EPSILON) * 10));
  let diffTenths = authoritativeTenths - dimTenths.reduce((sum, v) => sum + v, 0);

  if (diffTenths !== 0) {
    const remainders = clampedRawDims.map((d, idx) => ({
      idx,
      remainder: d.rawScore * 10 - dimTenths[idx]!,
      maxTenths: Math.round((d.maxScore + Number.EPSILON) * 10),
    }));
    if (diffTenths > 0) {
      remainders.sort((a, b) => b.remainder - a.remainder || a.idx - b.idx);
      for (const item of remainders) {
        if (diffTenths <= 0) break;
        if (dimTenths[item.idx]! < item.maxTenths) {
          dimTenths[item.idx]! += 1;
          diffTenths -= 1;
        }
      }
    } else {
      remainders.sort((a, b) => a.remainder - b.remainder || a.idx - b.idx);
      for (const item of remainders) {
        if (diffTenths >= 0) break;
        if (dimTenths[item.idx]! > 0) {
          dimTenths[item.idx]! -= 1;
          diffTenths += 1;
        }
      }
    }
  }

  const finalTotal = authoritativeTenths / 10;
  const pct = safePercentage(finalTotal, maxTotal);
  return {
    ...score,
    total: finalTotal,
    grade: getGradeCodeFromPercentage(pct),
    dimensions: clampedRawDims.map(({ rawScore: _rawScore, ...rest }, idx) => ({
      ...rest,
      score: dimTenths[idx]! / 10,
    })),
  };
}

const RING_RADIUS = 28;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 维度雷达图（纯 SVG，无外部依赖，≥3 维时使用） */
const RadarChart: React.FC<{ dimensions: DimensionScore[]; mounted: boolean }> = ({ dimensions, mounted }) => {
  // 画布宽于高：两侧留出双行英文标签的排版空间（viewBox 裁剪会吃掉超宽标签）
  const width = 300;
  const height = 220;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 70;
  const labelRadius = 82;
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

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full max-w-[300px] mx-auto"
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
      {/* 维度标签（宽度感知换行，避免英文维度名被截断到不可读） */}
      {dimensions.map((dim, i) => {
        const [x, y] = pointAt(i, labelRadius);
        const cos = Math.cos(angleAt(i));
        const anchor = Math.abs(cos) < 0.3 ? 'middle' : cos > 0 ? 'start' : 'end';
        const lines = wrapRadarLabel(dim.name);
        return (
          <text
            key={i}
            x={x}
            y={y}
            textAnchor={anchor}
            dominantBaseline="middle"
            className="fill-muted-foreground text-[10px]"
          >
            {lines.map((line, li) => (
              <React.Fragment key={li}>
                <tspan
                  x={x}
                  // 多行整体以锚点垂直居中：首行上移 (行数-1)/2 个行高
                  dy={li === 0 ? `${-((lines.length - 1) * 1.15) / 2}em` : '1.15em'}
                >
                  {line}
                </tspan>
                {li < lines.length - 1 ? ' ' : null}
              </React.Fragment>
            ))}
          </text>
        );
      })}
    </svg>
  );
};

export const ScoreCard: React.FC<ScoreCardProps> = ({ score, className, gradingModeId, staleRubric: staleRubricProp }) => {
  const { t } = useTranslation('essay_grading');
  const { staleRubric: contextStaleRubric } = useEssayRubricResultContext();
  const resolvedStaleRubric = staleRubricProp !== undefined ? staleRubricProp : contextStaleRubric;
  const effectiveGradingModeId = resolvedStaleRubric ? resolvedStaleRubric.graded.id : gradingModeId;
  const staleRubricBadgeText = useMemo(
    () => (resolvedStaleRubric ? formatStaleScoreBadgeText(resolvedStaleRubric.graded, t) : null),
    [resolvedStaleRubric, t],
  );
  const isIeltsBand = isIeltsNineBandMode(effectiveGradingModeId, score.maxTotal);
  const normalizedScore = useMemo(
    () => reconcileEssayScore(score, isIeltsBand),
    [score, isIeltsBand],
  );
  const dimensions = useMemo(
    () => normalizedScore.dimensions.map((dim) => ({ ...dim, name: getDimensionDisplayName(effectiveGradingModeId, dim.name, t) })),
    [normalizedScore.dimensions, effectiveGradingModeId, t]
  );

  const percentage = safePercentage(normalizedScore.total, normalizedScore.maxTotal);
  const gradeText = isIeltsBand ? 'text-primary' : (GRADE_TEXT_CLASS[normalizedScore.grade] ?? GRADE_TEXT_CLASS.fail);
  const progressBarClass = isIeltsBand ? 'bg-primary' : (GRADE_BAR_CLASS[normalizedScore.grade] ?? GRADE_BAR_CLASS.fail);

  // 挂载后触发进入动画（圆环、进度条、雷达）
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const safeTotal = Number.isFinite(normalizedScore.total) ? normalizedScore.total : 0;
  const displayTotal = formatEssayScore(safeTotal);
  // maxTotal 非法时显示占位符而不是 NaN
  const displayMaxTotal =
    Number.isFinite(normalizedScore.maxTotal) && normalizedScore.maxTotal > 0 ? formatEssayScore(normalizedScore.maxTotal) : '—';

  const canShowRadar = normalizedScore.dimensions.length >= 3;
  const [chartMode, setChartMode] = useState<'bars' | 'radar'>('radar');
  const showRadar = canShowRadar && chartMode === 'radar';

  const ringOffset = mounted
    ? RING_CIRCUMFERENCE * (1 - percentage / 100)
    : RING_CIRCUMFERENCE;

  return (
    <div
      className={cn(
        'mb-6',
        resolvedStaleRubric && 'rounded-xl border border-amber-500/45 bg-amber-500/[0.04] p-4',
        className,
      )}
      data-stale-rubric={resolvedStaleRubric ? 'true' : undefined}
    >
      {resolvedStaleRubric && staleRubricBadgeText && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span
            data-testid="score-card-stale-rubric-badge"
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/60 bg-amber-100/90 dark:border-amber-400/50 dark:bg-amber-950/70 px-2.5 py-0.5 text-xs font-medium text-amber-950 dark:text-amber-100"
          >
            <WarningCircle size={13} weight="fill" className="shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
            {staleRubricBadgeText}
          </span>
        </div>
      )}
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
              <span className={cn('text-xl font-mono font-semibold tabular-nums tracking-tight', gradeText)}>
                {displayTotal}
              </span>
            </div>
          </div>

          <div>
            <div className="flex items-baseline gap-1.5 mb-0.5">
              <span className="text-xs font-medium text-muted-foreground/75">{t('score.total')}</span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className={cn('text-3xl font-mono font-semibold tabular-nums tracking-tight', gradeText)}>
                {displayTotal}
              </span>
              <span className="text-sm font-mono tabular-nums text-muted-foreground/55">
                /{displayMaxTotal}
              </span>
            </div>
          </div>
        </div>

        {/* 等级徽章 + 得分率胶囊（雅思 9 分制 Band 评分隐藏及格/得分率，避免误导） */}
        {!isIeltsBand && (
          <div className="flex flex-col items-end gap-1.5">
            <div className={cn(
              'px-2.5 py-1 rounded-full text-xs font-medium tracking-wide',
              GRADE_BADGE_CLASS[normalizedScore.grade] ?? GRADE_BADGE_CLASS.fail
            )}>
              {t(`score.grade.${normalizedScore.grade}`)}
            </div>
            {Number.isFinite(normalizedScore.maxTotal) && normalizedScore.maxTotal > 0 && (
              <span
                data-testid="score-card-rate"
                className="text-2xs font-mono tabular-nums text-muted-foreground/80"
              >
                {t('score.rate_label')} {Math.round(percentage)}%
              </span>
            )}
          </div>
        )}
      </div>

      {/* 总进度条：颜色与等级徽章/圆环同源（score.grade），避免两处口径漂移 */}
      <div className="h-[3px] bg-foreground/[0.06] rounded-full overflow-hidden mb-5">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none',
            progressBarClass
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
              <div className="flex items-center gap-0.5 rounded-lg border border-border/35 bg-foreground/[0.02] p-0.5">
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  aria-label={t('score.view_bars')}
                  aria-pressed={chartMode === 'bars'}
                  onClick={() => setChartMode('bars')}
                  className={cn(
                    'w-6 h-6 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11',
                    chartMode === 'bars'
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground/50 hover:text-foreground'
                  )}
                >
                  <ChartBar size={13} />
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  aria-label={t('score.view_radar')}
                  aria-pressed={chartMode === 'radar'}
                  onClick={() => setChartMode('radar')}
                  className={cn(
                    'w-6 h-6 [@media(pointer:coarse)]:!w-11 [@media(pointer:coarse)]:!h-11',
                    chartMode === 'radar'
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground/50 hover:text-foreground'
                  )}
                >
                  <ChartPolar size={13} />
                </DsButton>
              </div>
            )}
          </div>

          {showRadar ? (
            <div className="space-y-3">
              <RadarChart dimensions={dimensions} mounted={mounted} />
              {/* 雷达模式下的分数速览 + 评语 */}
              <div className="space-y-1.5">
                {dimensions.map((dim, index) => {
                  const dimPct = safePercentage(dim.score, dim.maxScore);
                  const dimGrade = getGradeCodeFromPercentage(dimPct);
                  return (
                    <div key={index} className="text-xs leading-relaxed">
                      <span className="text-foreground/80">{dim.name}</span>{' '}
                      <span className="font-mono tabular-nums ml-1.5">
                        <span className={cn('font-medium', isIeltsBand ? 'text-primary' : GRADE_TEXT_CLASS[dimGrade])}>
                          {formatEssayScore(dim.score)}
                        </span>
                        <span className="text-muted-foreground/50">/{formatEssayScore(dim.maxScore)}</span>
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
              {dimensions.map((dim, index) => {
                const dimPct = safePercentage(dim.score, dim.maxScore);
                const dimGrade = getGradeCodeFromPercentage(dimPct);
                return (
                  <div key={index} className="group">
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-sm text-foreground/80">{dim.name}</span>{' '}
                      <span className="text-sm font-mono tabular-nums">
                        <span className={cn('font-medium', isIeltsBand ? 'text-primary' : GRADE_TEXT_CLASS[dimGrade])}>
                          {formatEssayScore(dim.score)}
                        </span>
                        <span className="text-muted-foreground/50 mx-0.5">/</span>
                        <span className="text-muted-foreground/50">{formatEssayScore(dim.maxScore)}</span>
                      </span>
                    </div>
                    <div className="h-[3px] bg-foreground/[0.06] rounded-full overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
                          isIeltsBand ? 'bg-primary' : GRADE_BAR_CLASS[dimGrade]
                        )}
                        style={{ width: mounted ? `${dimPct}%` : '0%', transitionDelay: `${index * 60}ms` }}
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
