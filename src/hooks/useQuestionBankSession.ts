/**
 * 题目集会话 Hook
 *
 * ★ 标签页改造：所有 exam-specific 状态（questions, stats, currentIndex, practiceMode）
 * 完全本地化，不再读写全局 useQuestionBankStore。这确保多个 ExamContentView 实例
 * 在标签页保活场景下数据隔离，互不干扰。
 *
 * 全局 store 仅保留 UI 偏好（focusMode, showSettingsPanel）和功能性 actions。
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type Question, type QuestionBankStats, type SubmitResult, type PracticeMode } from '@/api/questionBankApi';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { emitExamSheetDebug } from '@/debug-panel/plugins/ExamSheetProcessingDebugPlugin';

// Store 侧类型（snake_case，与 Rust 序列化一致）
interface StoreQuestion {
  id: string;
  card_id?: string;
  question_label?: string;
  content: string;
  question_type: string;
  options: any[];
  answer: string;
  explanation: string;
  difficulty: string;
  tags: string[];
  status: string;
  user_answer: string;
  is_correct: boolean | null;
  user_note: string;
  attempt_count: number;
  correct_count: number;
  last_attempt_at: string | null;
  is_favorite: boolean;
  images: any[];
  ai_feedback?: string | null;
  ai_score?: number | null;
  ai_graded_at?: string | null;
}

interface StoreStats {
  total_count: number;
  mastered_count: number;
  review_count: number;
  in_progress_count: number;
  new_count: number;
  correct_rate: number;
}

interface QuestionListResult {
  questions: StoreQuestion[];
  total: number;
  page: number;
  page_size: number;
  has_more: boolean;
}

interface SubmitAnswerResult {
  is_correct: boolean;
  correct_answer: string;
  needs_manual_grading: boolean;
  message: string;
  submission_id: string;
  updated_question: StoreQuestion;
  updated_stats: StoreStats;
}

function convertToApiQuestion(q: StoreQuestion): Question {
  return {
    id: q.id,
    cardId: q.card_id || q.id,
    questionLabel: q.question_label || '',
    content: q.content,
    ocrText: q.content,
    questionType: q.question_type as Question['questionType'],
    options: q.options,
    answer: q.answer,
    explanation: q.explanation,
    difficulty: q.difficulty as Question['difficulty'],
    tags: q.tags,
    status: q.status as Question['status'],
    userAnswer: q.user_answer,
    isCorrect: q.is_correct,
    userNote: q.user_note,
    attemptCount: q.attempt_count,
    correctCount: q.correct_count,
    lastAttemptAt: q.last_attempt_at,
    isFavorite: q.is_favorite,
    images: q.images,
    ai_feedback: q.ai_feedback,
    ai_score: q.ai_score,
    ai_graded_at: q.ai_graded_at,
  };
}

function convertToApiStats(s: StoreStats | null): QuestionBankStats | null {
  if (!s) return null;
  return {
    total: s.total_count,
    mastered: s.mastered_count,
    review: s.review_count,
    inProgress: s.in_progress_count,
    newCount: s.new_count,
    correctRate: s.correct_rate,
  };
}

interface UseQuestionBankSessionOptions {
  examId: string | null;
}

interface UseQuestionBankSessionReturn {
  questions: Question[];
  currentQuestion: Question | null;
  currentIndex: number;
  stats: QuestionBankStats | null;

  hasMore: boolean;
  pagination: { page: number; pageSize: number; total: number; hasMore: boolean };

  isLoading: boolean;
  isSubmitting: boolean;
  error: string | null;
  isMigrated: boolean;

  loadQuestions: () => Promise<void>;
  loadMoreQuestions: () => Promise<void>;
  submitAnswer: (questionId: string, answer: string, isCorrectOverride?: boolean) => Promise<SubmitResult>;
  markCorrect: (questionId: string, isCorrect: boolean) => Promise<void>;
  navigate: (index: number) => void;
  toggleFavorite: (questionId: string) => Promise<void>;
  practiceMode: PracticeMode;
  setPracticeMode: (mode: PracticeMode) => void;
  refreshStats: () => Promise<void>;
}

const PAGE_SIZE = 50;

export function useQuestionBankSession({
  examId,
}: UseQuestionBankSessionOptions): UseQuestionBankSessionReturn {
  // ========== ★ 完全本地化状态 ==========
  const [localQuestions, setLocalQuestions] = useState<Map<string, StoreQuestion>>(new Map());
  const [localOrder, setLocalOrder] = useState<string[]>([]);
  const [localStats, setLocalStats] = useState<StoreStats | null>(null);
  const [currentQuestionId, setCurrentQuestionId] = useState<string | null>(null);
  const [practiceMode, setPracticeModeState] = useState<PracticeMode>('sequential');
  const [isLoading, setIsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState({ page: 1, pageSize: PAGE_SIZE, total: 0, hasMore: false });

  // Refs for concurrent request protection
  const examIdRef = useRef(examId);
  const loadRequestIdRef = useRef(0);
  examIdRef.current = examId;

  // ========== 加载题目 ==========
  const loadQuestionsImpl = useCallback(async () => {
    const currentExamId = examIdRef.current;
    if (!currentExamId) return;

    const requestId = ++loadRequestIdRef.current;
    setIsLoading(true);
    setError(null);

    emitExamSheetDebug('info', 'frontend:hook-state', `[Session] loadQuestions: examId=${currentExamId}`, { sessionId: currentExamId });

    try {
      const [result, stats] = await Promise.all([
        invoke<QuestionListResult>('qbank_list_questions', {
          request: { exam_id: currentExamId, filters: {}, page: 1, page_size: PAGE_SIZE },
        }),
        invoke<StoreStats | null>('qbank_get_stats', { examId: currentExamId }),
      ]);

      // Concurrent guard
      if (loadRequestIdRef.current !== requestId) return;

      const questionsMap = new Map<string, StoreQuestion>();
      const order: string[] = [];
      result.questions.forEach(q => {
        questionsMap.set(q.id, q);
        order.push(q.id);
      });

      setLocalQuestions(questionsMap);
      setLocalOrder(order);
      setLocalStats(stats);
      setCurrentQuestionId(result.questions[0]?.id || null);
      setPagination({ page: result.page, pageSize: result.page_size, total: result.total, hasMore: result.has_more });

      emitExamSheetDebug('success', 'frontend:hook-state',
        `[Session] loadQuestions OK: ${result.questions.length} questions, total=${result.total}`,
        { sessionId: currentExamId },
      );
    } catch (err: unknown) {
      if (loadRequestIdRef.current !== requestId) return;
      debugLog.error('[useQuestionBankSession] loadQuestions failed:', err);
      setError(String(err));
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, []);

  const loadQuestions = useCallback(async () => {
    await loadQuestionsImpl();
  }, [loadQuestionsImpl]);

  // 初始加载
  useEffect(() => {
    if (examId) {
      void loadQuestionsImpl();
    } else {
      // Reset when examId becomes null
      setLocalQuestions(new Map());
      setLocalOrder([]);
      setLocalStats(null);
      setCurrentQuestionId(null);
      setPagination({ page: 1, pageSize: PAGE_SIZE, total: 0, hasMore: false });
    }
  }, [examId, loadQuestionsImpl]);

  // ========== 加载更多（分页） ==========
  const loadMoreQuestions = useCallback(async () => {
    const currentExamId = examIdRef.current;
    if (!currentExamId || isLoading || !pagination.hasMore) return;

    setIsLoading(true);
    try {
      const result = await invoke<QuestionListResult>('qbank_list_questions', {
        request: { exam_id: currentExamId, filters: {}, page: pagination.page + 1, page_size: PAGE_SIZE },
      });

      setLocalQuestions(prev => {
        const next = new Map(prev);
        result.questions.forEach(q => next.set(q.id, q));
        return next;
      });
      setLocalOrder(prev => {
        const existingSet = new Set(prev);
        const newIds = result.questions.filter(q => !existingSet.has(q.id)).map(q => q.id);
        return [...prev, ...newIds];
      });
      setPagination(prev => ({ ...prev, page: result.page, total: result.total, hasMore: result.has_more }));
    } catch (err: unknown) {
      debugLog.error('[useQuestionBankSession] loadMoreQuestions failed:', err);
      setError(String(err));
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, pagination.hasMore, pagination.page]);

  // ========== 提交答案 ==========
  const submitAnswer = useCallback(async (questionId: string, answer: string, isCorrectOverride?: boolean): Promise<SubmitResult> => {
    setIsSubmitting(true);
    try {
      const result = await invoke<SubmitAnswerResult>('qbank_submit_answer', {
        request: { question_id: questionId, user_answer: answer, is_correct_override: isCorrectOverride },
      });

      // 本地更新 question + stats
      setLocalQuestions(prev => {
        const next = new Map(prev);
        next.set(result.updated_question.id, result.updated_question);
        return next;
      });
      setLocalStats(result.updated_stats);

      return {
        isCorrect: result.is_correct,
        correctAnswer: result.correct_answer,
        needsManualGrading: result.needs_manual_grading,
        message: result.message,
        submissionId: result.submission_id,
      };
    } finally {
      setIsSubmitting(false);
    }
  }, []);

  // ========== 标记正确/错误 ==========
  const markCorrect = useCallback(async (questionId: string, isCorrect: boolean) => {
    const question = localQuestions.get(questionId);
    const userAnswer = question?.user_answer || '';
    await submitAnswer(questionId, userAnswer, isCorrect);
  }, [localQuestions, submitAnswer]);

  // ========== ★ 本地化导航（含 practiceMode） ==========
  const navigate = useCallback((index: number) => {
    if (index >= 0 && index < localOrder.length) {
      setCurrentQuestionId(localOrder[index] || null);
    }
  }, [localOrder]);

  // ========== 切换收藏 ==========
  const toggleFavorite = useCallback(async (questionId: string) => {
    try {
      const question = await invoke<StoreQuestion>('qbank_toggle_favorite', { questionId });
      setLocalQuestions(prev => {
        const next = new Map(prev);
        next.set(question.id, question);
        return next;
      });
    } catch (err: unknown) {
      debugLog.error('[useQuestionBankSession] toggleFavorite failed:', err);
      throw err;
    }
  }, []);

  // ========== 练习模式 ==========
  const setPracticeMode = useCallback((mode: PracticeMode) => {
    setPracticeModeState(mode);
  }, []);

  // ========== 刷新统计 ==========
  const refreshStats = useCallback(async () => {
    const currentExamId = examIdRef.current;
    if (!currentExamId) return;
    try {
      const stats = await invoke<StoreStats>('qbank_refresh_stats', { examId: currentExamId });
      setLocalStats(stats);
    } catch (err: unknown) {
      debugLog.error('[useQuestionBankSession] refreshStats failed:', err);
    }
  }, []);

  // ========== 转换为 API 类型 ==========
  const questions = useMemo(() => {
    return localOrder
      .map(id => localQuestions.get(id))
      .filter((q): q is StoreQuestion => q != null)
      .map(convertToApiQuestion);
  }, [localQuestions, localOrder]);

  const currentIndex = useMemo(() => {
    if (!currentQuestionId) return 0;
    const idx = localOrder.indexOf(currentQuestionId);
    return idx >= 0 ? idx : 0;
  }, [localOrder, currentQuestionId]);

  const currentQuestion = useMemo(() => {
    if (!currentQuestionId) return null;
    const q = localQuestions.get(currentQuestionId);
    return q ? convertToApiQuestion(q) : null;
  }, [localQuestions, currentQuestionId]);

  const stats = useMemo(() => convertToApiStats(localStats), [localStats]);

  const isMigrated = questions.length > 0;

  return {
    questions,
    currentQuestion,
    currentIndex,
    stats,

    hasMore: pagination.hasMore,
    pagination,

    isLoading,
    isSubmitting,
    error,
    isMigrated,

    loadQuestions,
    loadMoreQuestions,
    submitAnswer,
    markCorrect,
    navigate,
    toggleFavorite,
    practiceMode,
    setPracticeMode,
    refreshStats,
  };
}

export default useQuestionBankSession;
