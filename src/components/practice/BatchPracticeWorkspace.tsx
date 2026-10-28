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
  Star,
  X,
} from '@phosphor-icons/react';
import {
  practiceApi,
  newPracticeId,
  type CreatePracticeRequest,
  type PracticeDraft,
  type PracticeAttempt,
} from '@/api/practiceApi';
import { convertToApiQuestion } from '@/hooks/useQuestionBankSession';
import { parseImageAnswerEnvelope } from '@/api/questionBankApi';
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
  const uploadingRef = useRef(false);
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState('all');
  const [tick, setTick] = useState(Date.now());
  const [favorites, setFavorites] = useState<Record<string, boolean>>({});
  const runtimeKey = useRef(newPracticeId());
  const [images, setImages] = useState<Record<string, string>>({});
  const dirtyRef = useRef(false);
  const changeRef = useRef(0);
  const saveRef = useRef<Promise<void> | null>(null);
  const submitRef = useRef(false);
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
    onFlushReady?.(flush);
    const handler = () => {
      if (document.visibilityState === 'hidden') void flush().catch(() => {});
    };
    document.addEventListener('visibilitychange', handler);
    return () => {
      mounted.current = false;
      onFlushReady?.(null);
      document.removeEventListener('visibilitychange', handler);
      void flush().catch(() => {});
    };
  }, [flush, onFlushReady]);

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
    if (!draftRef.current || submitRef.current) return;
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
  useEffect(() => {
    if (!current || readOnly) return;
    let cancelled = false;
    void invoke<{ is_favorite: boolean } | null>('qbank_get_question', { questionId: current.id })
      .then((live) => {
        if (live && !cancelled) setFavorites((values) => ({ ...values, [current.id]: live.is_favorite }));
      }).catch(() => {});
    return () => { cancelled = true; };
  }, [current?.id, readOnly]);
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
  const results = attempt?.results ?? [];
  const result = results.find((r) => r.question_id === current?.id);
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
    if (uploading || busy || next < 0 || next >= questions.length) return false;
    if (draftRef.current) {
      change({ current_index: next });
      try {
        await flush();
      } catch {
        return false;
      }
    }
    setIndex(next);
    return true;
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
      answeredCount: Object.keys(answers).length,
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

  const sheet = (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t('batch.progress', { answered: Object.keys(answers).length, total: questions.length })}
        </span>
        <span>
          {t('batch.unansweredCount', { count: questions.length - Object.keys(answers).length })}
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(44px,1fr))] gap-1.5">
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
                'relative !h-11 !min-w-11 !rounded-md border tabular-nums',
                answers[q.id] && !attempt && 'border-primary/50 bg-primary/10',
                r?.is_correct === true && 'border-success/50 bg-success/10',
                r?.is_correct === false && 'border-destructive/50 bg-destructive/10',
                (r?.status === 'pending' || r?.status === 'failed') &&
                  'border-warning/50 bg-warning/10',
                index === i && 'ring-2 ring-ring',
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
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          aria-label={t('common:back')}
          title={t('common:back')}
          disabled={busy || uploading}
          onClick={() => void leave()}
        >
          <ArrowLeft size={18} />
        </DsButton>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {attempt?.title ?? draft?.title}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">{formatTime(elapsed)}</span>
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
        <DsButton variant="ghost" size="sm" onClick={() => setSheetOpen(!sheetOpen)}>
          <ListNumbers size={16} />
          {t('batch.answerSheet')}
        </DsButton>
        {!attempt && (
          <DsButton size="sm" disabled={busy || uploading} onClick={() => setConfirmOpen(true)}>
            {busy ? (
              <CircleNotch size={16} className="animate-spin" />
            ) : (
              <PaperPlaneRight size={16} />
            )}
            {t('batch.submit')}
          </DsButton>
        )}
        {attempt && !readOnly && (
          <DsButton
            variant="outline"
            size="sm"
            disabled={busy}
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
            <ArrowClockwise size={16} />
            {t('batch.restart')}
          </DsButton>
        )}
      </div>
      {error && (
        <div
          className="flex flex-wrap items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-sm text-destructive"
          role="alert"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          {draft && (
            <DsButton variant="outline" size="sm" onClick={() => void flush().catch(() => {})}>
              <ArrowClockwise size={16} />
              {t('common:actions.retry')}
            </DsButton>
          )}
        </div>
      )}
      {attempt && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b px-4 py-3 text-sm">
          <span className="text-success">
            {t('batch.correctCount', {
              count: results.filter((r) => r.is_correct === true).length,
            })}
          </span>
          <span className="text-destructive">
            {t('batch.wrongCount', { count: results.filter((r) => r.is_correct === false).length })}
          </span>
          <span>
            {t('batch.unansweredCount', {
              count: results.filter((r) => r.status === 'unanswered').length,
            })}
          </span>
          <span className="text-warning">
            {t('batch.pendingCount', {
              count: results.filter((r) => r.status === 'pending' || r.status === 'failed').length,
            })}
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
            className="ml-auto min-h-9 rounded-md border bg-background px-2 text-sm"
          >
            {['all', 'wrong', 'unanswered', 'pending'].map((f) => (
              <option key={f} value={f}>
                {t(`batch.filters.${f}`)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <CustomScrollArea className="min-w-0 flex-1" viewportClassName="p-4 sm:p-6">
          <div className="mx-auto max-w-3xl space-y-5">
            <div className="flex items-center gap-3">
              <span className="text-xs tabular-nums text-muted-foreground">
                {index + 1} / {questions.length}
              </span>
              <span className="text-xs text-muted-foreground">
                {t(`questionType.${question.questionType}`)}
              </span>
              {!readOnly && result?.source_available !== false && (
                <DsButton variant="ghost" size="icon" iconOnly
                  aria-label={t('editor.favorite')} title={t('editor.favorite')}
                  aria-pressed={favorites[question.id] ?? current.is_favorite}
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const updated = await invoke<{ is_favorite: boolean }>('qbank_toggle_favorite', { questionId: question.id });
                      setFavorites((values) => ({ ...values, [question.id]: updated.is_favorite }));
                      callbackRef.current?.();
                    } catch (error) { setError(getErrorMessage(error)); }
                    finally { setBusy(false); }
                  }}>
                  <Star size={16} weight={(favorites[question.id] ?? current.is_favorite) ? 'fill' : 'regular'} />
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
                >
                  <BookmarkSimple
                    size={16}
                    weight={marked.includes(question.id) ? 'fill' : 'regular'}
                  />
                  {t('batch.mark')}
                </DsButton>
              )}
            </div>
            {!!question.materials?.length && (
              <QuestionMaterialView materials={question.materials} />
            )}
            <MarkdownRenderer content={question.content} />
            {(current.images ?? [])
              .filter((image) => image.role !== 'source')
              .map((image) =>
                images[image.id] && images[image.id] !== 'error' ? (
                  <img
                    key={image.id}
                    src={images[image.id]}
                    alt={image.name}
                    className="max-h-[600px] max-w-full object-contain"
                  />
                ) : (
                  <p key={image.id} className="text-sm text-destructive">
                    {t('batch.imageMissing')}
                  </p>
                ),
              )}
          {attempt && !!question.options?.length && <div className="space-y-2">{question.options.map(option => <div key={option.key} className="flex items-start gap-2 text-sm"><span className="shrink-0 font-medium">{option.key}.</span><MarkdownRenderer content={option.content} /></div>)}</div>}
          {!attempt ? (
              <>
                <fieldset
                  disabled={busy || Boolean(draft?.deadline && Date.parse(draft.deadline) <= tick)}
                >
                  <PracticeAnswerInput
                    key={question.id}
                    question={question}
                    value={answers[question.id] ?? ''}
                    onUploadingChange={(value) => {
                      uploadingRef.current = value;
                      setUploading(value);
                    }}
                    onChange={(value) =>
                      change({
                        answers: value
                          ? { ...draftRef.current!.answers, [question.id]: value }
                          : Object.fromEntries(
                              Object.entries(draftRef.current!.answers).filter(
                                ([id]) => id !== question.id,
                              ),
                            ),
                      })
                    }
                  />
                </fieldset>
                <DsButton
                  variant="ghost"
                  size="sm"
                  disabled={busy || uploading || !answers[question.id]}
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
              <div className="space-y-4 border-t pt-4">
                <p
                  className={cn(
                    'text-sm font-medium',
                    result?.is_correct === true
                      ? 'text-success'
                      : result?.is_correct === false
                        ? 'text-destructive'
                        : 'text-warning',
                  )}
                >
                  {t(`batch.result.${result?.status ?? 'pending'}`)}
                  {result?.score != null && ` · ${result.score}/100`}
                </p>
                {result && !result.source_available && (
                  <p className="text-xs text-muted-foreground">{t('batch.sourceUnavailable')}</p>
                )}
                <div>
                  <h4 className="mb-2 text-sm font-medium">{t('batch.yourAnswer')}</h4>
                  {imageAnswer ? (
                    <ImageAnswerDisplay images={imageAnswer.images} text={imageAnswer.text} />
                  ) : (
                    <p className="whitespace-pre-wrap break-words text-sm">
                      {practiceAnswerText(question, answers[question.id] ?? '') || t('batch.result.unanswered')}
                    </p>
                  )}
                </div>
                <div>
                  <h4 className="mb-2 text-sm font-medium">{t('paper.answer')}</h4>
                  <MarkdownRenderer content={paperAnswer(current) || t('batch.noReference')} />
                </div>
                {question.explanation && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium">{t('paper.explanation')}</h4>
                    <MarkdownRenderer content={question.explanation} />
                  </div>
                )}
                {result?.feedback && <MarkdownRenderer content={result.feedback} />}
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
                {result?.status !== 'unanswered' && !readOnly && (
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
              </div>
            )}
          </div>
        </CustomScrollArea>
        {sheetOpen && (
          <aside className="hidden w-64 shrink-0 overflow-y-auto border-l p-3 md:block">
            {sheet}
          </aside>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t px-4 py-2 pb-[max(0.5rem,var(--mobile-safe-area-bottom,0px))]">
        <DsButton
          variant="outline"
          disabled={busy || uploading || previousIndex == null}
          onClick={() => previousIndex != null && void navigate(previousIndex)}
        >
          <ArrowLeft size={16} />
          {t('editor.prevQuestion')}
        </DsButton>
        <DsButton
          variant="outline"
          disabled={busy || uploading || nextIndex == null}
          onClick={() => nextIndex != null && void navigate(nextIndex)}
        >
          {t('editor.nextQuestion')}
          <ArrowRight size={16} />
        </DsButton>
      </div>
      <DsDialog
        open={sheetOpen && typeof window !== 'undefined' && window.innerWidth < 768}
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
              answered: Object.keys(answers).length,
              total: questions.length,
            })}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            {t('batch.unansweredCount', { count: questions.length - Object.keys(answers).length })}
          </p>
        </DsDialogBody>
        <DsDialogFooter>
          <DsButton variant="ghost" onClick={() => setConfirmOpen(false)}>
            {t('common:cancel')}
          </DsButton>
          <DsButton disabled={busy || uploading} onClick={() => void submit()}>
            <PaperPlaneRight size={16} />
            {t('batch.submit')}
          </DsButton>
        </DsDialogFooter>
      </DsDialog>
    </div>
  );
}
