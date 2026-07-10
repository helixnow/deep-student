/**
 * ACR todo Driver — R1-14
 *
 * 数据面走后端 user_todo 工具；本驱动 probe 恒 clean，apply 仅导航类 op。
 * 域事件 todo://changed（agent/ai + entityIds）→ reload 后 flash + selectItem。
 * 见 docs/dev/acr/DESIGN.md §5.3。
 */

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

const UNSUPPORTED_HINT =
  '请用 user_todo 领域工具修改待办数据；本驱动仅支持导航类 op（todo_show_list）';

interface ActiveRun {
  aborted: boolean;
  done: string[];
  undone: string[];
  entityIds: string[];
  applied: number;
  totalOps: number;
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
  useTodoStore.getState().setActiveList(listId);
}

export const todoDriver: CollabDriver = {
  typeId: TYPE_ID,

  probe(_target: AcrTarget): AcrProbeState {
    // 数据面在后端；开窗脏态不由本驱动判定
    return 'clean';
  },

  async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
    const state: ActiveRun = {
      aborted: false,
      done: [],
      undone: [],
      entityIds: [],
      applied: 0,
      totalOps: ops.length,
    };
    activeRuns.set(run.runId, state);

    for (let i = 0; i < ops.length; i++) {
      if (state.aborted) {
        for (let j = i; j < ops.length; j++) {
          state.undone.push(ops[j].label || ops[j].kind);
        }
        break;
      }

      const pause = await run.checkPaused();
      if (pause === 'abort') {
        state.aborted = true;
        for (let j = i; j < ops.length; j++) {
          state.undone.push(ops[j].label || ops[j].kind);
        }
        break;
      }

      const op = ops[i];
      run.reportProgress(i + 1, ops.length, op.label || op.kind);

      if (isNavShowList(op)) {
        const listId = payloadListId(op.payload);
        if (!listId) {
          state.undone.push(`${op.label || op.kind}（缺少 listId）`);
        } else {
          try {
            await applyShowList(listId);
            state.done.push(op.label || `切换清单 ${listId}`);
            state.entityIds.push(listId);
            state.applied += 1;
            await run.pacing.tick(listTickCost(run.pacing.profile));
          } catch (err) {
            state.undone.push(
              `${op.label || op.kind}（失败: ${err instanceof Error ? err.message : String(err)}）`,
            );
          }
        }
      } else {
        state.undone.push(`${op.label || op.kind} — ${UNSUPPORTED_HINT}`);
      }
    }

    activeRuns.delete(run.runId);

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
          state.undone.length > 0 && state.applied === 0
            ? UNSUPPORTED_HINT
            : state.undone.some((u) => u.includes('user_todo'))
              ? UNSUPPORTED_HINT
              : undefined,
      }),
      TYPE_ID,
    );
  },

  abort(runId: string): AcrReceipt {
    const state = activeRuns.get(runId);
    if (state) {
      state.aborted = true;
      return withUserPatch(
        emptyReceipt({
          status: 'cancelled',
          applied: state.applied,
          totalOps: state.totalOps,
          entityIds: state.entityIds,
          done: [...state.done],
          undone: [...state.undone, '（已中止）'],
          message: 'todo 导航已中止',
        }),
        TYPE_ID,
      );
    }
    return withUserPatch(
      emptyReceipt({
        status: 'cancelled',
        message: 'todo run 不存在或已结束',
        undone: ['run 已结束'],
      }),
      TYPE_ID,
    );
  },
};

/**
 * 注册 todo driver + 域事件：agent/ai 写库后 flash 并选中首个 entity。
 */
let domainUnlisten: (() => void) | null = null;

export function registerTodoDriver(stage: StageManagerApi): () => void {
  stage.registerDriver(todoDriver);

  domainUnlisten?.();
  const unlisten = registerDomainListener('todo://changed', (payload) => {
    if (!isAgentSource(payload)) return;
    // R2-04：normalize 已统一 entityIds；此处再经 collect 兜底 snake_case
    const entityIds = collectDomainEntityIds(payload);
    if (!entityIds.length) return;

    void (async () => {
      try {
        const { useTodoStore } = await import(
          '@/features/todo/stores/useTodoStore'
        );
        const store = useTodoStore.getState();
        // 与 TodoContentView 守卫对齐：详情面板聚焦时等 blur 再 reload，避免冲掉本地草稿
        const detailFocused = () => {
          if (typeof document === 'undefined') return false;
          const el = document.activeElement;
          return Boolean(
            el instanceof Element && el.closest('[data-todo-detail-panel]'),
          );
        };
        let attempts = 0;
        while (detailFocused() && attempts < 25) {
          attempts += 1;
          await new Promise((r) => setTimeout(r, 400));
        }
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
        // R3-02：批量 flash 仅末项 scroll，避免 50 条 smooth 争抢主线程
        agentFlashMany(TYPE_ID, entityIds);
        store.selectItem(entityIds[0]);
      } catch (err) {
        console.warn('[acr:todoDriver] domain flash failed:', err);
      }
    })();
  });
  domainUnlisten = unlisten;

  return () => {
    if (domainUnlisten !== unlisten) return;
    domainUnlisten = null;
    unlisten();
  };
}
