/**
 * LLM 使用统计组件
 *
 * 嵌入式组件，用于在数据统计页面中显示 LLM API 调用统计
 * 遵循 Notion 风格设计：极简、大留白、精致排版
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from 'recharts';
import {
  Lightning,
  Pulse,
  CheckCircle,
  Clock,
  TrendUp,
  Cpu,
  ArrowsClockwise,
} from '@phosphor-icons/react';
import { cn } from '../../lib/utils';
import { Skeleton } from '../ui/shad/Skeleton';
import { NotionButton } from '@/components/ui/NotionButton';
import { LlmUsageApi, UsageSummary, UsageTrendPoint, ModelSummary, CallerTypeSummary } from '../../api/llmUsageApi';
import { useTranslation } from 'react-i18next';

// 主题自适应单色阶梯色板：跟随 --primary 主题色，暗色/浅色模式自动适配
const CHART_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--primary) / 0.72)',
  'hsl(var(--primary) / 0.52)',
  'hsl(var(--primary) / 0.38)',
  'hsl(var(--primary) / 0.26)',
  'hsl(var(--primary) / 0.16)',
];

// 图表卡片统一容器样式
const CHART_CARD_CLASS = 'rounded-xl bg-card ring-1 ring-border/40 shadow-sm p-5';

const TOOLTIP_CONTENT_STYLE: React.CSSProperties = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border) / 0.5)',
  borderRadius: '8px',
  fontSize: '12px',
  boxShadow: '0 8px 24px -6px hsl(var(--foreground) / 0.12)',
  padding: '8px 12px',
};

// 调用方显示名称映射（通过 i18n）
const getCallerDisplayName = (callerType: string, t: (key: string) => string): string => {
  const key = `callerTypes.${callerType}`;
  const translated = t(key);
  return translated !== key ? translated : callerType;
};

// 格式化模型名称
const formatModelName = (modelId: string, t: (key: string) => string): string => {
  if (!modelId) return t('unknown_model');
  
  if (modelId.startsWith('f_')) {
    return t('custom_config');
  }
  
  if (modelId.includes('/')) {
    const parts = modelId.split('/');
    return parts[parts.length - 1];
  }
  
  if (modelId.length > 25) {
    return modelId.slice(0, 22) + '...';
  }
  
  return modelId;
};

const formatCompactNumber = (num: number): string => {
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return num.toString();
};

const formatPercentage = (numerator: number, denominator: number): string | null => {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }

  const percentage = (numerator / denominator) * 100;

  if (percentage <= 0) {
    return '0';
  }

  if (percentage < 0.1) {
    return '<0.1';
  }

  return percentage.toFixed(1);
};

// ============================================================================
// PropRow - 制卡任务风格 property 行
// ============================================================================

const PropRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}> = ({ icon, label, children }) => (
  <div className="grid grid-cols-[120px_1fr] sm:grid-cols-[150px_1fr] items-center py-2 group border-b border-border/20 last:border-0">
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-muted-foreground/40 group-hover:text-muted-foreground/60 transition-colors flex-shrink-0">
        {icon}
      </span>
      <span className="text-[13px] text-muted-foreground truncate">
        {label}
      </span>
    </div>
    <div className="flex items-center gap-1 text-[13px] text-foreground min-w-0 flex-wrap">
      {children}
    </div>
  </div>
);

// ============================================================================
// 合并趋势图（会话趋势 + Token 趋势）
// ============================================================================

interface SessionTrendData {
  date: string;
  displayDate: string;
  sessions: number;
}

interface CombinedTrendProps {
  tokenData: UsageTrendPoint[];
  sessionData?: SessionTrendData[];
}

const CombinedTrend: React.FC<CombinedTrendProps> = ({ tokenData, sessionData }) => {
  const { t } = useTranslation('llm_usage');
  // 使用完整日期匹配，避免跨年时按“月-日”误合并（例如 2025-02-01 匹配到 2026-02-01）
  const normalizeDateLabel = (value: string): string | null => {
    if (!value) return null;
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return trimmed;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toISOString().slice(0, 10);
  };

  const sessionMap = new Map<string, number>();
  for (const session of sessionData ?? []) {
    const normalized = normalizeDateLabel(session.date);
    if (normalized) {
      sessionMap.set(normalized, session.sessions);
    }
  }

  const combinedData = tokenData.map((item) => {
    const normalizedTokenDate = normalizeDateLabel(item.timeLabel);
    const matchingSessions = normalizedTokenDate ? (sessionMap.get(normalizedTokenDate) ?? 0) : 0;

    // 格式化显示的日期标签（去掉年份，只显示 "02-01"）
    const displayLabel = item.timeLabel.includes('-')
      ? item.timeLabel.slice(5)
      : item.timeLabel;

    return {
      timeLabel: displayLabel,
      totalTokens: item.totalTokens,
      sessions: matchingSessions,
    };
  });

  if (tokenData.length === 0) {
    return (
      <div className={CHART_CARD_CLASS}>
        <div className="flex items-center gap-2 mb-4">
          <TrendUp size={16} className="text-muted-foreground/70" />
          <h3 className="font-medium text-sm text-foreground/80">{t('activity_trend')}</h3>
        </div>
        <div className="h-[220px] flex items-center justify-center text-muted-foreground/40 text-xs">
          {t('no_data')}
        </div>
      </div>
    );
  }

  return (
    <div className={CHART_CARD_CLASS}>
      <div className="flex items-center gap-2 mb-5">
        <TrendUp size={16} className="text-muted-foreground/70" />
        <h3 className="font-medium text-sm text-foreground/80">{t('activity_trend')}</h3>
      </div>
      <div className="w-full h-[240px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={combinedData} margin={{ top: 10, right: 0, left: -16, bottom: 0 }}>
            <defs>
              <linearGradient id="tokenTrendGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.22} />
                <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="sessionTrendGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity={0.16} />
                <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.35} />
            <XAxis
              dataKey="timeLabel"
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, opacity: 0.8 }}
              axisLine={false}
              tickLine={false}
              dy={10}
              minTickGap={24}
/>
            {/* 左侧 Y 轴：Token 数 */}
            <YAxis
              yAxisId="tokens"
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, opacity: 0.8 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
              tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
/>
            {/* 右侧 Y 轴：会话数（整数刻度，避免 0.25 / 0.5 这类小数） */}
            <YAxis
              yAxisId="sessions"
              orientation="right"
              width={36}
              tick={{ fill: 'hsl(var(--success))', fontSize: 10, opacity: 0.85 }}
              axisLine={false}
              tickLine={false}
              allowDecimals={false}
/>
            <Tooltip
              contentStyle={TOOLTIP_CONTENT_STYLE}
              labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px', fontSize: '10px' }}
              itemStyle={{ fontWeight: 500 }}
              formatter={(value: number, name: string) => [value.toLocaleString(), name]}
              cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.3 }}
/>
            <Legend
              verticalAlign="top"
              align="right"
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: '11px', paddingBottom: '10px' }}
              formatter={(value) => <span className="text-muted-foreground/80">{value}</span>}
/>
            <Area
              yAxisId="tokens"
              type="monotone"
              dataKey="totalTokens"
              name="Tokens"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              fill="url(#tokenTrendGradient)"
              activeDot={{ r: 4, strokeWidth: 0, fill: 'hsl(var(--primary))' }}
              animationDuration={700}
/>
            <Area
              yAxisId="sessions"
              type="monotone"
              dataKey="sessions"
              name={t('sessions')}
              stroke="hsl(var(--success))"
              strokeWidth={2}
              fill="url(#sessionTrendGradient)"
              activeDot={{ r: 4, strokeWidth: 0, fill: 'hsl(var(--success))' }}
              animationDuration={700}
/>
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

// ============================================================================
// DonutChart - 通用环形图（中心数值 + 交互高亮 + 图例联动）
// ============================================================================

interface DonutDatum {
  name: string;
  value: number;
  percent: string | null;
  fill: string;
}

interface DonutChartProps {
  icon: React.ReactNode;
  title: string;
  data: DonutDatum[];
  /** 中心默认展示的副标签，如"累计请求" */
  centerLabel: string;
}

const DonutChart: React.FC<DonutChartProps> = ({ icon, title, data, centerLabel }) => {
  const { t } = useTranslation('llm_usage');
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const total = data.reduce((sum, d) => sum + d.value, 0);
  const active = activeIndex !== null ? data[activeIndex] : null;

  if (data.length === 0) {
    return (
      <div className={CHART_CARD_CLASS}>
        <div className="flex items-center gap-2 mb-4">
          <span className="text-muted-foreground/70">{icon}</span>
          <h3 className="font-medium text-sm text-foreground/80">{title}</h3>
        </div>
        <div className="h-[220px] flex items-center justify-center text-muted-foreground/40 text-xs">
          {t('no_data')}
        </div>
      </div>
    );
  }

  return (
    <div className={CHART_CARD_CLASS}>
      <div className="flex items-center gap-2 mb-5">
        <span className="text-muted-foreground/70">{icon}</span>
        <h3 className="font-medium text-sm text-foreground/80">{title}</h3>
      </div>
      {/* 小屏纵向堆叠（环形图在上、图例在下），≥sm 恢复左右布局 */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        {/* 环形图 + 中心数值 */}
        <div className="relative h-[220px] w-full min-w-0 sm:flex-1" onMouseLeave={() => setActiveIndex(null)}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius={58}
                outerRadius={82}
                paddingAngle={3}
                dataKey="value"
                strokeWidth={0}
                cornerRadius={4}
                animationDuration={600}
                onMouseEnter={(_, index) => setActiveIndex(index)}
                onMouseLeave={() => setActiveIndex(null)}
                onClick={(_, index) =>
                  setActiveIndex((current) => (current === index ? null : index))
                }
              >
                {data.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={entry.fill}
                    opacity={activeIndex === null || activeIndex === index ? 1 : 0.35}
                    style={{ transition: 'opacity 0.2s ease', outline: 'none' }}
/>
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          {/* 中心数值：默认显示总量，hover 扇区时显示该项 */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-10 text-center">
            <span className="text-2xl font-semibold tracking-tight text-foreground tabular-nums leading-none">
              {formatCompactNumber(active ? active.value : total)}
            </span>
            <span className="text-[11px] text-muted-foreground mt-1.5 max-w-full truncate">
              {active ? `${active.name} · ${active.percent ?? '-'}%` : centerLabel}
            </span>
          </div>
        </div>
        {/* 图例：色点 + 名称 + 右对齐百分比，hover/点按联动高亮 */}
        <div className="flex w-full shrink-0 flex-col justify-center gap-1 sm:w-40">
          {data.map((item, i) => (
            <div
              key={i}
              className={cn(
                'flex items-center justify-between gap-2 rounded-md px-2 py-1.5 cursor-default transition-colors',
                '[@media(pointer:coarse)]:min-h-[2.5rem]',
                activeIndex === i && 'bg-muted/50'
              )}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseLeave={() => setActiveIndex(null)}
              onClick={() => setActiveIndex((current) => (current === i ? null : i))}
            >
              <div className="flex items-center gap-2 min-w-0">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: item.fill }}
/>
                <span className="text-xs text-foreground/80 truncate" title={item.name}>
                  {item.name}
                </span>
              </div>
              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                {item.percent ? `${item.percent}%` : '-'}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 模型分布 / 模块分布 数据整形
// ============================================================================

const ModelDistribution: React.FC<{ data: ModelSummary[] }> = ({ data }) => {
  const { t } = useTranslation('llm_usage');

  const pieData = useMemo<DonutDatum[]>(() => {
    // 合并相同显示名称的模型数据
    const mergedData = new Map<string, number>();
    data.forEach((m) => {
      const displayName = formatModelName(m.modelId, t);
      mergedData.set(displayName, (mergedData.get(displayName) ?? 0) + Number(m.requestCount));
    });

    const total = Array.from(mergedData.values()).reduce((sum, v) => sum + v, 0);
    return Array.from(mergedData.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, value], i) => ({
        name,
        value,
        percent: formatPercentage(value, total),
        fill: CHART_COLORS[i % CHART_COLORS.length],
      }));
  }, [data, t]);

  return (
    <DonutChart
      icon={<Cpu size={16} />}
      title={t('model_distribution')}
      data={pieData}
      centerLabel={t('summary.cumulativeRequests')}
/>
  );
};

const CallerDistribution: React.FC<{ data: CallerTypeSummary[] }> = ({ data }) => {
  const { t } = useTranslation('llm_usage');

  const pieData = useMemo<DonutDatum[]>(() => {
    const total = data.reduce((sum, c) => sum + Number(c.requestCount), 0);
    return [...data]
      .sort((a, b) => Number(b.requestCount) - Number(a.requestCount))
      .map((c, i) => ({
        name: c.displayName || getCallerDisplayName(c.callerType, t),
        value: Number(c.requestCount),
        percent: formatPercentage(Number(c.requestCount), total),
        fill: CHART_COLORS[i % CHART_COLORS.length],
      }));
  }, [data, t]);

  return (
    <DonutChart
      icon={<Pulse size={16} />}
      title={t('module_stats')}
      data={pieData}
      centerLabel={t('summary.cumulativeRequests')}
/>
  );
};

// ============================================================================
// 主组件
// ============================================================================

interface LlmUsageStatsSectionProps {
  className?: string;
  days?: number;
  sessionTrends?: { date: string; displayDate: string; sessions: number }[];
  statsOnly?: boolean;
  chartsOnly?: boolean;
}

export const LlmUsageStatsSection: React.FC<LlmUsageStatsSectionProps> = ({
  className,
  days = 30,
  sessionTrends,
  statsOnly,
  chartsOnly,
}) => {
  const { t } = useTranslation('llm_usage');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [trends, setTrends] = useState<UsageTrendPoint[]>([]);
  const [byModel, setByModel] = useState<ModelSummary[]>([]);
  const [byCaller, setByCaller] = useState<CallerTypeSummary[]>([]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const today = new Date().toISOString().split('T')[0];
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const start = startDate.toISOString().split('T')[0];

      const [summaryData, trendsData, modelData, callerData] = await Promise.all([
        LlmUsageApi.getSummary(start, today),
        LlmUsageApi.getTrends(days, 'day'),
        LlmUsageApi.getByModel(start, today),
        LlmUsageApi.getByCaller(start, today),
      ]);

      setSummary(summaryData);
      setTrends(trendsData);
      setByModel(modelData);
      setByCaller(callerData);
    } catch (err) {
      console.error('[LlmUsageStatsSection] Load error:', err);
      const errorMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const formatNumber = formatCompactNumber;

  const formatDuration = (ms: number | undefined): string => {
    if (!ms) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  if (loading) {
    return (
      <div className={cn('w-full', (statsOnly || chartsOnly) ? '' : 'space-y-8', className)}>
        {!chartsOnly && (
          <div className="space-y-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-7 w-full max-w-md rounded bg-muted/10" />
            ))}
          </div>
        )}
        {!statsOnly && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-4">
            <Skeleton className="h-64 rounded-md bg-muted/10" />
            <Skeleton className="h-64 rounded-md bg-muted/10" />
          </div>
        )}
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('w-full', className)}>
        <div className="flex items-center justify-end mb-4">
          <NotionButton variant="ghost" size="sm" onClick={loadData}>
            <ArrowsClockwise size={14} className="mr-2" />
            {t('actions.retry')}
          </NotionButton>
        </div>
        <div className="py-12 text-center">
          <p className="text-muted-foreground text-sm">{t('no_data_or_load_failed')}</p>
          <p className="text-xs text-muted-foreground/50 mt-1 font-mono">{error}</p>
        </div>
      </div>
    );
  }

  const successRate = formatPercentage(
    Number(summary?.successRequests || 0),
    Number(summary?.totalRequests || 0)
  );

  return (
    <div className={cn('w-full', className)}>
      {/* 刷新按钮 */}
      {!statsOnly && (
        <div className="flex justify-end mb-4">
          <NotionButton variant="ghost" size="sm" onClick={loadData} className="text-muted-foreground hover:text-foreground h-8 px-2">
            <ArrowsClockwise size={14} />
          </NotionButton>
        </div>
      )}

      {/* 统计属性列表 */}
      {!chartsOnly && (
        <div className={statsOnly ? 'space-y-0' : 'space-y-0 mb-8'}>
          <PropRow icon={<Pulse size={14} />} label={t('summary.totalCalls')}>
            <span className="font-semibold tabular-nums">{formatNumber(Number(summary?.totalRequests || 0))}</span>
            <span className="text-muted-foreground/50 ml-1 text-[12px]">
              {t('summary.cumulativeRequests')}
            </span>
          </PropRow>
          <PropRow icon={<Lightning size={14} />} label={t('summary.totalTokens')}>
            <span className="font-semibold tabular-nums">{formatNumber(Number(summary?.totalTokens || 0))}</span>
            <span className="text-muted-foreground/50 ml-1 text-[12px]">
              {t('summary.tokenBreakdown', {
                prompt: formatNumber(Number(summary?.totalPromptTokens || 0)),
                completion: formatNumber(Number(summary?.totalCompletionTokens || 0)),
              })}
            </span>
          </PropRow>
          <PropRow icon={<CheckCircle size={14} />} label={t('summary.successRate')}>
            <span className="font-semibold tabular-nums">{successRate ? `${successRate}%` : '-'}</span>
            <span className="text-muted-foreground/50 ml-1 text-[12px]">
              {summary?.successRequests || 0} / {summary?.totalRequests || 0}
            </span>
          </PropRow>
          <PropRow icon={<Clock size={14} />} label={t('summary.avgDuration')}>
            <span className="tabular-nums">{formatDuration(summary?.avgDurationMs)}</span>
            <span className="text-muted-foreground/50 ml-1 text-[12px]">
              {t('summary.perRequestAvg')}
            </span>
          </PropRow>
        </div>
      )}

      {/* 图表区域：趋势图通栏，两个分布图并排 */}
      {!statsOnly && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="lg:col-span-2">
            <CombinedTrend tokenData={trends} sessionData={sessionTrends} />
          </div>
          <ModelDistribution data={byModel} />
          {byCaller.length > 0 && <CallerDistribution data={byCaller} />}
        </div>
      )}
    </div>
  );
};

export default LlmUsageStatsSection;
