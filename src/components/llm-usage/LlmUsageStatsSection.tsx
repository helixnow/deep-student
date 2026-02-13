/**
 * LLM 使用统计组件
 *
 * 嵌入式组件，用于在数据统计页面中显示 LLM API 调用统计
 * 遵循 Notion 风格设计：极简、大留白、精致排版
 */

import React, { useEffect, useState, useCallback } from 'react';
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
  Zap,
  Activity,
  CheckCircle,
  Clock,
  TrendingUp,
  Cpu,
  RefreshCw,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { Skeleton } from '../ui/shad/Skeleton';
import { NotionButton } from '@/components/ui/NotionButton';
import { LlmUsageApi, UsageSummary, UsageTrendPoint, ModelSummary, CallerTypeSummary } from '../../api/llmUsageApi';
import { useTranslation } from 'react-i18next';

// Notion 风格色板 (低饱和度，优雅)
const CHART_COLORS = [
  'hsl(var(--primary))',
  'hsl(210, 20%, 60%)', // 灰蓝
  'hsl(25, 20%, 60%)',  // 暖褐
  'hsl(160, 20%, 50%)', // 灰绿
  'hsl(340, 30%, 65%)', // 柔粉
  'hsl(270, 20%, 60%)', // 灰紫
  'hsl(40, 40%, 60%)',  // 暖黄
];

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

// ============================================================================
// StatCard - Notion风格极简统计卡片
// ============================================================================

interface StatCardProps {
  title: string;
  value: number | string;
  description?: string;
  icon: React.ElementType;
}

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  description,
  icon: Icon,
}) => {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-md hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="w-4 h-4 opacity-70" />
        <span className="text-xs font-medium">{title}</span>
      </div>
      <div className="text-2xl font-semibold tracking-tight text-foreground font-mono tabular-nums">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      {description && (
        <div className="text-[10px] text-muted-foreground/50 truncate">
          {description}
        </div>
      )}
    </div>
  );
};

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
      <div>
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-4 h-4 text-muted-foreground/70" />
          <h3 className="font-medium text-sm text-foreground/80">{t('activity_trend')}</h3>
        </div>
        <div className="h-[220px] flex items-center justify-center text-muted-foreground/40 text-xs">
          {t('no_data')}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-6 pl-1">
        <TrendingUp className="w-4 h-4 text-muted-foreground/70" />
        <h3 className="font-medium text-sm text-foreground/80">{t('activity_trend')}</h3>
      </div>
      <div className="w-full h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={combinedData} margin={{ top: 10, right: 40, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="tokenTrendGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.1} />
                <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="sessionTrendGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="hsl(160, 60%, 50%)" stopOpacity={0.1} />
                <stop offset="95%" stopColor="hsl(160, 60%, 50%)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" opacity={0.4} />
            <XAxis
              dataKey="timeLabel"
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, opacity: 0.8 }}
              axisLine={false}
              tickLine={false}
              dy={10}
            />
            {/* 左侧 Y 轴：Token 数 */}
            <YAxis
              yAxisId="tokens"
              tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, opacity: 0.8 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}
            />
            {/* 右侧 Y 轴：会话数 */}
            <YAxis
              yAxisId="sessions"
              orientation="right"
              tick={{ fill: 'hsl(160, 60%, 50%)', fontSize: 10, opacity: 0.8 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                background: 'hsl(var(--popover))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '6px',
                fontSize: '12px',
                boxShadow: '0 4px 6px -1px hsl(var(--foreground) / 0.1), 0 2px 4px -2px hsl(var(--foreground) / 0.1)',
                padding: '8px 12px',
              }}
              labelStyle={{ color: 'hsl(var(--muted-foreground))', marginBottom: '4px', fontSize: '10px' }}
              itemStyle={{ fontWeight: 500 }}
              formatter={(value: number, name: string) => {
                if (name === 'Tokens') {
                  return [value.toLocaleString(), t('summary.totalTokens')];
                }
                return [value, t('trends.title')];
              }}
              cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1, strokeDasharray: '3 3', opacity: 0.3 }}
            />
            <Legend
              verticalAlign="top"
              align="right"
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: '11px', paddingBottom: '8px' }}
              formatter={(value) => <span className="text-muted-foreground/80">{value}</span>}
            />
            <Area
              yAxisId="tokens"
              type="monotone"
              dataKey="totalTokens"
              name="Tokens"
              stroke="hsl(var(--primary))"
              strokeWidth={1.5}
              fill="url(#tokenTrendGradient)"
              activeDot={{ r: 4, strokeWidth: 0, fill: 'hsl(var(--primary))' }}
              isAnimationActive={false}
            />
            <Area
              yAxisId="sessions"
              type="monotone"
              dataKey="sessions"
              name={t('sessions')}
              stroke="hsl(160, 60%, 50%)"
              strokeWidth={1.5}
              fill="url(#sessionTrendGradient)"
              activeDot={{ r: 4, strokeWidth: 0, fill: 'hsl(160, 60%, 50%)' }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

// ============================================================================
// 模型分布（饼图）
// ============================================================================

interface ModelDistributionProps {
  data: ModelSummary[];
}

const ModelDistribution: React.FC<ModelDistributionProps> = ({ data }) => {
  const { t } = useTranslation('llm_usage');
  if (data.length === 0) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Cpu className="w-4 h-4 text-muted-foreground/70" />
          <h3 className="font-medium text-sm text-foreground/80">{t('model_distribution')}</h3>
        </div>
        <div className="h-[220px] flex items-center justify-center text-muted-foreground/40 text-xs">
          {t('no_data')}
        </div>
      </div>
    );
  }

  // 合并相同显示名称的模型数据
  const mergedData = new Map<string, { value: number; originalIds: string[] }>();
  data.forEach((m) => {
    const displayName = formatModelName(m.modelId, t);
    const existing = mergedData.get(displayName);
    if (existing) {
      existing.value += Number(m.totalTokens);
      existing.originalIds.push(m.modelId);
    } else {
      mergedData.set(displayName, {
        value: Number(m.totalTokens),
        originalIds: [m.modelId],
      });
    }
  });

  const total = Array.from(mergedData.values()).reduce((sum, item) => sum + item.value, 0);
  const pieData = Array.from(mergedData.entries())
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, 6)
    .map(([name, item], i) => ({
      name,
      value: item.value,
      percent: total > 0 ? ((item.value / total) * 100).toFixed(1) : '0',
      fill: CHART_COLORS[i % CHART_COLORS.length],
    }));

  return (
    <div>
      <div className="flex items-center gap-2 mb-6 pl-1">
        <Cpu className="w-4 h-4 text-muted-foreground/70" />
        <h3 className="font-medium text-sm text-foreground/80">{t('model_distribution')}</h3>
      </div>
      <div className="flex items-center">
        {/* 饼图 */}
        <div className="flex-1 h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={70}
                paddingAngle={4}
                dataKey="value"
                strokeWidth={0}
                cornerRadius={3}
                isAnimationActive={false}
              >
                {pieData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px',
                  fontSize: '12px',
                  boxShadow: '0 4px 6px -1px hsl(var(--foreground) / 0.1), 0 2px 4px -2px hsl(var(--foreground) / 0.1)',
                  padding: '8px 12px',
                }}
                labelStyle={{ display: 'none' }}
                itemStyle={{ color: 'hsl(var(--foreground))', fontWeight: 500 }}
                formatter={(value: number, name: string) => [
                  `${value.toLocaleString()} (${pieData.find(d => d.name === name)?.percent}%)`, 
                  name
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        {/* 图例 */}
        <div className="w-32 flex flex-col justify-center gap-3 pr-2">
          {pieData.map((item, i) => (
            <div key={i} className="flex flex-col gap-0.5">
               <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full shrink-0 opacity-80"
                  style={{ backgroundColor: item.fill }}
                />
                <span className="text-xs font-medium text-foreground/80 truncate" title={item.name}>
                  {item.name}
                </span>
              </div>
              <span className="text-[10px] text-muted-foreground pl-4">{item.percent}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 调用方分布（饼图）
// ============================================================================

interface CallerDistributionProps {
  data: CallerTypeSummary[];
}

const CallerDistribution: React.FC<CallerDistributionProps> = ({ data }) => {
  const { t } = useTranslation('llm_usage');
  if (data.length === 0) {
    return (
      <div>
        <div className="flex items-center gap-2 mb-4">
          <Activity className="w-4 h-4 text-muted-foreground/70" />
          <h3 className="font-medium text-sm text-foreground/80">{t('module_stats')}</h3>
        </div>
        <div className="h-[220px] flex items-center justify-center text-muted-foreground/40 text-xs">
          {t('no_data')}
        </div>
      </div>
    );
  }

  // 计算总量和百分比
  const total = data.reduce((sum, c) => sum + Number(c.totalTokens), 0);
  const pieData = data.map((c, i) => ({
    name: c.displayName || getCallerDisplayName(c.callerType, t),
    value: Number(c.totalTokens),
    percent: total > 0 ? ((Number(c.totalTokens) / total) * 100).toFixed(1) : '0',
    fill: CHART_COLORS[i % CHART_COLORS.length],
  }));

  return (
    <div>
      <div className="flex items-center gap-2 mb-6 pl-1">
        <Activity className="w-4 h-4 text-muted-foreground/70" />
        <h3 className="font-medium text-sm text-foreground/80">{t('module_stats')}</h3>
      </div>
      <div className="flex items-center">
        {/* 饼图 */}
        <div className="flex-1 h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={50}
                outerRadius={70}
                paddingAngle={4}
                dataKey="value"
                strokeWidth={0}
                cornerRadius={3}
                isAnimationActive={false}
              >
                {pieData.map((entry, index) => (
                  <Cell key={`cell-${index}`} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px',
                  fontSize: '12px',
                  boxShadow: '0 4px 6px -1px hsl(var(--foreground) / 0.1), 0 2px 4px -2px hsl(var(--foreground) / 0.1)',
                  padding: '8px 12px',
                }}
                labelStyle={{ display: 'none' }}
                itemStyle={{ color: 'hsl(var(--foreground))', fontWeight: 500 }}
                formatter={(value: number, name: string) => [
                  `${value.toLocaleString()} (${pieData.find(d => d.name === name)?.percent}%)`, 
                  name
                ]}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        {/* 图例 */}
        <div className="w-32 flex flex-col justify-center gap-3 pr-2">
          {pieData.map((item, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full shrink-0 opacity-80"
                  style={{ backgroundColor: item.fill }}
                />
                <span className="text-xs font-medium text-foreground/80 truncate" title={item.name}>
                  {item.name}
                </span>
              </div>
               <span className="text-[10px] text-muted-foreground pl-4">{item.percent}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

interface LlmUsageStatsSectionProps {
  className?: string;
  days?: number;
  sessionTrends?: { date: string; displayDate: string; sessions: number }[];
}

export const LlmUsageStatsSection: React.FC<LlmUsageStatsSectionProps> = ({
  className,
  days = 30,
  sessionTrends,
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

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
    return num.toString();
  };

  const formatDuration = (ms: number | undefined): string => {
    if (!ms) return '-';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  if (loading) {
    return (
      <div className={cn('w-full space-y-8', className)}>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-md bg-muted/10" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-4">
          <Skeleton className="h-64 rounded-md bg-muted/10" />
          <Skeleton className="h-64 rounded-md bg-muted/10" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn('w-full', className)}>
        <div className="flex items-center justify-end mb-4">
          <NotionButton variant="ghost" size="sm" onClick={loadData}>
            <RefreshCw className="w-3.5 h-3.5 mr-2" />
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

  const successRate = summary && summary.totalRequests > 0
    ? ((summary.successRequests / summary.totalRequests) * 100).toFixed(1)
    : '0';

  return (
    <div className={cn('w-full', className)}>
      {/* 刷新按钮 */}
      <div className="flex justify-end mb-4">
        <NotionButton variant="ghost" size="sm" onClick={loadData} className="text-muted-foreground hover:text-foreground h-8 px-2">
          <RefreshCw className="w-3.5 h-3.5" />
        </NotionButton>
      </div>

      {/* 统计卡片网格 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        <StatCard
          icon={Activity}
          title={t('summary.totalCalls')}
          value={formatNumber(Number(summary?.totalRequests || 0))}
          description={t('summary.cumulativeRequests')}
        />
        <StatCard
          icon={Zap}
          title={t('summary.totalTokens')}
          value={formatNumber(Number(summary?.totalTokens || 0))}
          description={t('summary.tokenBreakdown', {
            prompt: formatNumber(Number(summary?.totalPromptTokens || 0)),
            completion: formatNumber(Number(summary?.totalCompletionTokens || 0)),
          })}
        />
        <StatCard
          icon={CheckCircle}
          title={t('summary.successRate')}
          value={`${successRate}%`}
          description={`${summary?.successRequests || 0} / ${summary?.totalRequests || 0}`}
        />
        <StatCard
          icon={Clock}
          title={t('summary.avgDuration')}
          value={formatDuration(summary?.avgDurationMs)}
          description={t('summary.perRequestAvg')}
        />
      </div>

      {/* 图表区域 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="min-h-[280px]">
          <CombinedTrend tokenData={trends} sessionData={sessionTrends} />
        </div>
        <div className="min-h-[280px]">
          <ModelDistribution data={byModel} />
        </div>
        
        {/* 单独一行显示模块分布，如果有数据 */}
        {byCaller.length > 0 && (
           <div className="lg:col-span-2 min-h-[280px]">
             <CallerDistribution data={byCaller} />
           </div>
        )}
      </div>
    </div>
  );
};

export default LlmUsageStatsSection;
