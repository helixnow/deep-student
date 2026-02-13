import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  BarChart3,
  Clock,
  Cpu,
  RefreshCw,
  TrendingUp,
  Zap,
  CheckCircle,
  XCircle,
  Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/shad/Card';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/shad/Table';
import { LlmUsageApi, UsageSummary, UsageTrendPoint, ModelSummary, CallerTypeSummary, UsageRecord } from '../../api/llmUsageApi';

const DESIGN = {
  colors: {
    primary: 'hsl(var(--primary))',
    success: 'hsl(var(--success))',
    warning: 'hsl(var(--warning))',
    danger: 'hsl(var(--danger))',
    info: 'hsl(var(--info))',
    chart: [
      'hsl(var(--primary))',
      'hsl(var(--accent))',
      'hsl(var(--info))',
      'hsl(var(--success))',
      'hsl(var(--warning))',
      'hsl(var(--danger))',
      'hsl(210, 70%, 50%)',
      'hsl(280, 70%, 50%)',
    ],
  },
};

type TimeRange = '7' | '30' | '90';

interface LlmUsageStatsPageProps {
  onBack?: () => void;
  embedded?: boolean;
}

export const LlmUsageStatsPage: React.FC<LlmUsageStatsPageProps> = ({ onBack, embedded = false }) => {
  const { t } = useTranslation('llm_usage');
  
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [trends, setTrends] = useState<UsageTrendPoint[]>([]);
  const [byModel, setByModel] = useState<ModelSummary[]>([]);
  const [byCaller, setByCaller] = useState<CallerTypeSummary[]>([]);
  const [recentCalls, setRecentCalls] = useState<UsageRecord[]>([]);
  const [timeRange, setTimeRange] = useState<TimeRange>('30');

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      const today = new Date().toISOString().split('T')[0];
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(timeRange));
      const start = startDate.toISOString().split('T')[0];

      const [summaryData, trendsData, modelData, callerData, recentData] = await Promise.all([
        LlmUsageApi.getSummary(start, today),
        LlmUsageApi.getTrends(parseInt(timeRange), 'day'),
        LlmUsageApi.getByModel(start, today),
        LlmUsageApi.getByCaller(start, today),
        LlmUsageApi.getRecent(20),
      ]);

      setSummary(summaryData);
      setTrends(trendsData);
      setByModel(modelData);
      setByCaller(callerData);
      setRecentCalls(recentData);
    } catch (err) {
      console.error('[LlmUsageStats] Load error:', err);
      const errorMsg = err instanceof Error ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
      setError(errorMsg || t('error.loadFailed'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [timeRange, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  };

  const formatDuration = (ms: number | undefined): string => {
    if (!ms) return '-';
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  const getCallerDisplayName = (callerType: string): string => {
    const key = `callerTypes.${callerType}`;
    const translated = t(key);
    return translated !== key ? translated : callerType;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <XCircle className="w-12 h-12 text-destructive" />
        <p className="text-destructive">{error}</p>
        <NotionButton onClick={() => loadData()}>
          <RefreshCw className="w-4 h-4 mr-2" />
          {t('actions.refresh')}
        </NotionButton>
      </div>
    );
  }

  const successRate = summary && summary.totalRequests > 0
    ? ((summary.successRequests / summary.totalRequests) * 100).toFixed(1)
    : '0';

  const modelPieData = byModel.map((m, i) => ({
    name: m.modelId,
    value: Number(m.totalTokens),
    fill: DESIGN.colors.chart[i % DESIGN.colors.chart.length],
  }));

  const callerPieData = byCaller.map((c, i) => ({
    name: getCallerDisplayName(c.callerType),
    value: Number(c.totalTokens),
    fill: DESIGN.colors.chart[i % DESIGN.colors.chart.length],
  }));

  return (
    <div className={`space-y-6 ${embedded ? '' : 'p-6'}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          {onBack && (
            <NotionButton variant="ghost" size="sm" onClick={onBack}>
              ←
            </NotionButton>
          )}
          <div>
            <h1 className="text-2xl font-bold">{t('title')}</h1>
            <p className="text-muted-foreground text-sm">{t('description')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex border rounded-md">
            {(['7', '30', '90'] as TimeRange[]).map((range) => (
              <NotionButton
                key={range}
                variant={timeRange === range ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setTimeRange(range)}
                className="rounded-none first:rounded-l-md last:rounded-r-md"
              >
                {range}d
              </NotionButton>
            ))}
          </div>
          <NotionButton
            variant="outline"
            size="sm"
            onClick={() => loadData(true)}
            disabled={refreshing}
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            {t('actions.refresh')}
          </NotionButton>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-md bg-primary/10">
                <Activity className="w-4 h-4 text-primary" />
              </div>
              <CardTitle className="text-sm font-medium">{t('summary.totalCalls')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatNumber(Number(summary?.totalRequests || 0))}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-md bg-info/10">
                <Zap className="w-4 h-4 text-info" />
              </div>
              <CardTitle className="text-sm font-medium">{t('summary.totalTokens')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatNumber(Number(summary?.totalTokens || 0))}</div>
            <p className="text-xs text-muted-foreground">
              {t('summary.promptTokens')}: {formatNumber(Number(summary?.totalPromptTokens || 0))} / {t('summary.completionTokens')}: {formatNumber(Number(summary?.totalCompletionTokens || 0))}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-md bg-success/10">
                <CheckCircle className="w-4 h-4 text-success" />
              </div>
              <CardTitle className="text-sm font-medium">{t('summary.successRate')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{successRate}%</div>
            <p className="text-xs text-muted-foreground">
              {summary?.successRequests || 0} / {summary?.totalRequests || 0}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-md bg-warning/10">
                <Clock className="w-4 h-4 text-warning" />
              </div>
              <CardTitle className="text-sm font-medium">{t('summary.avgDuration')}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatDuration(summary?.avgDurationMs)}</div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5" />
              {t('trends.title')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {trends.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={trends} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorTokens" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={DESIGN.colors.primary} stopOpacity={0.3} />
                      <stop offset="95%" stopColor={DESIGN.colors.primary} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="timeLabel" className="text-xs" />
                  <YAxis className="text-xs" tickFormatter={formatNumber} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                    }}
                    formatter={(value: number) => [formatNumber(value), 'Tokens']}
                  />
                  <Area
                    type="monotone"
                    dataKey="totalTokens"
                    stroke={DESIGN.colors.primary}
                    fillOpacity={1}
                    fill="url(#colorTokens)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                {t('empty.description')}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="w-5 h-5" />
              {t('byModel.title')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {modelPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={modelPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, percent }: any) => `${name} (${((percent || 0) * 100).toFixed(0)}%)`}
                    labelLine={false}
                    isAnimationActive={false}
                  >
                    {modelPieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => formatNumber(value)} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                {t('empty.description')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BarChart3 className="w-5 h-5" />
              {t('byCaller.title')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {callerPieData.length > 0 ? (
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={callerPieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={2}
                    dataKey="value"
                    label={({ name, percent }: any) => `${name} (${((percent || 0) * 100).toFixed(0)}%)`}
                    labelLine={false}
                    isAnimationActive={false}
                  >
                    {callerPieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.fill} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => formatNumber(value)} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                {t('empty.description')}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Activity className="w-5 h-5" />
              {t('recent.title')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {recentCalls.length > 0 ? (
              <div className="max-h-[300px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('recent.model')}</TableHead>
                      <TableHead>{t('recent.caller')}</TableHead>
                      <TableHead className="text-right">{t('recent.tokens')}</TableHead>
                      <TableHead className="text-right">{t('recent.status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentCalls.slice(0, 10).map((call) => (
                      <TableRow key={call.id}>
                        <TableCell className="font-mono text-xs">{call.modelId}</TableCell>
                        <TableCell>{getCallerDisplayName(call.callerType)}</TableCell>
                        <TableCell className="text-right">{formatNumber(call.totalTokens)}</TableCell>
                        <TableCell className="text-right">
                          {call.success ? (
                            <CheckCircle className="w-4 h-4 text-success inline" />
                          ) : (
                            <XCircle className="w-4 h-4 text-destructive inline" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[300px] text-muted-foreground">
                {t('empty.description')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default LlmUsageStatsPage;
