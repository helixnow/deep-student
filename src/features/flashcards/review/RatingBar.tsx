/**
 * 评分栏：翻面前显示「显示答案」，翻面后显示 Again/Hard/Good/Easy 四键，
 * 带预测间隔、键位提示与按键反馈动画。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Eye } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/utils/cn';
import {
  formatInterval,
  type FsrsRating,
  type RatingPreviews,
} from '../store/fsrsReviewStore';

export interface RatingDescriptor {
  value: FsrsRating;
  labelKey: string;
  tone: string;
}

export const RATING_DESCRIPTORS: RatingDescriptor[] = [
  {
    value: 1,
    labelKey: 'session.again',
    tone: 'border-destructive/40 text-destructive hover:bg-destructive/10',
  },
  {
    value: 2,
    labelKey: 'session.hard',
    tone: 'border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10',
  },
  {
    value: 3,
    labelKey: 'session.good',
    tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10',
  },
  {
    value: 4,
    labelKey: 'session.easy',
    tone: 'border-sky-500/40 text-sky-700 dark:text-sky-400 hover:bg-sky-500/10',
  },
];

export interface RatingBarProps {
  flipped: boolean;
  disabled: boolean;
  previews: RatingPreviews | null;
  /** 键盘评分时短暂高亮对应按钮 */
  pressedRating: FsrsRating | null;
  onShowAnswer: () => void;
  onRate: (rating: FsrsRating, event: React.MouseEvent<HTMLButtonElement>) => void;
}

export const RatingBar: React.FC<RatingBarProps> = ({
  flipped,
  disabled,
  previews,
  pressedRating,
  onShowAnswer,
  onRate,
}) => {
  const { t } = useTranslation('flashcards');

  if (!flipped) {
    return (
      <div className="wb-fc-ratebar" data-mode="reveal">
        <NotionButton
          type="button"
          variant="primary"
          disabled={disabled}
          onClick={onShowAnswer}
          aria-keyshortcuts="Space"
          className="wb-fc-show-answer h-auto min-h-11 w-full gap-2"
        >
          <Eye size={16} aria-hidden="true" />
          <span>{t('review.showAnswer')}</span>
          <kbd aria-hidden="true" className="wb-fc-keycap">Space</kbd>
        </NotionButton>
      </div>
    );
  }

  return (
    <div className="wb-fc-ratebar" data-mode="rate">
      {RATING_DESCRIPTORS.map((rating) => {
        const preview = previews?.[rating.value];
        const intervalLabel = preview ? formatInterval(preview.intervalMs) : null;
        return (
          <NotionButton
            key={rating.value}
            type="button"
            variant="default"
            disabled={disabled}
            data-pressed={pressedRating === rating.value ? 'true' : undefined}
            aria-keyshortcuts={String(rating.value)}
            onClick={(event) => onRate(rating.value, event)}
            className={cn(
              'wb-fc-rate-btn h-auto min-h-12 min-w-0 flex-col gap-0.5 px-1 py-1.5 text-xs',
              rating.tone,
            )}
            title={`${rating.value}${intervalLabel ? ` · ${intervalLabel}` : ''}`}
          >
            <kbd aria-hidden="true" className="wb-fc-keycap wb-fc-keycap--corner">
              {rating.value}
            </kbd>
            <span className="wb-fc-rate-label">{t(rating.labelKey)}</span>
            {intervalLabel ? (
              <span className="wb-fc-rate-interval">
                {t('session.intervalHint', { interval: intervalLabel })}
              </span>
            ) : null}
          </NotionButton>
        );
      })}
    </div>
  );
};
