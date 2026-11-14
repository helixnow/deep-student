import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ArrowClockwise, CheckCircle, CircleNotch, WarningCircle, X } from '@phosphor-icons/react';
import { Z_INDEX } from '@/config/zIndex';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/utils/cn';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import SprintFsrsCardStage from './cards/SprintFsrsCardStage';
import SprintMistakeCardStage, {
  evaluateMistakeChoiceAnswer,
  isMultiChoiceMistake,
} from './cards/SprintMistakeCardStage';
import SprintMindmapClozeStage from './cards/SprintMindmapClozeStage';
import SprintSettlementScreen from './SprintSettlementScreen';
import {
  resolveItemSourceAnchors,
  revealSprintSourceAnchor,
} from './sourceAnchorBridge';
import {
  fetchDailySprintPlan,
  recordMindmapClozeSprintOutcome,
  settleDailySprint,
} from './sprintBridge';
import {
  formatElapsedTimerMmSs,
  getExamPhaseDotClass,
  type DailySprintPlan,
  type ResolvedSprintSourceAnchor,
  type SprintAnchorRevealer,
  type SprintCompletedItemRecord,
  type SprintCompoundPlan,
  type SprintCompoundQueueItem,
  type SprintMistakeItem,
  type SprintRating,
  type SprintSessionSettlement,
} from './sprintContracts';

export interface UnifiedDailySprintPlayerProps {
  spaceId?: string | null;
  rootFolderId?: string | null;
  examDateOverride?: string | null;
  sprintBudgetMinutesOverride?: number | null;
  defaultDeckIdOverride?: string | null;
  initialPlan?: SprintCompoundPlan | DailySprintPlan | null;
  anchorRevealer?: SprintAnchorRevealer;
  usePortal?: boolean;
  onClose: () => void;
  onSettled?: (settlement: SprintSessionSettlement) => void;
}

interface QueueEntry {
  entryKey: string;
  item: SprintCompoundQueueItem;
  requeuedOnce: boolean;
}

type PlayerPhase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; settlementRetry?: { plan: SprintCompoundPlan; records: SprintCompletedItemRecord[] } }
  | { kind: 'empty'; plan: SprintCompoundPlan }
  | { kind: 'active'; plan: SprintCompoundPlan }
  | { kind: 'settling'; plan: SprintCompoundPlan }
  | { kind: 'settled'; plan: SprintCompoundPlan; settlement: SprintSessionSettlement };

function formatCountdownBadge(
  daysUntilExam: number | null,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  if (daysUntilExam === null) return null;
  if (daysUntilExam === 0) return t('examSprint.hud.countdownToday');
  if (daysUntilExam > 0) return t('examSprint.hud.countdownDays', { count: daysUntilExam });
  return t('examSprint.hud.countdownPost', { count: Math.abs(daysUntilExam) });
}

function getPreviewIntervals(item: SprintCompoundQueueItem): Record<SprintRating, string> {
  if (item.kind === 'fsrs_card' && item.stability !== null && item.stability > 1.5) {
    const base = Math.max(1, Math.round(item.stability));
    const hardDays = Math.max(1, Math.round(base * 1.2));
    const goodDays = Math.max(hardDays + 1, Math.round(base * 2.4));
    const easyDays = Math.max(goodDays + 1, Math.round(base * 3.8));
    return {
      1: '10m',
      2: `${hardDays}d`,
      3: `${goodDays}d`,
      4: `${easyDays}d`,
    };
  }
  if (item.kind === 'mistake_question' && item.intervalDays > 1) {
    const hardDays = Math.max(1, Math.round(item.intervalDays * 1.2));
    const goodDays = Math.max(hardDays + 1, Math.round(item.intervalDays * 2.2));
    const easyDays = Math.max(goodDays + 1, Math.round(item.intervalDays * 3.2));
    return {
      1: '10m',
      2: `${hardDays}d`,
      3: `${goodDays}d`,
      4: `${easyDays}d`,
    };
  }
  return {
    1: '10m',
    2: '1d',
    3: '3d',
    4: '7d',
  };
}

function getMistakeEffectiveOptionKeys(item: SprintMistakeItem): string[] {
  if (Array.isArray(item.options) && item.options.length > 0) {
    return item.options.map((o) => o.key);
  }
  if (item.questionType === 'true_false') {
    return ['T', 'F'];
  }
  return [];
}

export const UnifiedDailySprintPlayer: React.FC<UnifiedDailySprintPlayerProps> = ({
  spaceId = null,
  rootFolderId = null,
  examDateOverride = null,
  sprintBudgetMinutesOverride = null,
  defaultDeckIdOverride = null,
  initialPlan = null,
  anchorRevealer,
  usePortal = true,
  onClose,
  onSettled,
}) => {
  const { t } = useTranslation('review');

  const [phase, setPhase] = useState<PlayerPhase>(() => {
    if (initialPlan) {
      return initialPlan.items.length > 0
        ? { kind: 'active', plan: initialPlan }
        : { kind: 'empty', plan: initialPlan };
    }
    return { kind: 'loading' };
  });

  const [queue, setQueue] = useState<QueueEntry[]>(() =>
    initialPlan
      ? initialPlan.items.map((item, idx) => ({
          entryKey: `${item.sprintItemId}:${idx}`,
          item,
          requeuedOnce: false,
        }))
      : [],
  );
  const [cursor, setCursor] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [selectedOptionKeys, setSelectedOptionKeys] = useState<string[]>([]);
  const [scratchpadText, setScratchpadText] = useState('');
  const [submittingRating, setSubmittingRating] = useState(false);
  const [splitDocked, setSplitDocked] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [budgetOverrideState, setBudgetOverrideState] = useState<number | null>(
    sprintBudgetMinutesOverride,
  );
  const [reloadNonce, setReloadNonce] = useState(0);

  const sessionStartedAtRef = useRef<number>(Date.now());
  const itemStartedAtRef = useRef<number>(Date.now());
  const completedRecordsRef = useRef<SprintCompletedItemRecord[]>([]);
  const sessionSeqRef = useRef(0);
  const ratedEntryRef = useRef<string | null>(null);
  const settlingRef = useRef(false);

  const initializePlanSession = useCallback((plan: SprintCompoundPlan) => {
    completedRecordsRef.current = [];
    ratedEntryRef.current = null;
    settlingRef.current = false;
    sessionStartedAtRef.current = Date.now();
    itemStartedAtRef.current = Date.now();
    setElapsedSeconds(0);
    setCursor(0);
    setRevealed(false);
    setSelectedOptionKeys([]);
    setScratchpadText('');
    setSubmittingRating(false);
    setSplitDocked(false);
    setQueue(
      plan.items.map((item, idx) => ({
        entryKey: `${item.sprintItemId}:${idx}`,
        item,
        requeuedOnce: false,
      })),
    );
    setPhase(plan.items.length > 0 ? { kind: 'active', plan } : { kind: 'empty', plan });
  }, []);

  useEffect(() => {
    const sessionSeq = ++sessionSeqRef.current;
    settlingRef.current = false;
    if (initialPlan && reloadNonce === 0) {
      initializePlanSession(initialPlan);
      return () => { sessionSeqRef.current += 1; };
    }
    let cancelled = false;
    setPhase({ kind: 'loading' });
    fetchDailySprintPlan({
      spaceId,
      rootFolderId,
      examDateOverride,
      sprintBudgetMinutesOverride: budgetOverrideState,
      defaultDeckIdOverride,
      enableAiVariants: true,
      maxLiveVariants: 2,
    })
      .then((plan) => {
        if (cancelled || sessionSeq !== sessionSeqRef.current) return;
        initializePlanSession(plan);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPhase({ kind: 'error', message: getErrorMessage(error) });
      });

    return () => {
      cancelled = true;
      sessionSeqRef.current += 1;
    };
  }, [
    budgetOverrideState,
    defaultDeckIdOverride,
    examDateOverride,
    initialPlan,
    initializePlanSession,
    reloadNonce,
    rootFolderId,
    spaceId,
  ]);

  useEffect(() => {
    if (phase.kind !== 'active') return undefined;
    const timer = window.setInterval(() => {
      const next = Math.max(0, Math.floor((Date.now() - sessionStartedAtRef.current) / 1000));
      setElapsedSeconds(next);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase.kind]);

  const currentEntry = phase.kind === 'active' ? (queue[cursor] ?? null) : null;
  const currentItem = currentEntry?.item ?? null;

  const resolvedAnchors = useMemo<ResolvedSprintSourceAnchor[]>(
    () => (currentItem ? resolveItemSourceAnchors(currentItem) : []),
    [currentItem],
  );
  const primarySourceAnchor: ResolvedSprintSourceAnchor | null = resolvedAnchors[0] ?? null;

  const suggestedRating = useMemo<SprintRating>(() => {
    if (!currentItem) return 3;
    if (currentItem.kind === 'mistake_question') {
      const matched = evaluateMistakeChoiceAnswer(currentItem, selectedOptionKeys);
      if (matched === false) return 1;
    }
    return 3;
  }, [currentItem, selectedOptionKeys]);

  const runSettlement = useCallback(
    async (plan: SprintCompoundPlan, records: SprintCompletedItemRecord[]) => {
      if (settlingRef.current) return;
      settlingRef.current = true;
      const sessionSeq = sessionSeqRef.current;
      setPhase({ kind: 'settling', plan });
      const totalElapsed = Math.max(
        1,
        Math.round((Date.now() - sessionStartedAtRef.current) / 1000),
      );
      try {
      const settled = await settleDailySprint({
        planSessionId: plan.planSessionId,
        spaceId: plan.config.spaceId ?? spaceId,
        rootFolderId: plan.config.rootFolderId ?? rootFolderId,
        examDateOverride,
        sprintBudgetMinutesOverride: budgetOverrideState,
        defaultDeckIdOverride,
        readinessBefore: plan.readinessBefore,
        totalElapsedSeconds: totalElapsed,
        completedItems: records,
      });
      if (sessionSeq !== sessionSeqRef.current) return;
      setPhase({ kind: 'settled', plan, settlement: settled });
      onSettled?.(settled);
      } catch (error) {
        if (sessionSeq === sessionSeqRef.current) {
          setPhase({ kind: 'error', message: getErrorMessage(error), settlementRetry: { plan, records } });
        }
      } finally {
        if (sessionSeq === sessionSeqRef.current) settlingRef.current = false;
      }
    },
    [
      budgetOverrideState,
      defaultDeckIdOverride,
      examDateOverride,
      onSettled,
      rootFolderId,
      spaceId,
    ],
  );

  const handleExitRequest = useCallback(() => {
    if (settlingRef.current) return;
    if (phase.kind === 'active') {
      const completed = completedRecordsRef.current;
      const remainingCount = queue.length - cursor;
      if (completed.length > 0 && remainingCount > 0) {
        void runSettlement(phase.plan, [...completed]);
        return;
      }
    }
    onClose();
  }, [cursor, onClose, phase, queue.length, runSettlement]);

  const handleToggleOption = useCallback(
    (optionKey: string) => {
      if (!currentItem || currentItem.kind !== 'mistake_question' || revealed) return;
      if (isMultiChoiceMistake(currentItem)) {
        setSelectedOptionKeys((prev) =>
          prev.includes(optionKey) ? prev.filter((k) => k !== optionKey) : [...prev, optionKey],
        );
      } else {
        setSelectedOptionKeys([optionKey]);
      }
    },
    [currentItem, revealed],
  );

  const handleReveal = useCallback(() => {
    if (revealed || !currentItem) return;
    setRevealed(true);
  }, [currentItem, revealed]);

  const handleRevealAnchor = useCallback(
    async (targetAnchor?: ResolvedSprintSourceAnchor) => {
      const anchor = targetAnchor ?? primarySourceAnchor;
      if (!anchor) return;
      const sessionSeq = sessionSeqRef.current;
      const res = await revealSprintSourceAnchor(anchor, { anchorRevealer });
      if (res.ok && sessionSeq === sessionSeqRef.current) {
        setSplitDocked(true);
      }
    },
    [anchorRevealer, primarySourceAnchor],
  );

  const handleRate = useCallback(
    async (rating: SprintRating) => {
      if (phase.kind !== 'active' || !currentEntry || !currentItem || !revealed
        || submittingRating || ratedEntryRef.current === currentEntry.entryKey) return;
      ratedEntryRef.current = currentEntry.entryKey;
      setSubmittingRating(true);

      const elapsedMs = Math.max(50, Date.now() - itemStartedAtRef.current);
      const alreadyCommittedInline = false;

      if (currentItem.kind === 'mindmap_cloze') {
        recordMindmapClozeSprintOutcome(
          currentItem.mindmapId,
          currentItem.nodeId,
          currentItem.blankedRanges.length,
          rating,
        );
      }

      const objectiveMatched =
        currentItem.kind === 'mistake_question'
          ? evaluateMistakeChoiceAnswer(currentItem, selectedOptionKeys)
          : null;
      const passed =
        rating === 1
          ? false
          : objectiveMatched === false
            ? false
            : rating >= 2;

      const record: SprintCompletedItemRecord = {
        sprintItemId: currentItem.sprintItemId,
        kind: currentItem.kind,
        rating,
        passed,
        elapsedMs,
        conceptTags: currentItem.triage.conceptTags,
        cardStateId: currentItem.kind === 'fsrs_card' ? currentItem.cardStateId : null,
        ankiCardId: currentItem.kind === 'fsrs_card' ? currentItem.ankiCardId : null,
        planId: currentItem.kind === 'mistake_question' ? currentItem.planId : null,
        questionId: currentItem.kind === 'mistake_question' ? currentItem.questionId : null,
        originalQuestionId:
          currentItem.kind === 'mistake_question' ? currentItem.originalQuestionId : null,
        isVariant: currentItem.kind === 'mistake_question' ? currentItem.isVariant : false,
        mindmapId: currentItem.kind === 'mindmap_cloze' ? currentItem.mindmapId : null,
        nodeId: currentItem.kind === 'mindmap_cloze' ? currentItem.nodeId : null,
        alreadyCommittedInline,
      };

      const nextRecords = [...completedRecordsRef.current, record];
      completedRecordsRef.current = nextRecords;

      let nextQueue = queue;
      if (rating === 1 && !currentEntry.requeuedOnce) {
        nextQueue = [
          ...queue,
          {
            entryKey: `${currentEntry.entryKey}:retry`,
            item: currentItem,
            requeuedOnce: true,
          },
        ];
        setQueue(nextQueue);
      }

      const nextCursor = cursor + 1;
      setSubmittingRating(false);

      if (nextCursor >= nextQueue.length) {
        await runSettlement(phase.plan, nextRecords);
        return;
      }

      itemStartedAtRef.current = Date.now();
      setCursor(nextCursor);
      setRevealed(false);
      setSelectedOptionKeys([]);
      setScratchpadText('');
    },
    [
      currentEntry,
      currentItem,
      cursor,
      phase,
      queue,
      revealed,
      runSettlement,
      selectedOptionKeys,
      submittingRating,
    ],
  );

  useEffect(() => {
    if (phase.kind === 'settled') return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isComposingKeyEvent(event) || event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        handleExitRequest();
        return;
      }

      const target = event.target as HTMLElement | null;
      if (
        target
        && (target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
           || target.tagName === 'SELECT'
           || target.isContentEditable
           || (typeof target.closest === 'function' && target.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"]')))
      ) {
        return;
      }

      if (phase.kind !== 'active' || !currentItem || submittingRating) return;

      if ((event.key === 'o' || event.key === 'O') && primarySourceAnchor) {
        event.preventDefault();
        void handleRevealAnchor(primarySourceAnchor);
        return;
      }

      if (!revealed) {
        if (currentItem.kind === 'mistake_question') {
          const optionKeys = getMistakeEffectiveOptionKeys(currentItem);
          if (optionKeys.length > 0) {
            if (event.key >= '1' && event.key <= '4') {
              const idx = Number(event.key) - 1;
              if (idx < optionKeys.length) {
                event.preventDefault();
                handleToggleOption(optionKeys[idx]!);
              }
              return;
            }
            const upper = event.key.toUpperCase();
            if (upper >= 'A' && upper <= 'D') {
              const matched = optionKeys.find((k) => k.toUpperCase() === upper);
              if (matched) {
                event.preventDefault();
                handleToggleOption(matched);
              }
              return;
            }
          }
        }

        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          handleReveal();
        }
        return;
      }

      if (event.key >= '1' && event.key <= '4') {
        event.preventDefault();
        void handleRate(Number(event.key) as SprintRating);
        return;
      }

      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        void handleRate(suggestedRating);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    currentItem,
    handleExitRequest,
    handleRate,
    handleReveal,
    handleRevealAnchor,
    handleToggleOption,
    phase.kind,
    primarySourceAnchor,
    revealed,
    submittingRating,
    suggestedRating,
  ]);

  const activePlan =
    phase.kind === 'active' || phase.kind === 'settling' || phase.kind === 'settled' || phase.kind === 'empty'
      ? phase.plan
      : null;

  const remainingSecondsEstimate = useMemo(() => {
    if (phase.kind !== 'active') return 0;
    let sum = 0;
    for (let i = cursor; i < queue.length; i += 1) {
      const est = queue[i]?.item.triage.estimatedSeconds ?? 20;
      sum += Number.isFinite(est) && est > 0 ? Math.min(120, Math.max(8, est)) : 20;
    }
    return sum;
  }, [cursor, phase.kind, queue]);

  const remainingMinutesLabel = useMemo(() => {
    if (remainingSecondsEstimate <= 0) return null;
    if (remainingSecondsEstimate < 60) {
      return t('examSprint.player.remainingLessThanMinute');
    }
    return t('examSprint.player.remainingMinutes', {
      minutes: Math.max(1, Math.ceil(remainingSecondsEstimate / 60)),
    });
  }, [remainingSecondsEstimate, t]);

  const modalityBadgeLabel = useMemo(() => {
    if (!currentItem) return '';
    if (currentItem.kind === 'mistake_question' && currentItem.isVariant) {
      return t('examSprint.player.modality.ai_variant');
    }
    return t(`examSprint.player.modality.${currentItem.kind}`);
  }, [currentItem, t]);

  const countdownBadge = useMemo(
    () =>
      activePlan
        ? formatCountdownBadge(activePlan.readinessBefore.daysUntilExam, t)
        : null,
    [activePlan, t],
  );

  const previewIntervals = useMemo(
    () => (currentItem ? getPreviewIntervals(currentItem) : null),
    [currentItem],
  );

  const progressPct =
    queue.length > 0 ? Math.min(100, Math.round((cursor / queue.length) * 100)) : 0;

  const content = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('examSprint.player.dialogLabel')}
      data-testid="unified-daily-sprint-player"
      data-split-docked={splitDocked ? 'true' : undefined}
      style={{ zIndex: Z_INDEX.modal }}
      className={cn(
        'fixed inset-0 z-[70] flex flex-col bg-background/95 backdrop-blur-sm transition-all',
        splitDocked && 'sm:left-auto sm:w-[min(560px,50vw)] sm:border-l sm:border-border/35 sm:shadow-2xl',
      )}
    >
      <header className="shrink-0 border-b border-border/35 bg-background/80 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between gap-3 px-4">
          <button
            type="button"
            data-testid="sprint-player-exit"
            aria-label={t('examSprint.player.exitLabel')}
            onClick={handleExitRequest}
            className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:border-border/35 hover:bg-muted/50 hover:text-foreground active:scale-95 active:opacity-80"
          >
            <X size={18} aria-hidden="true" />
          </button>

          {phase.kind === 'active' && currentItem && activePlan ? (
            <div className="flex min-w-0 flex-1 flex-col items-center gap-1">
              <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5 text-xs">
                <span
                  data-testid="sprint-modality-badge"
                  className="rounded-md border border-border/35 bg-card px-2 py-0.5 font-medium text-foreground"
                >
                  {modalityBadgeLabel}
                </span>

                {currentEntry?.requeuedOnce ? (
                  <span
                    data-testid="sprint-requeued-badge"
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
                  >
                    {t('examSprint.player.requeuedBadge')}
                  </span>
                ) : null}

                {countdownBadge ? (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border/35 bg-card/70 px-2 py-0.5 text-muted-foreground">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 shrink-0 rounded-full',
                        getExamPhaseDotClass(activePlan.readinessBefore.phase),
                      )}
                      aria-hidden="true"
                    />
                    <span>{t(`examSprint.hud.phase.${activePlan.readinessBefore.phase}`)}</span>
                    <span>·</span>
                    <span className="font-mono tabular-nums text-foreground">{countdownBadge}</span>
                  </span>
                ) : null}

                <span
                  data-testid="sprint-progress-ordinal"
                  className="font-mono tabular-nums text-muted-foreground"
                >
                  {cursor + 1} / {queue.length}
                </span>

                {remainingMinutesLabel ? (
                  <span className="hidden font-mono tabular-nums text-muted-foreground sm:inline">
                    · {remainingMinutesLabel}
                  </span>
                ) : null}
              </div>

              <div className="h-0.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-200"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          ) : (
            <div className="text-sm font-medium text-foreground">
              {t('examSprint.player.dialogLabel')}
            </div>
          )}

          <div
            data-testid="sprint-live-timer"
            className="min-w-[48px] shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground"
          >
            {phase.kind === 'active' ? formatElapsedTimerMmSs(elapsedSeconds) : ''}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {phase.kind === 'loading' || phase.kind === 'settling' ? (
          <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-3 text-center">
            <CircleNotch size={24} className="animate-spin text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">
              {phase.kind === 'settling'
                ? t('examSprint.settlement.settling')
                : t('examSprint.player.loading')}
            </p>
          </div>
        ) : phase.kind === 'error' ? (
          <div className="mx-auto flex h-full min-h-[260px] max-w-md flex-col items-center justify-center gap-3 text-center">
            <WarningCircle size={26} className="text-amber-500" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">
              {t('examSprint.player.loadFailed')}
            </p>
            <p className="break-words text-xs text-muted-foreground">{phase.message}</p>
            <div className="mt-1 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  if (phase.settlementRetry) {
                    void runSettlement(phase.settlementRetry.plan, phase.settlementRetry.records);
                  } else {
                    setReloadNonce((n) => n + 1);
                  }
                }}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-medium text-primary-foreground active:scale-95 active:opacity-80"
              >
                <ArrowClockwise size={14} aria-hidden="true" />
                <span>{t('examSprint.player.retry')}</span>
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-border/35 px-4 py-2 text-xs font-medium text-foreground active:scale-95 active:opacity-80"
              >
                {t('examSprint.player.close')}
              </button>
            </div>
          </div>
        ) : phase.kind === 'empty' ? (
          <div className="mx-auto flex h-full min-h-[260px] max-w-md flex-col items-center justify-center gap-3 text-center">
            <CheckCircle size={28} className="text-emerald-500" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">
              {t('examSprint.player.emptyTitle')}
            </p>
            <p className="text-xs text-muted-foreground">{t('examSprint.player.emptyHint')}</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-1 inline-flex min-h-[44px] items-center rounded-lg border border-border/35 bg-card px-4 py-2 text-xs font-medium text-foreground active:scale-95 active:opacity-80"
            >
              {t('examSprint.player.close')}
            </button>
          </div>
        ) : phase.kind === 'settled' ? (
          <SprintSettlementScreen
            settlement={phase.settlement}
            deferredBacklogCount={phase.plan.deferredBacklogCount}
            onFinish={onClose}
            onExtraSprint={(minutes) => {
              setBudgetOverrideState(minutes);
              setReloadNonce((n) => n + 1);
            }}
          />
        ) : currentItem ? (
          <>
            {currentItem.kind === 'fsrs_card' ? (
              <SprintFsrsCardStage
                item={currentItem}
                revealed={revealed}
                resolvedAnchors={resolvedAnchors}
                onReveal={handleReveal}
                onRevealAnchor={
                  resolvedAnchors.length > 0
                    ? (anchor) => void handleRevealAnchor(anchor)
                    : undefined
                }
              />
            ) : currentItem.kind === 'mistake_question' ? (
              <SprintMistakeCardStage
                key={currentEntry?.entryKey}
                item={currentItem}
                revealed={revealed}
                resolvedAnchors={resolvedAnchors}
                selectedOptionKeys={selectedOptionKeys}
                scratchpadText={scratchpadText}
                onSelectOptionKey={handleToggleOption}
                onScratchpadChange={setScratchpadText}
                onReveal={handleReveal}
                onRevealAnchor={
                  resolvedAnchors.length > 0
                    ? (anchor) => void handleRevealAnchor(anchor)
                    : undefined
                }
              />
            ) : (
              <SprintMindmapClozeStage
                item={currentItem}
                revealed={revealed}
                resolvedAnchors={resolvedAnchors}
                onReveal={handleReveal}
                onRevealAnchor={(anchor) => void handleRevealAnchor(anchor)}
              />
            )}
          </>
        ) : null}
      </div>

      {phase.kind === 'active' && currentItem ? (
        <footer className="shrink-0 border-t border-border/35 bg-background/90 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="mx-auto max-w-2xl">
            {!revealed ? (
              <button
                type="button"
                data-testid="sprint-reveal-button"
                onClick={handleReveal}
                className="flex min-h-[44px] max-sm:min-h-[48px] w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 active:scale-95 active:opacity-80"
              >
                <span>
                  {currentItem.kind === 'mistake_question'
                    ? getMistakeEffectiveOptionKeys(currentItem).length > 0
                      ? t('examSprint.player.checkAnswer')
                      : t('examSprint.player.revealAnalysis')
                    : t('examSprint.player.revealAnswer')}
                </span>
              </button>
            ) : (
              <div
                className="grid grid-cols-4 gap-2"
                role="group"
                aria-label={t('rating.prompt')}
                data-testid="sprint-rating-bar"
              >
                {(
                  [
                    { rating: 1 as const, labelKey: 'examSprint.player.rating.again', tone: 'rose' },
                    { rating: 2 as const, labelKey: 'examSprint.player.rating.hard', tone: 'amber' },
                    { rating: 3 as const, labelKey: 'examSprint.player.rating.good', tone: 'emerald' },
                    { rating: 4 as const, labelKey: 'examSprint.player.rating.easy', tone: 'primary' },
                  ] as const
                ).map(({ rating, labelKey, tone }) => {
                  const isSuggested = suggestedRating === rating;
                  return (
                    <button
                      key={rating}
                      type="button"
                      disabled={submittingRating}
                      data-testid={`sprint-rate-${rating}`}
                      data-suggested={isSuggested ? 'true' : undefined}
                      onClick={() => void handleRate(rating)}
                      className={cn(
                        'flex min-h-[44px] max-sm:min-h-[48px] flex-col items-center justify-center rounded-lg border px-2 py-1.5 text-xs transition-colors active:scale-95 active:opacity-80 disabled:opacity-50',
                        isSuggested && tone === 'emerald'
                          && 'border-emerald-500/45 bg-emerald-500/12 text-foreground',
                        isSuggested && tone === 'rose'
                          && 'border-rose-500/45 bg-rose-500/12 text-foreground',
                        !isSuggested && 'border-border/35 bg-card hover:bg-muted/60 text-foreground',
                      )}
                    >
                      <span className="flex items-center gap-1 font-medium">
                        <kbd className="font-mono text-[10px] tabular-nums text-muted-foreground">
                          {rating}
                        </kbd>
                        <span>{t(labelKey)}</span>
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                        {previewIntervals?.[rating] ?? ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </footer>
      ) : null}
    </div>
  );

  if (!usePortal || typeof document === 'undefined') {
    return content;
  }
  return createPortal(content, document.body);
};

export default UnifiedDailySprintPlayer;
