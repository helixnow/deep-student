/**
 * ACR todo Driver — R1-14
 *
 * 数据面走后端 user_todo 工具；本驱动 probe 恒 clean，apply 仅导航类 op。
 * 域事件 todo://changed（agent/ai + entityIds）→ reload 后 flash + selectItem。
 * 见 docs/dev/acr/DESIGN.md §5.3。
 */

import i18n from '@/i18n';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';
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
import { collectDomainEntityIds, registerDomainListener } from '../domainEvents';
import { listTickCost } from '../pacing';
import { withUserPatch } from '../userPatch';
import { agentFlashMany } from '../visuals/agentFlash';

const TYPE_ID = 'todo';

// 用户/agent 可见文案统一走 i18n（todo:agent.*）；defaultValue 兜底
// todo namespace 尚未完成异步加载的窗口期。语言可运行时切换，故用函数而非模块级常量。
function unsupportedHint(): string {
  return i18n.t('todo:agent.unsupported_hint', {
    defaultValue:
      '请用 user_todo 领域工具修改待办数据；本驱动仅支持导航类 op（todo_show_list）',
  });
}

interface ActiveRun {
  runId: string;
  ops: AgentOp[];
  aborted: boolean;
  done: string[];
  undone: string[];
  entityIds: string[];
  applied: number;
  totalOps: number;
  nextOpIndex: number;
  /** 出现过非导航 op（message 文案已本地化，不能再靠字符串嗅探回执内容判断） */
  sawUnsupported: boolean;
  inversesCommitted: boolean;
  pendingInverses: Array<{ invert: () => Promise<void>; label: string }>;
  ledger: AcrRunContext['ledger'];
  errorMessage?: string;
}

const activeRuns = new Map<string, ActiveRun>();

function emptyReceipt(
  partial: Partial<AcrReceipt> & Pick<AcrReceipt, 'status'>,
): AcrReceipt {
  return {
    mode: 'frontend',
    applied: 0,
    totalOps: 0,
    entityIds: [],
    done: [],
    undone: [],
    ...partial,
  };
}

function payloadListId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const listId = (payload as { listId?: unknown }).listId;
  return typeof listId === 'string' && listId.trim() ? listId.trim() : null;
}

function isNavShowList(op: AgentOp): boolean {
  return (
    op.kind === 'todo_show_list' ||
    op.kind === 'show_list' ||
    op.kind === 'showList'
  );
}

function isAgentSource(payload: DomainChangePayload): boolean {
  const src = payload.source as string;
  return src === 'agent' || src === 'ai';
}

async function applyShowList(listId: string): Promise<void> {
  const { useTodoStore } = await import('@/features/todo/stores/useTodoStore');
  const store = useTodoStore.getState();
  store.setActiveList(listId);
  if (typeof store.reloadCurrentView === 'function') {
    await store.reloadCurrentView();
  }
  const after = useTodoStore.getState();
  if ('activeListId' in after && after.activeListId !== listId) {
    throw new Error(
      i18n.t('todo:agent.list_not_activated', { defaultValue: '目标清单未激活' }),
    );
  }
  if ('error' in after && after.error) {
    throw new Error(after.error);
  }
}

async function restoreList(listId: string | null): Promise<void> {
  const { useTodoStore } = await import('@/features/todo/stores/useTodoStore');
  const store = useTodoStore.getState();
  store.setActiveList(listId);
  if (typeof store.reloadCurrentView === 'function') await store.reloadCurrentView();
  const after = useTodoStore.getState();
  if ('activeListId' in after && after.activeListId !== listId) {
    throw new Error(
      i18n.t('todo:agent.undo_list_not_restored', {
        defaultValue: '撤销失败：原清单未恢复',
      }),
    );
  }
  if ('error' in after && after.error) {
    throw new Error(
      i18n.t('todo:agent.undo_failed', {
        error: after.error,
        defaultValue: '撤销失败：{{error}}',
      }),
    );
  }
}

function isTodoDetailFocused(): boolean {
  if (typeof document === 'undefined' || typeof Element === 'undefined') return false;
  const el = document.activeElement;
  return Boolean(el instanceof Element && el.closest('[data-todo-detail-panel]'));
}

function commitInverses(state: ActiveRun): void {
  if (state.inversesCommitted) return;
  for (const entry of state.pendingInverses) {
    state.ledger.record(state.runId, entry.invert, entry.label);
  }
  state.inversesCommitted = true;
}

function markRemaining(state: ActiveRun): void {
  for (let i = state.nextOpIndex; i < state.totalOps; i++) {
    state.undone.push(state.ops[i].label || state.ops[i].kind);
  }
  state.nextOpIndex = state.totalOps;
}

export const todoDriver: CollabDriver & {
  queryState: () => Record<string, unknown>;
} = {
  typeId: TYPE_ID,

  queryState() {
    const state = useTodoStore.getState();
    return {
      activeListId: state.activeListId,
      selectedItemId: state.selectedItemId,
      itemCount: state.items.length,
      listCount: state.lists.length,
      overdueCount: state.overdueCount,
      filter: state.filter,
      loading: state.isLoadingLists || state.isLoadingItems,
      error: state.error,
    };
  },

  probe(_target: AcrTarget): AcrProbeState {
    return isTodoDetailFocused() ? 'hot' : 'clean';
  },

  async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
    const state: ActiveRun = {
      runId: run.runId,
      ops,
      aborted: false,
      done: [],
      undone: [],
      entityIds: [],
      applied: 0,
      totalOps: ops.length,
      nextOpIndex: 0,
      sawUnsupported: false,
      inversesCommitted: false,
      pendingInverses: [],
      ledger: run.ledger,
    };
    activeRuns.set(run.runId, state);

    for (let i = 0; i < ops.length; i++) {
      state.nextOpIndex = i;
      if (state.aborted) {
        markRemaining(state);
        break;
      }

      let pause: 'resume' | 'abort';
      try {
        pause = await run.checkPaused();
      } catch (err) {
        state.aborted = true;
        state.errorMessage = i18n.t('todo:agent.pause_check_failed', {
          error: err instanceof Error ? err.message : String(err),
          defaultValue: '暂停检查失败：{{error}}',
        });
        markRemaining(state);
        break;
      }
      if (pause === 'abort') {
        state.aborted = true;
        markRemaining(state);
        break;
      }

      const op = ops[i];
      run.reportProgress(i + 1, ops.length, op.label || op.kind);

      if (isNavShowList(op)) {
        const listId = payloadListId(op.payload);
        if (!listId) {
          state.undone.push(
            i18n.t('todo:agent.op_missing_list_id', {
              label: op.label || op.kind,
              defaultValue: '{{label}}（缺少 listId）',
            }),
          );
        } else {
          try {
            const { useTodoStore } = await import(
              '@/features/todo/stores/useTodoStore'
            );
            const previousListId = useTodoStore.getState().activeListId;
            await applyShowList(listId);
            state.done.push(op.label || `切换清单 ${listId}`);
            state.entityIds.push(listId);
            state.applied += 1;
            if (previousListId !== listId) {
              state.pendingInverses.push({
                invert: () => restoreList(previousListId),
                label: op.label || `切换清单 ${listId}`,
              });
            }
            // 当前副作用已经完成；此后中止只能把后续 op 标为 undone。
            state.nextOpIndex = i + 1;
            try {
              await run.pacing.tick(listTickCost(run.pacing.profile));
            } catch (err) {
              state.aborted = true;
              state.errorMessage = i18n.t('todo:agent.pacing_failed', {
                error: err instanceof Error ? err.message : String(err),
                defaultValue: '节奏控制失败：{{error}}',
              });
              markRemaining(state);
              break;
            }
          } catch (err) {
            state.undone.push(
              i18n.t('todo:agent.op_failed', {
                label: op.label || op.kind,
                error: err instanceof Error ? err.message : String(err),
                defaultValue: '{{label}}（失败: {{error}}）',
              }),
            );
          }
        }
      } else {
        state.sawUnsupported = true;
        state.undone.push(`${op.label || op.kind} — ${unsupportedHint()}`);
      }
      state.nextOpIndex = i + 1;
    }

    if (activeRuns.get(run.runId) === state) activeRuns.delete(run.runId);
    commitInverses(state);

    const status = state.aborted
      ? 'cancelled'
      : state.undone.length === 0
        ? 'completed'
        : state.applied > 0
          ? 'partial'
          : 'failed';

    return withUserPatch(
      emptyReceipt({
        status,
        applied: state.applied,
        totalOps: state.totalOps,
        entityIds: state.entityIds,
        done: state.done,
        undone: state.undone,
        message:
          state.errorMessage ?? (state.undone.length > 0 && state.applied === 0
            ? unsupportedHint()
            : state.sawUnsupported
              ? unsupportedHint()
              : undefined),
      }),
      TYPE_ID,
    );
  },

  abort(runId: string): AcrReceipt {
    const state = activeRuns.get(runId);
    if (state) {
      state.aborted = true;
      markRemaining(state);
      commitInverses(state);
      return withUserPatch(
        emptyReceipt({
          status: 'cancelled',
          applied: state.applied,
          totalOps: state.totalOps,
          entityIds: state.entityIds,
          done: [...state.done],
          undone: [...state.undone],
          message: i18n.t('todo:agent.nav_aborted', {
            defaultValue: 'todo 导航已中止',
          }),
        }),
        TYPE_ID,
      );
    }
    return withUserPatch(
      emptyReceipt({
        status: 'cancelled',
        message: i18n.t('todo:agent.run_not_found', {
          defaultValue: 'todo run 不存在或已结束',
        }),
        undone: [i18n.t('todo:agent.run_ended', { defaultValue: 'run 已结束' })],
      }),
      TYPE_ID,
    );
  },
};

/**
 * 注册 todo driver + 域事件：agent/ai 写库后 flash 并选中首个 entity。
 *
 * ACR 4.0 A3：详情面板长时间保持焦点时**不再强行 reload**（旧行为 25×400ms
 * 等待后强刷会冲掉本地草稿）——改为记录待刷新 entityIds，等下次 blur
 * （focusout 离开详情面板）或下次域事件再刷。
 */
let domainUnlisten: (() => void) | null = null;

/** 详情面板占焦超时后挂起的待刷新实体（与 blur 监听一起构成延迟重试） */
let pendingRefreshEntityIds: string[] | null = null;
let pendingBlurCleanup: (() => void) | null = null;

const BLUR_WAIT_ATTEMPTS = 25;
const BLUR_WAIT_INTERVAL_MS = 400;

async function reloadAndFlashTodo(entityIds: string[]): Promise<void> {
  const { useTodoStore } = await import('@/features/todo/stores/useTodoStore');
  const store = useTodoStore.getState();
  await store.loadLists();
  await store.reloadCurrentView();
  // 等一帧让列表行挂上 data-agent-entity
  await new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => resolve());
    } else {
      resolve();
    }
  });
  // R3-02：批量 flash 只滚一次，避免 50 条 smooth 争抢主线程。
  // 演出优化轮：滚动目标与 selectItem 同为首项——旧行为滚末项、选首项，
  // 视口落点与详情面板显示的条目不一致（滚动指令互相拉扯）。
  agentFlashMany(TYPE_ID, entityIds, { scroll: 'first' });
  store.selectItem(entityIds[0]);
}

function clearPendingBlurListener(): void {
  pendingBlurCleanup?.();
  pendingBlurCleanup = null;
}

/** 取出并清空挂起的待刷新实体（含 blur 监听清理） */
function takePendingRefreshEntityIds(): string[] {
  const ids = pendingRefreshEntityIds ?? [];
  pendingRefreshEntityIds = null;
  clearPendingBlurListener();
  return ids;
}

/**
 * 详情面板仍占焦：记录待刷新实体并挂一次性 blur 监听。
 * 焦点真正离开详情面板后再执行 reload + flash；期间新事件会合并 entityIds。
 */
function deferTodoRefresh(entityIds: string[]): void {
  const merged = pendingRefreshEntityIds ?? [];
  for (const id of entityIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  pendingRefreshEntityIds = merged;
  if (pendingBlurCleanup || typeof document === 'undefined') return;

  const onFocusOut = () => {
    // focusout 时 activeElement 尚未落定，让出一拍再判定
    setTimeout(() => {
      if (isTodoDetailFocused()) return;
      const ids = takePendingRefreshEntityIds();
      if (!ids.length) return;
      void reloadAndFlashTodo(ids).catch((err) => {
        console.warn('[acr:todoDriver] deferred domain flash failed:', err);
      });
    }, 0);
  };
  document.addEventListener('focusout', onFocusOut, true);
  pendingBlurCleanup = () => {
    document.removeEventListener('focusout', onFocusOut, true);
  };
}

/** 处理 todo://changed（导出供单测直接调用） */
export function handleTodoDomainChange(payload: DomainChangePayload): void {
  if (!isAgentSource(payload)) return;
  // R2-04：normalize 已统一 entityIds；此处再经 collect 兜底 snake_case
  const entityIds = collectDomainEntityIds(payload);
  if (!entityIds.length) return;

  void (async () => {
    try {
      // 新域事件到达即接管挂起的延迟重试，合并其 entityIds 一起刷
      const pending = takePendingRefreshEntityIds();
      const mergedIds = [...entityIds];
      for (const id of pending) {
        if (!mergedIds.includes(id)) mergedIds.push(id);
      }
      // 与 TodoContentView 守卫对齐：详情面板聚焦时等 blur 再 reload，避免冲掉本地草稿
      let attempts = 0;
      while (isTodoDetailFocused() && attempts < BLUR_WAIT_ATTEMPTS) {
        attempts += 1;
        await new Promise((r) => setTimeout(r, BLUR_WAIT_INTERVAL_MS));
      }
      if (isTodoDetailFocused()) {
        // 超时仍占焦：跳过本次 reload，记录延迟重试（下次 blur 或下次域事件再刷）
        deferTodoRefresh(mergedIds);
        console.warn(
          '[acr:todoDriver] detail panel still focused, reload deferred until blur',
        );
        return;
      }
      await reloadAndFlashTodo(mergedIds);
    } catch (err) {
      console.warn('[acr:todoDriver] domain flash failed:', err);
    }
  })();
}

/** 仅供测试：清空延迟重试状态与 blur 监听 */
export function __resetTodoDriverForTests(): void {
  pendingRefreshEntityIds = null;
  clearPendingBlurListener();
}

export function registerTodoDriver(stage: StageManagerApi): () => void {
  stage.registerDriver(todoDriver);

  domainUnlisten?.();
  const unlisten = registerDomainListener('todo://changed', handleTodoDomainChange);
  domainUnlisten = unlisten;

  return () => {
    if (domainUnlisten !== unlisten) return;
    domainUnlisten = null;
    unlisten();
    __resetTodoDriverForTests();
  };
}
