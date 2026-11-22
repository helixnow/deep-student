import React, { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { FileText, Image, Pulse, Tag, TrendUp } from '@phosphor-icons/react';
import { StatCard } from './StatCard';
import { formatLocalDateYmd, getHeatmapDateRange, type LearningActivity } from '@/hooks/useLearningHeatmap';
import {
  dashboardCoreStats,
  type DashboardStatProps,
  type DashboardStatistics,
} from '@/ui-plugins/official/dashboard/api';

interface KnowledgePointReply {
  tag?: unknown;
  total?: unknown;
  mastery_rate?: unknown;
}

export interface FallbackDashboardStats {
  basic_stats: { total_mistakes: number; tag_stats: Record<string, number> };
  recent_additions: number;
  recent_growth?: number;
  quality_score: number;
  monthly_trend: Array<{ month: string; count: number }>;
}

const FALLBACK_CACHE_TTL_MS = 60_000;
let fallbackData: FallbackDashboardStats | null = null;
let fallbackFetchedAt = 0;
let fallbackInflight: Promise<FallbackDashboardStats | null> | null = null;
const fallbackListeners = new Set<() => void>();

function notifyFallbackListeners(): void {
  for (const listener of [...fallbackListeners]) {
    listener();
  }
}

export function getFallbackDashboardStatistics(): FallbackDashboardStats | null {
  return fallbackData;
}

export function subscribeFallbackDashboardStatistics(listener: () => void): () => void {
  fallbackListeners.add(listener);
  return () => {
    fallbackListeners.delete(listener);
  };
}

export function resetFallbackDashboardStatisticsForTest(): void {
  fallbackData = null;
  fallbackFetchedAt = 0;
  fallbackInflight = null;
  notifyFallbackListeners();
}

export function normalizeDashboardStatistics(
  statistics: DashboardStatistics | undefined,
  fallback: FallbackDashboardStats | null = null,
): DashboardStatistics | undefined {
  if (!statistics) return undefined;
  const raw = statistics as Record<string, unknown>;
  const rawBasic = (statistics.basic_stats ?? raw.basicStats) as
    | { total_mistakes?: unknown; totalMistakes?: unknown; tag_stats?: unknown; tagStats?: unknown }
    | undefined;
  const rawImage = (statistics.image_stats ?? raw.imageStats) as
    | { total_files?: unknown; totalFiles?: unknown; total_size_bytes?: unknown; totalSizeBytes?: unknown }
    | undefined;
  const rawMonthly = statistics.monthly_trend ?? raw.monthlyTrend;
  const rawRecentAdditions = statistics.recent_additions ?? raw.recentAdditions;
  const rawRecentGrowth = statistics.recent_growth ?? raw.recentGrowth;
  const rawQualityScore = statistics.quality_score ?? raw.qualityScore;

  const hasExplicitCoreFields =
    rawBasic !== undefined ||
    rawRecentAdditions !== undefined ||
    rawQualityScore !== undefined ||
    rawMonthly !== undefined;

  const effectiveBasic = hasExplicitCoreFields
    ? {
        total_mistakes: Number(rawBasic?.total_mistakes ?? rawBasic?.totalMistakes ?? 0) || 0,
        tag_stats:
          ((rawBasic?.tag_stats ?? rawBasic?.tagStats) as Record<string, unknown> | undefined) ?? {},
      }
    : fallback?.basic_stats;

  return {
    ...statistics,
    ...(effectiveBasic ? { basic_stats: effectiveBasic } : {}),
    recent_additions:
      hasExplicitCoreFields
        ? Number(rawRecentAdditions ?? 0) || 0
        : (fallback?.recent_additions ?? 0),
    recent_growth:
      hasExplicitCoreFields
        ? (typeof rawRecentGrowth === 'number' ? rawRecentGrowth : undefined)
        : fallback?.recent_growth,
    quality_score:
      hasExplicitCoreFields
        ? Number(rawQualityScore ?? 0) || 0
        : (fallback?.quality_score ?? 0),
    monthly_trend: hasExplicitCoreFields ? rawMonthly : fallback?.monthly_trend,
    image_stats: rawImage
      ? {
          total_files: Number(rawImage.total_files ?? rawImage.totalFiles ?? 0) || 0,
          total_size_bytes: Number(rawImage.total_size_bytes ?? rawImage.totalSizeBytes ?? 0) || 0,
        }
      : statistics.image_stats,
  };
}

function needsFallbackAggregation(statistics: DashboardStatistics | undefined): boolean {
  if (!statistics) return false;
  const raw = statistics as Record<string, unknown>;
  return (
    statistics.basic_stats === undefined &&
    raw.basicStats === undefined &&
    statistics.recent_additions === undefined &&
    raw.recentAdditions === undefined &&
    statistics.quality_score === undefined &&
    raw.qualityScore === undefined &&
    statistics.monthly_trend === undefined &&
    raw.monthlyTrend === undefined
  );
}

export function buildFallbackStatsFromSources(
  heatmap: readonly LearningActivity[] | null,
  knowledge: readonly KnowledgePointReply[] | null,
  now: Date = new Date(),
): FallbackDashboardStats | null {
  if (!heatmap && !knowledge) return null;

  const days = Array.isArray(heatmap) ? heatmap : [];
  const points = Array.isArray(knowledge) ? knowledge : [];

  const recent7Start = formatLocalDateYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const prev7Start = formatLocalDateYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 13));
  const prev7End = formatLocalDateYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7));

  let totalActivities = 0;
  let recentAdditions = 0;
  let prevAdditions = 0;
  let activeDays30 = 0;
  const recent30Start = formatLocalDateYmd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29));
  const monthlyMap = new Map<string, number>();

  for (const item of days) {
    const count = Number(item?.count ?? 0) || 0;
    const date = typeof item?.date === 'string' ? item.date : '';
    totalActivities += count;
    if (date >= recent7Start) recentAdditions += count;
    else if (date >= prev7Start && date <= prev7End) prevAdditions += count;
    if (date >= recent30Start && count > 0) activeDays30 += 1;
    if (/^\d{4}-\d{2}/.test(date) && count > 0) {
      const month = date.slice(0, 7);
      monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + count);
    }
  }

  const tagStats: Record<string, number> = {};
  let knowledgeTotal = 0;
  let weightedMastery = 0;
  for (const kp of points) {
    const tag = typeof kp?.tag === 'string' ? kp.tag.trim() : '';
    const total = Number(kp?.total ?? 0) || 0;
    const masteryRate = Number(kp?.mastery_rate ?? 0) || 0;
    if (tag && total > 0) {
      tagStats[tag] = (tagStats[tag] ?? 0) + total;
      knowledgeTotal += total;
      weightedMastery += masteryRate * total;
    }
  }

  const recentGrowth =
    prevAdditions > 0
      ? Math.round(((recentAdditions - prevAdditions) / prevAdditions) * 100)
      : recentAdditions > 0
        ? 100
        : undefined;

  const qualityScore =
    knowledgeTotal > 0
      ? Math.min(100, Math.round(weightedMastery / knowledgeTotal))
      : activeDays30 > 0
        ? Math.min(100, Math.round((activeDays30 / 30) * 100))
        : 0;

  const monthlyTrend = [...monthlyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, count]) => ({ month, count }));

  return {
    basic_stats: {
      total_mistakes: Math.max(totalActivities, knowledgeTotal),
      tag_stats: tagStats,
    },
    recent_additions: recentAdditions,
    ...(recentGrowth !== undefined ? { recent_growth: recentGrowth } : {}),
    quality_score: qualityScore,
    monthly_trend: monthlyTrend,
  };
}

async function ensureFallbackLoaded(): Promise<FallbackDashboardStats | null> {
  if (fallbackData && Date.now() - fallbackFetchedAt < FALLBACK_CACHE_TTL_MS) {
    return fallbackData;
  }
  if (fallbackInflight) return fallbackInflight;

  const { startDate, endDate } = getHeatmapDateRange(6);
  fallbackInflight = Promise.all([
    invoke<LearningActivity[]>('get_learning_heatmap', { startDate, endDate }).catch(() => null),
    invoke<KnowledgePointReply[]>('qbank_get_knowledge_stats', { request: { exam_id: null } }).catch(() => null),
  ])
    .then(([heatmap, knowledge]) => {
      const built = buildFallbackStatsFromSources(heatmap, knowledge);
      if (built) {
        fallbackData = built;
        fallbackFetchedAt = Date.now();
        notifyFallbackListeners();
      }
      return built;
    })
    .finally(() => {
      fallbackInflight = null;
    });

  return fallbackInflight;
}

export function useResolvedDashboardStatistics(
  statistics: DashboardStatistics | undefined,
): DashboardStatistics | undefined {
  const needsFallback = needsFallbackAggregation(statistics);
  const fallback = useSyncExternalStore(
    subscribeFallbackDashboardStatistics,
    getFallbackDashboardStatistics,
    () => null,
  );

  useEffect(() => {
    if (!needsFallback) return;
    void ensureFallbackLoaded();
  }, [needsFallback]);

  return useMemo(
    () => normalizeDashboardStatistics(statistics, needsFallback ? fallback : null),
    [statistics, needsFallback, fallback],
  );
}

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
  const resolved = useResolvedDashboardStatistics(statistics);
  return (
    <StatCard
      title={t('stats_cards.learning_records')}
      value={resolved?.basic_stats?.total_mistakes || 0}
      subtitle={t('stats_cards.learning_records_subtitle')}
      icon={FileText}
      variant="primary"
      trend={resolved?.recent_growth}
    />
  );
};

const TagsCountStat: React.FC<DashboardStatProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  const resolved = useResolvedDashboardStatistics(statistics);
  return (
    <StatCard
      title={t('stats_cards.tags_count')}
      value={Object.keys(resolved?.basic_stats?.tag_stats || {}).length}
      subtitle={t('stats_cards.tags_count_subtitle')}
      icon={Tag}
      variant="info"
    />
  );
};

const RecentAdditionsStat: React.FC<DashboardStatProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  const resolved = useResolvedDashboardStatistics(statistics);
  return (
    <StatCard
      title={t('stats_cards.recent_additions')}
      value={Number(resolved?.recent_additions ?? 0)}
      subtitle={t('stats_cards.recent_additions_subtitle')}
      icon={TrendUp}
      variant="success"
    />
  );
};

const DataQualityStat: React.FC<DashboardStatProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  const resolved = useResolvedDashboardStatistics(statistics);
  return (
    <StatCard
      title={t('stats_cards.data_quality')}
      value={Number(resolved?.quality_score ?? 0)}
      subtitle={t('stats_cards.data_quality_subtitle')}
      icon={Pulse}
      variant="secondary"
    />
  );
};

const ResourceFilesStat: React.FC<DashboardStatProps> = ({ statistics }) => {
  const { t } = useTranslation('data');
  const resolved = useResolvedDashboardStatistics(statistics);
  const totalBytes = resolved?.image_stats?.total_size_bytes;
  const imageStorageDisplay = useMemo(() => {
    if (typeof totalBytes !== 'number' || Number.isNaN(totalBytes) || totalBytes <= 0) {
      return null;
    }
    return formatStorageFromKB(totalBytes / 1024);
  }, [totalBytes]);
  return (
    <StatCard
      title={t('stats_cards.resource_files')}
      value={Number(resolved?.image_stats?.total_files ?? 0)}
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
