/**
 * 会话结束/空队列屏：完成小结（用时、评分分布、最长连击）与空态美化。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  CardsThree,
  CheckCircle,
  Lightning,
  Play,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { FsrsRating, SessionRatingCounts } from '../store/fsrsReviewStore';
import { formatDuration } from './useSessionClock';

const DIST_ROWS: Array<{ rating: FsrsRating; labelKey: string; toneClass: string }> = [
  { rating: 1, labelKey: 'session.again', toneClass: 'wb-fc-dist-fill--again' },
  { rating: 2, labelKey: 'session.hard', toneClass: 'wb-fc-dist-fill--hard' },
  { rating: 3, labelKey: 'session.good', toneClass: 'wb-fc-dist-fill--good' },
  { rating: 4, labelKey: 'session.easy', toneClass: 'wb-fc-dist-fill--easy' },
];

export interface SessionSummaryProps {
  /** true=会话从未有卡（空态）；false=完成态 */
  empty: boolean;
  headline: string;
  ratedCount: number;
  ratingCounts: SessionRatingCounts;
  bestStreak: number;
  /** null 表示没有可靠的开始时间（如直接注入的会话） */
  elapsedMs: number | null;
  remainingDue: number | null;
  busy: boolean;
  canUndo: boolean;
  canResume: boolean;
  onUndo: () => void;
  onResume: () => void;
  onBack: () => void;
  /** 剩余到期 > 0 时的「继续复习」入口（重新 loadDue 并开新一轮） */
  onContinue?: () => void;
  /** 今日清零后前往卡片库挑选牌组或入队新卡的次级引导 */
  onOpenLibrary?: () => void;
  errorBanner?: React.ReactNode;
  /** Mobile host already provides back, undo and resume. */
  hideChromeActions?: boolean;
}

export const SessionSummary: React.FC<SessionSummaryProps> = ({
  empty,
  headline,
  ratedCount,
  ratingCounts,
  bestStreak,
  elapsedMs,
  remainingDue,
  busy,
  canUndo,
  canResume,
  onUndo,
  onResume,
  onBack,
  onContinue,
  onOpenLibrary,
  errorBanner,
  hideChromeActions = false,
}) => {
  const { t } = useTranslation('flashcards');
  // ratedCount>0 means a real session finished even if reconcile emptied the queue.
  const showSummary = ratedCount > 0;
  const showContinue = Boolean(onContinue) && remainingDue != null && remainingDue > 0;
  const maxCount = Math.max(1, ...DIST_ROWS.map(({ rating }) => ratingCounts[rating]));
  const passedCount = ratingCounts[2] + ratingCounts[3] + ratingCounts[4];
  const recallPct = ratedCount > 0 ? Math.round((passedCount / ratedCount) * 100) : 0;

  return (
    <CustomScrollArea
      className="wb-fc-summary h-full min-h-0"
    >
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center animate-chat-rise-in motion-reduce:animate-none">
      <div className={empty ? 'wb-fc-summary-icon wb-fc-summary-icon--empty' : 'wb-fc-summary-icon'}>
        {empty ? (
          <CardsThree size={34} weight="duotone" aria-hidden="true" />
        ) : (
          <CheckCircle size={34} weight="duotone" aria-hidden="true" />
        )}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{headline}</p>
        {empty ? (
          <p className="text-xs text-muted-foreground">{t('review.emptyHint')}</p>
        ) : showSummary ? (
          <p
            data-testid="fc-session-encourage"
            className="max-w-sm text-xs text-muted-foreground"
          >
            {recallPct >= 80
              ? t('review.summaryEncourageHigh')
              : t('review.summaryEncourageSteady')}
          </p>
        ) : null}
      </div>

      {showSummary ? (
        <div className="wb-fc-summary-panel">
          <div className="wb-fc-summary-stats">
            <div className="wb-fc-summary-stat">
              <span className="wb-fc-summary-stat-value font-mono tabular-nums">{ratedCount}</span>
              <span className="wb-fc-summary-stat-label">{t('review.statRated')}</span>
            </div>
            <div className="wb-fc-summary-stat">
              <span className="wb-fc-summary-stat-value font-mono tabular-nums" data-testid="fc-session-recall-rate">
                {recallPct}%
              </span>
              <span className="wb-fc-summary-stat-label">{t('review.statRecall')}</span>
            </div>
            {elapsedMs != null ? (
              <div className="wb-fc-summary-stat">
                <span className="wb-fc-summary-stat-value font-mono tabular-nums">{formatDuration(elapsedMs)}</span>
                <span className="wb-fc-summary-stat-label">{t('review.statTime')}</span>
              </div>
            ) : null}
            {bestStreak > 1 ? (
              <div className="wb-fc-summary-stat">
                <span className="wb-fc-summary-stat-value font-mono tabular-nums">
                  <Lightning size={13} weight="fill" aria-hidden="true" className="wb-fc-summary-stat-bolt" />
                  {bestStreak}
                </span>
                <span className="wb-fc-summary-stat-label">{t('review.statBestStreak')}</span>
              </div>
            ) : null}
          </div>
          <div className="wb-fc-dist" role="list" aria-label={t('review.distribution')}>
            {DIST_ROWS.map(({ rating, labelKey, toneClass }) => {
              const count = ratingCounts[rating];
              return (
                <div key={rating} className="wb-fc-dist-row" role="listitem">
                  <span className="wb-fc-dist-label">{t(labelKey)}</span>
                  <span className="wb-fc-dist-bar">
                    <span
                      className={`wb-fc-dist-fill ${toneClass} motion-reduce:transition-none`}
                      style={{ width: `${Math.round((count / maxCount) * 100)}%` }}
                    />
                  </span>
                  <span className="wb-fc-dist-count font-mono tabular-nums">{count}</span>
                </div>
              );
            })}
          </div>
          {remainingDue != null && remainingDue > 0 ? (
            <p className="wb-fc-summary-remaining">
              {t('session.stillDue', { count: remainingDue })}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-center gap-2">
        {canUndo && !hideChromeActions ? (
          <DsButton
            type="button"
            variant="default"
            aria-label={t('session.undo')}
            aria-keyshortcuts="Z"
            disabled={busy}
            onClick={onUndo}
            className="active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <ArrowCounterClockwise size={16} />
            <span>{t('session.undo')}</span>
            <kbd aria-hidden="true" className="wb-fc-keycap">Z</kbd>
          </DsButton>
        ) : null}
        {canResume && !hideChromeActions ? (
          <DsButton
            type="button"
            variant="default"
            disabled={busy}
            onClick={onResume}
            className="active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <Play size={16} />
            {t('session.resume')}
          </DsButton>
        ) : null}
        {showContinue ? (
          <DsButton
            type="button"
            variant="primary"
            disabled={busy}
            onClick={onContinue}
            className="active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <Play size={16} />
            {t('session.continueReview', { count: remainingDue })}
          </DsButton>
        ) : !hideChromeActions && onOpenLibrary ? (
          <DsButton
            type="button"
            variant="default"
            disabled={busy}
            onClick={onOpenLibrary}
            data-testid="fc-summary-open-library"
            className="active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <CardsThree size={16} />
            {t('today.goLibrary')}
          </DsButton>
        ) : null}
        {!hideChromeActions && <DsButton
          type="button"
          variant={showContinue ? 'default' : 'primary'}
          onClick={onBack}
          className="active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          {t('session.backToday')}
        </DsButton>}
      </div>
      {errorBanner}
      </div>
    </CustomScrollArea>
  );
};
