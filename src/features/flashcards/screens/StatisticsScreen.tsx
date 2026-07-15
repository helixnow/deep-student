/** FSRS 学习统计：只展示后端真实聚合，不做客户端推算。 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, ChartBar, WarningCircle } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { getFsrsStats } from '@/utils/chatApi';
import { getErrorMessage } from '@/utils/errorUtils';
import type { FsrsStats } from '@/types';
import { FSRS_STATS_REFRESH_EVENT } from '../events';

export const StatisticsScreen: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const [stats, setStats] = useState<FsrsStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const translationRef = useRef(t);
  translationRef.current = t;

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
    };
    window.addEventListener(FSRS_STATS_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(FSRS_STATS_REFRESH_EVENT, onRefresh);
  }, [load]);

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
          onClick={() => void load()}
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
        <div className="wb-fc-panel p-0" data-testid="fsrs-statistics">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5 text-xs font-medium text-foreground/80">
            <ChartBar size={15} weight="duotone" />
            {t('statistics.overview')}
          </div>
          <dl className="grid grid-cols-2 sm:grid-cols-4">
            {metrics.map((metric) => (
              <div
                key={metric.key}
                className="min-w-0 border-b border-r border-border/40 px-3 py-3 last:border-r-0"
              >
                <dt className="truncate text-[11px] text-muted-foreground">{metric.label}</dt>
                <dd className="mt-1 text-lg font-semibold leading-none text-foreground">
                  {metric.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
};

export default StatisticsScreen;
