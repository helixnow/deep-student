/**
 * 题目集会话 Hook
 *
 * ★ 标签页改造：所有 exam-specific 状态（questions, stats, currentIndex, practiceMode）
 * 完全本地化，不再读写全局 useQuestionBankStore。这确保多个 ExamContentView 实例
 * 在标签页保活场景下数据隔离，互不干扰。
 *
 * 全局 store 仅保留跨题目集 UI 偏好（如 focusMode）和功能性 actions。
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { type Question, type QuestionBankStats, type SubmitResult, type PracticeMode, type QuestionStructuredData } from '@/api/questionBankApi';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { emitExamSheetDebug } from '@/debug-panel/plugins/ExamSheetProcessingDebugPlugin';
import {
  useQuestionBankStore,
  type PracticeSessionOwner,
  type DailyProgressSnapshot,
} from '@/stores/questionBankStore';

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
  /**
   * 新题型（true_false/matching/ordering/numeric）的结构化数据。
   * 本 hook 只负责透传，不做解析；契约类型见 questionBankApi.QuestionStructuredData。
   */
  structured_data?: QuestionStructuredData | null;
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
  is_correct: boolean | null;
  correct_answer: string | null;
  needs_manual_grading: boolean;
  message: string;
  submission_id: string;
  updated_question: StoreQuestion;
  updated_stats: StoreStats;
  /**
   * 后端在提交/改判响应里回带的当日权威 daily 进度快照
   * （Rust SubmitAnswerResult.daily_progress，serde snake_case、Option 字段）。
   * 旧后端载荷无此键时为 undefined。本 hook 只负责透传给调用方，
   * 由判分调用点决定是否覆盖 store 的本地乐观增量。
   */
  daily_progress?: DailyProgressSnapshot | null;
}

/**
 * hook 对外的提交结果：在 API 层 SubmitResult 之上附带权威 daily 快照。
 * submitAnswer / markCorrect（改判）都会返回，调用点在完成本地乐观回写后
 * 应以它为准覆盖（applyAuthoritativeDailyProgress）——这是首答锁 fail-closed
 * 分支（已答但无判定基线）唯一的即时收敛路径。
 */
export type SessionSubmitResult = SubmitResult & {
  dailyProgress?: DailyProgressSnapshot;
};

function generateClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function convertToApiQuestion(q: StoreQuestion): Question {
  const question: Question = {
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
  // 透传新题型结构化数据（不做穷举解析；组件侧经 parse*Data 收窄校验）
  if (q.structured_data !== undefined) {
    question.structured_data = q.structured_data;
  }
  return question;
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
  /** 本 hook 实例的稳定归属键；同一 examId 的两个保活实例也不会共享进度。 */
  practiceSessionOwner: PracticeSessionOwner | null;
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
  refreshQuestion: (questionId: string) => Promise<void>;
  submitAnswer: (questionId: string, answer: string, isCorrectOverride?: boolean) => Promise<SessionSubmitResult>;
  /** 自评改判。返回本次改判的提交结果（含权威 daily 快照），供调用点回写进度。 */
  markCorrect: (questionId: string, isCorrect: boolean) => Promise<SessionSubmitResult>;
  navigate: (index: number) => void;
  toggleFavorite: (questionId: string) => Promise<void>;
  practiceMode: PracticeMode;
  setPracticeMode: (mode: PracticeMode) => void;
  refreshStats: () => Promise<void>;
}

const PAGE_SIZE = 50;

// ========== 做题位置持久化（关闭重开恢复到上次题目） ==========
const LAST_QUESTION_STORAGE_PREFIX = 'qbank:lastQuestion:';

function readLastQuestionId(examId: string): string | null {
  try {
    return localStorage.getItem(`${LAST_QUESTION_STORAGE_PREFIX}${examId}`);
  } catch {
    return null;
  }
}

function writeLastQuestionId(examId: string, questionId: string | null): void {
  try {
    const key = `${LAST_QUESTION_STORAGE_PREFIX}${examId}`;
    if (questionId) {
      localStorage.setItem(key, questionId);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage 不可用时静默忽略（隐私模式等）
  }
}

export function useQuestionBankSession({
  examId,
}: UseQuestionBankSessionOptions): UseQuestionBankSessionReturn {
  const practiceViewInstanceIdRef = useRef<string | null>(null);
  if (practiceViewInstanceIdRef.current === null) {
    practiceViewInstanceIdRef.current = `qbank_view_${generateClientRequestId()}`;
  }
  const practiceSessionOwner = useMemo<PracticeSessionOwner | null>(
    () => examId
      ? { examId, viewInstanceId: practiceViewInstanceIdRef.current! }
      : null,
    [examId],
  );

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
  const ensurePracticeSession = useQuestionBankStore((state) => state.ensurePracticeSession);
  const releasePracticeSession = useQuestionBankStore((state) => state.releasePracticeSession);

  // 全局容器只负责跨「做题 / 错题本 / 统计」子视图保留即时进度。
  // 归属由当前 hook 实例显式提供，题目白名单随本地题目集刷新。
  useEffect(() => {
    if (!practiceSessionOwner) return;
    ensurePracticeSession(practiceSessionOwner, localOrder);
  }, [practiceSessionOwner, localOrder, ensurePracticeSession]);

  // 整个题库视图卸载（关闭标签）后释放分片；切换内部子视图不会卸载本 hook。
  useEffect(() => {
    if (!practiceSessionOwner) return;
    return () => releasePracticeSession(practiceSessionOwner);
  }, [practiceSessionOwner, releasePracticeSession]);

  // Refs for concurrent request protection
  const examIdRef = useRef(examId);
  const loadRequestIdRef = useRef(0);
  const sessionEpochRef = useRef(0);
  const currentQuestionIdRef = useRef<string | null>(null);
  const localOrderRef = useRef<string[]>([]);
  // 提交防重入：isSubmitting state 在同一帧内读到的是旧值，连点会触发双提交
  const submitInFlightRef = useRef(false);
  // 每题最近一次提交 id（本会话内）：自评改判时传给后端定位要改判的提交
  const lastSubmissionIdsRef = useRef<Map<string, string>>(new Map());
  examIdRef.current = examId;
  currentQuestionIdRef.current = currentQuestionId;
  localOrderRef.current = localOrder;

  const fetchAllQuestions = useCallback(async (
    currentExamId: string,
    epoch: number,
    requestId: number,
  ): Promise<QuestionListResult> => {
    const firstPage = await invoke<QuestionListResult>('qbank_list_questions', {
      request: { exam_id: currentExamId, filters: {}, page: 1, page_size: PAGE_SIZE },
    });

    if (loadRequestIdRef.current !== requestId || sessionEpochRef.current !== epoch || examIdRef.current !== currentExamId) {
      return firstPage;
    }

    if (!firstPage.has_more) {
      return firstPage;
    }

    const allQuestions = [...firstPage.questions];
    let page = firstPage.page;
    let hasMore: boolean = firstPage.has_more;

    while (hasMore) {
      const nextPage = page + 1;
      const result = await invoke<QuestionListResult>('qbank_list_questions', {
        request: { exam_id: currentExamId, filters: {}, page: nextPage, page_size: PAGE_SIZE },
      });

      if (loadRequestIdRef.current !== requestId || sessionEpochRef.current !== epoch || examIdRef.current !== currentExamId) {
        return {
          ...result,
          questions: allQuestions,
          total: result.total,
          page: nextPage,
          has_more: result.has_more,
        };
      }

      // 防御：后端异常地返回空页却仍报 has_more 时终止循环，避免无限请求
      if (result.questions.length === 0) {
        return {
          ...result,
          questions: allQuestions,
          page: nextPage,
          has_more: false,
        };
      }

      allQuestions.push(...result.questions);
      page = result.page;
      hasMore = result.has_more;
    }

    return {
      ...firstPage,
      questions: allQuestions,
      total: firstPage.total,
      page,
      has_more: false,
    };
  }, []);

  // ========== 加载题目 ==========
  const loadQuestionsImpl = useCallback(async () => {
    const currentExamId = examIdRef.current;
    if (!currentExamId) return;
    const epoch = sessionEpochRef.current;

    const requestId = ++loadRequestIdRef.current;
    setIsLoading(true);
    setError(null);

    emitExamSheetDebug('info', 'frontend:hook-state', `[Session] loadQuestions: examId=${currentExamId}`, { sessionId: currentExamId });

    try {
      const previousQuestionId = currentQuestionIdRef.current;
      const [result, stats] = await Promise.all([
        fetchAllQuestions(currentExamId, epoch, requestId),
        invoke<StoreStats | null>('qbank_get_stats', { examId: currentExamId }),
      ]);

      // Concurrent guard
      if (loadRequestIdRef.current !== requestId || sessionEpochRef.current !== epoch || examIdRef.current !== currentExamId) return;

      const questionsMap = new Map<string, StoreQuestion>();
      const order: string[] = [];
      result.questions.forEach(q => {
        questionsMap.set(q.id, q);
        order.push(q.id);
      });

      setLocalQuestions(questionsMap);
      setLocalOrder(order);
      setLocalStats(stats);
      // ★ 位置恢复优先级：会话内已有位置 > 上次持久化位置 > 第一题
      const persistedQuestionId = readLastQuestionId(currentExamId);
      const nextCurrentQuestionId =
        (previousQuestionId && questionsMap.has(previousQuestionId) && previousQuestionId) ||
        (persistedQuestionId && questionsMap.has(persistedQuestionId) && persistedQuestionId) ||
        (result.questions[0]?.id || null);
      setCurrentQuestionId(nextCurrentQuestionId);
      setPagination({ page: result.page, pageSize: result.page_size, total: result.total, hasMore: result.has_more });

      emitExamSheetDebug('success', 'frontend:hook-state',
        `[Session] loadQuestions OK: ${result.questions.length} questions, total=${result.total}, page=${result.page}`,
        { sessionId: currentExamId },
      );
    } catch (err: unknown) {
      if (loadRequestIdRef.current !== requestId || sessionEpochRef.current !== epoch || examIdRef.current !== currentExamId) return;
      debugLog.error('[useQuestionBankSession] loadQuestions failed:', err);
      setError(String(err));
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (loadRequestIdRef.current === requestId && sessionEpochRef.current === epoch) {
        setIsLoading(false);
      }
    }
  }, [fetchAllQuestions]);

  const loadQuestions = useCallback(async () => {
    await loadQuestionsImpl();
  }, [loadQuestionsImpl]);

  // 初始加载
  useEffect(() => {
    sessionEpochRef.current += 1;
    const epoch = sessionEpochRef.current;
    lastSubmissionIdsRef.current.clear();
    if (examId) {
      setLocalQuestions(new Map());
      setLocalOrder([]);
      setLocalStats(null);
      setCurrentQuestionId(null);
      setPagination({ page: 1, pageSize: PAGE_SIZE, total: 0, hasMore: false });
      setError(null);
      void loadQuestionsImpl().catch((err) => {
        if (sessionEpochRef.current === epoch) {
          debugLog.warn('[useQuestionBankSession] initial load failed:', err);
        }
      });
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
    const epoch = sessionEpochRef.current;
    // ★ 竞态守卫：loadMore 期间若有全量 reload 启动（loadRequestId 变化），
    //   丢弃本次追加，否则过期分页会拼进刚刷新的新列表
    const loadRequestIdAtStart = loadRequestIdRef.current;
    const nextPage = pagination.page + 1;

    setIsLoading(true);
    try {
      const result = await invoke<QuestionListResult>('qbank_list_questions', {
        request: { exam_id: currentExamId, filters: {}, page: nextPage, page_size: PAGE_SIZE },
      });
      if (
        sessionEpochRef.current !== epoch
        || examIdRef.current !== currentExamId
        || loadRequestIdRef.current !== loadRequestIdAtStart
      ) return;

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
      if (
        sessionEpochRef.current !== epoch
        || examIdRef.current !== currentExamId
        || loadRequestIdRef.current !== loadRequestIdAtStart
      ) return;
      debugLog.error('[useQuestionBankSession] loadMoreQuestions failed:', err);
      setError(String(err));
    } finally {
      // 有更新的全量 reload 在途时不重置 isLoading，交由该请求自己收尾
      if (sessionEpochRef.current === epoch && loadRequestIdRef.current === loadRequestIdAtStart) {
        setIsLoading(false);
      }
    }
  }, [isLoading, pagination.hasMore, pagination.page]);

  // ========== 刷新单题并同步统计 ==========
  const refreshQuestion = useCallback(async (questionId: string) => {
    const currentExamId = examIdRef.current;
    if (!currentExamId || !questionId) return;
    const epoch = sessionEpochRef.current;

    try {
      const [question, stats] = await Promise.all([
        invoke<StoreQuestion | null>('qbank_get_question', { questionId }),
        invoke<StoreStats>('qbank_refresh_stats', { examId: currentExamId }),
      ]);

      if (sessionEpochRef.current !== epoch || examIdRef.current !== currentExamId) return;

      setLocalStats(stats);
      if (!question) {
        setLocalQuestions(prev => {
          if (!prev.has(questionId)) return prev;
          const next = new Map(prev);
          next.delete(questionId);
          return next;
        });
        setLocalOrder(prev => prev.filter(id => id !== questionId));
        setCurrentQuestionId(prev => {
          if (prev !== questionId) return prev;
          const remainingIds = localOrderRef.current.filter(id => id !== questionId);
          return remainingIds[0] || null;
        });
        return;
      }

      setLocalQuestions(prev => {
        const next = new Map(prev);
        next.set(question.id, question);
        return next;
      });
      setLocalOrder(prev => (prev.includes(question.id) ? prev : [...prev, question.id]));
    } catch (err: unknown) {
      debugLog.error('[useQuestionBankSession] refreshQuestion failed:', err);
      if (sessionEpochRef.current === epoch) {
        setError(String(err));
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }, []);

  // ========== 提交答案 ==========
  const submitAnswer = useCallback(async (questionId: string, answer: string, isCorrectOverride?: boolean): Promise<SessionSubmitResult> => {
    if (submitInFlightRef.current) {
      throw new Error('Submission already in flight');
    }
    submitInFlightRef.current = true;
    const epoch = sessionEpochRef.current;
    const currentExamId = examIdRef.current;
    setIsSubmitting(true);
    try {
      // 自评改判：该题最近一次提交出自本会话时带上其 id，后端对该提交改判
      // 而非新插作答记录，避免"我答对了/我答错了"把 attempt_count 双计。
      const regradeSubmissionId = isCorrectOverride !== undefined
        ? lastSubmissionIdsRef.current.get(questionId) ?? null
        : null;
      const result = await invoke<SubmitAnswerResult>('qbank_submit_answer', {
        request: {
          question_id: questionId,
          user_answer: answer,
          is_correct_override: isCorrectOverride,
          client_request_id: generateClientRequestId(),
          regrade_submission_id: regradeSubmissionId,
        },
      });
      if (sessionEpochRef.current !== epoch || examIdRef.current !== currentExamId) {
        throw new Error('Session changed before answer submission completed');
      }

      // 本地更新 question + stats
      setLocalQuestions(prev => {
        const next = new Map(prev);
        next.set(result.updated_question.id, result.updated_question);
        return next;
      });
      setLocalStats(result.updated_stats);
      lastSubmissionIdsRef.current.set(questionId, result.submission_id);

      return {
        isCorrect: result.is_correct,
        correctAnswer: result.correct_answer,
        needsManualGrading: result.needs_manual_grading,
        message: result.message,
        submissionId: result.submission_id,
        // 权威 daily 快照透传（旧后端载荷无此键时保持 undefined）
        ...(result.daily_progress ? { dailyProgress: result.daily_progress } : {}),
      };
    } catch (err: unknown) {
      // 会话已切换时不把过期错误写进新会话的 error 状态
      if (sessionEpochRef.current === epoch && examIdRef.current === currentExamId) {
        setError(String(err));
      }
      throw err;
    } finally {
      submitInFlightRef.current = false;
      if (sessionEpochRef.current === epoch) {
        setIsSubmitting(false);
      }
    }
  }, []);

  // ========== 标记正确/错误 ==========
  const markCorrect = useCallback(async (questionId: string, isCorrect: boolean): Promise<SessionSubmitResult> => {
    const question = localQuestions.get(questionId);
    const userAnswer = question?.user_answer || '';
    // 结果（含权威 daily 快照）回传调用点：改判正是首答锁差量修正 +
    // 权威覆盖收敛最需要的路径，不能在这里吞掉。
    return await submitAnswer(questionId, userAnswer, isCorrect);
  }, [localQuestions, submitAnswer]);

  // ========== ★ 本地化导航（含 practiceMode） ==========
  const navigate = useCallback((index: number) => {
    if (localOrder.length === 0) return;
    // ★ 越界钳制：刷新/删除后题目数变化时，调用方持有的旧索引可能越界，
    //   钳到有效范围而非静默忽略，保证"跳最后一题"之类的操作仍然生效
    const clamped = Math.min(Math.max(index, 0), localOrder.length - 1);
    const questionId = localOrder[clamped] || null;
    setCurrentQuestionId(questionId);
    // ★ 持久化做题位置，重开恢复
    if (examIdRef.current && questionId) {
      writeLastQuestionId(examIdRef.current, questionId);
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
    const epoch = sessionEpochRef.current;
    try {
      const stats = await invoke<StoreStats>('qbank_refresh_stats', { examId: currentExamId });
      if (sessionEpochRef.current !== epoch || examIdRef.current !== currentExamId) return;
      setLocalStats(stats);
    } catch (err: unknown) {
      debugLog.error('[useQuestionBankSession] refreshStats failed:', err);
      if (sessionEpochRef.current === epoch) {
        setError(String(err));
      }
      throw err instanceof Error ? err : new Error(String(err));
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
    practiceSessionOwner,
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
    refreshQuestion,
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
