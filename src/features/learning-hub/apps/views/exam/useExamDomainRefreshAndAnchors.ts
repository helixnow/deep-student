import { useState, useEffect, useCallback, useRef, useMemo, type MutableRefObject, type RefObject } from 'react';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  isQbankAgentModifyPayload,
  useQbankAgentDiffStore,
} from '@/stores/qbankAgentDiffStore';
import {
  QBANK_FOCUS_EVENT,
  type QbankFocusEventDetail,
  QBANK_REFRESH_EVENT,
  isQbankInlineEditorActive,
} from '@/features/workbench/agent/drivers/qbankDriver';
import { collectDomainEntityIds } from '@/features/workbench/agent/domainEvents';
import { agentFlash, agentFlashMany } from '@/features/workbench/agent/visuals/agentFlash';
import type { DomainChangePayload } from '@/features/workbench/agent/types';
import type { PracticeMode, Question } from '@/api/questionBankApi';
import type { GradingMode } from '@/api/practiceApi';
import {
  createQuestionRevealSequencer,
  extractQuestionIdFromAnchor,
} from '../examQuestionInterop';
import type { ViewMode } from './ExamViewPrimitives';

export interface UseExamDomainRefreshAndAnchorsOptions {
  sessionId: string;
  nodePath?: string;
  isActive?: boolean;
  focusScopeId?: string;
  viewMode: ViewMode;
  gradingMode: GradingMode;
  questions: Question[];
  questionsRef: RefObject<Question[]>;
  practiceQuestions: Question[];
  currentIndex: number;
  navigate: (index: number) => void;
  requestViewMode: (mode: ViewMode, afterViewChange?: () => void, changesPractice?: boolean) => boolean;
  setBrowseQuestionId: (questionId: string | null) => void;
  setGroupPracticeIds: (ids: string[] | null) => void;
  setStorePracticeMode: (mode: PracticeMode) => void;
  refreshQuestionsAndStats: () => Promise<void>;
  handleOpenQuestion: (questionId: string) => void;
  draftStateRef: RefObject<{ examId: string; dirty: boolean }>;
  flushPendingQbankRefreshRef: MutableRefObject<(() => void) | null>;
  batchNavigateRef: RefObject<((target: number | string) => Promise<void>) | null>;
  agentFlashRootRef: RefObject<HTMLDivElement | null>;
}

/**
 * 题库域刷新去抖、Agent diff 协调、语义锚点跳转（AppKernel anchors + DSTU_FOCUS_QBANK）
 * 与 `QBANK_FOCUS_EVENT` 处理。
 */
export function useExamDomainRefreshAndAnchors({
  sessionId,
  nodePath,
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
}: UseExamDomainRefreshAndAnchorsOptions) {
  // A domain refresh may arrive while an inline editor has focus elsewhere.
  // Keep the latest request until the editor reports that its draft is clean.
  const pendingQbankRefreshRef = useRef<DomainChangePayload | undefined>(undefined);
  const hasPendingQbankRefreshRef = useRef(false);
  // 域刷新去抖队列：批量变更会连发多个 qbank:refresh，合并为一次刷新。
  // 放 ref 而非 effect 局部变量：监听 effect 依赖频繁变化会重建，队列必须存活
  const qbankRefreshDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuedRefreshEntityIdsRef = useRef<string[]>([]);
  const queuedRefreshPayloadRef = useRef<DomainChangePayload | undefined>(undefined);
  const queuedRefreshAgentModifyRef = useRef(false);
  const queuedRefreshRunIdRef = useRef<string | undefined>(undefined);
  const pendingAgentReconcileRef = useRef(false);
  const [agentRefreshTick, setAgentRefreshTick] = useState(0);
  const revealSequencerRef = useRef(createQuestionRevealSequencer());
  const pendingAnchorRevealRef = useRef<{
    questionId: string;
    pulse: boolean;
    token: number;
  } | null>(null);
  // 行内编辑聚焦时的 800ms 延迟重试 timer：同样必须跨 effect 重建存活，
  // 否则 deps（questions 等）一变就取消，被延迟的刷新会静默丢失
  const qbankDeferredEditorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 会话切换：清空上一会话排队中的域刷新（entityIds 属于旧会话，不能串台）
  useEffect(() => {
    pendingQbankRefreshRef.current = undefined;
    hasPendingQbankRefreshRef.current = false;
    flushPendingQbankRefreshRef.current = null;
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
    queuedRefreshAgentModifyRef.current = false;
    queuedRefreshRunIdRef.current = undefined;
    pendingAgentReconcileRef.current = false;
    pendingAnchorRevealRef.current = null;
    revealSequencerRef.current.cancel();
  }, [sessionId, flushPendingQbankRefreshRef]);

  // 卸载时清理仍在排队的域刷新 timer（防止卸载后触发无意义的刷新）
  useEffect(() => () => {
    revealSequencerRef.current.cancel();
    pendingAnchorRevealRef.current = null;
    if (qbankRefreshDebounceTimerRef.current) {
      clearTimeout(qbankRefreshDebounceTimerRef.current);
      qbankRefreshDebounceTimerRef.current = null;
    }
    if (qbankDeferredEditorTimerRef.current) {
      clearTimeout(qbankDeferredEditorTimerRef.current);
      qbankDeferredEditorTimerRef.current = null;
    }
  }, []);

  /**
   * ACR R1-15：消费 qbankDriver 派发的域刷新 / 聚焦事件。
   * - 刷新：未保存草稿时保留最后一次刷新，避免新的 question 对象重置行内表单
   * - 聚焦：打开对应题目并 flash
   */
  useEffect(() => {
    const flashIds = (entityIds: string[] | undefined, payload?: DomainChangePayload) => {
      const scope = agentFlashRootRef.current;
      if (!scope) return;
      const ids =
        (entityIds?.length ? entityIds : null) ??
        (payload ? collectDomainEntityIds(payload) : []);
      agentFlashMany('exam', ids, { scope });
    };

    const runLocalRefresh = (payload?: DomainChangePayload, mergedEntityIds?: string[]) => {
      const currentDraft = draftStateRef.current;
      if (currentDraft.examId === sessionId && currentDraft.dirty) {
        pendingQbankRefreshRef.current = payload;
        hasPendingQbankRefreshRef.current = true;
        return;
      }

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

      const isAgentModify = isQbankAgentModifyPayload(payload);
      if (isAgentModify) {
        useQbankAgentDiffStore
          .getState()
          .stageBeforeRefresh(
            sessionId,
            questionsRef.current,
            mergedEntityIds?.length ? mergedEntityIds : payload?.entityIds,
            payload?.runId,
          );
      }

      void refreshQuestionsAndStats()
        .then(() => {
          if (isAgentModify) {
            pendingAgentReconcileRef.current = true;
            setAgentRefreshTick((tick) => tick + 1);
          }
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

    const onRefresh = (ev: Event) => {
      const detail = (ev as CustomEvent<DomainChangePayload>).detail;
      if (detail) {
        const incomingIds = collectDomainEntityIds(detail);
        queuedRefreshEntityIdsRef.current.push(...incomingIds);
        if (isQbankAgentModifyPayload(detail)) {
          queuedRefreshAgentModifyRef.current = true;
          if (typeof detail.runId === 'string' && detail.runId) {
            queuedRefreshRunIdRef.current = detail.runId;
          }
          useQbankAgentDiffStore
            .getState()
            .stageBeforeRefresh(
              sessionId,
              questionsRef.current,
              incomingIds.length > 0 ? incomingIds : detail.entityIds,
              detail.runId,
            );
        }
        queuedRefreshPayloadRef.current = detail;
      }
      if (qbankRefreshDebounceTimerRef.current) {
        clearTimeout(qbankRefreshDebounceTimerRef.current);
      }
      qbankRefreshDebounceTimerRef.current = setTimeout(() => {
        qbankRefreshDebounceTimerRef.current = null;
        const mergedIds = Array.from(new Set(queuedRefreshEntityIdsRef.current));
        const rawPayload = queuedRefreshPayloadRef.current;
        const wasAgentModify = queuedRefreshAgentModifyRef.current;
        const latchedRunId = queuedRefreshRunIdRef.current;
        queuedRefreshEntityIdsRef.current = [];
        queuedRefreshPayloadRef.current = undefined;
        queuedRefreshAgentModifyRef.current = false;
        queuedRefreshRunIdRef.current = undefined;

        const effectivePayload =
          wasAgentModify && rawPayload
            ? {
                ...rawPayload,
                source: 'agent' as const,
                action:
                  isQbankAgentModifyPayload(rawPayload) && rawPayload.action
                    ? rawPayload.action
                    : 'changed',
                entityIds: mergedIds,
                ...(latchedRunId ? { runId: latchedRunId } : {}),
              }
            : rawPayload;

        runLocalRefresh(effectivePayload, mergedIds);
      }, 200);
    };

    const onFocus = (ev: Event) => {
      const detail = (ev as CustomEvent<QbankFocusEventDetail & { groupId?: string }>).detail;
      if (detail?.targetScopeId && detail.targetScopeId !== focusScopeId) return;
      if (detail?.targetResourceId && detail.targetResourceId !== sessionId) return;
      const questionId = detail?.questionId;
      if (questionId && viewMode === 'practice' && gradingMode === 'on_submit' && batchNavigateRef.current) {
        void batchNavigateRef.current(questionId)
          .then(() => detail.acknowledge?.({ handled: true, previousQuestionId: questions[currentIndex]?.id ?? null }))
          .catch(() => detail.acknowledge?.({ handled: false, previousQuestionId: null }));
        return;
      }
      // issue 491：题组深链定位到组内第一题（组内顺序由后端 group_position 保证）
      const groupId = detail?.groupId;
      if (!questionId && !groupId) return;
      const index = questionId
        ? questions.findIndex((question) => question.id === questionId)
        : questions.findIndex((question) => question.groupId === groupId);
      const handled = index >= 0 && requestViewMode('practice', () => navigate(index));
      const previousQuestionId = questions[currentIndex]?.id ?? null;
      const resolvedQuestionId = index >= 0 ? questions[index].id : questionId;
      if (handled && resolvedQuestionId) {
        agentFlash('exam', resolvedQuestionId, { scope: agentFlashRootRef.current });
      }
      detail.acknowledge?.({ handled, previousQuestionId });
    };

    window.addEventListener(QBANK_REFRESH_EVENT, onRefresh);
    window.addEventListener(QBANK_FOCUS_EVENT, onFocus);
    return () => {
      window.removeEventListener(QBANK_REFRESH_EVENT, onRefresh);
      window.removeEventListener(QBANK_FOCUS_EVENT, onFocus);
      if (flushPendingQbankRefreshRef.current === flushPendingRefresh) {
        flushPendingQbankRefreshRef.current = null;
      }
    };
  }, [
    agentFlashRootRef,
    batchNavigateRef,
    currentIndex,
    draftStateRef,
    flushPendingQbankRefreshRef,
    focusScopeId,
    gradingMode,
    navigate,
    questions,
    questionsRef,
    refreshQuestionsAndStats,
    requestViewMode,
    sessionId,
    viewMode,
  ]);

  // Reconcile staged Agent snapshots after React commits the refreshed `questions` array.
  useEffect(() => {
    if (!pendingAgentReconcileRef.current) return;
    pendingAgentReconcileRef.current = false;
    useQbankAgentDiffStore.getState().reconcileAfterRefresh(sessionId, questions);
  }, [agentRefreshTick, questions, sessionId]);

  const interopIds = useMemo(() => {
    const raw = [sessionId, nodePath].filter(
      (val): val is string => typeof val === 'string' && val.trim().length > 0,
    );
    return Array.from(new Set(raw));
  }, [sessionId, nodePath]);
  const interopKey = interopIds.join('\u0000');

  const findQuestionEntityElement = useCallback((questionId: string): HTMLElement | null => {
    const scope = agentFlashRootRef.current;
    if (!scope || !questionId) return null;
    const targetAttr = `exam:${questionId}`;
    const candidates = scope.querySelectorAll<HTMLElement>('[data-agent-entity]');
    for (const el of candidates) {
      if (el.getAttribute('data-agent-entity') === targetAttr) {
        return el;
      }
    }
    return null;
  }, [agentFlashRootRef]);

  const revealQuestionInView = useCallback(
    (questionId: string | null, pulse: boolean, token: number): boolean => {
      if (!revealSequencerRef.current.isCurrent(token)) return false;
      if (!questionId) return true;

      const list = questionsRef.current;
      const index = list.findIndex((q) => q.id === questionId);
      if (index < 0) {
        return false;
      }

      const targetQuestion = list[index]!;
      const existingRow = findQuestionEntityElement(questionId);

      if (viewMode === 'list' || (viewMode === 'review' && targetQuestion.status === 'review')) {
        navigate(index);
        if (existingRow) {
          existingRow.scrollIntoView?.({ block: 'center', behavior: 'auto' });
        }
      } else if (viewMode === 'browse') {
        setBrowseQuestionId(questionId);
        navigate(index);
      } else if (viewMode === 'practice') {
        if (gradingMode === 'on_submit' && batchNavigateRef.current) {
          void batchNavigateRef.current(questionId).catch(() => undefined);
        } else {
          if (!practiceQuestions.some((q) => q.id === questionId)) {
            setGroupPracticeIds(null);
            setStorePracticeMode('sequential');
          }
          navigate(index);
        }
      } else {
        requestViewMode('browse', () => {
          if (!revealSequencerRef.current.isCurrent(token)) return;
          setBrowseQuestionId(questionId);
          navigate(index);
        });
      }

      if (pulse) {
        agentFlash('exam', questionId, { scope: agentFlashRootRef.current });
        if (!existingRow && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => {
            if (!revealSequencerRef.current.isCurrent(token)) return;
            const mountedRow = findQuestionEntityElement(questionId);
            if (mountedRow) {
              mountedRow.scrollIntoView?.({ block: 'center', behavior: 'auto' });
            }
            agentFlash('exam', questionId, { scope: agentFlashRootRef.current });
          });
        }
      }

      return true;
    },
    [
      agentFlashRootRef,
      batchNavigateRef,
      findQuestionEntityElement,
      gradingMode,
      navigate,
      practiceQuestions,
      questionsRef,
      requestViewMode,
      setBrowseQuestionId,
      setGroupPracticeIds,
      setStorePracticeMode,
      viewMode,
    ],
  );

  const handleFocusQuestionById = useCallback(
    (questionId: string) => {
      const token = revealSequencerRef.current.next();
      if (!revealQuestionInView(questionId, true, token)) {
        handleOpenQuestion(questionId);
      }
    },
    [handleOpenQuestion, revealQuestionInView],
  );

  useEffect(() => {
    if (interopIds.length === 0) return;
    const idSet = new Set(interopIds);
    const kernel = getAppKernel();

    const computeMatchQuality = (resourceId: string, aliasResourceId?: string) => {
      const matches =
        idSet.has(resourceId) ||
        (aliasResourceId !== undefined && idSet.has(aliasResourceId));
      if (!matches) return false as const;
      const active = typeof document !== 'undefined' ? document.activeElement : null;
      if ((active && agentFlashRootRef.current?.contains(active)) || isActive === true) {
        return 'exact-focused' as const;
      }
      return 'exact-mounted' as const;
    };

    const handleAnchorReveal = (questionId: string | null, pulse: boolean) => {
      const token = revealSequencerRef.current.next();
      if (revealQuestionInView(questionId, pulse, token)) {
        pendingAnchorRevealRef.current = null;
        return true;
      }
      if (questionId && questionsRef.current.length === 0) {
        pendingAnchorRevealRef.current = { questionId, pulse, token };
        return true;
      }
      return false;
    };

    const disposeQbank = kernel.anchors.registerAnchorRevealHandler('qbank', {
      canHandle: (anchor) => computeMatchQuality(anchor.resourceId, anchor.aliasResourceId),
      reveal: (anchor, ctx) => handleAnchorReveal(extractQuestionIdFromAnchor(anchor), ctx.pulse),
    });

    const disposeCustom = kernel.anchors.registerAnchorRevealHandler('custom', {
      canHandle: (anchor) => {
        if (anchor.namespace !== 'exam' && anchor.namespace !== 'qbank') return false;
        return computeMatchQuality(anchor.resourceId, anchor.aliasResourceId);
      },
      reveal: (anchor, ctx) => handleAnchorReveal(extractQuestionIdFromAnchor(anchor), ctx.pulse),
    });

    return () => {
      disposeQbank();
      disposeCustom();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interopKey summarizes interopIds stably
  }, [interopKey, isActive, revealQuestionInView]);

  useEffect(() => {
    const pending = pendingAnchorRevealRef.current;
    if (!pending || questions.length === 0) return;
    pendingAnchorRevealRef.current = null;
    revealQuestionInView(pending.questionId, pending.pulse, pending.token);
  }, [questions, revealQuestionInView]);

  useEffect(() => {
    if (interopIds.length === 0) return;
    const idSet = new Set(interopIds);
    const onHostFocusQbank = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{ bankId?: string; questionId?: string; splitIfClosed?: boolean }>
      ).detail;
      if (!detail?.bankId || !idSet.has(detail.bankId)) return;
      const token = revealSequencerRef.current.next();
      const targetId = detail.questionId?.trim() || null;
      if (!revealQuestionInView(targetId, true, token) && targetId && questionsRef.current.length === 0) {
        pendingAnchorRevealRef.current = { questionId: targetId, pulse: true, token };
      }
    };
    window.addEventListener('DSTU_FOCUS_QBANK', onHostFocusQbank);
    return () => window.removeEventListener('DSTU_FOCUS_QBANK', onHostFocusQbank);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interopKey summarizes interopIds stably
  }, [interopKey, revealQuestionInView]);

  return {
    handleFocusQuestionById,
  };
}
