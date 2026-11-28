import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  ArrowUUpLeft,
  ArrowsOutSimple,
  CheckCircle,
  CircleNotch,
  Sparkle,
  SpeakerHigh,
  StopCircle,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { BACK_PRIORITY, registerBackHandler } from '@/app/navigation/androidBackCoordinator';
import { UnifiedMobileHeader } from '@/components/layout/UnifiedMobileHeader';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { DsButton } from '@/components/ui/DsButton';
import { Z_INDEX } from '@/config/zIndex';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/utils/cn';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { speak as speakTts, stop as stopTts } from '@/utils/tts';
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
  MINDMAP_RECITE_STATS_PREFIX,
  fetchDailySprintPlan,
  recordMindmapClozeSprintOutcome,
  settleDailySprint,
} from './sprintBridge';
import {
  clearSprintCheckpoint,
  getLocalSprintDateKey,
  loadSprintCheckpoint,
  saveSprintCheckpoint,
  type PersistedSprintCheckpoint,
} from './sprintCheckpointStorage';
import {
  formatElapsedTimerMmSs,
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

/** 翻面后短时间内忽略真实指针点击评分，防止双击翻面误评（键盘不受限） */
const POINTER_RATE_GUARD_MS = 280;
const CLOZE_SYNTAX_RE = /\{\{c\d+::([\s\S]*?)(?:::([\s\S]*?))?\}\}/gi;

function stripRichMarkup(value: string | null | undefined, maxLen = 1200): string {
  return (value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLen);
}

function buildAskAiPrompt(
  item: SprintCompoundQueueItem,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const sections: string[] = [];
  if (item.kind === 'fsrs_card') {
    const front = stripRichMarkup(item.fields.Text || item.front).replace(CLOZE_SYNTAX_RE, '$1');
    const back = stripRichMarkup(item.back);
    if (front) sections.push(`题目/正面：${front}`);
    if (back && back !== front) sections.push(`答案/背面：${back}`);
  } else if (item.kind === 'mistake_question') {
    sections.push(`题干：${stripRichMarkup(item.content)}`);
    if (Array.isArray(item.options) && item.options.length > 0) {
      sections.push(
        `选项：\n${item.options.map((o) => `${o.key}. ${stripRichMarkup(o.content, 300)}`).join('\n')}`,
      );
    }
    if (item.answer) sections.push(`参考答案：${stripRichMarkup(item.answer, 400)}`);
    if (item.explanation) sections.push(`解析：${stripRichMarkup(item.explanation, 600)}`);
  } else {
    sections.push(`思维导图：${item.mindmapTitle}`);
    if (item.ancestorPath.length > 0) sections.push(`路径：${item.ancestorPath.join(' > ')}`);
    sections.push(`节点内容：${stripRichMarkup(item.fullText)}`);
    if (item.noteExcerpt) sections.push(`备注：${stripRichMarkup(item.noteExcerpt, 400)}`);
  }
  return t('examSprint.player.askAiPrompt', {
    card: sections.join('\n'),
    defaultValue:
      '我在今日冲刺中遇到这张难卡没完全掌握，请帮我讲透：先说明核心考点与底层逻辑，再指出最容易踩坑的地方和好记的规律，最后出 1 道同类型小题检验我。\n\n{{card}}',
  });
}

function buildSpeakableText(item: SprintCompoundQueueItem, revealed: boolean): string {
  if (item.kind === 'fsrs_card') {
    const rawFront = item.fields.Text || item.front;
    const frontText = stripRichMarkup(
      rawFront.replace(CLOZE_SYNTAX_RE, (_m, ans: string, hint?: string) =>
        revealed ? ans : (hint?.trim() ? hint.trim() : '填空'),
      ),
      800,
    );
    if (!revealed) return frontText;
    const backText = stripRichMarkup(item.back, 800);
    return backText && backText !== frontText ? `${frontText}。答案：${backText}` : frontText;
  }
  if (item.kind === 'mistake_question') {
    const parts = [stripRichMarkup(item.content, 800)];
    if (Array.isArray(item.options) && item.options.length > 0) {
      parts.push(item.options.map((o) => `${o.key}，${stripRichMarkup(o.content, 200)}`).join('；'));
    }
    if (revealed) {
      if (item.answer) parts.push(`答案：${stripRichMarkup(item.answer, 300)}`);
      if (item.explanation) parts.push(`解析：${stripRichMarkup(item.explanation, 500)}`);
    }
    return parts.filter(Boolean).join('。');
  }
  return stripRichMarkup(revealed ? item.fullText : item.maskedText, 800);
}

interface SprintUndoSnapshot {
  queue: QueueEntry[];
  cursor: number;
  completedRecords: SprintCompletedItemRecord[];
  selectedOptionKeys: string[];
  scratchpadText: string;
  mindmapStorageKey?: string;
  mindmapStoragePrevValue?: string | null;
}

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
  const isMobileViewport = useMediaQuery('(max-width: 767px)');
  const checkpointScopeKey = spaceId ?? null;

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
  const [dockReason, setDockReason] = useState<'source' | 'ai'>('source');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [budgetOverrideState, setBudgetOverrideState] = useState<number | null>(
    sprintBudgetMinutesOverride,
  );
  const [reloadNonce, setReloadNonce] = useState(0);
  const [pressedRating, setPressedRating] = useState<SprintRating | null>(null);
  const [undoStack, setUndoStack] = useState<SprintUndoSnapshot[]>([]);
  const [isSpeakingTts, setIsSpeakingTts] = useState(false);
  const [resumedFromCheckpoint, setResumedFromCheckpoint] = useState(false);
  const pressTimerRef = useRef<number | null>(null);
  const revealedAtRef = useRef<number>(0);
  const ttsSeqRef = useRef(0);

  const stopReadingAloud = useCallback(() => {
    ttsSeqRef.current += 1;
    setIsSpeakingTts(false);
    void stopTts().catch(() => {});
  }, []);

  useEffect(() => () => {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    void stopTts().catch(() => {});
  }, []);

  const flashRating = useCallback((rating: SprintRating) => {
    if (pressTimerRef.current !== null) window.clearTimeout(pressTimerRef.current);
    setPressedRating(rating);
    pressTimerRef.current = window.setTimeout(() => {
      setPressedRating(null);
      pressTimerRef.current = null;
    }, 220);
  }, []);

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
    revealedAtRef.current = 0;
    sessionStartedAtRef.current = Date.now();
    itemStartedAtRef.current = Date.now();
    setElapsedSeconds(0);
    setCursor(0);
    setRevealed(false);
    setSelectedOptionKeys([]);
    setScratchpadText('');
    setSubmittingRating(false);
    setSplitDocked(false);
    setDockReason('source');
    setUndoStack([]);
    setResumedFromCheckpoint(false);
    stopReadingAloud();
    setQueue(
      plan.items.map((item, idx) => ({
        entryKey: `${item.sprintItemId}:${idx}`,
        item,
        requeuedOnce: false,
      })),
    );
    setPhase(plan.items.length > 0 ? { kind: 'active', plan } : { kind: 'empty', plan });
  }, [stopReadingAloud]);

  const restoreCheckpointSession = useCallback((checkpoint: PersistedSprintCheckpoint) => {
    completedRecordsRef.current = [...checkpoint.completedRecords];
    ratedEntryRef.current = null;
    settlingRef.current = false;
    revealedAtRef.current = 0;
    const restoredElapsed = Math.max(0, checkpoint.elapsedSeconds);
    sessionStartedAtRef.current = Date.now() - restoredElapsed * 1000;
    itemStartedAtRef.current = Date.now();
    setElapsedSeconds(restoredElapsed);
    setCursor(Math.min(checkpoint.cursor, Math.max(0, checkpoint.queue.length - 1)));
    setRevealed(false);
    setSelectedOptionKeys([]);
    setScratchpadText('');
    setSubmittingRating(false);
    setSplitDocked(false);
    setDockReason('source');
    setUndoStack([]);
    setResumedFromCheckpoint(true);
    stopReadingAloud();
    setQueue(checkpoint.queue);
    setPhase({ kind: 'active', plan: checkpoint.plan });
  }, [stopReadingAloud]);

  const runSettlement = useCallback(
    async (plan: SprintCompoundPlan, records: SprintCompletedItemRecord[]) => {
      if (settlingRef.current) return;
      settlingRef.current = true;
      stopReadingAloud();
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
        clearSprintCheckpoint(checkpointScopeKey, plan.planSessionId);
        setSplitDocked(false);
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
      checkpointScopeKey,
      defaultDeckIdOverride,
      examDateOverride,
      onSettled,
      rootFolderId,
      spaceId,
      stopReadingAloud,
    ],
  );

  const runSettlementRef = useRef(runSettlement);
  runSettlementRef.current = runSettlement;

  useEffect(() => {
    const sessionSeq = ++sessionSeqRef.current;
    settlingRef.current = false;
    const savedCheckpoint = reloadNonce === 0 ? loadSprintCheckpoint(checkpointScopeKey) : null;

    if (initialPlan && reloadNonce === 0) {
      if (savedCheckpoint && savedCheckpoint.planSessionId === initialPlan.planSessionId) {
        if (savedCheckpoint.cursor >= savedCheckpoint.queue.length) {
          completedRecordsRef.current = [...savedCheckpoint.completedRecords];
          sessionStartedAtRef.current = Date.now() - Math.max(0, savedCheckpoint.elapsedSeconds) * 1000;
          setQueue(savedCheckpoint.queue);
          setCursor(savedCheckpoint.cursor);
          void runSettlementRef.current(savedCheckpoint.plan, savedCheckpoint.completedRecords);
        } else {
          restoreCheckpointSession(savedCheckpoint);
        }
      } else {
        initializePlanSession(initialPlan);
      }
      return () => { sessionSeqRef.current += 1; };
    }

    let cancelled = false;
    const todayKey = getLocalSprintDateKey();

    if (savedCheckpoint && savedCheckpoint.dateKey === todayKey) {
      if (savedCheckpoint.cursor < savedCheckpoint.queue.length) {
        restoreCheckpointSession(savedCheckpoint);
        return () => {
          cancelled = true;
          sessionSeqRef.current += 1;
        };
      }
      // All items were completed before the process was killed; settle immediately.
      completedRecordsRef.current = [...savedCheckpoint.completedRecords];
      sessionStartedAtRef.current = Date.now() - Math.max(0, savedCheckpoint.elapsedSeconds) * 1000;
      setQueue(savedCheckpoint.queue);
      setCursor(savedCheckpoint.cursor);
      void runSettlementRef.current(savedCheckpoint.plan, savedCheckpoint.completedRecords);
      return () => {
        cancelled = true;
        sessionSeqRef.current += 1;
      };
    }

    setPhase({ kind: 'loading' });
    const settleStaleThenFetch = async (): Promise<DailySprintPlan> => {
      if (savedCheckpoint && savedCheckpoint.dateKey !== todayKey) {
        try {
          await settleDailySprint({
            planSessionId: savedCheckpoint.plan.planSessionId,
            spaceId: savedCheckpoint.plan.config.spaceId ?? spaceId,
            rootFolderId: savedCheckpoint.plan.config.rootFolderId ?? rootFolderId,
            examDateOverride,
            sprintBudgetMinutesOverride: budgetOverrideState,
            defaultDeckIdOverride,
            readinessBefore: savedCheckpoint.plan.readinessBefore,
            totalElapsedSeconds: Math.max(1, savedCheckpoint.elapsedSeconds),
            completedItems: savedCheckpoint.completedRecords,
          });
          clearSprintCheckpoint(checkpointScopeKey, savedCheckpoint.planSessionId);
        } catch {
          // Keep stale checkpoint untouched if offline; proceed to fetch today's plan.
        }
      }
      return fetchDailySprintPlan({
        spaceId,
        rootFolderId,
        examDateOverride,
        sprintBudgetMinutesOverride: budgetOverrideState,
        defaultDeckIdOverride,
        enableAiVariants: true,
        maxLiveVariants: 2,
      });
    };

    settleStaleThenFetch()
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
    checkpointScopeKey,
    defaultDeckIdOverride,
    examDateOverride,
    initialPlan,
    initializePlanSession,
    reloadNonce,
    restoreCheckpointSession,
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

  const flushActiveCheckpoint = useCallback(() => {
    if (phase.kind !== 'active' || completedRecordsRef.current.length === 0) return;
    const currentElapsed = Math.max(
      0,
      Math.floor((Date.now() - sessionStartedAtRef.current) / 1000),
    );
    saveSprintCheckpoint(checkpointScopeKey, {
      plan: phase.plan,
      queue,
      cursor,
      completedRecords: [...completedRecordsRef.current],
      elapsedSeconds: currentElapsed,
    });
  }, [checkpointScopeKey, cursor, phase, queue]);

  useEventRegistry(
    phase.kind === 'active'
      ? [
          { target: 'window', type: 'pagehide', listener: flushActiveCheckpoint },
          {
            target: 'document',
            type: 'visibilitychange',
            listener: () => {
              if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
                flushActiveCheckpoint();
              }
            },
          },
        ]
      : [],
    [phase.kind, flushActiveCheckpoint],
  );

  const handleExitRequest = useCallback(() => {
    if (settlingRef.current) return;
    stopReadingAloud();
    if (phase.kind === 'active') {
      const completed = completedRecordsRef.current;
      const remainingCount = queue.length - cursor;
      if (completed.length > 0 && remainingCount > 0) {
        void runSettlement(phase.plan, [...completed]);
        return;
      }
      if (completed.length === 0) {
        clearSprintCheckpoint(checkpointScopeKey, phase.plan.planSessionId);
      }
    }
    onClose();
  }, [checkpointScopeKey, cursor, onClose, phase, queue.length, runSettlement, stopReadingAloud]);

  // 接管 Android 物理返回键与浏览器后退：手机查看来源时先回到冲刺，否则走安全结算/退出
  const backActionRef = useRef<() => void>(() => {});
  backActionRef.current = () => {
    if (splitDocked && isMobileViewport && phase.kind === 'active') {
      setSplitDocked(false);
      return;
    }
    if (phase.kind === 'settled') {
      onClose();
      return;
    }
    handleExitRequest();
  };
  useEffect(
    () =>
      registerBackHandler(() => {
        backActionRef.current();
        return true;
      }, BACK_PRIORITY.overlay),
    [],
  );

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
    revealedAtRef.current = Date.now();
    setRevealed(true);
  }, [currentItem, revealed]);

  const handleRevealAnchor = useCallback(
    async (targetAnchor?: ResolvedSprintSourceAnchor) => {
      const anchor = targetAnchor ?? primarySourceAnchor;
      if (!anchor) return;
      const sessionSeq = sessionSeqRef.current;
      const res = await revealSprintSourceAnchor(anchor, { anchorRevealer });
      if (res.ok && sessionSeq === sessionSeqRef.current) {
        setDockReason('source');
        setSplitDocked(true);
      }
    },
    [anchorRevealer, primarySourceAnchor],
  );

  const handleAskAi = useCallback(() => {
    if (!currentItem) return;
    stopReadingAloud();
    dispatchAppEvent(APP_EVENTS.PREFILL_CHAT_INPUT, {
      content: buildAskAiPrompt(currentItem, t),
      autoSend: false,
      newSession: true,
    });
    setDockReason('ai');
    setSplitDocked(true);
  }, [currentItem, stopReadingAloud, t]);

  const handleToggleTts = useCallback(() => {
    if (!currentItem) return;
    if (isSpeakingTts) {
      stopReadingAloud();
      return;
    }
    const text = buildSpeakableText(currentItem, revealed);
    if (!text) return;
    const seq = ++ttsSeqRef.current;
    setIsSpeakingTts(true);
    void speakTts(text)
      .catch((err: unknown) => {
        if (ttsSeqRef.current !== seq) return;
        const msg = getErrorMessage(err);
        if (msg && !/abort|cancel|interrupt/i.test(msg)) {
          showGlobalNotification('error', msg);
        }
      })
      .finally(() => {
        if (ttsSeqRef.current === seq) {
          setIsSpeakingTts(false);
        }
      });
  }, [currentItem, isSpeakingTts, revealed, stopReadingAloud]);

  const handleUndo = useCallback(() => {
    if (phase.kind !== 'active' || submittingRating || undoStack.length === 0) return;
    stopReadingAloud();
    const prev = undoStack[undoStack.length - 1]!;
    setUndoStack((stack) => stack.slice(0, -1));
    if (prev.mindmapStorageKey && typeof globalThis.localStorage !== 'undefined') {
      try {
        if (prev.mindmapStoragePrevValue === null || prev.mindmapStoragePrevValue === undefined) {
          globalThis.localStorage.removeItem(prev.mindmapStorageKey);
        } else {
          globalThis.localStorage.setItem(prev.mindmapStorageKey, prev.mindmapStoragePrevValue);
        }
      } catch {
        // Ignore storage restore errors.
      }
    }
    completedRecordsRef.current = [...prev.completedRecords];
    ratedEntryRef.current = null;
    revealedAtRef.current = 0;
    itemStartedAtRef.current = Date.now();
    setQueue(prev.queue);
    setCursor(prev.cursor);
    setSelectedOptionKeys(prev.selectedOptionKeys);
    setScratchpadText(prev.scratchpadText);
    setRevealed(true);
    const currentElapsed = Math.max(
      0,
      Math.floor((Date.now() - sessionStartedAtRef.current) / 1000),
    );
    saveSprintCheckpoint(checkpointScopeKey, {
      plan: phase.plan,
      queue: prev.queue,
      cursor: prev.cursor,
      completedRecords: [...prev.completedRecords],
      elapsedSeconds: currentElapsed,
    });
  }, [checkpointScopeKey, phase, stopReadingAloud, submittingRating, undoStack]);

  const handleRate = useCallback(
    async (rating: SprintRating) => {
      if (phase.kind !== 'active' || !currentEntry || !currentItem || !revealed
        || submittingRating || ratedEntryRef.current === currentEntry.entryKey) return;
      ratedEntryRef.current = currentEntry.entryKey;
      stopReadingAloud();
      flashRating(rating);
      setSubmittingRating(true);

      const elapsedMs = Math.max(50, Date.now() - itemStartedAtRef.current);
      const alreadyCommittedInline = false;

      let mindmapStorageKey: string | undefined;
      let mindmapStoragePrevValue: string | null | undefined;
      if (currentItem.kind === 'mindmap_cloze') {
        mindmapStorageKey = `${MINDMAP_RECITE_STATS_PREFIX}${currentItem.mindmapId}`;
        if (typeof globalThis.localStorage !== 'undefined') {
          try {
            mindmapStoragePrevValue = globalThis.localStorage.getItem(mindmapStorageKey);
          } catch {
            mindmapStoragePrevValue = null;
          }
        }
        recordMindmapClozeSprintOutcome(
          currentItem.mindmapId,
          currentItem.nodeId,
          currentItem.blankedRanges.length,
          rating,
        );
      }

      const undoEntry: SprintUndoSnapshot = {
        queue,
        cursor,
        completedRecords: [...completedRecordsRef.current],
        selectedOptionKeys: [...selectedOptionKeys],
        scratchpadText,
        mindmapStorageKey,
        mindmapStoragePrevValue,
      };

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
      const currentElapsed = Math.max(
        0,
        Math.floor((Date.now() - sessionStartedAtRef.current) / 1000),
      );
      saveSprintCheckpoint(checkpointScopeKey, {
        plan: phase.plan,
        queue: nextQueue,
        cursor: nextCursor,
        completedRecords: nextRecords,
        elapsedSeconds: currentElapsed,
      });

      setUndoStack((prev) => [...prev.slice(-19), undoEntry]);
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
      checkpointScopeKey,
      currentEntry,
      currentItem,
      cursor,
      flashRating,
      phase,
      queue,
      revealed,
      runSettlement,
      scratchpadText,
      selectedOptionKeys,
      stopReadingAloud,
      submittingRating,
    ],
  );

  const handleRateClick = useCallback(
    (rating: SprintRating, event: React.MouseEvent<HTMLButtonElement>) => {
      // 真实指针点击（detail > 0）在翻面后 280ms 内忽略，防止双击卡面误评（键盘不受限）
      if (event.detail > 0 && Date.now() - revealedAtRef.current < POINTER_RATE_GUARD_MS) {
        return;
      }
      void handleRate(rating);
    },
    [handleRate],
  );

  const onWindowKeyDown = useCallback(
    (rawEvent: Event) => {
      const event = rawEvent as KeyboardEvent;
      if (isComposingKeyEvent(event) || event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        if (splitDocked && isMobileViewport && phase.kind === 'active') {
          setSplitDocked(false);
        } else {
          handleExitRequest();
        }
        return;
      }

      if (splitDocked && isMobileViewport) return;

      const target = event.target as HTMLElement | null;
      if (
        target
        && (target.tagName === 'INPUT'
          || target.tagName === 'TEXTAREA'
          || target.tagName === 'SELECT'
          || target.isContentEditable
          || (typeof target.closest === 'function'
            && target.closest('[contenteditable]:not([contenteditable="false"]), [role="textbox"]')))
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
    },
    [
      currentItem,
      handleExitRequest,
      handleRate,
      handleReveal,
      handleRevealAnchor,
      handleToggleOption,
      isMobileViewport,
      phase.kind,
      primarySourceAnchor,
      revealed,
      splitDocked,
      submittingRating,
      suggestedRating,
    ],
  );

  useEventRegistry(
    phase.kind !== 'settled'
      ? [{ target: 'window', type: 'keydown', listener: onWindowKeyDown }]
      : [],
    [phase.kind, onWindowKeyDown],
  );

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

  const content = splitDocked && isMobileViewport && phase.kind === 'active' && currentItem ? (
    <div
      role="region"
      aria-label={t('examSprint.player.dialogLabel')}
      data-testid="unified-daily-sprint-player"
      data-split-docked="true"
      data-mobile-docked="true"
      style={{
        zIndex: Z_INDEX.modal,
        bottom:
          'calc(0.75rem + max(var(--mobile-safe-area-bottom, env(safe-area-inset-bottom, 0px)), var(--keyboard-inset, 0px)))',
      }}
      className="fixed inset-x-3 flex items-center justify-between gap-2 rounded-2xl border border-primary/35 bg-background/95 px-3 py-2 shadow-2xl backdrop-blur-md"
    >
      <button
        type="button"
        data-testid="sprint-return-from-source"
        onClick={() => setSplitDocked(false)}
        className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 rounded-xl px-1.5 text-left text-xs font-medium text-foreground transition-colors active:opacity-80"
      >
        <ArrowUUpLeft size={15} weight="bold" className="shrink-0 text-primary" aria-hidden="true" />
        <span className="truncate">
          {dockReason === 'ai'
            ? t('examSprint.player.viewingAiReturn', { defaultValue: '正在向 AI 提问 · 回到冲刺' })
            : t('examSprint.player.viewingSourceReturn', { defaultValue: '正在查看来源 · 回到冲刺' })}
        </span>
        <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-muted-foreground">
          {cursor + 1} / {queue.length}
        </span>
      </button>
      <DsButton
        type="button"
        variant="ghost"
        iconOnly
        data-testid="sprint-player-exit"
        aria-label={t('examSprint.player.exitLabel')}
        onClick={handleExitRequest}
        className="min-h-[44px] min-w-[44px] shrink-0 rounded-lg active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100"
      >
        <X size={16} aria-hidden="true" />
      </DsButton>
    </div>
  ) : (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('examSprint.player.dialogLabel')}
      data-testid="unified-daily-sprint-player"
      data-split-docked={splitDocked ? 'true' : undefined}
      style={{
        zIndex: Z_INDEX.modal,
        paddingBottom: 'var(--keyboard-inset, 0px)',
      }}
      className={cn(
        'fixed inset-0 z-modal flex flex-col bg-background/95 backdrop-blur-sm transition-all motion-reduce:transition-none',
        splitDocked && 'sm:left-auto sm:w-[min(560px,50vw)] sm:border-l sm:border-border/35 sm:shadow-2xl',
      )}
    >
      {isMobileViewport ? (
        <div className="shrink-0 border-b border-border/35 bg-background/85">
          <UnifiedMobileHeader
            className="relative shrink-0"
            progressiveBlur={false}
            configOverride={{
              showBackArrow: true,
              onMenuClick: handleExitRequest,
              title: phase.kind === 'active' && currentItem ? modalityBadgeLabel : t('examSprint.player.dialogLabel'),
              titleNode:
                phase.kind === 'active' && currentItem && activePlan ? (
                  <div className="flex max-w-full items-center justify-center gap-1.5 text-xs">
                    <span
                      key={`${currentItem.kind}:${currentItem.kind === 'mistake_question' && currentItem.isVariant ? 'variant' : 'base'}`}
                      data-testid="sprint-modality-badge"
                      className="truncate font-medium text-foreground"
                    >
                      {modalityBadgeLabel}
                    </span>
                    <span
                      data-testid="sprint-progress-ordinal"
                      className="shrink-0 font-mono tabular-nums text-muted-foreground"
                    >
                      {cursor + 1} / {queue.length}
                    </span>
                  </div>
                ) : undefined,
              rightActions:
                phase.kind === 'active' ? (
                  <span
                    data-testid="sprint-live-timer"
                    className="min-w-[44px] text-right font-mono text-xs tabular-nums text-muted-foreground"
                  >
                    {formatElapsedTimerMmSs(elapsedSeconds)}
                  </span>
                ) : undefined,
            }}
          />
          {phase.kind === 'active' && currentItem && activePlan ? (
            <div className="px-4 pb-2">
              <div
                role="progressbar"
                aria-label={t('examSprint.player.progressAriaLabel')}
                aria-valuemin={0}
                aria-valuemax={queue.length}
                aria-valuenow={cursor}
                data-testid="sprint-progress-bar"
                className="h-1 w-full overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-standard motion-reduce:transition-none"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <header className="shrink-0 border-b border-border/35 bg-background/80">
          <div className="mx-auto flex h-14 max-w-4xl items-center justify-between gap-2 px-4">
            <div className="flex shrink-0 items-center gap-1">
              <DsButton
                type="button"
                variant="ghost"
                iconOnly
                data-testid="sprint-player-exit"
                aria-label={t('examSprint.player.exitLabel')}
                onClick={handleExitRequest}
                className="min-h-[44px] min-w-[44px] shrink-0 rounded-lg active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                <X size={18} aria-hidden="true" />
              </DsButton>

              {splitDocked && !isMobileViewport ? (
                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="sprint-restore-fullscreen"
                  onClick={() => setSplitDocked(false)}
                  className="min-h-[36px] shrink-0 gap-1.5 rounded-lg border border-border/35 bg-card/80 px-2.5 text-xs font-medium text-foreground hover:bg-muted/60"
                >
                  <ArrowsOutSimple size={14} aria-hidden="true" />
                  <span>{t('examSprint.player.restoreFullscreen', { defaultValue: '恢复全屏' })}</span>
                </DsButton>
              ) : null}
            </div>

            {phase.kind === 'active' && currentItem && activePlan ? (
              <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
                <div className="flex max-w-full flex-wrap items-center justify-center gap-1.5 text-xs">
                  <span
                    key={`${currentItem.kind}:${currentItem.kind === 'mistake_question' && currentItem.isVariant ? 'variant' : 'base'}`}
                    data-testid="sprint-modality-badge"
                    className="inline-flex items-center rounded-md border border-border/35 bg-card px-2 py-0.5 font-medium text-foreground animate-chat-fade-in motion-reduce:animate-none"
                  >
                    <span>{modalityBadgeLabel}</span>
                  </span>

                  {currentEntry?.requeuedOnce ? (
                    <span
                      data-testid="sprint-requeued-badge"
                      className="rounded-md border border-warning/30 bg-warning/10 px-2 py-0.5 text-2xs font-medium text-warning"
                    >
                      {t('examSprint.player.requeuedBadge')}
                    </span>
                  ) : null}

                  {resumedFromCheckpoint ? (
                    <span
                      data-testid="sprint-resumed-badge"
                      className="rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary"
                    >
                      {t('examSprint.player.resumedBadge', { defaultValue: '已续接进度' })}
                    </span>
                  ) : null}

                  {countdownBadge ? (
                    <span className="inline-flex items-center gap-1.5 rounded-md border border-border/35 bg-card/70 px-2 py-0.5 text-muted-foreground">
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

                <div
                  role="progressbar"
                  aria-label={t('examSprint.player.progressAriaLabel')}
                  aria-valuemin={0}
                  aria-valuemax={queue.length}
                  aria-valuenow={cursor}
                  data-testid="sprint-progress-bar"
                  className="h-1 w-full max-w-xs overflow-hidden rounded-full bg-muted"
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300 ease-standard motion-reduce:transition-none"
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
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        {phase.kind === 'loading' || phase.kind === 'settling' ? (
          <div className="flex h-full min-h-[260px] flex-col items-center justify-center gap-3 text-center">
            <CircleNotch
              size={24}
              className="animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
            <p className="text-sm text-muted-foreground">
              {phase.kind === 'settling'
                ? t('examSprint.settlement.settling')
                : t('examSprint.player.loading')}
            </p>
          </div>
        ) : phase.kind === 'error' ? (
          <div className="mx-auto flex h-full min-h-[260px] max-w-md flex-col items-center justify-center gap-3 text-center">
            <WarningCircle size={26} className="text-warning" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">
              {t('examSprint.player.loadFailed')}
            </p>
            <p className="break-words text-xs text-muted-foreground">{phase.message}</p>
            <div className="mt-1 flex items-center gap-2">
              <DsButton
                type="button"
                variant="primary"
                onClick={() => {
                  if (phase.settlementRetry) {
                    void runSettlement(phase.settlementRetry.plan, phase.settlementRetry.records);
                  } else {
                    setReloadNonce((n) => n + 1);
                  }
                }}
                className="!h-auto min-h-[44px] gap-1.5 rounded-lg !border-transparent !bg-primary px-4 py-2 text-xs font-medium !text-primary-foreground hover:!bg-primary/90 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                <ArrowClockwise size={14} aria-hidden="true" />
                <span>{t('examSprint.player.retry')}</span>
              </DsButton>
              <DsButton
                type="button"
                variant="default"
                onClick={onClose}
                className="!h-auto min-h-[44px] rounded-lg px-4 py-2 text-xs font-medium active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                {t('examSprint.player.close')}
              </DsButton>
            </div>
          </div>
        ) : phase.kind === 'empty' ? (
          <div className="mx-auto flex h-full min-h-[260px] max-w-md flex-col items-center justify-center gap-3 text-center">
            <CheckCircle size={28} className="text-success" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">
              {t('examSprint.player.emptyTitle')}
            </p>
            <p className="text-xs text-muted-foreground">{t('examSprint.player.emptyHint')}</p>
            <DsButton
              type="button"
              variant="default"
              onClick={onClose}
              className="mt-1 !h-auto min-h-[44px] rounded-lg px-4 py-2 text-xs font-medium active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              {t('examSprint.player.close')}
            </DsButton>
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
          <div
            key={currentEntry?.entryKey ?? currentItem.sprintItemId}
            data-testid="sprint-stage-transition"
            data-item-kind={currentItem.kind}
            className="animate-chat-rise-in motion-reduce:animate-none"
          >
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
          </div>
        ) : null}
      </div>

      {phase.kind === 'active' && currentItem ? (
        <footer className="shrink-0 border-t border-border/35 bg-background/90 px-4 pt-2.5 pb-[max(0.75rem,var(--mobile-safe-area-bottom,env(safe-area-inset-bottom,0px)))]">
          <div className="mx-auto max-w-2xl">
            <div
              data-testid="sprint-card-toolbar"
              className="mb-2 flex flex-wrap items-center justify-between gap-1.5"
            >
              <div className="flex items-center gap-1.5">
                {undoStack.length > 0 ? (
                  <DsButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={submittingRating}
                    data-testid="sprint-undo-last"
                    onClick={handleUndo}
                    className="!h-auto min-h-[36px] gap-1.5 rounded-lg border border-border/35 bg-card/70 px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  >
                    <ArrowUUpLeft size={13} aria-hidden="true" />
                    <span>{t('examSprint.player.undoLast', { defaultValue: '撤销上一题' })}</span>
                  </DsButton>
                ) : null}
              </div>

              <div className="ml-auto flex items-center gap-1.5">
                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="sprint-tts-toggle"
                  aria-pressed={isSpeakingTts}
                  onClick={handleToggleTts}
                  className={cn(
                    '!h-auto min-h-[36px] gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors',
                    isSpeakingTts
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/35 bg-card/70 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {isSpeakingTts ? (
                    <StopCircle size={14} weight="bold" aria-hidden="true" />
                  ) : (
                    <SpeakerHigh size={14} aria-hidden="true" />
                  )}
                  <span>
                    {isSpeakingTts
                      ? t('examSprint.player.stopReading', { defaultValue: '停止朗读' })
                      : t('examSprint.player.readAloud', { defaultValue: '朗读' })}
                  </span>
                </DsButton>

                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="sprint-ask-ai"
                  onClick={handleAskAi}
                  className="!h-auto min-h-[36px] gap-1.5 rounded-lg border border-primary/30 bg-primary/[0.06] px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/[0.12]"
                >
                  <Sparkle size={13} weight="bold" aria-hidden="true" />
                  <span>{t('examSprint.player.askAiExplain', { defaultValue: '问 AI 讲透' })}</span>
                </DsButton>
              </div>
            </div>

            {!revealed ? (
              <DsButton
                type="button"
                variant="primary"
                data-testid="sprint-reveal-button"
                aria-keyshortcuts="Space"
                onClick={handleReveal}
                className="flex !h-auto min-h-[44px] max-sm:min-h-[48px] w-full items-center justify-center gap-2 rounded-lg !border-transparent !bg-primary px-4 py-2.5 text-sm font-medium !text-primary-foreground transition-all hover:!bg-primary/90 active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                <span>
                  {currentItem.kind === 'mistake_question'
                    ? getMistakeEffectiveOptionKeys(currentItem).length > 0
                      ? t('examSprint.player.checkAnswer')
                      : t('examSprint.player.revealAnalysis')
                    : t('examSprint.player.revealAnswer')}
                </span>
              </DsButton>
            ) : (
              <div
                className="grid grid-cols-4 gap-2 animate-chat-fade-in motion-reduce:animate-none"
                role="group"
                aria-label={t('rating.prompt')}
                data-testid="sprint-rating-bar"
              >
                {(
                  [
                    {
                      rating: 1 as const,
                      labelKey: 'examSprint.player.rating.again',
                      tone: 'destructive',
                      interactiveTone:
                        'hover:!border-destructive/40 hover:!bg-destructive/[0.08] hover:!text-destructive focus-visible:!text-destructive data-[pressed=true]:!border-destructive/45 data-[pressed=true]:!bg-destructive/[0.12] data-[pressed=true]:!text-destructive',
                    },
                    {
                      rating: 2 as const,
                      labelKey: 'examSprint.player.rating.hard',
                      tone: 'warning',
                      interactiveTone:
                        'hover:!border-warning/40 hover:!bg-warning/[0.10] hover:!text-warning focus-visible:!text-warning data-[pressed=true]:!border-warning/45 data-[pressed=true]:!bg-warning/[0.15] data-[pressed=true]:!text-warning',
                    },
                    {
                      rating: 3 as const,
                      labelKey: 'examSprint.player.rating.good',
                      tone: 'success',
                      interactiveTone:
                        'hover:!border-success/40 hover:!bg-success/[0.10] hover:!text-success focus-visible:!text-success data-[pressed=true]:!border-success/45 data-[pressed=true]:!bg-success/[0.15] data-[pressed=true]:!text-success',
                    },
                    {
                      rating: 4 as const,
                      labelKey: 'examSprint.player.rating.easy',
                      tone: 'info',
                      interactiveTone:
                        'hover:!border-info/40 hover:!bg-info/[0.10] hover:!text-info focus-visible:!text-info data-[pressed=true]:!border-info/45 data-[pressed=true]:!bg-info/[0.15] data-[pressed=true]:!text-info',
                    },
                  ] as const
                ).map(({ rating, labelKey, tone, interactiveTone }) => {
                  const isSuggested = suggestedRating === rating;
                  return (
                    <DsButton
                      key={rating}
                      type="button"
                      variant="ghost"
                      disabled={submittingRating}
                      data-testid={`sprint-rate-${rating}`}
                      data-suggested={isSuggested ? 'true' : undefined}
                      data-pressed={pressedRating === rating ? 'true' : undefined}
                      aria-keyshortcuts={isSuggested ? `${rating} Space` : String(rating)}
                      onClick={(event) => handleRateClick(rating, event)}
                      className={cn(
                        'flex !h-auto min-h-[44px] max-sm:min-h-[48px] flex-col items-center justify-center gap-0.5 rounded-lg border px-2 py-1.5 text-xs transition-all active:scale-[0.98] disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100',
                        isSuggested && tone === 'success'
                          && '!border-success/40 !bg-success/[0.10] !text-success',
                        isSuggested && tone === 'destructive'
                          && '!border-destructive/40 !bg-destructive/[0.10] !text-destructive',
                        !isSuggested && '!border-border/35 !bg-card !text-foreground',
                        interactiveTone,
                      )}
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        <kbd className="hidden font-mono text-2xs tabular-nums text-muted-foreground sm:inline">
                          {rating}
                        </kbd>
                        <span>{t(labelKey)}</span>
                      </span>
                      <span className="font-mono text-2xs tabular-nums text-muted-foreground">
                        {previewIntervals?.[rating] ?? ''}
                      </span>
                    </DsButton>
                  );
                })}
              </div>
            )}

            <div
              data-testid="sprint-shortcut-hint"
              aria-hidden="true"
              className="mt-2 hidden items-center justify-center gap-2 text-2xs text-muted-foreground/75 sm:flex"
            >
              {!revealed ? (
                currentItem.kind === 'mistake_question'
                && getMistakeEffectiveOptionKeys(currentItem).length > 0 ? (
                  <>
                    <span>
                      <kbd className="rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 font-mono text-2xs">
                        A–D
                      </kbd>{' '}
                      {t('examSprint.player.shortcutSelectOption')}
                    </span>
                    <span>·</span>
                    <span>
                      <kbd className="rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 font-mono text-2xs">
                        Space
                      </kbd>{' '}
                      {t('examSprint.player.shortcutCheck')}
                    </span>
                  </>
                ) : (
                  <span>
                    <kbd className="rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 font-mono text-2xs">
                      Space
                    </kbd>{' '}
                    {t('examSprint.player.shortcutReveal')}
                  </span>
                )
              ) : (
                <>
                  <span>{t('keyboard.ratingHint')}</span>
                  <span>·</span>
                  <span>{t('keyboard.spaceSuggested')}</span>
                </>
              )}
              {primarySourceAnchor ? (
                <>
                  <span>·</span>
                  <span>
                    <kbd className="rounded border border-border/50 bg-muted/40 px-1.5 py-0.5 font-mono text-2xs">
                      O
                    </kbd>{' '}
                    {t('examSprint.player.shortcutSource')}
                  </span>
                </>
              ) : null}
            </div>
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
