/**
 * 复习会话：模板卡面、Cloze、评分、撤销、编辑、暂停/跳过。
 *
 * 键盘流：Space/Enter 翻面（已翻面时评 Good）、1–4 评分、
 * Z 或 Ctrl/Cmd+Z 撤销、E 编辑、S 跳过、- 埋藏到明天、R 重播音频、? 快捷键说明；
 * 编辑中 Esc 取消、Ctrl/Cmd+Enter 保存。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  ArrowLeft,
  ArrowClockwise,
  ArrowSquareOut,
  BracketsCurly,
  ChatCircleText,
  DotsThree,
  FloppyDisk,
  Hourglass,
  Info,
  Lightning,
  Moon,
  Pause,
  PencilSimple,
  Play,
  SkipForward,
  SpeakerHigh,
  Stop,
  Timer,
  Warning,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { AppMenu, AppMenuTrigger, AppMenuContent, AppMenuItem } from '@/components/ui/app-menu/AppMenu';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useAnkiTemplateLoader } from '@/hooks/useAnkiTemplateLoader';
import { replayCardAudio } from '@/components/anki/utils/cardMedia';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { dispatchOpenMediaRef } from '@/features/learning-hub/apps/views/media/mediaRefEvents';
import { cn } from '@/utils/cn';
import { speak as speakTts, stop as stopTts } from '@/utils/tts';
import { hasValidCloze, insertClozeDeletion, nextClozeIndex } from '../cloze';
import { findReviewCardMediaSource, type CardMediaSource } from '../library/cardMediaSource';
import { parseTagsInput } from '../library/libraryView';
import { consumeLibraryReturnOrigin } from '../library/libraryViewState';
import { useSwipeRating } from '../hooks/useSwipeRating';
import { isEditableTarget } from '../isEditableTarget';
import { isKeyEventFromOtherModal } from '@/utils/modalKeyGuard';
import {
  getReviewCardEditValues,
  isClozeReviewCard,
} from '../reviewCardEditFields';
import {
  isReviewSessionDone,
  isReviewSessionEmpty,
  useFsrsReviewStore,
  type FsrsRating,
  type ReviewCard,
  type ReviewSessionErrorKind,
} from '../store/fsrsReviewStore';
import { RatingBar } from '../review/RatingBar';
import { ReviewCardSurface } from '../review/ReviewCardSurface';
import { SessionSummary } from '../review/SessionSummary';
import { UndoNudge } from '../review/UndoNudge';
import { formatDuration, useCardAnswerClock, useNow } from '../review/useSessionClock';
import { openReviewCardSource } from '../review/openReviewCardSource';
import { askAiAboutCard, askAiAboutCards } from '../review/askAiAboutCard';
import { getReviewCardSpeechText, hasReviewCardAudio } from '../review/cardSpeechText';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useFlashcardsMobileChrome } from '../useFlashcardsMobileChrome';
import { useOptionalSlot, useOptionalUiKernel } from '@/ui-kernel/react';
import { SlotEntryScope, runSlotCallback } from '@/ui-kernel/outlet';
import type { ReviewCardActionContribution } from '@/ui-kernel/contracts/surfaces';
import type { SlotEntry } from '@/ui-kernel/slots';

const EMPTY_REVIEW_CARD_ACTIONS: readonly SlotEntry<ReviewCardActionContribution>[] = [];

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
  onExit?: () => void;
}

export const ReviewSessionScreen: React.FC<ReviewSessionScreenProps> = ({
  isActive = true,
  onExit,
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
  const resumeLabel = lastSuspended?.reason === 'bury' ? t('session.unbury') : t('session.resume');
  const retryBatchRequest = useFsrsReviewStore((state) => state.retryBatchRequest);
  const sessionRatedCount = useFsrsReviewStore((state) => state.sessionRatedCount);
  const sessionAgainCardIds = useFsrsReviewStore((state) => state.sessionAgainCardIds);
  const sessionRatingCounts = useFsrsReviewStore((state) => state.sessionRatingCounts);
  const sessionStreak = useFsrsReviewStore((state) => state.sessionStreak);
  const sessionBestStreak = useFsrsReviewStore((state) => state.sessionBestStreak);
  const sessionStartedAtMs = useFsrsReviewStore((state) => state.sessionStartedAtMs);
  const remainingDueAfterSession = useFsrsReviewStore((state) => state.remainingDueAfterSession);
  const ratingPreviews = useFsrsReviewStore((state) => state.ratingPreviews);
  const current = queue[queueIndex];

  const [editing, setEditing] = React.useState(false);
  const [editingCardId, setEditingCardId] = React.useState<string | null>(null);
  const [draftFront, setDraftFront] = React.useState('');
  const [draftBack, setDraftBack] = React.useState('');
  const [draftTags, setDraftTags] = React.useState('');
  const [draftClozeMode, setDraftClozeMode] = React.useState(false);
  const editFrontRef = React.useRef<HTMLTextAreaElement | null>(null);
  const editedCardIdentityRef = React.useRef<string | null>(null);

  const editingCard = React.useMemo<ReviewCard | undefined>(() => {
    if (editing && editingCardId) {
      return queue.find((card) => card.id === editingCardId)
        ?? lastReview?.queueSnapshot?.find((card) => card.id === editingCardId)
        ?? current;
    }
    return current;
  }, [editing, editingCardId, queue, lastReview, current]);

  const openSource = React.useCallback(() => {
    if (!current) return;
    void openReviewCardSource(current).then((opened) => {
      if (!opened) showGlobalNotification('info', t('session.noSource'));
    });
  }, [current, t]);
  const askAi = React.useCallback(() => {
    if (current) askAiAboutCard(current, t);
  }, [current, t]);
  const uiKernel = useOptionalUiKernel();
  const cardActionEntries = useOptionalSlot('review.cardActions') ?? EMPTY_REVIEW_CARD_ACTIONS;
  const runContributedCardAction = React.useCallback((entry: SlotEntry<ReviewCardActionContribution>) => {
    if (!current) return;
    runSlotCallback(uiKernel, 'review.cardActions', entry, () =>
      entry.value.run({
        cardId: current.id,
        ...(current.ankiCardId ? { noteCardId: current.ankiCardId } : {}),
        front: isClozeReviewCard(current) && current.text ? current.text : current.front,
        back: current.back,
        tags: current.tags ?? [],
        flipped,
      })
    );
  }, [current, flipped, uiKernel]);
  const { template, loading: templateLoading } = useAnkiTemplateLoader(
    editing ? editingCard?.templateId : current?.templateId,
  );
  const flip = useFsrsReviewStore((state) => state.flip);
  const rate = useFsrsReviewStore((state) => state.rate);
  const undoLastReview = useFsrsReviewStore((state) => state.undoLastReview);
  const updateCurrentCard = useFsrsReviewStore((state) => state.updateCurrentCard);
  const suspendCurrent = useFsrsReviewStore((state) => state.suspendCurrent);
  const buryCurrent = useFsrsReviewStore((state) => state.buryCurrent);
  const resumeLastSuspended = useFsrsReviewStore((state) => state.resumeLastSuspended);
  const skipCurrent = useFsrsReviewStore((state) => state.skipCurrent);
  const retryBatchSession = useFsrsReviewStore((state) => state.retryBatchSession);
  const endSession = useFsrsReviewStore((state) => state.endSession);
  const setScreen = useFsrsReviewStore((state) => state.setScreen);
  const loadDue = useFsrsReviewStore((state) => state.loadDue);
  const startDueSession = useFsrsReviewStore((state) => state.startDueSession);
  const startAgainCardsSession = useFsrsReviewStore((state) => state.startAgainCardsSession);
  const defaultExitSession = React.useCallback(() => {
    const returnTo = consumeLibraryReturnOrigin();
    endSession();
    if (returnTo === 'library') {
      setScreen?.('library');
    }
  }, [endSession, setScreen]);
  const exitSession = onExit ?? defaultExitSession;
  const handleUndoWithFeedback = React.useCallback(() => {
    void undoLastReview().then((undone) => {
      if (undone !== false) {
        showGlobalNotification(
          'info',
          t('session.undone', { defaultValue: 'Undid last rating' }),
        );
      } else {
        const live = useFsrsReviewStore.getState();
        if (live.errorKind === 'undo' && live.error) {
          showGlobalNotification('error', live.error);
        }
      }
    });
  }, [undoLastReview, t]);
  const openLibraryFromSummary = React.useCallback(() => {
    consumeLibraryReturnOrigin();
    endSession();
    setScreen?.('library');
  }, [endSession, setScreen]);

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

  const sessionDone = isReviewSessionDone({ queue, queueIndex, loading });
  const sessionEmpty = isReviewSessionEmpty({ queue, loading });
  const isSessionEnded = sessionEmpty || !current || sessionDone;
  const canUndoInSession = Boolean(lastReview) && !isSessionEnded;

  // `?` 键盘快捷键速查弹层
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const shortcutsPopoverId = React.useId();
  const shortcutsContainerRef = React.useRef<HTMLDivElement | null>(null);
  const shortcutsTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => {
    if (!isActive || editing || isSessionEnded || loading) {
      setShortcutsOpen(false);
    }
  }, [isActive, editing, isSessionEnded, loading]);
  const handleShortcutsOutsidePointerDown = React.useCallback((rawEvent: Event) => {
    const root = shortcutsContainerRef.current;
    if (!root) return;
    if (rawEvent.target instanceof Node && root.contains(rawEvent.target)) return;
    setShortcutsOpen(false);
  }, []);
  const shortcutCheatSheetItems = React.useMemo(() => [
    { keys: 'Space', label: t('review.shortcuts.flipOrGood', { defaultValue: 'Flip card / Rate Good' }) },
    { keys: '1–4', label: t('review.shortcuts.rate', { defaultValue: 'Rate: Again / Hard / Good / Easy' }) },
    { keys: 'Z', label: t('review.shortcuts.undo', { defaultValue: 'Undo last rating' }) },
    { keys: 'R', label: t('review.shortcuts.replayAudio', { defaultValue: 'Replay card audio' }) },
    { keys: 'E', label: t('review.shortcuts.edit', { defaultValue: 'Edit current card' }) },
    { keys: 'S', label: t('review.shortcuts.skip', { defaultValue: 'Skip card for now' }) },
    { keys: '-', label: t('review.shortcuts.bury', { defaultValue: 'Bury until tomorrow' }) },
    { keys: '?', label: t('review.shortcuts.help', { defaultValue: 'Toggle this shortcut sheet' }) },
  ], [t]);

  const draftTargetCard = editing ? editingCard : current;
  const draftIsCloze = editing
    ? draftClozeMode
    : Boolean(current && isClozeReviewCard(current, template));
  const draftClozeInvalid = draftIsCloze && Boolean(draftFront.trim()) && !hasValidCloze(draftFront);
  const draftIsValid = Boolean(
    draftTargetCard
    && draftFront.trim()
    && (draftIsCloze ? hasValidCloze(draftFront) : draftBack.trim()),
  );
  const flipAriaLabel = flipped
    ? t('session.showFront')
    : t('session.showBack');

  // ---- TTS 朗读 & APKG 音频重播 ----
  const [speaking, setSpeaking] = React.useState(false);
  const speakSeqRef = React.useRef(0);
  const speechText = React.useMemo(
    () => getReviewCardSpeechText(current, flipped),
    [current, flipped],
  );
  const hasCardAudio = React.useMemo(() => hasReviewCardAudio(current), [current]);
  const stopSpeaking = React.useCallback(() => {
    speakSeqRef.current += 1;
    setSpeaking(false);
    void stopTts();
  }, []);
  const handleToggleSpeak = React.useCallback(() => {
    if (speaking) {
      stopSpeaking();
      return;
    }
    if (!speechText) {
      showGlobalNotification('info', t('session.ttsEmpty', { defaultValue: 'No readable text on this card face' }));
      return;
    }
    const seq = ++speakSeqRef.current;
    setSpeaking(true);
    void speakTts(speechText)
      .catch((err) => {
        if (speakSeqRef.current !== seq) return;
        const message = err instanceof Error && err.message
          ? err.message
          : t('session.ttsFailed', { defaultValue: 'Text-to-speech is unavailable' });
        showGlobalNotification('warning', message);
      })
      .finally(() => {
        if (speakSeqRef.current === seq) setSpeaking(false);
      });
  }, [speaking, speechText, stopSpeaking, t]);
  const handleReplayAudio = React.useCallback(() => {
    replayCardAudio(document.querySelector('.wb-fc-card-stage') ?? document);
  }, []);

  // 本轮遗忘卡（Again）集合与最近 Again/leech 卡片（难卡救援闭环）
  const sessionAgainCards = React.useMemo(() => {
    if (sessionAgainCardIds.length === 0) return [];
    const byId = new Map(queue.map((card) => [card.id, card] as const));
    return sessionAgainCardIds
      .map((id) => byId.get(id))
      .filter((card): card is ReviewCard => Boolean(card));
  }, [queue, sessionAgainCardIds]);
  const reviewableAgainCount = React.useMemo(
    () => sessionAgainCards.filter((card) => card.suspended !== true && card.buried !== true).length,
    [sessionAgainCards],
  );
  const lastAgainCard = React.useMemo(() => {
    if (!lastReview || lastReview.rating !== 1) return null;
    return queue.find((card) => card.id === lastReview.cardStateId)
      ?? lastReview.queueSnapshot?.find((card) => card.id === lastReview.cardStateId)
      ?? null;
  }, [lastReview, queue]);
  const leechCard = React.useMemo(() => {
    if (lastSuspended?.reason !== 'leech') return null;
    return queue.find((card) => card.id === lastSuspended.cardStateId) ?? null;
  }, [lastSuspended, queue]);

  // 音视频转写制成的卡：翻面后可回看讲到该知识点的片段；评「重来」后提示条里也给回看入口
  const currentMediaSource = React.useMemo(() => findReviewCardMediaSource(current), [current]);
  const lastReviewMediaSource = React.useMemo(() => {
    if (!lastReview || lastReview.rating !== 1) return null;
    return findReviewCardMediaSource(lastReview.queueSnapshot?.find((card) => card.id === lastReview.cardStateId));
  }, [lastReview]);
  const renderMediaChip = (source: CardMediaSource) => (
    <DsButton
      type="button"
      variant="ghost"
      size="sm"
      className="wb-fc-media-chip max-w-full gap-1 rounded-full text-xs"
      aria-label={t('review.rewatchSourceTitle', { time: source.label })}
      title={t('review.rewatchSourceTitle', { time: source.label })}
      // 窗口级快捷键会把 Space/Enter 当翻面/评分，聚焦本按钮时让给按钮本身
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
      onClick={() => dispatchOpenMediaRef(source.resourceId, source.seconds)}
    >
      <Play size={11} weight="fill" aria-hidden="true" />
      <span className="truncate">{t('review.rewatchSource', { time: source.label })}</span>
    </DsButton>
  );

  // ---- 前端计时（本卡用时 + 本轮用时） ----
  const cardKey = current ? `${current.id}:${current.ankiCardId ?? ''}` : null;
  React.useEffect(() => {
    speakSeqRef.current += 1;
    setSpeaking(false);
    void stopTts();
  }, [cardKey, flipped, editing, sessionDone]);
  React.useEffect(() => () => {
    speakSeqRef.current += 1;
    void stopTts();
  }, []);
  const clockEnabled = isActive && !loading && !templateLoading && Boolean(current) && !sessionDone && !editing && !ratingBusy;
  const now = useNow(clockEnabled);
  const getAnswerDuration = useCardAnswerClock(
    cardKey ? `${cardKey}:${sessionStartedAtMs}:${sessionRatedCount}` : null,
    clockEnabled,
  );
  const [doneAt, setDoneAt] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (sessionDone) {
      setDoneAt((prev) => prev ?? Date.now());
    } else {
      setDoneAt(null);
    }
  }, [sessionDone]);
  const cardElapsedMs = getAnswerDuration();
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
    if (cardChanged) {
      setEditing(false);
      setEditingCardId(null);
    }
    if (!cardChanged && editing) return;
    if (!current) {
      setDraftFront('');
      setDraftBack('');
      setDraftTags('');
      setDraftClozeMode(false);
      return;
    }
    const values = getReviewCardEditValues(current, template);
    setDraftFront(values.front);
    setDraftBack(values.back);
    setDraftTags((current.tags ?? []).join(', '));
    setDraftClozeMode(isClozeReviewCard(current, template));
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
    void rate(rating, getAnswerDuration());
  }, [flashRating, flipped, rate, ratingBusy, getAnswerDuration]);

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
  // F07：只有一张学习卡时，评分后回插的是同一张卡，cardKey 不变 → flyout 飞出
  // 状态不会复位，下一次展示可能不可见。叠加 sessionRatedCount 作为「本轮作答」
  // 身份，使每次评分/撤销都触发一次复位。
  const swipeResetKey = current
    ? `${current.id}:${current.ankiCardId ?? ''}:${sessionRatedCount}`
    : null;
  const swipe = useSwipeRating({
    enabled: swipeEnabled,
    resetKey: swipeResetKey,
    onRate: handleRate,
  });
  // 评分失败（错误条出现）时把已飞出的卡片拉回原位，避免卡面空悬
  const swipeReset = swipe.reset;
  React.useEffect(() => {
    if (error && errorKind === 'rate') swipeReset();
  }, [error, errorKind, swipeReset]);

  const beginEditForCard = React.useCallback((targetCard: ReviewCard | null | undefined) => {
    const live = useFsrsReviewStore.getState();
    if (!targetCard || live.ratingBusy || !targetCard.ankiCardId) return;
    const targetTemplate = targetCard.id === current?.id ? template : null;
    if (targetCard.id === current?.id && templateLoading) return;
    const values = getReviewCardEditValues(targetCard, targetTemplate);
    setEditingCardId(targetCard.id);
    setDraftFront(values.front);
    setDraftBack(values.back);
    setDraftTags((targetCard.tags ?? []).join(', '));
    setDraftClozeMode(isClozeReviewCard(targetCard, targetTemplate));
    setEditing(true);
  }, [current?.id, template, templateLoading]);

  const beginEdit = React.useCallback(() => {
    const live = useFsrsReviewStore.getState();
    beginEditForCard(live.queue[live.queueIndex]);
  }, [beginEditForCard]);

  const cancelEdit = React.useCallback(() => {
    setEditing(false);
    setEditingCardId(null);
  }, []);

  const handleInsertEditCloze = React.useCallback(() => {
    const textarea = editFrontRef.current;
    const { nextValue, nextSelectionStart, nextSelectionEnd } = insertClozeDeletion(
      draftFront,
      textarea?.selectionStart,
      textarea?.selectionEnd,
      t('library.create.clozePlaceholder', { defaultValue: 'Cloze text' }),
    );
    setDraftClozeMode(true);
    setDraftFront(nextValue);
    requestAnimationFrame(() => {
      const el = editFrontRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(nextSelectionStart, nextSelectionEnd);
    });
  }, [draftFront, t]);

  const saveEdit = React.useCallback(async () => {
    const target = editingCard;
    if (!target) return;
    const saved = await updateCurrentCard(draftFront, draftBack, template, {
      cardStateId: target.id,
      tags: parseTagsInput(draftTags),
      forceCloze: draftClozeMode,
    });
    if (saved) {
      setEditing(false);
      setEditingCardId(null);
    }
  }, [draftBack, draftClozeMode, draftFront, draftTags, editingCard, template, updateCurrentCard]);

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
    // 盖在闪卡上的模态层（如跨题目集错题复习）里的空格 / 数字键归模态层，背后不翻面不评分
    if (isKeyEventFromOtherModal(event)) return;
    if (ratingBusy || editing) return;

    if (shortcutsOpen && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setShortcutsOpen(false);
      shortcutsTriggerRef.current?.focus();
      return;
    }

    const isQuestionKey = (event.key === '?' || (event.code === 'Slash' && event.shiftKey))
      && !event.ctrlKey
      && !event.metaKey
      && !event.altKey;
    if (isQuestionKey && !loading && !isSessionEnded) {
      event.preventDefault();
      setShortcutsOpen((open) => !open);
      return;
    }

    if (shortcutsOpen) return;

    // 撤销：Z 与 Ctrl/Cmd+Z 仅在复习会话进行中生效（Session Complete 完成态禁用）
    const isUndoKey = event.key.toLowerCase() === 'z' || event.code === 'KeyZ';
    if (isUndoKey && !event.altKey && !event.shiftKey) {
      if (canUndoInSession) {
        event.preventDefault();
        handleUndoWithFeedback();
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
    if (event.key.toLowerCase() === 'r' || event.code === 'KeyR') {
      event.preventDefault();
      handleReplayAudio();
      return;
    }
    if (event.key === '-' || event.code === 'Minus' || event.code === 'NumpadSubtract') {
      event.preventDefault();
      void buryCurrent();
      return;
    }
    if (event.key.toLowerCase() === 's' || event.code === 'KeyS') {
      event.preventDefault();
      skipCurrent();
    }
  }, [
    beginEdit,
    buryCurrent,
    canUndoInSession,
    current,
    editing,
    flipped,
    handleFlip,
    handleRate,
    handleReplayAudio,
    handleUndoWithFeedback,
    isSessionEnded,
    loading,
    ratingBusy,
    sessionDone,
    shortcutsOpen,
    skipCurrent,
  ]);
  useEventRegistry(
    isActive
      ? [
          { target: 'window', type: 'keydown', listener: onKeyDown },
          ...(shortcutsOpen
            ? [{ target: 'window' as const, type: 'pointerdown', listener: handleShortcutsOutsidePointerDown }]
            : []),
        ]
      : [],
    [isActive, onKeyDown, shortcutsOpen, handleShortcutsOutsidePointerDown],
  );

  const onEditKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (draftIsValid && !ratingBusy) void saveEdit();
    }
  }, [cancelEdit, draftIsValid, ratingBusy, saveEdit]);

  const handleMobileBack = React.useCallback(() => {
    if (ratingBusy) return;
    if (editing) cancelEdit();
    else exitSession();
  }, [cancelEdit, editing, ratingBusy, exitSession]);
  const ttsLabel = speaking
    ? t('session.stopSpeak', { defaultValue: 'Stop reading' })
    : t('session.speakCard', { defaultValue: 'Read card aloud' });
  const replayAudioLabel = t('session.replayAudio', { defaultValue: 'Replay audio' });
  const mobileChrome = useFlashcardsMobileChrome({
    title: t(editing ? 'session.edit' : 'session.title'),
    subtitle: !editing && current && !sessionDone ? t('review.ratedRemaining', { rated: sessionRatedCount, left: remainingCount, defaultValue: '{{rated}} rated · {{left}} left' }) : undefined,
    onBack: handleMobileBack,
    rightActions: editing ? (
      <DsButton variant="ghost" size="icon" className="!min-h-11 !min-w-11" aria-label={t('session.saveEdit')} disabled={ratingBusy || !draftIsValid} onClick={() => void saveEdit()}>
        <FloppyDisk size={20} />
      </DsButton>
    ) : <>
      {current && !sessionDone && (
        <DsButton
          variant="ghost"
          size="icon"
          className="!min-h-11 !min-w-11"
          aria-label={ttsLabel}
          aria-pressed={speaking}
          disabled={!speechText}
          onClick={handleToggleSpeak}
        >
          {speaking ? <Stop size={20} /> : <SpeakerHigh size={20} />}
        </DsButton>
      )}
      <DsButton variant="ghost" size="icon" className="!min-h-11 !min-w-11" aria-label={t('session.undo')} disabled={!canUndoInSession || ratingBusy} onClick={handleUndoWithFeedback}>
        <ArrowCounterClockwise size={20} />
      </DsButton>
      {(current || lastSuspended) && <AppMenu>
        <AppMenuTrigger asChild>
          <DsButton variant="ghost" size="icon" className="!min-h-11 !min-w-11" aria-label={t('common:more')}><DotsThree size={22} /></DsButton>
        </AppMenuTrigger>
        <AppMenuContent align="end" width={200}>
          {current && <>
            {hasCardAudio && <AppMenuItem icon={<ArrowClockwise size={18} />} onClick={handleReplayAudio}>{replayAudioLabel}</AppMenuItem>}
            <AppMenuItem icon={<ArrowSquareOut size={18} />} onClick={openSource}>{t('session.viewSource')}</AppMenuItem>
            <AppMenuItem icon={<ChatCircleText size={18} />} onClick={askAi}>{t('session.askAi')}</AppMenuItem>
            {cardActionEntries.map((entry) => {
              const Icon = entry.value.icon;
              return (
                <AppMenuItem
                  key={`${entry.owner}\u0000${entry.id}`}
                  icon={Icon ? (
                    <SlotEntryScope slot="review.cardActions" entry={entry} fallback={<Lightning size={18} />}>
                      <Icon size={18} />
                    </SlotEntryScope>
                  ) : (
                    <Lightning size={18} />
                  )}
                  onClick={() => runContributedCardAction(entry)}
                >
                  {entry.value.label}
                </AppMenuItem>
              );
            })}
            <AppMenuItem icon={<PencilSimple size={18} />} disabled={ratingBusy || templateLoading || !current.ankiCardId} onClick={beginEdit}>{t('session.edit')}</AppMenuItem>
            <AppMenuItem icon={<SkipForward size={18} />} disabled={ratingBusy} onClick={skipCurrent}>{t('review.skip')}</AppMenuItem>
            <AppMenuItem icon={<Moon size={18} />} disabled={ratingBusy} onClick={() => void buryCurrent()}>{t('session.bury')}</AppMenuItem>
            <AppMenuItem icon={<Pause size={18} />} disabled={ratingBusy} onClick={() => void suspendCurrent()}>{t('session.suspend')}</AppMenuItem>
          </>}
          {lastSuspended && <AppMenuItem icon={<Play size={18} />} disabled={ratingBusy} onClick={() => void resumeLastSuspended()}>{resumeLabel}</AppMenuItem>}
        </AppMenuContent>
      </AppMenu>}
    </>,
  }, [t, editing, current, sessionDone, sessionRatedCount, remainingCount, handleMobileBack, ratingBusy, draftIsValid, saveEdit, ttsLabel, speaking, speechText, handleToggleSpeak, hasCardAudio, handleReplayAudio, replayAudioLabel, canUndoInSession, handleUndoWithFeedback, lastSuspended, resumeLabel, templateLoading, beginEdit, skipCurrent, suspendCurrent, buryCurrent, resumeLastSuspended, openSource, askAi, cardActionEntries, runContributedCardAction]);

  const errorBanner = error ? (
    <div role="alert" className="wb-fc-session-error flex items-start justify-between gap-3">
      <div className="min-w-0 flex items-start gap-2">
        <Warning size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-0.5 text-left">
          <p className="text-xs font-medium text-destructive">{errorTitle(t, errorKind)}</p>
          <p className="break-words text-2xs text-destructive/90">{error}</p>
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
          {!mobileChrome && <DsButton
            type="button"
            variant="default"
            onClick={exitSession}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {t('session.backToday')}
          </DsButton>}
        </div>
      </div>
    );
  }

  if (sessionEmpty || !current || sessionDone) {
    const stillDue = (remainingDueAfterSession ?? 0) > 0;
    // If we rated cards this session then the queue was reconciled empty,
    // still show the completion summary (not the virgin "empty queue" empty-state).
    const finishedWithRatings = sessionRatedCount > 0;
    const showAsEmpty = sessionEmpty && !finishedWithRatings;
    const headline = showAsEmpty
      ? t('session.emptyQueue')
      : stillDue
        ? t('session.batchDoneRemaining', { count: remainingDueAfterSession })
        : t('session.done');

    return (
      <SessionSummary
        empty={showAsEmpty}
        headline={headline}
        ratedCount={sessionRatedCount}
        ratingCounts={sessionRatingCounts}
        bestStreak={sessionBestStreak}
        elapsedMs={showAsEmpty ? null : sessionElapsedMs}
        remainingDue={remainingDueAfterSession}
        busy={ratingBusy}
        canUndo={false}
        canResume={Boolean(lastSuspended)}
        onUndo={handleUndoWithFeedback}
        onResume={() => void resumeLastSuspended()}
        onBack={exitSession}
        hideChromeActions={mobileChrome}
        onContinue={continueWithDue}
        onOpenLibrary={openLibraryFromSummary}
        againCount={sessionAgainCards.length}
        canRetryAgain={reviewableAgainCount > 0}
        onRetryAgain={reviewableAgainCount > 0 ? () => void startAgainCardsSession() : undefined}
        onAskAiAgain={sessionAgainCards.length > 0 ? () => askAiAboutCards(sessionAgainCards, t) : undefined}
        errorBanner={errorBanner}
      />
    );
  }

  // 进度按「本轮已评 / (已评 + 剩余)」：学习步骤中的卡会回到队尾，queueIndex 常停在 0，
  // 按下标算进度条永远不动、计数一直是「1 / N」
  const sessionTotal = sessionRatedCount + remainingCount;
  const progressPct = sessionTotal > 0
    ? Math.round((sessionRatedCount / sessionTotal) * 100)
    : 0;

  // 底部留出移动端手势导航安全区（评分栏贴屏幕底部，避免与 Home indicator 冲突）
  return (
    <div className="wb-fc-session flex h-full min-h-0 flex-col gap-3 px-4 pt-4 pb-[calc(1rem+var(--mobile-safe-area-bottom,0px))] sm:px-5 sm:pt-5 sm:pb-[calc(1.25rem+var(--mobile-safe-area-bottom,0px))]">
      <div
        className="wb-fc-session-progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={sessionTotal}
        aria-valuenow={sessionRatedCount}
        aria-label={t('review.progressLabel')}
      >
        <div className="wb-fc-session-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>

      {sessionMode === 'batch' && !batchNoticeDismissed ? (
        <div
          role="status"
          className="wb-fc-session-notice flex items-start justify-between gap-2 rounded-md border border-info/40 bg-info/10 px-3 py-2 text-xs text-foreground"
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

      {lastSuspended?.reason === 'leech' ? (
        <div
          role="status"
          data-testid="fc-leech-banner"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
        >
          <span className="flex min-w-0 items-start gap-1.5">
            <Warning size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
            {t('session.leechSuspended')}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {leechCard ? (
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                data-testid="fc-leech-ask-ai"
                onClick={() => askAiAboutCard(leechCard, t)}
                className="shrink-0 gap-1 text-xs"
              >
                <ChatCircleText size={14} aria-hidden="true" />
                {t('session.askAiDeep', { defaultValue: 'Ask AI to explain' })}
              </DsButton>
            ) : null}
            {leechCard?.ankiCardId ? (
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                data-testid="fc-leech-edit-card"
                onClick={() => beginEditForCard(leechCard)}
                disabled={ratingBusy}
                className="shrink-0 gap-1 text-xs"
              >
                <PencilSimple size={14} aria-hidden="true" />
                {t('session.edit')}
              </DsButton>
            ) : null}
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void resumeLastSuspended()}
              disabled={ratingBusy}
              className="shrink-0"
            >
              {t('session.resume')}
            </DsButton>
          </div>
        </div>
      ) : null}

      {mobileChrome && learningWaitMs != null && !editing && (
        <p className="text-xs text-muted-foreground">{t('review.learningStepHint', { time: formatDuration(learningWaitMs) })}</p>
      )}
      {!mobileChrome && <div className="wb-fc-session-toolbar text-muted-foreground/75">
      <div className="wb-fc-session-overview flex items-center justify-between gap-2">
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          onClick={exitSession}
          aria-label={t('session.exit')}
          className="wb-fc-session-exit gap-1 border-transparent text-muted-foreground/75 hover:bg-foreground/[0.04] hover:text-foreground [@media(pointer:coarse)]:!min-h-11"
        >
          <ArrowLeft size={14} />
          <span>{t('session.exit')}</span>
        </DsButton>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 text-xs tabular-nums">
          {sessionStreak >= STREAK_BADGE_THRESHOLD ? (
            <span
              key={sessionStreak}
              className="wb-fc-chip wb-fc-chip--streak motion-reduce:animate-none"
              title={t('review.streakTitle')}
            >
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
            <span className="wb-fc-chip wb-fc-chip--new">
              {t('review.newCount', { count: newCount })}
            </span>
          ) : null}
          {learnCount > 0 ? (
            <span className="wb-fc-chip wb-fc-chip--learn">
              {t('review.learnCount', { count: learnCount })}
            </span>
          ) : null}
          <span className="wb-fc-chip wb-fc-chip--due" title={t('review.remainingTitle', { count: remainingCount })}>
            {t('review.ratedRemaining', {
              rated: sessionRatedCount,
              left: remainingCount,
            })}
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

      <div className="wb-fc-session-actions flex items-center justify-end gap-0.5 text-muted-foreground/65">
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          disabled={!canUndoInSession || ratingBusy}
          onClick={handleUndoWithFeedback}
          aria-label={t('session.undo')}
          aria-keyshortcuts="Z Control+Z Meta+Z"
          title={`${t('session.undo')} · Z`}
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
            aria-label={resumeLabel}
            title={resumeLabel}
          >
            <Play size={16} />
          </DsButton>
        ) : null}
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          disabled={!speechText}
          aria-pressed={speaking}
          onClick={handleToggleSpeak}
          aria-label={ttsLabel}
          title={ttsLabel}
          data-testid="fc-review-tts"
        >
          {speaking ? <Stop size={16} /> : <SpeakerHigh size={16} />}
        </DsButton>
        {hasCardAudio ? (
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            iconOnly
            onClick={handleReplayAudio}
            aria-label={replayAudioLabel}
            aria-keyshortcuts="R"
            title={`${replayAudioLabel} · R`}
            data-testid="fc-review-replay-audio-toolbar"
          >
            <ArrowClockwise size={16} />
          </DsButton>
        ) : null}
        <DsButton
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          onClick={askAi}
          aria-label={t('session.askAi')}
          title={t('session.askAi')}
          data-testid="fc-review-ask-ai"
        >
          <ChatCircleText size={16} />
        </DsButton>
        {cardActionEntries.map((entry) => {
          const Icon = entry.value.icon;
          return (
            <DsButton
              key={`${entry.owner}\u0000${entry.id}`}
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => runContributedCardAction(entry)}
              aria-label={entry.value.label}
              title={entry.value.label}
              data-testid={`fc-review-action-${entry.id}`}
            >
              {Icon ? (
                <SlotEntryScope slot="review.cardActions" entry={entry} fallback={<Lightning size={16} />}>
                  <Icon size={16} />
                </SlotEntryScope>
              ) : (
                <Lightning size={16} />
              )}
            </DsButton>
          );
        })}
        <AppMenu>
          <AppMenuTrigger asChild>
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t('common:more')}
              title={t('common:more')}
              data-testid="fc-review-more-actions"
            >
              <DotsThree size={18} />
            </DsButton>
          </AppMenuTrigger>
          <AppMenuContent align="end" width={200}>
            <AppMenuItem
              icon={<ArrowSquareOut size={16} />}
              onClick={openSource}
              data-testid="fc-review-view-source"
            >
              {t('session.viewSource')}
            </AppMenuItem>
            <AppMenuItem
              icon={<PencilSimple size={16} />}
              shortcut="E"
              disabled={ratingBusy || templateLoading || !current.ankiCardId}
              onClick={beginEdit}
              data-testid="fc-review-edit"
            >
              {t('session.edit')}
            </AppMenuItem>
            <AppMenuItem
              icon={<SkipForward size={16} />}
              shortcut="S"
              disabled={ratingBusy || editing}
              onClick={skipCurrent}
            >
              {t('review.skip')}
            </AppMenuItem>
            <AppMenuItem
              icon={<Moon size={16} />}
              shortcut="-"
              disabled={ratingBusy}
              onClick={() => void buryCurrent()}
            >
              {t('session.bury')}
            </AppMenuItem>
            <AppMenuItem
              icon={<Pause size={16} />}
              disabled={ratingBusy}
              onClick={() => void suspendCurrent()}
            >
              {t('session.suspend')}
            </AppMenuItem>
          </AppMenuContent>
        </AppMenu>
      </div>
      </div>}

      {editing ? (
        <CustomScrollArea
          className="wb-fc-edit-panel min-h-0 flex-1"
          onKeyDown={onEditKeyDown}
        >
          <div className="flex min-h-full flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              role="group"
              aria-label={t('library.create.typeLabel', { defaultValue: 'Card type' })}
              className="inline-flex items-center rounded-lg border border-border/50 bg-muted/40 p-0.5"
            >
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={!draftClozeMode}
                data-testid="fc-edit-mode-basic"
                onClick={() => setDraftClozeMode(false)}
                className={cn(
                  'min-h-[32px] rounded-md px-2.5 text-xs font-medium',
                  !draftClozeMode
                    ? 'bg-card text-foreground shadow-sm hover:bg-card'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('library.create.typeBasic', { defaultValue: 'Basic (Q&A)' })}
              </DsButton>
              <DsButton
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={draftClozeMode}
                data-testid="fc-edit-mode-cloze"
                onClick={() => setDraftClozeMode(true)}
                className={cn(
                  'min-h-[32px] rounded-md px-2.5 text-xs font-medium',
                  draftClozeMode
                    ? 'bg-card text-foreground shadow-sm hover:bg-card'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t('library.create.typeCloze', { defaultValue: 'Cloze deletion' })}
              </DsButton>
            </div>
            <DsButton
              type="button"
              variant="default"
              size="sm"
              data-testid="fc-edit-insert-cloze"
              onClick={handleInsertEditCloze}
              className="min-h-[36px] gap-1.5 text-xs"
            >
              <BracketsCurly size={14} aria-hidden="true" />
              <span>
                {t('library.create.insertCloze', { defaultValue: 'Insert cloze' })}
                {' '}
                <code className="font-mono">{`{{c${nextClozeIndex(draftFront)}::...}}`}</code>
              </span>
            </DsButton>
          </div>
          <label className="flex min-h-0 flex-1 flex-col gap-1.5 text-left text-xs font-medium text-muted-foreground">
            {t('session.front')}
            <textarea
              ref={editFrontRef}
              value={draftFront}
              onChange={(event) => setDraftFront(event.target.value)}
              autoFocus
              className="min-h-28 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-base font-normal text-foreground outline-none focus:border-ring sm:text-sm"
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
              className="min-h-28 flex-1 resize-y rounded-md border border-border bg-background px-3 py-2 text-base font-normal text-foreground outline-none focus:border-ring sm:text-sm"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-left text-xs font-medium text-muted-foreground">
            {t('library.editTags', { defaultValue: 'Tags (comma separated)' })}
            <Input
              value={draftTags}
              onChange={(event) => setDraftTags(event.target.value)}
              placeholder={t('library.create.tagsPlaceholder', { defaultValue: 'e.g. Calculus, Key concept' })}
              data-testid="fc-edit-tags"
              className="h-9 text-base font-normal sm:text-sm [@media(pointer:coarse)]:!h-11"
            />
          </label>
          {!mobileChrome && <div className="flex items-center justify-between gap-2">
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
                onClick={cancelEdit}
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
          </div>}
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
          audioAccessory={hasCardAudio ? (
            <DsButton
              type="button"
              variant="ghost"
              size="sm"
              data-testid="fc-review-replay-audio"
              aria-label={replayAudioLabel}
              aria-keyshortcuts="R"
              title={`${replayAudioLabel} · R`}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
              }}
              onClick={handleReplayAudio}
              className="wb-fc-audio-pill min-h-[36px] gap-1.5 rounded-full px-3 text-xs"
            >
              <ArrowClockwise size={13} aria-hidden="true" />
              <span>{replayAudioLabel}</span>
            </DsButton>
          ) : null}
          backAccessory={currentMediaSource ? renderMediaChip(currentMediaSource) : null}
        />
      )}

      {!editing ? (
        <>
          {/* 悬浮在评分栏上方：出现/消失不再推挤卡面 */}
          <div className="wb-fc-undo-anchor">
            <UndoNudge
              receiptId={lastReview?.logId ?? null}
              rating={lastReview?.rating ?? null}
              busy={ratingBusy}
              onUndo={handleUndoWithFeedback}
              secondaryAction={lastAgainCard ? (
                <div className="flex flex-wrap items-center gap-1">
                  {lastReviewMediaSource ? renderMediaChip(lastReviewMediaSource) : null}
                  <DsButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="fc-nudge-ask-ai"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                    }}
                    onClick={() => askAiAboutCard(lastAgainCard, t)}
                    className="shrink-0 gap-1 text-xs text-primary"
                  >
                    <ChatCircleText size={13} aria-hidden="true" />
                    {t('session.askAiDeep', { defaultValue: 'Ask AI to explain' })}
                  </DsButton>
                  {lastAgainCard.ankiCardId ? (
                    <DsButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="fc-nudge-edit-card"
                      disabled={ratingBusy}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                      }}
                      onClick={() => beginEditForCard(lastAgainCard)}
                      className="shrink-0 gap-1 text-xs"
                    >
                      <PencilSimple size={13} aria-hidden="true" />
                      {t('session.edit')}
                    </DsButton>
                  ) : null}
                </div>
              ) : (lastReviewMediaSource ? renderMediaChip(lastReviewMediaSource) : null)}
            />
          </div>
          <RatingBar
            flipped={flipped}
            disabled={ratingBusy}
            previews={ratingPreviews}
            pressedRating={pressedRating}
            onShowAnswer={handleFlip}
            onRate={handleRateClick}
          />
          {!mobileChrome ? (
            <div
              ref={shortcutsContainerRef}
              data-testid="fc-review-shortcut-hint"
              className="wb-fc-shortcut-hint relative justify-center"
            >
              <span aria-hidden="true" className="inline-flex flex-wrap items-center justify-center gap-1.5">
                {!flipped ? (
                  <span className="inline-flex items-center gap-1">
                    <kbd className="wb-fc-keycap">Space</kbd>
                    {t('review.shortcutFlip')}
                  </span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1">
                      <kbd className="wb-fc-keycap">1–4</kbd>
                      {t('review.shortcutRate')}
                    </span>
                    <span className="wb-fc-shortcut-sep">·</span>
                    <span className="inline-flex items-center gap-1">
                      <kbd className="wb-fc-keycap">Space</kbd>
                      {t('review.shortcutGood')}
                    </span>
                  </>
                )}
                {canUndoInSession ? (
                  <>
                    <span className="wb-fc-shortcut-sep">·</span>
                    <span className="inline-flex items-center gap-1">
                      <kbd className="wb-fc-keycap">Z</kbd>
                      {t('review.shortcutUndo')}
                    </span>
                  </>
                ) : null}
                <span className="wb-fc-shortcut-sep">·</span>
              </span>
              <DsButton
                ref={shortcutsTriggerRef}
                type="button"
                variant="ghost"
                size="sm"
                data-testid="fc-review-shortcuts-trigger"
                aria-haspopup="dialog"
                aria-expanded={shortcutsOpen}
                aria-controls={shortcutsPopoverId}
                aria-keyshortcuts="?"
                aria-label={t('review.shortcuts.triggerLabel', { defaultValue: 'Show keyboard shortcuts' })}
                title={`${t('review.shortcuts.triggerLabel', { defaultValue: 'Show keyboard shortcuts' })} · ?`}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                }}
                onClick={() => setShortcutsOpen((open) => !open)}
                className="h-auto gap-1 rounded px-1.5 py-0.5 text-2xs font-normal text-muted-foreground hover:text-foreground"
              >
                <kbd className="wb-fc-keycap" aria-hidden="true">?</kbd>
                <span>{t('review.shortcuts.triggerShort', { defaultValue: 'Shortcuts' })}</span>
              </DsButton>
              {shortcutsOpen ? (
                <div
                  id={shortcutsPopoverId}
                  role="dialog"
                  aria-modal="false"
                  aria-label={t('review.shortcuts.title', { defaultValue: 'Keyboard shortcuts' })}
                  data-testid="fc-review-shortcuts-popover"
                  className="absolute bottom-full left-1/2 z-30 mb-2 w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-border/70 bg-popover p-3 text-left text-xs text-popover-foreground shadow-lg"
                >
                  <div className="mb-2 flex items-center justify-between gap-2 border-b border-border/50 pb-1.5">
                    <span className="font-medium text-foreground">
                      {t('review.shortcuts.title', { defaultValue: 'Keyboard shortcuts' })}
                    </span>
                    <DsButton
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-testid="fc-review-shortcuts-close"
                      aria-label={t('common:close', { defaultValue: 'Close' })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                      }}
                      onClick={() => {
                        setShortcutsOpen(false);
                        shortcutsTriggerRef.current?.focus();
                      }}
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    >
                      <X size={13} aria-hidden="true" />
                    </DsButton>
                  </div>
                  <dl className="space-y-1.5">
                    {shortcutCheatSheetItems.map((item) => (
                      <div key={item.keys} className="flex items-center justify-between gap-3">
                        <dt className="text-muted-foreground">{item.label}</dt>
                        <dd className="shrink-0">
                          <kbd className="wb-fc-keycap">{item.keys}</kbd>
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="mt-2 flex items-center justify-end gap-1 border-t border-border/40 pt-1.5 text-2xs text-muted-foreground">
                    <kbd className="wb-fc-keycap">Esc</kbd>
                    <span>{t('review.shortcuts.closeHint', { defaultValue: 'Close' })}</span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {errorBanner}
    </div>
  );
};
