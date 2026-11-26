import React, { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import {
  WarningCircle,
  ArrowClockwise,
  Tag,
  GearSix,
  ChartBar,
  Star,
  XCircle,
  ClockCounterClockwise,
  DotsSixVertical,
} from '@phosphor-icons/react';
import { TauriAPI, type ExamSheetSessionDetail } from '@/utils/tauriApi';
import { DsButton } from '@/components/ui/DsButton';
import { DsDialog, DsDialogHeader, DsDialogTitle, DsDialogBody } from '@/components/ui/DsDialog';
import type { ContentViewProps } from '../UnifiedAppPanel';
import {
  getNextQuestionIndex,
  getPracticeStartIndex,
  type Question,
  type PracticeMode,
  type QuestionType,
  type Difficulty,
} from '@/api/questionBankApi';
import { invoke } from '@tauri-apps/api/core';
import { convertToApiQuestion, useQuestionBankSession, type StoreQuestion } from '@/hooks/useQuestionBankSession';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import {
  buildSelectiveQuestionRevertParams,
  QuestionRevertError,
  useQbankAgentDiffStore,
} from '@/stores/qbankAgentDiffStore';
import { useExamDueReviewCount } from './useExamDueReviewCount';
import {
  DS_EXCERPT_MIME,
  deriveQuestionExcerptMeta,
  startQuestionExcerptDrag,
} from './examQuestionInterop';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { emitExamSheetDebug } from '@/shared/debug/channels/examSheetProcessing';
import { newPracticeId, type CreatePracticeRequest, type GradingMode } from '@/api/practiceApi';

import {
  LAUNCHER_REQUIRED_MODES,
  MODE_LABEL_KEYS,
  Sm2ReviewPanel,
  ViewSkeleton,
  type LauncherRequestedMode,
  type ManageFilters,
  type ViewMode,
} from './exam/ExamViewPrimitives';
import { useExamPracticeTimers } from './exam/useExamPracticeTimers';
import { useExamDraftGuard } from './exam/useExamDraftGuard';
import { useExamQbankControlBridge } from './exam/useExamQbankControlBridge';
import { useExamAuthoringDrafts } from './exam/useExamAuthoringDrafts';
import { useExamDomainRefreshAndAnchors } from './exam/useExamDomainRefreshAndAnchors';
import { ExamHeaderAndTabs } from './exam/ExamHeaderAndTabs';

const ExamSheetUploader = lazy(() => import('@/components/ExamSheetUploader'));
const QuestionImportAuditPanel = lazy(() => import('@/components/QuestionImportAuditPanel'));
const QuestionBankEditor = lazy(() => import('@/components/QuestionBankEditor'));
const QuestionBankListView = lazy(() => import('@/components/QuestionBankListView'));
const AiQuestionGenerationPanel = lazy(() => import('@/components/AiQuestionGenerationPanel'));
const QuestionBankManageView = lazy(() => import('@/components/QuestionBankManageView'));
const QuestionBankStatsView = lazy(() => import('@/components/QuestionBankStatsView'));
const QuestionFavoritesView = lazy(() => import('@/components/QuestionFavoritesView'));
const QuestionHistoryView = lazy(() => import('@/components/QuestionHistoryView'));
const ReviewQuestionsView = lazy(() => import('@/components/ReviewQuestionsView'));
// I1 修复：接入 SM-2 间隔复习系统（复习计划 + 复习会话）
const ReviewPlanView = lazy(() => import('@/components/ReviewPlanView'));
const ReviewSession = lazy(() => import('@/components/ReviewSession'));
const ReviewCalendarView = lazy(() => import('@/components/ReviewCalendarView'));
const TagNavigationView = lazy(() => import('@/components/TagNavigationView'));
const PracticeLauncher = lazy(() => import('@/components/practice/PracticeLauncher'));
const BatchPracticeWorkspace = lazy(() => import('@/components/practice/BatchPracticeWorkspace'));
const PaperLibrary = lazy(() => import('@/components/practice/PaperLibrary'));
const CsvImportPanel = lazy(() => import('@/components/CsvImportDialog').then((module) => ({ default: module.CsvImportPanel })));
const QuestionBankExportDialog = lazy(() => import('@/components/QuestionBankExportDialog'));

const ExamContentView: React.FC<ContentViewProps> = ({
  node,
  readOnly = false,
  isActive,
  focusScopeId,
  onSaveStateChange,
}) => {
  // 'review' 需显式加入：secondaryTabs 与退出确认使用 review:* 文案，
  // 避免命名空间未加载时首帧回退为 key 本身
  const { t } = useTranslation(['exam_sheet', 'common', 'learningHub', 'review']);

  const MODE_OPTIONS = useMemo(() =>
    Object.entries(MODE_LABEL_KEYS).map(([value, labelKey]) => ({ value, label: t(labelKey) })),
    [t]
  );

  const sessionId = node.id;
  const isSmallScreen = useIsMobile();

  // 渲染日志放入 effect，保持 render 纯函数（避免 StrictMode 双调用产生重复日志）
  useEffect(() => {
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] 渲染: sessionId=${sessionId}, node.name=${node.name}`, { sessionId });
  }, [sessionId, node.name]);

  // 2026-01 改造：使用 useQuestionBankSession Hook 管理题目状态
  const {
    practiceSessionOwner,
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
    toggleFavorite: toggleFavoriteInSession,
  } = useQuestionBankSession({ examId: sessionId });
  const hasQuestions = questions.length > 0;
  const [gradingMode, setGradingMode] = useState<GradingMode>('on_submit');
  const [batchRequest, setBatchRequest] = useState<CreatePracticeRequest | null>(null);
  const [batchRecord, setBatchRecord] = useState<{ id: string; submitted: boolean } | null>(null);
  const batchFlushRef = useRef<(() => Promise<void>) | null>(null);
  const batchNavigateRef = useRef<((target: number | string) => Promise<void>) | null>(null);
  const setBatchNavigate = useCallback((fn: ((target: number | string) => Promise<void>) | null) => { batchNavigateRef.current = fn; }, []);
  const setBatchFlush = useCallback((flush: (() => Promise<void>) | null) => { batchFlushRef.current = flush; }, []);
  const sm2DueCount = useExamDueReviewCount(sessionId);

  // 二级视图（收纳进 Tab 栏「更多」菜单）：错题 / 复习 / 收藏 / 知识点 / 统计 / 管理
  const secondaryTabs = useMemo(() => ([
    { mode: 'review' as ViewMode, label: t('learningHub:exam.tab.wrongAnswers'), icon: XCircle, badge: stats?.review ?? 0 },
    { mode: 'sm2' as ViewMode, label: t('review:title'), icon: ClockCounterClockwise, badge: sm2DueCount },
    { mode: 'favorites' as ViewMode, label: t('learningHub:exam.tab.favorites'), icon: Star, badge: 0 },
    { mode: 'tags' as ViewMode, label: t('learningHub:exam.tab.topics'), icon: Tag, badge: 0 },
    { mode: 'stats' as ViewMode, label: t('learningHub:exam.tab.stats'), icon: ChartBar, badge: 0 },
    { mode: 'manage' as ViewMode, label: t('learningHub:exam.tab.manage'), icon: GearSix, badge: 0 },
  ]), [t, stats?.review, sm2DueCount]);

  // 专注模式（从 Store 获取 — 全局 UI 偏好，不需要本地化）
  const focusMode = useQuestionBankStore(state => state.focusMode);
  const setFocusMode = useQuestionBankStore(state => state.setFocusMode);
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
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [groupPracticeIds, setGroupPracticeIds] = useState<string[] | null>(null);
  useEffect(() => setGroupPracticeIds(null), [sessionId]);
  // 只读浏览（#466）的当前题：按 id 记忆，独立于做题进度（currentIndex），看答案不挪动练习位置
  const [browseQuestionId, setBrowseQuestionId] = useState<string | null>(null);
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [historyQuestionId, setHistoryQuestionId] = useState<string | null>(null);
  const [manageFilters, setManageFilters] = useState<ManageFilters>({});
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [pendingSettingsOpen, setPendingSettingsOpen] = useState(false);
  const [launcherRequestedMode, setLauncherRequestedMode] = useState<LauncherRequestedMode | null>(null);
  // 从题库启动台拖入、待传给识别导入的文件
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[] | null>(null);
  // 从「添加题目」菜单请求列表视图打开内联创建编辑器的信号（递增触发）
  const [listCreateRequestKey, setListCreateRequestKey] = useState(0);

  const questionsRef = useRef<Question[]>(questions);
  questionsRef.current = questions;
  const flushPendingQbankRefreshRef = useRef<(() => void) | null>(null);
  // CSV 内嵌导入的进行中标记（导入中阻止切换到其他视图）
  const csvImportingRef = useRef(false);
  // ACR 演出优化轮：flash 限定在本视图 DOM 内（qbank 可多窗，全局查找会闪错窗口）
  const agentFlashRootRef = useRef<HTMLDivElement | null>(null);

  // 会话切换：记录最新 sessionId（异步回调的过期守卫）
  const latestSessionIdRef = useRef(sessionId);
  const sessionScope = useMemo(() => ({ sessionId }), [sessionId]);
  const latestSessionScopeRef = useRef<typeof sessionScope | null>(sessionScope);
  latestSessionScopeRef.current = sessionScope;
  useEffect(() => {
    latestSessionScopeRef.current = sessionScope;
    return () => { latestSessionScopeRef.current = null; };
  }, [sessionScope]);

  // 视图切换走 transition：懒加载 chunk 未就绪时保持当前视图渲染，
  // 避免整个内容区退化为 Suspense fallback 的闪烁
  const switchViewMode = useCallback((mode: ViewMode) => {
    startTransition(() => {
      setViewMode(mode);
    });
  }, []);

  const handleClearBatchState = useCallback(() => {
    setBatchRequest(null);
    setBatchRecord(null);
  }, []);

  const handleResetPendingSettings = useCallback(() => {
    setPendingSettingsOpen(false);
  }, []);

  const handleResetToBatchImmediateDefaults = useCallback(() => {
    setGradingMode('on_submit');
    setBatchRequest(null);
    setBatchRecord(null);
  }, []);

  const {
    elapsedTime,
    setElapsedTime,
    isTimerRunning,
    setIsTimerRunning,
    toggleTimer,
    activeAdvancedTimerDuration,
    isAdvancedRuntimeTimer,
    advancedTimerRemaining,
  } = useExamPracticeTimers({
    sessionId,
    sessionScope,
    latestSessionScopeRef,
    viewMode,
    practiceMode,
    gradingMode,
    isActive,
    activeTimedSession,
    activeMockExamSession,
    activeDailyPractice,
    setTimedSession,
    submitMockExam,
    switchViewMode,
  });

  const {
    draftStateRef,
    pendingReviewExitView,
    pendingPracticeExitView,
    pendingDraftNavigation,
    requestDraftNavigation,
    handlePracticeDraftDirtyChange,
    handleInlineEditorDraftDirtyChange,
    requestViewMode,
    confirmReviewExit,
    cancelReviewExit,
    confirmPracticeExit,
    cancelPracticeExit,
    confirmDiscardDraft,
    cancelDiscardDraft,
  } = useExamDraftGuard({
    sessionId,
    viewMode,
    switchViewMode,
    gradingMode,
    practiceMode,
    practiceSessionOwner,
    activeTimedSession,
    activeMockExamSession,
    activeDailyPractice,
    batchFlushRef,
    csvImportingRef,
    flushPendingQbankRefreshRef,
    onClearBatchState: handleClearBatchState,
    onResetPendingSettings: handleResetPendingSettings,
    onSetTimerRunning: setIsTimerRunning,
    onSaveStateChange,
  });

  // 待开的练习设置：进入练习视图后统一兑现。settings 请求可能被「退出复习」
  // 或「丢弃草稿」两条确认路径拦下，此前只有复习路径在确认后会补开设置面板，
  // 草稿路径确认后请求被静默丢弃
  useEffect(() => {
    if (pendingSettingsOpen && viewMode === 'practice') {
      setSettingsPanelOpen(true);
      setPendingSettingsOpen(false);
    }
  }, [pendingSettingsOpen, viewMode]);

  // 管理视图筛选（搜索逐键触发大列表过滤）降级为 transition，保持输入流畅
  const handleFilterChange = useCallback((filters: ManageFilters) => {
    startTransition(() => {
      setManageFilters(filters);
    });
  }, []);

  // 会话切换：重置上一会话的 UI 状态，防止旧会话的详情/错误/弹窗/筛选串到新会话（快速切换场景）
  useEffect(() => {
    latestSessionIdRef.current = sessionId;
    setSessionDetail(null);
    setSessionDetailError(null);
    setViewMode('list');
    setSelectedTag('');
    setBatchRequest(null);
    setBatchRecord(null);
    setGradingMode('on_submit');
    setManageFilters({});
    setShowExportDialog(false);
    setShowHistoryDialog(false);
    setHistoryQuestionId(null);
    setSettingsPanelOpen(false);
    setPendingSettingsOpen(false);
    setPendingUploadFiles(null);
    setLauncherRequestedMode(null);
    // CSV 导入进行中标记随面板卸载失效，防止残留 true 阻塞新会话的视图切换
    csvImportingRef.current = false;
  }, [sessionId]);

  // 加载 sessionDetail（仅用于 ExamSheetUploader 等需要原始 preview 的组件）
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

  // COMPAT-REMOVED 2026-07-20: 题库专属 sync conflict UI 已移除（无生产生产者）。
  // 真冲突源见设置 → 数据治理 RecordConflictsPanel（__sync_conflicts）。

  const handleSessionUpdate = useCallback(async (detail: ExamSheetSessionDetail) => {
    if (latestSessionIdRef.current !== sessionId) return;
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] handleSessionUpdate: pages=${detail.preview.pages?.length}, cards=${detail.preview.pages?.reduce((s, p) => s + (p.cards?.length ?? 0), 0)}`, { sessionId });
    setSessionDetail(detail);
    // 刷新 Store 中的题目和统计
    await loadQuestions();
    emitExamSheetDebug('info', 'frontend:hook-state', `[ExamContentView] handleSessionUpdate 完成`, { sessionId });
  }, [loadQuestions, sessionId]);

  // 使用 Hook 的 submitAnswer（已改名避免冲突）
  const handleSubmitAnswer = useCallback(async (questionId: string, answer: string, _questionType?: QuestionType) => {
    if (!sessionId) throw new Error('No session');
    const result = await submitAnswer(questionId, answer);

    // 限时/每日练习进度回写（2026-08 修复）：action 内部按会话题目成员资格 + 首答幂等自行门禁
    useQuestionBankStore.getState().recordPracticeAnswer(sessionId, questionId, result.isCorrect);

    // 权威优先（R6 补齐）：后端提交响应回带当日 daily 快照时覆盖本地乐观增量
    if (result.dailyProgress) {
      useQuestionBankStore.getState().applyAuthoritativeDailyProgress(sessionId, result.dailyProgress);
    }

    // mock_exam 依赖 session.answers/results 做进度与成绩计算，提交后同步回写。
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

  // 使用 Hook 的 markCorrect
  const handleMarkCorrect = useCallback(async (questionId: string, isCorrect: boolean) => {
    if (!sessionId) return;
    const result = await markCorrect(questionId, isCorrect);

    useQuestionBankStore.getState().recordPracticeAnswer(sessionId, questionId, isCorrect);

    if (practiceMode === 'mock_exam') {
      const latestSession = useQuestionBankStore.getState().mockExamSession;
      if (
        latestSession &&
        latestSession.exam_id === sessionId &&
        !latestSession.is_submitted &&
        latestSession.question_ids.includes(questionId) &&
        questionId in latestSession.answers
      ) {
        setMockExamSession({
          ...latestSession,
          results: { ...latestSession.results, [questionId]: isCorrect },
        });
      }
    }

    if (result.dailyProgress) {
      useQuestionBankStore.getState().applyAuthoritativeDailyProgress(sessionId, result.dailyProgress);
    }
  }, [sessionId, markCorrect, practiceMode, setMockExamSession]);

  // AI 评判完成（主观题/填空题 verdict 已在后端落库）后的回写
  const handleGradingResolved = useCallback((questionId: string, isCorrect: boolean) => {
    if (!sessionId) return;
    useQuestionBankStore.getState().recordPracticeAnswer(sessionId, questionId, isCorrect);

    if (practiceMode === 'mock_exam') {
      const latestSession = useQuestionBankStore.getState().mockExamSession;
      if (
        latestSession &&
        latestSession.exam_id === sessionId &&
        !latestSession.is_submitted &&
        latestSession.question_ids.includes(questionId) &&
        questionId in latestSession.answers
      ) {
        setMockExamSession({
          ...latestSession,
          results: { ...latestSession.results, [questionId]: isCorrect },
        });
      }
    }
  }, [sessionId, practiceMode, setMockExamSession]);

  // 使用 Hook 的 navigate
  const handleNavigate = useCallback((index: number) => {
    navigate(index);
  }, [navigate]);

  const requestQuestionNavigation = useCallback((proceed: () => void) => (
    requestDraftNavigation(proceed)
  ), [requestDraftNavigation]);

  // 更新 Store 练习模式（Store 是 SSOT，无本地 state）
  const handleModeChange = useCallback((mode: PracticeMode, tag?: string) => {
    if (LAUNCHER_REQUIRED_MODES.has(mode as LauncherRequestedMode)
      && (mode !== 'by_tag' || !tag)) {
      requestViewMode('launcher', () => {
        setLauncherRequestedMode(mode as LauncherRequestedMode);
      });
      return;
    }
    requestViewMode('practice', () => {
      setStorePracticeMode(mode);
      if (tag) setSelectedTag(tag);
      const nextIdx = getPracticeStartIndex(questions, currentIndex, mode, tag);
      navigate(nextIdx);
    }, mode !== practiceMode || (mode === 'by_tag' && tag !== selectedTag));
  }, [questions, currentIndex, navigate, requestViewMode, setStorePracticeMode, practiceMode, selectedTag]);

  // 模式下拉不带 tag：launcher 必配模式的分流已由 handleModeChange 统一处理
  const handleSelectMode = useCallback((value: string) => {
    handleModeChange(value as PracticeMode);
  }, [handleModeChange]);

  const handleStartPracticeByTag = useCallback((tag: string) => {
    requestViewMode('practice', () => {
      setGradingMode('on_submit'); setBatchRequest(null); setBatchRecord(null);
      setStorePracticeMode('by_tag');
      setSelectedTag(tag);
      navigate(getNextQuestionIndex(questions, currentIndex, 'by_tag', tag));
    });
  }, [currentIndex, navigate, questions, requestViewMode, setStorePracticeMode]);

  const handleStartReview = useCallback(() => {
    requestViewMode('practice', () => {
      setGradingMode('on_submit'); setBatchRequest(null); setBatchRecord(null);
      setStorePracticeMode('review_first');
      navigate(getNextQuestionIndex(questions, currentIndex, 'review_first'));
    });
  }, [currentIndex, navigate, questions, requestViewMode, setStorePracticeMode]);

  /**
   * issue 491：从题组头部进入练习。
   * 题组成员按后端 group_position 连续排列，采用顺序模式从组内第一题开始；
   * 当前题始终加载完整共享材料（单题随机练习同样如此）。
   */
  const handleStartGroupPractice = useCallback((groupQuestionIds: string[]) => {
    if (groupQuestionIds.length === 0) return;
    const firstIndex = questions.findIndex((question) => question.id === groupQuestionIds[0]);
    if (firstIndex < 0) return;
    requestViewMode('practice', () => {
      setGradingMode('on_submit'); setBatchRequest(null); setBatchRecord(null);
      setStorePracticeMode('sequential');
      setGroupPracticeIds(groupQuestionIds);
      navigate(firstIndex);
    });
  }, [navigate, questions, requestViewMode, setStorePracticeMode]);

  // 点击题目进入做题模式（必须在条件返回之前定义）
  const handleQuestionClick = useCallback((index: number) => {
    setGroupPracticeIds(null);
    requestViewMode('practice', () => { setGradingMode('on_submit'); setBatchRequest(null); setBatchRecord(null); navigate(index); });
  }, [navigate, requestViewMode]);

  const handleOpenQuestion = useCallback((questionId: string) => {
    const index = questions.findIndex((question) => question.id === questionId);
    if (index >= 0) {
      handleQuestionClick(index);
      return;
    }
    // 目标题已被删除/尚未同步（如收藏视图里的过期条目）：给出反馈而非静默无响应
    showGlobalNotification('warning', t('learningHub:exam.controlHints.questionNotFound'));
  }, [handleQuestionClick, questions, t]);

  const handleOpenHistory = useCallback((questionId: string) => {
    setHistoryQuestionId(questionId);
    setShowHistoryDialog(true);
  }, []);

  // 只读查看答案/解析（#466）：不进练习、不计时、不记作答
  const handleViewAnswer = useCallback((index: number) => {
    const target = questions[index];
    if (!target) return;
    requestViewMode('browse', () => setBrowseQuestionId(target.id));
  }, [questions, requestViewMode]);

  // 管理视图的「查看详情」= 只读查看，而不是开始做题
  const handleViewQuestionDetail = useCallback((question: Question) => {
    const index = questions.findIndex((candidate) => candidate.id === question.id);
    if (index >= 0) {
      handleViewAnswer(index);
      return;
    }
    showGlobalNotification('warning', t('learningHub:exam.controlHints.questionNotFound'));
  }, [handleViewAnswer, questions, t]);

  const handleHistoryOpenChange = useCallback((open: boolean) => {
    setShowHistoryDialog(open);
    if (!open) {
      setHistoryQuestionId(null);
    }
  }, []);

  // AI 出题知识点候选：现有题目 tags 去重（C2）
  const availableTagsForAiGeneration = useMemo(() => {
    const tags = new Set<string>();
    questions.forEach((question) => {
      question.tags?.forEach((tag) => {
        const trimmed = tag.trim();
        if (trimmed) tags.add(trimmed);
      });
    });
    return Array.from(tags).sort((a, b) => a.localeCompare(b));
  }, [questions]);

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

      if (manageFilters.tags?.length) {
        const questionTags = question.tags || [];
        if (!manageFilters.tags.some((tag) => questionTags.includes(tag))) {
          return false;
        }
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
      const questionMap = new Map(questions.map((question) => [question.id, question]));
      return questionIds
        .map((questionId) => questionMap.get(questionId))
        .filter((question): question is Question => Boolean(question));
    };

    if (practiceMode === 'sequential' && groupPracticeIds) return orderQuestionsByIds(groupPracticeIds);
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
      case 'by_tag': {
        if (!selectedTag) return [];
        if (selectedTag === '__untagged__') {
          return questions.filter((question) => !question.tags || question.tags.length === 0);
        }
        return questions.filter((question) => question.tags?.includes(selectedTag));
      }
      default:
        return questions;
    }
  }, [practiceMode, groupPracticeIds, questions, selectedTag, activeMockExamSession, activeTimedSession, activeDailyPractice, activeGeneratedPaper]);

  useEffect(() => {
    if (viewMode !== 'practice' || gradingMode !== 'on_submit' || batchRequest || batchRecord || !practiceQuestions.length) return;
    let selected = [...practiceQuestions];
    if (practiceMode === 'review_only') selected = selected.filter(q => q.status === 'review');
    if (practiceMode === 'review_first') selected.sort((a, b) => Number(b.status === 'review') - Number(a.status === 'review'));
    if (practiceMode === 'random') {
      for (let i = selected.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [selected[i], selected[j]] = [selected[j], selected[i]]; }
    }
    if (!selected.length) return;
    const timed = practiceMode === 'timed' ? activeTimedSession : null;
    const mock = practiceMode === 'mock_exam' ? activeMockExamSession : null;
    setBatchRequest({
      id: newPracticeId(),
      scope_id: sessionId,
      title: activeGeneratedPaper && practiceMode === 'paper' ? activeGeneratedPaper.title : t(MODE_LABEL_KEYS[practiceMode]),
      mode: groupPracticeIds ? 'group' : practiceMode,
      question_ids: selected.map(q => q.id),
      paper_id: practiceMode === 'paper' ? activeGeneratedPaper?.id : undefined,
      start_question_id: practiceMode === 'sequential' ? questions[currentIndex]?.id : undefined,
      duration_seconds: timed ? timed.duration_minutes * 60 : mock ? mock.config.duration_minutes * 60 : undefined,
      started_at: timed?.started_at ?? mock?.started_at,
    });
    if (timed) setTimedSession(null);
    if (mock) setMockExamSession(null);
  }, [viewMode, gradingMode, batchRequest, batchRecord, practiceQuestions, practiceMode, activeTimedSession, activeMockExamSession, activeGeneratedPaper, sessionId, groupPracticeIds, t, setTimedSession, setMockExamSession]);

  useEffect(() => {
    if (viewMode !== 'practice' || practiceMode !== 'sequential') setGroupPracticeIds(null);
  }, [viewMode, practiceMode, sessionId]);

  const handleRefreshQuestion = useCallback(async (questionId: string) => {
    await refreshQuestion(questionId);
  }, [refreshQuestion]);

  // 答题卡状态以本地会话（useQuestionBankSession）为准
  const sessionCurrentQuestionId = questions[currentIndex]?.id ?? null;
  const favoriteQuestionIds = useMemo(() => {
    const ids = new Set<string>();
    questions.forEach((question) => {
      if (question.isFavorite) ids.add(question.id);
    });
    return ids;
  }, [questions]);

  // 高级模式下 currentIndex 需要映射到过滤后的子集
  const practiceCurrentIndex = useMemo(() => {
    if (practiceQuestions === questions) return currentIndex;
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
      return;
    }
    handleNavigate(index);
  }, [practiceQuestions, questions, handleNavigate]);

  const requestPracticeNavigate = useCallback((index: number) => {
    requestQuestionNavigation(() => handlePracticeNavigate(index));
  }, [handlePracticeNavigate, requestQuestionNavigation]);

  // 浏览模式按全量题目顺序翻看；记忆的题被删后回到第一题
  const browseIndex = useMemo(() => {
    const idx = browseQuestionId ? questions.findIndex((q) => q.id === browseQuestionId) : -1;
    return idx >= 0 ? idx : 0;
  }, [browseQuestionId, questions]);

  const handleBrowseNavigate = useCallback((index: number) => {
    const target = questions[index];
    if (target) setBrowseQuestionId(target.id);
  }, [questions]);

  const handlePracticeFromBrowse = useCallback((questionId: string) => {
    const index = questions.findIndex((q) => q.id === questionId);
    if (index >= 0) handleQuestionClick(index);
  }, [handleQuestionClick, questions]);

  useExamQbankControlBridge({
    sessionId,
    viewMode,
    gradingMode,
    hasQuestions,
    questions,
    practiceQuestions,
    currentIndex,
    practiceMode,
    settingsPanelOpen,
    setSettingsPanelOpen,
    setPendingSettingsOpen,
    setFocusMode,
    setManageFilters,
    setElapsedTime,
    setStorePracticeMode,
    setSelectedTag,
    onResetToBatchImmediateDefaults: handleResetToBatchImmediateDefaults,
    navigate,
    requestViewMode,
    csvImportingRef,
    batchNavigateRef,
    agentFlashRootRef,
  });

  // PracticeLauncher 的 onStartPractice 回调
  const handleStartPractice = useCallback((mode: PracticeMode, tag?: string) => {
    setGradingMode('on_submit');
    setBatchRequest(null); setBatchRecord(null);
    setElapsedTime(0);
    setLauncherRequestedMode(null);
    setStorePracticeMode(mode);
    if (tag) setSelectedTag(tag);
    if (['mock_exam', 'timed', 'daily', 'paper'].includes(mode)) {
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
      const nextIdx = getPracticeStartIndex(questions, currentIndex, mode, tag);
      navigate(nextIdx);
    }
    switchViewMode('practice');
  }, [questions, currentIndex, navigate, setElapsedTime, setStorePracticeMode, switchViewMode, activeMockExamSession, activeTimedSession, activeDailyPractice, activeGeneratedPaper]);

  const refreshQuestionsAndStats = useCallback(async () => {
    await Promise.all([loadQuestions(), refreshStats()]);
  }, [loadQuestions, refreshStats]);

  // 重试按钮回调：吞掉 rejection（错误已由 hook 的 error 状态呈现），避免未处理的 Promise 拒绝
  const handleRetryQuestions = useCallback(() => {
    void refreshQuestionsAndStats().catch((err: unknown) => {
      debugLog.warn('[ExamContentView] retry load questions failed:', err);
    });
  }, [refreshQuestionsAndStats]);

  const handleImportComplete = useCallback(() => {
    handleRetryQuestions();
  }, [handleRetryQuestions]);

  const handleOpenCsvImport = useCallback(() => {
    requestViewMode('csvImport');
  }, [requestViewMode]);

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
          t('learningHub:exam.mutationRefreshFailed')
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

  const refreshAfterExternalMutation = useCallback(async () => {
    try {
      await refreshQuestionsAndStats();
    } catch (refreshErr: unknown) {
      debugLog.warn('[ExamContentView] refresh after batch mutation failed:', refreshErr);
      showGlobalNotification('warning', t('learningHub:exam.mutationRefreshFailed'));
    }
  }, [refreshQuestionsAndStats, t]);

  const handleBatchUpdateDifficulty = useCallback(async (questionIds: string[], difficulty: Difficulty) => {
    await useQuestionBankStore.getState().batchUpdateDifficulty(questionIds, difficulty);
    await refreshAfterExternalMutation();
  }, [refreshAfterExternalMutation]);

  const handleBatchUpdateTags = useCallback(async (
    questionIds: string[],
    op: { add?: string[]; remove?: string[] },
  ) => {
    await useQuestionBankStore.getState().batchUpdateTags(questionIds, {
      add: op.add ?? [],
      remove: op.remove ?? [],
    });
    await refreshAfterExternalMutation();
  }, [refreshAfterExternalMutation]);

  const handleRenameTag = useCallback(async (oldTag: string, newTag: string) => {
    await useQuestionBankStore.getState().renameTag(sessionId, oldTag, newTag);
    await refreshAfterExternalMutation();
  }, [refreshAfterExternalMutation, sessionId]);

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

  const handleRevertQuestions = useCallback(
    async (targets: Question[]) => {
      if (targets.length === 0) return;
      const completed: string[] = [];
      try {
        for (const snapshot of targets) {
          const entry = useQbankAgentDiffStore.getState().entriesByExamId[sessionId]
            ?.find((item) => item.questionId === snapshot.id && item.before === snapshot);
          if (!entry?.after) continue;
          const current = await invoke<StoreQuestion | null>('qbank_get_question', { questionId: snapshot.id });
          if (!useQbankAgentDiffStore.getState().entriesByExamId[sessionId]?.includes(entry)) continue;
          if (!current) { completed.push(snapshot.id); continue; }
          await invoke('qbank_update_question', {
            request: {
              question_id: snapshot.id,
              params: buildSelectiveQuestionRevertParams(snapshot, entry.after, convertToApiQuestion(current)),
              record_history: true,
            },
          });
          completed.push(snapshot.id);
        }
      } catch (err: unknown) {
        showGlobalNotification(
          'error',
          err,
          t('exam_sheet:agentDiff.revertFailed', {
            defaultValue: '撤回题目修改失败，请重试',
          }),
        );
        await refreshQuestionsAndStats().catch(() => undefined);
        throw new QuestionRevertError(completed, err);
      }

      try {
        await refreshQuestionsAndStats();
      } catch (refreshErr: unknown) {
        debugLog.warn('[ExamContentView] refresh after revert failed:', refreshErr);
      }

      showGlobalNotification(
        'success',
        t('exam_sheet:agentDiff.revertSuccess', {
          defaultValue: '已撤回题目修改',
        }),
      );
    },
    [refreshQuestionsAndStats, sessionId, t],
  );

  const handleBackToLauncher = useCallback(() => {
    requestViewMode('launcher');
  }, [requestViewMode]);

  const {
    isImportingSession,
    isResuming,
    resumedImportDraft,
    setResumedImportDraft,
    resumeError,
    showImportAudit,
    setShowImportAudit,
    showAiGenerationPanel,
    setShowAiGenerationPanel,
    aiGenerationTarget,
    setAiGenerationTarget,
    confirmingDraftJobId,
    activeGenerationTask,
    pendingAuthoringDrafts,
    handleReviewPendingDraft,
    handleConfirmPendingDraft,
    handleResumeImport,
    handleOpenAiGeneration,
    handleOpenGenerationProgress,
  } = useExamAuthoringDrafts({
    sessionId,
    sessionDetail,
    setSessionDetail,
    latestSessionIdRef,
    questionsLength: questions.length,
    loadQuestions,
    refreshQuestionsAndStats,
    switchViewMode,
  });

  const isEmptySession = sessionDetail?.summary.status === 'empty' &&
    (!sessionDetail?.preview.pages || sessionDetail.preview.pages.length === 0);
  const sessionStatus = sessionDetail?.summary?.status ?? null;

  // 硬件返回键（移动端）：viewMode 处于非根态（非 list/launcher）时，先执行页内返回
  const hardwareBackRef = useRef({ viewMode, isActive, requestViewMode });
  hardwareBackRef.current = { viewMode, isActive, requestViewMode };
  const isNonRootViewMode = viewMode !== 'list' && viewMode !== 'launcher';
  useEffect(() => {
    if (!isSmallScreen || !isNonRootViewMode) return;
    return registerBackHandler(() => {
      const { viewMode: mode, isActive: active, requestViewMode: request } = hardwareBackRef.current;
      if (active === false || mode === 'list' || mode === 'launcher') return false;
      if (agentFlashRootRef.current?.closest('[inert]')) return false;
      request(mode === 'practice' ? 'launcher' : 'list');
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isSmallScreen, isNonRootViewMode]);

  useEffect(() => {
    emitExamSheetDebug('debug', 'frontend:hook-state',
      `[ExamContentView] 渲染决策: isEmptySession=${isEmptySession}, hasQuestions=${hasQuestions}, viewMode=${viewMode}, isLoading=${isLoading}, sessionDetail.status=${sessionStatus ?? 'null'}, error=${error ?? 'null'}`,
      { sessionId },
    );
  }, [isEmptySession, hasQuestions, viewMode, isLoading, sessionStatus, error, sessionId]);

  const handleUploadSuccess = useCallback(async (detail: ExamSheetSessionDetail) => {
    setResumedImportDraft(null);
    emitExamSheetDebug('info', 'frontend:navigate', `[ExamContentView] onUploadSuccess 触发, pages=${detail.preview.pages?.length}`, { sessionId });
    await handleSessionUpdate(detail);
    if (latestSessionIdRef.current !== sessionId) return;
    emitExamSheetDebug('info', 'frontend:navigate', `[ExamContentView] onUploadSuccess 完成 → setViewMode('list')`, { sessionId });
    switchViewMode('list');
  }, [handleSessionUpdate, sessionId, setResumedImportDraft, switchViewMode]);

  const handleUploaderBack = useCallback(() => {
    switchViewMode('list');
  }, [switchViewMode]);

  const handleCreateQuestionEntry = useCallback(() => {
    requestViewMode('list', () => setListCreateRequestKey((key) => key + 1));
  }, [requestViewMode]);

  const handleOpenUploadEntry = useCallback(() => {
    setPendingUploadFiles(null);
    requestViewMode('upload');
  }, [requestViewMode]);

  const handleLauncherFilesDropped = useCallback((files: File[]) => {
    if (files.length === 0) return;
    requestViewMode('upload', () => setPendingUploadFiles(files));
  }, [requestViewMode]);

  const handleRetryLoad = useCallback(() => {
    void loadSessionDetail();
    if (error) {
      void loadQuestions().catch((err: unknown) => {
        debugLog.warn('[ExamContentView] retry load questions failed:', err);
      });
    }
  }, [loadSessionDetail, error, loadQuestions]);

  // 题目清空（如在管理/练习视图删光题目）后，依赖题目的视图回退到题库列表
  useEffect(() => {
    const hasSavedSurface = viewMode === 'papers' || (viewMode === 'practice' && (batchRequest || batchRecord));
    if (!hasQuestions && !isLoading && !hasSavedSurface && viewMode !== 'list' && viewMode !== 'upload' && viewMode !== 'csvImport') {
      switchViewMode('list');
    }
  }, [hasQuestions, isLoading, viewMode, switchViewMode, batchRequest, batchRecord]);

  const { handleFocusQuestionById } = useExamDomainRefreshAndAnchors({
    sessionId,
    nodePath: node.path,
    isActive,
    focusScopeId,
    viewMode,
    gradingMode,
    questions,
    questionsRef,
    practiceQuestions,
    currentIndex,
    navigate,
    requestViewMode,
    setBrowseQuestionId,
    setGroupPracticeIds,
    setStorePracticeMode,
    refreshQuestionsAndStats,
    handleOpenQuestion,
    draftStateRef,
    flushPendingQbankRefreshRef,
    batchNavigateRef,
    agentFlashRootRef,
  });

  const examTitle = sessionDetail?.summary?.exam_name || node.name;

  const activeQuestionId = useMemo(() => {
    if (viewMode === 'browse') {
      return questions[browseIndex]?.id ?? sessionCurrentQuestionId;
    }
    if (viewMode === 'practice') {
      return practiceQuestions[practiceCurrentIndex]?.id ?? sessionCurrentQuestionId;
    }
    return sessionCurrentQuestionId;
  }, [browseIndex, practiceCurrentIndex, practiceQuestions, questions, sessionCurrentQuestionId, viewMode]);

  const activeDragQuestionIndex = useMemo(() => {
    if (!activeQuestionId) return -1;
    return questions.findIndex((q) => q.id === activeQuestionId);
  }, [activeQuestionId, questions]);

  const activeDragQuestion = activeDragQuestionIndex >= 0 ? questions[activeDragQuestionIndex] : null;

  const activeDragQuestionMeta = useMemo(() => {
    if (!activeDragQuestion || !sessionId) return null;
    return deriveQuestionExcerptMeta({
      resourceId: sessionId,
      question: activeDragQuestion,
      questionIndex: activeDragQuestionIndex,
    });
  }, [activeDragQuestion, activeDragQuestionIndex, sessionId]);

  const mistakeQuestions = useMemo(
    () => questions.filter((q) => q.status === 'review'),
    [questions],
  );

  const handleQuestionDragStart = useCallback(
    (event: React.DragEvent, question: Question, questionIndex?: number) => {
      if (!sessionId) return;
      startQuestionExcerptDrag(event.nativeEvent, {
        resourceId: sessionId,
        aliasResourceId: node.path,
        examTitle,
        question,
        questionIndex,
      });
    },
    [examTitle, node.path, sessionId],
  );

  const handleRootPointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (
      target.closest(
        'input, textarea, select, [contenteditable="true"], [data-question-inline-editor]',
      )
    ) {
      return;
    }
    const entityEl = target.closest<HTMLElement>('[data-agent-entity^="exam:"]');
    if (entityEl && !entityEl.draggable) {
      entityEl.draggable = true;
    }
  }, []);

  const handleRootDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || !sessionId) return;
      if (event.dataTransfer?.types?.includes(DS_EXCERPT_MIME)) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[data-question-inline-editor]')) return;
      const entityEl = target.closest<HTMLElement>('[data-agent-entity^="exam:"]');
      if (!entityEl) return;
      const attr = entityEl.getAttribute('data-agent-entity') ?? '';
      const questionId = attr.slice('exam:'.length).trim();
      if (!questionId) return;
      const qIndex = questionsRef.current.findIndex((q) => q.id === questionId);
      if (qIndex < 0) return;
      startQuestionExcerptDrag(event.nativeEvent, {
        resourceId: sessionId,
        aliasResourceId: node.path,
        examTitle,
        question: questionsRef.current[qIndex]!,
        questionIndex: qIndex,
      });
    },
    [examTitle, node.path, sessionId],
  );

  // ========== 条件返回（早期退出） ==========

  if (!sessionId) {
    return (
      <div className="ui-rise-in flex flex-col items-center justify-center h-full gap-3 px-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted/60">
          <WarningCircle size={26} className="text-muted-foreground" />
        </div>
        <span className="text-sm text-muted-foreground">
          {t('exam_sheet:errors.noSession')}
        </span>
      </div>
    );
  }

  if ((sessionDetailError || error) && !sessionDetail && !isLoading) {
    const loadErrorMessage = sessionDetailError || error;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 px-6 ui-rise-in">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
          <WarningCircle size={26} className="text-destructive" />
        </div>
        <div className="flex flex-col items-center gap-1 text-center max-w-md" role="alert">
          <span className="text-sm font-medium text-foreground">{t('exam_sheet:errors.loadFailed')}</span>
          <span className="text-xs text-muted-foreground break-words">{loadErrorMessage}</span>
        </div>
        <DsButton variant="ghost" size="sm" onClick={handleRetryLoad} className="gap-2">
          <ArrowClockwise size={16} />
          {t('common:actions.retry')}
        </DsButton>
      </div>
    );
  }

  // 会话详情未就绪，或题目仍在首次加载
  if (!sessionDetail || (isLoading && !hasQuestions && !isResuming)) {
    return (
      <div className="h-full ui-fade-in-slow">
        <ViewSkeleton />
      </div>
    );
  }

  return (
    <div
      ref={agentFlashRootRef}
      onPointerDownCapture={handleRootPointerDownCapture}
      onDragStart={handleRootDragStart}
      className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background"
    >
      <ExamHeaderAndTabs
        sessionId={sessionId}
        readOnly={readOnly}
        isSmallScreen={isSmallScreen}
        isLoading={isLoading}
        hasQuestions={hasQuestions}
        questionsCount={questions.length}
        stats={stats}
        viewMode={viewMode}
        gradingMode={gradingMode}
        practiceMode={practiceMode}
        modeOptions={MODE_OPTIONS}
        secondaryTabs={secondaryTabs}
        sm2DueCount={sm2DueCount}
        isImportingSession={isImportingSession}
        isResuming={isResuming}
        resumeError={resumeError}
        error={error}
        isAdvancedRuntimeTimer={isAdvancedRuntimeTimer}
        advancedTimerRemaining={advancedTimerRemaining}
        elapsedTime={elapsedTime}
        isTimerRunning={isTimerRunning}
        onToggleTimer={toggleTimer}
        activeQuestionId={activeQuestionId}
        activeDragQuestion={activeDragQuestion}
        activeDragQuestionIndex={activeDragQuestionIndex}
        activeDragQuestionMeta={activeDragQuestionMeta}
        onQuestionDragStart={handleQuestionDragStart}
        onRequestViewMode={requestViewMode}
        onSelectMode={handleSelectMode}
        onResumeImport={() => { void handleResumeImport(); }}
        onRetryQuestions={handleRetryQuestions}
        onOpenExport={handleOpenExport}
        onCreateQuestionEntry={handleCreateQuestionEntry}
        onOpenAiGeneration={handleOpenAiGeneration}
        onOpenUploadEntry={handleOpenUploadEntry}
        onOpenCsvImport={handleOpenCsvImport}
        onOpenImportAudit={() => setShowImportAudit(true)}
        pendingReviewExitView={pendingReviewExitView}
        onCancelReviewExit={cancelReviewExit}
        onConfirmReviewExit={confirmReviewExit}
        pendingPracticeExitView={pendingPracticeExitView}
        onCancelPracticeExit={cancelPracticeExit}
        onConfirmPracticeExit={confirmPracticeExit}
        pendingDraftNavigation={pendingDraftNavigation}
        onCancelDiscardDraft={cancelDiscardDraft}
        onConfirmDiscardDraft={confirmDiscardDraft}
        activeGenerationTask={activeGenerationTask}
        onOpenGenerationProgress={handleOpenGenerationProgress}
        pendingAuthoringDrafts={pendingAuthoringDrafts}
        confirmingDraftJobId={confirmingDraftJobId}
        onConfirmPendingDraft={(draft) => { void handleConfirmPendingDraft(draft); }}
        onReviewPendingDraft={handleReviewPendingDraft}
        onRevertQuestions={handleRevertQuestions}
        onFocusQuestionById={handleFocusQuestionById}
      />

      {/* 内容区：viewMode 变化时以淡入 + 轻微上移过渡 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={<ViewSkeleton />}>
          <div key={viewMode} className="h-full min-h-0 ui-rise-in">
            {viewMode === 'papers' ? (
              <PaperLibrary
                examId={sessionId}
                readOnly={readOnly}
                onOpenPractice={(id, submitted) => {
                  setGradingMode('on_submit');
                  setBatchRequest(null);
                  setBatchRecord({ id, submitted });
                  switchViewMode('practice');
                }}
                onStartPaper={paper => {
                  setGradingMode('on_submit');
                  setBatchRecord(null);
                  setBatchRequest({
                    id: newPracticeId(),
                    scope_id: sessionId,
                    title: paper.title,
                    mode: 'paper',
                    paper_id: paper.id,
                    question_ids: [],
                  });
                  switchViewMode('practice');
                }}
              />
            ) : viewMode === 'practice' && gradingMode === 'on_submit' && (!readOnly || batchRecord?.submitted) ? (
              batchRequest || batchRecord ? (
                <BatchPracticeWorkspace
                  key={batchRequest?.id ?? batchRecord?.id}
                  readOnly={readOnly}
                  request={batchRequest ?? undefined}
                  practiceId={batchRecord?.id}
                  submitted={batchRecord?.submitted}
                  onBack={() => {
                    setBatchRequest(null);
                    setBatchRecord(null);
                    switchViewMode('launcher');
                  }}
                  onFlushReady={setBatchFlush}
                  onNavigateReady={setBatchNavigate}
                  onDirtyChange={handlePracticeDraftDirtyChange}
                  onChanged={() => { void loadQuestions(); }}
                  isActive={isActive}
                />
              ) : (
                <div className="space-y-3 p-4">
                  <p className="text-sm text-muted-foreground">{t('practice:batch.noQuestions')}</p>
                  <DsButton variant="outline" onClick={() => switchViewMode('launcher')}>{t('common:back')}</DsButton>
                </div>
              )
            ) : viewMode === 'launcher' && hasQuestions ? (
              /* 练习启动页 — 选择练习模式 */
              <PracticeLauncher
                examId={sessionId}
                stats={stats}
                questions={questions}
                onStartPractice={handleStartPractice}
                onStartDrill={(mode, tag) => {
                  setGradingMode('immediate');
                  setBatchRequest(null);
                  setBatchRecord(null);
                  setStorePracticeMode(mode);
                  if (tag) setSelectedTag(tag);
                  navigate(getPracticeStartIndex(questions, currentIndex, mode, tag));
                  switchViewMode('practice');
                }}
                onOpenPractice={(id, submitted) => {
                  setGradingMode('on_submit');
                  setBatchRequest(null);
                  setBatchRecord({ id, submitted });
                  switchViewMode('practice');
                }}
                requestedMode={launcherRequestedMode}
                onRequestedModeHandled={() => setLauncherRequestedMode(null)}
                currentQuestionId={sessionCurrentQuestionId}
                markedQuestionIds={favoriteQuestionIds}
                isActive={isActive}
              />
            ) : viewMode === 'manage' && hasQuestions ? (
              <QuestionBankManageView
                questions={manageQuestions}
                isLoading={isLoading}
                filters={manageFilters}
                onDelete={readOnly ? undefined : handleDeleteQuestions}
                onToggleFavorite={readOnly ? undefined : handleToggleFavorite}
                onResetProgress={readOnly ? undefined : handleResetProgress}
                onBatchUpdateDifficulty={readOnly ? undefined : handleBatchUpdateDifficulty}
                onBatchUpdateTags={readOnly ? undefined : handleBatchUpdateTags}
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
                onSelectQuestion={(question) => handleOpenQuestion(question.id)}
                onToggleFavorite={readOnly ? undefined : handleToggleFavorite}
                onViewHistory={handleOpenHistory}
                onBrowseQuestions={() => switchViewMode('list')}
              />
            ) : viewMode === 'tags' && hasQuestions ? (
              /* 知识点导航视图 */
              <TagNavigationView
                questions={questions}
                onQuestionClick={handleQuestionClick}
                onStartPracticeByTag={handleStartPracticeByTag}
                onRenameTag={readOnly ? undefined : handleRenameTag}
              />
            ) : viewMode === 'sm2' && hasQuestions ? (
              /* I1 修复：SM-2 间隔复习视图（计划面板 + 复习会话） */
              <Sm2ReviewPanel
                examId={sessionId}
                isActive={isActive}
                ReviewCalendarView={ReviewCalendarView}
                ReviewSession={ReviewSession}
                ReviewPlanView={ReviewPlanView}
              />
            ) : viewMode === 'review' && hasQuestions ? (
              /* 错题本视图 */
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1 overflow-hidden">
                  <ReviewQuestionsView
                    questions={questions}
                    stats={stats}
                    onQuestionClick={handleQuestionClick}
                    onStartReview={handleStartReview}
                    onResetProgress={readOnly ? undefined : handleResetProgress}
                    onDelete={readOnly ? undefined : handleDeleteQuestions}
                  />
                </div>
              </div>
            ) : viewMode === 'csvImport' && !readOnly ? (
              /* CSV 导入 — 内嵌整页流程（非模态） */
              <CsvImportPanel
                examId={sessionId}
                examName={sessionDetail?.summary?.exam_name || node.name}
                onClose={() => switchViewMode('list')}
                onImportComplete={handleImportComplete}
                onImportingChange={(importing) => { csvImportingRef.current = importing; }}
              />
            ) : viewMode === 'upload' && !readOnly ? (
              <ExamSheetUploader
                sessionId={sessionId}
                sessionName={sessionDetail?.summary?.exam_name || node.name}
                initialFiles={pendingUploadFiles}
                initialDraft={resumedImportDraft}
                onInitialFilesConsumed={() => setPendingUploadFiles(null)}
                onUploadSuccess={handleUploadSuccess}
                onBack={handleUploaderBack}
                onManualCreate={handleCreateQuestionEntry}
              />
            ) : viewMode === 'browse' && hasQuestions && practiceSessionOwner ? (
              /* 只读浏览：答案 / 解析 / AI 解析（#466 / #467） */
              <QuestionBankEditor
                sessionId={sessionId}
                practiceSessionOwner={practiceSessionOwner}
                questions={questions}
                currentIndex={browseIndex}
                browseMode
                showTimer={false}
                isActive={isActive}
                onNavigate={handleBrowseNavigate}
                onToggleFavorite={readOnly ? undefined : handleToggleFavorite}
                onRefreshQuestion={readOnly ? undefined : handleRefreshQuestion}
                onPracticeQuestion={handlePracticeFromBrowse}
                onBack={() => requestViewMode('list')}
              />
            ) : viewMode === 'practice' && hasQuestions && practiceSessionOwner ? (
              <QuestionBankEditor
                sessionId={sessionId}
                practiceSessionOwner={practiceSessionOwner}
                questions={practiceQuestions}
                stats={stats}
                currentIndex={practiceCurrentIndex}
                practiceMode={practiceMode}
                showTimer={true}
                timerDuration={activeAdvancedTimerDuration ?? undefined}
                timerElapsedSeconds={elapsedTime}
                timerRunning={isTimerRunning}
                onTimerRunningChange={setIsTimerRunning}
                allowTimerControl={!isAdvancedRuntimeTimer}
                selectedTag={selectedTag}
                focusMode={focusMode}
                onFocusModeChange={setFocusMode}
                settingsPanelOpen={settingsPanelOpen}
                onSettingsPanelOpenChange={setSettingsPanelOpen}
                isActive={isActive}
                onSubmitAnswer={readOnly ? undefined : handleSubmitAnswer}
                onNavigate={handlePracticeNavigate}
                onModeChange={handleModeChange}
                onMarkCorrect={readOnly ? undefined : handleMarkCorrect}
                onGradingResolved={readOnly ? undefined : handleGradingResolved}
                onRefreshQuestion={readOnly ? undefined : handleRefreshQuestion}
                onToggleFavorite={readOnly ? undefined : handleToggleFavorite}
                onUpdateUserNote={readOnly ? undefined : handleUpdateUserNote}
                onDeleteQuestion={readOnly ? undefined : handleDeleteQuestion}
                onBack={handleBackToLauncher}
                onDraftDirtyChange={handlePracticeDraftDirtyChange}
                onDraftNavigationRequested={requestPracticeNavigate}
              />
            ) : (
              /* 列表视图 - 内联编辑 */
              <QuestionBankListView
                questions={questions}
                stats={stats}
                examId={sessionId}
                onQuestionClick={handleQuestionClick}
                onViewAnswer={handleViewAnswer}
                onDelete={readOnly ? undefined : handleDeleteQuestions}
                onResetProgress={readOnly ? undefined : handleResetProgress}
                onToggleFavorite={readOnly ? undefined : toggleFavoriteInSession}
                onStartGroupPractice={handleStartGroupPractice}
                onUpdateQuestion={readOnly ? undefined : handleListChanged}
                onCreateQuestion={readOnly ? undefined : handleListChanged}
                onUploadQuestions={readOnly ? undefined : handleOpenUploadEntry}
                onUploadFiles={readOnly ? undefined : handleLauncherFilesDropped}
                onCsvImport={readOnly ? undefined : handleOpenCsvImport}
                onAiGenerate={readOnly ? undefined : handleOpenAiGeneration}
                pendingDrafts={readOnly ? undefined : pendingAuthoringDrafts}
                activeGenerationTask={readOnly ? undefined : activeGenerationTask}
                confirmingDraftJobId={confirmingDraftJobId}
                onReviewPendingDraft={readOnly ? undefined : handleReviewPendingDraft}
                onConfirmPendingDraft={readOnly ? undefined : handleConfirmPendingDraft}
                onOpenGenerationProgress={
                  readOnly || !activeGenerationTask
                    ? undefined
                    : handleOpenGenerationProgress
                }
                createRequestKey={listCreateRequestKey}
                onDraftDirtyChange={handleInlineEditorDraftDirtyChange}
                onDraftNavigationRequested={(index) => {
                  requestQuestionNavigation(() => handleQuestionClick(index));
                }}
              />
            )}
          </div>
        </Suspense>
      </div>

      {/* 导入审计对话框 */}
      <DsDialog open={showImportAudit} onOpenChange={setShowImportAudit}>
        <DsDialogHeader>
          <DsDialogTitle>{t('exam_sheet:uploader.audit_imports', { defaultValue: '导入记录与重解析复核' })}</DsDialogTitle>
        </DsDialogHeader>
        <DsDialogBody className="overflow-y-auto">
          {showImportAudit && <Suspense fallback={<ViewSkeleton />}><QuestionImportAuditPanel examId={sessionId} onChanged={handleListChanged} /></Suspense>}
        </DsDialogBody>
      </DsDialog>

      {showAiGenerationPanel && (
        <Suspense fallback={null}>
          <AiQuestionGenerationPanel
            open={showAiGenerationPanel}
            onOpenChange={(nextOpen) => {
              setShowAiGenerationPanel(nextOpen);
              if (!nextOpen) setAiGenerationTarget(null);
            }}
            examId={sessionId}
            examName={sessionDetail?.summary?.exam_name || node.name}
            onImportComplete={handleListChanged}
            availableTags={availableTagsForAiGeneration}
            initialTaskId={aiGenerationTarget?.taskId ?? null}
            initialDraftJobId={aiGenerationTarget?.jobId ?? null}
          />
        </Suspense>
      )}

      {/* 导出 / 历史：全端统一走组件自带的内联子屏形态（absolute inset-0） */}
      <Suspense fallback={null}>
        <QuestionBankExportDialog
          open={showExportDialog}
          onOpenChange={setShowExportDialog}
          questions={questions}
          examName={sessionDetail?.summary?.exam_name || node.name}
          examId={sessionId}
          inline
          isActive={isActive}
        />
        <QuestionHistoryView
          questionId={historyQuestionId}
          open={showHistoryDialog}
          onOpenChange={handleHistoryOpenChange}
          inline
          onJumpToQuestion={handleOpenQuestion}
          isActive={isActive}
        />
      </Suspense>
    </div>
  );
};

export default ExamContentView;
