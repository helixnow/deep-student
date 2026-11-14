import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText, Image, Pulse, Tag, TrendUp } from '@phosphor-icons/react';
import { StatCard } from './StatCard';
import { dashboardCoreStats, type DashboardStatProps } from '@/ui-plugins/official/dashboard/api';

function formatStorageFromKB(kb?: number | null) {
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
}

// 学习记录统计
const LearningRecordsStat: React.FC<DashboardStatProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  return (
    <StatCard
      title={t('stats_cards.learning_records')}
      value={statistics?.basic_stats?.total_mistakes || 0}
      subtitle={t('stats_cards.learning_records_subtitle')}
      icon={FileText}
      variant="primary"
      trend={statistics?.recent_growth}
    />
  );
};

const TagsCountStat: React.FC<DashboardStatProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  return (
    <StatCard
      title={t('stats_cards.tags_count')}
      value={Object.keys(statistics?.basic_stats?.tag_stats || {}).length}
      subtitle={t('stats_cards.tags_count_subtitle')}
      icon={Tag}
      variant="info"
    />
  );
};

const RecentAdditionsStat: React.FC<DashboardStatProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  return (
    <StatCard
      title={t('stats_cards.recent_additions')}
      value={Number(statistics?.recent_additions ?? 0)}
      subtitle={t('stats_cards.recent_additions_subtitle')}
      icon={TrendUp}
      variant="success"
    />
  );
};

const DataQualityStat: React.FC<DashboardStatProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  return (
    <StatCard
      title={t('stats_cards.data_quality')}
      value={Number(statistics?.quality_score ?? 0)}
      subtitle={t('stats_cards.data_quality_subtitle')}
      icon={Pulse}
      variant="secondary"
    />
  );
};

const ResourceFilesStat: React.FC<DashboardStatProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  const totalBytes = statistics?.image_stats?.total_size_bytes;
  const imageStorageDisplay = useMemo(() => {
    if (typeof totalBytes !== 'number' || Number.isNaN(totalBytes) || totalBytes <= 0) {
      return null;
    }
    return formatStorageFromKB(totalBytes / 1024);
  }, [totalBytes]);
  return (
    <StatCard
      title={t('stats_cards.resource_files')}
      value={Number(statistics?.image_stats?.total_files ?? 0)}
      subtitle={imageStorageDisplay ? t('stats_cards.resource_files_subtitle_with_size', { size: imageStorageDisplay }) : t('stats_cards.resource_files_subtitle')}
      icon={Image}
      variant="info"
    />
  );
};

// ★ 占位卡治理（2026-06）：未上线功能不渲染占位卡（科目统计、统一回顾统计已移除）
dashboardCoreStats.announce({ id: 'learning-records', order: 10, value: { component: LearningRecordsStat } });
dashboardCoreStats.announce({ id: 'tags-count', order: 20, value: { component: TagsCountStat } });
dashboardCoreStats.announce({ id: 'recent-additions', order: 30, value: { component: RecentAdditionsStat } });
dashboardCoreStats.announce({ id: 'data-quality', order: 40, value: { component: DataQualityStat } });
dashboardCoreStats.announce({ id: 'resource-files', order: 50, value: { component: ResourceFilesStat } });
