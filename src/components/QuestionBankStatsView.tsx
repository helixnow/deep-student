/**
 * 智能题目集统计视图
 *
 * P2-1 功能：图表展示学习进度和统计数据
 *
 * 🆕 2026-01 新增
 * 🆕 2026-01 增强：时间维度统计与趋势可视化
 *   - 时间维度选择器（今日/本周/本月/全部）
 *   - 学习趋势折线图
 *   - 学习热力图
 *   - 知识点掌握度雷达图
 * 🆕 2026-07 增强：学习统计/Anki 风格统计总览
 *   - 核心 KPI 卡置顶（总题数/掌握率/连续天数/今日完成），计数动画 + 入场错峰
 *   - 正确率圆环描画动画
 *   - 分区标题统一（SectionHeader）
 *   - 题型分布与正确率（13 种契约题型）
 *   - 加载态骨架屏（stats 未就绪时）
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from './custom-scroll-area';
import {
  BookOpen,
  CheckCircle,
  Crosshair,
  Fire,
  Lightning,
  TrendUp,
  ChartBar,
  CaretDown,
  CaretUp,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import type { QuestionBankStats } from '@/api/questionBankApi';
import { useShallow } from 'zustand/react/shallow';
import { useActivityHeatmap, useQuestionBankStore } from '@/stores/questionBankStore';
import { LearningTrendChart } from './stats/LearningTrendChart';
import { LearningHeatmapChart } from './stats/LearningHeatmapChart';
import { KnowledgeRadar } from './stats/KnowledgeRadar';
import { QuestionTypeBreakdown } from './stats/QuestionTypeBreakdown';
import { percentOf, ratioToPercent } from './stats/percent';
import { computeCurrentStreak, todayActivityCount } from './stats/activityDates';
import { Skeleton } from './ui/shad/Skeleton';

// ============================================================================
// 类型定义
// ============================================================================

interface QuestionBankStatsViewProps {
  stats: QuestionBankStats | null;
  examId?: string;
  className?: string;
  /** 是否显示详细统计图表（默认 true） */
  showDetailCharts?: boolean;
  /** 是否使用紧凑模式（默认 false） */
  compact?: boolean;
}

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  /** 紧跟数字的单位（如 %），与数字同色同基线 */
  suffix?: string;
  description?: string;
  color?: string;
  /** 入场错峰序号 */
  index?: number;
}

// ============================================================================
// 计数动画 hook（rAF 驱动，尊重 prefers-reduced-motion，卸载时清理）
// ============================================================================

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function useCountUp(target: number, durationMs = 700): number {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const [value, setValue] = useState(() => (prefersReducedMotion() ? safeTarget : 0));
  const fromRef = useRef(prefersReducedMotion() ? safeTarget : 0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      fromRef.current = safeTarget;
      setValue(safeTarget);
      return;
    }
    const from = fromRef.current;
    if (from === safeTarget) {
      setValue(safeTarget);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min((now - start) / durationMs, 1);
      // easeOutCubic：结尾减速，数字停稳
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (safeTarget - from) * eased));
      if (p < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = safeTarget;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      fromRef.current = safeTarget;
    };
  }, [safeTarget, durationMs]);

  return value;
}

// ============================================================================
// 统计卡片组件
// ============================================================================

const StatCard: React.FC<StatCardProps> = ({
  icon,
  label,
  value,
  suffix,
  description,
  color = 'text-primary',
  index = 0,
}) => {
  const animatedValue = useCountUp(value);

  return (
    <div
      className={cn(
        'ui-rise-in flex items-center gap-3 rounded-lg p-3',
        'border border-border/50 bg-muted/30',
        'transition-colors hover:border-border/80 hover:bg-[var(--interactive-hover)]'
      )}
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div className={cn('flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border/40 bg-background/60', color)}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        <div className="flex items-baseline gap-1.5">
          <span className="text-lg font-semibold tabular-nums text-foreground">
            {animatedValue}
            {suffix}
          </span>
          {description && (
            <span className="truncate text-xs tabular-nums text-muted-foreground/70">{description}</span>
          )}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 统一分区标题
// ============================================================================

const SectionHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  right?: React.ReactNode;
}> = ({ icon, title, right }) => (
  <div className="flex items-center justify-between gap-2 text-sm">
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex-shrink-0 text-muted-foreground">{icon}</span>
      <span className="truncate font-medium text-foreground">{title}</span>
    </div>
    {right}
  </div>
);

// ============================================================================
// 骨架屏组件（stats 尚未加载完成时展示）
// ============================================================================

const StatsSkeleton: React.FC<{ className?: string }> = ({ className }) => (
  <CustomScrollArea className={cn('h-full min-h-0', className)} viewportClassName="space-y-6 p-4">
    <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
      {[1, 2, 3, 4].map(i => (
        <Skeleton key={i} className="h-20 rounded-xl" />
      ))}
    </div>
    <Skeleton className="h-3 w-full rounded-full" />
    <Skeleton className="h-10 w-full rounded-lg" />
  </CustomScrollArea>
);

// ============================================================================
// 正确率圆环（计数 + 描画动画）
// ============================================================================

const AccuracyRing: React.FC<{ percent: number }> = ({ percent }) => {
  const clamped = Math.min(Math.max(percent, 0), 100);
  const animated = useCountUp(clamped, 900);
  // r=16 → 周长 ≈ 100.5，百分比直接映射 dasharray
  return (
    <div className="relative w-10 h-10">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
        <circle
          cx="20" cy="20" r="16"
          fill="none" stroke="currentColor" strokeWidth="3"
          strokeDasharray={`${animated * 1.005} 100.5`}
          className="text-success"
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[10px] font-semibold tabular-nums">{animated}%</span>
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const QuestionBankStatsView: React.FC<QuestionBankStatsViewProps> = ({
  stats,
  examId,
  className,
  showDetailCharts = true,
  compact = false,
}) => {
  const { t } = useTranslation(['exam_sheet', 'stats', 'common']);
  const [expandedCharts, setExpandedCharts] = useState(true);
  // stats.correctRate 是 0-1 比例（qbank_get_stats），只在这里换算一次
  const correctRatePercent = ratioToPercent(stats?.correctRate);

  // 连续天数/今日完成：来自活跃度热力图数据（本地时区聚合）
  const heatmapData = useActivityHeatmap();
  const { loadActivityHeatmap } = useQuestionBankStore(
    useShallow((state) => ({ loadActivityHeatmap: state.loadActivityHeatmap }))
  );
  useEffect(() => {
    // 与 LearningHeatmapChart 的默认年份一致（当前年），重复调用幂等
    loadActivityHeatmap(examId).catch(console.error);
  }, [examId, loadActivityHeatmap]);

  // 热力图槽位是全 store 共享的：用户在热力图里翻看往年时，
  // KPI 冻结在最近一次"当前年"数据的计算结果，避免连续天数被历史年份数据打断。
  const activityKpiRef = useRef({ streak: 0, todayCount: 0 });
  const activityKpi = useMemo(() => {
    const currentYearPrefix = String(new Date().getFullYear());
    const isCurrentYearData = heatmapData.length === 0
      || heatmapData.some(d => d.date.startsWith(currentYearPrefix));
    if (!isCurrentYearData) return activityKpiRef.current;
    const next = {
      streak: computeCurrentStreak(heatmapData),
      todayCount: todayActivityCount(heatmapData),
    };
    activityKpiRef.current = next;
    return next;
  }, [heatmapData]);

  const progressData = useMemo(() => {
    if (!stats || stats.total === 0) {
      return {
        masteredPercent: 0,
        inProgressPercent: 0,
        reviewPercent: 0,
        newPercent: 100,
      };
    }

    return {
      masteredPercent: percentOf(stats.mastered, stats.total),
      inProgressPercent: percentOf(stats.inProgress, stats.total),
      reviewPercent: percentOf(stats.review, stats.total),
      newPercent: percentOf(stats.newCount, stats.total),
    };
  }, [stats]);

  // stats 尚未就绪（父级仅在有题目时渲染本视图，此时为加载中）→ 骨架屏
  if (!stats) {
    return <StatsSkeleton className={className} />;
  }

  // 有 stats 但确实没有任何题目 → 空状态占位（对齐管理页空态：图标 + 主文案 + 弱化提示）
  if (stats.total === 0) {
    return (
      <div className={cn('flex h-full items-center justify-center p-8', className)}>
        <div className="ui-rise-in flex flex-col items-center text-muted-foreground">
          <ChartBar size={28} className="mb-3 opacity-40" />
          <p className="text-sm">{t('exam_sheet:questionBank.stats.noData')}</p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            {t('exam_sheet:questionBank.stats.noDataHint')}
          </p>
        </div>
      </div>
    );
  }

  return (
    // h-full + min-h-0 + 内部滚动：父容器（ExamContentView 内容区）是 overflow-hidden，
    // 矮窗口下统计卡片不再被整体裁掉；min-h-0 防止 flex 子项按内容撑开后滚不动
    <CustomScrollArea className={cn('h-full min-h-0', className)} viewportClassName="space-y-6 p-4">
      {/* 核心 KPI 卡（总题数/掌握率/连续天数/今日完成） */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatCard
          icon={<BookOpen size={16} />}
          label={t('stats:overview.total')}
          value={stats.total}
          color="text-primary"
          index={0}
        />
        <StatCard
          icon={<CheckCircle size={16} />}
          label={t('stats:overview.masteryRate')}
          value={progressData.masteredPercent}
          suffix="%"
          description={`${stats.mastered}/${stats.total}`}
          color="text-success"
          index={1}
        />
        <StatCard
          icon={<Fire size={16} />}
          label={t('stats:overview.streak')}
          value={activityKpi.streak}
          description={t('stats:overview.daySuffix')}
          color="text-warning"
          index={2}
        />
        <StatCard
          icon={<Lightning size={16} />}
          label={t('stats:overview.todayDone')}
          value={activityKpi.todayCount}
          description={t('stats:overview.questionSuffix')}
          color="text-info"
          index={3}
        />
      </div>

      {/* 学习进度（与正确率合并为同一层级的分区卡，对齐管理页 border-border/50 + bg-muted/30 层次） */}
      <div className="ui-rise-in rounded-lg border border-border/50 bg-muted/20 p-4" style={{ animationDelay: '160ms' }}>
        <div className="space-y-3">
          <SectionHeader
            icon={<Crosshair size={16} />}
            title={t('exam_sheet:questionBank.stats.progress')}
            right={
              <span className="text-xs tabular-nums text-muted-foreground">{progressData.masteredPercent}%</span>
            }
          />

          {/* 分段进度条 */}
          <div className="relative h-1.5 overflow-hidden rounded-full bg-muted/50">
            <div
              className="absolute left-0 top-0 h-full bg-success transition-all duration-500 ease-out"
              style={{ width: `${progressData.masteredPercent}%` }}
            />
            <div
              className="absolute top-0 h-full bg-warning transition-all duration-500 ease-out"
              style={{
                left: `${progressData.masteredPercent}%`,
                width: `${progressData.inProgressPercent}%`,
              }}
            />
            <div
              className="absolute top-0 h-full bg-destructive/80 transition-all duration-500 ease-out"
              style={{
                left: `${progressData.masteredPercent + progressData.inProgressPercent}%`,
                width: `${progressData.reviewPercent}%`,
              }}
            />
          </div>

          {/* 图例（带各状态计数） */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
            {([
              { dot: 'bg-success', label: t('exam_sheet:questionBank.stats.mastered'), count: stats.mastered },
              { dot: 'bg-warning', label: t('exam_sheet:questionBank.stats.inProgress'), count: stats.inProgress },
              { dot: 'bg-destructive/80', label: t('exam_sheet:questionBank.stats.review'), count: stats.review },
              { dot: 'bg-muted-foreground/30', label: t('exam_sheet:questionBank.stats.new'), count: stats.newCount },
            ] as const).map(({ dot, label, count }) => (
              <span key={label} className="flex items-center gap-1.5 text-muted-foreground">
                <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
                {label}
                <span className="tabular-nums text-muted-foreground/70">{count}</span>
              </span>
            ))}
          </div>
        </div>

        {/* 正确率 */}
        <div className="mt-4 border-t border-border/40 pt-4">
          <SectionHeader
            icon={<TrendUp size={16} />}
            title={t('exam_sheet:questionBank.stats.accuracy')}
            right={
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  {correctRatePercent >= 80
                    ? t('exam_sheet:questionBank.stats.excellent')
                    : correctRatePercent >= 60
                    ? t('exam_sheet:questionBank.stats.good')
                    : correctRatePercent >= 40
                    ? t('exam_sheet:questionBank.stats.needsWork')
                    : t('exam_sheet:questionBank.stats.keepGoing')}
                </span>
                <AccuracyRing percent={correctRatePercent} />
              </div>
            }
          />
        </div>
      </div>

      {/* 详细统计图表区域 */}
      {showDetailCharts && !compact && (
        <>
          {/* 展开/收起：弱化为分隔线上的文字开关，避免整宽按钮的预制感 */}
          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-border/50" />
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => setExpandedCharts(!expandedCharts)}
              className="!h-auto !px-2.5 !py-1.5 [@media(pointer:coarse)]:!min-h-[44px] text-xs text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
              aria-expanded={expandedCharts}
            >
              <ChartBar size={14} />
              <span>{expandedCharts ? t('exam_sheet:questionBank.stats.collapseCharts') : t('exam_sheet:questionBank.stats.expandCharts')}</span>
              {expandedCharts ? <CaretUp size={12} /> : <CaretDown size={12} />}
            </DsButton>
            <div className="h-px flex-1 bg-border/50" />
          </div>

          {/* 图表内容 */}
          {expandedCharts && (
            <div className="ui-drop-in space-y-4">
              {/* 学习趋势图 */}
              <LearningTrendChart
                examId={examId}
                showDateRangeSelector={true}
              />

              {/* 两列布局：热力图 + 雷达图 / 题型分布 */}
              <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
                {/* 学习活跃度热力图 */}
                <LearningHeatmapChart examId={examId} />

                {/* 知识点雷达图 */}
                <KnowledgeRadar
                  examId={examId}
                  showDetailList={true}
                />

                {/* 题型分布与正确率（13 种契约题型） */}
                <QuestionTypeBreakdown className="lg:col-span-2" />
              </div>
            </div>
          )}
        </>
      )}
    </CustomScrollArea>
  );
};

export default QuestionBankStatsView;
