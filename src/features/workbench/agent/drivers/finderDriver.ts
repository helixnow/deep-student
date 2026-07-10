/**
 * ACR finder(files) Driver — R1-14
 *
 * 数据面走后端 DSTU / 资源工具；probe 恒 clean。
 * apply 支持 openFolder 导航备用；域事件 dstu:change 对 agent 来源 flash 资源行。
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

const TYPE_ID = 'files';

const UNSUPPORTED_HINT =
  '请用资源/DSTU 领域工具修改文件数据；本驱动仅支持导航类 op（openFolder）';

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

function payloadFolderId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const folderId =
    (payload as { folderId?: unknown }).folderId ??
    (payload as { id?: unknown }).id;
  return typeof folderId === 'string' && folderId.trim() ? folderId.trim() : null;
}

function isOpenFolderOp(op: AgentOp): boolean {
  return (
    op.kind === 'openFolder' ||
    op.kind === 'open_folder' ||
    op.kind === 'finder_open_folder'
  );
}

function isAgentSource(payload: DomainChangePayload): boolean {
  const src = payload.source as string | undefined;
  if (src === 'agent' || src === 'ai') return true;
  return typeof payload.runId === 'string' && payload.runId.length > 0;
}

/** R2-04：经 domainEvents 统一收集，path/node/entity_ids 与 DOM files:{id} 对齐 */
function collectEntityIds(payload: DomainChangePayload): string[] {
  return collectDomainEntityIds(payload);
}

async function applyOpenFolder(folderId: string): Promise<void> {
  const { useFinderStore } = await import(
    '@/features/learning-hub/stores/finderStore'
  );
  await useFinderStore.getState().enterFolder(folderId);
}

export const finderDriver: CollabDriver = {
  typeId: TYPE_ID,

  probe(_target: AcrTarget): AcrProbeState {
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

      if (isOpenFolderOp(op)) {
        const folderId = payloadFolderId(op.payload);
        if (!folderId) {
          state.undone.push(`${op.label || op.kind}（缺少 folderId）`);
        } else {
          try {
            await applyOpenFolder(folderId);
            state.done.push(op.label || `打开文件夹 ${folderId}`);
            state.entityIds.push(folderId);
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
            : state.undone.some((u) => u.includes('DSTU'))
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
          message: 'files 导航已中止',
        }),
        TYPE_ID,
      );
    }
    return withUserPatch(
      emptyReceipt({
        status: 'cancelled',
        message: 'files run 不存在或已结束',
        undone: ['run 已结束'],
      }),
      TYPE_ID,
    );
  },
};

/**
 * 注册 finder driver + dstu:change：agent 来源变更 flash 对应资源行。
 */
let domainUnlisten: (() => void) | null = null;

export function registerFinderDriver(stage: StageManagerApi): () => void {
  stage.registerDriver(finderDriver);

  domainUnlisten?.();
  const unlisten = registerDomainListener('dstu:change', (payload) => {
    if (!isAgentSource(payload)) return;
    const ids = collectEntityIds(payload);
    if (!ids.length) return;

    // 等列表行渲染后再 flash（R3-02：批量仅末项 scroll）
    const flash = () => {
      agentFlashMany(TYPE_ID, ids);
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        requestAnimationFrame(flash);
      });
    } else {
      flash();
    }
  });
  domainUnlisten = unlisten;

  return () => {
    if (domainUnlisten !== unlisten) return;
    domainUnlisten = null;
    unlisten();
  };
}
