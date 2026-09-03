/**
 * 数据图表面板 — macOS System Settings 风格
 *
 * 设置页「数据统计」标签页专用：
 * - 分组内嵌列表（grouped inset list）+ 组标题在容器外
 * - 顶部概览指标条 + 时间范围分段控件
 * - 活动趋势（面积图）/ 模型・模块分布（Screen Time 式横向条）
 * - 学习热力图并入分组容器
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { ArrowsClockwise } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/SegmentedControl';
import { LearningHeatmap } from '@/components/LearningHeatmap';
import { useChatV2Stats, type DailyActivity } from '@/hooks/useChatV2Stats';
import {
  LlmUsageApi,
  type UsageSummary,
  type UsageTrendPoint,
  type ModelSummary,
  type CallerTypeSummary,
} from '@/api/llmUsageApi';

// ============================================================================
// 样式常量
// ============================================================================

/** 与设置本体一致的分组容器：无描边、圆角灰填充（bg-muted） */
const GROUP_BOX_CLASS =
  'overflow-hidden rounded-2xl bg-muted';

const TOOLTIP_CONTENT_STYLE: React.CSSProperties = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border) / 0.6)',
  borderRadius: '10px',
  fontSize: '12px',
  boxShadow: '0 8px 24px -6px hsl(var(--foreground) / 0.15)',
  padding: '8px 12px',
};

// ============================================================================
// 工具函数
// ============================================================================

const formatCompactNumber = (num: number): string => {
  if (!Number.isFinite(num)) return '0';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return num.toString();
};

const formatPercentage = (numerator: number, denominator: number): string | null => {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  const percentage = (numerator / denominator) * 100;
  if (percentage <= 0) return '0';
  if (percentage < 0.1) return '<0.1';
  return percentage.toFixed(1);
};

const formatModelName = (modelId: string, t: (key: string) => string): string => {
  if (!modelId) return t('unknown_model');
  if (modelId.startsWith('f_')) return t('custom_config');
  if (modelId.includes('/')) {
    const parts = modelId.split('/');
    return parts[parts.length - 1];
  }
  return modelId;
};

const getCallerDisplayName = (callerType: string, t: (key: string) => string): string => {
  const key = `callerTypes.${callerType}`;
  const translated = t(key);
  return translated !== key ? translated : callerType;
};

const formatDuration = (ms: number | undefined): string => {
  if (!ms) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

/** 统一成 YYYY-MM-DD，避免跨年时按「月-日」误合并 */
const normalizeDateLabel = (value: string): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

// ============================================================================
// 布局原子：分组容器 / 属性行 / 概览指标
// ============================================================================

const Group: React.FC<{
  title?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  boxClassName?: string;
}> = ({ title, right, children, className, boxClassName }) => (
  <section className={cn('min-w-0', className)}>
    {(title || right) && (
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1">
        <h3 className="text-base font-semibold text-foreground/85">{title}</h3>
        {right}
      </div>
    )}
    <div className={cn(GROUP_BOX_CLASS, boxClassName)}>{children}</div>
  </section>
);

const Row: React.FC<{
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
}> = ({ label, value, sub }) => (
  <div className="flex min-h-[38px] items-center justify-between gap-4 px-4 py-1.5">
    <span className="min-w-0 truncate text-[13px] text-foreground">{label}</span>
    <span className="shrink-0 text-right text-[13px] tabular-nums text-muted-foreground">
      {value}
      {sub != null && <span className="ml-1.5 text-xs text-muted-foreground/60">{sub}</span>}
    </span>
  </div>
);

const Metric: React.FC<{
  label: React.ReactNode;
  value: React.ReactNode;
  sub?: React.ReactNode;
}> = ({ label, value, sub }) => (
  <div className="min-w-0 px-4 py-3.5">
    <div className="truncate text-[11px] font-medium text-muted-foreground">{label}</div>
    <div className="mt-1.5 text-[22px] font-semibold leading-none tracking-tight tabular-nums text-foreground">
      {value}
    </div>
    {sub != null && (
      <div className="mt-1.5 truncate text-[11px] text-muted-foreground/70">{sub}</div>
    )}
  </div>
);

const LegendChip: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
    {label}
  </span>
);

const EmptyState: React.FC<{ label: string; className?: string }> = ({ label, className }) => (
  <div className={cn('flex items-center justify-center text-xs text-muted-foreground/50', className)}>
    {label}
  </div>
);


// ============================================================================
// 活动趋势图
// ============================================================================

interface TrendChartProps {
  tokenData: UsageTrendPoint[];
  sessionData: DailyActivity[];
  emptyLabel: string;
  tokensName: string;
  sessionsName: string;
}

const TrendChart: React.FC<TrendChartProps> = ({
  tokenData,
  sessionData,
  emptyLabel,
  tokensName,
  sessionsName,
}) => {
  const combinedData = useMemo(() => {
    const sessionMap = new Map<string, number>();
    for (const session of sessionData) {
      const normalized = normalizeDateLabel(session.date);
      if (normalized) sessionMap.set(normalized, session.sessions);
    }

    return tokenData.map((item) => {
      const normalized = normalizeDateLabel(item.timeLabel);
      // 会话数据只覆盖近 7 天：范围外置 null 断线，而不是画出误导性的 0
      const sessions = normalized && sessionMap.has(normalized) ? sessionMap.get(normalized)! : null;
      const displayLabel = item.timeLabel.includes('-') ? item.timeLabel.slice(5) : item.timeLabel;
      return {
        timeLabel: displayLabel,
        totalTokens: item.totalTokens,
        sessions,
      };
    });
  }, [tokenData, sessionData]);

  if (tokenData.length === 0) {
    return <EmptyState label={emptyLabel} className="h-[220px]" />;
  }

  return (
    <div className="h-[240px] w-full pb-2 pl-1 pr-4 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={combinedData} margin={{ top: 4, right: 0, left: -8, bottom: 0 }}>
          <defs>
            <linearGradient id="dcpTokenGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.18} />
              <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.01} />
            </linearGradient>
            <linearGradient id="dcpSessionGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity={0.14} />
              <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity={0.01} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeOpacity={0.35} />
          <XAxis
            dataKey="timeLabel"
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, opacity: 0.75 }}
            axisLine={false}
            tickLine={false}
            dy={8}
            minTickGap={28}
          />
          <YAxis
            yAxisId="tokens"
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10, opacity: 0.75 }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
            tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : `${v}`)}
          />
          <YAxis
            yAxisId="sessions"
            orientation="right"
            width={32}
            tick={{ fill: 'hsl(var(--success))', fontSize: 10, opacity: 0.8 }}
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
          <Area
            yAxisId="tokens"
            type="monotone"
            dataKey="totalTokens"
            name={tokensName}
            stroke="hsl(var(--primary))"
            strokeWidth={1.5}
            fill="url(#dcpTokenGradient)"
            activeDot={{ r: 3.5, strokeWidth: 0, fill: 'hsl(var(--primary))' }}
            animationDuration={500}
          />
          <Area
            yAxisId="sessions"
            type="monotone"
            dataKey="sessions"
            name={sessionsName}
            stroke="hsl(var(--success))"
            strokeWidth={1.5}
            fill="url(#dcpSessionGradient)"
            connectNulls={false}
            activeDot={{ r: 3.5, strokeWidth: 0, fill: 'hsl(var(--success))' }}
            animationDuration={500}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

// ============================================================================
// 分布条形列表（Screen Time 风格）
// ============================================================================

interface BarListItem {
  name: string;
  value: number;
  percent: string | null;
}

const BarList: React.FC<{ items: BarListItem[]; emptyLabel: string }> = ({ items, emptyLabel }) => {
  if (items.length === 0) {
    return <EmptyState label={emptyLabel} className="h-[120px]" />;
  }

  const maxValue = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className="py-1.5">
      {items.map((item) => (
        <div key={item.name} className="px-4 py-2" title={item.name}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[13px] text-foreground">{item.name}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatCompactNumber(item.value)}
              {item.percent != null && (
                <span className="ml-1.5 text-muted-foreground/60">{item.percent}%</span>
              )}
            </span>
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${Math.max((item.value / maxValue) * 100, 2)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

type RangeDays = '7' | '30' | '90';

export const DataChartsPanel: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation(['data', 'llm_usage', 'common', 'stats']);

  const [rangeDays, setRangeDays] = useState<RangeDays>('30');
  // 趋势图独立的时间范围（与顶部面板级控件解耦）
  const [trendRange, setTrendRange] = useState<RangeDays>('30');
  const [loading, setLoading] = useState(true);
  const [trendLoading, setTrendLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [trends, setTrends] = useState<UsageTrendPoint[]>([]);
  const [byModel, setByModel] = useState<ModelSummary[]>([]);
  const [byCaller, setByCaller] = useState<CallerTypeSummary[]>([]);

  const days = Number(rangeDays);
  const trendDays = Number(trendRange);

  // 会话统计 + 与趋势范围等长的每日会话序列
  const chatStats = useChatV2Stats(false, 30000, trendDays);

  const loadLlmData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const today = new Date().toISOString().split('T')[0];
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - days);
      const start = startDate.toISOString().split('T')[0];

      const [summaryData, modelData, callerData] = await Promise.all([
        LlmUsageApi.getSummary(start, today),
        LlmUsageApi.getByModel(start, today),
        LlmUsageApi.getByCaller(start, today),
      ]);

      setSummary(summaryData);
      setByModel(modelData);
      setByCaller(callerData);
    } catch (err) {
      console.error('[DataChartsPanel] Load error:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [days]);

  const loadTrends = useCallback(async () => {
    try {
      setTrendLoading(true);
      const trendsData = await LlmUsageApi.getTrends(trendDays, 'day');
      setTrends(trendsData);
    } catch (err) {
      console.error('[DataChartsPanel] Trend load error:', err);
    } finally {
      setTrendLoading(false);
    }
  }, [trendDays]);

  useEffect(() => {
    loadLlmData();
  }, [loadLlmData]);

  useEffect(() => {
    loadTrends();
  }, [loadTrends]);

  const tLlm = useCallback((key: string) => t(`llm_usage:${key}`), [t]);

  const modelItems = useMemo<BarListItem[]>(() => {
    // 合并相同显示名称的模型
    const merged = new Map<string, number>();
    byModel.forEach((m) => {
      const displayName = formatModelName(m.modelId, tLlm);
      merged.set(displayName, (merged.get(displayName) ?? 0) + Number(m.requestCount));
    });
    const total = Array.from(merged.values()).reduce((sum, v) => sum + v, 0);
    return Array.from(merged.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, value]) => ({ name, value, percent: formatPercentage(value, total) }));
  }, [byModel, tLlm]);

  const callerItems = useMemo<BarListItem[]>(() => {
    const total = byCaller.reduce((sum, c) => sum + Number(c.requestCount), 0);
    return [...byCaller]
      .sort((a, b) => Number(b.requestCount) - Number(a.requestCount))
      .slice(0, 8)
      .map((c) => ({
        name: c.displayName || getCallerDisplayName(c.callerType, tLlm),
        value: Number(c.requestCount),
        percent: formatPercentage(Number(c.requestCount), total),
      }));
  }, [byCaller, tLlm]);

  const successRate = formatPercentage(
    Number(summary?.successRequests || 0),
    Number(summary?.totalRequests || 0)
  );

  const rangeOptions = useMemo<Array<SegmentedControlOption<RangeDays>>>(
    () => [
      { value: '7', label: t('data:charts_panel.range_7d') },
      { value: '30', label: t('data:charts_panel.range_30d') },
      { value: '90', label: t('data:charts_panel.range_90d') },
    ],
    [t]
  );

  const initialLoading = loading && !summary;

  return (
    <div className={cn('flex w-full flex-col gap-6', className)}>
      {/* 工具栏：说明 + 时间范围 + 刷新 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted-foreground">
          {t('data:statistics_section_subtitle')}
        </p>
        <div className="flex items-center gap-1.5">
          <SegmentedControl<RangeDays>
            ariaLabel={t('data:charts_panel.range_label')}
            value={rangeDays}
            onValueChange={setRangeDays}
            options={rangeOptions}
            itemClassName="[@media(pointer:coarse)]:!min-h-11"
          />
          <DsButton
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('llm_usage:actions.refresh')}
            onClick={() => {
              void loadLlmData();
              void loadTrends();
            }}
            className="h-7 w-7 text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
          >
            <ArrowsClockwise size={14} className={cn((loading || trendLoading) && 'animate-spin')} />
          </DsButton>
        </div>
      </div>

      {error && !summary ? (
        <div className={cn(GROUP_BOX_CLASS, 'flex flex-col items-center gap-2 py-12')}>
          <p className="text-sm text-muted-foreground">{t('llm_usage:no_data_or_load_failed')}</p>
          <p className="max-w-full truncate px-6 font-mono text-xs text-muted-foreground/50">{error}</p>
          <DsButton variant="outline" size="sm" onClick={loadLlmData} className="mt-1 [@media(pointer:coarse)]:!min-h-11">
            <ArrowsClockwise size={13} className="mr-1.5" />
            {t('llm_usage:actions.retry')}
          </DsButton>
        </div>
      ) : initialLoading || chatStats.loading ? (
        <div className="flex flex-col gap-6">
          <Skeleton className="h-[88px] rounded-[10px] bg-muted/20" />
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Skeleton className="h-[220px] rounded-[10px] bg-muted/20" />
            <Skeleton className="h-[220px] rounded-[10px] bg-muted/20" />
          </div>
          <Skeleton className="h-[280px] rounded-[10px] bg-muted/20" />
        </div>
      ) : (
        <>
          {/* 概览指标条 */}
          <Group>
            <div
              className={cn(
                'grid grid-cols-2 sm:grid-cols-4',
                '[&>*]:border-border/50',
                '[&>*:nth-child(even)]:border-l [&>*:nth-child(n+3)]:border-t',
                'sm:[&>*]:border-t-0 sm:[&>*+*]:border-l'
              )}
            >
              <Metric
                label={t('common:chat_stats.total_sessions')}
                value={chatStats.totalSessions.toLocaleString()}
                sub={t('data:charts_panel.sessions_sub', {
                  active: chatStats.activeSessions.toLocaleString(),
                  archived: chatStats.archivedSessions.toLocaleString(),
                })}
              />
              <Metric
                label={t('common:chat_stats.total_messages')}
                value={formatCompactNumber(chatStats.totalMessages)}
                sub={t('data:charts_panel.messages_sub', {
                  user: formatCompactNumber(chatStats.userMessages),
                  ai: formatCompactNumber(chatStats.assistantMessages),
                })}
              />
              <Metric
                label={t('llm_usage:summary.totalCalls')}
                value={formatCompactNumber(Number(summary?.totalRequests || 0))}
                sub={t('data:charts_panel.in_range', { days })}
              />
              <Metric
                label={t('llm_usage:summary.totalTokens')}
                value={formatCompactNumber(Number(summary?.totalTokens || 0))}
                sub={t('llm_usage:summary.tokenBreakdown', {
                  prompt: formatCompactNumber(Number(summary?.totalPromptTokens || 0)),
                  completion: formatCompactNumber(Number(summary?.totalCompletionTokens || 0)),
                })}
              />
            </div>
          </Group>

          {/* 会话 / 模型调用 明细分组 */}
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <Group title={t('data:charts_panel.sessions_group')}>
              <div className="divide-y divide-border/40">
                <Row
                  label={t('common:chat_stats.active_sessions')}
                  value={chatStats.activeSessions.toLocaleString()}
                />
                <Row
                  label={t('common:chat_stats.archived_sessions')}
                  value={chatStats.archivedSessions.toLocaleString()}
                />
                <Row
                  label={t('common:chat_stats.recent_sessions')}
                  value={chatStats.recentSessions.toLocaleString()}
                />
                <Row
                  label={t('common:chat_stats.avg_messages')}
                  value={chatStats.avgMessagesPerSession}
                  sub={t('common:chat_stats.avg_messages_desc')}
                />
              </div>
            </Group>
            <Group title={t('data:charts_panel.llm_group')}>
              <div className="divide-y divide-border/40">
                <Row
                  label={t('llm_usage:summary.successRate')}
                  value={successRate ? `${successRate}%` : '-'}
                  sub={`${summary?.successRequests || 0} / ${summary?.totalRequests || 0}`}
                />
                <Row
                  label={t('llm_usage:summary.avgDuration')}
                  value={formatDuration(summary?.avgDurationMs)}
                  sub={t('llm_usage:summary.perRequestAvg')}
                />
                <Row
                  label={t('llm_usage:summary.promptTokens')}
                  value={formatCompactNumber(Number(summary?.totalPromptTokens || 0))}
                />
                <Row
                  label={t('llm_usage:summary.completionTokens')}
                  value={formatCompactNumber(Number(summary?.totalCompletionTokens || 0))}
                />
              </div>
            </Group>
          </div>

          {/* 活动趋势 — 独立时间范围控件，与顶部面板级控件解耦 */}
          <Group
            title={t('llm_usage:activity_trend')}
            right={
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex items-center gap-3">
                  <LegendChip color="hsl(var(--primary))" label="Tokens" />
                  <LegendChip color="hsl(var(--success))" label={t('llm_usage:sessions')} />
                </div>
                <SegmentedControl<RangeDays>
                  ariaLabel={t('data:charts_panel.trend_range_label')}
                      value={trendRange}
                  onValueChange={setTrendRange}
                  options={rangeOptions}
                  itemClassName="[@media(pointer:coarse)]:!min-h-11"
                />
              </div>
            }
          >
            {trendLoading && trends.length === 0 ? (
              <div className="h-[240px] p-4">
                <Skeleton className="h-full w-full rounded-md bg-muted/20" />
              </div>
            ) : (
              <div className={cn('transition-opacity', trendLoading && 'opacity-50')}>
                <TrendChart
                  tokenData={trends}
                  sessionData={chatStats.dailyActivity}
                  emptyLabel={t('llm_usage:no_data')}
                  tokensName="Tokens"
                  sessionsName={t('llm_usage:sessions')}
                />
              </div>
            )}
          </Group>

          {/* 模型 / 模块分布 */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Group title={t('llm_usage:model_distribution')}>
              <BarList items={modelItems} emptyLabel={t('llm_usage:no_data')} />
            </Group>
            <Group title={t('llm_usage:module_stats')}>
              <BarList items={callerItems} emptyLabel={t('llm_usage:no_data')} />
            </Group>
          </div>

          {/* 学习热力图 */}
          <Group title={t('stats:heatmap.title')}>
            <div className="px-4 pb-3 pt-4">
              <LearningHeatmap months={12} hideTitle showStats={false} showLegend />
            </div>
          </Group>
        </>
      )}
    </div>
  );
};

export default DataChartsPanel;
