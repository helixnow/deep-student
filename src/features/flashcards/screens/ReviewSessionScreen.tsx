/**
 * 复习会话 — 翻面 + 1/2/3/4 评分（含键盘）
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowClockwise } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/utils/cn';
import { isEditableTarget } from '../isEditableTarget';
import { useFsrsReviewStore, type FsrsRating } from '../store/fsrsReviewStore';

const RATINGS: Array<{ value: FsrsRating; labelKey: string; fallback: string; tone: string }> = [
  { value: 1, labelKey: 'session.again', fallback: '重来', tone: 'border-destructive/40 text-destructive hover:bg-destructive/10' },
  { value: 2, labelKey: 'session.hard', fallback: '困难', tone: 'border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10' },
  { value: 3, labelKey: 'session.good', fallback: '良好', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10' },
  { value: 4, labelKey: 'session.easy', fallback: '简单', tone: 'border-sky-500/40 text-sky-700 dark:text-sky-400 hover:bg-sky-500/10' },
];

function ratingFromKey(e: KeyboardEvent): FsrsRating | null {
  const fromKey = e.key;
  if (fromKey === '1' || fromKey === '2' || fromKey === '3' || fromKey === '4') {
    return Number(fromKey) as FsrsRating;
  }
  switch (e.code) {
    case 'Digit1':
    case 'Numpad1':
      return 1;
    case 'Digit2':
    case 'Numpad2':
      return 2;
    case 'Digit3':
    case 'Numpad3':
      return 3;
    case 'Digit4':
    case 'Numpad4':
      return 4;
    default:
      return null;
  }
}

export const ReviewSessionScreen: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const queue = useFsrsReviewStore((s) => s.queue);
  const queueIndex = useFsrsReviewStore((s) => s.queueIndex);
  const flipped = useFsrsReviewStore((s) => s.flipped);
  const ratingBusy = useFsrsReviewStore((s) => s.ratingBusy);
  const usingMock = useFsrsReviewStore((s) => s.usingMock);
  const loading = useFsrsReviewStore((s) => s.loading);
  const flip = useFsrsReviewStore((s) => s.flip);
  const rate = useFsrsReviewStore((s) => s.rate);
  const endSession = useFsrsReviewStore((s) => s.endSession);

  const current = queue[queueIndex];
  const progress = queue.length > 0 ? Math.min(queueIndex + 1, queue.length) : 0;
  const sessionDone = !loading && queue.length > 0 && queueIndex >= queue.length;

  React.useEffect(() => {
    if (loading || !current || sessionDone) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (isEditableTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Space：与点击一样双向翻面；Enter：仅正面→背面
      if (e.code === 'Space' || e.key === ' ') {
        e.preventDefault();
        flip();
        return;
      }
      if (!flipped && e.key === 'Enter') {
        e.preventDefault();
        flip();
        return;
      }

      if (flipped && !ratingBusy) {
        const rating = ratingFromKey(e);
        if (rating != null) {
          e.preventDefault();
          void rate(rating);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [loading, current, sessionDone, flipped, ratingBusy, flip, rate]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('session.loading', '准备复习队列…')}
      </div>
    );
  }

  if (!current || sessionDone) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t('session.done', '本轮复习已完成')}</p>
        <NotionButton type="button" variant="primary" onClick={endSession}>
          {t('session.backToday', '返回今日')}
        </NotionButton>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <NotionButton type="button" variant="ghost" size="sm" onClick={endSession} className="gap-1">
          <ArrowLeft size={14} />
          {t('session.exit', '退出')}
        </NotionButton>
        <div className="text-xs text-muted-foreground">
          {t('session.progress', '{{current}} / {{total}}', {
            current: progress,
            total: queue.length,
          })}
          {usingMock ? (
            <span className="ml-2 text-amber-600/90">{t('session.mockHint', '演示')}</span>
          ) : null}
        </div>
      </div>

      <button
        type="button"
        onClick={flip}
        className={cn(
          'flex min-h-0 flex-1 flex-col items-center justify-center rounded-xl border border-border/70',
          'bg-card px-5 py-8 text-center transition-colors',
          'hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
        aria-label={flipped ? t('session.showFront', '显示正面') : t('session.showBack', '显示背面')}
      >
        <span className="mb-3 text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {flipped ? t('session.back', '背面') : t('session.front', '正面')}
        </span>
        <p className="max-w-prose whitespace-pre-wrap text-base font-medium leading-relaxed text-foreground sm:text-lg">
          {flipped ? current.back || t('card.noBack', '无背面') : current.front || t('card.untitled', '无正面')}
        </p>
        <span className="mt-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <ArrowClockwise size={12} />
          {t('session.tapToFlip', '点击翻面')}
          <kbd className="rounded border border-border/60 bg-muted/40 px-1 py-px font-mono text-[10px] text-muted-foreground">
            Space
          </kbd>
        </span>
      </button>

      <div className="grid grid-cols-4 gap-2">
        {RATINGS.map((r) => (
          <NotionButton
            key={r.value}
            type="button"
            variant="default"
            disabled={!flipped || ratingBusy}
            onClick={() => void rate(r.value)}
            className={cn('flex-col gap-0.5 py-2 text-xs sm:text-sm', r.tone)}
            title={`${r.value}`}
          >
            <kbd className="rounded border border-border/50 bg-muted/30 px-1 py-px font-mono text-[10px] opacity-70">
              {r.value}
            </kbd>
            {t(r.labelKey, r.fallback)}
          </NotionButton>
        ))}
      </div>
      {!flipped ? (
        <p className="text-center text-[11px] text-muted-foreground">
          {t('session.flipFirst', '请先翻面再评分')}
        </p>
      ) : (
        <div className="h-4" />
      )}
    </div>
  );
};
