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
  errorBanner?: React.ReactNode;
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
  errorBanner,
}) => {
  const { t } = useTranslation('flashcards');
  const showSummary = !empty && ratedCount > 0;
  const showContinue = Boolean(onContinue) && remainingDue != null && remainingDue > 0;
  const maxCount = Math.max(1, ...DIST_ROWS.map(({ rating }) => ratingCounts[rating]));

  return (
    <CustomScrollArea
      className="wb-fc-summary h-full min-h-0"
    >
      <div className="flex min-h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <div className={empty ? 'wb-fc-summary-icon wb-fc-summary-icon--empty' : 'wb-fc-summary-icon'}>
        {empty ? (
          <CardsThree size={34} weight="duotone" aria-hidden="true" />
        ) : (
          <CheckCircle size={34} weight="duotone" aria-hidden="true" />
        )}
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{headline}</p>
        <p className="text-xs text-muted-foreground">
          {empty ? t('review.emptyHint') : t('review.doneHint')}
        </p>
      </div>

      {showSummary ? (
        <div className="wb-fc-summary-panel">
          <div className="wb-fc-summary-stats">
            <div className="wb-fc-summary-stat">
              <span className="wb-fc-summary-stat-value">{ratedCount}</span>
              <span className="wb-fc-summary-stat-label">{t('review.statRated')}</span>
            </div>
            {elapsedMs != null ? (
              <div className="wb-fc-summary-stat">
                <span className="wb-fc-summary-stat-value">{formatDuration(elapsedMs)}</span>
                <span className="wb-fc-summary-stat-label">{t('review.statTime')}</span>
              </div>
            ) : null}
            {bestStreak > 1 ? (
              <div className="wb-fc-summary-stat">
                <span className="wb-fc-summary-stat-value">
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
                      className={`wb-fc-dist-fill ${toneClass}`}
                      style={{ width: `${Math.round((count / maxCount) * 100)}%` }}
                    />
                  </span>
                  <span className="wb-fc-dist-count">{count}</span>
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
        {canUndo ? (
          <DsButton type="button" variant="default" disabled={busy} onClick={onUndo}>
            <ArrowCounterClockwise size={16} />
            {t('session.undo')}
          </DsButton>
        ) : null}
        {canResume ? (
          <DsButton type="button" variant="default" disabled={busy} onClick={onResume}>
            <Play size={16} />
            {t('session.resume')}
          </DsButton>
        ) : null}
        {showContinue ? (
          <DsButton type="button" variant="primary" disabled={busy} onClick={onContinue}>
            <Play size={16} />
            {t('session.continueReview', { count: remainingDue })}
          </DsButton>
        ) : null}
        <DsButton
          type="button"
          variant={showContinue ? 'default' : 'primary'}
          onClick={onBack}
        >
          {t('session.backToday')}
        </DsButton>
      </div>
      {errorBanner}
      </div>
    </CustomScrollArea>
  );
};
