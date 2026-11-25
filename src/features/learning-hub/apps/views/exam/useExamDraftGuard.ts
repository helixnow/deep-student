import { useState, useCallback, useEffect, useRef, type RefObject } from 'react';
import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { registerContentDirtyChecker } from '@/features/workbench/apps/content/contentDirtyRegistry';
import {
  useQuestionBankStore,
  getPracticeSessionKey,
  type PracticeSessionOwner,
} from '@/stores/questionBankStore';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import type { PracticeMode } from '@/api/questionBankApi';
import type { GradingMode } from '@/api/practiceApi';
import type { ContentViewProps } from '../../UnifiedAppPanel';
import type {
  DraftSource,
  PendingDraftNavigation,
  PendingViewNavigation,
  ViewMode,
} from './ExamViewPrimitives';

type QuestionBankStoreState = ReturnType<typeof useQuestionBankStore.getState>;

export interface UseExamDraftGuardOptions {
  sessionId: string;
  viewMode: ViewMode;
  switchViewMode: (mode: ViewMode) => void;
  gradingMode: GradingMode;
  practiceMode: PracticeMode;
  practiceSessionOwner: PracticeSessionOwner | null | undefined;
  activeTimedSession: QuestionBankStoreState['timedSession'];
  activeMockExamSession: QuestionBankStoreState['mockExamSession'];
  activeDailyPractice: QuestionBankStoreState['dailyPractice'];
  batchFlushRef: RefObject<(() => Promise<void>) | null>;
  csvImportingRef: RefObject<boolean>;
  flushPendingQbankRefreshRef: RefObject<(() => void) | null>;
  onClearBatchState: () => void;
  onResetPendingSettings: () => void;
  onSetTimerRunning: (running: boolean) => void;
  onSaveStateChange?: ContentViewProps['onSaveStateChange'];
}

export function useExamDraftGuard({
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
  onClearBatchState,
  onResetPendingSettings,
  onSetTimerRunning,
  onSaveStateChange,
}: UseExamDraftGuardOptions) {
  const reviewSession = useReviewPlanStore((state) => state.session);
  const endReviewSession = useReviewPlanStore((state) => state.endSession);

  const [pendingReviewExitView, setPendingReviewExitView] = useState<PendingViewNavigation | null>(null);
  /** 离开进行中的练习/考试前的确认目标视图（与复习退出同款内联条） */
  const [pendingPracticeExitView, setPendingPracticeExitView] = useState<PendingViewNavigation | null>(null);
  const [draftState, setDraftState] = useState({ examId: sessionId, dirty: false });
  const [pendingDraftNavigation, setPendingDraftNavigation] = useState<PendingDraftNavigation | null>(null);

  const activeDraftExamIdRef = useRef(sessionId);
  const draftSourcesRef = useRef<Record<DraftSource, boolean>>({
    practice: false,
    inlineEditor: false,
  });
  const draftStateRef = useRef({ examId: sessionId, dirty: false });
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

  // 会话切换时清空草稿状态与退出确认条
  useEffect(() => {
    draftSourcesRef.current = { practice: false, inlineEditor: false };
    draftStateRef.current = { examId: sessionId, dirty: false };
    setDraftState({ examId: sessionId, dirty: false });
    setPendingDraftNavigation(null);
    setPendingReviewExitView(null);
    setPendingPracticeExitView(null);
  }, [sessionId]);

  // 视图壳只消费判分侧已有的 dirty 信号；判分侧尚未提供窗口级保存 API，
  // 故不注册 save handler（不自造保存），关窗确认只提供「放弃/取消」。
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
  }, [isCurrentExamDraftDirty, flushPendingQbankRefreshRef]);

  // Tab navigation is an explicit exit point for an in-progress SM-2 queue.
  // Keep submitted ratings, but ask before discarding the remaining local queue.
  const hasInProgressPracticeSession = useCallback((): boolean => {
    if (viewMode !== 'practice') return false;
    if (gradingMode === 'on_submit') return false;
    if (
      practiceMode === 'timed'
      && activeTimedSession
      && !activeTimedSession.is_submitted
      && !activeTimedSession.is_timeout
    ) {
      return true;
    }
    if (
      practiceMode === 'mock_exam'
      && activeMockExamSession
      && !activeMockExamSession.is_submitted
    ) {
      return true;
    }
    if (
      practiceMode === 'daily'
      && activeDailyPractice
      && !activeDailyPractice.is_completed
      && (activeDailyPractice.completed_count ?? 0) > 0
    ) {
      return true;
    }
    // 普通顺序/随机练习：已作答但未答完
    const ownerKey = practiceSessionOwner
      ? getPracticeSessionKey(practiceSessionOwner)
      : null;
    const progress = ownerKey
      ? useQuestionBankStore.getState().practiceSessions[ownerKey]
      : undefined;
    if (
      progress
      && progress.answeredIds.length > 0
      && progress.answeredIds.length < progress.questionIds.length
    ) {
      return true;
    }
    return false;
  }, [
    viewMode,
    practiceMode,
    activeTimedSession,
    activeMockExamSession,
    activeDailyPractice,
    practiceSessionOwner,
    gradingMode,
  ]);

  const applyViewMode = useCallback((mode: ViewMode, afterViewChange?: () => void, changesPractice = false): boolean => {
    if (mode === viewMode && !changesPractice) return true;

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
        setPendingReviewExitView({ examId: sessionId, view: mode, afterViewChange });
        return false;
      }
      endReviewSession();
    }

    // 离开进行中的练习/考试：内联确认，避免误触丢进度
    if (viewMode === 'practice' && (mode !== 'practice' || changesPractice) && hasInProgressPracticeSession()) {
      setPendingPracticeExitView({ examId: sessionId, view: mode, afterViewChange });
      return false;
    }

    switchViewMode(mode);
    return true;
  }, [
    csvImportingRef,
    endReviewSession,
    reviewSession,
    sessionId,
    switchViewMode,
    viewMode,
    hasInProgressPracticeSession,
  ]);

  const requestViewMode = useCallback((mode: ViewMode, afterViewChange?: () => void, changesPractice = false): boolean => {
    setPendingDraftNavigation(null);
    setPendingReviewExitView(null);
    setPendingPracticeExitView(null);
    onResetPendingSettings();
    const requiresNavigation = mode !== viewMode || Boolean(afterViewChange) || changesPractice;
    if (!requiresNavigation) return true;
    const proceed = () => {
      const handled = applyViewMode(mode, afterViewChange, changesPractice);
      if (handled) afterViewChange?.();
    };
    if (viewMode === 'practice' && gradingMode === 'on_submit' && batchFlushRef.current) {
      void batchFlushRef.current().then(() => {
        if (changesPractice) onClearBatchState();
        proceed();
      }).catch(error => showGlobalNotification('error', String(error)));
      return false;
    }
    const currentDraft = draftStateRef.current;
    if (currentDraft.examId === sessionId && currentDraft.dirty) {
      setPendingDraftNavigation({
        examId: sessionId,
        proceed,
      });
      return false;
    }
    const handled = applyViewMode(mode, afterViewChange, changesPractice);
    if (handled) afterViewChange?.();
    return handled;
  }, [applyViewMode, batchFlushRef, gradingMode, onClearBatchState, onResetPendingSettings, sessionId, viewMode]);

  // 退出复习 / 丢弃草稿确认的共享动作（行内确认条全端复用）
  const confirmReviewExit = useCallback(() => {
    const nextView = pendingReviewExitView;
    setPendingReviewExitView(null);
    if (!nextView || nextView.examId !== sessionId) return;
    endReviewSession();
    switchViewMode(nextView.view);
    nextView.afterViewChange?.();
  }, [endReviewSession, pendingReviewExitView, sessionId, switchViewMode]);

  const cancelReviewExit = useCallback(() => {
    setPendingReviewExitView(null);
    onResetPendingSettings();
  }, [onResetPendingSettings]);

  const confirmPracticeExit = useCallback(() => {
    const nextView = pendingPracticeExitView;
    setPendingPracticeExitView(null);
    if (!nextView || nextView.examId !== sessionId) return;
    onSetTimerRunning(nextView.view === 'practice');
    switchViewMode(nextView.view);
    nextView.afterViewChange?.();
  }, [onSetTimerRunning, pendingPracticeExitView, sessionId, switchViewMode]);

  const cancelPracticeExit = useCallback(() => {
    setPendingPracticeExitView(null);
    onResetPendingSettings();
  }, [onResetPendingSettings]);

  const confirmDiscardDraft = useCallback(() => {
    const pending = pendingDraftNavigation;
    setPendingDraftNavigation(null);
    if (!pending || pending.examId !== sessionId) return;
    clearCurrentExamDraft();
    pending.proceed();
  }, [clearCurrentExamDraft, pendingDraftNavigation, sessionId]);

  const cancelDiscardDraft = useCallback(() => {
    setPendingDraftNavigation(null);
    // 用户取消导航即取消整个链条：残留的待开设置请求不能在之后手动进入练习时突然弹面板
    onResetPendingSettings();
  }, [onResetPendingSettings]);

  return {
    draftStateRef,
    isCurrentExamDraftDirty,
    pendingReviewExitView,
    pendingPracticeExitView,
    pendingDraftNavigation,
    clearCurrentExamDraft,
    requestDraftNavigation,
    handlePracticeDraftDirtyChange,
    handleInlineEditorDraftDirtyChange,
    applyViewMode,
    requestViewMode,
    confirmReviewExit,
    cancelReviewExit,
    confirmPracticeExit,
    cancelPracticeExit,
    confirmDiscardDraft,
    cancelDiscardDraft,
  };
}
