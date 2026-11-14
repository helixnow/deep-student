/**
 * 评分栏：翻面前显示「显示答案」，翻面后显示 Again/Hard/Good/Easy 四键，
 * 带预测间隔、键位提示与按键反馈动画。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Eye } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import {
  formatInterval,
  type FsrsRating,
  type RatingPreviews,
} from '../store/fsrsReviewStore';

export interface RatingDescriptor {
  value: FsrsRating;
  labelKey: string;
  /** 现场可读的评分判断标准（F09），避免用户凭感觉把「忘了」打成 Hard */
  hintKey: string;
  tone: string;
  dotClass: string;
}

export const RATING_DESCRIPTORS: RatingDescriptor[] = [
  {
    value: 1,
    labelKey: 'session.again',
    hintKey: 'session.againHint',
    tone: 'border-transparent bg-transparent text-foreground/85 hover:bg-destructive/[0.06] hover:text-destructive focus-visible:text-destructive',
    dotClass: 'bg-destructive',
  },
  {
    value: 2,
    labelKey: 'session.hard',
    hintKey: 'session.hardHint',
    tone: 'border-transparent bg-transparent text-foreground/85 hover:bg-amber-500/[0.07] hover:text-amber-700 dark:hover:text-amber-400 focus-visible:text-amber-700 dark:focus-visible:text-amber-400',
    dotClass: 'bg-amber-500',
  },
  {
    value: 3,
    labelKey: 'session.good',
    hintKey: 'session.goodHint',
    tone: 'border-transparent bg-transparent text-foreground/85 hover:bg-emerald-500/[0.07] hover:text-emerald-700 dark:hover:text-emerald-400 focus-visible:text-emerald-700 dark:focus-visible:text-emerald-400',
    dotClass: 'bg-emerald-500',
  },
  {
    value: 4,
    labelKey: 'session.easy',
    hintKey: 'session.easyHint',
    tone: 'border-transparent bg-transparent text-foreground/85 hover:bg-sky-500/[0.07] hover:text-sky-700 dark:hover:text-sky-400 focus-visible:text-sky-700 dark:focus-visible:text-sky-400',
    dotClass: 'bg-sky-500',
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
      <div
        className="wb-fc-ratebar mx-auto w-full max-w-xl rounded-2xl border border-border/55 bg-background/85 p-1.5 backdrop-blur-md shadow-[0_12px_32px_-12px_rgba(15,23,42,0.16)]"
        data-mode="reveal"
      >
        <DsButton
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={onShowAnswer}
          aria-keyshortcuts="Space"
          className="wb-fc-show-answer h-auto min-h-11 w-full gap-2 rounded-xl border-transparent bg-foreground/[0.04] font-medium text-foreground hover:bg-foreground/[0.08]"
        >
          <Eye size={16} aria-hidden="true" />
          <span>{t('review.showAnswer')}</span>
          <kbd aria-hidden="true" className="wb-fc-keycap">Space</kbd>
        </DsButton>
      </div>
    );
  }

  return (
    // F09 评分标准不再常驻一行：挂在评分栏与各按钮的悬停提示上
    <div
      className="wb-fc-ratebar mx-auto w-full max-w-xl rounded-2xl border border-border/55 bg-background/85 p-1.5 backdrop-blur-md shadow-[0_12px_32px_-12px_rgba(15,23,42,0.16)]"
      data-mode="rate"
      title={t('review.ratingGuide')}
    >
      {RATING_DESCRIPTORS.map((rating) => {
        const preview = previews?.[rating.value];
        const intervalLabel = preview ? formatInterval(preview.intervalMs) : null;
        const label = t(rating.labelKey);
        const hint = t(rating.hintKey);
        return (
          <DsButton
            key={rating.value}
            type="button"
            variant="ghost"
            disabled={disabled}
            data-pressed={pressedRating === rating.value ? 'true' : undefined}
            data-rating={rating.value}
            aria-keyshortcuts={String(rating.value)}
            onClick={(event) => onRate(rating.value, event)}
            className={cn(
              'wb-fc-rate-btn group h-auto min-h-12 min-w-0 flex-col justify-center gap-1 rounded-xl px-2 py-2 text-xs shadow-none',
              rating.tone,
            )}
            aria-label={label}
            title={`${label} · ${hint}${intervalLabel ? ` · ${intervalLabel}` : ''}`}
          >
            {intervalLabel ? (
              <span className="wb-fc-rate-interval font-mono text-[11px] tabular-nums text-muted-foreground transition-colors group-hover:text-current">
                {t('session.intervalHint', { interval: intervalLabel })}
              </span>
            ) : null}
            <span className="inline-flex items-center justify-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  'wb-fc-rate-dot h-1.5 w-1.5 shrink-0 rounded-full opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[pressed=true]:opacity-100',
                  rating.dotClass,
                )}
              />
              <kbd aria-hidden="true" className="wb-fc-keycap">
                {rating.value}
              </kbd>
              <span className="wb-fc-rate-label text-xs font-medium">{label}</span>
            </span>
          </DsButton>
        );
      })}
    </div>
  );
};
