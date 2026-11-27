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
  /** 翻面后再次按空格/回车触发的默认节拍档位 */
  defaultRhythm?: boolean;
}

export const RATING_DESCRIPTORS: RatingDescriptor[] = [
  {
    value: 1,
    labelKey: 'session.again',
    hintKey: 'session.againHint',
    tone: '!border-transparent !bg-transparent !text-foreground/85 hover:!bg-destructive/[0.08] hover:!text-destructive focus-visible:!text-destructive active:!bg-destructive/[0.12] data-[pressed=true]:!border-destructive/30 data-[pressed=true]:!bg-destructive/[0.12] data-[pressed=true]:!text-destructive',
  },
  {
    value: 2,
    labelKey: 'session.hard',
    hintKey: 'session.hardHint',
    tone: '!border-transparent !bg-transparent !text-foreground/85 hover:!bg-warning/[0.10] hover:!text-warning focus-visible:!text-warning active:!bg-warning/[0.15] data-[pressed=true]:!border-warning/30 data-[pressed=true]:!bg-warning/[0.15] data-[pressed=true]:!text-warning',
  },
  {
    value: 3,
    labelKey: 'session.good',
    hintKey: 'session.goodHint',
    tone: '!border-border/75 !bg-muted/45 !text-foreground hover:!border-success/35 hover:!bg-success/[0.10] hover:!text-success focus-visible:!text-success active:!bg-success/[0.15] data-[pressed=true]:!border-success/40 data-[pressed=true]:!bg-success/[0.16] data-[pressed=true]:!text-success',
    defaultRhythm: true,
  },
  {
    value: 4,
    labelKey: 'session.easy',
    hintKey: 'session.easyHint',
    tone: '!border-transparent !bg-transparent !text-foreground/85 hover:!bg-info/[0.10] hover:!text-info focus-visible:!text-info active:!bg-info/[0.15] data-[pressed=true]:!border-info/30 data-[pressed=true]:!bg-info/[0.15] data-[pressed=true]:!text-info',
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
        className="wb-fc-ratebar mx-auto w-full max-w-xl rounded-2xl border border-border/55 bg-background/85 p-1.5 backdrop-blur-md shadow-floating"
        data-mode="reveal"
      >
        <DsButton
          type="button"
          variant="ghost"
          disabled={disabled}
          onClick={onShowAnswer}
          aria-keyshortcuts="Space"
          className="wb-fc-show-answer h-auto min-h-11 w-full gap-2 rounded-xl !border-transparent !bg-foreground/[0.04] font-medium !text-foreground hover:!bg-foreground/[0.08] active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100"
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
      className="wb-fc-ratebar mx-auto w-full max-w-xl gap-1.5 rounded-2xl border border-border/55 bg-background/85 p-1.5 backdrop-blur-md shadow-floating sm:gap-2"
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
            data-default-rhythm={rating.defaultRhythm ? 'true' : undefined}
            aria-keyshortcuts={rating.defaultRhythm ? `${rating.value} Space` : String(rating.value)}
            onClick={(event) => onRate(rating.value, event)}
            className={cn(
              'wb-fc-rate-btn group !h-auto min-h-12 min-w-0 flex-col justify-center gap-1 rounded-xl px-2 py-2 text-xs shadow-none active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100',
              rating.tone,
            )}
            aria-label={label}
            title={`${label} · ${hint}${intervalLabel ? ` · ${intervalLabel}` : ''}`}
          >
            {intervalLabel ? (
              <span className="wb-fc-rate-interval font-mono text-2xs font-medium tabular-nums text-muted-foreground transition-colors group-hover:text-current motion-reduce:transition-none">
                {t('session.intervalHint', { interval: intervalLabel })}
              </span>
            ) : null}
            <span className="inline-flex items-center justify-center gap-1.5">
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
