import React, { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, RefreshCw, ScanLine, RotateCcw, ListOrdered, Shuffle, Tag, Clock, CalendarDays, FileText, Timer, BookOpen, Play, Pause, RotateCw } from 'lucide-react';
import { TauriAPI, type ExamSheetSessionDetail } from '@/utils/tauriApi';
import { NotionButton } from '@/components/ui/NotionButton';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { 
  getNextQuestionIndex,
  type Question,
  type QuestionBankStats,
  type PracticeMode,
  type QuestionType,
} from '@/api/questionBankApi';
import { invoke } from '@tauri-apps/api/core';
import { useQuestionBankSession } from '@/hooks/useQuestionBankSession';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { AppSelect } from '@/components/ui/app-menu';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { formatTime } from '@/utils/formatUtils';
import { emitExamSheetDebug } from '@/debug-panel/plugins/ExamSheetProcessingDebugPlugin';

const ExamSheetUploader = lazy(() => import('@/components/ExamSheetUploader'));
const QuestionBankEditor = lazy(() => import('@/components/QuestionBankEditor'));
const QuestionBankListView = lazy(() => import('@/components/QuestionBankListView'));
const ReviewQuestionsView = lazy(() => import('@/components/ReviewQuestionsView'));
const TagNavigationView = lazy(() => import('@/components/TagNavigationView'));
const PracticeLauncher = lazy(() => import('@/components/practice/PracticeLauncher'));

type ViewMode = 'list' | 'manage' | 'practice' | 'upload' | 'review' | 'tags' | 'launcher';

const MODE_CONFIG: Record<PracticeMode, { labelKey: string; icon: React.ElementType; descKey: string }> = {
  sequential: { labelKey: 'learningHub:exam.mode.sequential', icon: ListOrdered, descKey: 'learningHub:exam.mode.sequentialDesc' },
  random: { labelKey: 'learningHub:exam.mode.random', icon: Shuffle, descKey: 'learningHub:exam.mode.randomDesc' },
  review_first: { labelKey: 'learningHub:exam.mode.reviewFirst', icon: RotateCcw, descKey: 'learningHub:exam.mode.reviewFirstDesc' },
  review_only: { labelKey: 'learningHub:exam.mode.reviewOnly', icon: RotateCcw, descKey: 'learningHub:exam.mode.reviewOnlyDesc' },
  by_tag: { labelKey: 'learningHub:exam.mode.byTag', icon: Tag, descKey: 'learningHub:exam.mode.byTagDesc' },
  daily: { labelKey: 'learningHub:exam.mode.daily', icon: CalendarDays, descKey: 'learningHub:exam.mode.dailyDesc' },
  paper: { labelKey: 'learningHub:exam.mode.paper', icon: FileText, descKey: 'learningHub:exam.mode.paperDesc' },
  timed: { labelKey: 'learningHub:exam.mode.timed', icon: Timer, descKey: 'learningHub:exam.mode.timedDesc' },
  mock_exam: { labelKey: 'learningHub:exam.mode.mockExam', icon: BookOpen, descKey: 'learningHub:exam.mode.mockExamDesc' },
};

const ExamContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
  readOnly = false,
  isActive,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'learningHub']);

  const MODE_OPTIONS = useMemo(() =>
    Object.entries(MODE_CONFIG).map(([value, { labelKey }]) => ({ value, label: t(labelKey) })),
    [t]
  );

  const sessionId = node.id;
  emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] 渲染: sessionId=${sessionId}, node.name=${node.name}`, { sessionId });

  // 🆕 2026-01 改造：使用 useQuestionBankSession Hook 管理题目状态
  const {
    questions,
    currentIndex,
    stats,
    isLoading,
    error,
    loadQuestions,
    submitAnswer,
    markCorrect,
    navigate,
    setPracticeMode: setStorePracticeMode,
    practiceMode,
    refreshStats,
  } = useQuestionBankSession({ examId: sessionId });

  // 专注模式（从 Store 获取 — 全局 UI 偏好，不需要本地化）
  const focusMode = useQuestionBankStore(state => state.focusMode);
  const setFocusMode = useQuestionBankStore(state => state.setFocusMode);
  const checkSyncStatus = useQuestionBankStore(state => state.checkSyncStatus);
  const setMockExamSession = useQuestionBankStore(state => state.setMockExamSession);

  // 高级练习模式会话数据（全局 store）
  const mockExamSession = useQuestionBankStore(state => state.mockExamSession);
  const timedSession = useQuestionBankStore(state => state.timedSession);
  const dailyPractice = useQuestionBankStore(state => state.dailyPractice);
  const generatedPaper = useQuestionBankStore(state => state.generatedPaper);

  // 仅使用当前题目集的高级模式会话，避免跨题目集串会话
  const activeMockExamSession = useMemo(
    () => (mockExamSession?.exam_id === sessionId ? mockExamSession : null),
    [mockExamSession, sessionId],
  );
  const activeTimedSession = useMemo(
    () => (timedSession?.exam_id === sessionId ? timedSession : null),
    [timedSession, sessionId],
  );
  const activeDailyPractice = useMemo(
    () => (dailyPractice?.exam_id === sessionId ? dailyPractice : null),
    [dailyPractice, sessionId],
  );
  const activeGeneratedPaper = useMemo(
    () => (generatedPaper?.exam_id === sessionId ? generatedPaper : null),
    [generatedPaper, sessionId],
  );

  // UI 状态（保留在组件内）
  const [sessionDetail, setSessionDetail] = useState<ExamSheetSessionDetail | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedTag, setSelectedTag] = useState<string>('');
  
  // 计时器状态
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // 计时器逻辑
  // ★ 标签页：isActive === false 时暂停计时器，避免后台计时不精确
  useEffect(() => {
    if (viewMode === 'practice' && isTimerRunning && isActive !== false) {
      timerRef.current = setInterval(() => {
        setElapsedTime(prev => prev + 1);
      }, 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [viewMode, isTimerRunning, isActive]);
  
  // 进入做题模式时自动开始计时
  useEffect(() => {
    if (viewMode === 'practice') {
      setIsTimerRunning(true);
    } else {
      setIsTimerRunning(false);
    }
  }, [viewMode]);

  useEffect(() => {
    setElapsedTime(0);
  }, [sessionId]);
  
  const toggleTimer = useCallback(() => {
    setIsTimerRunning(prev => !prev);
  }, []);

  // 🆕 加载 sessionDetail（仅用于 ExamSheetUploader 等需要原始 preview 的组件）
  const loadSessionDetail = useCallback(async () => {
    if (!sessionId) return;
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] loadSessionDetail 开始: ${sessionId}`, { sessionId });
    try {
      const detail = await TauriAPI.getExamSheetSessionDetail(sessionId);
      emitExamSheetDebug('success', 'frontend:hook-state', `[ExamContentView] loadSessionDetail 成功: status=${detail.summary.status}, pages=${detail.preview.pages?.length ?? 0}`, { sessionId, detail: { status: detail.summary.status, pageCount: detail.preview.pages?.length, cardCount: detail.preview.pages?.reduce((s, p) => s + (p.cards?.length ?? 0), 0) } });
      setSessionDetail(detail);
    } catch (err: unknown) {
      emitExamSheetDebug('error', 'frontend:hook-state', `[ExamContentView] loadSessionDetail 失败: ${err}`, { sessionId });
      console.error('[ExamContentView] Failed to load session detail:', err);
      setSessionDetail({
        summary: {
          id: sessionId,
          exam_name: node.name || null,
          mistake_id: sessionId,
          created_at: new Date(node.createdAt).toISOString(),
          updated_at: new Date(node.updatedAt).toISOString(),
          status: 'empty',
          metadata: null,
          linked_mistake_ids: null,
        },
        preview: {
          session_id: sessionId,
          mistake_id: sessionId,
          exam_name: node.name || null,
          pages: [],
        },
      });
    }
  }, [sessionId, node]);

  useEffect(() => {
    void loadSessionDetail();
  }, [loadSessionDetail, node.id]);

  // M-025: 加载时检查同步状态
  useEffect(() => {
    if (!sessionId) return;
    checkSyncStatus(sessionId).then(status => {
      if (status && status.pending_conflict_count > 0) {
        showGlobalNotification('warning', t('learningHub:exam.syncConflictWarning', {
          count: status.pending_conflict_count,
        }));
      }
    }).catch(err => {
      debugLog.warn('[ExamContentView] sync status check failed:', err);
    });
  }, [sessionId, checkSyncStatus, t]);

  const handleSessionUpdate = useCallback(async (detail: ExamSheetSessionDetail) => {
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] handleSessionUpdate: pages=${detail.preview.pages?.length}, cards=${detail.preview.pages?.reduce((s, p) => s + (p.cards?.length ?? 0), 0)}`, { sessionId });
    setSessionDetail(detail);
    // 🆕 刷新 Store 中的题目和统计
    await loadQuestions();
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] handleSessionUpdate 完成, questions.length=${questions.length}`, { sessionId });
  }, [loadQuestions, questions.length, sessionId]);

  // 🆕 使用 Hook 的 submitAnswer（已改名避免冲突）
  const handleSubmitAnswer = useCallback(async (questionId: string, answer: string, questionType?: QuestionType) => {
    if (!sessionId) throw new Error('No session');
    const result = await submitAnswer(questionId, answer);

    // mock_exam 依赖 session.answers/results 做进度与成绩计算，提交后同步回写
    if (
      practiceMode === 'mock_exam' &&
      activeMockExamSession &&
      !activeMockExamSession.is_submitted &&
      activeMockExamSession.question_ids.includes(questionId)
    ) {
      const nextAnswers = { ...activeMockExamSession.answers, [questionId]: answer };
      const nextResults = { ...activeMockExamSession.results };
      if (result.isCorrect === true || result.isCorrect === false) {
        nextResults[questionId] = result.isCorrect;
      } else {
        delete nextResults[questionId];
      }
      setMockExamSession({
        ...activeMockExamSession,
        answers: nextAnswers,
        results: nextResults,
      });
    }

    return result;
  }, [sessionId, submitAnswer, practiceMode, activeMockExamSession, setMockExamSession]);

  // 🆕 使用 Hook 的 markCorrect
  const handleMarkCorrect = useCallback(async (questionId: string, isCorrect: boolean) => {
    if (!sessionId) return;
    await markCorrect(questionId, isCorrect);
  }, [sessionId, markCorrect]);

  // 🆕 使用 Hook 的 navigate
  const handleNavigate = useCallback((index: number) => {
    navigate(index);
  }, [navigate]);

  // 🆕 更新 Store 练习模式（Store 是 SSOT，无本地 state）
  const handleModeChange = useCallback((mode: PracticeMode, tag?: string) => {
    setStorePracticeMode(mode);
    if (tag) setSelectedTag(tag);
    const nextIdx = getNextQuestionIndex(questions, currentIndex, mode, tag);
    navigate(nextIdx);
  }, [questions, currentIndex, navigate, setStorePracticeMode]);

  // 点击题目进入做题模式（必须在条件返回之前定义）
  const handleQuestionClick = useCallback((index: number) => {
    navigate(index);
    setViewMode('practice');
  }, [navigate]);

  // 高级模式题目过滤：根据 session 的 question_ids 过滤出子集
  const practiceQuestions = useMemo(() => {
    switch (practiceMode) {
      case 'mock_exam': {
        if (!activeMockExamSession?.question_ids?.length) return questions;
        const idSet = new Set(activeMockExamSession.question_ids);
        return questions.filter(q => idSet.has(q.id));
      }
      case 'timed': {
        if (!activeTimedSession?.question_ids?.length) return questions;
        const idSet = new Set(activeTimedSession.question_ids);
        return questions.filter(q => idSet.has(q.id));
      }
      case 'daily': {
        if (!activeDailyPractice?.question_ids?.length) return questions;
        const idSet = new Set(activeDailyPractice.question_ids);
        return questions.filter(q => idSet.has(q.id));
      }
      case 'paper': {
        if (!activeGeneratedPaper?.questions?.length) return questions;
        const idSet = new Set(activeGeneratedPaper.questions.map(q => q.id));
        return questions.filter(q => idSet.has(q.id));
      }
      default:
        return questions;
    }
  }, [practiceMode, questions, activeMockExamSession, activeTimedSession, activeDailyPractice, activeGeneratedPaper]);

  // 高级模式下 currentIndex 需要映射到过滤后的子集
  const practiceCurrentIndex = useMemo(() => {
    if (practiceQuestions === questions) return currentIndex;
    // 找到当前题目在过滤子集中的位置
    const currentQ = questions[currentIndex];
    if (!currentQ) return 0;
    const idx = practiceQuestions.findIndex(q => q.id === currentQ.id);
    return idx >= 0 ? idx : 0;
  }, [practiceQuestions, questions, currentIndex]);

  // PracticeLauncher 的 onStartPractice 回调
  const handleStartPractice = useCallback((mode: PracticeMode, tag?: string) => {
    setElapsedTime(0);
    setStorePracticeMode(mode);
    if (tag) setSelectedTag(tag);
    // 对于高级模式，navigate 到过滤子集的第一题
    if (['mock_exam', 'timed', 'daily', 'paper'].includes(mode)) {
      // 高级模式的 question_ids 已经在全局 store 中设置好了
      // 找到第一个匹配的题目在全量 questions 中的索引
      let sessionQuestionIds: string[] = [];
      if (mode === 'mock_exam') sessionQuestionIds = activeMockExamSession?.question_ids || [];
      else if (mode === 'timed') sessionQuestionIds = activeTimedSession?.question_ids || [];
      else if (mode === 'daily') sessionQuestionIds = activeDailyPractice?.question_ids || [];
      else if (mode === 'paper') sessionQuestionIds = activeGeneratedPaper?.questions?.map(q => q.id) || [];
      
      if (sessionQuestionIds.length > 0) {
        const firstId = sessionQuestionIds[0];
        const idx = questions.findIndex(q => q.id === firstId);
        if (idx >= 0) navigate(idx);
      }
    } else {
      const nextIdx = getNextQuestionIndex(questions, currentIndex, mode, tag);
      navigate(nextIdx);
    }
    setViewMode('practice');
  }, [questions, currentIndex, navigate, setStorePracticeMode, activeMockExamSession, activeTimedSession, activeDailyPractice, activeGeneratedPaper]);

  const refreshQuestionsAndStats = useCallback(async () => {
    await Promise.all([loadQuestions(), refreshStats()]);
  }, [loadQuestions, refreshStats]);

  const executeMutation = useCallback(
    async (
      mutation: () => Promise<void>,
      errorMessage: string,
      refreshMode: 'questions' | 'all' = 'all'
    ) => {
      try {
        await mutation();
        if (refreshMode === 'all') {
          await refreshQuestionsAndStats();
        } else {
          await loadQuestions();
        }
      } catch (err: unknown) {
        showGlobalNotification('error', err, errorMessage);
      }
    },
    [loadQuestions, refreshQuestionsAndStats]
  );

  const handleResetProgress = useCallback(
    async (ids: string[]) => {
      await executeMutation(
        async () => {
          const result = await invoke<{ success_count: number; failed_count: number; errors: string[] }>('qbank_reset_questions_progress', { questionIds: ids });
          if (result.failed_count > 0) {
            showGlobalNotification('warning', t('learningHub:exam.partialResetFailed', {
              success: result.success_count,
              failed: result.failed_count,
            }));
          }
        },
        t('learningHub:exam.error.resetProgressFailed')
      );
    },
    [executeMutation, t]
  );

  const handleDeleteQuestions = useCallback(
    async (ids: string[]) => {
      await executeMutation(
        async () => {
          const result = await invoke<{ success_count: number; failed_count: number; errors: string[] }>('qbank_batch_delete_questions', { questionIds: ids });
          if (result.failed_count > 0) {
            showGlobalNotification('warning', t('learningHub:exam.partialDeleteFailed', {
              success: result.success_count,
              failed: result.failed_count,
            }));
          }
        },
        t('learningHub:exam.error.deleteQuestionsFailed')
      );
    },
    [executeMutation, t]
  );

  const handleToggleFavorite = useCallback(
    async (id: string) => {
      await executeMutation(
        async () => {
          await invoke('qbank_toggle_favorite', { questionId: id });
        },
        t('learningHub:exam.error.toggleFavoriteFailed'),
        'questions'
      );
    },
    [executeMutation, t]
  );

  const handleUpdateQuestion = useCallback(
    async (id: string, data: { answer?: string; explanation?: string; difficulty?: string; tags?: string[]; userNote?: string }) => {
      await executeMutation(
        async () => {
          await invoke('qbank_update_question', {
            request: {
              question_id: id,
              params: {
                answer: data.answer,
                explanation: data.explanation,
                difficulty: data.difficulty,
                tags: data.tags,
                user_note: data.userNote,
              },
              record_history: true,
            },
          });
        },
        t('learningHub:exam.error.updateQuestionFailed'),
        'questions'
      );
    },
    [executeMutation, t]
  );

  const handleDeleteQuestion = useCallback(
    async (id: string) => {
      await executeMutation(
        async () => {
          await invoke('qbank_delete_question', { questionId: id });
        },
        t('learningHub:exam.error.deleteQuestionFailed')
      );
    },
    [executeMutation, t]
  );

  // ★ 断点续导：检测 importing 状态
  const isImportingSession = sessionDetail?.summary.status === 'importing';
  const [isResuming, setIsResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  const handleResumeImport = useCallback(async () => {
    if (!sessionId || isResuming) return;
    setIsResuming(true);
    setResumeError(null);
    try {
      const detail = await TauriAPI.resumeQuestionImport(sessionId);
      setSessionDetail(detail);
      await loadQuestions();
      showGlobalNotification('success', t('exam_sheet:uploader.resume_success', '导入恢复完成'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setResumeError(msg);
      debugLog.error('[ExamContentView] resume import failed:', err);
    } finally {
      setIsResuming(false);
    }
  }, [sessionId, isResuming, loadQuestions, t]);

  const isEmptySession = sessionDetail?.summary.status === 'empty' && 
    (!sessionDetail?.preview.pages || sessionDetail.preview.pages.length === 0);

  const hasQuestions = questions.length > 0;

  emitExamSheetDebug('debug', 'frontend:hook-state',
    `[ExamContentView] 渲染决策: isEmptySession=${isEmptySession}, hasQuestions=${hasQuestions}(${questions.length}), viewMode=${viewMode}, isLoading=${isLoading}, sessionDetail.status=${sessionDetail?.summary?.status ?? 'null'}, error=${error ?? 'null'}`,
    { sessionId },
  );

  // 空会话自动进入上传模式（只读模式下不自动切换）
  useEffect(() => {
    if (isEmptySession && viewMode === 'list' && !readOnly) {
      emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] 空会话自动切换到 upload 模式`, { sessionId });
      setViewMode('upload');
    }
  }, [isEmptySession, viewMode, readOnly, sessionId]);

  // ========== 条件返回（早期退出） ==========
  
  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <AlertCircle className="w-8 h-8 text-muted-foreground mb-2" />
        <span className="text-muted-foreground">
          {t('exam_sheet:errors.noSession', '未指定整卷会话')}
        </span>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading', '加载中...')}
        </span>
      </div>
    );
  }

  if (error && !sessionDetail) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <AlertCircle className="w-8 h-8 text-destructive" />
        <span className="text-muted-foreground text-center max-w-md">
          {t('exam_sheet:errors.loadFailed', '加载整卷会话失败')}: {error}
        </span>
        <NotionButton variant="ghost" size="sm" onClick={loadSessionDetail} className="gap-2">
          <RefreshCw className="w-4 h-4" />
          {t('common:actions.retry', '重试')}
        </NotionButton>
      </div>
    );
  }

  if (!sessionDetail) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <AlertCircle className="w-8 h-8 text-muted-foreground mb-2" />
        <span className="text-muted-foreground">
          {t('exam_sheet:errors.sessionNotFound', '未找到整卷会话')}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ★ 断点续导：importing 状态横幅 */}
      {isImportingSession && (
        <div className="flex-shrink-0 px-3 sm:px-4 py-2.5 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800/40">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <span className="text-sm text-amber-800 dark:text-amber-200 truncate">
                {t('exam_sheet:uploader.import_interrupted', { count: questions.length })}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {resumeError && (
                <span className="text-xs text-destructive max-w-[200px] truncate" title={resumeError}>
                  {resumeError}
                </span>
              )}
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={handleResumeImport}
                disabled={isResuming}
                className="gap-1.5 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40"
              >
                {isResuming ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <RotateCw className="w-3.5 h-3.5" />
                )}
                {isResuming
                  ? t('exam_sheet:uploader.resuming', '恢复中...')
                  : t('exam_sheet:uploader.resume_import', '继续导入')
                }
              </NotionButton>
            </div>
          </div>
        </div>
      )}

      {/* Tab 栏 */}
      <div className="flex-shrink-0 px-3 sm:px-4 py-2.5 border-b border-border/40">
        <div className="flex items-center justify-between gap-2">
          {/* 左侧 Tab - 允许横向滚动 */}
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-none">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setViewMode('list')}
              disabled={!hasQuestions && viewMode !== 'upload'}
              className={cn(
                'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                viewMode === 'list' 
                  ? 'bg-foreground text-background font-medium' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                (!hasQuestions && viewMode !== 'upload') && 'opacity-50 cursor-not-allowed'
              )}
            >
              {t('learningHub:exam.tab.questionBank')}
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setViewMode('launcher')}
              disabled={!hasQuestions}
              className={cn(
                'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                (viewMode === 'practice' || viewMode === 'launcher')
                  ? 'bg-foreground text-background font-medium' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
                !hasQuestions && 'opacity-50 cursor-not-allowed'
              )}
            >
              {t('learningHub:exam.tab.practice')}
            </NotionButton>
            {hasQuestions && stats && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => setViewMode('review')}
                className={cn(
                  'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1 whitespace-nowrap flex-shrink-0',
                  viewMode === 'review' 
                    ? 'bg-amber-500 text-white font-medium' 
                    : stats.review > 0 
                      ? 'text-amber-600 dark:text-amber-400 hover:bg-amber-500/10'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
              >
                {t('learningHub:exam.tab.wrongAnswers')}
                <span className={cn(
                  "text-xs opacity-80",
                  stats.review === 0 && viewMode !== 'review' && "text-muted-foreground"
                )}>{stats.review}</span>
              </NotionButton>
            )}
            {hasQuestions && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => setViewMode('tags')}
                className={cn(
                  'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                  viewMode === 'tags' 
                    ? 'bg-foreground text-background font-medium' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                )}
              >
                {t('learningHub:exam.tab.topics')}
              </NotionButton>
            )}
            
            {(viewMode === 'practice') && hasQuestions && (
              <>
                <div className="w-px h-4 bg-border/60 mx-1 sm:mx-2 flex-shrink-0" />
                <AppSelect value={practiceMode} onValueChange={(v) => handleModeChange(v as PracticeMode)}
                  options={MODE_OPTIONS}
                  size="sm"
                  variant="ghost"
                  className="h-7 sm:h-8 text-xs px-2 border-0 bg-muted/30 hover:bg-muted/50 flex-shrink-0"
                />
                
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={toggleTimer}
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors text-sm flex-shrink-0',
                    isTimerRunning ? 'text-primary bg-primary/5 hover:bg-primary/10' : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                  title={isTimerRunning ? t('learningHub:exam.timer.pause', '暂停') : t('learningHub:exam.timer.resume', '继续')}
                >
                  {isTimerRunning ? (
                    <Pause className="w-3.5 h-3.5" />
                  ) : (
                    <Play className="w-3.5 h-3.5" />
                  )}
                  <span className={cn("font-mono tabular-nums text-xs", !isTimerRunning && "animate-pulse")}>
                    {formatTime(elapsedTime)}
                  </span>
                </NotionButton>
              </>
            )}
          </div>
          
          {/* 右侧添加按钮（只读模式下隐藏） */}
          {!readOnly && (
            <div className="flex items-center flex-shrink-0">
              <NotionButton
                variant={viewMode === 'upload' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setViewMode('upload')}
                className="h-7 sm:h-8 px-2.5 sm:px-3 gap-1.5"
              >
                <ScanLine className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('learningHub:exam.tab.add')}</span>
              </NotionButton>
            </div>
          )}
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">
                {t('common:loading', '加载中...')}
              </span>
            </div>
          }
        >
          {viewMode === 'launcher' && hasQuestions ? (
            /* 练习启动页 — 选择练习模式 */
            <PracticeLauncher
              examId={sessionId}
              stats={stats}
              questions={questions}
              onStartPractice={handleStartPractice}
            />
          ) : viewMode === 'tags' && hasQuestions ? (
            /* 知识点导航视图 */
            <TagNavigationView
              questions={questions}
              onQuestionClick={handleQuestionClick}
              onStartPracticeByTag={(tag) => {
                setSelectedTag(tag);
                handleModeChange('by_tag', tag);
                setViewMode('practice');
              }}
            />
          ) : viewMode === 'review' && hasQuestions ? (
            /* 错题本视图 */
            <ReviewQuestionsView
              questions={questions}
              stats={stats}
              onQuestionClick={handleQuestionClick}
              onStartReview={() => {
                handleModeChange('review_first');
                setViewMode('practice');
              }}
              onResetProgress={readOnly ? undefined : handleResetProgress}
              onDelete={readOnly ? undefined : handleDeleteQuestions}
            />
          ) : viewMode === 'upload' && !readOnly ? (
            <ExamSheetUploader
              sessionId={sessionId}
              sessionName={sessionDetail?.summary?.exam_name || node.name}
              onUploadSuccess={async (detail) => {
                emitExamSheetDebug('info', 'frontend:navigate', `[ExamContentView] onUploadSuccess 触发, pages=${detail.preview.pages?.length}`, { sessionId });
                await handleSessionUpdate(detail);
                emitExamSheetDebug('info', 'frontend:navigate', `[ExamContentView] onUploadSuccess 完成 → setViewMode('list'), questions=${questions.length}`, { sessionId });
                setViewMode('list');
              }}
              onBack={() => hasQuestions ? setViewMode('list') : onClose?.()}
            />
          ) : viewMode === 'practice' && hasQuestions ? (
            <QuestionBankEditor
              sessionId={sessionId}
              questions={practiceQuestions}
              stats={stats}
              currentIndex={practiceCurrentIndex}
              practiceMode={practiceMode}
              selectedTag={selectedTag}
              focusMode={focusMode}
              onFocusModeChange={setFocusMode}
              isActive={isActive}
              onSubmitAnswer={readOnly ? undefined : handleSubmitAnswer}
              onNavigate={(index: number) => {
                // 将过滤子集的 index 映射回全量 questions 的 index
                if (practiceQuestions !== questions) {
                  const targetQ = practiceQuestions[index];
                  if (targetQ) {
                    const realIdx = questions.findIndex(q => q.id === targetQ.id);
                    if (realIdx >= 0) { handleNavigate(realIdx); return; }
                  }
                }
                handleNavigate(index);
              }}
              onModeChange={handleModeChange}
              onMarkCorrect={readOnly ? undefined : handleMarkCorrect}
              onToggleFavorite={readOnly ? undefined : (id, _isFavorite) => handleToggleFavorite(id)}
              onUpdateQuestion={readOnly ? undefined : handleUpdateQuestion}
              onUpdateUserNote={readOnly ? undefined : async (questionId: string, note: string) => {
                await handleUpdateQuestion(questionId, { userNote: note });
              }}
              onDeleteQuestion={readOnly ? undefined : handleDeleteQuestion}
              onBack={() => setViewMode('launcher')}
            />
          ) : (
            /* 列表视图 - 内联编辑 */
            <QuestionBankListView
              questions={questions}
              stats={stats}
              examId={sessionId}
              onQuestionClick={handleQuestionClick}
              onDelete={readOnly ? undefined : handleDeleteQuestions}
              onResetProgress={readOnly ? undefined : handleResetProgress}
              onUpdateQuestion={readOnly ? undefined : async () => {
                // QuestionInlineEditor 已经保存到后端，这里只需刷新本地数据
                await refreshQuestionsAndStats();
              }}
              onCreateQuestion={readOnly ? undefined : async () => {
                await refreshQuestionsAndStats();
              }}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
};

export default ExamContentView;
