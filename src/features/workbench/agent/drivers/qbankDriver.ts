/**
 * ACR qbank(exam) Driver — R1-15
 *
 * - probe：题库编辑器真实获焦时 hot，其余 clean
 * - apply：仅导航类 op（qbank_focus_question / focus_question）
 * - 域事件 `qbank://changed` → refreshQuestions + 保持 currentQuestionId；行内编辑中延迟
 *
 * 见 docs/dev/acr/DESIGN.md §5.4 / ROUND1.md R1-15。
 */
import i18n from '@/i18n';
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

export interface QbankFocusResult {
  handled: boolean;
  previousQuestionId: string | null;
}

export interface QbankFocusEventDetail {
  questionId: string;
  /** Restricts a workbench activation to the currently mounted exam resource. */
  targetResourceId?: string;
  acknowledge?: (result: QbankFocusResult) => void;
}

/** ExamContentView 监听：域变更后刷新本地题目列表 */
export const QBANK_REFRESH_EVENT = 'qbank:refresh';

/** ExamContentView owns its questions locally, so OS actions use this bridge. */
export const QBANK_CONTROL_EVENT = 'qbank:control';

export type QbankControlAction =
  | 'nextQuestion'
  | 'previousQuestion'
  | 'setFilters'
  | 'resetFilters'
  | 'setPracticeMode'
  | 'hydratePracticeSession';

export interface QbankControlResult {
  handled: boolean;
  code?: string;
  hint?: string;
  currentQuestionId?: string | null;
  acknowledged?: boolean;
  hydratedSessionId?: string;
  practiceMode?: 'timed' | 'mock_exam' | 'daily';
}

export interface QbankControlEventDetail {
  targetResourceId?: string;
  action: QbankControlAction;
  payload?: unknown;
  acknowledge?: (result: QbankControlResult) => void;
}

let deferredRefreshTimer: ReturnType<typeof setTimeout> | null = null;
/** 行内编辑期间到达的域事件载荷合并暂存：只保留最新 action/runId，entityIds 取并集 */
let pendingDeferredPayload: DomainChangePayload | null = null;
let domainUnlisten: (() => void) | null = null;

function mergeDeferredPayloads(
  previous: DomainChangePayload | null,
  next: DomainChangePayload | undefined,
): DomainChangePayload | null {
  if (!next) return previous;
  if (!previous) return next;
  const mergedIds = [
    ...(previous.entityIds ?? []),
    ...(next.entityIds ?? []),
  ].filter((id, index, ids) => typeof id === 'string' && !!id && ids.indexOf(id) === index);
  return { ...previous, ...next, entityIds: mergedIds };
}

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
 * ACR 4.0 A3：运行中 run 追踪（参照 todoDriver/pomodoroDriver 的 activeRuns 模式），
 * 使 abort 回执携带真实 done/undone 前缀（ACR-3.0 §3「cancelled 需已知 applied 前缀」）。
 */
interface QbankActiveRun {
  runId: string;
  ops: AgentOp[];
  aborted: boolean;
  done: string[];
  undone: string[];
  entityIds: string[];
  applied: number;
  totalOps: number;
  nextOpIndex: number;
  remainingMarked: boolean;
}

const qbankActiveRuns = new Map<string, QbankActiveRun>();

function markQbankRemaining(state: QbankActiveRun): void {
  if (state.remainingMarked) return;
  state.remainingMarked = true;
  for (let i = state.nextOpIndex; i < state.totalOps; i++) {
    state.undone.push(state.ops[i]!.label || state.ops[i]!.kind);
  }
  state.nextOpIndex = state.totalOps;
}

function qbankCancelledReceipt(state: QbankActiveRun, message?: string): AcrReceipt {
  markQbankRemaining(state);
  qbankActiveRuns.delete(state.runId);
  return withUserPatch(
    emptyReceipt('cancelled', state.totalOps, {
      applied: state.applied,
      entityIds: [...state.entityIds],
      done: [...state.done],
      undone: [...state.undone],
      ...(message ? { message } : {}),
    }),
    TYPE_ID,
  );
}

/**
 * store 无独立「行内编辑」字段；以题库编辑区内的真实可编辑焦点为准。
 * 不能把 Chat/搜索等其他模块的 input 误判为题库 hot。
 */
export function isQbankInlineEditorActive(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!el || !(el instanceof HTMLElement)) return false;
  const scope = el.closest(
    '[data-question-inline-editor], [data-agent-qbank-editor]',
  );
  if (!scope) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
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

function dispatchFocusEvent(questionId: string): QbankFocusResult | null {
  if (typeof window === 'undefined') return null;
  let result: QbankFocusResult | null = null;
  window.dispatchEvent(
    new CustomEvent<QbankFocusEventDetail>(QBANK_FOCUS_EVENT, {
      detail: {
        questionId,
        acknowledge: (nextResult) => {
          result = nextResult;
        },
      },
    }),
  );
  return result;
}

/**
 * 刷新题目列表并保持 currentQuestionId。
 * loadQuestions 会把 current 重置为第一题，故必须显式恢复。
 * 导出供单测。
 */
export async function refreshQbankPreservingCurrent(
  payload?: DomainChangePayload,
): Promise<void> {
  // R2-04：答题中（答案输入焦点）与行内编辑同一守卫——延迟而非冲掉草稿。
  // 编辑期间可能连续到达多个域事件：合并 entityIds 而不是只保留最后一个，
  // 否则先到事件对应题目的刷新/flash 会被静默丢弃。
  if (isQbankAnsweringOrEditing()) {
    pendingDeferredPayload = mergeDeferredPayloads(pendingDeferredPayload, payload);
    if (deferredRefreshTimer) clearTimeout(deferredRefreshTimer);
    deferredRefreshTimer = setTimeout(() => {
      deferredRefreshTimer = null;
      const merged = pendingDeferredPayload;
      pendingDeferredPayload = null;
      void refreshQbankPreservingCurrent(merged ?? undefined);
    }, 800);
    return;
  }

  const store = useQuestionBankStore.getState();
  const preservedId = store.currentQuestionId;
  try {
    await store.refreshQuestions();
    if (preservedId) {
      const after = useQuestionBankStore.getState();
      // 题目可能已被删除：不存在时不强行恢复，让 store 的默认选中生效
      if (after.questions.has(preservedId)) {
        after.setCurrentQuestion(preservedId);
      }
    }
  } catch (error) {
    // refreshQuestions 失败不能吞成 unhandled rejection；
    // 仍然广播刷新事件，让 ExamContentView 等本地持有题目的视图自行重试。
    console.warn('[qbankDriver] refreshQuestions failed after domain change:', error);
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

export const qbankDriver: CollabDriver & {
  queryState: () => Record<string, unknown>;
} = {
  typeId: TYPE_ID,

  queryState() {
    const state = useQuestionBankStore.getState();
    const current = state.currentQuestionId
      ? state.questions.get(state.currentQuestionId)
      : undefined;
    return {
      examId: state.currentExamId,
      currentQuestionId: state.currentQuestionId,
      questionCount: state.questionOrder.length,
      currentQuestionStatus: current?.status ?? null,
      currentQuestionType: current?.question_type ?? null,
      currentQuestionFavorite: current?.is_favorite ?? false,
      practiceMode: state.practiceMode,
      focusMode: state.focusMode,
      filters: state.filters,
      loading: state.isLoading,
      submitting: state.isSubmitting,
      error: state.error,
    };
  },

  probe(_target: AcrTarget): AcrProbeState {
    return isQbankAnsweringOrEditing() ? 'hot' : 'clean';
  },

  async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
    const totalOps = ops.length;
    const state: QbankActiveRun = {
      runId: run.runId,
      ops,
      aborted: false,
      done: [],
      undone: [],
      entityIds: [],
      applied: 0,
      totalOps,
      nextOpIndex: 0,
      remainingMarked: false,
    };
    qbankActiveRuns.set(run.runId, state);

    for (let i = 0; i < ops.length; i++) {
      state.nextOpIndex = i;
      const pause = state.aborted ? 'abort' : await run.checkPaused();
      if (pause === 'abort') {
        state.aborted = true;
        return qbankCancelledReceipt(state);
      }

      const op = ops[i]!;
      run.reportProgress(i + 1, totalOps, op.label || op.kind);

      if (op.kind === 'qbank_focus_question' || op.kind === 'focus_question') {
        const questionId = parseQuestionId(op);
        if (!questionId) {
          state.undone.push(op.label || op.kind);
        } else {
          const store = useQuestionBankStore.getState();
          const focusResult = dispatchFocusEvent(questionId);
          if (!focusResult?.handled) {
            state.undone.push(
              i18n.t('exam_sheet:agent.question_not_visible', {
                label: op.label || op.kind,
                defaultValue: '{{label}}（可见题库未找到该题）',
              }),
            );
            state.nextOpIndex = i + 1;
            await run.pacing.tick(listTickCost(run.pacing.profile));
            continue;
          }
          const previousQuestionId = focusResult.previousQuestionId;
          store.setCurrentQuestion(questionId);
          agentFlash(TYPE_ID, questionId);
          state.entityIds.push(questionId);
          state.done.push(
            op.label ||
              i18n.t('exam_sheet:agent.focus_question_done', {
                questionId,
                defaultValue: '聚焦题目 {{questionId}}',
              }),
          );
          state.applied += 1;
          // 没有前选中项时，记录一个只恢复 store 却无法恢复视图的 inverse 会让撤销撒谎。
          if (previousQuestionId && previousQuestionId !== questionId) {
            run.ledger.record(
              run.runId,
              () => {
                const reverted = dispatchFocusEvent(previousQuestionId);
                if (!reverted?.handled) {
                  throw new Error(
                    i18n.t('exam_sheet:agent.undo_question_missing', {
                      questionId: previousQuestionId,
                      defaultValue: '无法恢复已不存在的题目 {{questionId}}',
                    }),
                  );
                }
                useQuestionBankStore.getState().setCurrentQuestion(previousQuestionId);
              },
              op.label || op.kind,
            );
          }
        }
      } else {
        state.undone.push(op.label || op.kind);
      }
      state.nextOpIndex = i + 1;

      await run.pacing.tick(listTickCost(run.pacing.profile));
    }

    if (state.aborted) return qbankCancelledReceipt(state);
    qbankActiveRuns.delete(run.runId);

    const status: AcrReceipt['status'] =
      state.applied === totalOps && state.undone.length === 0
        ? 'completed'
        : state.applied > 0
          ? 'partial'
          : totalOps === 0
            ? 'completed'
            : 'failed';

    return {
      status,
      mode: 'frontend',
      applied: state.applied,
      totalOps,
      entityIds: state.entityIds,
      done: state.done,
      undone: state.undone,
      message:
        status === 'failed'
          ? i18n.t('exam_sheet:agent.unsupported_hint', {
              defaultValue:
                'qbank driver 仅支持导航 op（qbank_focus_question）；数据修改请用领域工具',
            })
          : undefined,
    };
  },

  abort(runId: string): AcrReceipt {
    const state = qbankActiveRuns.get(runId);
    if (state) {
      state.aborted = true;
      return qbankCancelledReceipt(
        state,
        i18n.t('exam_sheet:agent.nav_aborted', { defaultValue: 'qbank 导航已中止' }),
      );
    }
    return withUserPatch(
      emptyReceipt('cancelled', 0, {
        message: i18n.t('exam_sheet:agent.run_not_found', {
          runId,
          defaultValue: 'run {{runId}} aborted',
        }),
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
  pendingDeferredPayload = null;
}
