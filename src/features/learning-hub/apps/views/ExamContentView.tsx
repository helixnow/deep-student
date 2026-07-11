import React, { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, WarningCircle, ArrowClockwise, Scan, ArrowCounterClockwise, ListNumbers, Shuffle, Tag, Clock, CalendarBlank, FileText, Timer, BookOpen, Play, Pause, ArrowClockwise as RotateCw, GearSix, ChartBar, Star, Download } from '@phosphor-icons/react';
import { TauriAPI, type ExamSheetSessionDetail } from '@/utils/tauriApi';
import { NotionButton } from '@/components/ui/NotionButton';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { 
  getNextQuestionIndex,
  type Question,
  type PracticeMode,
  type QuestionType,
  type QuestionStatus,
  type Difficulty,
} from '@/api/questionBankApi';
import { invoke } from '@tauri-apps/api/core';
import { useQuestionBankSession } from '@/hooks/useQuestionBankSession';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import SyncConflictDialog from '@/components/SyncConflictDialog';
import { AppSelect } from '@/components/ui/app-menu';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { formatTime } from '@/utils/formatUtils';
import { emitExamSheetDebug } from '@/debug-panel/plugins/ExamSheetProcessingDebugPlugin';
import {
  QBANK_FOCUS_EVENT,
  type QbankFocusEventDetail,
  QBANK_REFRESH_EVENT,
  isQbankInlineEditorActive,
} from '@/features/workbench/agent/drivers/qbankDriver';
import { collectDomainEntityIds } from '@/features/workbench/agent/domainEvents';
import { agentFlash } from '@/features/workbench/agent/visuals/agentFlash';
import type { DomainChangePayload } from '@/features/workbench/agent/types';

const ExamSheetUploader = lazy(() => import('@/components/ExamSheetUploader'));
const QuestionBankEditor = lazy(() => import('@/components/QuestionBankEditor'));
const QuestionBankListView = lazy(() => import('@/components/QuestionBankListView'));
const QuestionBankManageView = lazy(() => import('@/components/QuestionBankManageView'));
const QuestionBankStatsView = lazy(() => import('@/components/QuestionBankStatsView'));
const QuestionFavoritesView = lazy(() => import('@/components/QuestionFavoritesView'));
const QuestionHistoryView = lazy(() => import('@/components/QuestionHistoryView'));
const ReviewQuestionsView = lazy(() => import('@/components/ReviewQuestionsView'));
// ★ I1 修复：接入 SM-2 间隔复习系统（复习计划 + 复习会话）
const ReviewPlanView = lazy(() => import('@/components/ReviewPlanView'));
const ReviewSession = lazy(() => import('@/components/ReviewSession'));
const TagNavigationView = lazy(() => import('@/components/TagNavigationView'));
const PracticeLauncher = lazy(() => import('@/components/practice/PracticeLauncher'));
const CsvImportDialog = lazy(() => import('@/components/CsvImportDialog'));
const QuestionBankExportDialog = lazy(() => import('@/components/QuestionBankExportDialog'));

type ViewMode = 'list' | 'manage' | 'stats' | 'favorites' | 'practice' | 'upload' | 'review' | 'sm2' | 'tags' | 'launcher';

/**
 * ★ I1 修复：SM-2 间隔复习面板
 *
 * 有活跃复习会话时渲染 ReviewSession（答题打分），否则渲染 ReviewPlanView
 * （今日到期/复习队列/开始复习）。会话由 reviewPlanStore 全局管理。
 */
const Sm2ReviewPanel: React.FC<{ examId: string }> = ({ examId }) => {
  const isSessionActive = useReviewPlanStore((s) => s.session.isActive);
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <Suspense fallback={null}>
        {isSessionActive ? <ReviewSession /> : <ReviewPlanView examId={examId} />}
      </Suspense>
    </div>
  );
};

interface ManageFilters {
  search?: string;
  status?: QuestionStatus[];
  difficulty?: Difficulty[];
  questionType?: QuestionType[];
  isFavorite?: boolean;
}

const MODE_CONFIG: Record<PracticeMode, { labelKey: string; icon: React.ElementType; descKey: string }> = {
  sequential: { labelKey: 'learningHub:exam.mode.sequential', icon: ListNumbers, descKey: 'learningHub:exam.mode.sequentialDesc' },
  random: { labelKey: 'learningHub:exam.mode.random', icon: Shuffle, descKey: 'learningHub:exam.mode.randomDesc' },
  review_first: { labelKey: 'learningHub:exam.mode.reviewFirst', icon: ArrowCounterClockwise, descKey: 'learningHub:exam.mode.reviewFirstDesc' },
  review_only: { labelKey: 'learningHub:exam.mode.reviewOnly', icon: ArrowCounterClockwise, descKey: 'learningHub:exam.mode.reviewOnlyDesc' },
  by_tag: { labelKey: 'learningHub:exam.mode.byTag', icon: Tag, descKey: 'learningHub:exam.mode.byTagDesc' },
  daily: { labelKey: 'learningHub:exam.mode.daily', icon: CalendarBlank, descKey: 'learningHub:exam.mode.dailyDesc' },
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

  // 移动端触控目标 ≥44px（契约第 5 条）；桌面端（≥768px）不受影响
  const touchTargetClass = 'max-md:min-h-11';

  const sessionId = node.id;

  // 渲染日志放入 effect，保持 render 纯函数（避免 StrictMode 双调用产生重复日志）
  useEffect(() => {
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] 渲染: sessionId=${sessionId}, node.name=${node.name}`, { sessionId });
  }, [sessionId, node.name]);

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
    refreshQuestion,
  } = useQuestionBankSession({ examId: sessionId });

  // 专注模式（从 Store 获取 — 全局 UI 偏好，不需要本地化）
  const focusMode = useQuestionBankStore(state => state.focusMode);
  const setFocusMode = useQuestionBankStore(state => state.setFocusMode);
  const checkSyncStatus = useQuestionBankStore(state => state.checkSyncStatus);
  const getSyncConflicts = useQuestionBankStore(state => state.getSyncConflicts);
  const syncConflicts = useQuestionBankStore(state => state.syncConflicts);
  const setMockExamSession = useQuestionBankStore(state => state.setMockExamSession);
  const setTimedSession = useQuestionBankStore(state => state.setTimedSession);
  const submitMockExam = useQuestionBankStore(state => state.submitMockExam);

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
  const [sessionDetailError, setSessionDetailError] = useState<string | null>(null);
  const [showSyncConflictDialog, setShowSyncConflictDialog] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [showCsvImportDialog, setShowCsvImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [historyQuestionId, setHistoryQuestionId] = useState<string | null>(null);
  const [manageFilters, setManageFilters] = useState<ManageFilters>({});

  // 视图切换走 transition：懒加载 chunk 未就绪时保持当前视图渲染，
  // 避免整个内容区退化为 Suspense fallback 的闪烁
  const switchViewMode = useCallback((mode: ViewMode) => {
    startTransition(() => {
      setViewMode(mode);
    });
  }, []);

  // 管理视图筛选（搜索逐键触发大列表过滤）降级为 transition，保持输入流畅
  const handleFilterChange = useCallback((filters: ManageFilters) => {
    startTransition(() => {
      setManageFilters(filters);
    });
  }, []);
  
  // 计时器状态
  const [elapsedTime, setElapsedTime] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const mockExamTimeoutHandledRef = useRef<string | null>(null);
  const timedTimeoutHandledRef = useRef<string | null>(null);
  
  // 进入做题模式时自动开始计时
  useEffect(() => {
    if (viewMode === 'practice') {
      setIsTimerRunning(true);
    } else {
      setIsTimerRunning(false);
    }
  }, [viewMode]);

  // ★ 会话切换：记录最新 sessionId（异步回调的过期守卫），并重置上一会话的 UI 状态，
  //   防止旧会话的详情/错误/弹窗/筛选串到新会话（快速切换场景）
  const latestSessionIdRef = useRef(sessionId);
  useEffect(() => {
    latestSessionIdRef.current = sessionId;
    setElapsedTime(0);
    setSessionDetail(null);
    setSessionDetailError(null);
    setViewMode('list');
    setSelectedTag('');
    setManageFilters({});
    setShowSyncConflictDialog(false);
    setShowCsvImportDialog(false);
    setShowExportDialog(false);
    setShowHistoryDialog(false);
    setHistoryQuestionId(null);
  }, [sessionId]);
  
  const toggleTimer = useCallback(() => {
    setIsTimerRunning(prev => !prev);
  }, []);

  const activeAdvancedTimerDuration = useMemo(() => {
    if (
      practiceMode === 'timed' &&
      activeTimedSession &&
      !activeTimedSession.is_submitted &&
      !activeTimedSession.is_timeout
    ) {
      return activeTimedSession.duration_minutes * 60;
    }
    if (
      practiceMode === 'mock_exam' &&
      activeMockExamSession &&
      !activeMockExamSession.is_submitted
    ) {
      return activeMockExamSession.config.duration_minutes * 60;
    }
    return null;
  }, [practiceMode, activeTimedSession, activeMockExamSession]);

  const activeAdvancedStartedAt = useMemo(() => {
    if (practiceMode === 'timed') return activeTimedSession?.started_at || null;
    if (practiceMode === 'mock_exam') return activeMockExamSession?.started_at || null;
    return null;
  }, [practiceMode, activeTimedSession, activeMockExamSession]);

  // 计时器逻辑
  // ★ 标签页：普通练习的秒表在 isActive === false 时暂停，避免后台计时不精确；
  //   限时/模拟考（advanced runtime）必须按墙钟走：后台切换、休眠恢复都不能"暂停"考试，
  //   否则与后端 time_spent（ended_at - started_at）和启动页的绝对时间倒计时不一致。
  useEffect(() => {
    const advancedRuntime = activeAdvancedTimerDuration != null;
    if (viewMode === 'practice' && isTimerRunning && (isActive !== false || advancedRuntime)) {
      timerRef.current = setInterval(() => {
        if (advancedRuntime && activeAdvancedStartedAt) {
          const startedMs = Date.parse(activeAdvancedStartedAt);
          if (Number.isFinite(startedMs)) {
            // 墙钟推算，免疫 setInterval 漂移与系统休眠
            setElapsedTime(Math.max(0, Math.floor((Date.now() - startedMs) / 1000)));
            return;
          }
        }
        setElapsedTime(prev => prev + 1);
      }, 1000);
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [viewMode, isTimerRunning, isActive, activeAdvancedTimerDuration, activeAdvancedStartedAt]);

  const isAdvancedRuntimeTimer = activeAdvancedTimerDuration != null;
  const advancedTimerRemaining = useMemo(() => {
    if (activeAdvancedTimerDuration == null) return null;
    return Math.max(activeAdvancedTimerDuration - elapsedTime, 0);
  }, [activeAdvancedTimerDuration, elapsedTime]);

  useEffect(() => {
    if (viewMode !== 'practice' || !activeAdvancedStartedAt || activeAdvancedTimerDuration == null) {
      return;
    }
    const startedMs = Date.parse(activeAdvancedStartedAt);
    if (!Number.isFinite(startedMs)) return;
    const restoredElapsed = Math.min(
      activeAdvancedTimerDuration,
      Math.max(0, Math.floor((Date.now() - startedMs) / 1000)),
    );
    setElapsedTime(restoredElapsed);
    setIsTimerRunning(true);
  }, [viewMode, activeAdvancedStartedAt, activeAdvancedTimerDuration]);

  useEffect(() => {
    if (!activeTimedSession || activeTimedSession.is_submitted || activeTimedSession.is_timeout) {
      timedTimeoutHandledRef.current = null;
      return;
    }
    if (
      viewMode !== 'practice' ||
      practiceMode !== 'timed' ||
      activeAdvancedTimerDuration == null ||
      elapsedTime < activeAdvancedTimerDuration
    ) {
      return;
    }
    if (timedTimeoutHandledRef.current === activeTimedSession.id) {
      return;
    }
    timedTimeoutHandledRef.current = activeTimedSession.id;
    setIsTimerRunning(false);
    // 清掉残留的倒计时读数，避免下次普通练习的秒表从整卷时长起跳
    setElapsedTime(0);
    setTimedSession({
      ...activeTimedSession,
      ended_at: new Date().toISOString(),
      is_timeout: true,
      is_submitted: true,
    });
    switchViewMode('launcher');
    showGlobalNotification(
      'info',
      t('learningHub:exam.timedPracticeTimeout', '限时练习已结束'),
      t('learningHub:exam.timerEnded', '时间到'),
    );
  }, [
    activeTimedSession,
    activeAdvancedTimerDuration,
    elapsedTime,
    practiceMode,
    setTimedSession,
    switchViewMode,
    t,
    viewMode,
  ]);

  useEffect(() => {
    if (!activeMockExamSession || activeMockExamSession.is_submitted) {
      mockExamTimeoutHandledRef.current = null;
      return;
    }
    if (
      viewMode !== 'practice' ||
      practiceMode !== 'mock_exam' ||
      activeAdvancedTimerDuration == null ||
      elapsedTime < activeAdvancedTimerDuration
    ) {
      return;
    }
    if (mockExamTimeoutHandledRef.current === activeMockExamSession.id) {
      return;
    }
    mockExamTimeoutHandledRef.current = activeMockExamSession.id;
    setIsTimerRunning(false);

    const submitSession = {
      ...activeMockExamSession,
      ended_at: new Date().toISOString(),
      is_submitted: true,
    };

    void submitMockExam(submitSession)
      .then(() => {
        setElapsedTime(0);
        switchViewMode('launcher');
        showGlobalNotification(
          'info',
          t('learningHub:exam.mockExamAutoSubmitted', '模拟考试已自动交卷，可在启动页查看成绩单'),
          t('learningHub:exam.timerEnded', '时间到'),
        );
      })
      .catch((err: unknown) => {
        mockExamTimeoutHandledRef.current = null;
        debugLog.error('[ExamContentView] auto submit mock exam failed:', err);
        showGlobalNotification(
          'error',
          t('learningHub:exam.mockExamAutoSubmitFailed', '模拟考试自动交卷失败，请返回启动页手动交卷'),
        );
      });
  }, [
    activeMockExamSession,
    activeAdvancedTimerDuration,
    elapsedTime,
    practiceMode,
    submitMockExam,
    switchViewMode,
    t,
    viewMode,
  ]);

  // 🆕 加载 sessionDetail（仅用于 ExamSheetUploader 等需要原始 preview 的组件）
  const loadSessionDetail = useCallback(async () => {
    if (!sessionId) return;
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] loadSessionDetail 开始: ${sessionId}`, { sessionId });
    try {
      const detail = await TauriAPI.getExamSheetSessionDetail(sessionId);
      // 会话已切换：丢弃过期响应，避免旧会话数据串台
      if (latestSessionIdRef.current !== sessionId) return;
      emitExamSheetDebug('success', 'frontend:hook-state', `[ExamContentView] loadSessionDetail 成功: status=${detail.summary.status}, pages=${detail.preview.pages?.length ?? 0}`, { sessionId, detail: { status: detail.summary.status, pageCount: detail.preview.pages?.length, cardCount: detail.preview.pages?.reduce((s, p) => s + (p.cards?.length ?? 0), 0) } });
      setSessionDetail(detail);
      setSessionDetailError(null);
    } catch (err: unknown) {
      if (latestSessionIdRef.current !== sessionId) return;
      emitExamSheetDebug('error', 'frontend:hook-state', `[ExamContentView] loadSessionDetail 失败: ${err}`, { sessionId });
      console.error('[ExamContentView] Failed to load session detail:', err);
      setSessionDetail(null);
      setSessionDetailError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSessionDetail();
  }, [loadSessionDetail]);

  // M-025: 加载时检查同步状态（每个会话只检查一次，避免语言切换等重渲染触发重复通知）
  const syncCheckedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || syncCheckedSessionRef.current === sessionId) return;
    syncCheckedSessionRef.current = sessionId;
    checkSyncStatus(sessionId).then(status => {
      // 会话已切换：不要把旧会话的冲突提示/弹窗带到新会话
      if (latestSessionIdRef.current !== sessionId) return;
      if (status && status.pending_conflict_count > 0) {
        showGlobalNotification('warning', t('learningHub:exam.syncConflictWarning', {
          count: status.pending_conflict_count,
        }));
        void getSyncConflicts(sessionId)
          .then((conflicts) => {
            if (latestSessionIdRef.current !== sessionId) return;
            if (conflicts.some((conflict) => conflict.status === 'pending')) {
              setShowSyncConflictDialog(true);
            }
          })
          .catch((err: unknown) => {
            debugLog.warn('[ExamContentView] load sync conflicts failed:', err);
            showGlobalNotification(
              'warning',
              t('learningHub:exam.syncConflictsLoadFailed', '检测到冲突，但加载冲突详情失败，请重试')
            );
          });
      }
    }).catch(err => {
      debugLog.warn('[ExamContentView] sync status check failed:', err);
      showGlobalNotification('warning', t('learningHub:exam.syncStatusCheckFailed', '同步状态检查失败，请稍后重试'));
    });
  }, [sessionId, checkSyncStatus, getSyncConflicts, t]);

  const handleSessionUpdate = useCallback(async (detail: ExamSheetSessionDetail) => {
    if (latestSessionIdRef.current !== sessionId) return;
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] handleSessionUpdate: pages=${detail.preview.pages?.length}, cards=${detail.preview.pages?.reduce((s, p) => s + (p.cards?.length ?? 0), 0)}`, { sessionId });
    setSessionDetail(detail);
    // 🆕 刷新 Store 中的题目和统计
    await loadQuestions();
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] handleSessionUpdate 完成`, { sessionId });
  }, [loadQuestions, sessionId]);

  // 🆕 使用 Hook 的 submitAnswer（已改名避免冲突）
  const handleSubmitAnswer = useCallback(async (questionId: string, answer: string, questionType?: QuestionType) => {
    if (!sessionId) throw new Error('No session');
    const result = await submitAnswer(questionId, answer);

    // mock_exam 依赖 session.answers/results 做进度与成绩计算，提交后同步回写。
    // ★ 提交是异步的：回写时从 store 读取最新会话（而非闭包快照），
    //   避免连续快速提交时后写覆盖先写、丢失已答记录
    if (practiceMode === 'mock_exam') {
      const latestSession = useQuestionBankStore.getState().mockExamSession;
      if (
        latestSession &&
        latestSession.exam_id === sessionId &&
        !latestSession.is_submitted &&
        latestSession.question_ids.includes(questionId)
      ) {
        const nextAnswers = { ...latestSession.answers, [questionId]: answer };
        const nextResults = { ...latestSession.results };
        if (result.isCorrect === true || result.isCorrect === false) {
          nextResults[questionId] = result.isCorrect;
        } else {
          delete nextResults[questionId];
        }
        setMockExamSession({
          ...latestSession,
          answers: nextAnswers,
          results: nextResults,
        });
      }
    }

    return result;
  }, [sessionId, submitAnswer, practiceMode, setMockExamSession]);

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

  const handleSelectMode = useCallback((value: string) => {
    handleModeChange(value as PracticeMode);
  }, [handleModeChange]);

  const handleStartPracticeByTag = useCallback((tag: string) => {
    handleModeChange('by_tag', tag);
    switchViewMode('practice');
  }, [handleModeChange, switchViewMode]);

  const handleStartReview = useCallback(() => {
    handleModeChange('review_first');
    switchViewMode('practice');
  }, [handleModeChange, switchViewMode]);

  // 点击题目进入做题模式（必须在条件返回之前定义）
  const handleQuestionClick = useCallback((index: number) => {
    navigate(index);
    switchViewMode('practice');
  }, [navigate, switchViewMode]);

  const handleOpenQuestion = useCallback((questionId: string) => {
    const index = questions.findIndex((question) => question.id === questionId);
    if (index >= 0) {
      navigate(index);
      switchViewMode('practice');
    }
  }, [questions, navigate, switchViewMode]);

  const handleOpenHistory = useCallback((questionId: string) => {
    setHistoryQuestionId(questionId);
    setShowHistoryDialog(true);
  }, []);

  const handleViewQuestionDetail = useCallback((question: Question) => {
    handleOpenQuestion(question.id);
  }, [handleOpenQuestion]);

  const handleHistoryOpenChange = useCallback((open: boolean) => {
    setShowHistoryDialog(open);
    if (!open) {
      setHistoryQuestionId(null);
    }
  }, []);

  const manageQuestions = useMemo(() => {
    const normalizedSearch = manageFilters.search?.trim().toLowerCase();
    return questions.filter((question) => {
      if (normalizedSearch) {
        const matchesSearch =
          question.content.toLowerCase().includes(normalizedSearch) ||
          (question.questionLabel || '').toLowerCase().includes(normalizedSearch) ||
          question.tags?.some((tag) => tag.toLowerCase().includes(normalizedSearch));
        if (!matchesSearch) return false;
      }

      if (manageFilters.status?.length && !manageFilters.status.includes(question.status || 'new')) {
        return false;
      }

      if (manageFilters.difficulty?.length) {
        if (!question.difficulty || !manageFilters.difficulty.includes(question.difficulty)) {
          return false;
        }
      }

      if (manageFilters.questionType?.length && !manageFilters.questionType.includes(question.questionType)) {
        return false;
      }

      if (manageFilters.isFavorite && !question.isFavorite) {
        return false;
      }

      return true;
    });
  }, [questions, manageFilters]);

  // 高级模式题目过滤：根据 session 的 question_ids 过滤出子集
  const practiceQuestions = useMemo(() => {
    const orderQuestionsByIds = (questionIds: string[]) => {
      if (questionIds.length === 0) return questions;
      const questionMap = new Map(questions.map((question) => [question.id, question]));
      return questionIds
        .map((questionId) => questionMap.get(questionId))
        .filter((question): question is Question => Boolean(question));
    };

    switch (practiceMode) {
      case 'mock_exam': {
        return orderQuestionsByIds(activeMockExamSession?.question_ids || []);
      }
      case 'timed': {
        return orderQuestionsByIds(activeTimedSession?.question_ids || []);
      }
      case 'daily': {
        return orderQuestionsByIds(activeDailyPractice?.question_ids || []);
      }
      case 'paper': {
        return orderQuestionsByIds(activeGeneratedPaper?.questions?.map((question) => question.id) || []);
      }
      default:
        return questions;
    }
  }, [practiceMode, questions, activeMockExamSession, activeTimedSession, activeDailyPractice, activeGeneratedPaper]);

  const handleRefreshQuestion = useCallback(async (questionId: string) => {
    await refreshQuestion(questionId);
  }, [refreshQuestion]);

  // 高级模式下 currentIndex 需要映射到过滤后的子集
  const practiceCurrentIndex = useMemo(() => {
    if (practiceQuestions === questions) return currentIndex;
    // 找到当前题目在过滤子集中的位置
    const currentQ = questions[currentIndex];
    if (!currentQ) return 0;
    const idx = practiceQuestions.findIndex(q => q.id === currentQ.id);
    return idx >= 0 ? idx : 0;
  }, [practiceQuestions, questions, currentIndex]);

  // 将过滤子集的 index 映射回全量 questions 的 index
  const handlePracticeNavigate = useCallback((index: number) => {
    if (practiceQuestions !== questions) {
      const targetQ = practiceQuestions[index];
      if (targetQ) {
        const realIdx = questions.findIndex(q => q.id === targetQ.id);
        if (realIdx >= 0) handleNavigate(realIdx);
      }
      // 子集索引越界时不回退到全量索引，避免跳到错误题目
      return;
    }
    handleNavigate(index);
  }, [practiceQuestions, questions, handleNavigate]);

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
    switchViewMode('practice');
  }, [questions, currentIndex, navigate, setStorePracticeMode, switchViewMode, activeMockExamSession, activeTimedSession, activeDailyPractice, activeGeneratedPaper]);

  const refreshQuestionsAndStats = useCallback(async () => {
    await Promise.all([loadQuestions(), refreshStats()]);
  }, [loadQuestions, refreshStats]);

  // 重试按钮回调：吞掉 rejection（错误已由 hook 的 error 状态呈现），避免未处理的 Promise 拒绝
  const handleRetryQuestions = useCallback(() => {
    void refreshQuestionsAndStats().catch((err: unknown) => {
      debugLog.warn('[ExamContentView] retry load questions failed:', err);
    });
  }, [refreshQuestionsAndStats]);

  const handleSyncConflictResolved = useCallback(() => {
    void refreshQuestionsAndStats().catch((err: unknown) => {
      debugLog.warn('[ExamContentView] refresh after conflict resolve failed:', err);
    });
    void getSyncConflicts(sessionId).catch((err: unknown) => {
      debugLog.warn('[ExamContentView] reload sync conflicts failed:', err);
    });
  }, [refreshQuestionsAndStats, getSyncConflicts, sessionId]);

  const handleImportComplete = useCallback(() => {
    handleRetryQuestions();
  }, [handleRetryQuestions]);

  const handleOpenCsvImport = useCallback(() => {
    setShowCsvImportDialog(true);
  }, []);

  const handleOpenExport = useCallback(() => {
    setShowExportDialog(true);
  }, []);

  const executeMutation = useCallback(
    async (
      mutation: () => Promise<void>,
      errorMessage: string,
      refreshMode: 'questions' | 'all' = 'all'
    ) => {
      try {
        await mutation();
      } catch (err: unknown) {
        const normalized =
          err instanceof Error ? err : new Error(typeof err === 'string' ? err : String(err));
        (normalized as Error & { __notified?: boolean }).__notified = true;
        showGlobalNotification('error', err, errorMessage);
        throw normalized;
      }

      try {
        if (refreshMode === 'all') {
          await refreshQuestionsAndStats();
        } else {
          await loadQuestions();
        }
      } catch (refreshErr: unknown) {
        debugLog.warn('[ExamContentView] mutation refresh failed:', refreshErr);
        showGlobalNotification(
          'warning',
          t(
            'learningHub:exam.mutationRefreshFailed',
            '操作已完成，但界面刷新失败，请手动刷新后确认最新状态'
          )
        );
      }
    },
    [loadQuestions, refreshQuestionsAndStats, t]
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
          } else {
            showGlobalNotification(
              'success',
              t('learningHub:exam.resetProgressSuccess', {
                count: result.success_count,
                defaultValue: `已重置 ${result.success_count} 道题目的学习进度`,
              })
            );
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
          } else {
            showGlobalNotification(
              'success',
              t('learningHub:exam.deleteQuestionsSuccess', {
                count: result.success_count,
                defaultValue: `已删除 ${result.success_count} 道题目`,
              })
            );
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

  const handleUpdateUserNote = useCallback(async (questionId: string, note: string) => {
    await handleUpdateQuestion(questionId, { userNote: note });
  }, [handleUpdateQuestion]);

  // QuestionInlineEditor 已经保存到后端，这里只需刷新本地数据
  const handleListChanged = useCallback(async () => {
    await refreshQuestionsAndStats();
  }, [refreshQuestionsAndStats]);

  const handleBackToLauncher = useCallback(() => {
    switchViewMode('launcher');
  }, [switchViewMode]);

  // ★ 断点续导：检测 importing 状态
  const isImportingSession = sessionDetail?.summary.status === 'importing';
  const [isResuming, setIsResuming] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  // 会话切换时清理上一会话的恢复导入状态
  useEffect(() => {
    setIsResuming(false);
    setResumeError(null);
  }, [sessionId]);

  const handleResumeImport = useCallback(async () => {
    if (!sessionId || isResuming) return;
    setIsResuming(true);
    setResumeError(null);
    try {
      const detail = await TauriAPI.resumeQuestionImport(sessionId);
      if (latestSessionIdRef.current !== sessionId) return;
      setSessionDetail(detail);
      await loadQuestions();
      showGlobalNotification('success', t('exam_sheet:uploader.resume_success', '导入恢复完成'));
    } catch (err: unknown) {
      if (latestSessionIdRef.current !== sessionId) return;
      const msg = err instanceof Error ? err.message : String(err);
      setResumeError(msg);
      debugLog.error('[ExamContentView] resume import failed:', err);
    } finally {
      if (latestSessionIdRef.current === sessionId) {
        setIsResuming(false);
      }
    }
  }, [sessionId, isResuming, loadQuestions, t]);

  const isEmptySession = sessionDetail?.summary.status === 'empty' && 
    (!sessionDetail?.preview.pages || sessionDetail.preview.pages.length === 0);

  const hasQuestions = questions.length > 0;
  const sessionStatus = sessionDetail?.summary?.status ?? null;

  useEffect(() => {
    emitExamSheetDebug('debug', 'frontend:hook-state',
      `[ExamContentView] 渲染决策: isEmptySession=${isEmptySession}, hasQuestions=${hasQuestions}, viewMode=${viewMode}, isLoading=${isLoading}, sessionDetail.status=${sessionStatus ?? 'null'}, error=${error ?? 'null'}`,
      { sessionId },
    );
  }, [isEmptySession, hasQuestions, viewMode, isLoading, sessionStatus, error, sessionId]);

  const handleUploadSuccess = useCallback(async (detail: ExamSheetSessionDetail) => {
    emitExamSheetDebug('info', 'frontend:navigate', `[ExamContentView] onUploadSuccess 触发, pages=${detail.preview.pages?.length}`, { sessionId });
    await handleSessionUpdate(detail);
    if (latestSessionIdRef.current !== sessionId) return;
    emitExamSheetDebug('info', 'frontend:navigate', `[ExamContentView] onUploadSuccess 完成 → setViewMode('list')`, { sessionId });
    switchViewMode('list');
  }, [handleSessionUpdate, sessionId, switchViewMode]);

  const handleUploaderBack = useCallback(() => {
    if (hasQuestions) {
      switchViewMode('list');
    } else {
      onClose?.();
    }
  }, [hasQuestions, onClose, switchViewMode]);

  // 加载失败重试：会话详情与题目一起重试；rejection 已由 hook 的 error 状态呈现
  const handleRetryLoad = useCallback(() => {
    void loadSessionDetail();
    if (error) {
      void loadQuestions().catch((err: unknown) => {
        debugLog.warn('[ExamContentView] retry load questions failed:', err);
      });
    }
  }, [loadSessionDetail, error, loadQuestions]);

  // 空会话自动进入上传模式（只读模式下不自动切换）
  useEffect(() => {
    if (isEmptySession && viewMode === 'list' && !readOnly) {
      emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] 空会话自动切换到 upload 模式`, { sessionId });
      switchViewMode('upload');
    }
  }, [isEmptySession, viewMode, readOnly, sessionId, switchViewMode]);

  // 题目清空（如在管理/练习视图删光题目）后，依赖题目的视图已无内容支撑，
  // 回退到题库列表，保持 Tab 高亮与实际内容一致
  useEffect(() => {
    if (!hasQuestions && !isLoading && viewMode !== 'list' && viewMode !== 'upload') {
      switchViewMode('list');
    }
  }, [hasQuestions, isLoading, viewMode, switchViewMode]);

  /**
   * ACR R1-15：消费 qbankDriver 派发的域刷新 / 聚焦事件。
   * - 刷新：行内编辑中延迟；loadQuestions 已按 previousQuestionId 保位（不打断答题）
   * - 聚焦：打开对应题目并 flash
   */
  useEffect(() => {
    let deferredTimer: ReturnType<typeof setTimeout> | null = null;

    const flashIds = (entityIds: string[] | undefined, payload?: DomainChangePayload) => {
      const ids =
        (entityIds?.length ? entityIds : null) ??
        (payload ? collectDomainEntityIds(payload) : []);
      for (const id of ids) {
        if (typeof id === 'string' && id) agentFlash('exam', id);
      }
    };

    const runLocalRefresh = (payload?: DomainChangePayload) => {
      if (isQbankInlineEditorActive()) {
        if (deferredTimer) clearTimeout(deferredTimer);
        deferredTimer = setTimeout(() => {
          deferredTimer = null;
          runLocalRefresh(payload);
        }, 800);
        return;
      }
      void refreshQuestionsAndStats()
        .then(() => {
          flashIds(payload?.entityIds, payload);
        })
        .catch((err: unknown) => {
          debugLog.warn('[ExamContentView] qbank://changed refresh failed:', err);
        });
    };

    const onRefresh = (ev: Event) => {
      const detail = (ev as CustomEvent<DomainChangePayload>).detail;
      runLocalRefresh(detail);
    };

    const onFocus = (ev: Event) => {
      const detail = (ev as CustomEvent<QbankFocusEventDetail>).detail;
      const questionId = detail?.questionId;
      if (!questionId) return;
      const index = questions.findIndex((question) => question.id === questionId);
      const handled = index >= 0;
      const previousQuestionId = questions[currentIndex]?.id ?? null;
      if (handled) {
        handleOpenQuestion(questionId);
        agentFlash('exam', questionId);
      }
      detail.acknowledge?.({ handled, previousQuestionId });
    };

    window.addEventListener(QBANK_REFRESH_EVENT, onRefresh);
    window.addEventListener(QBANK_FOCUS_EVENT, onFocus);
    return () => {
      window.removeEventListener(QBANK_REFRESH_EVENT, onRefresh);
      window.removeEventListener(QBANK_FOCUS_EVENT, onFocus);
      if (deferredTimer) clearTimeout(deferredTimer);
    };
  }, [refreshQuestionsAndStats, handleOpenQuestion, questions, currentIndex]);

  // ========== 条件返回（早期退出） ==========
  
  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <WarningCircle size={32} className="text-muted-foreground mb-2" />
        <span className="text-muted-foreground">
          {t('exam_sheet:errors.noSession', '未指定整卷会话')}
        </span>
      </div>
    );
  }

  if ((sessionDetailError || error) && !sessionDetail && !isLoading) {
    const loadErrorMessage = sessionDetailError || error;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4">
        <WarningCircle size={32} className="text-destructive" />
        <span className="text-muted-foreground text-center max-w-md" role="alert">
          {t('exam_sheet:errors.loadFailed', '加载整卷会话失败')}: {loadErrorMessage}
        </span>
        <NotionButton variant="ghost" size="sm" onClick={handleRetryLoad} className="gap-2">
          <ArrowClockwise size={16} />
          {t('common:actions.retry', '重试')}
        </NotionButton>
      </div>
    );
  }

  // 会话详情未就绪，或题目仍在首次加载（已有题目时的后台刷新不再整页转圈；
  // 恢复导入期间保持横幅与 Tab 栏挂载，按钮自带"恢复中"反馈）
  if (!sessionDetail || (isLoading && !hasQuestions && !isResuming)) {
    return (
      <div className="flex items-center justify-center h-full" role="status">
        <CircleNotch size={24} className="animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="ml-2 text-muted-foreground">
          {t('common:loading', '加载中...')}
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
              <WarningCircle size={16} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
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
                  <CircleNotch size={14} className="animate-spin" />
                ) : (
                  <RotateCw size={14} />
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

      {error && (
        <div className="flex-shrink-0 px-3 sm:px-4 py-2 border-b border-destructive/20 bg-destructive/5" role="alert">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-destructive truncate" title={error}>
              {t('exam_sheet:errors.loadQuestionsFailed', '题目加载失败')}: {error}
            </span>
            <NotionButton variant="ghost" size="sm" onClick={handleRetryQuestions} className="gap-1.5">
              <ArrowClockwise size={14} />
              {t('common:actions.retry', '重试')}
            </NotionButton>
          </div>
        </div>
      )}

      {/* Tab 栏 */}
      <div className="flex-shrink-0 px-3 sm:px-4 py-2.5 border-b border-border/40">
        <div className="flex items-center justify-between gap-2">
          {/* 左侧 Tab - 允许横向滚动；移动端右缘渐隐提示还有更多 */}
          <div className="flex items-center gap-1 min-w-0 overflow-x-auto scrollbar-none max-sm:[mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => switchViewMode('list')}
              disabled={!hasQuestions && viewMode !== 'upload'}
              aria-pressed={viewMode === 'list'}
              className={cn(
                'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                touchTargetClass,
                viewMode === 'list' 
                  ? 'bg-foreground text-background font-medium' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]',
                (!hasQuestions && viewMode !== 'upload') && 'opacity-50 cursor-not-allowed'
              )}
            >
              {t('learningHub:exam.tab.questionBank')}
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => switchViewMode('launcher')}
              disabled={!hasQuestions}
              aria-pressed={viewMode === 'practice' || viewMode === 'launcher'}
              className={cn(
                'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                touchTargetClass,
                (viewMode === 'practice' || viewMode === 'launcher')
                  ? 'bg-foreground text-background font-medium' 
                  : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]',
                !hasQuestions && 'opacity-50 cursor-not-allowed'
              )}
            >
              {t('learningHub:exam.tab.practice')}
            </NotionButton>
            {hasQuestions && stats && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => switchViewMode('review')}
                aria-pressed={viewMode === 'review'}
                className={cn(
                  'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors flex items-center gap-1 whitespace-nowrap flex-shrink-0',
                  touchTargetClass,
                  viewMode === 'review' 
                    ? 'bg-amber-500 text-white font-medium' 
                    : stats.review > 0 
                      ? 'text-amber-600 dark:text-amber-400 hover:bg-amber-500/10'
                      : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
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
                onClick={() => switchViewMode('sm2')}
                aria-pressed={viewMode === 'sm2'}
                className={cn(
                  'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                touchTargetClass,
                  viewMode === 'sm2'
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
                )}
              >
                {t('review:title', '复习计划')}
              </NotionButton>
            )}
            {hasQuestions && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => switchViewMode('manage')}
                aria-pressed={viewMode === 'manage'}
                className={cn(
                  'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                touchTargetClass,
                  viewMode === 'manage'
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
                )}
              >
                <GearSix size={14} className="mr-1.5" />
                {t('learningHub:exam.tab.manage', '管理')}
              </NotionButton>
            )}
            {hasQuestions && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => switchViewMode('stats')}
                aria-pressed={viewMode === 'stats'}
                className={cn(
                  'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                touchTargetClass,
                  viewMode === 'stats'
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
                )}
              >
                <ChartBar size={14} className="mr-1.5" />
                {t('learningHub:exam.tab.stats', '统计')}
              </NotionButton>
            )}
            {hasQuestions && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => switchViewMode('favorites')}
                aria-pressed={viewMode === 'favorites'}
                className={cn(
                  'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                touchTargetClass,
                  viewMode === 'favorites'
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
                )}
              >
                <Star size={14} className="mr-1.5" />
                {t('learningHub:exam.tab.favorites', '收藏')}
              </NotionButton>
            )}
            {hasQuestions && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => switchViewMode('tags')}
                aria-pressed={viewMode === 'tags'}
                className={cn(
                  'px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0',
                touchTargetClass,
                  viewMode === 'tags' 
                    ? 'bg-foreground text-background font-medium' 
                    : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
                )}
              >
                {t('learningHub:exam.tab.topics')}
              </NotionButton>
            )}
            
            {(viewMode === 'practice') && hasQuestions && (
              <>
                <div className="w-px h-4 bg-border/60 mx-1 sm:mx-2 flex-shrink-0" />
                <AppSelect value={practiceMode} onValueChange={handleSelectMode}
                  options={MODE_OPTIONS}
                  size="sm"
                  variant="ghost"
                  className={cn('h-7 sm:h-8 text-xs px-2 border-0 bg-muted/30 hover:bg-[var(--interactive-hover)] flex-shrink-0', touchTargetClass)}
                />
                
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={isAdvancedRuntimeTimer ? undefined : toggleTimer}
                  aria-disabled={isAdvancedRuntimeTimer || undefined}
                  aria-label={
                    isAdvancedRuntimeTimer
                      ? t('learningHub:exam.timer.remaining', '剩余时间')
                      : isTimerRunning
                        ? t('learningHub:exam.timer.pause', '暂停')
                        : t('learningHub:exam.timer.resume', '继续')
                  }
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors text-sm flex-shrink-0',
                    touchTargetClass,
                    isAdvancedRuntimeTimer
                      ? 'text-rose-600 bg-rose-500/10 hover:bg-rose-500/10'
                      : isTimerRunning
                        ? 'text-primary bg-primary/5 hover:bg-primary/10'
                        : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
                  )}
                  title={
                    isAdvancedRuntimeTimer
                      ? t('learningHub:exam.timer.remaining', '剩余时间')
                      : isTimerRunning
                        ? t('learningHub:exam.timer.pause', '暂停')
                        : t('learningHub:exam.timer.resume', '继续')
                  }
                >
                  {isAdvancedRuntimeTimer ? (
                    <Clock size={14} />
                  ) : isTimerRunning ? (
                    <Pause size={14} />
                  ) : (
                    <Play size={14} />
                  )}
                  <span className={cn('font-mono tabular-nums text-xs', !isAdvancedRuntimeTimer && !isTimerRunning && 'animate-pulse')}>
                    {formatTime(advancedTimerRemaining ?? elapsedTime)}
                  </span>
                </NotionButton>
              </>
            )}
          </div>
          
          {/* 右侧添加按钮（只读模式下隐藏） */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {hasQuestions && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => setShowExportDialog(true)}
                aria-label={t('learningHub:exam.tab.export', '导出')}
                className={cn('h-7 sm:h-8 px-2.5 sm:px-3 gap-1.5', touchTargetClass)}
              >
                <Download size={14} />
                <span className="hidden sm:inline">{t('learningHub:exam.tab.export', '导出')}</span>
              </NotionButton>
            )}
            {!readOnly && (
              <NotionButton
                variant={viewMode === 'upload' ? 'default' : 'ghost'}
                size="sm"
                onClick={() => switchViewMode('upload')}
                aria-label={t('learningHub:exam.tab.add')}
                className={cn('h-7 sm:h-8 px-2.5 sm:px-3 gap-1.5', touchTargetClass)}
              >
                <Scan size={14} />
                <span className="hidden sm:inline">{t('learningHub:exam.tab.add')}</span>
              </NotionButton>
            )}
            {!readOnly && hasQuestions && (
              <NotionButton
                variant="ghost"
                size="sm"
                onClick={() => setShowCsvImportDialog(true)}
                aria-label={t('learningHub:exam.tab.importCsv', '导入 CSV')}
                className={cn('h-7 sm:h-8 px-2.5 sm:px-3 gap-1.5', touchTargetClass)}
              >
                <Scan size={14} />
                <span className="hidden sm:inline">{t('learningHub:exam.tab.importCsv', '导入 CSV')}</span>
              </NotionButton>
            )}
          </div>
        </div>
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full">
              <CircleNotch size={24} className="animate-spin text-muted-foreground" />
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
          ) : viewMode === 'manage' && hasQuestions ? (
            <QuestionBankManageView
              questions={manageQuestions}
              isLoading={isLoading}
              onDelete={readOnly ? undefined : handleDeleteQuestions}
              onToggleFavorite={readOnly ? undefined : handleToggleFavorite}
              onResetProgress={readOnly ? undefined : handleResetProgress}
              onViewDetail={handleViewQuestionDetail}
              onViewHistory={handleOpenHistory}
              onFilterChange={handleFilterChange}
              onCsvImport={readOnly ? undefined : handleOpenCsvImport}
              onCsvExport={handleOpenExport}
              showCsvActions={!readOnly}
            />
          ) : viewMode === 'stats' && hasQuestions ? (
            <QuestionBankStatsView
              stats={stats}
              examId={sessionId}
            />
          ) : viewMode === 'favorites' && hasQuestions ? (
            <QuestionFavoritesView
              examId={sessionId}
              onSelectQuestion={handleViewQuestionDetail}
              onToggleFavorite={readOnly ? undefined : handleToggleFavorite}
              onViewHistory={handleOpenHistory}
            />
          ) : viewMode === 'tags' && hasQuestions ? (
            /* 知识点导航视图 */
            <TagNavigationView
              questions={questions}
              onQuestionClick={handleQuestionClick}
              onStartPracticeByTag={handleStartPracticeByTag}
            />
          ) : viewMode === 'sm2' && hasQuestions ? (
            /* ★ I1 修复：SM-2 间隔复习视图（计划面板 + 复习会话） */
            <Sm2ReviewPanel examId={sessionId} />
          ) : viewMode === 'review' && hasQuestions ? (
            /* 错题本视图 */
            <ReviewQuestionsView
              questions={questions}
              stats={stats}
              onQuestionClick={handleQuestionClick}
              onStartReview={handleStartReview}
              onResetProgress={readOnly ? undefined : handleResetProgress}
              onDelete={readOnly ? undefined : handleDeleteQuestions}
            />
          ) : viewMode === 'upload' && !readOnly ? (
            <ExamSheetUploader
              sessionId={sessionId}
              sessionName={sessionDetail?.summary?.exam_name || node.name}
              onUploadSuccess={handleUploadSuccess}
              onBack={handleUploaderBack}
            />
          ) : viewMode === 'practice' && hasQuestions ? (
            <QuestionBankEditor
              sessionId={sessionId}
              questions={practiceQuestions}
              stats={stats}
              currentIndex={practiceCurrentIndex}
              practiceMode={practiceMode}
              showTimer={true}
              timerDuration={activeAdvancedTimerDuration ?? undefined}
              timerElapsedSeconds={isAdvancedRuntimeTimer ? elapsedTime : undefined}
              allowTimerControl={!isAdvancedRuntimeTimer}
              selectedTag={selectedTag}
              focusMode={focusMode}
              onFocusModeChange={setFocusMode}
              isActive={isActive}
              onSubmitAnswer={readOnly ? undefined : handleSubmitAnswer}
              onNavigate={handlePracticeNavigate}
              onModeChange={handleModeChange}
              onMarkCorrect={readOnly ? undefined : handleMarkCorrect}
              onRefreshQuestion={readOnly ? undefined : handleRefreshQuestion}
              onToggleFavorite={readOnly ? undefined : handleToggleFavorite}
              onUpdateQuestion={readOnly ? undefined : handleUpdateQuestion}
              onUpdateUserNote={readOnly ? undefined : handleUpdateUserNote}
              onDeleteQuestion={readOnly ? undefined : handleDeleteQuestion}
              onBack={handleBackToLauncher}
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
              onUpdateQuestion={readOnly ? undefined : handleListChanged}
              onCreateQuestion={readOnly ? undefined : handleListChanged}
            />
          )}
        </Suspense>
      </div>

      <SyncConflictDialog
        open={showSyncConflictDialog}
        onOpenChange={setShowSyncConflictDialog}
        examId={sessionId}
        conflicts={syncConflicts}
        onResolved={handleSyncConflictResolved}
      />

      <Suspense fallback={null}>
        <CsvImportDialog
          open={showCsvImportDialog}
          onOpenChange={setShowCsvImportDialog}
          examId={sessionId}
          examName={sessionDetail?.summary?.exam_name || node.name}
          onImportComplete={handleImportComplete}
        />
        <QuestionBankExportDialog
          open={showExportDialog}
          onOpenChange={setShowExportDialog}
          questions={questions}
          examName={sessionDetail?.summary?.exam_name || node.name}
          examId={sessionId}
        />
        <QuestionHistoryView
          questionId={historyQuestionId}
          open={showHistoryDialog}
          onOpenChange={handleHistoryOpenChange}
        />
      </Suspense>
    </div>
  );
};

export default ExamContentView;
