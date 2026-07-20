/**
 * 今日屏 — 复习驾驶舱：进度环 + 队列计数 + streak + 到期预览。
 * 数据源：fsrs_get_due / fsrs_get_stats（真实后端聚合）+ 复习活动前端近似。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowClockwise,
  Books,
  ChartBar,
  CheckCircle,
  Fire,
  Lightning,
  Play,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { PullToRefresh } from '@/components/mobile';
import type { FsrsStats } from '@/types';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';
import { subscribeFlashcardsDueRefresh } from '../events';
import { useReviewActivity, computeCurrentStreak } from '../hooks/useReviewActivity';
import { useCountUp } from '../hooks/useCountUp';
import { ProgressRing } from '../components/ProgressRing';

function readCount(row: Record<string, unknown>, camelKey: string, snakeKey: string): number | null {
  const raw = row[camelKey] !== undefined ? row[camelKey] : row[snakeKey];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return null;
}

function parseFsrsStats(raw: unknown): FsrsStats | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const total = readCount(row, 'total', 'total');
  const due = readCount(row, 'due', 'due');
  const newCount = readCount(row, 'newCount', 'new_count');
  const learning = readCount(row, 'learning', 'learning');
  const review = readCount(row, 'review', 'review');
  const relearning = readCount(row, 'relearning', 'relearning');
  const suspended = readCount(row, 'suspended', 'suspended');
  const reviewsToday = readCount(row, 'reviewsToday', 'reviews_today');
  if (
    total == null || due == null || newCount == null || learning == null
    || review == null || relearning == null || suspended == null || reviewsToday == null
  ) {
    return null;
  }
  return { total, due, newCount, learning, review, relearning, suspended, reviewsToday };
}

const CountValue: React.FC<{ value: number | null }> = ({ value }) => {
  const display = useCountUp(value ?? 0);
  return <>{value == null ? '—' : display}</>;
};

export const TodayScreen: React.FC = () => {
  const { t, i18n } = useTranslation('flashcards');
  const dueCards = useFsrsReviewStore((s) => s.dueCards);
  const dueTotal = useFsrsReviewStore((s) => s.dueTotal);
  const loading = useFsrsReviewStore((s) => s.loading);
  const error = useFsrsReviewStore((s) => s.error);
  const loadDue = useFsrsReviewStore((s) => s.loadDue);
  const startDueSession = useFsrsReviewStore((s) => s.startDueSession);
  const setScreen = useFsrsReviewStore((s) => s.setScreen);

  const [stats, setStats] = useState<FsrsStats | null>(null);
  const statsRequestRef = useRef(0);
  const activity = useReviewActivity();

  const displayDueCount = dueTotal > 0 ? dueTotal : dueCards.length;
  const batchCapped = dueTotal > dueCards.length && dueCards.length > 0;

  const loadStats = useCallback(async () => {
    const requestId = ++statsRequestRef.current;
    try {
      const raw = await invoke<unknown>('fsrs_get_stats');
      if (requestId !== statsRequestRef.current) return;
      setStats(parseFsrsStats(raw));
    } catch {
      if (requestId !== statsRequestRef.current) return;
      setStats(null);
    }
  }, []);

  useEffect(() => {
    void loadDue();
    void loadStats();
    return () => {
      statsRequestRef.current += 1;
    };
  }, [loadDue, loadStats]);

  // 他窗评分 / 库操作后保持计数新鲜（去抖合并连发事件）
  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = subscribeFlashcardsDueRefresh(() => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void loadDue();
        void loadStats();
        activity.reload(true);
      }, 200);
    });
    return () => {
      unsubscribe();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [loadDue, loadStats, activity.reload]);

  // 返回 Promise：下拉刷新指示器保持到数据到位（顶栏刷新按钮亦复用）
  const handleRefresh = useCallback(async () => {
    activity.reload(true);
    await Promise.allSettled([loadDue(), loadStats()]);
  }, [loadDue, loadStats, activity.reload]);

  const dateLabel = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, {
      month: 'long',
      day: 'numeric',
      weekday: 'long',
    }).format(new Date()),
    [i18n.language],
  );

  const activeDays = useMemo(
    () => new Set(activity.dayCounts.keys()),
    [activity.dayCounts],
  );
  const streak = useMemo(
    () => (activity.status === 'ready'
      ? computeCurrentStreak(activeDays, (stats?.reviewsToday ?? 0) > 0)
      : 0),
    [activity.status, activeDays, stats?.reviewsToday],
  );

  const doneToday = stats?.reviewsToday ?? 0;
  const todayTarget = doneToday + displayDueCount;
  const progress = todayTarget > 0 ? doneToday / todayTarget : stats ? 1 : 0;
  const progressPercent = Math.round(progress * 100);
  const learningCount = stats == null ? null : stats.learning + stats.relearning;

  return (
    <div className="wb-fc-screen">
      <header className="wb-fc-header">
        <div className="min-w-0">
          <h2 className="wb-fc-title">
            {t('today.title')}
          </h2>
          <p className="wb-fc-subtitle">
            {loading
              ? t('today.loading')
              : error
                ? t('today.loadFailed')
                : `${dateLabel} · ${t('today.dueCount', { count: displayDueCount })}`}
          </p>
        </div>
        <div className="wb-fc-toolbar shrink-0">
          <NotionButton
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            disabled={loading}
            onClick={() => void handleRefresh()}
            aria-label={t('today.refresh')}
            title={t('today.refresh')}
          >
            <ArrowClockwise size={15} />
          </NotionButton>
        </div>
      </header>

      {error ? (
        <div className="wb-fc-list">
          <div role="alert" className="wb-fc-empty gap-3 px-5 text-center">
            <Lightning size={28} className="text-destructive/70" weight="duotone" />
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                {t('today.loadFailed')}
              </p>
              <p className="max-w-md break-words text-xs text-destructive/90">{error}</p>
            </div>
            <NotionButton
              type="button"
              variant="default"
              onClick={() => void loadDue()}
              className="text-sm"
            >
              <ArrowClockwise size={16} />
              {t('today.retry')}
            </NotionButton>
          </div>
        </div>
      ) : (
        /* 触屏下拉刷新（桌面鼠标不受影响）；PullToRefresh 自身即滚动容器 */
        <PullToRefresh
          onRefresh={handleRefresh}
          className="min-h-0 flex-1"
          contentClassName="wb-fcx-scroll"
        >
          <section className="wb-fcx-panel wb-fcx-hero">
            <div className="wb-fcx-hero-ring">
              <ProgressRing
                value={progress}
                size={104}
                strokeWidth={9}
                aria-label={t('today.ringDone', {
                  done: doneToday,
                  remaining: displayDueCount,
                })}
              >
                <span className="wb-fcx-ring-percent">{progressPercent}%</span>
                <span className="wb-fcx-ring-caption">{t('today.progressCaption')}</span>
              </ProgressRing>
            </div>
            <div className="wb-fcx-hero-main">
              <div className="wb-fcx-counts">
                <div className="wb-fcx-count" data-tone="due">
                  <div className="wb-fcx-count-label">{t('today.statDue')}</div>
                  <div className="wb-fcx-count-value">
                    <CountValue value={loading ? null : displayDueCount} />
                  </div>
                </div>
                <div className="wb-fcx-count" data-tone="new">
                  <div className="wb-fcx-count-label">{t('today.statNew')}</div>
                  <div className="wb-fcx-count-value">
                    <CountValue value={stats?.newCount ?? null} />
                  </div>
                </div>
                <div className="wb-fcx-count" data-tone="learning">
                  <div className="wb-fcx-count-label">{t('today.statLearning')}</div>
                  <div className="wb-fcx-count-value">
                    <CountValue value={learningCount} />
                  </div>
                </div>
              </div>
              <div className="wb-fcx-hero-actions">
                <NotionButton
                  type="button"
                  variant="primary"
                  disabled={loading || dueCards.length === 0}
                  onClick={startDueSession}
                  className="wb-fcx-cta"
                >
                  <Play size={16} weight="fill" />
                  {t('today.startReview')}
                </NotionButton>
                {streak > 0 ? (
                  <span className="wb-fcx-chip" title={t('today.streakHint')}>
                    <Fire size={13} weight="fill" />
                    {t('today.streak', { count: streak })}
                  </span>
                ) : null}
                {activity.status === 'ready' && activity.totalCards != null ? (
                  <span className="wb-fcx-chip" data-tone="muted">
                    <Books size={13} weight="duotone" />
                    {t('today.libSummary', { count: activity.totalCards })}
                  </span>
                ) : null}
              </div>
              {!loading && batchCapped ? (
                <p className="wb-fcx-panel-sub">
                  {t('today.batchCapHint', { n: dueCards.length })}
                </p>
              ) : null}
            </div>
          </section>

          {loading ? (
            <div className="wb-fc-list">
              <div className="wb-fc-loading">
                {t('today.loading')}
              </div>
            </div>
          ) : dueCards.length === 0 ? (
            <div className="wb-fc-list">
              <div className="wb-fc-empty gap-3">
                <div className="wb-fcx-empty-icon">
                  {doneToday > 0
                    ? <CheckCircle size={28} weight="duotone" />
                    : <Lightning size={28} weight="duotone" />}
                </div>
                <div className="space-y-1">
                  <p className="font-medium text-foreground">
                    {doneToday > 0 ? t('today.allDone') : t('today.empty')}
                  </p>
                  <p className="mx-auto max-w-md text-xs text-muted-foreground">
                    {t('today.emptyHint')}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <NotionButton
                    type="button"
                    variant="default"
                    onClick={() => setScreen('library')}
                    className="text-sm"
                  >
                    <Books size={15} weight="duotone" />
                    {t('today.goLibrary')}
                  </NotionButton>
                  <NotionButton
                    type="button"
                    variant="ghost"
                    onClick={() => setScreen('settings')}
                    className="text-sm"
                  >
                    <ChartBar size={15} weight="duotone" />
                    {t('today.goStats')}
                  </NotionButton>
                </div>
              </div>
            </div>
          ) : (
            <section className="wb-fcx-panel">
              <div className="wb-fcx-panel-head">
                <h3 className="wb-fcx-panel-title">
                  <Lightning size={14} weight="duotone" />
                  {t('today.upNext')}
                </h3>
                <p className="wb-fcx-panel-sub">
                  {t('today.upNextCount', { count: dueCards.length })}
                </p>
              </div>
              <div className="wb-fcx-panel-list">
                <ul className="wb-fc-list-ul">
                  {dueCards.map((card) => (
                    <li
                      key={card.id}
                      className="wb-fc-row"
                      data-agent-entity={`flashcards:${card.id}`}
                    >
                      <div className="wb-fc-row-front">
                        {card.front || t('card.untitled')}
                      </div>
                      {card.tags && card.tags.length > 0 ? (
                        <div className="wb-fc-tags">
                          {card.tags.slice(0, 4).map((tag, index) => (
                            <span key={`${tag}-${index}`} className="wb-fc-tag">{tag}</span>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
        </PullToRefresh>
      )}
    </div>
  );
};
