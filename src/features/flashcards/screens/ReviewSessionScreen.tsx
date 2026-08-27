/**
 * 复习会话：模板卡面、Cloze、评分、撤销、编辑、暂停/跳过。
 *
 * 键盘流：Space/Enter 翻面（已翻面时评 Good）、1–4 评分、
 * Z 或 Ctrl/Cmd+Z 撤销、E 编辑、S 跳过；编辑中 Esc 取消、Ctrl/Cmd+Enter 保存。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowClockwise,
  FloppyDisk,
  Hourglass,
  Info,
  Lightning,
  Pause,
  PencilSimple,
  Play,
  SkipForward,
  Timer,
  Warning,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useAnkiTemplateLoader } from '@/hooks/useAnkiTemplateLoader';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/utils/cn';
import { hasValidCloze } from '../cloze';
import { useSwipeRating } from '../hooks/useSwipeRating';
import { isEditableTarget } from '../isEditableTarget';
import {
  getReviewCardEditValues,
  isClozeReviewCard,
} from '../reviewCardEditFields';
import {
  isReviewSessionDone,
  isReviewSessionEmpty,
  useFsrsReviewStore,
  type FsrsRating,
  type ReviewSessionErrorKind,
} from '../store/fsrsReviewStore';
import { RatingBar } from '../review/RatingBar';
import { ReviewCardSurface } from '../review/ReviewCardSurface';
import { SessionSummary } from '../review/SessionSummary';
import { UndoNudge } from '../review/UndoNudge';
import { formatDuration, useNow } from '../review/useSessionClock';

/** 翻面后短时间内忽略指针评分，防止翻面双击误评（键盘不受限） */
const POINTER_RATE_GUARD_MS = 280;
const PRESS_FLASH_MS = 240;
const STREAK_BADGE_THRESHOLD = 3;
/** 本卡用时的显示封顶：超过后定格为「1:00+」。仅影响 UI，落库用时仍走 store 的 MAX_ANSWER_DURATION_MS */
const CARD_TIMER_DISPLAY_CAP_MS = 60_000;

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

export interface ReviewSessionScreenProps {
  /** 工作台窗口/标签页是否处于前台；后台实例不得接管全局评分快捷键。 */
  isActive?: boolean;
}

export const ReviewSessionScreen: React.FC<ReviewSessionScreenProps> = ({
  isActive = true,
}) => {
  const { t } = useTranslation('flashcards');
  const queue = useFsrsReviewStore((state) => state.queue);
  const queueIndex = useFsrsReviewStore((state) => state.queueIndex);
  const sessionMode = useFsrsReviewStore((state) => state.sessionMode);
  const flipped = useFsrsReviewStore((state) => state.flipped);
  const ratingBusy = useFsrsReviewStore((state) => state.ratingBusy);
  const loading = useFsrsReviewStore((state) => state.loading);
  const error = useFsrsReviewStore((state) => state.error);
  const errorKind = useFsrsReviewStore((state) => state.errorKind);
  const lastRated = useFsrsReviewStore((state) => state.lastRated);
  const lastReview = useFsrsReviewStore((state) => state.lastReview);
  const lastSuspended = useFsrsReviewStore((state) => state.lastSuspended);
  const retryBatchRequest = useFsrsReviewStore((state) => state.retryBatchRequest);
  const sessionRatedCount = useFsrsReviewStore((state) => state.sessionRatedCount);
  const sessionRatingCounts = useFsrsReviewStore((state) => state.sessionRatingCounts);
  const sessionStreak = useFsrsReviewStore((state) => state.sessionStreak);
  const sessionBestStreak = useFsrsReviewStore((state) => state.sessionBestStreak);
  const sessionStartedAtMs = useFsrsReviewStore((state) => state.sessionStartedAtMs);
  const remainingDueAfterSession = useFsrsReviewStore((state) => state.remainingDueAfterSession);
  const ratingPreviews = useFsrsReviewStore((state) => state.ratingPreviews);
  const current = queue[queueIndex];
  const { template, loading: templateLoading } = useAnkiTemplateLoader(current?.templateId);
  const flip = useFsrsReviewStore((state) => state.flip);
  const rate = useFsrsReviewStore((state) => state.rate);
  const undoLastReview = useFsrsReviewStore((state) => state.undoLastReview);
  const updateCurrentCard = useFsrsReviewStore((state) => state.updateCurrentCard);
  const suspendCurrent = useFsrsReviewStore((state) => state.suspendCurrent);
  const resumeLastSuspended = useFsrsReviewStore((state) => state.resumeLastSuspended);
  const skipCurrent = useFsrsReviewStore((state) => state.skipCurrent);
  const retryBatchSession = useFsrsReviewStore((state) => state.retryBatchSession);
  const endSession = useFsrsReviewStore((state) => state.endSession);
  const loadDue = useFsrsReviewStore((state) => state.loadDue);
  const startDueSession = useFsrsReviewStore((state) => state.startDueSession);

  const [editing, setEditing] = React.useState(false);
  const [draftFront, setDraftFront] = React.useState('');
  const [draftBack, setDraftBack] = React.useState('');
  const editedCardIdentityRef = React.useRef<string | null>(null);

  // 批次集中复习的一次性提示（每次会话开始时重置）
  const [batchNoticeDismissed, setBatchNoticeDismissed] = React.useState(false);
  React.useEffect(() => {
    setBatchNoticeDismissed(false);
  }, [sessionStartedAtMs]);

  // 键盘评分的按钮闪烁反馈
  const [pressedRating, setPressedRating] = React.useState<FsrsRating | null>(null);
  const pressTimerRef = React.useRef<number | null>(null);
  React.useEffect(() => () => {
    if (pressTimerRef.current != null) window.clearTimeout(pressTimerRef.current);
  }, []);

  // 指针防误触：记录最近一次翻到背面的时间
  const flippedAtRef = React.useRef(0);

  const progress = queue.length > 0 ? Math.min(queueIndex + 1, queue.length) : 0;
  const sessionDone = isReviewSessionDone({ queue, queueIndex, loading });
  const sessionEmpty = isReviewSessionEmpty({ queue, loading });
  const draftIsCloze = Boolean(current && isClozeReviewCard(current, template));
  const draftClozeInvalid = draftIsCloze && Boolean(draftFront.trim()) && !hasValidCloze(draftFront);
  const draftIsValid = Boolean(
    current
    && draftFront.trim()
    && (draftIsCloze ? hasValidCloze(draftFront) : draftBack.trim()),
  );
  const flipAriaLabel = flipped
    ? t('session.showFront')
    : t('session.showBack');

  // ---- 前端计时（本卡用时 + 本轮用时） ----
  const cardKey = current ? `${current.id}:${current.ankiCardId ?? ''}` : null;
  const clockEnabled = !loading && Boolean(current) && !sessionDone && !editing;
  const now = useNow(clockEnabled);
  const [cardShownAt, setCardShownAt] = React.useState(() => Date.now());
  React.useEffect(() => {
    setCardShownAt(Date.now());
  }, [cardKey, sessionRatedCount]);
  const [doneAt, setDoneAt] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (sessionDone) {
      setDoneAt((prev) => prev ?? Date.now());
    } else {
      setDoneAt(null);
    }
  }, [sessionDone]);
  const cardElapsedMs = Math.max(0, now - cardShownAt);
  const cardTimerCapped = cardElapsedMs >= CARD_TIMER_DISPLAY_CAP_MS;
  const cardTimerText = cardTimerCapped
    ? `${formatDuration(CARD_TIMER_DISPLAY_CAP_MS)}+`
    : formatDuration(cardElapsedMs);
  const sessionElapsedMs = sessionStartedAtMs != null
    ? Math.max(0, (doneAt ?? now) - sessionStartedAtMs)
    : null;
  // 学习步回插卡：真实 due 尚在未来时提示「提前复习」及剩余等待
  const learningWaitMs = current?.learningDueMs != null && current.learningDueMs > now
    ? current.learningDueMs - now
    : null;

  // ---- 剩余队列计数（new = 从未评过；learn = 已有复习记录） ----
  const upcoming = React.useMemo(
    () => queue.slice(queueIndex).filter((card) => card.suspended !== true),
    [queue, queueIndex],
  );
  const remainingCount = upcoming.length;
  const newCount = React.useMemo(
    () => upcoming.filter((card) => card.lastReviewMs === null).length,
    [upcoming],
  );
  const learnCount = React.useMemo(
    () => upcoming.filter((card) => typeof card.lastReviewMs === 'number').length,
    [upcoming],
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

  const flashRating = React.useCallback((rating: FsrsRating) => {
    if (pressTimerRef.current != null) window.clearTimeout(pressTimerRef.current);
    setPressedRating(rating);
    pressTimerRef.current = window.setTimeout(() => {
      setPressedRating(null);
      pressTimerRef.current = null;
    }, PRESS_FLASH_MS);
  }, []);

  const handleFlip = React.useCallback(() => {
    if (!flipped) flippedAtRef.current = Date.now();
    flip();
  }, [flip, flipped]);

  const handleRate = React.useCallback((rating: FsrsRating) => {
    if (ratingBusy || !flipped) return;
    flashRating(rating);
    void rate(rating);
  }, [flashRating, flipped, rate, ratingBusy]);

  const handleRateClick = React.useCallback((
    rating: FsrsRating,
    event: React.MouseEvent<HTMLButtonElement>,
  ) => {
    // 真实指针点击（detail>0）在翻面后的极短窗口内忽略，防止双击卡面误评
    if (event.detail > 0 && Date.now() - flippedAtRef.current < POINTER_RATE_GUARD_MS) {
      return;
    }
    handleRate(rating);
  }, [handleRate]);

  // 滑动评分手势：翻面后拖动卡面评分（左=Again 右=Good 上=Easy 下=Hard），
  // 手势逻辑与视觉反馈见 useSwipeRating / ReviewCardSurface。
  const swipeEnabled =
    flipped && !ratingBusy && !editing && !loading && !sessionDone && Boolean(current);
  const swipe = useSwipeRating({
    enabled: swipeEnabled,
    resetKey: cardKey,
    onRate: handleRate,
  });
  // 评分失败（错误条出现）时把已飞出的卡片拉回原位，避免卡面空悬
  const swipeReset = swipe.reset;
  React.useEffect(() => {
    if (error && errorKind === 'rate') swipeReset();
  }, [error, errorKind, swipeReset]);

  const beginEdit = React.useCallback(() => {
    const live = useFsrsReviewStore.getState();
    const liveCurrent = live.queue[live.queueIndex];
    if (!liveCurrent || live.ratingBusy || templateLoading || !liveCurrent.ankiCardId) return;
    const values = getReviewCardEditValues(liveCurrent, template);
    setDraftFront(values.front);
    setDraftBack(values.back);
    setEditing(true);
  }, [template, templateLoading]);

  const saveEdit = React.useCallback(async () => {
    if (await updateCurrentCard(draftFront, draftBack, template)) setEditing(false);
  }, [draftBack, draftFront, template, updateCurrentCard]);

  // 完成态「继续复习」：重新拉取到期队列并直接开新一轮，不必回 Today
  const continueWithDue = React.useCallback(() => {
    void loadDue().then((loaded) => {
      if (loaded) startDueSession();
    });
  }, [loadDue, startDueSession]);

  const onKeyDown = React.useCallback((rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.isComposing || event.keyCode === 229 || event.repeat) return;
    if (isEditableTarget(event.target)) return;
    if (ratingBusy || editing) return;

    // 撤销：Z 与 Ctrl/Cmd+Z 都支持（完成态也可用）
    const isUndoKey = event.key.toLowerCase() === 'z' || event.code === 'KeyZ';
    if (isUndoKey && !event.altKey && !event.shiftKey) {
      if (lastReview) {
        event.preventDefault();
        void undoLastReview();
      }
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (loading || !current || sessionDone) return;

    if (event.code === 'Space' || event.key === ' ') {
      event.preventDefault();
      if (!flipped) {
        handleFlip();
      } else {
        handleRate(3);
      }
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!flipped) {
        handleFlip();
      } else {
        handleRate(3);
      }
      return;
    }
    if (flipped) {
      const rating = ratingFromKey(event);
      if (rating != null) {
        event.preventDefault();
        handleRate(rating);
        return;
      }
    }
    if (event.key.toLowerCase() === 'e' || event.code === 'KeyE') {
      event.preventDefault();
      beginEdit();
      return;
    }
    if (event.key.toLowerCase() === 's' || event.code === 'KeyS') {
      event.preventDefault();
      skipCurrent();
    }
  }, [
    beginEdit,
    current,
    editing,
    flipped,
    handleFlip,
    handleRate,
    lastReview,
    loading,
    ratingBusy,
    sessionDone,
    skipCurrent,
    undoLastReview,
  ]);
  useEventRegistry(
    isActive ? [{ target: 'window', type: 'keydown', listener: onKeyDown }] : [],
    [isActive, onKeyDown],
  );

  const onEditKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setEditing(false);
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (draftIsValid && !ratingBusy) void saveEdit();
    }
  }, [draftIsValid, ratingBusy, saveEdit]);

  const errorBanner = error ? (
    <div role="alert" className="wb-fc-session-error flex items-start justify-between gap-3">
      <div className="min-w-0 flex items-start gap-2">
        <Warning size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-0.5 text-left">
          <p className="text-xs font-medium text-destructive">{errorTitle(t, errorKind)}</p>
          <p className="break-words text-[11px] text-destructive/90">{error}</p>
        </div>
      </div>
      {errorKind === 'rate' && lastRated && flipped ? (
        <DsButton
          type="button"
          size="sm"
          variant="default"
          disabled={ratingBusy}
          onClick={() => void rate(lastRated)}
          className="shrink-0 text-xs [@media(pointer:coarse)]:!min-h-11"
        >
          <ArrowClockwise size={14} />
          {t('session.retry')}
        </DsButton>
      ) : null}
    </div>
  ) : null;

  if (loading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <span className="wb-fc-spinner" aria-hidden="true" />
        {t('session.loading')}
      </div>
    );
  }

  if (error && !current && (errorKind === 'prepare' || retryBatchRequest)) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="wb-fc-summary-icon wb-fc-summary-icon--error">
          <Warning size={30} weight="duotone" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            {t('session.prepareFailed')}
          </p>
          <p className="max-w-md break-words text-xs text-destructive/90">{error}</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {retryBatchRequest ? (
            <DsButton
              type="button"
              variant="primary"
              onClick={() => void retryBatchSession()}
              className="[@media(pointer:coarse)]:!min-h-11"
            >
              <ArrowClockwise size={16} />
              {t('session.retry')}
            </DsButton>
          ) : null}
          <DsButton
            type="button"
            variant="default"
            onClick={endSession}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {t('session.backToday')}
          </DsButton>
        </div>
      </div>
    );
  }

  if (sessionEmpty || !current || sessionDone) {
    const stillDue = (remainingDueAfterSession ?? 0) > 0;
    const headline = sessionEmpty
      ? t('session.emptyQueue')
      : stillDue
        ? t('session.batchDoneRemaining', { count: remainingDueAfterSession })
        : t('session.done');

    return (
      <SessionSummary
        empty={sessionEmpty}
        headline={headline}
        ratedCount={sessionRatedCount}
        ratingCounts={sessionRatingCounts}
        bestStreak={sessionBestStreak}
        elapsedMs={sessionEmpty ? null : sessionElapsedMs}
        remainingDue={remainingDueAfterSession}
        busy={ratingBusy}
        canUndo={Boolean(lastReview)}
        canResume={Boolean(lastSuspended)}
        onUndo={() => void undoLastReview()}
        onResume={() => void resumeLastSuspended()}
        onBack={endSession}
        onContinue={continueWithDue}
        errorBanner={errorBanner}
      />
    );
  }

  const progressPct = queue.length > 0
    ? Math.round((Math.min(queueIndex, queue.length) / queue.length) * 100)
    : 0;

  // 底部留出移动端手势导航安全区（评分栏贴屏幕底部，避免与 Home indicator 冲突）
  return (
    <div className="wb-fc-session flex h-full min-h-0 flex-col gap-3 px-4 pt-4 pb-[calc(1rem+var(--mobile-safe-area-bottom,0px))] sm:px-5 sm:pt-5 sm:pb-[calc(1.25rem+var(--mobile-safe-area-bottom,0px))]">
      <div
        className="wb-fc-session-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={queue.length}
        aria-valuenow={Math.min(queueIndex, queue.length)}
        aria-label={t('review.progressLabel')}
      >
        <div className="wb-fc-session-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      {sessionMode === 'batch' && !batchNoticeDismissed ? (
        <div
          role="status"
          className="flex items-start justify-between gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-xs text-foreground"
        >
          <span className="flex min-w-0 items-start gap-1.5">
            <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-info" />
            {t('session.batchNotice')}
          </span>
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            onClick={() => setBatchNoticeDismissed(true)}
            aria-label={t('library.dismiss')}
            title={t('library.dismiss')}
            className="shrink-0 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          >
            <X size={13} />
          </DsButton>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-2">
        <DsButton type="button" variant="ghost" size="sm" onClick={endSession} className="gap-1 [@media(pointer:coarse)]:!min-h-11">
          <ArrowLeft size={14} />
          {t('session.exit')}
        </DsButton>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {sessionStreak >= STREAK_BADGE_THRESHOLD ? (
            <span key={sessionStreak} className="wb-fc-chip wb-fc-chip--streak" title={t('review.streakTitle')}>
              <Lightning size={11} weight="fill" aria-hidden="true" />
              {t('review.streak', { count: sessionStreak })}
            </span>
          ) : null}
          {learningWaitMs != null ? (
            <span
              className="wb-fc-chip wb-fc-chip--learn"
              title={t('review.learningStepHint', { time: formatDuration(learningWaitMs) })}
            >
              <Hourglass size={11} aria-hidden="true" />
              {t('review.learningStep')}
            </span>
          ) : null}
          {newCount > 0 ? (
            <span className="wb-fc-chip wb-fc-chip--new">{t('review.newCount', { count: newCount })}</span>
          ) : null}
          {learnCount > 0 ? (
            <span className="wb-fc-chip wb-fc-chip--learn">{t('review.learnCount', { count: learnCount })}</span>
          ) : null}
          <span className="wb-fc-chip wb-fc-chip--due" title={t('review.remainingTitle', { count: remainingCount })}>
            {t('session.progress', { current: progress, total: queue.length })}
          </span>
          <span
            className="wb-fc-chip wb-fc-chip--timer"
            title={cardTimerCapped
              ? t('review.cardTimeCappedTitle', {
                  defaultValue: 'Over 1 minute on this card (display capped; stats unaffected)',
                })
              : sessionElapsedMs != null
                ? t('review.sessionTimeTitle', { time: formatDuration(sessionElapsedMs) })
                : t('review.cardTimeTitle')}
          >
            <Timer size={11} aria-hidden="true" />
            {cardTimerText}
          </span>
        </div>
      </div>

      {/* DsButton 在 lg 断点后压缩到 30px，宽屏触屏平板会跌破触控基线，coarse 兜底 ≥44px（与 library.css .fc-lib-row-actions 同基线） */}
      <div className="flex items-center justify-end gap-1">
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          disabled={!lastReview || ratingBusy}
          onClick={() => void undoLastReview()}
          aria-label={t('session.undo')}
          aria-keyshortcuts="Z Control+Z Meta+Z"
          title={`${t('session.undo')} · Z`}
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
        >
          <ArrowCounterClockwise size={16} />
        </DsButton>
        {lastSuspended ? (
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            disabled={ratingBusy}
            onClick={() => void resumeLastSuspended()}
            aria-label={t('session.resume')}
            title={t('session.resume')}
            className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          >
            <Play size={16} />
          </DsButton>
        ) : null}
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          disabled={ratingBusy || templateLoading || !current.ankiCardId}
          onClick={beginEdit}
          aria-label={t('session.edit')}
          aria-keyshortcuts="E"
          title={`${t('session.edit')} · E`}
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
        >
          <PencilSimple size={16} />
        </DsButton>
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          disabled={ratingBusy || editing}
          onClick={skipCurrent}
          aria-label={t('review.skip')}
          aria-keyshortcuts="S"
          title={`${t('review.skip')} · S`}
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
        >
          <SkipForward size={16} />
        </DsButton>
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          disabled={ratingBusy}
          onClick={() => void suspendCurrent()}
          aria-label={t('session.suspend')}
          title={t('session.suspend')}
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
        >
          <Pause size={16} />
        </DsButton>
      </div>

      {editing ? (
        <CustomScrollArea
          className="wb-fc-edit-panel min-h-0 flex-1"
          onKeyDown={onEditKeyDown}
        >
          <div className="flex min-h-full flex-col gap-3 p-4">
          <label className="flex min-h-0 flex-1 flex-col gap-1.5 text-left text-xs font-medium text-muted-foreground">
            {t('session.front')}
            <textarea
              value={draftFront}
              onChange={(event) => setDraftFront(event.target.value)}
              autoFocus
              className="min-h-28 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm font-normal text-foreground outline-none focus:border-ring [@media(pointer:coarse)]:text-[16px]"
            />
          </label>
          {draftClozeInvalid ? (
            <p className="wb-fc-edit-hint" role="status">
              <Warning size={12} aria-hidden="true" />
              {t('session.invalidClozeEdit')}
            </p>
          ) : null}
          <label className="flex min-h-0 flex-1 flex-col gap-1.5 text-left text-xs font-medium text-muted-foreground">
            {t('session.back')}
            <textarea
              value={draftBack}
              onChange={(event) => setDraftBack(event.target.value)}
              className="min-h-28 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-sm font-normal text-foreground outline-none focus:border-ring [@media(pointer:coarse)]:text-[16px]"
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <span className="wb-fc-shortcut-hint" aria-hidden="true">
              <kbd className="wb-fc-keycap">Esc</kbd> {t('session.cancelEdit')}
              <span className="wb-fc-shortcut-sep">·</span>
              <kbd className="wb-fc-keycap">⌘/Ctrl+Enter</kbd> {t('session.saveEdit')}
            </span>
            <div className="flex gap-2">
              <DsButton
                type="button"
                variant="ghost"
                disabled={ratingBusy}
                onClick={() => setEditing(false)}
                className="[@media(pointer:coarse)]:!min-h-11"
              >
                <X size={16} />
                {t('session.cancelEdit')}
              </DsButton>
              <DsButton
                type="button"
                variant="primary"
                disabled={ratingBusy || !draftIsValid}
                onClick={() => void saveEdit()}
                className="[@media(pointer:coarse)]:!min-h-11"
              >
                <FloppyDisk size={16} />
                {t('session.saveEdit')}
              </DsButton>
            </div>
          </div>
          </div>
        </CustomScrollArea>
      ) : (
        <ReviewCardSurface
          card={current}
          template={template}
          agentEntityId={`flashcards:${current.ankiCardId ?? current.id}`}
          templateLoading={templateLoading}
          flipped={flipped}
          disabled={ratingBusy}
          onFlip={handleFlip}
          frontLabel={t('session.front')}
          backLabel={t('session.back')}
          flipAriaLabel={flipAriaLabel}
          flipHint={t('session.tapToFlip')}
          noFrontText={t('card.untitled')}
          noBackText={t('card.noBack')}
          swipe={swipe}
          swipeEnabled={swipeEnabled}
          ratingLabel={(key) => t(key)}
        />
      )}

      {!editing ? (
        <>
          <UndoNudge
            receiptId={lastReview?.logId ?? null}
            rating={lastReview?.rating ?? null}
            busy={ratingBusy}
            onUndo={() => void undoLastReview()}
          />
          <RatingBar
            flipped={flipped}
            disabled={ratingBusy}
            previews={ratingPreviews}
            pressedRating={pressedRating}
            onShowAnswer={handleFlip}
            onRate={handleRateClick}
          />
          <div className="wb-fc-shortcut-hint justify-center" aria-hidden="true">
            <span><kbd className="wb-fc-keycap">Space</kbd> {t('review.shortcutFlip')}</span>
            <span className="wb-fc-shortcut-sep">·</span>
            <span><kbd className="wb-fc-keycap">1–4</kbd> {t('review.shortcutRate')}</span>
            <span className="wb-fc-shortcut-sep">·</span>
            <span><kbd className="wb-fc-keycap">Z</kbd> {t('review.shortcutUndo')}</span>
          </div>
        </>
      ) : null}
      {errorBanner}
    </div>
  );
};
