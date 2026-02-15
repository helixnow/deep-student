import React, { useState, useEffect } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { TauriAPI } from '../utils/tauriApi';
import { BarChart3, Settings, AlertTriangle, FileText, Search, BookOpen, Tag, PieChart, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { HeaderTemplate } from './HeaderTemplate';
import { formatErrorMessage, logError } from '../utils/errorUtils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { unifiedAlert, unifiedConfirm } from '@/utils/unifiedDialogs';

interface DashboardProps {
  onBack: () => void;
}

interface Statistics {
  totalMistakes: number;
  totalReviews: number;
  typeStats: Record<string, number>;
  tagStats: Record<string, number>;
  recentMistakes: any[];
}

export const Dashboard: React.FC<DashboardProps> = ({ onBack }) => {
  const { t } = useTranslation('common', { keyPrefix: 'dashboard' });
  const [stats, setStats] = useState<Statistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debugMode, setDebugMode] = useState(false);

  const loadStatistics = async () => {
    setLoading(true);
    setError(null);
    try {
      console.log(t('loading_statistics'));

      const statistics = await TauriAPI.getStatistics();
      console.log(t('statistics_loaded_success'), statistics);

      const formattedStats: Statistics = {
        totalMistakes: statistics.total_mistakes || 0,
        totalReviews: statistics.total_reviews || 0,
        typeStats: statistics.type_stats || {},
        tagStats: statistics.tag_stats || {},
        recentMistakes: statistics.recent_mistakes || []
      };

      setStats(formattedStats);
    } catch (error: unknown) {
      logError(t('loading_statistics_failed'), error);
      setError(formatErrorMessage(t('loading_failed'), error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatistics();
  }, []);

  // Stat card component
  const StatCard = ({
    icon: Icon,
    iconColor,
    iconBgColor,
    value,
    label,
  }: {
    icon: any;
    iconColor: string;
    iconBgColor: string;
    value: number | string;
    label: string;
    index?: number;
  }) => (
    <div className="bg-background rounded-xl border border-border p-6 flex items-center gap-4 shadow-sm hover:shadow-md transition-shadow">
      <div
        className="w-12 h-12 rounded-lg flex items-center justify-center"
        style={{ backgroundColor: iconBgColor }}
      >
        <Icon size={24} color={iconColor} />
      </div>
      <div>
        <div className="text-3xl font-bold text-foreground mb-0.5">
          {value}
        </div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
    </div>
  );

  return (
    <div className="h-[calc(100vh-var(--desktop-titlebar-height,40px))] flex flex-col bg-background">
      <HeaderTemplate
        icon={BarChart3}
        title={t('title')}
        subtitle={t('description')}
        onRefresh={loadStatistics}
        isRefreshing={loading}
        refreshingText={t('loading_statistics')}
        customActions={[
          {
            icon: Settings,
            label: debugMode ? t('close_debug') : t('open_debug'),
            onClick: () => setDebugMode(!debugMode),
            className: debugMode ? 'active' : ''
          }
        ]}
      />

      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="p-4 sm:px-8 sm:pb-8">
        <div className="max-w-5xl mx-auto">
          {/* Debug Panel */}
          {debugMode && (
            <div className="bg-background rounded-xl border border-border p-6 mb-6 shadow-sm overflow-hidden">
              <h3 className="flex items-center gap-2 text-lg font-medium text-foreground mb-4">
                <Settings size={20} />
                {t('debug_info')}
              </h3>
              <div className="grid gap-2 text-sm">
                <div><strong>{t('loading_status')}:</strong> <span className={loading ? 'text-amber-500' : 'text-emerald-500'}>{loading ? t('loading') : t('completed')}</span></div>
                <div><strong>{t('error_status')}:</strong> <span className={error ? 'text-red-500' : 'text-emerald-500'}>{error || t('no_error')}</span></div>
                <div><strong>{t('data_status')}:</strong> <span className={stats ? 'text-emerald-500' : 'text-muted-foreground'}>{stats ? t('has_data') : t('no_data_status')}</span></div>
                <div><strong>{t('component_render')}:</strong> <span className="text-emerald-500">{t('normal')}</span></div>
              </div>
              <div className="flex gap-3 mt-4">
                <NotionButton variant="primary" size="sm" onClick={async () => { try { console.log(t('manual_test')); const result = await TauriAPI.getStatistics(); console.log(t('manual_test_result'), result); unifiedAlert(t('api_call_success')); } catch (err: unknown) { console.error(t('manual_test_result'), err); unifiedAlert(`${t('api_call_failed')}: ${err}`); } }} className="!px-4 !py-2 bg-blue-500 hover:bg-blue-600 text-white !rounded-lg text-sm font-medium">
                  {t('test_api')}
                </NotionButton>
                <NotionButton variant="primary" size="sm" onClick={() => loadStatistics()} className="!px-4 !py-2 bg-emerald-500 hover:bg-emerald-600 text-white !rounded-lg text-sm font-medium">
                  {t('reload')}
                </NotionButton>
              </div>
            </div>
          )}

          {/* Content Area */}
          {loading ? (
            <div className="bg-background rounded-xl border border-border p-16 text-center shadow-sm">
              <div className="mb-4 inline-block">
                <RefreshCw size={48} className="text-primary animate-spin" />
              </div>
              <div className="text-lg text-muted-foreground">{t('loading_statistics')}</div>
            </div>
          ) : error && !stats ? (
            <div className="bg-background rounded-xl border border-red-200 dark:border-red-900 p-16 text-center shadow-sm bg-gradient-to-b from-red-50 to-background dark:from-red-950/30">
              <div className="mb-4">
                <AlertTriangle size={48} className="text-red-500 mx-auto" />
              </div>
              <div className="text-lg font-medium text-red-600 dark:text-red-400 mb-2">
                {t('loading_failed')}
              </div>
              <div className="text-sm text-red-700 dark:text-red-300">{error}</div>
            </div>
          ) : (
            <div>
              {/* Overview Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                <StatCard
                  icon={FileText}
                  iconColor="hsl(var(--primary))"
                  iconBgColor="hsl(var(--primary) / 0.1)"
                  value={stats?.totalMistakes || 0}
                  label={t('total_mistakes')}
                  index={0}
                />
                <StatCard
                  icon={Search}
                  iconColor="hsl(var(--success))"
                  iconBgColor="hsl(var(--success) / 0.1)"
                  value={stats?.totalReviews || 0}
                  label={t('total_reviews')}
                  index={1}
                />
                <StatCard
                  icon={BookOpen}
                  iconColor="hsl(var(--warning))"
                  iconBgColor="hsl(var(--warning) / 0.1)"
                  value={0}
                  label={t('total_subjects')}
                  index={2}
                />
                <StatCard
                  icon={Tag}
                  iconColor="hsl(var(--info))"
                  iconBgColor="hsl(var(--info) / 0.1)"
                  value={Object.keys(stats?.tagStats || {}).length}
                  label={t('total_tags')}
                  index={3}
                />
              </div>

              {/* Detailed Statistics */}
              {stats && stats.totalMistakes > 0 ? (
                <div className="grid gap-4">
                  {/* Type Distribution */}
                  {Object.keys(stats.typeStats).length > 0 && (
                    <div className="bg-background rounded-xl border border-border p-6 shadow-sm">
                      <h3 className="mb-6 flex items-center gap-2 text-lg font-semibold text-foreground">
                        <div className="w-8 h-8 bg-emerald-100 dark:bg-emerald-900/30 rounded-md flex items-center justify-center">
                          <PieChart size={16} className="text-emerald-600 dark:text-emerald-400" />
                        </div>
                        {t('type_distribution')}
                      </h3>
                      <div className="grid gap-4">
                        {Object.entries(stats.typeStats).map(([type, count]) => (
                          <div key={type} className="flex items-center">
                            <div className="min-w-[140px] text-sm font-medium text-foreground">
                              {type}
                            </div>
                            <div className="flex-1 bg-muted h-2 rounded-full mx-4 overflow-hidden">
                              <div
                                className="h-full bg-emerald-500 rounded-full"
                                style={{
                                  width: `${stats.totalMistakes > 0 ? (count / stats.totalMistakes) * 100 : 0}%`
                                }}
                              />
                            </div>
                            <div className="min-w-[40px] text-right text-sm font-semibold text-foreground">
                              {count}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="bg-background rounded-xl border border-border p-16 text-center shadow-sm">
                  <div className="mb-4">
                    <BarChart3 size={48} className="text-muted-foreground mx-auto" />
                  </div>
                  <h3 className="text-xl font-semibold text-foreground mb-2">
                    {t('no_data')}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t('no_data_description')}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </CustomScrollArea>
    </div>
  );
};
