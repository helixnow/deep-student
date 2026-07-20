import React, { lazy, Suspense, useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { CircleNotch, WarningCircle, ArrowClockwise, Scan, Tag, Clock, Play, Pause, ArrowClockwise as RotateCw, GearSix, ChartBar, Star, Download, Plus, CaretDown, PencilSimple, XCircle, ClockCounterClockwise, Table as TableIcon } from '@phosphor-icons/react';
import { TauriAPI, type ExamSheetSessionDetail } from '@/utils/tauriApi';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { percentOf, ratioToPercent } from '@/components/stats';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { 
  getNextQuestionIndex,
  type Question,
  type PracticeMode,
  type QuestionType,
  type QuestionStatus,
  type Difficulty,
  type QuestionBankStats,
} from '@/api/questionBankApi';
import { invoke } from '@tauri-apps/api/core';
import { useQuestionBankSession } from '@/hooks/useQuestionBankSession';
import {
  useQuestionBankStore,
  validateQbankPracticeHandoff,
  type PracticeHandoffHydrationResult,
} from '@/stores/questionBankStore';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { AppSelect, AppMenu, AppMenuTrigger, AppMenuContent, AppMenuItem, AppMenuSeparator } from '@/components/ui/app-menu';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { formatTime } from '@/utils/formatUtils';
import { emitExamSheetDebug } from '@/debug-panel/plugins/ExamSheetProcessingDebugPlugin';
import {
  QBANK_FOCUS_EVENT,
  type QbankFocusEventDetail,
  QBANK_CONTROL_EVENT,
  type QbankControlEventDetail,
  type QbankControlResult,
  QBANK_REFRESH_EVENT,
  isQbankInlineEditorActive,
} from '@/features/workbench/agent/drivers/qbankDriver';
import { collectDomainEntityIds } from '@/features/workbench/agent/domainEvents';
import { agentFlash, agentFlashMany } from '@/features/workbench/agent/visuals/agentFlash';
import type { DomainChangePayload } from '@/features/workbench/agent/types';
import { registerContentDirtyChecker } from '@/features/workbench/apps/content/contentDirtyRegistry';

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
const ReviewCalendarView = lazy(() => import('@/components/ReviewCalendarView'));
const TagNavigationView = lazy(() => import('@/components/TagNavigationView'));
const PracticeLauncher = lazy(() => import('@/components/practice/PracticeLauncher'));
const CsvImportPanel = lazy(() => import('@/components/CsvImportDialog').then((module) => ({ default: module.CsvImportPanel })));
const QuestionBankExportDialog = lazy(() => import('@/components/QuestionBankExportDialog'));

type ViewMode = 'list' | 'manage' | 'stats' | 'favorites' | 'practice' | 'upload' | 'review' | 'sm2' | 'tags' | 'launcher' | 'csvImport';
type LauncherRequestedMode = 'by_tag' | 'timed' | 'mock_exam' | 'daily' | 'paper';
type DraftSource = 'practice' | 'inlineEditor';

interface PendingDraftNavigation {
  examId: string;
  proceed: () => void;
}

const LAUNCHER_REQUIRED_MODES = new Set<LauncherRequestedMode>([
  'by_tag',
  'timed',
  'mock_exam',
  'daily',
  'paper',
]);

/**
 * ★ I1 修复：SM-2 间隔复习面板
 *
 * 有活跃复习会话时渲染 ReviewSession（答题打分），否则渲染 ReviewPlanView
 * （今日到期/复习队列/开始复习）。会话由 reviewPlanStore 全局管理。
 */
const Sm2ReviewPanel: React.FC<{ examId: string; isActive?: boolean }> = ({ examId, isActive }) => {
  const session = useReviewPlanStore((s) => s.session);
  const startSession = useReviewPlanStore((s) => s.startSession);
  const [showCalendar, setShowCalendar] = useState(false);
  const isSessionActive = session.isActive && session.examId === examId;

  return (
    <CustomScrollArea className="min-h-0 flex-1">
      <Suspense fallback={null}>
        {showCalendar ? (
          <ReviewCalendarView
            examId={examId}
            className="p-4"
            onClose={() => setShowCalendar(false)}
          />
        ) : isSessionActive ? (
          <ReviewSession examId={examId} isActive={isActive} />
        ) : (
          <ReviewPlanView
            examId={examId}
            onViewCalendar={() => setShowCalendar(true)}
            onStartReview={(items) => startSession(items, examId)}
            onReviewItemClick={(item) => startSession([item], examId)}
          />
        )}
      </Suspense>
    </CustomScrollArea>
  );
};

interface ManageFilters {
  search?: string;
  status?: QuestionStatus[];
  difficulty?: Difficulty[];
  questionType?: QuestionType[];
  tags?: string[];
  isFavorite?: boolean;
}

function controlStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return undefined;
  return value.filter((item) => item.trim().length > 0);
}

function parseManageFilters(payload: unknown): ManageFilters | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const outer = payload as Record<string, unknown>;
  const raw = outer.filters && typeof outer.filters === 'object' && !Array.isArray(outer.filters)
    ? outer.filters as Record<string, unknown>
    : outer;
  const search = typeof raw.search === 'string' ? raw.search : undefined;
  const isFavorite = typeof (raw.is_favorite ?? raw.isFavorite) === 'boolean'
    ? (raw.is_favorite ?? raw.isFavorite) as boolean
    : undefined;

  return {
    search,
    status: controlStringArray(raw.status) as QuestionStatus[] | undefined,
    difficulty: controlStringArray(raw.difficulty) as Difficulty[] | undefined,
    questionType: controlStringArray(raw.question_type ?? raw.questionType) as QuestionType[] | undefined,
    tags: controlStringArray(raw.tags),
    isFavorite,
  };
}

function matchesPracticeTag(question: Question, tag: string): boolean {
  if (tag === '__untagged__') return !question.tags || question.tags.length === 0;
  return question.tags?.includes(tag) ?? false;
}

const MODE_LABEL_KEYS: Record<PracticeMode, string> = {
  sequential: 'learningHub:exam.mode.sequential',
  random: 'learningHub:exam.mode.random',
  review_first: 'learningHub:exam.mode.reviewFirst',
  review_only: 'learningHub:exam.mode.reviewOnly',
  by_tag: 'learningHub:exam.mode.byTag',
  daily: 'learningHub:exam.mode.daily',
  paper: 'learningHub:exam.mode.paper',
  timed: 'learningHub:exam.mode.timed',
  mock_exam: 'learningHub:exam.mode.mockExam',
};

/** 数字滚动动效：以 rAF 缓动逼近目标值，reduced-motion 时直接跳变 */
function useAnimatedNumber(target: number, duration = 600): number {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);

  useEffect(() => {
    const from = valueRef.current;
    if (from === target) return;
    if (typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const next = from + (target - from) * eased;
      valueRef.current = next;
      setValue(next);
      if (progress < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);

  return value;
}

/** 轻量 SVG 进度环（颜色随 currentColor） */
const ProgressRing: React.FC<{ ratio: number; size?: number; className?: string }> = ({ ratio, size = 18, className }) => {
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(1, Math.max(0, ratio));
  const center = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className} aria-hidden="true">
      <circle cx={center} cy={center} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={stroke} />
      <circle
        cx={center}
        cy={center}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped)}
        transform={`rotate(-90 ${center} ${center})`}
        className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
      />
    </svg>
  );
};

/** 顶栏统计摘要：掌握率进度环 + 正确率，数字滚动 */
const StatsSummary: React.FC<{ stats: QuestionBankStats }> = ({ stats }) => {
  const { t } = useTranslation('learningHub');
  const masteryRatio = stats.total > 0 ? stats.mastered / stats.total : 0;
  const masteryPercent = Math.round(useAnimatedNumber(percentOf(stats.mastered, stats.total)));
  const correctPercent = Math.round(useAnimatedNumber(ratioToPercent(stats.correctRate)));

  return (
    <div
      className="hidden md:flex items-center gap-3 pr-1 select-none"
      role="group"
      aria-label={t('exam.shell.statsSummary')}
    >
      <div className="flex items-center gap-1.5" title={`${t('exam.shell.mastery')} ${stats.mastered}/${stats.total}`}>
        <ProgressRing ratio={masteryRatio} className="text-success" />
        <div className="flex items-baseline gap-1 leading-none">
          <span className="text-xs font-semibold tabular-nums text-foreground">{masteryPercent}%</span>
          <span className="text-[10px] text-muted-foreground">{t('exam.shell.mastery')}</span>
        </div>
      </div>
      <div className="w-px h-3.5 bg-border/60" aria-hidden="true" />
      <div className="flex items-baseline gap-1 leading-none" title={t('exam.shell.correctRate')}>
        <span className="text-xs font-semibold tabular-nums text-foreground">{correctPercent}%</span>
        <span className="text-[10px] text-muted-foreground">{t('exam.shell.correctRate')}</span>
      </div>
    </div>
  );
};

/** Suspense 骨架屏：模拟工具行 + 列表行，替代空白/转圈 */
const ViewSkeleton: React.FC = () => {
  const { t } = useTranslation('learningHub');
  return (
    <div className="h-full overflow-hidden px-4 py-4" role="status" aria-label={t('exam.shell.viewLoading')}>
      <div className="animate-pulse space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="h-7 w-36 rounded-md bg-muted/70" />
          <div className="flex items-center gap-2">
            <div className="h-7 w-20 rounded-md bg-muted/50" />
            <div className="h-7 w-14 rounded-md bg-muted/50" />
          </div>
        </div>
        <div className="space-y-2.5">
          {[0, 1, 2, 3, 4, 5].map((row) => (
            <div key={row} className="rounded-lg border border-border/40 px-3 py-3">
              <div className="h-4 rounded bg-muted/60" style={{ width: `${[72, 58, 84, 64, 76, 52][row]}%` }} />
              <div className="mt-2.5 flex items-center gap-2">
                <div className="h-3 w-12 rounded bg-muted/40" />
                <div className="h-3 w-16 rounded bg-muted/40" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const ExamContentView: React.FC<ContentViewProps> = ({
  node,
  readOnly = false,
  isActive,
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
    toggleFavorite: toggleFavoriteInSession,
  } = useQuestionBankSession({ examId: sessionId });
  const hasQuestions = questions.length > 0;

  // 二级视图（收纳进 Tab 栏「更多」菜单）：错题 / 复习 / 收藏 / 知识点 / 统计 / 管理
  const secondaryTabs = useMemo(() => ([
    { mode: 'review' as ViewMode, label: t('learningHub:exam.tab.wrongAnswers'), icon: XCircle, badge: stats?.review ?? 0 },
    { mode: 'sm2' as ViewMode, label: t('review:title'), icon: ClockCounterClockwise, badge: 0 },
    { mode: 'favorites' as ViewMode, label: t('learningHub:exam.tab.favorites'), icon: Star, badge: 0 },
    { mode: 'tags' as ViewMode, label: t('learningHub:exam.tab.topics'), icon: Tag, badge: 0 },
    { mode: 'stats' as ViewMode, label: t('learningHub:exam.tab.stats'), icon: ChartBar, badge: 0 },
    { mode: 'manage' as ViewMode, label: t('learningHub:exam.tab.manage'), icon: GearSix, badge: 0 },
  ]), [t, stats?.review]);

  // 专注模式（从 Store 获取 — 全局 UI 偏好，不需要本地化）
  const focusMode = useQuestionBankStore(state => state.focusMode);
  const setFocusMode = useQuestionBankStore(state => state.setFocusMode);
  const setMockExamSession = useQuestionBankStore(state => state.setMockExamSession);
  const setTimedSession = useQuestionBankStore(state => state.setTimedSession);
  const submitMockExam = useQuestionBankStore(state => state.submitMockExam);
  const reviewSession = useReviewPlanStore(state => state.session);
  const endReviewSession = useReviewPlanStore(state => state.endSession);

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
  const [selectedTag, setSelectedTag] = useState<string>('');
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  const [historyQuestionId, setHistoryQuestionId] = useState<string | null>(null);
  const [manageFilters, setManageFilters] = useState<ManageFilters>({});
  const [pendingReviewExitView, setPendingReviewExitView] = useState<ViewMode | null>(null);
  const [settingsPanelOpen, setSettingsPanelOpen] = useState(false);
  const [pendingSettingsOpen, setPendingSettingsOpen] = useState(false);
  const [launcherRequestedMode, setLauncherRequestedMode] = useState<LauncherRequestedMode | null>(null);
  // 从题库启动台拖入、待传给识别导入的文件
  const [pendingUploadFiles, setPendingUploadFiles] = useState<File[] | null>(null);
  // 从「添加题目」菜单请求列表视图打开内联创建编辑器的信号（递增触发）
  const [listCreateRequestKey, setListCreateRequestKey] = useState(0);
  const [draftState, setDraftState] = useState({ examId: sessionId, dirty: false });
  const [pendingDraftNavigation, setPendingDraftNavigation] = useState<PendingDraftNavigation | null>(null);
  const activeDraftExamIdRef = useRef(sessionId);
  const draftSourcesRef = useRef<Record<DraftSource, boolean>>({
    practice: false,
    inlineEditor: false,
  });
  const draftStateRef = useRef({ examId: sessionId, dirty: false });
  // A domain refresh may arrive while an inline editor has focus elsewhere.
  // Keep the latest request until the editor reports that its draft is clean.
  const pendingQbankRefreshRef = useRef<DomainChangePayload | undefined>(undefined);
  const hasPendingQbankRefreshRef = useRef(false);
  const flushPendingQbankRefreshRef = useRef<(() => void) | null>(null);
  // 域刷新去抖队列：批量变更会连发多个 qbank:refresh，合并为一次刷新。
  // 放 ref 而非 effect 局部变量：监听 effect 依赖频繁变化会重建，队列必须存活
  const qbankRefreshDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedRefreshEntityIdsRef = useRef<string[]>([]);
  const queuedRefreshPayloadRef = useRef<DomainChangePayload | undefined>(undefined);
  // 行内编辑聚焦时的 800ms 延迟重试 timer：同样必须跨 effect 重建存活，
  // 否则 deps（questions 等）一变就取消，被延迟的刷新会静默丢失
  const qbankDeferredEditorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // CSV 内嵌导入的进行中标记（导入中阻止切换到其他视图）
  const csvImportingRef = useRef(false);
  activeDraftExamIdRef.current = sessionId;

  const isCurrentExamDraftDirty = draftState.examId === sessionId && draftState.dirty;

  const updateDraftSource = useCallback((source: DraftSource, dirty: boolean) => {
    if (activeDraftExamIdRef.current !== sessionId) return;
    draftSourcesRef.current[source] = dirty;
    const nextDirty = Object.values(draftSourcesRef.current).some(Boolean);
    draftStateRef.current = { examId: sessionId, dirty: nextDirty };
    setDraftState((current) => (
      current.examId === sessionId && current.dirty === nextDirty
        ? current
        : { examId: sessionId, dirty: nextDirty }
    ));
  }, [sessionId]);

  const clearCurrentExamDraft = useCallback(() => {
    if (activeDraftExamIdRef.current !== sessionId) return;
    draftSourcesRef.current = { practice: false, inlineEditor: false };
    draftStateRef.current = { examId: sessionId, dirty: false };
    setDraftState((current) => (
      current.examId === sessionId && !current.dirty
        ? current
        : { examId: sessionId, dirty: false }
    ));
  }, [sessionId]);

  const requestDraftNavigation = useCallback((proceed: () => void): boolean => {
    const currentDraft = draftStateRef.current;
    if (currentDraft.examId !== sessionId || !currentDraft.dirty) {
      proceed();
      return true;
    }
    setPendingDraftNavigation({ examId: sessionId, proceed });
    return false;
  }, [sessionId]);

  const handlePracticeDraftDirtyChange = useCallback(
    (dirty: boolean) => updateDraftSource('practice', dirty),
    [updateDraftSource],
  );
  const handleInlineEditorDraftDirtyChange = useCallback(
    (dirty: boolean) => updateDraftSource('inlineEditor', dirty),
    [updateDraftSource],
  );

  useEffect(() => {
    draftSourcesRef.current = { practice: false, inlineEditor: false };
    draftStateRef.current = { examId: sessionId, dirty: false };
    pendingQbankRefreshRef.current = undefined;
    hasPendingQbankRefreshRef.current = false;
    flushPendingQbankRefreshRef.current = null;
    // 会话切换：清空上一会话排队中的域刷新（entityIds 属于旧会话，不能串台）
    if (qbankRefreshDebounceTimerRef.current) {
      clearTimeout(qbankRefreshDebounceTimerRef.current);
      qbankRefreshDebounceTimerRef.current = null;
    }
    if (qbankDeferredEditorTimerRef.current) {
      clearTimeout(qbankDeferredEditorTimerRef.current);
      qbankDeferredEditorTimerRef.current = null;
    }
    queuedRefreshEntityIdsRef.current = [];
    queuedRefreshPayloadRef.current = undefined;
    setDraftState({ examId: sessionId, dirty: false });
    setPendingDraftNavigation(null);
  }, [sessionId]);

  // 卸载时清理仍在排队的域刷新 timer（防止卸载后触发无意义的刷新）
  useEffect(() => () => {
    if (qbankRefreshDebounceTimerRef.current) {
      clearTimeout(qbankRefreshDebounceTimerRef.current);
      qbankRefreshDebounceTimerRef.current = null;
    }
    if (qbankDeferredEditorTimerRef.current) {
      clearTimeout(qbankDeferredEditorTimerRef.current);
      qbankDeferredEditorTimerRef.current = null;
    }
  }, []);

  useEffect(() => registerContentDirtyChecker(
    'exam',
    sessionId,
    () => {
      const currentDraft = draftStateRef.current;
      return currentDraft.examId === sessionId && currentDraft.dirty;
    },
  ), [sessionId]);

  useEffect(() => {
    onSaveStateChange?.(isCurrentExamDraftDirty ? 'dirty' : 'saved');
  }, [isCurrentExamDraftDirty, onSaveStateChange]);

  useEffect(() => {
    if (!isCurrentExamDraftDirty) {
      flushPendingQbankRefreshRef.current?.();
    }
  }, [isCurrentExamDraftDirty]);

  // 视图切换走 transition：懒加载 chunk 未就绪时保持当前视图渲染，
  // 避免整个内容区退化为 Suspense fallback 的闪烁
  const switchViewMode = useCallback((mode: ViewMode) => {
    startTransition(() => {
      setViewMode(mode);
    });
  }, []);

  // Tab navigation is an explicit exit point for an in-progress SM-2 queue.
  // Keep submitted ratings, but ask before discarding the remaining local queue.
  const applyViewMode = useCallback((mode: ViewMode): boolean => {
    if (mode === viewMode) return true;

    // CSV 内嵌导入中：阻止切换视图（与模态框导入中阻止关闭的行为一致）。
    // 用全局 i18n 而非组件 t：避免 t 的引用变化打进依赖数组导致 applyViewMode 每渲染换向
    if (viewMode === 'csvImport' && mode !== 'csvImport' && csvImportingRef.current) {
      showGlobalNotification('warning', i18n.t('exam_sheet:csv.import_in_progress_close_blocked'));
      return false;
    }

    const ownsReviewSession = reviewSession.isActive && reviewSession.examId === sessionId;
    if (viewMode === 'sm2' && mode !== 'sm2' && ownsReviewSession) {
      const hasRemainingItems = reviewSession.currentIndex < reviewSession.queue.length;
      if (hasRemainingItems) {
        setPendingReviewExitView(mode);
        return false;
      }
      endReviewSession();
    }

    switchViewMode(mode);
    return true;
  }, [endReviewSession, reviewSession, sessionId, switchViewMode, viewMode]);

  const requestViewMode = useCallback((mode: ViewMode, afterViewChange?: () => void): boolean => {
    const requiresNavigation = mode !== viewMode || Boolean(afterViewChange);
    if (!requiresNavigation) return true;
    const proceed = () => {
      const handled = applyViewMode(mode);
      if (handled) afterViewChange?.();
    };
    const currentDraft = draftStateRef.current;
    if (currentDraft.examId === sessionId && currentDraft.dirty) {
      setPendingDraftNavigation({
        examId: sessionId,
        proceed,
      });
      return false;
    }
    const handled = applyViewMode(mode);
    if (handled) afterViewChange?.();
    return handled;
  }, [applyViewMode, sessionId, viewMode]);

  // Settings are owned by this resource view, not the global question-bank store.
  // A workbench action can only succeed once this view can enter the practice surface.
  useEffect(() => {
    type SettingsRequest = {
      targetResourceId?: string;
      open?: boolean;
      acknowledge?: (result: {
        handled: boolean;
        code?: string;
        hint?: string;
        /** ACR 4.0（A7）：诚实回执——面板状态是否真的变化 */
        changed?: boolean;
        /** ACR 4.0（A7）：供 agent undo 的前值 */
        previousOpen?: boolean;
      }) => void;
    };
    const handleSettingsChange = (event: Event) => {
      const detail = (event as CustomEvent<SettingsRequest>).detail;
      if (detail?.targetResourceId && detail.targetResourceId !== sessionId) return;

      const open = detail?.open;
      if (open === true && !hasQuestions) {
        detail?.acknowledge?.({
          handled: false,
          code: 'QUESTION_NOT_FOUND',
          hint: t('learningHub:exam.controlHints.noQuestionsForSettings'),
        });
        return;
      }
      if (open === true && !requestViewMode('practice')) {
        // CSV 导入中被硬性阻断（无确认面板可解），不留待开请求；
        // 复习/草稿确认路径才记 pending，用户确认后由 effect 兑现
        const blockedByCsvImport = viewMode === 'csvImport' && csvImportingRef.current;
        if (!blockedByCsvImport) setPendingSettingsOpen(true);
        detail?.acknowledge?.({
          handled: false,
          code: 'CONFIRMATION_REQUIRED',
          hint: t('learningHub:exam.controlHints.confirmEndReviewForSettings'),
        });
        return;
      }

      const next = typeof open === 'boolean' ? open : !settingsPanelOpen;
      setSettingsPanelOpen(next);
      detail?.acknowledge?.({
        handled: true,
        changed: next !== settingsPanelOpen,
        previousOpen: settingsPanelOpen,
      });
    };
    window.addEventListener('exam:openSettings', handleSettingsChange);
    return () => window.removeEventListener('exam:openSettings', handleSettingsChange);
  }, [hasQuestions, requestViewMode, sessionId, settingsPanelOpen, t, viewMode]);

  // ACR 4.0（A7）：setFocusMode 的表面 ACK。专注视图只在练习面存在意义，
  // 与 settings 同款守卫：开启前必须能进入练习视图，回执诚实报告 changed。
  useEffect(() => {
    type FocusModeRequest = {
      targetResourceId?: string;
      enabled?: boolean;
      acknowledge?: (result: {
        handled: boolean;
        code?: string;
        hint?: string;
        changed?: boolean;
        previousEnabled?: boolean;
      }) => void;
    };
    const handleFocusModeChange = (event: Event) => {
      const detail = (event as CustomEvent<FocusModeRequest>).detail;
      if (detail?.targetResourceId && detail.targetResourceId !== sessionId) return;

      const enabled = detail?.enabled;
      if (typeof enabled !== 'boolean') {
        detail?.acknowledge?.({
          handled: false,
          code: 'INVALID_ARGS',
          hint: 'setFocusMode 需要 enabled',
        });
        return;
      }
      if (enabled && !hasQuestions) {
        detail?.acknowledge?.({
          handled: false,
          code: 'QUESTION_NOT_FOUND',
          hint: t('learningHub:exam.controlHints.noQuestionsForFocusMode'),
        });
        return;
      }
      if (enabled && !requestViewMode('practice')) {
        detail?.acknowledge?.({
          handled: false,
          code: 'CONFIRMATION_REQUIRED',
          hint: t('learningHub:exam.controlHints.confirmEndReviewForFocusMode'),
        });
        return;
      }
      const previous = useQuestionBankStore.getState().focusMode;
      setFocusMode(enabled);
      detail?.acknowledge?.({
        handled: true,
        changed: previous !== enabled,
        previousEnabled: previous,
      });
    };
    window.addEventListener('exam:setFocusMode', handleFocusModeChange);
    return () => window.removeEventListener('exam:setFocusMode', handleFocusModeChange);
  }, [hasQuestions, requestViewMode, sessionId, setFocusMode, t]);

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
    setShowExportDialog(false);
    setShowHistoryDialog(false);
    setHistoryQuestionId(null);
    setSettingsPanelOpen(false);
    setPendingSettingsOpen(false);
    setPendingUploadFiles(null);
    // 上一会话残留的「退出复习确认」与「启动台预选模式」不得带入新会话
    setPendingReviewExitView(null);
    setLauncherRequestedMode(null);
    // CSV 导入进行中标记随面板卸载失效，防止残留 true 阻塞新会话的视图切换
    csvImportingRef.current = false;
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

  // 限时练习的暂停补偿：TimedPracticeMode 恢复会话按 started_at + duration
  // + paused_seconds 计算倒计时终点，这里的 elapsed 必须同口径扣除
  // paused_seconds，否则暂停过的用户会被超时 effect 提前强制交卷。
  // 模拟考无暂停机制，恒为 0。
  const activeAdvancedPausedSeconds = useMemo(() => {
    if (practiceMode !== 'timed') return 0;
    const paused = activeTimedSession?.paused_seconds;
    return typeof paused === 'number' && Number.isFinite(paused) ? Math.max(0, paused) : 0;
  }, [practiceMode, activeTimedSession]);

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
            // 墙钟推算，免疫 setInterval 漂移与系统休眠；扣除累计暂停时长，
            // 与 TimedPracticeMode 的倒计时终点口径一致
            setElapsedTime(Math.max(
              0,
              Math.floor((Date.now() - startedMs) / 1000) - activeAdvancedPausedSeconds,
            ));
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
  }, [viewMode, isTimerRunning, isActive, activeAdvancedTimerDuration, activeAdvancedStartedAt, activeAdvancedPausedSeconds]);

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
    // 恢复时同样扣除累计暂停时长，保持与 tick 推算、启动页倒计时同口径
    const restoredElapsed = Math.min(
      activeAdvancedTimerDuration,
      Math.max(0, Math.floor((Date.now() - startedMs) / 1000) - activeAdvancedPausedSeconds),
    );
    setElapsedTime(restoredElapsed);
    setIsTimerRunning(true);
  }, [viewMode, activeAdvancedStartedAt, activeAdvancedTimerDuration, activeAdvancedPausedSeconds]);

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
    // 时间到是系统强制结束，不是可取消的导航。若改成普通草稿确认，用户
    // 取消后会留下已停止但仍标记为 active 的计时会话，无法再次触发结算。
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
      t('learningHub:exam.timedPracticeTimeout'),
      t('learningHub:exam.timerEnded'),
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
          t('learningHub:exam.mockExamAutoSubmitted'),
          t('learningHub:exam.timerEnded'),
        );
      })
      .catch((err: unknown) => {
        mockExamTimeoutHandledRef.current = null;
        debugLog.error('[ExamContentView] auto submit mock exam failed:', err);
        showGlobalNotification(
          'error',
          t('learningHub:exam.mockExamAutoSubmitFailed'),
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

  // COMPAT-REMOVED 2026-07-20: 题库专属 sync conflict UI 已移除（无生产生产者）。
  // 真冲突源见设置 → 数据治理 RecordConflictsPanel（__sync_conflicts）。

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

  const requestQuestionNavigation = useCallback((proceed: () => void) => (
    requestDraftNavigation(proceed)
  ), [requestDraftNavigation]);

  // 🆕 更新 Store 练习模式（Store 是 SSOT，无本地 state）
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
      const nextIdx = getNextQuestionIndex(questions, currentIndex, mode, tag);
      navigate(nextIdx);
    });
  }, [questions, currentIndex, navigate, requestViewMode, setStorePracticeMode]);

  // 模式下拉不带 tag：launcher 必配模式的分流已由 handleModeChange 统一处理
  const handleSelectMode = useCallback((value: string) => {
    handleModeChange(value as PracticeMode);
  }, [handleModeChange]);

  const handleStartPracticeByTag = useCallback((tag: string) => {
    requestViewMode('practice', () => {
      setStorePracticeMode('by_tag');
      setSelectedTag(tag);
      navigate(getNextQuestionIndex(questions, currentIndex, 'by_tag', tag));
    });
  }, [currentIndex, navigate, questions, requestViewMode, setStorePracticeMode]);

  const handleStartReview = useCallback(() => {
    requestViewMode('practice', () => {
      setStorePracticeMode('review_first');
      navigate(getNextQuestionIndex(questions, currentIndex, 'review_first'));
    });
  }, [currentIndex, navigate, questions, requestViewMode, setStorePracticeMode]);

  // 点击题目进入做题模式（必须在条件返回之前定义）
  const handleQuestionClick = useCallback((index: number) => {
    requestViewMode('practice', () => navigate(index));
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
  }, [practiceMode, questions, selectedTag, activeMockExamSession, activeTimedSession, activeDailyPractice, activeGeneratedPaper]);

  const handleRefreshQuestion = useCallback(async (questionId: string) => {
    await refreshQuestion(questionId);
  }, [refreshQuestion]);

  // 答题卡状态以本地会话（useQuestionBankSession）为准：做题导航走本地
  // currentIndex，全局 store.currentQuestionId 与之不同步；收藏集同理来自
  // 本地会话题目，全局 store.questions map 在此流程通常未加载
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

  const requestPracticeNavigate = useCallback((index: number) => {
    requestQuestionNavigation(() => handlePracticeNavigate(index));
  }, [handlePracticeNavigate, requestQuestionNavigation]);

  // Workbench activations must mutate this resource's local session. The
  // global question-bank store is only mirrored after this handler confirms it.
  useEffect(() => {
    const acknowledge = (
      detail: QbankControlEventDetail | undefined,
      result: QbankControlResult,
    ) => detail?.acknowledge?.(result);

    const onControl = (event: Event) => {
      const detail = (event as CustomEvent<QbankControlEventDetail>).detail;
      if (!detail || (detail.targetResourceId && detail.targetResourceId !== sessionId)) return;

      const scope = viewMode === 'practice' ? practiceQuestions : questions;
      const currentQuestionId = questions[currentIndex]?.id;
      const scopedIndex = scope.findIndex((question) => question.id === currentQuestionId);

      if (detail.action === 'nextQuestion' || detail.action === 'previousQuestion') {
        if (scope.length === 0) {
          acknowledge(detail, {
            handled: false,
            code: 'QUESTION_NOT_FOUND',
            hint: t('learningHub:exam.controlHints.noNavigableQuestions'),
          });
          return;
        }
        const delta = detail.action === 'nextQuestion' ? 1 : -1;
        const baseIndex = scopedIndex >= 0 ? scopedIndex : delta > 0 ? -1 : 0;
        const nextScopedIndex = Math.min(
          Math.max(baseIndex + delta, 0),
          Math.max(0, scope.length - 1),
        );
        const target = scope[nextScopedIndex];
        const fullIndex = target ? questions.findIndex((question) => question.id === target.id) : -1;
        if (fullIndex < 0 || !target) {
          acknowledge(detail, {
            handled: false,
            code: 'QUESTION_NOT_FOUND',
            hint: t('learningHub:exam.controlHints.questionNotFound'),
          });
          return;
        }
        if (!requestViewMode('practice', () => navigate(fullIndex))) {
          acknowledge(detail, {
            handled: false,
            code: 'CONFIRMATION_REQUIRED',
            hint: t('learningHub:exam.controlHints.confirmDiscardToSwitchQuestion'),
          });
          return;
        }
        agentFlash('exam', target.id, { scope: agentFlashRootRef.current });
        acknowledge(detail, { handled: true, currentQuestionId: target.id });
        return;
      }

      if (detail.action === 'setFilters' || detail.action === 'resetFilters') {
        const filters = detail.action === 'resetFilters'
          ? {}
          : parseManageFilters(detail.payload);
        if (!filters) {
          acknowledge(detail, {
            handled: false,
            code: 'INVALID_ARGS',
            hint: t('learningHub:exam.controlHints.setFiltersNeedsFilters'),
          });
          return;
        }
        if (!requestViewMode('manage')) {
          acknowledge(detail, {
            handled: false,
            code: 'CONFIRMATION_REQUIRED',
            hint: t('learningHub:exam.controlHints.confirmEndReviewForFilters'),
          });
          return;
        }
        setManageFilters(filters);
        acknowledge(detail, { handled: true });
        return;
      }

      if (detail.action === 'hydratePracticeSession') {
        const payload = detail.payload && typeof detail.payload === 'object'
          ? detail.payload as Record<string, unknown>
          : {};
        const rawHandoff = payload.handoff ?? detail.payload;
        const validated = validateQbankPracticeHandoff(rawHandoff, sessionId);
        if ('ok' in validated) {
          acknowledge(detail, {
            handled: false,
            code: validated.code,
            hint: validated.hint,
          });
          return;
        }

        const outcome: { current: PracticeHandoffHydrationResult | null } = { current: null };
        const accepted = requestViewMode('practice', () => {
          const hydration = useQuestionBankStore
            .getState()
            .hydratePracticeHandoff(validated, sessionId);
          outcome.current = hydration;
          if (hydration.ok === false) return;
          setElapsedTime(0);
          setStorePracticeMode(hydration.mode);
          const firstIndex = questions.findIndex(
            (question) => question.id === hydration!.firstQuestionId,
          );
          if (firstIndex >= 0) navigate(firstIndex);
          useQuestionBankStore.getState().setCurrentQuestion(hydration.firstQuestionId);
        });
        const hydration = outcome.current;
        if (!accepted || !hydration || hydration.ok === false) {
          const failure = hydration?.ok === false ? hydration : null;
          acknowledge(detail, {
            handled: false,
            code: failure?.code ?? 'CONFIRMATION_REQUIRED',
            hint: failure?.hint ?? t('learningHub:exam.controlHints.confirmDiscardToHydratePractice'),
          });
          return;
        }
        acknowledge(detail, {
          handled: true,
          acknowledged: true,
          currentQuestionId: hydration.firstQuestionId,
          hydratedSessionId: hydration.handoffId,
          practiceMode: hydration.mode,
        });
        return;
      }

      if (detail.action === 'setPracticeMode') {
        const payload = detail.payload && typeof detail.payload === 'object'
          ? detail.payload as Record<string, unknown>
          : {};
        const mode = payload.mode as PracticeMode | undefined;
        const tag = typeof payload.tag === 'string' ? payload.tag : undefined;
        if (!mode) {
          acknowledge(detail, {
            handled: false,
            code: 'INVALID_ARGS',
            hint: t('learningHub:exam.controlHints.setPracticeModeNeedsMode'),
          });
          return;
        }
        if (LAUNCHER_REQUIRED_MODES.has(mode as LauncherRequestedMode) && mode !== 'by_tag') {
          acknowledge(detail, {
            handled: false,
            code: 'CONFIGURATION_REQUIRED',
            hint: t('learningHub:exam.controlHints.modeNeedsLauncherConfig'),
          });
          return;
        }
        if (mode === 'by_tag' && (!tag || !questions.some((question) => matchesPracticeTag(question, tag)))) {
          acknowledge(detail, {
            handled: false,
            code: 'INVALID_ARGS',
            hint: t('learningHub:exam.controlHints.byTagNeedsValidTag'),
          });
          return;
        }
        const nextIndex = getNextQuestionIndex(questions, currentIndex, mode, tag);
        const target = questions[nextIndex];
        if (!requestViewMode('practice', () => {
          setElapsedTime(0);
          setStorePracticeMode(mode);
          if (tag) setSelectedTag(tag);
          navigate(nextIndex);
        })) {
          acknowledge(detail, {
            handled: false,
            code: 'CONFIRMATION_REQUIRED',
            hint: t('learningHub:exam.controlHints.confirmDiscardToSwitchMode'),
          });
          return;
        }
        acknowledge(detail, {
          handled: true,
          currentQuestionId: target?.id ?? null,
        });
        return;
      }

      // 未知 action 兜底回执：driver 侧新增动作而本视图尚未支持时，
      // 明确报告 unhandled，而不是静默无响应（会被误判为视图未挂载）
      acknowledge(detail, {
        handled: false,
        code: 'UNSUPPORTED_ACTION',
        hint: t('learningHub:exam.controlHints.unsupportedAction'),
      });
    };

    window.addEventListener(QBANK_CONTROL_EVENT, onControl);
    return () => window.removeEventListener(QBANK_CONTROL_EVENT, onControl);
  }, [
    currentIndex,
    navigate,
    practiceQuestions,
    practiceMode,
    questions,
    requestViewMode,
    sessionId,
    setStorePracticeMode,
    t,
    viewMode,
  ]);

  // PracticeLauncher 的 onStartPractice 回调
  const handleStartPractice = useCallback((mode: PracticeMode, tag?: string) => {
    setElapsedTime(0);
    setLauncherRequestedMode(null);
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
          t(
            'learningHub:exam.mutationRefreshFailed'
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

  // ========== 批量管理 / 标签重命名（2026-07 store 新增 action 的中枢接线） ==========
  // 通知责任在子视图（ManageView/TagNavigationView 自带成功/失败通知），
  // 此处只调 store action（出错 rethrow 给子视图呈现）+ 刷新本地会话数据。
  // 直连 qbank_batch_update_questions 不派发 qbank://changed（仅 agent 工具链会），
  // 因此这里的显式刷新与域刷新去抖链不会双重触发。
  const refreshAfterExternalMutation = useCallback(async () => {
    try {
      await refreshQuestionsAndStats();
    } catch (refreshErr: unknown) {
      // 变更已成功，刷新失败不能伪装成变更失败（否则子视图会误报操作失败）
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
    // ManageView 的 op 字段可选，store 契约要求两个数组齐备
    await useQuestionBankStore.getState().batchUpdateTags(questionIds, {
      add: op.add ?? [],
      remove: op.remove ?? [],
    });
    await refreshAfterExternalMutation();
  }, [refreshAfterExternalMutation]);

  const handleRenameTag = useCallback(async (oldTag: string, newTag: string) => {
    // TagNavigationView 签名是 (oldTag, newTag)，store 是 (examId, oldTag, newTag)：examId 由中枢闭包补齐
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

  const handleBackToLauncher = useCallback(() => {
    requestViewMode('launcher');
  }, [requestViewMode]);

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
      showGlobalNotification('success', t('exam_sheet:uploader.resume_success'));
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

  const sessionStatus = sessionDetail?.summary?.status ?? null;

  // 当前是否处于「更多」菜单中的二级视图（用于菜单触发器的高亮与文案）
  const activeSecondaryTab = secondaryTabs.find((tab) => tab.mode === viewMode);

  // ACR 演出优化轮：flash 限定在本视图 DOM 内（qbank 可多窗，全局查找会闪错窗口）
  const agentFlashRootRef = useRef<HTMLDivElement | null>(null);

  // ========== Tab 栏滑动选中指示器 + 方向键可达 ==========
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const [tabIndicator, setTabIndicator] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  // 顶部三个一级入口的激活归属：题库 / 做题(含启动台) / 更多(二级视图)
  const activeTopTab: 'list' | 'practice' | 'more' | null =
    viewMode === 'list' ? 'list'
      : (viewMode === 'practice' || viewMode === 'launcher') ? 'practice'
        : activeSecondaryTab ? 'more'
          : null;

  // 指示器几何测量：布局阶段同步测量避免首帧闪跳；
  // 标签文案（语言/二级视图标题）与容器尺寸变化时重测
  useLayoutEffect(() => {
    const list = tabListRef.current;
    if (!list) return;

    const measure = () => {
      const active = list.querySelector<HTMLElement>('[data-exam-tab][data-active="true"]');
      if (!active) {
        setTabIndicator(null);
        return;
      }
      // 用 rect 差值而非 offsetLeft：「更多」按钮嵌在 AppMenu 的 relative 包裹层里，
      // offsetLeft 相对的是包裹层而不是 Tab 列表
      const listRect = list.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const next = {
        left: Math.round(activeRect.left - listRect.left + list.scrollLeft),
        top: Math.round(activeRect.top - listRect.top + list.scrollTop),
        width: Math.round(activeRect.width),
        height: Math.round(activeRect.height),
      };
      setTabIndicator((prev) => (
        prev && prev.left === next.left && prev.top === next.top
          && prev.width === next.width && prev.height === next.height
          ? prev
          : next
      ));
    };

    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(list);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
    // sessionDetail / isLoading / isResuming 参与早退分支：Tab 栏从「加载中」早退恢复挂载时必须重测
  }, [activeTopTab, activeSecondaryTab?.label, hasQuestions, t, sessionDetail, isLoading, isResuming]);

  // 方向键在一级 Tab 之间移动焦点（Home/End 跳到首尾）
  const handleTabListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const list = tabListRef.current;
    if (!list) return;
    const tabs = Array.from(list.querySelectorAll<HTMLElement>('[data-exam-tab]'))
      .filter((el) => !el.hasAttribute('disabled'));
    if (tabs.length === 0) return;
    const current = document.activeElement instanceof HTMLElement
      ? tabs.indexOf(document.activeElement)
      : -1;
    if (current < 0) return;
    event.preventDefault();
    let next = current;
    if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else next = tabs.length - 1;
    tabs[next]?.focus();
  }, []);

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

  // 上传页返回：回到题库列表。空集时列表展示「新建/导入」启动台，
  // 不再直接关闭整个面板（避免误关刚创建的题目集）
  const handleUploaderBack = useCallback(() => {
    switchViewMode('list');
  }, [switchViewMode]);

  // 「添加题目」菜单：手动新建 → 切到题库列表并请求打开内联创建编辑器
  const handleCreateQuestionEntry = useCallback(() => {
    requestViewMode('list', () => setListCreateRequestKey((key) => key + 1));
  }, [requestViewMode]);

  // 「添加题目」菜单：识别导入（清空可能残留的拖入文件）
  const handleOpenUploadEntry = useCallback(() => {
    setPendingUploadFiles(null);
    requestViewMode('upload');
  }, [requestViewMode]);

  // 题库启动台拖入文件：携带文件进入识别导入
  const handleLauncherFilesDropped = useCallback((files: File[]) => {
    if (files.length === 0) return;
    requestViewMode('upload', () => setPendingUploadFiles(files));
  }, [requestViewMode]);

  // 加载失败重试：会话详情与题目一起重试；rejection 已由 hook 的 error 状态呈现
  const handleRetryLoad = useCallback(() => {
    void loadSessionDetail();
    if (error) {
      void loadQuestions().catch((err: unknown) => {
        debugLog.warn('[ExamContentView] retry load questions failed:', err);
      });
    }
  }, [loadSessionDetail, error, loadQuestions]);

  // 空会话停留在题库列表：列表的空状态就是「新建/导入」启动台

  // 题目清空（如在管理/练习视图删光题目）后，依赖题目的视图已无内容支撑，
  // 回退到题库列表，保持 Tab 高亮与实际内容一致（上传/CSV 导入不依赖题目，不在此列）
  useEffect(() => {
    if (!hasQuestions && !isLoading && viewMode !== 'list' && viewMode !== 'upload' && viewMode !== 'csvImport') {
      switchViewMode('list');
    }
  }, [hasQuestions, isLoading, viewMode, switchViewMode]);

  /**
   * ACR R1-15：消费 qbankDriver 派发的域刷新 / 聚焦事件。
   * - 刷新：未保存草稿时保留最后一次刷新，避免新的 question 对象重置行内表单
   * - 聚焦：打开对应题目并 flash
   */
  useEffect(() => {
    const flashIds = (entityIds: string[] | undefined, payload?: DomainChangePayload) => {
      // 刷新是异步的：视图可能已卸载（ref 置空）——此时目标行不在本视图，
      // 不能回退全局查找（会闪到别的窗口），直接跳过
      const scope = agentFlashRootRef.current;
      if (!scope) return;
      const ids =
        (entityIds?.length ? entityIds : null) ??
        (payload ? collectDomainEntityIds(payload) : []);
      // 演出优化轮：批量走 agentFlashMany（只滚一次、整批一次重排），
      // 此前逐条 agentFlash 每条都 scrollIntoView + 强制重排，批量刷新连环跳视口
      agentFlashMany('exam', ids, { scope });
    };

    const runLocalRefresh = (payload?: DomainChangePayload, mergedEntityIds?: string[]) => {
      const currentDraft = draftStateRef.current;
      if (currentDraft.examId === sessionId && currentDraft.dirty) {
        // Multiple mutations can arrive while a form is dirty. Refreshing only
        // the newest state after the form is saved/discarded is sufficient.
        pendingQbankRefreshRef.current = payload;
        hasPendingQbankRefreshRef.current = true;
        return;
      }

      // Keep the short focus debounce for an editor that has just received a
      // keystroke. It is supplementary only; dirty state above is the durable
      // guard once focus leaves the form.
      // ★ timer 存组件级 ref：此前存 effect 局部变量，effect 因 deps
      //   （questions/currentIndex）频繁重建时 cleanup 会取消延迟刷新，
      //   编辑器聚焦期间到达的域变更会被静默丢弃
      if (isQbankInlineEditorActive()) {
        if (qbankDeferredEditorTimerRef.current) {
          clearTimeout(qbankDeferredEditorTimerRef.current);
        }
        qbankDeferredEditorTimerRef.current = setTimeout(() => {
          qbankDeferredEditorTimerRef.current = null;
          runLocalRefresh(payload, mergedEntityIds);
        }, 800);
        return;
      }
      void refreshQuestionsAndStats()
        .then(() => {
          flashIds(mergedEntityIds?.length ? mergedEntityIds : payload?.entityIds, payload);
        })
        .catch((err: unknown) => {
          debugLog.warn('[ExamContentView] qbank://changed refresh failed:', err);
        });
    };

    const flushPendingRefresh = () => {
      const currentDraft = draftStateRef.current;
      if (
        !hasPendingQbankRefreshRef.current
        || (currentDraft.examId === sessionId && currentDraft.dirty)
      ) {
        return;
      }
      const payload = pendingQbankRefreshRef.current;
      pendingQbankRefreshRef.current = undefined;
      hasPendingQbankRefreshRef.current = false;
      runLocalRefresh(payload);
    };
    flushPendingQbankRefreshRef.current = flushPendingRefresh;

    // 域刷新去抖：批量变更（agent 连续写入）会在短时间内派发多个 qbank:refresh，
    // 此前每个事件都触发一次全量重载。合并为一次刷新，entityIds 取并集保证
    // flash 不丢批量中的任何一条。队列存放在组件级 ref 上：本 effect 因依赖
    // （questions/currentIndex 等）频繁重建，effect 局部队列会被重建丢弃。
    const onRefresh = (ev: Event) => {
      const detail = (ev as CustomEvent<DomainChangePayload>).detail;
      if (detail) {
        queuedRefreshEntityIdsRef.current.push(...collectDomainEntityIds(detail));
        queuedRefreshPayloadRef.current = detail;
      }
      if (qbankRefreshDebounceTimerRef.current) {
        clearTimeout(qbankRefreshDebounceTimerRef.current);
      }
      qbankRefreshDebounceTimerRef.current = setTimeout(() => {
        qbankRefreshDebounceTimerRef.current = null;
        const mergedIds = Array.from(new Set(queuedRefreshEntityIdsRef.current));
        const payload = queuedRefreshPayloadRef.current;
        queuedRefreshEntityIdsRef.current = [];
        queuedRefreshPayloadRef.current = undefined;
        runLocalRefresh(payload, mergedIds);
      }, 200);
    };

    const onFocus = (ev: Event) => {
      const detail = (ev as CustomEvent<QbankFocusEventDetail>).detail;
      if (detail?.targetResourceId && detail.targetResourceId !== sessionId) return;
      const questionId = detail?.questionId;
      if (!questionId) return;
      const index = questions.findIndex((question) => question.id === questionId);
      const handled = index >= 0 && requestViewMode('practice', () => navigate(index));
      const previousQuestionId = questions[currentIndex]?.id ?? null;
      if (handled) {
        agentFlash('exam', questionId, { scope: agentFlashRootRef.current });
      }
      detail.acknowledge?.({ handled, previousQuestionId });
    };

    window.addEventListener(QBANK_REFRESH_EVENT, onRefresh);
    window.addEventListener(QBANK_FOCUS_EVENT, onFocus);
    return () => {
      window.removeEventListener(QBANK_REFRESH_EVENT, onRefresh);
      window.removeEventListener(QBANK_FOCUS_EVENT, onFocus);
      // 去抖/延迟 timer 不在这里清：本 effect 依赖变化频繁，重建时清掉会吞掉
      // 已排队的刷新；跨闭包只经由 ref/稳定回调，旧闭包触发也安全。
      // 卸载与会话切换时的清理由专门的 effect 负责。
      if (flushPendingQbankRefreshRef.current === flushPendingRefresh) {
        flushPendingQbankRefreshRef.current = null;
      }
    };
  }, [refreshQuestionsAndStats, requestViewMode, questions, currentIndex, navigate, sessionId]);

  // ========== 条件返回（早期退出） ==========
  
  if (!sessionId) {
    return (
      <div className="flex flex-col items-center justify-center h-full">
        <WarningCircle size={32} className="text-muted-foreground mb-2" />
        <span className="text-muted-foreground">
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
        <DsButton variant="ghost" size="sm" onClick={handleRetryLoad} className="gap-2 [@media(pointer:coarse)]:min-h-11">
          <ArrowClockwise size={16} />
          {t('common:actions.retry')}
        </DsButton>
      </div>
    );
  }

  // 会话详情未就绪，或题目仍在首次加载（已有题目时的后台刷新不再整页转圈；
  // 恢复导入期间保持横幅与 Tab 栏挂载，按钮自带"恢复中"反馈）
  if (!sessionDetail || (isLoading && !hasQuestions && !isResuming)) {
    return (
      <div className="h-full ui-fade-in-slow">
        <ViewSkeleton />
      </div>
    );
  }

  // 退出复习 / 丢弃草稿确认的共享动作（行内确认条全端复用）
  const confirmReviewExit = () => {
    const nextView = pendingReviewExitView;
    setPendingReviewExitView(null);
    endReviewSession();
    // 待开的练习设置由 pendingSettingsOpen effect 在到达练习视图后统一兑现
    if (nextView) switchViewMode(nextView);
  };
  const cancelReviewExit = () => {
    setPendingReviewExitView(null);
    setPendingSettingsOpen(false);
  };
  const confirmDiscardDraft = () => {
    const pending = pendingDraftNavigation;
    setPendingDraftNavigation(null);
    if (!pending || pending.examId !== sessionId) return;
    clearCurrentExamDraft();
    pending.proceed();
  };
  const cancelDiscardDraft = () => {
    setPendingDraftNavigation(null);
    // 用户取消导航即取消整个链条：残留的待开设置请求不能在之后手动进入练习时突然弹面板
    setPendingSettingsOpen(false);
  };

  return (
    <div ref={agentFlashRootRef} className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* ★ 断点续导：importing 状态横幅 */}
      {isImportingSession && (
        <div className="flex-shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-2 sm:px-4">
          {/* 📱 flex-wrap：375px 下右侧「恢复导入」按钮组换行到第二行，避免把提示文案挤到不可读 */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <WarningCircle size={16} className="flex-shrink-0 text-warning" />
              <span className="truncate text-sm text-warning">
                {t('exam_sheet:uploader.import_interrupted', { count: questions.length })}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
              {resumeError && (
                <span className="text-xs text-destructive max-w-[200px] truncate" title={resumeError}>
                  {resumeError}
                </span>
              )}
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handleResumeImport}
                disabled={isResuming}
                className="gap-1.5 text-warning hover:bg-warning/10 [@media(pointer:coarse)]:min-h-11"
              >
                {isResuming ? (
                  <CircleNotch size={14} className="animate-spin" />
                ) : (
                  <RotateCw size={14} />
                )}
                {isResuming
                  ? t('exam_sheet:uploader.resuming')
                  : t('exam_sheet:uploader.resume_import')
                }
              </DsButton>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex-shrink-0 px-3 sm:px-4 py-2 border-b border-destructive/20 bg-destructive/5" role="alert">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm text-destructive truncate" title={error}>
              {t('exam_sheet:errors.loadQuestionsFailed')}: {error}
            </span>
            <DsButton variant="ghost" size="sm" onClick={handleRetryQuestions} className="gap-1.5 [@media(pointer:coarse)]:min-h-11">
              <ArrowClockwise size={14} />
              {t('common:actions.retry')}
            </DsButton>
          </div>
        </div>
      )}

      {/* Tab 栏 */}
      <div className="flex-shrink-0 px-3 sm:px-4 py-2.5 border-b border-border/40">
        <div className="flex items-center justify-between gap-2">
          {/* 左侧 Tab - 允许横向滚动；移动端右缘渐隐提示还有更多；方向键在一级入口间移动焦点 */}
          <div
            ref={tabListRef}
            role="toolbar"
            aria-label={t('learningHub:exam.shell.primaryNav')}
            aria-orientation="horizontal"
            onKeyDown={handleTabListKeyDown}
            className="relative flex items-center gap-1 min-w-0 overflow-x-auto overscroll-x-contain scrollbar-none max-sm:[mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]"
          >
            {/* 滑动选中指示器（在按钮下层随激活项平移/变宽） */}
            {tabIndicator && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute z-0 rounded-md bg-accent transition-[left,top,width,height] duration-200 ease-out motion-reduce:transition-none"
                style={{
                  left: tabIndicator.left,
                  top: tabIndicator.top,
                  width: tabIndicator.width,
                  height: tabIndicator.height,
                }}
              />
            )}
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => requestViewMode('list')}
              data-exam-tab=""
              data-active={activeTopTab === 'list' || undefined}
              aria-pressed={activeTopTab === 'list'}
              className={cn(
                'relative z-[1] px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0 ui-press [@media(pointer:coarse)]:min-h-11',
                activeTopTab === 'list'
                  ? 'text-accent-foreground font-medium hover:bg-transparent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
              )}
            >
              {t('learningHub:exam.tab.questionBank')}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => {
                if (viewMode !== 'practice' && viewMode !== 'launcher') {
                  requestViewMode('launcher');
                }
              }}
              disabled={!hasQuestions}
              data-exam-tab=""
              data-active={activeTopTab === 'practice' || undefined}
              aria-pressed={activeTopTab === 'practice'}
              className={cn(
                'relative z-[1] px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0 ui-press [@media(pointer:coarse)]:min-h-11',
                activeTopTab === 'practice'
                  ? 'text-accent-foreground font-medium hover:bg-transparent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]',
                !hasQuestions && 'opacity-50 cursor-not-allowed'
              )}
            >
              {t('learningHub:exam.tab.practice')}
            </DsButton>
            {/* 二级视图收纳进「更多」菜单：错题 / 复习 / 收藏 / 知识点 / 统计 / 管理 */}
            {hasQuestions && (
              <AppMenu>
                <AppMenuTrigger asChild>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    data-exam-tab=""
                    data-active={activeTopTab === 'more' || undefined}
                    aria-pressed={activeTopTab === 'more'}
                    aria-label={t('learningHub:exam.tab.more')}
                    className={cn(
                      'group relative z-[1] px-2.5 sm:px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap flex-shrink-0 gap-1 ui-press [@media(pointer:coarse)]:min-h-11',
                      activeTopTab === 'more'
                        ? 'text-accent-foreground font-medium hover:bg-transparent'
                        : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
                    )}
                  >
                    {activeSecondaryTab?.label ?? t('learningHub:exam.tab.more')}
                    <CaretDown
                      size={12}
                      className="opacity-60 transition-transform duration-200 ease-out motion-reduce:transition-none group-aria-expanded:rotate-180"
                    />
                  </DsButton>
                </AppMenuTrigger>
                <AppMenuContent align="start" width={180}>
                  {secondaryTabs.map(({ mode, label, icon: Icon, badge }) => (
                    <AppMenuItem
                      key={mode}
                      onClick={() => requestViewMode(mode)}
                      icon={<Icon size={16} />}
                      checked={viewMode === mode}
                      suffix={badge > 0 ? (
                        <span className="min-w-[18px] rounded-full bg-warning/15 px-1.5 py-px text-center text-[10px] font-medium tabular-nums text-warning">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      ) : undefined}
                    >
                      {label}
                    </AppMenuItem>
                  ))}
                </AppMenuContent>
              </AppMenu>
            )}

            {(viewMode === 'practice') && hasQuestions && (
              <>
                <div className="w-px h-4 bg-border/60 mx-1 sm:mx-2 flex-shrink-0" />
                <AppSelect value={practiceMode} onValueChange={handleSelectMode}
                  options={MODE_OPTIONS}
                  size="sm"
                  variant="ghost"
                  className="h-7 flex-shrink-0 border-0 bg-muted/30 px-2 text-xs hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:h-11"
                />
                
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={isAdvancedRuntimeTimer ? undefined : toggleTimer}
                  aria-disabled={isAdvancedRuntimeTimer || undefined}
                  aria-label={
                    isAdvancedRuntimeTimer
                      ? t('learningHub:exam.timer.remaining')
                      : isTimerRunning
                        ? t('learningHub:exam.timer.pause')
                        : t('learningHub:exam.timer.resume')
                  }
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors text-sm flex-shrink-0 [@media(pointer:coarse)]:min-h-11',
                    isAdvancedRuntimeTimer
                      ? 'bg-destructive/10 text-destructive hover:bg-destructive/10'
                      : isTimerRunning
                        ? 'text-primary bg-primary/5 hover:bg-primary/10'
                        : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
                  )}
                  title={
                    isAdvancedRuntimeTimer
                      ? t('learningHub:exam.timer.remaining')
                      : isTimerRunning
                        ? t('learningHub:exam.timer.pause')
                        : t('learningHub:exam.timer.resume')
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
                </DsButton>
              </>
            )}
          </div>
          
          {/* 右侧：统计摘要 + 导出 + 添加题目菜单（只读模式下隐藏添加） */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {hasQuestions && stats && <StatsSummary stats={stats} />}
            {hasQuestions && (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handleOpenExport}
                aria-label={t('learningHub:exam.tab.export')}
                title={t('learningHub:exam.tab.export')}
                className="h-7 gap-1.5 px-2.5 sm:px-3 ui-press [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11"
              >
                <Download size={14} />
                <span className="hidden sm:inline">{t('learningHub:exam.tab.export')}</span>
              </DsButton>
            )}
            {!readOnly && (
              <AppMenu>
                <AppMenuTrigger asChild>
                  <DsButton
                    variant={viewMode === 'upload' ? 'default' : 'ghost'}
                    size="sm"
                    aria-label={t('learningHub:exam.tab.addQuestion')}
                    title={t('learningHub:exam.tab.addQuestion')}
                    className="h-7 gap-1.5 px-2.5 sm:px-3 ui-press [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11"
                  >
                    <Plus size={14} />
                    <span className="hidden sm:inline">{t('learningHub:exam.tab.addQuestion')}</span>
                    <CaretDown size={12} className="opacity-60" />
                  </DsButton>
                </AppMenuTrigger>
                <AppMenuContent align="end" width={200}>
                  <AppMenuItem
                    onClick={handleCreateQuestionEntry}
                    icon={<PencilSimple size={16} />}
                  >
                    {t('exam_sheet:questionBank.create.title')}
                  </AppMenuItem>
                  <AppMenuSeparator />
                  <AppMenuItem
                    onClick={handleOpenUploadEntry}
                    icon={<Scan size={16} />}
                  >
                    {t('learningHub:exam.tab.add')}
                  </AppMenuItem>
                  <AppMenuItem
                    onClick={handleOpenCsvImport}
                    icon={<TableIcon size={16} />}
                  >
                    {t('learningHub:exam.tab.importCsv')}
                  </AppMenuItem>
                </AppMenuContent>
              </AppMenu>
            )}
          </div>
        </div>
      </div>

      {/* 行内确认条：退出复习 / 丢弃草稿（全端统一为 Tab 栏下方的内联确认，不再使用模态） */}
      {pendingReviewExitView !== null && (
        <div
          className="flex-shrink-0 border-b border-warning/30 bg-warning/10 px-3 py-2 ui-drop-in"
          role="alert"
          aria-label={t('review:session.exitTitle')}
        >
          <div className="flex items-start gap-2">
            <WarningCircle size={16} className="mt-0.5 flex-shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">{t('review:session.exitTitle')}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('review:session.exitDescription')}</p>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <DsButton variant="ghost" size="sm" className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!h-11" onClick={cancelReviewExit}>
              {t('common:cancel')}
            </DsButton>
            <DsButton variant="warning" size="sm" className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!h-11" onClick={confirmReviewExit}>
              {t('review:session.exitConfirm')}
            </DsButton>
          </div>
        </div>
      )}
      {pendingDraftNavigation !== null && (
        <div
          className="flex-shrink-0 border-b border-destructive/30 bg-destructive/5 px-3 py-2 ui-drop-in"
          role="alert"
          aria-label={t('editor.discardDraftTitle')}
        >
          <div className="flex items-start gap-2">
            <WarningCircle size={16} className="mt-0.5 flex-shrink-0 text-destructive" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">{t('editor.discardDraftTitle')}</div>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('editor.discardDraftDescription')}</p>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-end gap-2">
            <DsButton variant="ghost" size="sm" className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!h-11" onClick={cancelDiscardDraft}>
              {t('common:cancel')}
            </DsButton>
            <DsButton variant="danger" size="sm" className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!h-11" onClick={confirmDiscardDraft}>
              {t('common:actions.discard')}
            </DsButton>
          </div>
        </div>
      )}

      {/* 内容区：viewMode 变化时以淡入 + 轻微上移过渡（懒加载 chunk 未就绪时
          startTransition 保持旧视图；首次挂载由骨架屏兜底，避免空白/转圈闪切） */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Suspense fallback={<ViewSkeleton />}>
          <div key={viewMode} className="h-full min-h-0 ui-rise-in">
          {viewMode === 'launcher' && hasQuestions ? (
            /* 练习启动页 — 选择练习模式 */
            <PracticeLauncher
              examId={sessionId}
              stats={stats}
              questions={questions}
              onStartPractice={handleStartPractice}
              requestedMode={launcherRequestedMode}
              onRequestedModeHandled={() => setLauncherRequestedMode(null)}
              currentQuestionId={sessionCurrentQuestionId}
              markedQuestionIds={favoriteQuestionIds}
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
              onSelectQuestion={handleViewQuestionDetail}
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
            /* ★ I1 修复：SM-2 间隔复习视图（计划面板 + 复习会话） */
            <Sm2ReviewPanel examId={sessionId} isActive={isActive} />
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
              onInitialFilesConsumed={() => setPendingUploadFiles(null)}
              onUploadSuccess={handleUploadSuccess}
              onBack={handleUploaderBack}
              onManualCreate={handleCreateQuestionEntry}
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
              onDelete={readOnly ? undefined : handleDeleteQuestions}
              onResetProgress={readOnly ? undefined : handleResetProgress}
              onToggleFavorite={readOnly ? undefined : toggleFavoriteInSession}
              onUpdateQuestion={readOnly ? undefined : handleListChanged}
              onCreateQuestion={readOnly ? undefined : handleListChanged}
              onUploadQuestions={readOnly ? undefined : handleOpenUploadEntry}
              onUploadFiles={readOnly ? undefined : handleLauncherFilesDropped}
              onCsvImport={readOnly ? undefined : handleOpenCsvImport}
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

      {/* 导出 / 历史：全端统一走组件自带的内联子屏形态（absolute inset-0） */}
      <Suspense fallback={null}>
        <QuestionBankExportDialog
          open={showExportDialog}
          onOpenChange={setShowExportDialog}
          questions={questions}
          examName={sessionDetail?.summary?.exam_name || node.name}
          examId={sessionId}
          inline
        />
        {/* onJumpToQuestion 直连宿主导航而不走 QBANK_FOCUS_EVENT 回退：
            该事件不带 targetResourceId，同一题目集多窗（标签页保活）时会让
            所有挂载实例同时导航；直连还能在题目已删除时给出提示 */}
        <QuestionHistoryView
          questionId={historyQuestionId}
          open={showHistoryDialog}
          onOpenChange={handleHistoryOpenChange}
          inline
          onJumpToQuestion={handleOpenQuestion}
        />
      </Suspense>
    </div>
  );
};

export default ExamContentView;
