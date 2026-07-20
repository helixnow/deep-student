/**
 * FSRS 学习统计 — 对标 Anki 统计页：
 * 关键数字（后端真实聚合）+ 热力图 / 每日柱状 / 评分分布 / 状态构成
 * （前端基于「每张卡最近一次复习」的诚实近似，均有标注）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  CalendarBlank,
  ChartBar,
  ChartDonut,
  ChartPieSlice,
  Fire,
  WarningCircle,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { getFsrsStats } from '@/utils/chatApi';
import { getErrorMessage } from '@/utils/errorUtils';
import type { FsrsStats } from '@/types';
import { FSRS_STATS_REFRESH_EVENT } from '../events';
import {
  computeBestStreak,
  computeCurrentStreak,
  useReviewActivity,
} from '../hooks/useReviewActivity';
import { useCountUp } from '../hooks/useCountUp';
import { ReviewHeatmap } from '../components/ReviewHeatmap';
import { SchedulerSettingsSection } from '../components/SchedulerSettingsSection';
import type { FsrsRating } from '../store/fsrsReviewStore';

const DAILY_WINDOW_DAYS = 14;

const MetricValue: React.FC<{ value: number }> = ({ value }) => {
  const display = useCountUp(value);
  return <>{display}</>;
};

interface DonutSegment {
  key: string;
  tone: string;
  label: string;
  value: number;
}

const StateDonut: React.FC<{ segments: DonutSegment[]; centerValue: number; centerLabel: string }> = ({
  segments,
  centerValue,
  centerLabel,
}) => {
  const size = 132;
  const strokeWidth = 16;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  let cumulative = 0;
  const arcs = segments
    .filter((segment) => segment.value > 0)
    .map((segment) => {
      const fraction = segment.value / total;
      const arc = {
        ...segment,
        dashArray: `${fraction * circumference} ${circumference}`,
        dashOffset: -cumulative * circumference,
      };
      cumulative += fraction;
      return arc;
    });

  return (
    <div className="wb-fcx-donut-layout">
      <div className="wb-fcx-ring" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          <circle
            className="wb-fcx-ring-track"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
          />
          <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
            {arcs.map((arc) => (
              <circle
                key={arc.key}
                className="wb-fcx-donut-seg"
                data-tone={arc.tone}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                strokeWidth={strokeWidth}
                strokeDasharray={arc.dashArray}
                strokeDashoffset={arc.dashOffset}
              />
            ))}
          </g>
        </svg>
        <div className="wb-fcx-ring-center">
          <span className="wb-fcx-ring-percent"><MetricValue value={centerValue} /></span>
          <span className="wb-fcx-ring-caption">{centerLabel}</span>
        </div>
      </div>
      <div className="wb-fcx-donut-legend">
        {segments.map((segment) => (
          <span key={segment.key} className="wb-fcx-legend-item" data-tone={segment.tone}>
            <span className="wb-fcx-legend-dot" />
            {segment.label}
            <span className="wb-fcx-legend-strong">{segment.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

export const StatisticsScreen: React.FC = () => {
  const { t, i18n } = useTranslation('flashcards');
  const [stats, setStats] = useState<FsrsStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const translationRef = useRef(t);
  translationRef.current = t;

  const activity = useReviewActivity();
  const reloadActivity = activity.reload;

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await getFsrsStats();
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setStats(result);
    } catch (loadError) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setStats(null);
      setError(
        getErrorMessage(loadError)
          || translationRef.current('statistics.loadFailed'),
      );
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    const onRefresh = () => {
      void load();
      reloadActivity(true);
    };
    window.addEventListener(FSRS_STATS_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(FSRS_STATS_REFRESH_EVENT, onRefresh);
  }, [load, reloadActivity]);

  const handleRefresh = useCallback(() => {
    void load();
    reloadActivity(true);
  }, [load, reloadActivity]);

  const metrics = stats ? [
    { key: 'reviewsToday', label: t('statistics.reviewsToday'), value: stats.reviewsToday },
    { key: 'due', label: t('statistics.due'), value: stats.due },
    { key: 'new', label: t('statistics.new'), value: stats.newCount },
    { key: 'learning', label: t('statistics.learning'), value: stats.learning },
    { key: 'review', label: t('statistics.review'), value: stats.review },
    { key: 'relearning', label: t('statistics.relearning'), value: stats.relearning },
    { key: 'suspended', label: t('statistics.suspended'), value: stats.suspended },
    { key: 'total', label: t('statistics.total'), value: stats.total },
  ] : [];

  const activeDays = useMemo(
    () => new Set(activity.dayCounts.keys()),
    [activity.dayCounts],
  );
  const currentStreak = useMemo(
    () => computeCurrentStreak(activeDays, (stats?.reviewsToday ?? 0) > 0),
    [activeDays, stats?.reviewsToday],
  );
  const bestStreak = useMemo(() => computeBestStreak(activeDays), [activeDays]);

  const dailyBars = useMemo(() => {
    const bars: Array<{ key: string; label: string; count: number; isToday: boolean }> = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let offset = DAILY_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(date.getDate() - offset);
      const key = `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
      bars.push({
        key,
        label: `${date.getDate()}`,
        count: activity.dayCounts.get(key) ?? 0,
        isToday: offset === 0,
      });
    }
    return bars;
  }, [activity.dayCounts]);
  const dailyMax = Math.max(1, ...dailyBars.map((bar) => bar.count));

  const ratingSegments = useMemo(() => {
    const order: Array<{ rating: FsrsRating; tone: string; labelKey: string }> = [
      { rating: 1, tone: 'again', labelKey: 'stats.ratings.again' },
      { rating: 2, tone: 'hard', labelKey: 'stats.ratings.hard' },
      { rating: 3, tone: 'good', labelKey: 'stats.ratings.good' },
      { rating: 4, tone: 'easy', labelKey: 'stats.ratings.easy' },
    ];
    return order.map((item) => {
      const count = activity.ratingCounts[item.rating];
      const percent = activity.ratedTotal > 0
        ? Math.round((count / activity.ratedTotal) * 100)
        : 0;
      return { ...item, count, percent };
    });
  }, [activity.ratingCounts, activity.ratedTotal]);

  const donutSegments: DonutSegment[] = stats ? [
    { key: 'new', tone: 'state-new', label: t('stats.composition.new'), value: stats.newCount },
    { key: 'learning', tone: 'state-learning', label: t('stats.composition.learning'), value: stats.learning },
    { key: 'review', tone: 'state-review', label: t('stats.composition.review'), value: stats.review },
    { key: 'relearning', tone: 'state-relearning', label: t('stats.composition.relearning'), value: stats.relearning },
    { key: 'suspended', tone: 'state-suspended', label: t('stats.composition.suspended'), value: stats.suspended },
  ] : [];

  const hasActivityData = activity.status === 'ready' && activeDays.size > 0;
  const activityNote = activity.status === 'loading'
    ? t('stats.activity.loading')
    : activity.status === 'unavailable'
      ? t('stats.activity.unavailable')
      : activeDays.size === 0
        ? t('stats.activity.empty')
        : null;
  // 数据来源标注：后端真实日志统计 vs 前端近似聚合（旧后端回退）
  const activitySourceNote = activity.source === 'stats'
    ? t('stats.activity.realNote')
    : t('stats.activity.approxNote');

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );

  return (
    <div className="wb-fc-screen">
      <header className="wb-fc-header">
        <div className="min-w-0">
          <h2 className="wb-fc-title">{t('statistics.title')}</h2>
          <p className="wb-fc-subtitle">
            {loading
              ? t('statistics.loading')
              : t('statistics.subtitle')}
          </p>
        </div>
        <NotionButton
          type="button"
          variant="ghost"
          size="sm"
          disabled={loading}
          onClick={handleRefresh}
          className="shrink-0 text-sm"
        >
          <ArrowClockwise size={15} />
          {t('statistics.refresh')}
        </NotionButton>
      </header>

      {error ? (
        <div role="alert" className="wb-fc-empty gap-3 rounded-md border border-border/60 px-5 text-center">
          <WarningCircle size={28} className="text-destructive/70" weight="duotone" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">
              {t('statistics.loadFailed')}
            </p>
            <p className="max-w-md break-words text-xs text-destructive/90">{error}</p>
          </div>
          <NotionButton type="button" variant="default" size="sm" onClick={() => void load()}>
            <ArrowClockwise size={15} />
            {t('statistics.retry')}
          </NotionButton>
        </div>
      ) : loading && !stats ? (
        <div className="wb-fc-loading">{t('statistics.loading')}</div>
      ) : stats ? (
        <div className="wb-fcx-scroll">
          <SchedulerSettingsSection />
          <section className="wb-fcx-panel" data-testid="fsrs-statistics">
            <div className="wb-fcx-panel-head">
              <h3 className="wb-fcx-panel-title">
                <ChartBar size={14} weight="duotone" />
                {t('statistics.overview')}
              </h3>
              {hasActivityData ? (
                <span className="wb-fcx-chip" title={t('today.streakHint')}>
                  <Fire size={13} weight="fill" />
                  {t('stats.streak.current')} {t('stats.streak.days', { count: currentStreak })}
                  {bestStreak > currentStreak
                    ? ` · ${t('stats.streak.best', { count: bestStreak })}`
                    : ''}
                </span>
              ) : null}
            </div>
            <dl className="wb-fcx-metrics mt-3">
              {metrics.map((metric) => (
                <div key={metric.key} className="wb-fcx-metric">
                  <dt>{metric.label}</dt>
                  <dd><MetricValue value={metric.value} /></dd>
                </div>
              ))}
            </dl>
          </section>

          <div className="wb-fcx-stats-grid">
            <section className="wb-fcx-panel wb-fcx-span-2">
              <div className="wb-fcx-panel-head">
                <h3 className="wb-fcx-panel-title">
                  <CalendarBlank size={14} weight="duotone" />
                  {t('stats.heatmap.title')}
                </h3>
                <p className="wb-fcx-panel-sub">
                  {hasActivityData
                    ? `${t('stats.heatmap.subtitle')} · ${t('stats.streak.activeDays', {
                        count: activeDays.size,
                      })} · ${activitySourceNote}`
                    : t('stats.heatmap.subtitle')}
                </p>
              </div>
              <div className="wb-fcx-panel-body">
                {activityNote ? (
                  <p className="wb-fcx-note">{activityNote}</p>
                ) : (
                  <>
                    <ReviewHeatmap dayCounts={activity.dayCounts} />
                    {activity.truncated ? (
                      <p className="wb-fcx-footnote">
                        {t('stats.activity.truncated', {
                          count: numberFormat.format(activity.sampledCards),
                        })}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            </section>

            <section className="wb-fcx-panel">
              <div className="wb-fcx-panel-head">
                <h3 className="wb-fcx-panel-title">
                  <ChartBar size={14} weight="duotone" />
                  {t('stats.daily.title')}
                </h3>
                <p className="wb-fcx-panel-sub">
                  {t('stats.daily.subtitle', { days: DAILY_WINDOW_DAYS })}
                </p>
              </div>
              <div className="wb-fcx-panel-body">
                {activityNote ? (
                  <p className="wb-fcx-note">{activityNote}</p>
                ) : (
                  <div className="wb-fcx-bars">
                    {dailyBars.map((bar) => (
                      <div
                        key={bar.key}
                        className="wb-fcx-bar"
                        data-today={bar.isToday ? 'true' : undefined}
                        title={`${bar.key} · ${bar.count}`}
                      >
                        <span className="wb-fcx-bar-count">
                          {bar.count > 0 ? bar.count : ''}
                        </span>
                        <div className="wb-fcx-bar-track">
                          <div
                            className="wb-fcx-bar-fill"
                            style={{
                              height: `${Math.max(bar.count > 0 ? 4 : 2, (bar.count / dailyMax) * 100)}%`,
                            }}
                          />
                        </div>
                        <span className="wb-fcx-bar-label">{bar.label}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="wb-fcx-panel">
              <div className="wb-fcx-panel-head">
                <h3 className="wb-fcx-panel-title">
                  <ChartPieSlice size={14} weight="duotone" />
                  {t('stats.ratings.title')}
                </h3>
                <p className="wb-fcx-panel-sub">
                  {activity.source === 'stats'
                    ? t('stats.ratings.subtitleReal')
                    : t('stats.ratings.subtitle')}
                </p>
              </div>
              <div className="wb-fcx-panel-body">
                {activity.status !== 'ready' ? (
                  <p className="wb-fcx-note">
                    {activity.status === 'loading'
                      ? t('stats.activity.loading')
                      : t('stats.activity.unavailable')}
                  </p>
                ) : activity.ratedTotal === 0 ? (
                  <p className="wb-fcx-note">{t('stats.ratings.empty')}</p>
                ) : (
                  <>
                    <div className="wb-fcx-rating-track">
                      {ratingSegments
                        .filter((segment) => segment.count > 0)
                        .map((segment) => (
                          <div
                            key={segment.rating}
                            className="wb-fcx-rating-seg"
                            data-tone={segment.tone}
                            style={{ flexGrow: segment.count }}
                            title={`${t(segment.labelKey)} ${segment.percent}%`}
                          />
                        ))}
                    </div>
                    <div className="wb-fcx-rating-legend">
                      {ratingSegments.map((segment) => (
                        <span
                          key={segment.rating}
                          className="wb-fcx-legend-item"
                          data-tone={segment.tone}
                        >
                          <span className="wb-fcx-legend-dot" />
                          {t(segment.labelKey)}
                          <span className="wb-fcx-legend-strong">{segment.percent}%</span>
                        </span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </section>

            <section className="wb-fcx-panel wb-fcx-span-2">
              <div className="wb-fcx-panel-head">
                <h3 className="wb-fcx-panel-title">
                  <ChartDonut size={14} weight="duotone" />
                  {t('stats.composition.title')}
                </h3>
              </div>
              <div className="wb-fcx-panel-body">
                <StateDonut
                  segments={donutSegments}
                  centerValue={stats.total}
                  centerLabel={t('stats.composition.center')}
                />
              </div>
            </section>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default StatisticsScreen;
