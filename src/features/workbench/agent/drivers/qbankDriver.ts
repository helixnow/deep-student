/**
 * ACR qbank(exam) Driver — R1-15
 *
 * - probe：始终 clean（脏态由 contentDirty / 行内编辑守卫在刷新侧处理）
 * - apply：仅导航类 op（qbank_focus_question / focus_question）
 * - 域事件 `qbank://changed` → refreshQuestions + 保持 currentQuestionId；行内编辑中延迟
 *
 * 见 docs/dev/acr/DESIGN.md §5.4 / ROUND1.md R1-15。
 */
import { useQuestionBankStore } from '@/stores/questionBankStore';
import { collectDomainEntityIds, registerDomainListener } from '../domainEvents';
import { listTickCost } from '../pacing';
import { withUserPatch } from '../userPatch';
import { agentFlash, agentFlashMany } from '../visuals/agentFlash';
import type {
  AcrProbeState,
  AcrReceipt,
  AcrRunContext,
  AcrTarget,
  AgentOp,
  CollabDriver,
  DomainChangePayload,
  StageManagerApi,
} from '../types';

const TYPE_ID = 'exam';

/** ExamContentView 监听：聚焦某题（本地 session 与 store 双写） */
export const QBANK_FOCUS_EVENT = 'qbank:focus-question';

/** ExamContentView 监听：域变更后刷新本地题目列表 */
export const QBANK_REFRESH_EVENT = 'qbank:refresh';

let deferredRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let domainUnlisten: (() => void) | null = null;

function emptyReceipt(
  status: AcrReceipt['status'],
  totalOps: number,
  partial?: Partial<AcrReceipt>,
): AcrReceipt {
  return {
    status,
    mode: 'frontend',
    applied: 0,
    totalOps,
    entityIds: [],
    done: [],
    undone: [],
    ...partial,
  };
}

/**
 * store 无独立「行内编辑」字段；以 document.activeElement 是否在可编辑控件内为准。
 * QuestionInlineEditor / 答题区均为 input/textarea/contenteditable。
 */
export function isQbankInlineEditorActive(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.closest('[data-question-inline-editor]')) return true;
  if (el.closest('[data-agent-qbank-editor]')) return true;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    // 排除纯搜索框：仍视为编辑中，宁可延迟刷新
    return true;
  }
  if (el.isContentEditable) return true;
  return Boolean(el.closest('[contenteditable="true"]'));
}

function flashEntityIds(entityIds: string[] | undefined): void {
  const ids = (entityIds ?? []).filter((id): id is string => typeof id === 'string' && !!id);
  agentFlashMany(TYPE_ID, ids);
}

/** R2-04：答题中 / 行内编辑守卫——焦点在答题区或 inline editor 内则延迟刷新 */
export function isQbankAnsweringOrEditing(): boolean {
  return isQbankInlineEditorActive();
}

function dispatchRefreshEvent(payload: DomainChangePayload): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(QBANK_REFRESH_EVENT, { detail: payload }),
  );
}

function dispatchFocusEvent(questionId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(QBANK_FOCUS_EVENT, { detail: { questionId } }),
  );
}

/**
 * 刷新题目列表并保持 currentQuestionId。
 * loadQuestions 会把 current 重置为第一题，故必须显式恢复。
 * 导出供单测。
 */
export async function refreshQbankPreservingCurrent(
  payload?: DomainChangePayload,
): Promise<void> {
  // R2-04：答题中（答案输入焦点）与行内编辑同一守卫——延迟而非冲掉草稿
  if (isQbankAnsweringOrEditing()) {
    if (deferredRefreshTimer) clearTimeout(deferredRefreshTimer);
    deferredRefreshTimer = setTimeout(() => {
      deferredRefreshTimer = null;
      void refreshQbankPreservingCurrent(payload);
    }, 800);
    return;
  }

  const store = useQuestionBankStore.getState();
  const preservedId = store.currentQuestionId;
  await store.refreshQuestions();
  if (preservedId) {
    const after = useQuestionBankStore.getState();
    if (after.questions.has(preservedId)) {
      after.setCurrentQuestion(preservedId);
    }
  }

  const entityIds = payload
    ? collectDomainEntityIds(payload)
    : [];
  dispatchRefreshEvent(
    payload ?? { source: 'agent', action: 'changed', entityIds: [] },
  );
  flashEntityIds(entityIds.length > 0 ? entityIds : payload?.entityIds);
}

function parseQuestionId(op: AgentOp): string | null {
  if (typeof op.anchor === 'string' && op.anchor) return op.anchor;
  if (op.payload && typeof op.payload === 'object') {
    const p = op.payload as { questionId?: unknown; id?: unknown };
    if (typeof p.questionId === 'string' && p.questionId) return p.questionId;
    if (typeof p.id === 'string' && p.id) return p.id;
  }
  return null;
}

export const qbankDriver: CollabDriver = {
  typeId: TYPE_ID,

  probe(_target: AcrTarget): AcrProbeState {
    return 'clean';
  },

  async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
    const done: string[] = [];
    const undone: string[] = [];
    const entityIds: string[] = [];
    let applied = 0;
    const totalOps = ops.length;

    for (let i = 0; i < ops.length; i++) {
      const pause = await run.checkPaused();
      if (pause === 'abort') {
        return withUserPatch(
          emptyReceipt('cancelled', totalOps, {
            applied,
            entityIds,
            done,
            undone: [...undone, ...ops.slice(i).map((op) => op.label || op.kind)],
          }),
          TYPE_ID,
        );
      }

      const op = ops[i]!;
      run.reportProgress(i + 1, totalOps, op.label || op.kind);

      if (op.kind === 'qbank_focus_question' || op.kind === 'focus_question') {
        const questionId = parseQuestionId(op);
        if (!questionId) {
          undone.push(op.label || op.kind);
        } else {
          const previousQuestionId = useQuestionBankStore.getState().currentQuestionId;
          useQuestionBankStore.getState().setCurrentQuestion(questionId);
          dispatchFocusEvent(questionId);
          agentFlash(TYPE_ID, questionId);
          entityIds.push(questionId);
          done.push(op.label || `聚焦题目 ${questionId}`);
          applied += 1;
          run.ledger.record(
            run.runId,
            () => {
              useQuestionBankStore.getState().setCurrentQuestion(previousQuestionId);
              if (previousQuestionId) dispatchFocusEvent(previousQuestionId);
            },
            op.label || op.kind,
          );
        }
      } else {
        undone.push(op.label || op.kind);
      }

      await run.pacing.tick(listTickCost(run.pacing.profile));
    }

    const status: AcrReceipt['status'] =
      applied === totalOps && undone.length === 0
        ? 'completed'
        : applied > 0
          ? 'partial'
          : totalOps === 0
            ? 'completed'
            : 'failed';

    return {
      status,
      mode: 'frontend',
      applied,
      totalOps,
      entityIds,
      done,
      undone,
      message:
        status === 'failed'
          ? 'qbank driver 仅支持导航 op（qbank_focus_question）；数据修改请用领域工具'
          : undefined,
    };
  },

  abort(runId: string): AcrReceipt {
    return withUserPatch(
      emptyReceipt('cancelled', 0, {
        message: `run ${runId} aborted`,
      }),
      TYPE_ID,
    );
  },
};

export function handleQbankDomainChange(payload: DomainChangePayload): void {
  void refreshQbankPreservingCurrent(payload);
}

export function registerQbankDriver(stage: StageManagerApi): () => void {
  stage.registerDriver(qbankDriver);
  domainUnlisten?.();
  const unlisten = registerDomainListener('qbank://changed', handleQbankDomainChange);
  domainUnlisten = unlisten;

  return () => {
    if (domainUnlisten !== unlisten) return;
    domainUnlisten = null;
    unlisten();
  };
}

/** 单测清理延迟刷新定时器 */
export function __resetQbankDriverForTests(): void {
  domainUnlisten?.();
  domainUnlisten = null;
  if (deferredRefreshTimer) {
    clearTimeout(deferredRefreshTimer);
    deferredRefreshTimer = null;
  }
}
