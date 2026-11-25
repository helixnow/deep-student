import { useState, useEffect, useCallback, useMemo, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { TauriAPI, type ExamSheetSessionDetail } from '@/utils/tauriApi';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import {
  selectActiveTaskForExam,
  selectTasksForExam,
  useQbankGenerationStore,
} from '@/stores/qbankGenerationStore';
import {
  extractAuthoringDraftAttribution,
  QBANK_OPEN_GENERATION_DRAFT_EVENT,
  type PendingAuthoringDraftView,
  type QbankGenerationTask,
  type QbankOpenGenerationDraftDetail,
} from '@/types/qbankGeneration';
import type { ImportDraftResponse } from '@/components/ExamSheetUploader';
import type { ViewMode } from './ExamViewPrimitives';

export interface UseExamAuthoringDraftsOptions {
  sessionId: string;
  sessionDetail: ExamSheetSessionDetail | null;
  setSessionDetail: (detail: ExamSheetSessionDetail | null) => void;
  latestSessionIdRef: RefObject<string>;
  questionsLength: number;
  loadQuestions: () => Promise<void>;
  refreshQuestionsAndStats: () => Promise<void>;
  switchViewMode: (mode: ViewMode) => void;
}

/**
 * 题库导入断点续导、AI 生成后台任务与待确认草稿池管理：
 * - 拉取 `qbank_list_authoring_drafts` / `qbank_list_generation_tasks` 并监听 `qbank:refresh`
 * - 监听 `QBANK_OPEN_GENERATION_DRAFT_EVENT` 打开 AI 出题面板
 * - 审阅 / 一键确认入库待确认草稿、`handleResumeImport` 断点续导
 */
export function useExamAuthoringDrafts({
  sessionId,
  sessionDetail,
  setSessionDetail,
  latestSessionIdRef,
  questionsLength,
  loadQuestions,
  refreshQuestionsAndStats,
  switchViewMode,
}: UseExamAuthoringDraftsOptions) {
  const { t } = useTranslation(['exam_sheet', 'common', 'learningHub', 'review']);

  // AI 出题面板开关（MVP：ai-question-generation-feasibility-2026-09-07.md）
  const [showAiGenerationPanel, setShowAiGenerationPanel] = useState(false);
  const [aiGenerationTarget, setAiGenerationTarget] = useState<{ taskId?: string | null; jobId?: string | null } | null>(null);
  const [confirmingDraftJobId, setConfirmingDraftJobId] = useState<string | null>(null);

  const generationTasksMap = useQbankGenerationStore((state) => state.tasks);
  const activeGenerationTask = useMemo(
    () => selectActiveTaskForExam(generationTasksMap, sessionId) ?? null,
    [generationTasksMap, sessionId],
  );
  const completedGenerationTaskSignature = useMemo(
    () =>
      selectTasksForExam(generationTasksMap, sessionId)
        .filter((task) => task.status === 'completed')
        .map((task) => `${task.id}:${task.authoringResult?.job_id ?? ''}`)
        .join(','),
    [generationTasksMap, sessionId],
  );

  // 断点续导：检测 importing 状态
  const isImportingSession = sessionDetail?.summary.status === 'importing';
  const [isResuming, setIsResuming] = useState(false);
  const [resumedImportDraft, setResumedImportDraft] = useState<ImportDraftResponse | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [showImportAudit, setShowImportAudit] = useState(false);
  const [pendingAuthoringDrafts, setPendingAuthoringDrafts] = useState<PendingAuthoringDraftView[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void Promise.all([
        invoke<Array<{ job_id: string; version: number; question_count: number; status: string; created_at?: string }>>(
          'qbank_list_authoring_drafts',
          { examId: sessionId },
        ),
        invoke<QbankGenerationTask[]>('qbank_list_generation_tasks', {
          examId: sessionId,
          limit: 10,
        }).catch(() => null),
      ])
        .then(async ([rawDrafts, listedTasks]) => {
          if (cancelled) return;
          const tasksList = Array.isArray(listedTasks) ? listedTasks : [];
          if (tasksList.length > 0) {
            useQbankGenerationStore.getState().upsertTasks(tasksList);
          }
          const storeTasks = selectTasksForExam(useQbankGenerationStore.getState().tasks, sessionId);
          const taskByJobId = new Map<string, QbankGenerationTask>();
          for (const task of [...tasksList, ...storeTasks]) {
            const jid = task.authoringResult?.job_id;
            if (jid && !taskByJobId.has(jid)) taskByJobId.set(jid, task);
          }

          // 演示/旧后端可能对未知命令返回 null；非数组一律按“没有草稿”处理
          const drafts = Array.isArray(rawDrafts) ? rawDrafts : [];
          if (drafts.length === 0) {
            if (!cancelled) setPendingAuthoringDrafts([]);
            return;
          }

          const enriched = await Promise.all(
            drafts.map(async (draft, index): Promise<PendingAuthoringDraftView> => {
              const matchedTask = taskByJobId.get(draft.job_id);
              if (matchedTask?.authoringResult) {
                const { origin, sourceLabel } = extractAuthoringDraftAttribution(
                  matchedTask.authoringResult.model_route,
                  { defaultOrigin: 'ai_generation' },
                );
                const docQuestions = matchedTask.authoringResult.document?.questions;
                const localIds = Array.isArray(docQuestions)
                  ? docQuestions.map((q) => q.local_id).filter((id): id is string => typeof id === 'string' && id.length > 0)
                  : matchedTask.drafts.map((d) => d.local_id).filter((id): id is string => typeof id === 'string' && id.length > 0);
                return {
                  ...draft,
                  origin,
                  sourceLabel,
                  taskId: matchedTask.id,
                  ...(localIds.length > 0 ? { localIds } : {}),
                };
              }
              if (index < 5) {
                try {
                  const full = await invoke<{
                    metadata?: unknown;
                    document?: { questions?: Array<{ local_id?: string }> };
                  }>('qbank_get_authoring_draft', { jobId: draft.job_id });
                  const { origin, sourceLabel } = extractAuthoringDraftAttribution(full?.metadata);
                  const localIds = Array.isArray(full?.document?.questions)
                    ? full.document.questions
                        .map((q) => q.local_id)
                        .filter((id): id is string => typeof id === 'string' && id.length > 0)
                    : [];
                  return {
                    ...draft,
                    origin,
                    sourceLabel,
                    taskId: null,
                    ...(localIds.length > 0 ? { localIds } : {}),
                  };
                } catch {
                  // 详情读取失败时保留基础草稿项与默认归属
                }
              }
              const fallback = extractAuthoringDraftAttribution(null);
              return {
                ...draft,
                origin: fallback.origin,
                sourceLabel: fallback.sourceLabel,
                taskId: null,
              };
            }),
          );
          if (!cancelled) setPendingAuthoringDrafts(enriched);
        })
        .catch((error) => {
          debugLog.warn('[ExamContentView] Pending drafts unavailable:', error);
        });
    };
    setPendingAuthoringDrafts([]);
    refresh();
    window.addEventListener('qbank:refresh', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('qbank:refresh', refresh);
    };
  }, [sessionId, questionsLength, completedGenerationTaskSignature]);

  useEffect(() => {
    const onOpenGenerationDraft = (event: Event) => {
      const detail = (event as CustomEvent<QbankOpenGenerationDraftDetail>).detail;
      if (!detail || detail.examId !== sessionId) return;
      setAiGenerationTarget({
        taskId: detail.taskId ?? null,
        jobId: detail.jobId ?? null,
      });
      setShowAiGenerationPanel(true);
    };
    window.addEventListener(QBANK_OPEN_GENERATION_DRAFT_EVENT, onOpenGenerationDraft);
    return () => window.removeEventListener(QBANK_OPEN_GENERATION_DRAFT_EVENT, onOpenGenerationDraft);
  }, [sessionId]);

  // 会话切换时清理上一会话的恢复导入状态
  useEffect(() => {
    setIsResuming(false);
    setResumeError(null);
    setResumedImportDraft(null);
  }, [sessionId]);

  const handleOpenAuthoringDraft = useCallback(async (jobId: string) => {
    try {
      const draft = await invoke<{
        job_id: string;
        version: number;
        metadata: ImportDraftResponse['model_route'];
        document: NonNullable<ImportDraftResponse['draft_document']>;
      }>('qbank_get_authoring_draft', { jobId });
      if (latestSessionIdRef.current !== sessionId) return;
      const detail = sessionDetail ?? await TauriAPI.getExamSheetSessionDetail(sessionId);
      if (latestSessionIdRef.current !== sessionId) return;
      setResumedImportDraft({
        ...detail,
        draft_job_id: draft.job_id,
        draft_version: draft.version,
        draft_document: draft.document,
        model_route: draft.metadata,
        committed: false,
      });
      switchViewMode('upload');
    } catch (error) {
      showGlobalNotification('error', error instanceof Error ? error.message : String(error));
    }
  }, [latestSessionIdRef, sessionId, sessionDetail, switchViewMode]);

  const handleReviewPendingDraft = useCallback((draft: PendingAuthoringDraftView) => {
    if (draft.origin === 'ai_generation') {
      setAiGenerationTarget({
        taskId: draft.taskId ?? null,
        jobId: draft.job_id,
      });
      setShowAiGenerationPanel(true);
      return;
    }
    void handleOpenAuthoringDraft(draft.job_id);
  }, [handleOpenAuthoringDraft]);

  const handleConfirmPendingDraft = useCallback(async (draft: PendingAuthoringDraftView) => {
    if (confirmingDraftJobId !== null) return;
    setConfirmingDraftJobId(draft.job_id);
    try {
      let localIds = draft.localIds ?? [];
      let expectedVersion = draft.version;
      if (localIds.length === 0) {
        const full = await invoke<{
          version: number;
          document?: { questions?: Array<{ local_id?: string }> };
        }>('qbank_get_authoring_draft', { jobId: draft.job_id });
        expectedVersion = typeof full?.version === 'number' ? full.version : draft.version;
        localIds = Array.isArray(full?.document?.questions)
          ? full.document.questions
              .map((q) => q.local_id)
              .filter((id): id is string => typeof id === 'string' && id.length > 0)
          : [];
      }
      if (localIds.length === 0) {
        handleReviewPendingDraft(draft);
        return;
      }
      const created = await invoke<{ committed: boolean; imported_count: number }>(
        'qbank_commit_authoring_draft',
        {
          jobId: draft.job_id,
          expectedVersion,
          selectedLocalIds: localIds,
        },
      );
      if (!created?.committed) {
        throw new Error(t('exam_sheet:uploader.commit_not_confirmed'));
      }
      if (draft.taskId) {
        useQbankGenerationStore.getState().removeTask(draft.taskId);
      }
      setPendingAuthoringDrafts((prev) => prev.filter((item) => item.job_id !== draft.job_id));
      await refreshQuestionsAndStats();
      window.dispatchEvent(new CustomEvent('qbank:refresh', { detail: { examId: sessionId } }));
      showGlobalNotification(
        'success',
        t('exam_sheet:aiGeneration.importSuccess', {
          count: created.imported_count,
          defaultValue: `已确认并导入 ${created.imported_count} 道题目到题库`,
        }),
      );
    } catch (error) {
      debugLog.warn('[ExamContentView] Direct confirm pending draft failed, falling back to review:', error);
      showGlobalNotification(
        'warning',
        error instanceof Error
          ? `${error.message}，已打开审阅面板`
          : t('exam_sheet:aiGeneration.importFailed'),
      );
      handleReviewPendingDraft(draft);
    } finally {
      setConfirmingDraftJobId(null);
    }
  }, [confirmingDraftJobId, handleReviewPendingDraft, refreshQuestionsAndStats, sessionId, t]);

  const handleResumeImport = useCallback(async () => {
    if (!sessionId || isResuming) return;
    setIsResuming(true);
    setResumeError(null);
    try {
      const detail = await TauriAPI.resumeQuestionImport(sessionId);
      if (latestSessionIdRef.current !== sessionId) return;
      if ((detail as ImportDraftResponse).draft_job_id) {
        setResumedImportDraft(detail as ImportDraftResponse);
        switchViewMode('upload');
        return;
      }
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
  }, [latestSessionIdRef, sessionId, isResuming, setSessionDetail, loadQuestions, switchViewMode, t]);

  const handleOpenAiGeneration = useCallback(() => {
    setAiGenerationTarget(null);
    setShowAiGenerationPanel(true);
  }, []);

  const handleOpenGenerationProgress = useCallback(() => {
    if (!activeGenerationTask) return;
    setAiGenerationTarget({ taskId: activeGenerationTask.id, jobId: null });
    setShowAiGenerationPanel(true);
  }, [activeGenerationTask]);

  return {
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
  };
}
