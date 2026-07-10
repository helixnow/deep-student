/**
 * 今日到期屏 — due 列表 + 开始复习
 */
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Lightning, Play } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useFsrsReviewStore } from '../store/fsrsReviewStore';

export const TodayScreen: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const dueCards = useFsrsReviewStore((s) => s.dueCards);
  const loading = useFsrsReviewStore((s) => s.loading);
  const usingMock = useFsrsReviewStore((s) => s.usingMock);
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
            {t('today.title', '今日复习')}
          </h2>
          <p className="wb-fc-subtitle">
            {loading
              ? t('today.loading', '正在加载到期卡片…')
              : t('today.dueCount', '{{count}} 张待复习', { count: dueCards.length })}
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
          {t('today.startReview', '开始复习')}
        </NotionButton>
      </header>

      {usingMock && !loading ? (
        <div role="status" className="wb-fc-banner">
          <span className="font-medium text-foreground/80">
            {t('today.demoMode', '演示模式')}
          </span>
          <span className="mx-1.5 text-border">·</span>
          {t('today.demoBanner', '当前为示例复习队列，便于预览流程。')}
        </div>
      ) : null}

      <div className="wb-fc-list">
        {loading ? (
          <div className="wb-fc-loading">
            {t('today.loading', '正在加载到期卡片…')}
          </div>
        ) : dueCards.length === 0 ? (
          <div className="wb-fc-empty">
            <Lightning size={28} className="text-muted-foreground/50" weight="duotone" />
            <p>
              {t('today.empty', '今天没有到期卡片')}
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
                  {card.front || t('card.untitled', '无正面')}
                </div>
                <div className="wb-fc-row-back">
                  {card.back || t('card.noBack', '无背面')}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
