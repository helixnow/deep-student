/**
 * 保留率与记忆分布（Anki 统计页的 True Retention 表 + 难度 / 稳定度 / 可提取率分布）。
 *
 * 数据源：`fsrs_get_review_statistics` 的 `trueRetention` / `memoryDistributions` /
 * `dailyReviews[].studyMs`，全部来自本地复习日志与当前记忆状态。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { ChartLineUp } from '@phosphor-icons/react';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { FSRS_STATS_REFRESH_EVENT, subscribeFlashcardsDueRefresh } from '../events';

export interface TrueRetentionRow {
  period: string;
  youngReviews: number;
  youngPassed: number;
  matureReviews: number;
  maturePassed: number;
}

export interface MemoryDistributions {
  cards: number;
  difficulty: number[];
  stability: number[];
  retrievability: number[];
}

export interface RetentionInsights {
  trueRetention: TrueRetentionRow[];
  distributions: MemoryDistributions;
  studyMsToday: number;
  studyMsWeekAverage: number;
}

const PERIODS = ['today', 'yesterday', 'week', 'month', 'year'] as const;
const STABILITY_LABELS = ['<1d', '1–3d', '3–7d', '7–14d', '14–30d', '1–3mo', '3–6mo', '6–12mo', '≥1y'];

function numberArray(value: unknown, length: number): number[] {
  const raw = Array.isArray(value) ? value : [];
  return Array.from({ length }, (_, index) => {
    const item = raw[index];
    return typeof item === 'number' && Number.isFinite(item) ? item : 0;
  });
}

function count(row: Record<string, unknown>, camel: string, snake: string): number {
  const value = row[camel] ?? row[snake];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 解析统计响应；没有新字段的旧后端返回 null（面板不显示）。 */
export function parseRetentionInsights(raw: unknown, todayKey: string): RetentionInsights | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const rawRetention = row.trueRetention ?? row.true_retention;
  const rawDistributions = row.memoryDistributions ?? row.memory_distributions;
  if (!Array.isArray(rawRetention) || !rawDistributions || typeof rawDistributions !== 'object') return null;
  const trueRetention = rawRetention
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      period: String(item.period ?? ''),
      youngReviews: count(item, 'youngReviews', 'young_reviews'),
      youngPassed: count(item, 'youngPassed', 'young_passed'),
      matureReviews: count(item, 'matureReviews', 'mature_reviews'),
      maturePassed: count(item, 'maturePassed', 'mature_passed'),
    }))
    .filter((item) => (PERIODS as readonly string[]).includes(item.period));
  const dist = rawDistributions as Record<string, unknown>;
  const daily = Array.isArray(row.dailyReviews ?? row.daily_reviews)
    ? (row.dailyReviews ?? row.daily_reviews) as Array<Record<string, unknown>>
    : [];
  const studyByDate = new Map(daily.map((day) => [String(day.date ?? ''), count(day, 'studyMs', 'study_ms')]));
  const recent = [...studyByDate.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 7);
  return {
    trueRetention,
    distributions: {
      cards: count(dist, 'cards', 'cards'),
      difficulty: numberArray(dist.difficulty, 10),
      stability: numberArray(dist.stability, STABILITY_LABELS.length),
      retrievability: numberArray(dist.retrievability, 10),
    },
    studyMsToday: studyByDate.get(todayKey) ?? 0,
    studyMsWeekAverage: recent.length > 0 ? recent.reduce((sum, [, ms]) => sum + ms, 0) / 7 : 0,
  };
}

function rate(passed: number, total: number): string {
  return total > 0 ? `${Math.round((passed / total) * 1000) / 10}%` : '—';
}

function formatMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const MiniBars: React.FC<{ values: number[]; labels: string[]; title: string }> = ({ values, labels, title }) => {
  const max = Math.max(1, ...values);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      <div className="wb-fcx-bars" style={{ height: 72 }}>
        {values.map((value, index) => (
          <div key={labels[index] ?? index} className="wb-fcx-bar" title={`${labels[index]} · ${value}`}>
            <span className="wb-fcx-bar-count">{value > 0 ? value : ''}</span>
            <div className="wb-fcx-bar-track">
              <div
                className="wb-fcx-bar-fill"
                style={{ height: `${Math.max(value > 0 ? 4 : 2, (value / max) * 100)}%` }}
              />
            </div>
            <span className="wb-fcx-bar-label">{labels[index]}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export const RetentionInsightsPanel: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const [insights, setInsights] = useState<RetentionInsights | null>(null);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const result = await invoke<unknown>('fsrs_get_review_statistics', { days: 365 });
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      const row = result && typeof result === 'object' ? result as Record<string, unknown> : {};
      const dayStart = row.dayStartMs ?? row.day_start_ms;
      const todayKey = localDateKey(typeof dayStart === 'number' ? new Date(dayStart) : new Date());
      setInsights(parseRetentionInsights(result, todayKey));
    } catch {
      if (mountedRef.current && requestId === requestIdRef.current) setInsights(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void load();
    const unsubscribeDue = subscribeFlashcardsDueRefresh(() => void load());
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      unsubscribeDue();
    };
  }, [load]);
  useEventRegistry(
    [{ target: 'window', type: FSRS_STATS_REFRESH_EVENT, listener: () => void load() }],
    [load],
  );

  const tenths = useMemo(() => Array.from({ length: 10 }, (_, index) => `${index * 10}`), []);
  const difficultyLabels = useMemo(() => Array.from({ length: 10 }, (_, index) => `${index + 1}`), []);

  if (!insights) return null;
  const rows = PERIODS.map((period) => insights.trueRetention.find((row) => row.period === period))
    .filter((row): row is TrueRetentionRow => Boolean(row));

  return (
    <section className="wb-fcx-panel wb-fcx-span-2" data-testid="fsrs-retention-insights">
      <div className="wb-fcx-panel-head">
        <h3 className="wb-fcx-panel-title">
          <ChartLineUp size={14} weight="duotone" />
          {t('stats.insights.title')}
        </h3>
        <p className="wb-fcx-panel-sub">
          {t('stats.insights.studyTime', {
            today: formatMinutes(insights.studyMsToday),
            average: formatMinutes(insights.studyMsWeekAverage),
          })}
        </p>
      </div>
      <div className="wb-fcx-panel-body flex flex-col gap-4">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-medium">{t('stats.insights.period')}</th>
              <th className="py-1 text-right font-medium">{t('stats.insights.young')}</th>
              <th className="py-1 text-right font-medium">{t('stats.insights.mature')}</th>
              <th className="py-1 text-right font-medium">{t('stats.insights.total')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const totalReviews = row.youngReviews + row.matureReviews;
              const totalPassed = row.youngPassed + row.maturePassed;
              return (
                <tr key={row.period} className="border-t border-border/50">
                  <td className="py-1">{t(`stats.insights.periods.${row.period}`)}</td>
                  <td className="py-1 text-right" title={`${row.youngPassed}/${row.youngReviews}`}>
                    {rate(row.youngPassed, row.youngReviews)}
                  </td>
                  <td className="py-1 text-right" title={`${row.maturePassed}/${row.matureReviews}`}>
                    {rate(row.maturePassed, row.matureReviews)}
                  </td>
                  <td className="py-1 text-right" title={`${totalPassed}/${totalReviews}`}>
                    {rate(totalPassed, totalReviews)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {insights.distributions.cards > 0 ? (
          <div className="flex flex-wrap gap-4">
            <MiniBars
              title={t('stats.insights.retrievability')}
              values={insights.distributions.retrievability}
              labels={tenths}
            />
            <MiniBars
              title={t('stats.insights.stability')}
              values={insights.distributions.stability}
              labels={STABILITY_LABELS}
            />
            <MiniBars
              title={t('stats.insights.difficulty')}
              values={insights.distributions.difficulty}
              labels={difficultyLabels}
            />
          </div>
        ) : null}
        <p className="wb-fcx-footnote">{t('stats.insights.hint')}</p>
      </div>
    </section>
  );
};

export default RetentionInsightsPanel;
