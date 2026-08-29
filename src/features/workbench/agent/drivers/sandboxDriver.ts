/**
 * ACR sandbox Driver
 *
 * ACR 4.0（A6）：
 * - setMode 诚实化：渲染面固定 chat-safe 安全预览（HtmlSandboxPreview 两种 mode
 *   均剥离用户脚本，不存在真实 sandbox-run 形态），`sandbox_set_mode` 一律进
 *   undone 并带明确 message；queryState 的 mode 报告真实渲染形态。
 * - abort 运行追踪：参照 finderDriver 的 activeRuns 表，abort 返回真实 applied
 *   前缀（done/undone 为当刻已知状态），不再返回空回执。
 */
import i18n from '@/i18n';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import type { SandboxViewportPreset } from '@/features/sandbox/types';
import type {
  AcrReceipt,
  AcrRunContext,
  AgentOp,
  CollabDriver,
  StageManagerApi,
} from '../types';

const TYPE_ID = 'sandbox';
const VIEWPORTS = new Set<SandboxViewportPreset>(['desktop', 'tablet', 'mobile']);

export const SET_MODE_UNSUPPORTED =
  'Sandbox 渲染面固定为安全预览（safe-preview），不存在可切换的运行模式；能力已从清单撤除';

interface ActiveRun {
  runId: string;
  ops: AgentOp[];
  aborted: boolean;
  done: string[];
  undone: string[];
  applied: number;
  totalOps: number;
  nextOpIndex: number;
  errorMessage?: string;
}

const activeRuns = new Map<string, ActiveRun>();

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function markRemaining(state: ActiveRun): void {
  for (let i = state.nextOpIndex; i < state.totalOps; i++) {
    state.undone.push(state.ops[i]!.label || state.ops[i]!.kind);
  }
  state.nextOpIndex = state.totalOps;
}

function buildReceipt(state: ActiveRun, status: AcrReceipt['status'], message?: string): AcrReceipt {
  return {
    status,
    mode: 'frontend',
    applied: state.applied,
    totalOps: state.totalOps,
    entityIds: [],
    done: [...state.done],
    undone: [...state.undone],
    ...(message ? { message } : {}),
  };
}

export const sandboxDriver: CollabDriver & {
  queryState: () => Record<string, unknown>;
} = {
  typeId: TYPE_ID,

  queryState() {
    const state = selectSandboxWorkbenchOwnerState(
      useSandboxWorkbenchStore.getState(),
      LEGACY_SANDBOX_OWNER_KEY,
    );
    return {
      sessionId: state.activeSession?.id ?? null,
      title: state.activeSession?.title ?? null,
      // 真实渲染形态：SandboxWorkbenchSurface 固定以 chat-safe 安全预览渲染
      mode: state.activeSession ? 'safe-preview' : null,
      viewportPreset: state.viewportPreset,
      inspectorOpen: state.inspectorOpen,
      open: state.isOpen,
    };
  },

  probe() {
    return 'clean';
  },

  async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
    const state: ActiveRun = {
      runId: run.runId,
      ops,
      aborted: false,
      done: [],
      undone: [],
      applied: 0,
      totalOps: ops.length,
      nextOpIndex: 0,
    };
    activeRuns.set(run.runId, state);

    for (let index = 0; index < ops.length; index++) {
      // 先查 aborted 再推进 nextOpIndex：abort() 可能已把 nextOpIndex 收敛到
      // totalOps 并计入 undone，这里回退会导致剩余 op 重复计数。
      if (state.aborted) {
        markRemaining(state);
        break;
      }
      state.nextOpIndex = index;

      let pause: 'resume' | 'abort';
      try {
        pause = await run.checkPaused();
      } catch (err) {
        state.aborted = true;
        state.errorMessage = i18n.t('console:agent.pause_check_failed', {
          error: err instanceof Error ? err.message : String(err),
          defaultValue: '暂停检查失败：{{error}}',
        });
        markRemaining(state);
        break;
      }
      if (pause === 'abort' || state.aborted) {
        state.aborted = true;
        markRemaining(state);
        break;
      }

      const op = ops[index]!;
      const label = op.label || op.kind;
      const payload = payloadRecord(op.payload);
      const store = useSandboxWorkbenchStore.getState();
      const before = selectSandboxWorkbenchOwnerState(store, LEGACY_SANDBOX_OWNER_KEY);
      run.reportProgress(index + 1, ops.length, label);

      if (op.kind === 'sandbox_refresh') {
        if (!before.activeSession) {
          state.undone.push(
            i18n.t('console:agent.no_active_session', {
              label,
              defaultValue: '{{label}}（无活动会话）',
            }),
          );
        } else {
          store.refreshSession(LEGACY_SANDBOX_OWNER_KEY);
          state.done.push(label);
          state.applied += 1;
        }
      } else if (op.kind === 'sandbox_set_viewport') {
        const viewport = payload.viewport as SandboxViewportPreset;
        if (!VIEWPORTS.has(viewport)) {
          state.undone.push(
            i18n.t('console:agent.viewport_invalid', {
              label,
              defaultValue: '{{label}}（viewport 无效）',
            }),
          );
        } else {
          store.setViewportPreset(viewport, LEGACY_SANDBOX_OWNER_KEY);
          run.ledger.record(
            run.runId,
            () => useSandboxWorkbenchStore.getState().setViewportPreset(
              before.viewportPreset,
              LEGACY_SANDBOX_OWNER_KEY,
            ),
            label,
          );
          state.done.push(label);
          state.applied += 1;
        }
      } else if (op.kind === 'sandbox_set_inspector') {
        if (typeof payload.open !== 'boolean') {
          state.undone.push(
            i18n.t('console:agent.open_invalid', {
              label,
              defaultValue: '{{label}}（open 无效）',
            }),
          );
        } else {
          store.setInspectorOpen(payload.open, LEGACY_SANDBOX_OWNER_KEY);
          run.ledger.record(
            run.runId,
            () => useSandboxWorkbenchStore.getState().setInspectorOpen(
              before.inspectorOpen,
              LEGACY_SANDBOX_OWNER_KEY,
            ),
            label,
          );
          state.done.push(label);
          state.applied += 1;
        }
      } else if (op.kind === 'sandbox_set_mode') {
        // 诚实回执：不改 store、不记 inverse、不按 store 判成功
        const reason = i18n.t('console:agent.set_mode_unsupported', {
          defaultValue: SET_MODE_UNSUPPORTED,
        });
        state.undone.push(
          i18n.t('console:agent.set_mode_undone', {
            label,
            reason,
            defaultValue: '{{label}} — {{reason}}',
          }),
        );
        state.errorMessage ??= reason;
      } else {
        state.undone.push(
          i18n.t('console:agent.unsupported_op', {
            label,
            defaultValue: '{{label}}（不支持的 sandbox op）',
          }),
        );
      }

      state.nextOpIndex = index + 1;
      try {
        await run.pacing.tick();
      } catch (err) {
        state.aborted = true;
        state.errorMessage = i18n.t('console:agent.pacing_failed', {
          error: err instanceof Error ? err.message : String(err),
          defaultValue: '节奏控制失败：{{error}}',
        });
        markRemaining(state);
        break;
      }
    }

    if (activeRuns.get(run.runId) === state) activeRuns.delete(run.runId);

    const status = state.aborted
      ? 'cancelled'
      : state.undone.length === 0
        ? 'completed'
        : state.applied > 0
          ? 'partial'
          : 'failed';
    return buildReceipt(state, status, state.errorMessage);
  },

  abort(runId: string): AcrReceipt {
    const state = activeRuns.get(runId);
    if (state) {
      state.aborted = true;
      markRemaining(state);
      return buildReceipt(
        state,
        'cancelled',
        i18n.t('console:agent.op_aborted', { defaultValue: 'sandbox 操作已中止' }),
      );
    }
    return {
      status: 'cancelled',
      mode: 'frontend',
      applied: 0,
      totalOps: 0,
      entityIds: [],
      done: [],
      undone: [i18n.t('console:agent.run_ended', { defaultValue: 'run 已结束' })],
      message: i18n.t('console:agent.run_not_found', {
        defaultValue: 'sandbox run 不存在或已结束',
      }),
    };
  },
};

export function registerSandboxDriver(stage: StageManagerApi): void {
  stage.registerDriver(sandboxDriver);
}
