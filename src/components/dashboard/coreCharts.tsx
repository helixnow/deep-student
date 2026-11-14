import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Tag, TrendUp } from '@phosphor-icons/react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import { DESIGN } from './design';
import { dashboardCoreCharts, type DashboardChartProps, type DashboardStatistics } from '@/ui-plugins/official/dashboard/api';

interface MonthlyTrendItem {
  month?: unknown;
  count?: unknown;
}

function monthlyTrendOf(statistics: DashboardStatistics) {
  return Array.isArray(statistics.monthly_trend)
    ? statistics.monthly_trend.map((item: MonthlyTrendItem | null | undefined) => ({
        month: typeof item?.month === 'string' ? item.month : '—',
        count: Number(item?.count ?? 0) || 0,
      }))
    : [];
}

function topTagsOf(statistics: DashboardStatistics) {
  return Object.entries(statistics.basic_stats?.tag_stats || {})
    .map(([name, value]) => ({ name, value: Number(value) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

const DataTrendChart: React.FC<DashboardChartProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  const monthlyTrend = useMemo(() => monthlyTrendOf(statistics), [statistics]);
  return (
    <div className="sota-chart-card">
      <h3>
        <TrendUp size={20} />
        {t('charts.data_trend')}
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <AreaChart data={monthlyTrend} margin={{ top: 16, right: 24, left: 0, bottom: 8 }}>
          <defs>
            <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={DESIGN.colors.primary} stopOpacity={0.45} />
              <stop offset="95%" stopColor={DESIGN.colors.primary} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke={DESIGN.colors.border} />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
          <Tooltip />
          <Area type="monotone" dataKey="count" stroke={DESIGN.colors.primary} fill="url(#trendGradient)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};

const TopTagsChart: React.FC<DashboardChartProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  const tags = useMemo(() => topTagsOf(statistics), [statistics]);
  return (
    <div className="sota-chart-card">
      <h3>
        <Tag size={20} />
        {t('charts.top_tags')}
      </h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={tags} margin={{ top: 16, right: 24, left: 0, bottom: 32 }}>
          <CartesianGrid vertical={false} stroke={DESIGN.colors.border} />
          <XAxis dataKey="name" interval={0} angle={-20} textAnchor="end" height={60} tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
          <Tooltip />
          <Bar dataKey="value" fill={DESIGN.colors.secondary} radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

dashboardCoreCharts.announce({
  id: 'data-trend',
  order: 10,
  value: {
    hasData: (statistics) => Array.isArray(statistics.monthly_trend) && statistics.monthly_trend.length > 0,
    component: DataTrendChart,
  },
});
dashboardCoreCharts.announce({
  id: 'top-tags',
  order: 20,
  value: {
    hasData: (statistics) => Object.keys(statistics.basic_stats?.tag_stats || {}).length > 0,
    component: TopTagsChart,
  },
});
