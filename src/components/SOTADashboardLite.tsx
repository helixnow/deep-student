import React, { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  TrendUp,
  DownloadSimple,
  FileText,
  Tag,
  Pulse,
  WarningCircle,
  ArrowUpRight,
  ArrowDownRight,
  SpinnerGap,
  Image,
} from '@phosphor-icons/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/shad/Card';
import { Badge } from './ui/shad/Badge';
import { DsButton } from '@/components/ui/DsButton';
import { TodayCommandCenter } from './dashboard/TodayCommandCenter';
import { useAllStatistics } from '../hooks/useStatisticsData';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import { useMobileHeader } from '@/components/layout';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { fileManager } from '../utils/fileManager';
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

// 设计系统常量 - 统一从主题变量取色，兼容亮暗与调色板
const DESIGN = {
  colors: {
    primary: 'hsl(var(--primary))',
    secondary: 'hsl(var(--accent))',
    success: 'hsl(var(--success))',
    warning: 'hsl(var(--warning))',
    danger: 'hsl(var(--danger))',
    info: 'hsl(var(--info))',
    surface: 'var(--surface-elevated)',
    surfaceMuted: 'var(--surface-muted)',
    textPrimary: 'var(--text-primary)',
    textMuted: 'var(--text-muted)',
    border: 'var(--border-default)',
    gradients: {
      primary: 'var(--brand-gradient)',
      secondary: 'linear-gradient(135deg, hsl(var(--accent)) 0%, hsl(var(--primary)) 100%)',
      success: 'linear-gradient(135deg, hsl(var(--success)) 0%, hsl(var(--success-muted)) 100%)',
      warning: 'linear-gradient(135deg, hsl(var(--warning)) 0%, hsl(var(--warning-muted)) 100%)',
      info: 'linear-gradient(135deg, hsl(var(--info)) 0%, hsl(var(--info-muted)) 100%)',
      danger: 'linear-gradient(135deg, hsl(var(--danger)) 0%, hsl(var(--danger-muted)) 100%)',
    },
    gradientBackgrounds: {
      primary: 'var(--brand-100)',
      secondary: 'var(--surface-muted)',
      success: 'hsl(var(--success-bg))',
      warning: 'hsl(var(--warning-bg))',
      danger: 'hsl(var(--danger-bg))',
      info: 'hsl(var(--info-bg))',
    },
    chart: [
      'hsl(var(--primary))',
      'hsl(var(--accent))',
      'hsl(var(--info))',
      'hsl(var(--success))',
      'hsl(var(--warning))',
      'hsl(var(--danger))',
      'var(--brand-secondary)',
      'var(--brand-primary-light)',
    ],
  },
} as const;

type StatVariant = 'primary' | 'secondary' | 'info' | 'success' | 'warning' | 'danger';

const STAT_VARIANTS: Record<StatVariant, { gradient: string; iconColor: string; iconBg: string }> = {
  primary: {
    gradient: DESIGN.colors.gradients.primary,
    iconColor: DESIGN.colors.primary,
    iconBg: DESIGN.colors.gradientBackgrounds.primary,
  },
  secondary: {
    gradient: DESIGN.colors.gradients.secondary,
    iconColor: DESIGN.colors.secondary,
    iconBg: DESIGN.colors.gradientBackgrounds.secondary,
  },
  info: {
    gradient: DESIGN.colors.gradients.info,
    iconColor: DESIGN.colors.info,
    iconBg: DESIGN.colors.gradientBackgrounds.info,
  },
  success: {
    gradient: DESIGN.colors.gradients.success,
    iconColor: DESIGN.colors.success,
    iconBg: DESIGN.colors.gradientBackgrounds.success,
  },
  warning: {
    gradient: DESIGN.colors.gradients.warning,
    iconColor: DESIGN.colors.warning,
    iconBg: DESIGN.colors.gradientBackgrounds.warning,
  },
  danger: {
    gradient: DESIGN.colors.gradients.danger,
    iconColor: DESIGN.colors.danger,
    iconBg: DESIGN.colors.gradientBackgrounds.danger,
  },
};

interface SOTADashboardProps {
  onBack?: () => void;
  embedded?: boolean;
  /** ★ 5.1 今日指挥中心导航回调 */
  onNavigate?: (view: 'learning-hub' | 'todo' | 'task-dashboard') => void;
}

export const SOTADashboard: React.FC<SOTADashboardProps> = ({ onBack, embedded = false, onNavigate }) => {
  const { isActive } = useViewVisibility('dashboard');
  const shouldAutoRefresh = embedded ? true : isActive;
  // 使用数据 Hook
  const { data, loading, error, isRefreshing, refresh } = useAllStatistics({
    autoRefresh: shouldAutoRefresh,
    refreshInterval: 60000
  });
  const { t } = useTranslation('data');
  const { t: tCommon } = useTranslation('common');
  const { isSmallScreen } = useBreakpoint();

  // 供 useMobileHeader rightActions 调用（exportData 在下方定义）
  const exportDataRef = useRef<() => void>(() => {});

  // D-1: 移动端顶栏标题（独立视图形态时生效；embedded 形态由宿主视图管理顶栏）
  // 移动端设计哲学：页内不再放返回/导出按钮，操作统一收进顶栏
  useMobileHeader('dashboard', {
    title: tCommon('navigation.dashboard', '总览'),
    // ★ 顶栏统一：与设置/学习资源等子页一致，显示返回箭头（回聊天），
    // 而不是全局历史导航的 返回+前进 双按钮
    showBackArrow: !embedded && typeof onBack === 'function',
    onMenuClick: () => onBack?.(),
    rightActions: (
      <DsButton
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={t('export_stats_button')}
        onClick={() => exportDataRef.current()}
        className="!h-11 !w-11"
      >
        <DownloadSimple size={18} />
      </DsButton>
    ),
  }, [tCommon, t, embedded, onBack]);

  // 导出数据
  const exportData = useCallback(async () => {
    if (!data) return;
    
    const exportData = {
      timestamp: new Date().toISOString(),
      statistics: data
    };
    const json = JSON.stringify(exportData, null, 2);
    const defaultFileName = `statistics-${new Date().toISOString().split('T')[0]}.json`;

    let saved = false;
    try {
      const result = await fileManager.saveTextFile({
        title: t('export_stats_title'),
        defaultFileName,
        filters: [{ name: t('file_filter_json'), extensions: ['json'] }],
        content: json,
      });
      if (!result.canceled) {
        saved = true;
      }
    } catch (err: unknown) {
      console.warn('[SOTADashboard] Export failed, falling back to browser download', err);
    }

    if (!saved) {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultFileName;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [data, t]);
  exportDataRef.current = exportData;

  // 格式化数字
  const formatNumber = useCallback((num: number) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
  }, []);

  const formatStorageFromKB = useCallback((kb?: number | null) => {
    if (typeof kb !== 'number' || Number.isNaN(kb) || kb <= 0) {
      return '0 KB';
    }
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let bytes = kb * 1024;
    let idx = 0;
    while (bytes >= 1024 && idx < units.length - 1) {
      bytes /= 1024;
      idx += 1;
    }
    const precision = idx === 0 ? 0 : 1;
    return `${bytes.toFixed(precision)} ${units[idx]}`;
  }, []);

  // 准备图表数据
  const chartData = useMemo(() => {
    if (!data?.enhanced) return null;

    const tagStats = Object.entries(data.enhanced.basic_stats?.tag_stats || {})
      .map(([name, value]) => ({ name, value: Number(value) || 0 }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    const monthlyTrend = Array.isArray((data.enhanced as any).monthly_trend)
      ? (data.enhanced as any).monthly_trend.map((item: any) => ({
          month: typeof item?.month === 'string' ? item.month : '—',
          count: Number(item?.count ?? 0) || 0,
        }))
      : [];

    return {
      tags: tagStats,
      monthlyTrend,
    };
  }, [data]);

  const enhancedStats = data?.enhanced as any;

  const recentAdditions = Number(enhancedStats?.recent_additions ?? 0);
  const qualityScore = Number(enhancedStats?.quality_score ?? 0);
  const totalImages = Number(enhancedStats?.image_stats?.total_files ?? 0);

  const imageStorageDisplay = useMemo(() => {
    const totalBytes = enhancedStats?.image_stats?.total_size_bytes;
    if (typeof totalBytes !== 'number' || Number.isNaN(totalBytes) || totalBytes <= 0) {
      return null;
    }
    return formatStorageFromKB(totalBytes / 1024);
  }, [enhancedStats, formatStorageFromKB]);

  // 统计卡片组件
  const StatCard = ({
    title,
    value,
    subtitle,
    icon: Icon,
    variant,
    trend,
    isEstimated = false,
  }: {
    title: string;
    value: string | number;
    subtitle: string;
    icon: any;
    variant: StatVariant;
    trend?: number;
    isEstimated?: boolean;
  }) => {
    const palette = STAT_VARIANTS[variant] ?? STAT_VARIANTS.primary;
    const trendColor =
      trend !== undefined && trend !== 0
        ? trend > 0
          ? DESIGN.colors.success
          : DESIGN.colors.danger
        : undefined;
    const displayValue = typeof value === 'number' ? formatNumber(value) : value;
    return (
      <Card className="overflow-hidden">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div
 className="w-8 h-8 rounded-md flex items-center justify-center"
                style={{ background: palette.iconBg }}
              >
                <Icon size={20} color={palette.iconColor} />
              </div>
              <CardTitle className="text-base">
                {title}
                {isEstimated && (
                  <span
                    className="ml-2 text-xs font-normal"
                    style={{ color: DESIGN.colors.textMuted }}
                  >
                    {t('stats_cards.estimated_label')}
                  </span>
                )}
              </CardTitle>
            </div>
            {trend !== undefined && trend !== 0 && (
              <span className="text-xs flex items-center gap-1" style={{ color: trendColor }}>
                {trend > 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                {Math.abs(trend)}%
              </span>
            )}
          </div>
          <CardDescription>{subtitle}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-semibold" style={{ color: DESIGN.colors.textPrimary }}>
            {displayValue}
          </div>
        </CardContent>
      </Card>
    );
  };

  // 渲染统一内容 - 显示所有模块的统计数据
  const renderUnifiedContent = () => {
    if (loading && !data) {
      return (
        <div className="sota-loading">
          <SpinnerGap size={48} className="sota-spinner" />
          <p>{t('loading_stats')}</p>
        </div>
      );
    }

    if (error && !data) {
      return (
        <div className="sota-error">
          <WarningCircle size={48} color={DESIGN.colors.danger} />
          <p>{t('load_failed')}: {error.message}</p>
          <DsButton onClick={refresh} className="mt-2">{tCommon('actions.retry')}</DsButton>
        </div>
      );
    }

    return (
      <div className="sota-unified-content">
        {/* 移动端：返回/导出统一走顶栏（useMobileHeader），页内不再渲染工具行 */}
        {!isSmallScreen && (
        <div className="mb-4 flex items-center gap-2">
          {typeof onBack === 'function' && (
            <DsButton variant="ghost" size="sm" onClick={onBack} className="flex items-center gap-1 text-muted-foreground">
              <ArrowLeft size={16} /> {tCommon('actions.back')}
            </DsButton>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            <Badge
              variant="outline"
              className="border"
              style={
                isRefreshing
                  ? {
                      background: DESIGN.colors.gradientBackgrounds.info,
                      color: DESIGN.colors.info,
                      borderColor: DESIGN.colors.info,
                    }
                  : {
                      background: DESIGN.colors.surfaceMuted,
                      color: DESIGN.colors.textMuted,
                      borderColor: DESIGN.colors.border,
                    }
              }
            >
              {t('auto_refresh_label')} {isRefreshing ? t('auto_refresh_in_progress') : t('auto_refresh_interval')}
            </Badge>
            <DsButton variant="ghost" size="sm" onClick={exportData} disabled={!data} className="flex items-center gap-1">
              <DownloadSimple size={16} /> {t('export_stats_button')}
            </DsButton>
          </div>
        </div>
        )}

        {/* ★ 5.1 今日指挥中心：可行动入口置顶，统计下沉 */}
        <TodayCommandCenter onNavigate={onNavigate} />

        {/* 所有统计卡片平铺展示 */}
        <div className="sota-stats-grid">
          {/* 学习记录统计 */}
          <StatCard
            title={t('stats_cards.learning_records')}
            value={enhancedStats?.basic_stats?.total_mistakes || 0}
            subtitle={t('stats_cards.learning_records_subtitle')}
            icon={FileText}
            variant="primary"
            trend={enhancedStats?.recent_growth}
/>
          {/* ★ 占位卡治理（2026-06）：未上线功能不渲染占位卡（科目统计、统一回顾统计已移除） */}
          <StatCard
            title={t('stats_cards.tags_count')}
            value={Object.keys(enhancedStats?.basic_stats?.tag_stats || {}).length}
            subtitle={t('stats_cards.tags_count_subtitle')}
            icon={Tag}
            variant="info"
/>
          <StatCard
            title={t('stats_cards.recent_additions')}
            value={recentAdditions}
            subtitle={t('stats_cards.recent_additions_subtitle')}
            icon={TrendUp}
            variant="success"
/>

          <StatCard
            title={t('stats_cards.data_quality')}
            value={qualityScore}
            subtitle={t('stats_cards.data_quality_subtitle')}
            icon={Pulse}
            variant="secondary"
/>

          <StatCard
            title={t('stats_cards.resource_files')}
            value={totalImages}
            subtitle={imageStorageDisplay ? t('stats_cards.resource_files_subtitle_with_size', { size: imageStorageDisplay }) : t('stats_cards.resource_files_subtitle')}
            icon={Image}
            variant="info"
/>

        </div>

        {/* 图表区域 */}
        {chartData && (
          <div className="sota-charts">
            {chartData.monthlyTrend.length > 0 && (
              <div className="sota-chart-card">
                <h3>
                  <TrendUp size={20} />
                  {t('charts.data_trend')}
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={chartData.monthlyTrend} margin={{ top: 16, right: 24, left: 0, bottom: 8 }}>
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
            )}

            {chartData.tags.length > 0 && (
              <div className="sota-chart-card">
                <h3>
                  <Tag size={20} />
                  {t('charts.top_tags')}
                </h3>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={chartData.tags} margin={{ top: 16, right: 24, left: 0, bottom: 32 }}>
                    <CartesianGrid vertical={false} stroke={DESIGN.colors.border} />
                    <XAxis dataKey="name" interval={0} angle={-20} textAnchor="end" height={60} tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} width={40} />
                    <Tooltip />
                    <Bar dataKey="value" fill={DESIGN.colors.secondary} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };


  return (
    <>
      <style>{`
        .sota-dashboard {
          width: 100%;
          background: var(--surface-root);
          color: var(--text-primary);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }

        .sota-content {
          padding: 24px;
        }

        .sota-module {
          max-width: 1400px;
          margin: 0 auto;
        }

        .sota-stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
          gap: 1.5rem;
          margin-bottom: 2rem;
        }

        /* cleaned unused stat-card styles after shadcn refactor */

        .sota-charts {
          display: grid;
          /* min(500px, 100%)：容器窄于 500px（移动端）时轨道收缩到容器宽，避免横向溢出 */
          grid-template-columns: repeat(auto-fit, minmax(min(500px, 100%), 1fr));
          gap: 20px;
        }

        .sota-chart-card {
          background: var(--surface-elevated);
          border-radius: 0.75rem;
          padding: 2rem;
          border: 1px solid var(--border-default);
          box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
        }

        .sota-chart-card h3 {
          margin: 0 0 1.5rem 0;
          font-size: 1.125rem;
          font-weight: 600;
          color: var(--text-primary);
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .sota-loading,
        .sota-error {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 400px;
          gap: 16px;
          color: var(--text-muted);
        }

        .sota-error h3 {
          margin: 0;
          font-size: 20px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .sota-error p {
          margin: 0;
          font-size: 14px;
        }

        /* cleaned unused retry button styles */

        .sota-spinner {
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @media (max-width: 767.98px) {

          .sota-nav {
            padding: 0 16px;
            overflow-x: auto;
          }

          .sota-content {
            /* 底部预留安全区，避免内容被系统手势条/底部指示条遮挡 */
            padding: 16px 16px calc(16px + var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px)));
          }

          .sota-stats-grid {
            grid-template-columns: 1fr;
            gap: 0.75rem;
          }

          .sota-charts {
            grid-template-columns: 1fr;
          }

          /* 小屏图表卡收窄内边距，给 375px 视口下的图表留出绘图宽度 */
          .sota-chart-card {
            padding: 1.25rem 0.75rem 1rem;
          }

          .sota-chart-card h3 {
            padding: 0 0.5rem;
            margin-bottom: 1rem;
            font-size: 1rem;
          }

          /* cleaned: removed .sota-stat-value override */
        }

      `}</style>

      {/*
        * 内容容器不能用 main 元素：app.css 的全局 `main { height:100dvh; overflow:hidden }`
        * 会把内容钳死在一屏内，外层 ScrollArea 便无从滚动（移动端总览无法滚动的根因）。
        * 页面级 main 地标已由 App 壳（#main-content）唯一提供，这里嵌套也不合法。
        * 契约测试：tests/vitest/dashboardScrollContract.test.ts
        */}
      <div className="sota-dashboard">
        <div className="sota-content" style={embedded ? { padding: '0' } : undefined}>
          {renderUnifiedContent()}
        </div>
      </div>
    </>
  );
};
