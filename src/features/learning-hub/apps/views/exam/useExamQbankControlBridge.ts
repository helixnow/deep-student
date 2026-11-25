import { useEffect, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getPracticeStartIndex,
  type PracticeMode,
  type Question,
} from '@/api/questionBankApi';
import type { GradingMode } from '@/api/practiceApi';
import {
  useQuestionBankStore,
  validateQbankPracticeHandoff,
  type PracticeHandoffHydrationResult,
} from '@/stores/questionBankStore';
import {
  QBANK_CONTROL_EVENT,
  type QbankControlEventDetail,
  type QbankControlResult,
} from '@/features/workbench/agent/drivers/qbankDriver';
import { agentFlash } from '@/features/workbench/agent/visuals/agentFlash';
import {
  LAUNCHER_REQUIRED_MODES,
  matchesPracticeTag,
  parseManageFilters,
  type LauncherRequestedMode,
  type ManageFilters,
  type ViewMode,
} from './ExamViewPrimitives';

export interface UseExamQbankControlBridgeOptions {
  sessionId: string;
  viewMode: ViewMode;
  gradingMode: GradingMode;
  hasQuestions: boolean;
  questions: Question[];
  practiceQuestions: Question[];
  currentIndex: number;
  practiceMode: PracticeMode;
  settingsPanelOpen: boolean;
  setSettingsPanelOpen: (open: boolean) => void;
  setPendingSettingsOpen: (open: boolean) => void;
  setFocusMode: (enabled: boolean) => void;
  setManageFilters: (filters: ManageFilters) => void;
  setElapsedTime: (elapsed: number) => void;
  setStorePracticeMode: (mode: PracticeMode) => void;
  setSelectedTag: (tag: string) => void;
  onResetToBatchImmediateDefaults: () => void;
  navigate: (index: number) => void;
  requestViewMode: (mode: ViewMode, afterViewChange?: () => void, changesPractice?: boolean) => boolean;
  csvImportingRef: RefObject<boolean>;
  batchNavigateRef: RefObject<((target: number | string) => Promise<void>) | null>;
  agentFlashRootRef: RefObject<HTMLDivElement | null>;
}

/**
 * 题库工作台控制事件桥接（含 ACK 回执）：
 * - `exam:openSettings`
 * - `exam:setFocusMode`
 * - `QBANK_CONTROL_EVENT`（翻题 / 筛选 / 会话水合 / 切换练习模式）
 */
export function useExamQbankControlBridge({
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
  onResetToBatchImmediateDefaults,
  navigate,
  requestViewMode,
  csvImportingRef,
  batchNavigateRef,
  agentFlashRootRef,
}: UseExamQbankControlBridgeOptions) {
  const { t } = useTranslation(['exam_sheet', 'common', 'learningHub', 'review']);

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

      // 顶栏「更多→设置」不带 open（toggle 语义），而设置面板只在练习视图渲染：
      // 非 practice 时直接翻转 settingsPanelOpen 既无可见反馈，还会让之后进入
      // 练习时面板意外弹出。toggle 仅在 practice 有效；非 practice 统一按「打开」
      // 处理，复用 open === true 的进练习守卫。
      const open = detail?.open ?? (viewMode === 'practice' ? undefined : true);
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

      if (open === false) setPendingSettingsOpen(false);
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
  }, [csvImportingRef, hasQuestions, requestViewMode, sessionId, setPendingSettingsOpen, setSettingsPanelOpen, settingsPanelOpen, t, viewMode]);

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
      const previous = useQuestionBankStore.getState().focusMode;
      if (enabled && viewMode !== 'practice' && !requestViewMode('practice', () => setFocusMode(true))) {
        detail?.acknowledge?.({
          handled: false,
          code: 'CONFIRMATION_REQUIRED',
          hint: t('learningHub:exam.controlHints.confirmEndReviewForFocusMode'),
        });
        return;
      }
      if (!enabled || viewMode === 'practice') setFocusMode(enabled);
      detail?.acknowledge?.({
        handled: true,
        changed: previous !== enabled,
        previousEnabled: previous,
      });
    };
    window.addEventListener('exam:setFocusMode', handleFocusModeChange);
    return () => window.removeEventListener('exam:setFocusMode', handleFocusModeChange);
  }, [hasQuestions, requestViewMode, sessionId, setFocusMode, t, viewMode]);

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
        if (viewMode === 'practice' && gradingMode === 'on_submit' && batchNavigateRef.current) {
          void batchNavigateRef.current(detail.action === 'nextQuestion' ? 1 : -1)
            .then(() => acknowledge(detail, { handled: true }))
            .catch(error => acknowledge(detail, { handled: false, code: 'SAVE_FAILED', hint: String(error) }));
          return;
        }
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
          onResetToBatchImmediateDefaults();
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
        const nextIndex = getPracticeStartIndex(questions, currentIndex, mode, tag);
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
    agentFlashRootRef,
    batchNavigateRef,
    currentIndex,
    gradingMode,
    navigate,
    onResetToBatchImmediateDefaults,
    practiceMode,
    practiceQuestions,
    questions,
    requestViewMode,
    sessionId,
    setElapsedTime,
    setManageFilters,
    setSelectedTag,
    setStorePracticeMode,
    t,
    viewMode,
  ]);
}
