/**
 * 题目集会话 Hook
 * 
 * 封装 questionBankStore 与组件的集成逻辑，支持：
 * - 会话加载与状态同步
 * - 兼容现有 ExamContentView 接口
 */

import { useEffect, useCallback, useMemo, useRef } from 'react';
import { useQuestionBankStore, type Question as StoreQuestion, type QuestionBankStats as StoreStats, type PracticeMode } from '@/stores/questionBankStore';
import { useShallow } from 'zustand/react/shallow';
import { type Question, type QuestionBankStats, type SubmitResult } from '@/api/questionBankApi';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// 🆕 类型转换：Store (snake_case) -> API (camelCase)
function convertToApiQuestion(q: StoreQuestion): Question {
  return {
    id: q.id,
    cardId: q.card_id || q.id,
    questionLabel: q.question_label || '',
    content: q.content,
    ocrText: q.content, // KNOWN-ISSUE: ocr_text 未在 Store/Rust Question 中独立存储，当前与 content 相同
    questionType: q.question_type,
    options: q.options,
    answer: q.answer,
    explanation: q.explanation,
    difficulty: q.difficulty,
    tags: q.tags,
    status: q.status,
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
  // 数据（使用 API 类型，与组件兼容）
  questions: Question[];
  currentQuestion: Question | null;
  currentIndex: number;
  stats: QuestionBankStats | null;
  
  // 分页
  hasMore: boolean;
  pagination: { page: number; pageSize: number; total: number; hasMore: boolean };
  
  // 状态
  isLoading: boolean;
  isSubmitting: boolean;
  error: string | null;
  isMigrated: boolean;
  
  // Actions
  loadQuestions: () => Promise<void>;
  loadMoreQuestions: () => Promise<void>;
  submitAnswer: (questionId: string, answer: string, isCorrectOverride?: boolean) => Promise<SubmitResult>;
  markCorrect: (questionId: string, isCorrect: boolean) => Promise<void>;
  navigate: (index: number) => void;
  goNext: () => void;
  goPrev: () => void;
  toggleFavorite: (questionId: string) => Promise<void>;
  setPracticeMode: (mode: PracticeMode) => void;
  refreshStats: () => Promise<void>;
}

export function useQuestionBankSession({
  examId,
}: UseQuestionBankSessionOptions): UseQuestionBankSessionReturn {
  // 精细化 Store 订阅：只订阅需要的状态片段，避免不相关状态变化触发重渲染
  const {
    questions: storeQuestionsMap,
    questionOrder,
    currentQuestionId,
    stats: storeStats,
    isLoading,
    isSubmitting,
    error,
    pagination,
  } = useQuestionBankStore(useShallow(state => ({
    questions: state.questions,
    questionOrder: state.questionOrder,
    currentQuestionId: state.currentQuestionId,
    stats: state.stats,
    isLoading: state.isLoading,
    isSubmitting: state.isSubmitting,
    error: state.error,
    pagination: state.pagination,
  })));

  // Actions 使用稳定引用（不受 useShallow 影响）
  const loadQuestionsAction = useQuestionBankStore(state => state.loadQuestions);
  const loadStatsAction = useQuestionBankStore(state => state.loadStats);
  const submitAnswerAction = useQuestionBankStore(state => state.submitAnswer);
  const goToQuestion = useQuestionBankStore(state => state.goToQuestion);
  const goToNextQuestion = useQuestionBankStore(state => state.goToNextQuestion);
  const goToPrevQuestion = useQuestionBankStore(state => state.goToPrevQuestion);
  const loadMoreQuestionsAction = useQuestionBankStore(state => state.loadMoreQuestions);
  const refreshStatsAction = useQuestionBankStore(state => state.refreshStats);
  const toggleFavoriteAction = useQuestionBankStore(state => state.toggleFavorite);
  const setPracticeModeAction = useQuestionBankStore(state => state.setPracticeMode);
  const getCurrentQuestion = useQuestionBankStore(state => state.getCurrentQuestion);

  // 加载题目（使用 ref 避免循环依赖）
  const loadQuestionsRef = useRef<() => Promise<void>>();

  loadQuestionsRef.current = async () => {
    if (!examId) return;

    try {
      await loadQuestionsAction(examId);
      await loadStatsAction(examId);
    } catch (err: unknown) {
      debugLog.error('[useQuestionBankSession] loadQuestions failed:', err);
    }
  };

  // 稳定的 loadQuestions 引用
  const loadQuestions = useCallback(async () => {
    await loadQuestionsRef.current?.();
  }, []);

  // 初始加载（只在 examId 变化时触发）
  useEffect(() => {
    if (examId) {
      void loadQuestionsRef.current?.();
    }
  }, [examId]);

  // 提交答案（返回 API 兼容的 SubmitResult 类型）
  const submitAnswer = useCallback(async (questionId: string, answer: string, isCorrectOverride?: boolean): Promise<SubmitResult> => {
    const result = await submitAnswerAction(questionId, answer, isCorrectOverride);
    return {
      isCorrect: result.is_correct,
      correctAnswer: result.correct_answer,
      needsManualGrading: result.needs_manual_grading,
      message: result.message,
      submissionId: result.submission_id,
    };
  }, [submitAnswerAction]);

  // 标记正确/错误（用于主观题手动批改）
  // 🔧 修复：通过 submitAnswer 触发正确的状态转换逻辑
  const markCorrect = useCallback(async (questionId: string, isCorrect: boolean) => {
    // 获取当前问题的用户答案
    const question = storeQuestionsMap.get(questionId);
    const userAnswer = question?.user_answer || '';
    // 使用 submitAnswer 并传入 isCorrectOverride 来触发正确的状态更新
    await submitAnswerAction(questionId, userAnswer, isCorrect);
  }, [storeQuestionsMap, submitAnswerAction]);

  // 导航
  const navigate = useCallback((index: number) => {
    goToQuestion(index);
  }, [goToQuestion]);

  const goNext = useCallback(() => {
    goToNextQuestion();
  }, [goToNextQuestion]);

  const goPrev = useCallback(() => {
    goToPrevQuestion();
  }, [goToPrevQuestion]);

  // 加载更多题目（分页）
  const loadMoreQuestions = useCallback(async () => {
    if (!examId) return;
    await loadMoreQuestionsAction();
  }, [examId, loadMoreQuestionsAction]);

  const hasMore = pagination.hasMore;

  // 刷新统计
  const refreshStats = useCallback(async () => {
    if (!examId) return;
    await refreshStatsAction(examId);
  }, [examId, refreshStatsAction]);

  // 🆕 转换为 API 类型
  // M-024: 使用 questionOrder 保证题目顺序与服务端一致，而非依赖 Map 迭代顺序
  const storeQuestions = useMemo(() => {
    return questionOrder
      .map(id => storeQuestionsMap.get(id))
      .filter((q): q is NonNullable<typeof q> => q != null);
  }, [storeQuestionsMap, questionOrder]);
  const questions = useMemo(() => storeQuestions.map(convertToApiQuestion), [storeQuestions]);

  const storeCurrentQuestion = getCurrentQuestion();
  const currentQuestion = useMemo(
    () => storeCurrentQuestion ? convertToApiQuestion(storeCurrentQuestion) : null,
    [storeCurrentQuestion]
  );

  // M-024: 直接使用 questionOrder 计算索引，与 store 导航逻辑一致
  const currentIndex = useMemo(() => {
    if (!storeCurrentQuestion) return 0;
    const idx = questionOrder.indexOf(storeCurrentQuestion.id);
    return idx >= 0 ? idx : 0;
  }, [questionOrder, storeCurrentQuestion]);

  // 检查是否已有题目
  const isMigrated = questions.length > 0;

  // 🆕 转换统计类型
  const stats = useMemo(() => convertToApiStats(storeStats), [storeStats]);

  return {
    // 数据（已转换为 API 类型）
    questions,
    currentQuestion,
    currentIndex,
    stats,

    // 分页
    hasMore,
    pagination,

    // 状态
    isLoading,
    isSubmitting,
    error,
    isMigrated,

    // Actions
    loadQuestions,
    loadMoreQuestions,
    submitAnswer,
    markCorrect,
    navigate,
    goNext,
    goPrev,
    toggleFavorite: toggleFavoriteAction,
    setPracticeMode: setPracticeModeAction,
    refreshStats,
  };
}

export default useQuestionBankSession;
