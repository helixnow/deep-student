/**
 * 复习会话：模板卡面、Cloze、评分、撤销、编辑与暂停。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowClockwise,
  FloppyDisk,
  Pause,
  PencilSimple,
  Play,
  X,
} from '@phosphor-icons/react';
import { AnkiTemplateCardFace } from '@/components/anki/AnkiTemplateCardFace';
import { NotionButton } from '@/components/ui/NotionButton';
import { useAnkiTemplateLoader } from '@/hooks/useAnkiTemplateLoader';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { CustomAnkiTemplate } from '@/types';
import { cn } from '@/utils/cn';
import { hasValidCloze, renderClozeText } from '../cloze';
import { isEditableTarget } from '../isEditableTarget';
import {
  getReviewCardEditValues,
  isClozeReviewCard,
  toRenderableReviewCard,
} from '../reviewCardEditFields';
import {
  useFsrsReviewStore,
  type FsrsRating,
  type ReviewCard,
  type ReviewSessionErrorKind,
} from '../store/fsrsReviewStore';

const RATINGS: Array<{ value: FsrsRating; labelKey: string; tone: string }> = [
  { value: 1, labelKey: 'session.again', tone: 'border-destructive/40 text-destructive hover:bg-destructive/10' },
  { value: 2, labelKey: 'session.hard', tone: 'border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10' },
  { value: 3, labelKey: 'session.good', tone: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10' },
  { value: 4, labelKey: 'session.easy', tone: 'border-sky-500/40 text-sky-700 dark:text-sky-400 hover:bg-sky-500/10' },
];

function ratingFromKey(event: KeyboardEvent): FsrsRating | null {
  if (event.key === '1' || event.key === '2' || event.key === '3' || event.key === '4') {
    return Number(event.key) as FsrsRating;
  }
  switch (event.code) {
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

const ReviewCardSurface: React.FC<{
  card: ReviewCard;
  template: CustomAnkiTemplate | null;
  templateLoading: boolean;
  flipped: boolean;
  disabled: boolean;
  onFlip: () => void;
  frontLabel: string;
  backLabel: string;
  noFrontText: string;
  noBackText: string;
}> = ({
  card,
  template,
  templateLoading,
  flipped,
  disabled,
  onFlip,
  frontLabel,
  backLabel,
  noFrontText,
  noBackText,
}) => {
  const side = flipped ? 'back' : 'front';
  const isCloze = hasValidCloze(card.text);
  const fallbackText = isCloze
    ? renderClozeText(card.text ?? '', flipped)
    : flipped
      ? card.back || card.text || ''
      : card.front || card.text || '';
  const renderCard = React.useMemo(() => toRenderableReviewCard(card), [card]);

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-busy={templateLoading}
      aria-label={flipped ? frontLabel : backLabel}
      onClick={disabled ? undefined : onFlip}
      className={cn(
        'relative flex min-h-[16rem] min-w-0 flex-1 cursor-pointer flex-col overflow-auto rounded-lg border border-border/70',
        'bg-card px-5 py-6 text-center transition-colors',
        'hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        disabled && 'cursor-default opacity-70',
      )}
    >
      <span className="mb-3 text-[10px] uppercase text-muted-foreground/70">
        {flipped ? backLabel : frontLabel}
      </span>
      <AnkiTemplateCardFace
        card={renderCard}
        template={template}
        side={side}
        compact={false}
        fallbackText={fallbackText}
        emptyText={flipped ? noBackText : noFrontText}
        className="pointer-events-none flex min-h-0 flex-1 items-center justify-center [&_iframe]:max-h-[55vh]"
      />
      <ArrowClockwise
        size={14}
        className="pointer-events-none absolute bottom-3 right-3 text-muted-foreground/60"
        aria-hidden="true"
      />
    </div>
  );
};

function errorTitle(
  t: (key: string) => string,
  kind: ReviewSessionErrorKind | null,
): string {
  switch (kind) {
    case 'undo':
      return t('session.undoFailed');
    case 'edit':
      return t('session.editFailed');
    case 'suspend':
      return t('session.suspendFailed');
    case 'resume':
      return t('session.resumeFailed');
    case 'rate':
    default:
      return t('session.rateFailed');
  }
}

export const ReviewSessionScreen: React.FC = () => {
  const { t } = useTranslation('flashcards');
  const queue = useFsrsReviewStore((state) => state.queue);
  const queueIndex = useFsrsReviewStore((state) => state.queueIndex);
  const flipped = useFsrsReviewStore((state) => state.flipped);
  const ratingBusy = useFsrsReviewStore((state) => state.ratingBusy);
  const loading = useFsrsReviewStore((state) => state.loading);
  const error = useFsrsReviewStore((state) => state.error);
  const errorKind = useFsrsReviewStore((state) => state.errorKind);
  const lastRated = useFsrsReviewStore((state) => state.lastRated);
  const lastReview = useFsrsReviewStore((state) => state.lastReview);
  const lastSuspended = useFsrsReviewStore((state) => state.lastSuspended);
  const retryBatchRequest = useFsrsReviewStore((state) => state.retryBatchRequest);
  const current = queue[queueIndex];
  const { template, loading: templateLoading } = useAnkiTemplateLoader(current?.templateId);
  const flip = useFsrsReviewStore((state) => state.flip);
  const rate = useFsrsReviewStore((state) => state.rate);
  const undoLastReview = useFsrsReviewStore((state) => state.undoLastReview);
  const updateCurrentCard = useFsrsReviewStore((state) => state.updateCurrentCard);
  const suspendCurrent = useFsrsReviewStore((state) => state.suspendCurrent);
  const resumeLastSuspended = useFsrsReviewStore((state) => state.resumeLastSuspended);
  const retryBatchSession = useFsrsReviewStore((state) => state.retryBatchSession);
  const endSession = useFsrsReviewStore((state) => state.endSession);
  const [editing, setEditing] = React.useState(false);
  const [draftFront, setDraftFront] = React.useState('');
  const [draftBack, setDraftBack] = React.useState('');
  const editedCardIdentityRef = React.useRef<string | null>(null);

  const progress = queue.length > 0 ? Math.min(queueIndex + 1, queue.length) : 0;
  const sessionDone = !loading && queue.length > 0 && queueIndex >= queue.length;
  const draftIsCloze = Boolean(current && isClozeReviewCard(current, template));
  const draftIsValid = Boolean(
    current
    && draftFront.trim()
    && (draftIsCloze ? hasValidCloze(draftFront) : draftBack.trim()),
  );

  React.useEffect(() => {
    const cardIdentity = current ? `${current.id}:${current.ankiCardId ?? ''}` : null;
    const cardChanged = editedCardIdentityRef.current !== cardIdentity;
    editedCardIdentityRef.current = cardIdentity;
    if (cardChanged) setEditing(false);
    if (!cardChanged && editing) return;
    if (!current) {
      setDraftFront('');
      setDraftBack('');
      return;
    }
    const values = getReviewCardEditValues(current, template);
    setDraftFront(values.front);
    setDraftBack(values.back);
  }, [current, editing, template]);

  const onKeyDown = React.useCallback((rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.isComposing || event.keyCode === 229 || event.repeat) return;
    if (isEditableTarget(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || ratingBusy) return;

    if ((event.key.toLowerCase() === 'z' || event.code === 'KeyZ') && lastReview) {
      event.preventDefault();
      void undoLastReview();
      return;
    }
    if (loading || !current || sessionDone || editing) return;

    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      flip();
      return;
    }
    if (!flipped && event.key === 'Enter') {
      event.preventDefault();
      flip();
      return;
    }
    if (flipped) {
      const rating = ratingFromKey(event);
      if (rating != null) {
        event.preventDefault();
        void rate(rating);
      }
    }
  }, [
    current,
    editing,
    flipped,
    lastReview,
    loading,
    rate,
    ratingBusy,
    sessionDone,
    flip,
    undoLastReview,
  ]);
  useEventRegistry(
    [{ target: 'window', type: 'keydown', listener: onKeyDown }],
    [onKeyDown],
  );

  const beginEdit = () => {
    if (!current || ratingBusy || templateLoading) return;
    const values = getReviewCardEditValues(current, template);
    setDraftFront(values.front);
    setDraftBack(values.back);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (await updateCurrentCard(draftFront, draftBack, template)) setEditing(false);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t('session.loading')}
      </div>
    );
  }

  if (error && !current && (errorKind === 'prepare' || retryBatchRequest)) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {t('session.prepareFailed')}
          </p>
          <p className="max-w-md break-words text-xs text-destructive/90">{error}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {retryBatchRequest ? (
            <NotionButton type="button" variant="primary" onClick={() => void retryBatchSession()}>
              <ArrowClockwise size={16} />
              {t('session.retry')}
            </NotionButton>
          ) : null}
          <NotionButton type="button" variant="default" onClick={endSession}>
            {t('session.backToday')}
          </NotionButton>
        </div>
      </div>
    );
  }

  if (!current || sessionDone) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-muted-foreground">{t('session.done')}</p>
        <div className="flex items-center gap-2">
          {lastReview ? (
            <NotionButton
              type="button"
              variant="default"
              disabled={ratingBusy}
              onClick={() => void undoLastReview()}
            >
              <ArrowCounterClockwise size={16} />
              {t('session.undo')}
            </NotionButton>
          ) : null}
          {lastSuspended ? (
            <NotionButton
              type="button"
              variant="default"
              disabled={ratingBusy}
              onClick={() => void resumeLastSuspended()}
            >
              <Play size={16} />
              {t('session.resume')}
            </NotionButton>
          ) : null}
          <NotionButton type="button" variant="primary" onClick={endSession}>
            {t('session.backToday')}
          </NotionButton>
        </div>
        {error ? (
          <div role="alert" className="max-w-md rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
            <p className="text-xs font-medium text-destructive">{errorTitle(t, errorKind)}</p>
            <p className="mt-0.5 break-words text-[11px] text-destructive/90">{error}</p>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <NotionButton type="button" variant="ghost" size="sm" onClick={endSession} className="gap-1">
          <ArrowLeft size={14} />
          {t('session.exit')}
        </NotionButton>
        <div className="text-xs text-muted-foreground">
          {t('session.progress', {
            current: progress,
            total: queue.length,
          })}
        </div>
      </div>

      <div className="flex items-center justify-end gap-1">
        <NotionButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          disabled={!lastReview || ratingBusy}
          onClick={() => void undoLastReview()}
          aria-label={t('session.undo')}
          title={t('session.undo')}
        >
          <ArrowCounterClockwise size={16} />
        </NotionButton>
        {lastSuspended ? (
          <NotionButton
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            disabled={ratingBusy}
            onClick={() => void resumeLastSuspended()}
            aria-label={t('session.resume')}
            title={t('session.resume')}
          >
            <Play size={16} />
          </NotionButton>
        ) : null}
        <NotionButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          disabled={ratingBusy || templateLoading || !current.ankiCardId}
          onClick={beginEdit}
          aria-label={t('session.edit')}
          title={t('session.edit')}
        >
          <PencilSimple size={16} />
        </NotionButton>
        <NotionButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          disabled={ratingBusy}
          onClick={() => void suspendCurrent()}
          aria-label={t('session.suspend')}
          title={t('session.suspend')}
        >
          <Pause size={16} />
        </NotionButton>
      </div>

      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto rounded-lg border border-border/70 bg-card p-4">
          <label className="flex min-h-0 flex-1 flex-col gap-1.5 text-left text-xs font-medium text-muted-foreground">
            {t('session.front')}
            <textarea
              value={draftFront}
              onChange={(event) => setDraftFront(event.target.value)}
              className="min-h-28 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm font-normal text-foreground outline-none focus:border-ring"
            />
          </label>
          <label className="flex min-h-0 flex-1 flex-col gap-1.5 text-left text-xs font-medium text-muted-foreground">
            {t('session.back')}
            <textarea
              value={draftBack}
              onChange={(event) => setDraftBack(event.target.value)}
              className="min-h-28 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm font-normal text-foreground outline-none focus:border-ring"
            />
          </label>
          <div className="flex justify-end gap-2">
            <NotionButton
              type="button"
              variant="ghost"
              disabled={ratingBusy}
              onClick={() => setEditing(false)}
            >
              <X size={16} />
              {t('session.cancelEdit')}
            </NotionButton>
            <NotionButton
              type="button"
              variant="primary"
              disabled={ratingBusy || !draftIsValid}
              onClick={() => void saveEdit()}
            >
              <FloppyDisk size={16} />
              {t('session.saveEdit')}
            </NotionButton>
          </div>
        </div>
      ) : (
        <ReviewCardSurface
          card={current}
          template={template}
          templateLoading={templateLoading}
          flipped={flipped}
          disabled={ratingBusy}
          onFlip={flip}
          frontLabel={t('session.front')}
          backLabel={t('session.back')}
          noFrontText={t('card.untitled')}
          noBackText={t('card.noBack')}
        />
      )}

      <div className="grid grid-cols-4 gap-2">
        {RATINGS.map((rating) => (
          <NotionButton
            key={rating.value}
            type="button"
            variant="default"
            disabled={!flipped || ratingBusy || editing}
            onClick={() => void rate(rating.value)}
            className={cn('h-11 min-w-0 px-1 text-xs', rating.tone)}
            title={`${rating.value}`}
          >
            {t(rating.labelKey)}
          </NotionButton>
        ))}
      </div>
      {error ? (
        <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2">
          <div className="min-w-0 space-y-0.5">
            <p className="text-xs font-medium text-destructive">{errorTitle(t, errorKind)}</p>
            <p className="break-words text-[11px] text-destructive/90">{error}</p>
          </div>
          {errorKind === 'rate' && lastRated ? (
            <NotionButton
              type="button"
              size="sm"
              variant="default"
              disabled={ratingBusy}
              onClick={() => void rate(lastRated)}
              className="shrink-0 text-xs"
            >
              <ArrowClockwise size={14} />
              {t('session.retry')}
            </NotionButton>
          ) : null}
        </div>
      ) : null}
      <div className="h-4" />
    </div>
  );
};
