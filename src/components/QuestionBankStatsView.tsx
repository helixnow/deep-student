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
  Star,
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
        'group flex items-center gap-3 p-3 rounded-xl ui-rise-in',
        'border border-border/50 bg-muted/30',
        'transition-all duration-200 ease-out',
        'hover:border-border hover:bg-[var(--interactive-hover)] hover:-translate-y-0.5 hover:shadow-sm'
      )}
      style={{ animationDelay: `${index * 40}ms` }}
    >
      <div
        className={cn(
          'p-2 rounded-lg bg-background shadow-sm',
          'transition-transform duration-200 ease-out group-hover:scale-110',
          color
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground truncate">{label}</p>
        <div className="flex items-baseline gap-1.5">
          <span className={cn('text-lg font-semibold tabular-nums', color)}>
            {animatedValue}
            {suffix}
          </span>
          {description && (
            <span className="text-xs text-muted-foreground tabular-nums truncate">{description}</span>
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
  <div className="flex items-center justify-between text-sm">
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="font-medium">{title}</span>
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

  // 有 stats 但确实没有任何题目 → 空状态占位
  if (stats.total === 0) {
    return (
      <div className={cn('flex items-center justify-center p-8', className)}>
        <div className="text-center text-muted-foreground">
          <ChartBar size={28} className="mx-auto mb-2 opacity-50" />
          <p>{t('exam_sheet:questionBank.stats.noData')}</p>
          <p className="mt-1 text-xs">
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
          icon={<BookOpen size={20} />}
          label={t('stats:overview.total')}
          value={stats.total}
          color="text-primary"
          index={0}
        />
        <StatCard
          icon={<CheckCircle size={20} />}
          label={t('stats:overview.masteryRate')}
          value={progressData.masteredPercent}
          suffix="%"
          description={`${stats.mastered}/${stats.total}`}
          color="text-success"
          index={1}
        />
        <StatCard
          icon={<Fire size={20} />}
          label={t('stats:overview.streak')}
          value={activityKpi.streak}
          description={t('stats:overview.daySuffix')}
          color="text-warning"
          index={2}
        />
        <StatCard
          icon={<Lightning size={20} />}
          label={t('stats:overview.todayDone')}
          value={activityKpi.todayCount}
          description={t('stats:overview.questionSuffix')}
          color="text-info"
          index={3}
        />
      </div>

      {/* 学习进度条 */}
      <div className="space-y-3">
        <SectionHeader
          icon={<Crosshair size={16} />}
          title={t('exam_sheet:questionBank.stats.progress')}
          right={
            <span className="text-muted-foreground tabular-nums">{progressData.masteredPercent}%</span>
          }
        />

        {/* 进度条 */}
        <div className="relative h-2 rounded-full bg-muted/50 overflow-hidden">
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
            className="absolute top-0 h-full bg-destructive transition-all duration-500 ease-out"
            style={{
              left: `${progressData.masteredPercent + progressData.inProgressPercent}%`,
              width: `${progressData.reviewPercent}%`,
            }}
          />
        </div>

        {/* 图例（带各状态计数） */}
        <div className="flex items-center gap-4 text-xs flex-wrap">
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-success" />
            <span className="text-muted-foreground">
              {t('exam_sheet:questionBank.stats.mastered')}
              <span className="tabular-nums"> · {stats.mastered}</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-warning" />
            <span className="text-muted-foreground">
              {t('exam_sheet:questionBank.stats.inProgress')}
              <span className="tabular-nums"> · {stats.inProgress}</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-destructive" />
            <span className="text-muted-foreground">
              {t('exam_sheet:questionBank.stats.review')}
              <span className="tabular-nums"> · {stats.review}</span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-muted-foreground/30" />
            <span className="text-muted-foreground">
              {t('exam_sheet:questionBank.stats.new')}
              <span className="tabular-nums"> · {stats.newCount}</span>
            </span>
          </div>
        </div>
      </div>

      {/* 正确率 */}
      <div className="space-y-1">
        <SectionHeader
          icon={<TrendUp size={16} />}
          title={t('exam_sheet:questionBank.stats.accuracy')}
          right={
            <div className="flex items-center gap-3">
              <AccuracyRing percent={correctRatePercent} />
              <div className="flex items-center gap-1 text-xs">
                <Star size={12} className="text-warning" />
                <span className="text-muted-foreground">
                  {correctRatePercent >= 80
                    ? t('exam_sheet:questionBank.stats.excellent')
                    : correctRatePercent >= 60
                    ? t('exam_sheet:questionBank.stats.good')
                    : correctRatePercent >= 40
                    ? t('exam_sheet:questionBank.stats.needsWork')
                    : t('exam_sheet:questionBank.stats.keepGoing')}
                </span>
              </div>
            </div>
          }
        />
      </div>

      {/* 详细统计图表区域 */}
      {showDetailCharts && !compact && (
        <>
          {/* 展开/收起按钮 */}
          <DsButton variant="ghost" size="sm" onClick={() => setExpandedCharts(!expandedCharts)} className="w-full justify-center !py-2 text-muted-foreground hover:text-foreground border-t border-border/50">
            <ChartBar size={16} />
            <span>{expandedCharts ? t('exam_sheet:questionBank.stats.collapseCharts') : t('exam_sheet:questionBank.stats.expandCharts')}</span>
            {expandedCharts ? (
              <CaretUp size={16} />
            ) : (
              <CaretDown size={16} />
            )}
          </DsButton>

          {/* 图表内容 */}
          {expandedCharts && (
            <div className="space-y-6 ui-drop-in">
              {/* 学习趋势图 */}
              <LearningTrendChart
                examId={examId}
                showDateRangeSelector={true}
              />

              {/* 两列布局：热力图 + 雷达图 / 题型分布 */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
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
