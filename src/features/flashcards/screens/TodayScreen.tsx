/**
 * 今日到期屏 — due 列表 + 开始复习
 */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, Lightning, Play } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';

export const TodayScreen: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const dueCards = useFsrsReviewStore((s) => s.dueCards);
  const loading = useFsrsReviewStore((s) => s.loading);
  const error = useFsrsReviewStore((s) => s.error);
  const loadDue = useFsrsReviewStore((s) => s.loadDue);
  const startDueSession = useFsrsReviewStore((s) => s.startDueSession);

  useEffect(() => {
    void loadDue();
  }, [loadDue]);

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
              : t('today.dueCount', { count: dueCards.length })}
          </p>
        </div>
        <NotionButton
          type="button"
          variant="primary"
          disabled={loading || dueCards.length === 0}
          onClick={startDueSession}
          className="shrink-0 text-sm"
        >
          <Play size={16} weight="fill" />
          {t('today.startReview')}
        </NotionButton>
      </header>

      <div className="wb-fc-list">
        {loading ? (
          <div className="wb-fc-loading">
            {t('today.loading')}
          </div>
        ) : error ? (
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
        ) : dueCards.length === 0 ? (
          <div className="wb-fc-empty">
            <Lightning size={28} className="text-muted-foreground/50" weight="duotone" />
            <p>
              {t('today.empty')}
            </p>
          </div>
        ) : (
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
                <div className="wb-fc-row-back">
                  {card.back || t('card.noBack')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
