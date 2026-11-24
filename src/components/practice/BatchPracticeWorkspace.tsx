import React, { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  ArrowRight,
  BookmarkSimple,
  Check,
  CircleNotch,
  Eraser,
  ListNumbers,
  PaperPlaneRight,
  ArrowClockwise,
  PencilSimple,
  Sparkle,
  Star,
  X,
  Keyboard,
} from '@phosphor-icons/react';
import {
  practiceApi,
  newPracticeId,
  isAnswered,
  type CreatePracticeRequest,
  type PracticeDraft,
  type PracticeAttempt,
} from '@/api/practiceApi';
import { convertToApiQuestion } from '@/hooks/useQuestionBankSession';
import { isSubjectiveQuestionType, parseImageAnswerEnvelope } from '@/api/questionBankApi';
import { PracticeAnswerInput } from './PracticeAnswerInput';
import { DsButton } from '@/components/ui/DsButton';
import {
  DsDialog,
  DsDialogHeader,
  DsDialogTitle,
  DsDialogBody,
  DsDialogFooter,
} from '@/components/ui/DsDialog';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { MarkdownRenderer } from '@/features/chat/components/renderers';
import { QuestionMaterialView } from '@/components/QuestionMaterialView';
import { ImageAnswerDisplay } from '@/components/question-types/AnswerImageStrip';
import { loadQuestionImageUrls } from '@/components/questionImageLoader';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { formatTime } from '@/utils/formatUtils';
import { cn } from '@/lib/utils';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { setPracticeRuntime } from './practiceRuntime';
import { practiceAnswerText } from './practiceAnswerText';
import { paperAnswer } from './paperDocument';
import { GradingDiagnosticsView } from './GradingDiagnosticsView';
import { QuestionExplanation } from './QuestionExplanation';
import { QuestionFollowUpBar } from './QuestionFollowUpBar';
import { usePracticeShortcuts, type PracticeShortcutOptions } from './usePracticeShortcuts';
import { PracticeShortcutHints } from './PracticeShortcutHints';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';

function hasAnswer(raw: string | undefined): boolean {
  if (!isAnswered(raw)) return false;
  const envelope = parseImageAnswerEnvelope(raw);
  return envelope ? envelope.images.length > 0 || isAnswered(envelope.text) : true;
}

export interface BatchPracticeWorkspaceProps {
  request?: CreatePracticeRequest;
  practiceId?: string;
  submitted?: boolean;
  onBack: () => void;
  onChanged?: () => void;
  onFlushReady?: (flush: (() => Promise<void>) | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onNavigateReady?: (navigate: ((target: number | string) => Promise<void>) | null) => void;
  isActive?: boolean;
  readOnly?: boolean;
}

export default function BatchPracticeWorkspace({
  request,
  practiceId,
  submitted,
  onBack,
  onChanged,
  onFlushReady,
  onDirtyChange,
  onNavigateReady,
  isActive,
  readOnly = false,
}: BatchPracticeWorkspaceProps) {
  const { t } = useTranslation('practice');
  const { isSmallScreen } = useBreakpoint();
  const rootRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<PracticeDraft | null>(null);
  const draftRef = useRef<PracticeDraft | null>(null);
  const [attempt, setAttempt] = useState<PracticeAttempt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving' | 'error'>('saved');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const navigatingRef = useRef(false);
  const favoriteRef = useRef(false);
  const uploadingRef = useRef(false);
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState('all');
  const [tick, setTick] = useState(Date.now());
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const [aiFeedback, setAiFeedback] = useState<Record<string, string>>({});
  const [liveSourceAvailable, setLiveSourceAvailable] = useState<Record<string, boolean>>({});
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideScoreInput, setOverrideScoreInput] = useState('100');
  const runtimeKey = useRef(newPracticeId());
  const [images, setImages] = useState<Record<string, string>>({});
  const dirtyRef = useRef(false);
  const changeRef = useRef(0);
  const saveRef = useRef<Promise<void> | null>(null);
  const submitRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const mounted = useRef(true);
  const callbackRef = useRef(onChanged);
  callbackRef.current = onChanged;
  const dirtyCallbackRef = useRef(onDirtyChange);
  dirtyCallbackRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChange?.(saveState !== 'saved' || uploading);
  }, [onDirtyChange, saveState, uploading]);

  const flush = useCallback(async (): Promise<void> => {
    if (uploadingRef.current) throw new Error(t('batch.uploading'));
    if (saveRef.current) {
      await saveRef.current;
      if (dirtyRef.current) return flush();
      return;
    }
    const work = async () => {
      while (dirtyRef.current && draftRef.current) {
        const snapshot = draftRef.current;
        const generation = changeRef.current;
        if (mounted.current) setSaveState('saving');
        try {
          const saved = await practiceApi.save(snapshot);
          if (draftRef.current?.id !== snapshot.id) return;
          draftRef.current = {
            ...draftRef.current,
            revision: saved.revision,
            updated_at: saved.updated_at,
          };
          dirtyRef.current = changeRef.current !== generation;
          dirtyCallbackRef.current?.(dirtyRef.current);
          if (mounted.current) {
            setDraft(draftRef.current);
            setSaveState(dirtyRef.current ? 'dirty' : 'saved');
            setError(null);
          }
        } catch (error) {
          if (mounted.current) {
            setSaveState('error');
            setError(getErrorMessage(error));
          }
          throw error;
        }
      }
    };
    const promise = work();
    saveRef.current = promise;
    try {
      await promise;
    } finally {
      if (saveRef.current === promise) saveRef.current = null;
    }
  }, [t]);

  useEffect(() => {
    mounted.current = true;
    onFlushReady?.(async () => {
      if (submitRef.current || busyRef.current || navigatingRef.current) throw new Error(t('batch.busy'));
      await flush();
    });
    return () => {
      mounted.current = false;
      onFlushReady?.(null);
      void flush().catch(() => {});
    };
  }, [flush, onFlushReady, t]);

  useEventRegistry([{
    target: 'document',
    type: 'visibilitychange',
    listener: () => {
      if (document.visibilityState === 'hidden') void flush().catch(() => {});
    },
  }], [flush]);

  const installDraft = useCallback((next: PracticeDraft) => {
    draftRef.current = next;
    dirtyRef.current = false;
    changeRef.current = 0;
    setDraft(next);
    setAttempt(null);
    setIndex(next.current_index);
    setSaveState('saved');
    setError(null);
  }, []);

  const id = practiceId ?? request?.id;
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async () => {
      try {
        if (readOnly && !submitted) throw new Error(t('batch.readOnly'));
        if (submitted && id) {
          const next = await practiceApi.getAttempt(id);
          if (!cancelled) {
            setAttempt(next);
            setDraft(null);
            draftRef.current = null;
            setIndex(0);
          }
        } else {
          try {
            const next = request ? await practiceApi.create(request) : await practiceApi.getDraft(id!);
            if (!cancelled) installDraft(next);
          } catch (error) {
            if (!id) throw error;
            const completed = await practiceApi.getAttempt(id).catch(() => { throw error; });
            if (!cancelled) { setAttempt(completed); setDraft(null); draftRef.current = null; setIndex(0); }
          }
        }
        void practiceApi.resumeGrading().catch(() => {});
      } catch (error) {
        if (!cancelled) setError(getErrorMessage(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // Identity owns this surface; request object changes must not discard local input.
  }, [id, submitted, installDraft, readOnly]);

  useEffect(() => {
    if (!attempt) return;
    let stopped = false;
    const subscription = listen<string>('qbank-practice-updated', async (event) => {
      if (event.payload !== attempt.id) return;
      try {
        const updated = await practiceApi.getAttempt(attempt.id);
        if (!stopped) {
          setAttempt(updated);
          callbackRef.current?.();
        }
      } catch (error) {
        if (!stopped) setError(getErrorMessage(error));
      }
    });
    // Reconcile after subscribing: a fast objective/AI result may have arrived
    // between the submit response and the listener registration.
    void subscription.then(async () => {
      const updated = await practiceApi.getAttempt(attempt.id);
      if (!stopped) setAttempt(updated);
    }).catch(() => {});
    return () => {
      stopped = true;
      void subscription.then((unlisten) => unlisten());
    };
  }, [attempt?.id]);

  useEffect(() => {
    if (!dirtyRef.current) return;
    const timer = setTimeout(() => void flush().catch(() => {}), 300);
    return () => clearTimeout(timer);
  }, [draft, flush]);

  const change = (patch: Partial<PracticeDraft>) => {
    if (!draftRef.current || submitRef.current || readOnly ||
      (draftRef.current.deadline && Date.parse(draftRef.current.deadline) <= Date.now())) return;
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    changeRef.current += 1;
    dirtyRef.current = true;
    setDraft(next);
    setSaveState('dirty');
  };

  useEffect(() => {
    if (!draft) return;
    const timer = setInterval(() => {
      setTick(Date.now());
      if (
        isActive !== false &&
        !draftRef.current?.deadline &&
        draftRef.current &&
        !submitRef.current
      ) {
        const next = { ...draftRef.current, elapsed_seconds: draftRef.current.elapsed_seconds + 1 };
        draftRef.current = next;
        dirtyRef.current = true;
        changeRef.current += 1;
        // Persist the stopwatch periodically without delaying answer saves.
        if (next.elapsed_seconds % 10 === 0) void flush().catch(() => {});
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [draft?.id, isActive, flush]);

  const submit = useCallback(async () => {
    if (!draftRef.current || submitRef.current || uploading) return;
    submitRef.current = true;
    setBusy(true);
    setConfirmOpen(false);
    try {
      const cleanEntries = Object.entries(draftRef.current.answers).filter(([, raw]) => hasAnswer(raw));
      if (cleanEntries.length !== Object.keys(draftRef.current.answers).length) {
        draftRef.current = {
          ...draftRef.current,
          answers: Object.fromEntries(cleanEntries),
        };
        changeRef.current += 1;
        dirtyRef.current = true;
        setDraft(draftRef.current);
      }
      await flush();
      const latest = draftRef.current!;
      const result = await practiceApi.submit(latest.id, latest.revision);
      dirtyRef.current = false;
      draftRef.current = null;
      setDraft(null);
      setAttempt(result);
      setSaveState('saved');
      dirtyCallbackRef.current?.(false);
      setIndex(0);
      setFilter('all');
      setError(null);
      callbackRef.current?.();
      showGlobalNotification('success', t('batch.submitted'));
    } catch (error) {
      // The deadline task can commit before this surface flushes its last position.
      // Reconcile a clean draft; keep locally unsaved answers visible on conflict.
      const id = draftRef.current?.id;
      const completed = id && !dirtyRef.current
        ? await practiceApi.getAttempt(id).catch(() => null)
        : null;
      if (completed) {
        draftRef.current = null;
        setDraft(null);
        setAttempt(completed);
        setSaveState('saved');
        dirtyCallbackRef.current?.(false);
        setError(null);
      } else setError(getErrorMessage(error));
    } finally {
      submitRef.current = false;
      setBusy(false);
    }
  }, [flush, uploading, t]);
  const submitLatest = useRef(submit);
  submitLatest.current = submit;
  const expiredRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      draft?.deadline &&
      Date.parse(draft.deadline) <= tick &&
      !uploading &&
      expiredRef.current !== draft.id
    ) {
      expiredRef.current = draft.id;
      void submitLatest.current();
    }
  }, [draft?.id, draft?.deadline, tick, uploading]);

  const leave = useCallback(async () => {
    if (uploading || busy) return;
    try {
      await flush();
      onBack();
    } catch {
      /* Keep the unsaved answers visible. */
    }
  }, [flush, onBack, uploading, busy]);
  useEffect(() => {
    if (isActive === false) return;
    return registerBackHandler(() => {
      if (sheetOpen) setSheetOpen(false);
      else if (confirmOpen) setConfirmOpen(false);
      else void leave();
      return true;
    }, BACK_PRIORITY.view);
  }, [isActive, sheetOpen, confirmOpen, leave]);

  const questions = attempt?.questions ?? draft?.questions ?? [];
  const current = questions[index];
  const results = attempt?.results ?? [];
  const result = results.find((r) => r.question_id === current?.id);
  const canLoadAnalysis = Boolean(attempt && result?.source_available === true && !readOnly);
  const canAnalyze = Boolean(canLoadAnalysis && current && liveSourceAvailable[current.id] === true);
  useEffect(() => {
    if (!current || readOnly || result?.source_available === false) return;
    let cancelled = false;
    void invoke<{ is_favorite: boolean; ai_feedback?: string | null } | null>('qbank_get_question', { questionId: current.id })
      .then((live) => {
        if (cancelled) return;
        if (live) setFavorites((values) => ({ ...values, [current.id]: live.is_favorite }));
        if (canLoadAnalysis) {
          setLiveSourceAvailable((values) => ({ ...values, [current.id]: Boolean(live) }));
          setAiFeedback((values) => ({ ...values, [current.id]: live?.ai_feedback ?? '' }));
        }
      }).catch(() => {
        if (!cancelled && canLoadAnalysis) {
          setLiveSourceAvailable((values) => ({ ...values, [current.id]: false }));
        }
      });
    return () => { cancelled = true; };
  }, [current?.id, readOnly, result?.source_available, canLoadAnalysis]);
  const refreshExplanation = useCallback(async (questionId: string) => {
    const live = await invoke<{ ai_feedback?: string | null } | null>('qbank_get_question', { questionId });
    if (mounted.current) {
      setLiveSourceAvailable((values) => ({ ...values, [questionId]: Boolean(live) }));
      setAiFeedback((values) => ({ ...values, [questionId]: live?.ai_feedback ?? '' }));
      callbackRef.current?.();
    }
  }, []);
  useEffect(() => {
    setOverrideOpen(false);
  }, [current?.id, attempt?.id]);
  useEffect(() => {
    let cancelled = false;
    if (!current) return;
    void loadQuestionImageUrls(
      (current.images ?? []).filter((image) => image.role !== 'source'),
    ).then((next) => {
      if (!cancelled) setImages(next);
    });
    return () => {
      cancelled = true;
    };
  }, [current?.id]);
  const answers = attempt?.answers ?? draft?.answers ?? {};
  const marked = attempt?.marked_ids ?? draft?.marked_ids ?? [];
  const answeredCount = questions.filter((q) => hasAnswer(answers[q.id])).length;
  const unansweredCount = questions.length - answeredCount;
  const firstUnansweredIndex = questions.findIndex((q) => !hasAnswer(answers[q.id]));
  const correctCount = results.filter(
    (r) => r.status === 'correct' || (r.status !== 'partial' && r.is_correct === true),
  ).length;
  const partialCount = results.filter((r) => r.status === 'partial').length;
  const wrongCount = results.filter(
    (r) =>
      r.status === 'incorrect'
      || (r.status !== 'partial'
        && r.status !== 'unanswered'
        && r.status !== 'pending'
        && r.status !== 'failed'
        && r.is_correct === false),
  ).length;
  const unansweredResultCount = results.filter((r) => r.status === 'unanswered').length;
  const pendingCount = results.filter((r) => r.status === 'pending' || r.status === 'failed').length;
  const hasPartialScores = partialCount > 0 || results.some(
    (r) => typeof r.score === 'number' && r.score > 0 && r.score < 100,
  );
  const totalEarnedScorePercent =
    results.length > 0
      ? Math.round(
          (results.reduce(
            (sum, r) =>
              sum +
              (typeof r.score === 'number'
                ? r.score / 100
                : r.status === 'correct' || r.is_correct === true
                  ? 1
                  : 0),
            0,
          ) /
            results.length) *
            100,
        )
      : 0;
  const fullCorrectRatePercent =
    results.length > 0 ? Math.round((correctCount / results.length) * 100) : 0;
  const filteredIndices = questions.flatMap((q, i) => {
    const r = results.find((r) => r.question_id === q.id);
    return filter === 'all' ||
      (filter === 'wrong' && (r?.status === 'incorrect' || r?.status === 'partial')) ||
      (filter === 'unanswered' && r?.status === 'unanswered') ||
      (filter === 'pending' && (r?.status === 'pending' || r?.status === 'failed'))
      ? [i]
      : [];
  });
  const position = filteredIndices.indexOf(index);
  const previousIndex = filteredIndices[Math.max(0, position) - 1];
  const nextIndex = filteredIndices[position + 1];
  const navigate = async (next: number) => {
    if (uploadingRef.current || busy || submitRef.current || navigatingRef.current ||
      next < 0 || next >= questions.length ||
      (draftRef.current?.deadline && Date.parse(draftRef.current.deadline) <= Date.now())) return false;
    navigatingRef.current = true;
    setNavigating(true);
    const draftId = draftRef.current?.id;
    try {
      if (draftRef.current) {
        change({ current_index: next });
        await flush();
      }
      if (submitRef.current || !mounted.current || (draftId && draftRef.current?.id !== draftId)) return false;
      setIndex(next);
      return true;
    } catch {
      // Failed navigation must not resume at a question the user never reached.
      if (draftRef.current) change({ current_index: index });
      setSaveState('error');
      return false;
    } finally {
      navigatingRef.current = false;
      if (mounted.current) setNavigating(false);
    }
  };
  const navigationRef = useRef(navigate);
  navigationRef.current = navigate;
  const questionsRef = useRef(questions);
  questionsRef.current = questions;
  const indexRef = useRef(index);
  indexRef.current = index;
  useEffect(() => {
    onNavigateReady?.(async (target) => {
      const next =
        typeof target === 'string'
          ? questionsRef.current.findIndex((q) => q.id === target)
          : indexRef.current + target;
      if (next < 0 || !await navigationRef.current(next)) throw new Error(t('batch.navigationFailed'));
    });
    return () => {
      onNavigateReady?.(null);
    };
  }, [onNavigateReady]);
  useEffect(() => {
    const session = attempt ?? draft;
    if (!session) return;
    const key = runtimeKey.current;
    setPracticeRuntime(key, {
      id: session.id,
      examId: session.scope_id,
      mode: session.mode,
      gradingMode: 'on_submit',
      questionCount: questions.length,
      answeredCount,
      currentQuestionId: current?.id ?? null,
      isSubmitted: Boolean(attempt),
      scoreSummary: attempt
        ? {
            correctCount: results.filter((r) => r.is_correct === true).length,
            wrongCount: results.filter((r) => r.is_correct === false).length,
            unansweredCount: results.filter((r) => r.status === 'unanswered').length,
            pendingCount: results.filter((r) => r.status === 'pending' || r.status === 'failed')
              .length,
          }
        : null,
    });
    return () => setPracticeRuntime(key, null);
  }, [attempt, draft, questions, answers, current?.id, results]);
  const elapsed = draft?.deadline
    ? Math.max(0, Math.ceil((Date.parse(draft.deadline) - tick) / 1000))
    : (draftRef.current?.elapsed_seconds ?? attempt?.elapsed_seconds ?? 0);
  const imageAnswer = parseImageAnswerEnvelope(answers[current?.id] ?? '');
  const question = current
    ? convertToApiQuestion({
        ...current,
        options: current.options ?? [],
        answer: current.answer ?? '',
        explanation: current.explanation ?? '',
        difficulty: current.difficulty ?? 'medium',
        user_answer: '',
        user_note: '',
        is_correct: null,
        last_attempt_at: null,
        images: current.images ?? [],
      })
    : null;

  const changeAnswer = (value: string) => {
    const latest = draftRef.current;
    if (!latest || !current) return;
    change({
      answers: hasAnswer(value)
        ? { ...latest.answers, [current.id]: value }
        : Object.fromEntries(Object.entries(latest.answers).filter(([id]) => id !== current.id)),
    });
  };
  const toggleFavorite = async () => {
    if (!current || readOnly || busy || favoriteRef.current || result?.source_available === false) return;
    favoriteRef.current = true;
    setBusy(true);
    try {
      const updated = await invoke<{ is_favorite: boolean }>('qbank_toggle_favorite', { questionId: current.id });
      setFavorites(values => ({ ...values, [current.id]: updated.is_favorite }));
      callbackRef.current?.();
    } catch (error) { setError(getErrorMessage(error)); }
    finally { favoriteRef.current = false; setBusy(false); }
  };
  const shortcutOptions: PracticeShortcutOptions = {
    enabled: !isSmallScreen && isActive !== false && !loading && !!current && !busy && !uploading && !navigating && !confirmOpen &&
      !(draft?.deadline && Date.parse(draft.deadline) <= tick),
    rootRef,
    optionKeys: question?.options?.map(option => option.key),
    primaryLabel: attempt ? 'editor.nextQuestion' : 'batch.shortcutSaveNext',
    actions: {
      previous: previousIndex != null ? () => { void navigate(previousIndex); } : undefined,
      next: nextIndex != null ? () => { void navigate(nextIndex); } : undefined,
      primary: !attempt || nextIndex != null ? () => { void navigate(nextIndex ?? index); } : undefined,
      favorite: !readOnly && result?.source_available !== false ? () => { void toggleFavorite(); } : undefined,
      ...(!attempt && !readOnly ? {
        selectOption: question && ['single_choice', 'multiple_choice', 'indefinite_choice'].includes(question.questionType) ? (key: string) => {
          if (question.questionType === 'single_choice') changeAnswer(key);
          else {
            const selected = new Set((draftRef.current?.answers[question.id] ?? '').split(''));
            if (selected.has(key)) selected.delete(key); else selected.add(key);
            changeAnswer([...selected].sort().join(''));
          }
        } : undefined,
        selectTrueFalse: question?.questionType === 'true_false' ? changeAnswer : undefined,
      } : {}),
    },
  };
  const onAnswerPrimaryAction = usePracticeShortcuts(shortcutOptions);

  const sheet = (
    <div className="space-y-3">
      <div className="flex items-center justify-between font-mono text-xs tabular-nums text-muted-foreground">
        <span>
          {t('batch.progress', { answered: answeredCount, total: questions.length })}
        </span>
        <span>
          {t('batch.unansweredCount', { count: unansweredCount })}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
        {!attempt ? (
          <>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-primary/70" aria-hidden="true" />
              {t('answerSheet.answered')}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm border border-border bg-muted/70" aria-hidden="true" />
              {t('answerSheet.unanswered')}
            </span>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-success/75" aria-hidden="true" />
              {t('editor.correct')}
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-destructive/75" aria-hidden="true" />
              {t('editor.wrong')}
            </span>
            {results.some((r) => r.status === 'unanswered') && (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm border border-border bg-muted/70" aria-hidden="true" />
                {t('answerSheet.unanswered')}
              </span>
            )}
          </>
        )}
        {marked.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <BookmarkSimple size={11} weight="fill" className="text-warning" aria-hidden="true" />
            {t('answerSheet.marked')}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(40px,1fr))] gap-1.5">
        {filteredIndices.map((i) => {
          const q = questions[i];
          const r = results.find((r) => r.question_id === q.id);
          return (
            <DsButton
              key={q.id}
              variant="ghost"
              size="sm"
              aria-label={t('answerSheet.jumpTo', { index: i + 1 })}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => {
                void navigate(i);
                setSheetOpen(false);
              }}
              className={cn(
                'ui-press relative min-h-[var(--touch-target-size)] sm:min-h-9 !min-w-9 !px-0 !rounded-lg border border-border/45 bg-foreground/[0.02] font-mono text-xs tabular-nums text-muted-foreground transition-colors motion-reduce:transition-none hover:bg-foreground/[0.05] hover:text-foreground',
                hasAnswer(answers[q.id]) && !attempt && 'border-primary/40 bg-primary/[0.08] text-primary',
                r?.is_correct === true && 'border-success/40 bg-success/[0.08] text-success',
                r?.is_correct === false && 'border-destructive/35 bg-destructive/[0.06] text-destructive',
                (r?.status === 'pending' || r?.status === 'failed') &&
                  'border-warning/40 bg-warning/[0.08] text-warning',
                index === i && 'ring-2 ring-primary bg-primary/[0.10] text-foreground font-semibold',
              )}
            >
              {i + 1}
              {marked.includes(q.id) && (
                <BookmarkSimple
                  size={10}
                  weight="fill"
                  className="absolute right-0.5 top-0.5 text-warning"
                />
              )}
            </DsButton>
          );
        })}
      </div>
    </div>
  );

  if (loading)
    return (
      <div className="flex h-full items-center justify-center">
        <CircleNotch className="animate-spin" size={24} />
      </div>
    );
  if (!current || !question)
    return (
      <div className="space-y-3 p-4">
        <p role="alert">{error ?? t('batch.noQuestions')}</p>
        <DsButton variant="outline" onClick={onBack}>
          <ArrowLeft size={16} />
          {t('common:back')}
        </DsButton>
      </div>
    );

  return (
    <div ref={rootRef} data-practice-shortcuts className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/35 bg-background/95 px-3 py-1.5 backdrop-blur-sm">
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={t('common:back')}
          title={t('common:back')}
          disabled={busy || uploading}
          onClick={() => void leave()}
          className="!h-9 !w-9 sm:!h-7 sm:!w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
        </DsButton>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {attempt?.title ?? draft?.title}
        </span>
        {attempt && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span
              data-testid="batch-total-score-summary"
              className="inline-flex items-center gap-1 font-mono font-semibold tabular-nums text-primary"
            >
              {hasPartialScores
                ? t('batch.totalScoreSummaryPartial', {
                    defaultValue: '综合得分 {{score}}分 · 得分率 {{rate}}%（满分率 {{fullRate}}%）',
                    score: totalEarnedScorePercent,
                    rate: totalEarnedScorePercent,
                    fullRate: fullCorrectRatePercent,
                  })
                : t('batch.totalScoreSummary', {
                    defaultValue: '得分 {{score}}分 · 准确率 {{rate}}%',
                    score: totalEarnedScorePercent,
                    rate: fullCorrectRatePercent,
                  })}
            </span>
            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-foreground/85">
              <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
              {t('batch.correctCount', { count: correctCount })}
            </span>
            {partialCount > 0 && (
              <span className="inline-flex items-center gap-1 font-mono tabular-nums text-foreground/85">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
                {t('batch.partialCount', { defaultValue: '部分正确 {{count}} 题', count: partialCount })}
              </span>
            )}
            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-foreground/85">
              <span className="h-1.5 w-1.5 rounded-full bg-destructive" aria-hidden="true" />
              {t('batch.wrongCount', { count: wrongCount })}
            </span>
            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/35" aria-hidden="true" />
              {t('batch.unansweredCount', { count: unansweredResultCount })}
            </span>
            <span className="inline-flex items-center gap-1 font-mono tabular-nums text-foreground/85">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
              {t('batch.pendingCount', { count: pendingCount })}
            </span>
            <select
              aria-label={t('batch.filter')}
              value={filter}
              onChange={(event) => {
                const next = event.target.value;
                setFilter(next);
                const first = results.findIndex(
                  (r) =>
                    next === 'all' ||
                    (next === 'wrong' && (r.status === 'incorrect' || r.status === 'partial')) ||
                    (next === 'pending' && (r.status === 'pending' || r.status === 'failed')) ||
                    (next === 'unanswered' && r.status === 'unanswered'),
                );
                if (first >= 0) setIndex(first);
              }}
              className="h-9 sm:h-7 [@media(pointer:coarse)]:h-11 rounded-md border border-border/50 bg-background px-2 text-xs text-foreground"
            >
              {['all', 'wrong', 'unanswered', 'pending'].map((f) => (
                <option key={f} value={f}>
                  {t(`batch.filters.${f}`)}
                </option>
              ))}
            </select>
          </div>
        )}
        <span
          className={cn(
            'rounded-md bg-foreground/[0.04] px-2 py-0.5 font-mono text-xs tabular-nums',
            draft?.deadline && elapsed > 0 && elapsed <= 60
              ? 'text-destructive'
              : draft?.deadline && elapsed > 0 && elapsed <= 300
                ? 'text-warning'
                : 'text-muted-foreground',
          )}
        >
          {formatTime(elapsed)}
        </span>
        {!isSmallScreen && (
          <Popover>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <DsButton variant="ghost" size="icon" iconOnly aria-label={t('editor.shortcuts')} className="!h-7 !w-7 text-muted-foreground hover:text-foreground">
                    <Keyboard size={16} />
                  </DsButton>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t('editor.shortcuts')}</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-72" align="end">
              <PracticeShortcutHints {...shortcutOptions} />
            </PopoverContent>
          </Popover>
        )}
        {!attempt && (
          <span
            role="status"
            className={cn(
              'text-xs',
              saveState === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {t(`batch.save.${saveState}`)}
          </span>
        )}
        <DsButton variant="ghost" size="sm" onClick={() => setSheetOpen(!sheetOpen)} className="!h-9 sm:!h-7 [@media(pointer:coarse)]:!h-11 !px-2.5 text-xs text-muted-foreground hover:text-foreground">
          <ListNumbers size={15} />
          {t('batch.answerSheet')}
        </DsButton>
        {!attempt && (
          <DsButton size="sm" disabled={busy || uploading} onClick={() => setConfirmOpen(true)} className="!h-9 sm:!h-7 [@media(pointer:coarse)]:!h-11 !px-2.5 text-xs">
            {busy ? (
              <CircleNotch size={14} className="animate-spin" />
            ) : (
              <PaperPlaneRight size={14} />
            )}
            {t('batch.submit')}
          </DsButton>
        )}
        {attempt && !readOnly && (
          <DsButton
            variant="outline"
            size="sm"
            disabled={busy}
            className="!h-9 sm:!h-7 [@media(pointer:coarse)]:!h-11 !px-2.5 text-xs"
            onClick={async () => {
              setBusy(true);
              try {
                const next = await practiceApi.create({
                  id: newPracticeId(),
                  scope_id: attempt.scope_id,
                  title: attempt.title,
                  mode: attempt.mode,
                  question_ids: [],
                  attempt_id: attempt.id,
                  paper_id: attempt.paper_id ?? undefined,
                  duration_seconds: attempt.duration_seconds ?? undefined,
                });
                installDraft(next);
                callbackRef.current?.();
              } catch (error) {
                setError(getErrorMessage(error));
              } finally {
                setBusy(false);
              }
            }}
          >
            <ArrowClockwise size={14} />
            {t('batch.restart')}
          </DsButton>
        )}
      </div>
      {/* 2px 顶部细进度线 */}
      <div className="h-0.5 flex-shrink-0 bg-border/40" aria-hidden="true">
        <div
          className="h-full bg-primary transition-[width] duration-300 ease-out"
          style={{ width: `${questions.length > 0 ? ((index + 1) / questions.length) * 100 : 0}%` }}
        />
      </div>
      {error && (
        <div
          className="flex flex-wrap items-center gap-2 border-b border-border/40 bg-muted/50 px-4 py-2 text-xs text-destructive"
          role="alert"
        >
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          {draft && (
            <DsButton variant="outline" size="sm" onClick={() => void flush().catch(() => {})} className="!h-7 !px-2.5 text-xs">
              <ArrowClockwise size={14} />
              {t('common:actions.retry')}
            </DsButton>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <CustomScrollArea className="min-w-0 flex-1" viewportClassName="px-4 py-6 sm:px-8 sm:py-8">
          <div className="mx-auto max-w-3xl space-y-6">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-medium tabular-nums text-muted-foreground">
                {index + 1} / {questions.length}
              </span>
              <span className="rounded-md bg-foreground/[0.04] px-2 py-0.5 text-xs text-muted-foreground">
                {t(`questionType.${question.questionType}`)}
              </span>
              {!readOnly && result?.source_available !== false && (
                <DsButton variant="ghost" size="icon" iconOnly
                  aria-label={t('editor.favorite')} title={t('editor.favorite')}
                  aria-pressed={favorites[question.id] ?? current.is_favorite}
                  disabled={busy}
                  onClick={() => void toggleFavorite()}
                  className="!h-9 !w-9 sm:!h-7 sm:!w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground hover:text-foreground">
                  <Star size={15} weight={(favorites[question.id] ?? current.is_favorite) ? 'fill' : 'regular'} className={(favorites[question.id] ?? current.is_favorite) ? 'text-warning' : undefined} />
                </DsButton>
              )}
              {!attempt && (
                <DsButton
                  variant="ghost"
                  size="sm"
                  aria-pressed={marked.includes(question.id)}
                  onClick={() =>
                    change({
                      marked_ids: marked.includes(question.id)
                        ? marked.filter((id) => id !== question.id)
                        : [...marked, question.id],
                    })
                  }
                  className={cn(
                    '!h-9 sm:!h-7 [@media(pointer:coarse)]:!h-11 !px-2 text-xs',
                    marked.includes(question.id) ? 'text-warning' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <BookmarkSimple
                    size={15}
                    weight={marked.includes(question.id) ? 'fill' : 'regular'}
                  />
                  {t('batch.mark')}
                </DsButton>
              )}
            </div>
            {!!question.materials?.length && (
              <QuestionMaterialView materials={question.materials} />
            )}
            <div className="max-w-[74ch] text-[16px] sm:text-[17px] leading-[1.72] text-foreground">
              <MarkdownRenderer content={question.content} />
            </div>
            {(current.images ?? [])
              .filter((image) => image.role !== 'source')
              .map((image) =>
                images[image.id] && images[image.id] !== 'error' ? (
                  <img
                    key={image.id}
                    src={images[image.id]}
                    alt={image.name}
                    className="max-h-[600px] max-w-full rounded-lg border border-border/40 object-contain"
                  />
                ) : (
                  <p key={image.id} className="text-sm text-destructive">
                    {t('batch.imageMissing')}
                  </p>
                ),
              )}
          {attempt &&
            (question.questionType === 'single_choice' ||
              question.questionType === 'multiple_choice' ||
              question.questionType === 'indefinite_choice' ||
              (question.questionType === 'other' &&
                Boolean(question.options?.some((opt) => opt.content?.trim())))) &&
            !!question.options?.length && (
            <div className="space-y-2.5">
              {question.options.map((option) => {
                const userSelected = (answers[question.id] ?? '').includes(option.key);
                const isOptionCorrect = (question.answer ?? '').toUpperCase().includes(option.key.toUpperCase());
                const isMulti = question.questionType === 'multiple_choice' || question.questionType === 'indefinite_choice';
                return (
                  <div
                    key={option.key}
                    className={cn(
                      'flex items-start gap-3 rounded-xl border px-4 py-3 text-sm transition-colors motion-reduce:transition-none',
                      isOptionCorrect
                        ? 'border-success/45 bg-success/[0.07]'
                        : userSelected
                          ? 'border-destructive/40 bg-destructive/[0.06]'
                          : 'border-border/45 bg-card/60',
                    )}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border font-mono text-xs font-medium',
                        isMulti ? 'rounded-md' : 'rounded-full',
                        isOptionCorrect
                          ? 'border-success bg-success text-success-foreground'
                          : userSelected
                            ? 'border-destructive bg-destructive text-destructive-foreground'
                            : 'border-border/60 bg-background/80 text-muted-foreground',
                      )}
                    >
                      {option.key}
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5 leading-relaxed">
                      <MarkdownRenderer content={option.content} />
                    </div>
                    <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                      {userSelected && (
                        <span
                          className={cn(
                            'rounded-pill px-2 py-0.5 text-2xs font-medium',
                            isOptionCorrect
                              ? 'bg-success/15 text-success'
                              : 'bg-destructive/15 text-destructive',
                          )}
                        >
                          {t('batch.selectedOption')}
                        </span>
                      )}
                      {isOptionCorrect ? (
                        <Check size={16} weight="bold" className="text-success" aria-hidden="true" />
                      ) : userSelected ? (
                        <X size={16} weight="bold" className="text-destructive" aria-hidden="true" />
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!attempt ? (
              <>
                <fieldset
                  disabled={busy || uploading || navigating || Boolean(draft?.deadline && Date.parse(draft.deadline) <= tick)}
                >
                  <PracticeAnswerInput
                    key={question.id}
                    question={question}
                    value={answers[question.id] ?? ''}
                    onPrimaryAction={onAnswerPrimaryAction}
                    onUploadingChange={(value) => {
                      uploadingRef.current = value;
                      setUploading(value);
                    }}
                    onChange={changeAnswer}
                  />
                </fieldset>
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={busy || uploading || !hasAnswer(answers[question.id])}
                  onClick={() =>
                    change({
                      answers: Object.fromEntries(
                        Object.entries(answers).filter(([id]) => id !== question.id),
                      ),
                    })
                  }
                >
                  <Eraser size={16} />
                  {t('batch.clear')}
                </DsButton>
              </>
            ) : (
              <div className="ui-rise-in motion-reduce:animate-none space-y-4 border-t border-border/45 pt-4">
                <div
                  className={cn(
                    'flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm font-medium',
                    result?.is_correct === true
                      ? 'border-success/35 bg-success/[0.07] text-success'
                      : result?.is_correct === false
                        ? 'border-destructive/30 bg-destructive/[0.05] text-destructive'
                        : result?.status === 'unanswered'
                          ? 'border-border/50 bg-muted/40 text-muted-foreground'
                          : 'border-warning/35 bg-warning/[0.07] text-warning',
                  )}
                >
                  {result?.is_correct === true ? (
                    <Check size={16} weight="bold" className="shrink-0" aria-hidden="true" />
                  ) : result?.is_correct === false ? (
                    <X size={16} weight="bold" className="shrink-0" aria-hidden="true" />
                  ) : result?.status === 'pending' ? (
                    <CircleNotch size={15} className="shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : null}
                  <span>
                    {t(`batch.result.${result?.status ?? 'pending'}`)}
                    {result?.score != null && ` · ${result.score}/100`}
                  </span>
                </div>
                {result && (!result.source_available || liveSourceAvailable[question.id] === false) && (
                  <p className="text-xs text-muted-foreground">{t('batch.sourceUnavailable')}</p>
                )}
                <div className={cn(!imageAnswer ? 'grid gap-3 sm:grid-cols-2' : 'space-y-3')}>
                  <div className="min-w-0 rounded-xl border border-border/40 bg-card/40 p-3.5">
                    <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{t('batch.yourAnswer')}</h4>
                    {imageAnswer ? (
                      <ImageAnswerDisplay images={imageAnswer.images} text={imageAnswer.text} />
                    ) : (
                      <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                        {(hasAnswer(answers[question.id]) ? practiceAnswerText(question, answers[question.id] ?? '') : '') || t('batch.result.unanswered')}
                      </p>
                    )}
                  </div>
                  <div className="min-w-0 rounded-xl border border-border/40 bg-card/40 p-3.5">
                    <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{t('paper.answer')}</h4>
                    <div className="text-sm font-medium text-foreground">
                      <MarkdownRenderer content={paperAnswer(current) || t('batch.noReference')} />
                    </div>
                  </div>
                </div>
                <QuestionExplanation
                  key={`${attempt.id}:${question.id}`}
                  questionId={question.id}
                  explanation={question.explanation}
                  aiFeedback={aiFeedback[question.id]}
                  defaultExpanded
                  allowExplanationWrite={true}
                  onRefreshQuestion={canAnalyze ? refreshExplanation : undefined}
                />
                {(() => {
                  const cleanedFeedback = (result?.feedback ?? '')
                    .replace(/<verdict\s*>\s*(?:correct|partial|incorrect)\s*<\/verdict\s*>/gi, '')
                    .replace(/<score\s+value\s*=\s*["']\d+["']\s*\/?\s*>/gi, '')
                    .trim();
                  const isGradedResult = result && (
                    result.status === 'correct'
                    || result.status === 'partial'
                    || result.status === 'incorrect'
                  );
                  const needsFallbackRationale = Boolean(
                    isGradedResult
                    && !cleanedFeedback
                    && (
                      isSubjectiveQuestionType(question.questionType)
                      || result.status === 'partial'
                      || (typeof result.score === 'number' && result.score > 0 && result.score < 100)
                    ),
                  );
                  if (!cleanedFeedback && !needsFallbackRationale) return null;
                  const refText = paperAnswer(current).trim();
                  const fallbackRationale = refText
                    ? t('batch.aiGradingRationaleFallbackWithRef', {
                        defaultValue: '已按评分标准给出 {{score}} 分（{{status}}）。请重点对照参考答案「{{reference}}」核对关键要点与推导过程。',
                        score: result?.score ?? (result?.status === 'correct' ? 100 : 0),
                        status: t(`batch.result.${result?.status ?? 'partial'}`),
                        reference: refText,
                      })
                    : t('batch.aiGradingRationaleFallback', {
                        defaultValue: '已按主观题评分标准给出 {{score}} 分（{{status}}），请结合核心知识点核对作答完整性与表述准确性。',
                        score: result?.score ?? (result?.status === 'correct' ? 100 : 0),
                        status: t(`batch.result.${result?.status ?? 'partial'}`),
                      });
                  return (
                    <section
                      data-testid="practice-ai-grading-rationale"
                      aria-label={t('batch.aiGradingRationaleTitle', { defaultValue: 'AI 评分依据与批改评语' })}
                      className="space-y-2 rounded-xl border border-primary/20 bg-primary/[0.04] p-3.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                          <Sparkle size={14} className="text-primary" aria-hidden="true" />
                          {t('batch.aiGradingRationaleTitle', { defaultValue: 'AI 评分依据与批改评语' })}
                        </h4>
                        <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
                          {result?.score != null && (
                            <span className="rounded-md border border-border/50 bg-background/80 px-2 py-0.5 font-semibold text-foreground">
                              {t('batch.scorePoints', { defaultValue: '{{score}} / 100 分', score: result.score })}
                            </span>
                          )}
                          <span className="text-muted-foreground">
                            {t(`batch.result.${result?.status ?? 'partial'}`)}
                          </span>
                        </div>
                      </div>
                      <div className="text-sm text-foreground">
                        <MarkdownRenderer content={cleanedFeedback || fallbackRationale} />
                      </div>
                    </section>
                  );
                })()}
                {result?.grading_drafts?.map((saved, draftIndex, drafts) => (
                  <details key={`${saved.created_at}-${draftIndex}`} className="border-t pt-3 text-sm" open={draftIndex === drafts.length - 1 && result.status === 'failed'}>
                    <summary className="cursor-pointer font-medium text-warning">{t('batch.feedbackDraft')} · {new Date(saved.created_at).toLocaleString()}</summary>
                    <div className="mt-2 space-y-2">
                      {saved.feedback && <MarkdownRenderer content={saved.feedback} />}
                      <p className="break-words text-destructive">{saved.error}</p>
                      <GradingDiagnosticsView diagnostics={saved.diagnostics} />
                    </div>
                  </details>
                ))}
                <GradingDiagnosticsView diagnostics={result?.grading_diagnostics} />
                {result?.error && (
                  <p role="alert" className="break-words text-sm text-destructive">
                    {result.error}
                  </p>
                )}
                {result?.status === 'failed' && !readOnly && (
                  <DsButton
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        setAttempt(await practiceApi.retry(attempt.id, question.id));
                      } catch (error) {
                        setError(getErrorMessage(error));
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <ArrowClockwise size={16} />
                    {t('batch.retryGrading')}
                  </DsButton>
                )}
                {(result?.status === 'pending' || result?.status === 'failed') && !readOnly && (
                  <div className="flex flex-wrap gap-2">
                    {[true, false].map((correct) => (
                      <DsButton
                        key={String(correct)}
                        variant="outline"
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          try {
                            setAttempt(await practiceApi.grade(attempt.id, question.id, correct));
                            callbackRef.current?.();
                          } catch (error) {
                            setError(getErrorMessage(error));
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        {correct ? <Check size={16} /> : <X size={16} />}
                        {t(correct ? 'batch.markCorrect' : 'batch.markWrong')}
                      </DsButton>
                    ))}
                  </div>
                )}
                {result && result.status !== 'unanswered' && !readOnly && (
                  <div className="space-y-2 pt-1">
                    {!overrideOpen ? (
                      <DsButton
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        data-testid="practice-manual-override-toggle"
                        onClick={() => {
                          setOverrideScoreInput(
                            String(result.score ?? (result.is_correct === true ? 100 : 0)),
                          );
                          setOverrideOpen(true);
                        }}
                      >
                        <PencilSimple size={15} />
                        {t('batch.manualOverride', { defaultValue: '手动改判' })}
                      </DsButton>
                    ) : (
                      <div
                        data-testid="practice-manual-override-panel"
                        className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/20 p-3 text-xs"
                      >
                        <span className="font-medium text-foreground">
                          {t('batch.manualOverrideTitle', { defaultValue: '手动改判与分数微调' })}
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step={1}
                          data-testid="practice-manual-override-score-input"
                          aria-label={t('batch.manualScoreInput', { defaultValue: '手动调整得分 (0-100)' })}
                          value={overrideScoreInput}
                          onChange={(event) => setOverrideScoreInput(event.target.value)}
                          className="h-8 w-20 rounded-md border border-border bg-background px-2 font-mono tabular-nums text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
                        />
                        <DsButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setOverrideScoreInput('100')}
                        >
                          {t('batch.presetFull', { defaultValue: '满分 100' })}
                        </DsButton>
                        <DsButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setOverrideScoreInput('50')}
                        >
                          {t('batch.presetHalf', { defaultValue: '半对 50' })}
                        </DsButton>
                        <DsButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setOverrideScoreInput('0')}
                        >
                          {t('batch.presetZero', { defaultValue: '0 分' })}
                        </DsButton>
                        <DsButton
                          type="button"
                          variant="primary"
                          size="sm"
                          disabled={busy}
                          data-testid="practice-manual-override-save"
                          onClick={async () => {
                            const parsed = Number(overrideScoreInput);
                            const clampedScore = Number.isFinite(parsed)
                              ? Math.max(0, Math.min(100, Math.round(parsed)))
                              : 0;
                            setBusy(true);
                            try {
                              setAttempt(
                                await practiceApi.grade(
                                  attempt.id,
                                  question.id,
                                  clampedScore >= 80,
                                  clampedScore,
                                ),
                              );
                              setOverrideOpen(false);
                              showGlobalNotification(
                                'success',
                                t('batch.manualScoreSaved', { defaultValue: '已更新本题判分与成绩' }),
                              );
                              callbackRef.current?.();
                            } catch (error) {
                              setError(getErrorMessage(error));
                            } finally {
                              setBusy(false);
                            }
                          }}
                        >
                          <Check size={14} />
                          {t('batch.saveManualOverride', { defaultValue: '保存改判' })}
                        </DsButton>
                        <DsButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => setOverrideOpen(false)}
                        >
                          {t('common:cancel', { defaultValue: '取消' })}
                        </DsButton>
                      </div>
                    )}
                  </div>
                )}
                <QuestionFollowUpBar
                  question={question}
                  examId={current.exam_id || attempt.scope_id}
                  userAnswer={answers[question.id]}
                  isCorrect={result?.is_correct}
                />
              </div>
            )}
          </div>
        </CustomScrollArea>
        {sheetOpen && (
          <aside className="hidden w-64 shrink-0 overflow-y-auto border-l border-border/35 bg-background/60 p-3.5 md:block">
            {sheet}
          </aside>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border/35 bg-background/95 px-4 py-2.5 pb-[max(0.625rem,var(--mobile-safe-area-bottom,0px))]">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3">
          <DsButton
            variant="ghost"
            size="sm"
            disabled={busy || uploading || navigating || previousIndex == null}
            onClick={() => previousIndex != null && void navigate(previousIndex)}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft size={15} />
            {t('editor.prevQuestion')}
          </DsButton>
          <div className="flex flex-col items-center gap-0.5">
            <DsButton
              variant="ghost"
              size="sm"
              aria-expanded={sheetOpen}
              aria-label={t('batch.answerSheet')}
              onClick={() => setSheetOpen(!sheetOpen)}
              className="!px-2.5 font-mono text-xs tabular-nums text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
            >
              <ListNumbers size={14} aria-hidden="true" />
              {index + 1} / {questions.length}
            </DsButton>
            {!isSmallScreen && (
              <span className="hidden lg:inline text-2xs text-muted-foreground/60">
                {attempt ? t('batch.inlineReviewNavHint') : t('batch.inlineNavHint')}
              </span>
            )}
          </div>
          <DsButton
            variant="ghost"
            size="sm"
            disabled={busy || uploading || navigating || nextIndex == null}
            onClick={() => nextIndex != null && void navigate(nextIndex)}
            className="text-foreground hover:bg-foreground/[0.04]"
          >
            {t('editor.nextQuestion')}
            <ArrowRight size={15} />
          </DsButton>
        </div>
      </div>
      <DsDialog
        open={sheetOpen && isSmallScreen}
        onOpenChange={setSheetOpen}
      >
        <DsDialogHeader>
          <DsDialogTitle>{t('batch.answerSheet')}</DsDialogTitle>
        </DsDialogHeader>
        <DsDialogBody>{sheet}</DsDialogBody>
      </DsDialog>
      <DsDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DsDialogHeader>
          <DsDialogTitle>{t('batch.confirmSubmit')}</DsDialogTitle>
        </DsDialogHeader>
        <DsDialogBody>
          <p>
            {t('batch.progress', {
              answered: answeredCount,
              total: questions.length,
            })}
          </p>
          <p className={cn('mt-2 text-sm', firstUnansweredIndex >= 0 ? 'text-warning' : 'text-muted-foreground')}>
            {t('batch.unansweredCount', { count: unansweredCount })}
          </p>
        </DsDialogBody>
        <DsDialogFooter>
          <DsButton variant="ghost" onClick={() => setConfirmOpen(false)}>
            {t('common:cancel')}
          </DsButton>
          {firstUnansweredIndex >= 0 && (
            <DsButton
              variant="outline"
              disabled={busy || uploading || navigating}
              onClick={() => {
                setConfirmOpen(false);
                void navigate(firstUnansweredIndex);
              }}
            >
              {t('mockExam.jumpToUnanswered')}
            </DsButton>
          )}
          <DsButton disabled={busy || uploading} onClick={() => void submit()}>
            <PaperPlaneRight size={16} />
            {t('batch.submit')}
          </DsButton>
        </DsDialogFooter>
      </DsDialog>
    </div>
  );
}
