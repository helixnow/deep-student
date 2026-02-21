/**
 * 学习趋势图表组件
 * 
 * 2026-01 新增：时间维度统计与趋势可视化
 * 
 * 功能特性：
 * - 双Y轴：柱状图显示做题数，折线图显示正确率
 * - 时间范围选择：今日/本周/本月/全部
 * - 数据点悬浮提示
 * - Notion 风格 UI
 */

import React, { useEffect, useMemo } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { TrendingUp, Calendar, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { NotionButton } from '@/components/ui/NotionButton';
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

const DATE_RANGE_OPTIONS: DateRange[] = ['today', 'week', 'month', 'all'];

// ============================================================================
// 自定义 Tooltip
// ============================================================================

interface TooltipPayload {
  payload: LearningTrendPoint;
  name: string;
  value: number;
  color: string;
}

const CustomTooltip: React.FC<{
  active?: boolean;
  payload?: TooltipPayload[];
  label?: string;
}> = ({ active, payload, label }) => {
  const { t } = useTranslation('stats');
  
  if (!active || !payload || payload.length === 0) return null;

  const data = payload[0]?.payload;
  if (!data) return null;

  // 格式化日期显示
  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      weekday: 'short',
    });
  };

  return (
    <div className="rounded-lg border border-border bg-popover p-3 shadow-lg">
      <div className="font-medium text-foreground mb-2">{formatDate(data.date)}</div>
      <div className="space-y-1 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t('trendChart.questionCount')}</span>
          <span className="font-medium text-blue-500">{t('trendChart.questionUnit', { count: data.attempt_count })}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t('trendChart.correctCount')}</span>
          <span className="font-medium text-emerald-500">{t('trendChart.questionUnit', { count: data.correct_count })}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t('trendChart.correctRate')}</span>
          <span className="font-medium text-amber-500">{data.correct_rate}%</span>
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 骨架屏组件
// ============================================================================

const ChartSkeleton: React.FC = () => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-8 w-32" />
    </div>
    <Skeleton className="h-64 w-full rounded-lg" />
  </div>
);

// ============================================================================
// 空状态组件
// ============================================================================

const EmptyState: React.FC<{ onRefresh?: () => void }> = ({ onRefresh }) => {
  const { t } = useTranslation('stats');
  
  return (
    <div className="flex flex-col items-center justify-center h-64 text-center">
      <TrendingUp className="w-12 h-12 text-muted-foreground/30 mb-3" />
      <p className="text-muted-foreground mb-4">
        {t('trendChart.noRecord')}
      </p>
      {onRefresh && (
        <NotionButton variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="w-4 h-4 mr-2" />
          {t('trendChart.refreshData')}
        </NotionButton>
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

  // 格式化 X 轴日期
  const formatXAxis = (dateStr: string) => {
    const date = new Date(dateStr);
    if (selectedRange === 'today') {
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  };

  // 计算统计摘要
  const summary = useMemo(() => {
    if (!trendData || trendData.length === 0) {
      return { totalAttempts: 0, avgCorrectRate: 0, activeDays: 0 };
    }

    const totalAttempts = trendData.reduce((sum, d) => sum + d.attempt_count, 0);
    const validDays = trendData.filter(d => d.attempt_count > 0);
    const avgCorrectRate = validDays.length > 0
      ? Math.round(validDays.reduce((sum, d) => sum + d.correct_rate, 0) / validDays.length)
      : 0;

    return {
      totalAttempts,
      avgCorrectRate,
      activeDays: validDays.length,
    };
  }, [trendData]);

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
        <ChartSkeleton />
      </div>
    );
  }

  const hasData = trendData && trendData.length > 0 && summary.totalAttempts > 0;

  return (
    <div className={cn('rounded-xl border border-border bg-card p-5', className)}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-primary" />
          <h3 className="font-semibold">{t('trendChart.title')}</h3>
        </div>
        
        <div className="flex items-center gap-2">
          {/* 日期范围选择器 */}
          {showDateRangeSelector && (
            <div className="flex items-center gap-1 p-1 rounded-lg bg-muted/50">
              {DATE_RANGE_OPTIONS.map((value) => (
                <NotionButton
                  key={value}
                  variant="ghost" size="sm"
                  onClick={() => handleDateRangeChange(value)}
                  className={cn(
                    '!px-3 !py-1.5 !h-auto text-xs font-medium !rounded-md',
                    selectedRange === value
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {dateRangeLabels[value]}
                </NotionButton>
              ))}
            </div>
          )}
          
          {/* 刷新按钮 */}
          <NotionButton
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={handleRefresh}
          >
            <RefreshCw className="w-4 h-4" />
          </NotionButton>
        </div>
      </div>

      {/* 统计摘要 */}
      {hasData && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="rounded-lg bg-blue-500/10 p-3">
            <div className="text-xl font-bold text-blue-600">
              {summary.totalAttempts}
            </div>
            <div className="text-xs text-muted-foreground">{t('trendChart.totalQuestions')}</div>
          </div>
          <div className="rounded-lg bg-emerald-500/10 p-3">
            <div className="text-xl font-bold text-emerald-600">
              {summary.avgCorrectRate}%
            </div>
            <div className="text-xs text-muted-foreground">{t('trendChart.avgCorrectRate')}</div>
          </div>
          <div className="rounded-lg bg-amber-500/10 p-3">
            <div className="text-xl font-bold text-amber-600">
              {summary.activeDays}
            </div>
            <div className="text-xs text-muted-foreground">{t('trendChart.activeDays')}</div>
          </div>
        </div>
      )}

      {/* 图表区域 */}
      {!hasData ? (
        <EmptyState onRefresh={handleRefresh} />
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={trendData}
              margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
            >
              <defs>
                <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.8} />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                </linearGradient>
              </defs>
              
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                opacity={0.5}
                vertical={false}
              />
              
              <XAxis
                dataKey="date"
                tickFormatter={formatXAxis}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                axisLine={{ stroke: 'hsl(var(--border))' }}
                tickLine={false}
                interval="preserveStartEnd"
              />
              
              {/* 左侧 Y 轴 - 做题数 */}
              <YAxis
                yAxisId="left"
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={35}
              />
              
              {/* 右侧 Y 轴 - 正确率 */}
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={[0, 100]}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={35}
                tickFormatter={(v) => `${v}%`}
              />
              
              <Tooltip content={<CustomTooltip />} />
              
              <Legend
                verticalAlign="top"
                height={36}
                iconType="circle"
                iconSize={8}
                formatter={(value) => (
                  <span className="text-xs text-muted-foreground">{value}</span>
                )}
              />
              
              {/* 做题数 - 柱状图 */}
              <Bar
                yAxisId="left"
                dataKey="attempt_count"
                name={t('trendChart.questionCount')}
                fill="url(#barGradient)"
                radius={[4, 4, 0, 0]}
                maxBarSize={40}
              />
              
              {/* 正确率 - 折线图 */}
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="correct_rate"
                name={t('trendChart.correctRate')}
                stroke="hsl(var(--success))"
                strokeWidth={2}
                dot={{ fill: 'hsl(var(--success))', strokeWidth: 0, r: 3 }}
                activeDot={{ r: 5, stroke: 'hsl(var(--success))', strokeWidth: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
};

export default LearningTrendChart;
