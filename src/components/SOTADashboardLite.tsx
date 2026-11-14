import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  TrendUp,
  DownloadSimple,
  WarningCircle,
  SpinnerGap,
} from '@phosphor-icons/react';
import { Badge } from './ui/shad/Badge';
import { DsButton } from '@/components/ui/DsButton';
import { TodayCommandCenter } from './dashboard/TodayCommandCenter';
import { DESIGN } from './dashboard/design';
import './dashboard/coreStats';
import './dashboard/coreCharts';
import { SlotOutlet } from '@/ui-kernel/outlet';
import { useOptionalUiKernel } from '@/ui-kernel/react';
import {
  useUnattachedDashboardCharts,
  useUnattachedDashboardStats,
  type DashboardStatistics,
} from '@/ui-plugins/official/dashboard/api';
import { useAllStatistics } from '../hooks/useStatisticsData';
import { useViewVisibility } from '@/hooks/useViewVisibility';
import { useMobileHeader, MobileSlidingLayout } from '@/components/layout';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { fileManager } from '../utils/fileManager';

interface SOTADashboardProps {
  onBack?: () => void;
  embedded?: boolean;
  /** ★ 5.1 今日指挥中心导航回调 */
  onNavigate?: (view: 'learning-hub' | 'todo' | 'task-dashboard' | 'flashcards') => void;
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
  const platform = useOptionalUiKernel()?.platform.kind;
  const unattachedStats = useUnattachedDashboardStats();
  const unattachedCharts = useUnattachedDashboardCharts();
  // P3-1：总览是抽屉「管理」分组的平级目的地，顶栏应与其它平级页
  // （制卡任务/技能管理/模板管理）一致显示 ☰ 打开抽屉，而不是"返回"箭头
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 供 useMobileHeader rightActions 调用（exportData 在下方定义）
  const exportDataRef = useRef<() => void>(() => {});

  // D-1: 移动端顶栏标题（独立视图形态时生效；embedded 形态由宿主视图管理顶栏）
  // 移动端设计哲学：页内不再放返回/导出按钮，操作统一收进顶栏
  // ★ 嵌入形态（embedded）时禁用：不写 dashboard 键，
  // 避免覆盖/清掉独立视图实例的顶栏配置
  useMobileHeader('dashboard', {
    title: tCommon('navigation.dashboard', '总览'),
    showMenu: !embedded,
    onMenuClick: () => setSidebarOpen(true),
    rightActions: (
      <DsButton
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={t('export_stats_button')}
        onClick={() => exportDataRef.current()}
        disabled={!data}
        className="!h-11 !w-11"
      >
        <DownloadSimple size={18} />
      </DsButton>
    ),
  }, [tCommon, t, embedded, onBack, !data], !embedded);

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

  const enhancedStats = data?.enhanced as DashboardStatistics | undefined;
  const onPlatform = (entry: { value: { platforms?: readonly string[] } }) =>
    !platform || !entry.value.platforms || entry.value.platforms.includes(platform);

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
          <DsButton onClick={refresh} className="mt-2 [@media(pointer:coarse)]:!min-h-11">{tCommon('actions.retry')}</DsButton>
        </div>
      );
    }

    return (
      <div className="sota-unified-content">
        {/* 移动端：返回/导出统一走顶栏（useMobileHeader），页内不再渲染工具行 */}
        {!isSmallScreen && (
        <div className="mb-4 flex items-center gap-2">
          {typeof onBack === 'function' && (
            <DsButton variant="ghost" size="sm" onClick={onBack} className="flex items-center gap-1 text-muted-foreground [@media(pointer:coarse)]:!min-h-11">
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
            <DsButton variant="ghost" size="sm" onClick={exportData} disabled={!data} className="flex items-center gap-1 [@media(pointer:coarse)]:!min-h-11">
              <DownloadSimple size={16} /> {t('export_stats_button')}
            </DsButton>
          </div>
        </div>
        )}

        {/* ★ 5.1 今日指挥中心：可行动入口置顶，统计下沉 */}
        <TodayCommandCenter onNavigate={onNavigate} />

        {/* 所有统计卡片平铺展示：`dashboard.stats`（官方卡片见 ./dashboard/coreStats） */}
        <div className="sota-stats-grid">
          <SlotOutlet
            name="dashboard.stats"
            entries={unattachedStats}
            filter={onPlatform}
            render={(entry) => {
              const Stat = entry.value.component;
              return <Stat statistics={enhancedStats} />;
            }}
          />
        </div>

        {/* 图表区域：`dashboard.charts`（官方图表见 ./dashboard/coreCharts）；没有一张图有数据时显示空卡片 */}
        {enhancedStats ? (
          <div className="sota-charts">
            <SlotOutlet
              name="dashboard.charts"
              entries={unattachedCharts}
              filter={(entry) => onPlatform(entry) && (entry.value.hasData?.(enhancedStats) ?? true)}
              render={(entry) => {
                const Chart = entry.value.component;
                return <Chart statistics={enhancedStats} />;
              }}
              empty={
                <div className="sota-chart-card sota-chart-empty">
                  <TrendUp size={24} className="sota-chart-empty__icon" />
                  <p className="sota-chart-empty__title">{t('charts.empty')}</p>
                  <p className="sota-chart-empty__hint">{t('charts.empty_hint')}</p>
                </div>
              }
            />
          </div>
        ) : null}
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

        .sota-chart-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 3rem 2rem;
          gap: 0.5rem;
        }

        .sota-chart-empty__icon {
          color: var(--text-tertiary, var(--text-secondary));
          opacity: 0.6;
          margin-bottom: 0.25rem;
        }

        .sota-chart-empty__title {
          margin: 0;
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--text-secondary);
        }

        .sota-chart-empty__hint {
          margin: 0;
          font-size: 0.8rem;
          color: var(--text-tertiary, var(--text-secondary));
          opacity: 0.8;
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
      {/* P3-1：移动端独立形态挂 MobileSlidingLayout 统一抽屉（本页无页内工具，
          抽屉只承载应用主导航，与制卡任务页同一配方）；此时组件自带内容滚动，
          App 层不再套 CustomScrollArea（见 dashboardContent 的 isSmallScreen 分支） */}
      {(() => {
        const body = (
          <div className="sota-dashboard">
            <div className="sota-content" style={embedded ? { padding: '0' } : undefined}>
              {renderUnifiedContent()}
            </div>
          </div>
        );
        if (!embedded && isSmallScreen) {
          return (
            <div className="absolute inset-0 overflow-hidden">
              <MobileSlidingLayout
                sidebar={<div aria-hidden className="h-0" />}
                sidebarOpen={sidebarOpen}
                onSidebarOpenChange={setSidebarOpen}
                sidebarWidth="auto"
                showSidebarAppNavigation
                showContentOverlay
                className="flex-1"
              >
                <CustomScrollArea className="h-full" viewportClassName="h-full">
                  {body}
                </CustomScrollArea>
              </MobileSlidingLayout>
            </div>
          );
        }
        return body;
      })()}
    </>
  );
};
