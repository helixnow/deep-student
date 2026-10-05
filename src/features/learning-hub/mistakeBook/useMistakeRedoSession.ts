/**
 * 错题批量重做：把错题本里选中的一批（可跨题目集）当一套题做。
 *
 * 逐题按 id 取完整题目（结构化题型数据都在），作答走 qbank_submit_answer 写回原题——
 * 答对即移出错题本（status 回到 in_progress / mastered），与在题目集里做题同一口径。
 * 练习进度挂在虚拟归属 `__mistake_redo__` 上，不占任何题目集的做题会话。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Question, SubmitResult } from '@/api/questionBankApi';
import { convertToApiQuestion, type StoreQuestion } from '@/hooks/useQuestionBankSession';
import { useQuestionBankStore, type PracticeSessionOwner } from '@/stores/questionBankStore';
import { getErrorMessage } from '@/utils/errorUtils';
import { MISTAKE_REDO_LIMIT } from './mistakeBookApi';

export const MISTAKE_REDO_SESSION_KEY = '__mistake_redo__';

const QUESTION_FETCH_BATCH = 8;

type RedoQuestion = StoreQuestion & { exam_id?: string };

interface RawSubmitResult {
  is_correct: boolean | null;
  correct_answer: string | null;
  needs_manual_grading: boolean;
  message: string;
  submission_id: string;
  updated_question: RedoQuestion;
}

export type MistakeRedoPhase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

export interface MistakeRedoSession {
  owner: PracticeSessionOwner;
  phase: MistakeRedoPhase;
  /** 选中时还在、加载时已被删除的题数（跳过） */
  missing: number;
  questions: Question[];
  currentIndex: number;
  /** 当前题所属题目集（问 AI / 同类题 / 图片裁剪都按它落库） */
  currentExamId: string | null;
  navigate: (index: number) => void;
  submitAnswer: (questionId: string, answer: string) => Promise<SubmitResult>;
  /** 自评改判（主观题「我答对了 / 我答错了」） */
  markCorrect: (questionId: string, isCorrect: boolean) => Promise<void>;
  refreshQuestion: (questionId: string) => Promise<void>;
  toggleFavorite: (questionId: string) => Promise<void>;
}

function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

type FetchOutcome = { ok: true; question: RedoQuestion | null } | { ok: false; error: unknown };

export function useMistakeRedoSession(questionIds: readonly string[]): MistakeRedoSession {
  const viewInstanceIdRef = useRef(`mistake_redo_${newRequestId()}`);
  const owner = useMemo<PracticeSessionOwner>(
    () => ({ examId: MISTAKE_REDO_SESSION_KEY, viewInstanceId: viewInstanceIdRef.current }),
    [],
  );
  const [byId, setById] = useState<Map<string, RedoQuestion>>(() => new Map());
  const [order, setOrder] = useState<string[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [phase, setPhase] = useState<MistakeRedoPhase>({ kind: 'loading' });
  const [missing, setMissing] = useState(0);
  const byIdRef = useRef(byId);
  byIdRef.current = byId;
  const orderRef = useRef(order);
  orderRef.current = order;
  // 每题本会话最近一次提交：自评改判时让后端改这次提交，而不是再记一次作答
  const lastSubmissionIdsRef = useRef(new Map<string, string>());

  const ensurePracticeSession = useQuestionBankStore((state) => state.ensurePracticeSession);
  const releasePracticeSession = useQuestionBankStore((state) => state.releasePracticeSession);

  // 调用方每次渲染都可能给新数组：按内容决定要不要重新加载
  const idsKey = questionIds.slice(0, MISTAKE_REDO_LIMIT).join('\n');

  useEffect(() => {
    let cancelled = false;
    const ids = idsKey ? idsKey.split('\n') : [];
    setPhase({ kind: 'loading' });
    lastSubmissionIdsRef.current.clear();

    void (async () => {
      const loaded = new Map<string, RedoQuestion>();
      const loadedOrder: string[] = [];
      let failed = 0;
      let firstError: unknown = null;
      for (let start = 0; start < ids.length; start += QUESTION_FETCH_BATCH) {
        const outcomes = await Promise.all(
          ids.slice(start, start + QUESTION_FETCH_BATCH).map((questionId) =>
            invoke<RedoQuestion | null>('qbank_get_question', { questionId }).then(
              (question): FetchOutcome => ({ ok: true, question }),
              (error: unknown): FetchOutcome => ({ ok: false, error }),
            ),
          ),
        );
        if (cancelled) return;
        for (const outcome of outcomes) {
          if (outcome.ok === false) {
            failed += 1;
            firstError ??= outcome.error;
          } else if (outcome.question && !loaded.has(outcome.question.id)) {
            loaded.set(outcome.question.id, outcome.question);
            loadedOrder.push(outcome.question.id);
          }
        }
      }
      if (cancelled) return;
      if (ids.length > 0 && failed === ids.length) {
        setPhase({ kind: 'error', message: getErrorMessage(firstError) });
        return;
      }
      setById(loaded);
      setOrder(loadedOrder);
      setCurrentId(loadedOrder[0] ?? null);
      setMissing(ids.length - loadedOrder.length);
      setPhase(loadedOrder.length > 0 ? { kind: 'ready' } : { kind: 'empty' });
    })();

    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  useEffect(() => {
    ensurePracticeSession(owner, order);
  }, [owner, order, ensurePracticeSession]);

  useEffect(() => () => releasePracticeSession(owner), [owner, releasePracticeSession]);

  const putQuestion = useCallback((question: RedoQuestion) => {
    setById((prev) => {
      if (!prev.has(question.id)) return prev;
      const next = new Map(prev);
      next.set(question.id, question);
      return next;
    });
  }, []);

  const submit = useCallback(async (
    questionId: string,
    answer: string,
    isCorrectOverride?: boolean,
  ): Promise<SubmitResult> => {
    const regradeSubmissionId = isCorrectOverride !== undefined
      ? lastSubmissionIdsRef.current.get(questionId) ?? null
      : null;
    const result = await invoke<RawSubmitResult>('qbank_submit_answer', {
      request: {
        question_id: questionId,
        user_answer: answer,
        is_correct_override: isCorrectOverride,
        client_request_id: newRequestId(),
        regrade_submission_id: regradeSubmissionId,
      },
    });
    putQuestion(result.updated_question);
    lastSubmissionIdsRef.current.set(questionId, result.submission_id);
    return {
      isCorrect: result.is_correct,
      correctAnswer: result.correct_answer ?? undefined,
      needsManualGrading: result.needs_manual_grading,
      message: result.message,
      submissionId: result.submission_id,
    };
  }, [putQuestion]);

  // 编辑器的 onSubmitAnswer 第三个参数是题型，不能透传成改判标记
  const submitAnswer = useCallback(
    (questionId: string, answer: string) => submit(questionId, answer),
    [submit],
  );

  const markCorrect = useCallback(async (questionId: string, isCorrect: boolean) => {
    await submit(questionId, byIdRef.current.get(questionId)?.user_answer || '', isCorrect);
  }, [submit]);

  const refreshQuestion = useCallback(async (questionId: string) => {
    const question = await invoke<RedoQuestion | null>('qbank_get_question', { questionId });
    if (question) {
      putQuestion(question);
      return;
    }
    // 重做途中题目被删了：移出这一套，当前题顺延
    const remaining = orderRef.current.filter((id) => id !== questionId);
    setOrder(remaining);
    setById((prev) => {
      if (!prev.has(questionId)) return prev;
      const next = new Map(prev);
      next.delete(questionId);
      return next;
    });
    setCurrentId((prev) => (prev === questionId ? remaining[0] ?? null : prev));
    if (remaining.length === 0) setPhase({ kind: 'empty' });
  }, [putQuestion]);

  const toggleFavorite = useCallback(async (questionId: string) => {
    putQuestion(await invoke<RedoQuestion>('qbank_toggle_favorite', { questionId }));
  }, [putQuestion]);

  const navigate = useCallback((index: number) => {
    const ids = orderRef.current;
    if (ids.length === 0) return;
    setCurrentId(ids[Math.min(Math.max(index, 0), ids.length - 1)] ?? null);
  }, []);

  const questions = useMemo(
    () => order
      .map((id) => byId.get(id))
      .filter((question): question is RedoQuestion => question != null)
      .map(convertToApiQuestion),
    [byId, order],
  );

  const currentIndex = useMemo(() => {
    const index = currentId ? order.indexOf(currentId) : 0;
    return index >= 0 ? index : 0;
  }, [currentId, order]);

  const currentExamId = byId.get(order[currentIndex] ?? '')?.exam_id ?? null;

  return {
    owner,
    phase,
    missing,
    questions,
    currentIndex,
    currentExamId,
    navigate,
    submitAnswer,
    markCorrect,
    refreshQuestion,
    toggleFavorite,
  };
}
