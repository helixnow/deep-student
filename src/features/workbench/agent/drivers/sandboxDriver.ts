import {
  LEGACY_SANDBOX_OWNER_KEY,
  selectSandboxWorkbenchOwnerState,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import type { SandboxViewportPreset, SandboxWorkbenchMode } from '@/features/sandbox/types';
import type {
  AcrReceipt,
  AcrRunContext,
  AgentOp,
  CollabDriver,
  StageManagerApi,
} from '../types';

const TYPE_ID = 'sandbox';
const VIEWPORTS = new Set<SandboxViewportPreset>(['desktop', 'tablet', 'mobile']);
const MODES = new Set<SandboxWorkbenchMode>(['safe-preview', 'sandbox-run']);

function payloadRecord(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
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
      mode: state.activeSession?.mode ?? null,
      viewportPreset: state.viewportPreset,
      inspectorOpen: state.inspectorOpen,
      open: state.isOpen,
    };
  },

  probe() {
    return 'clean';
  },

  async apply(run: AcrRunContext, ops: AgentOp[]): Promise<AcrReceipt> {
    const done: string[] = [];
    const undone: string[] = [];
    let applied = 0;

    for (let index = 0; index < ops.length; index++) {
      if (await run.checkPaused() === 'abort') {
        return {
          status: 'cancelled',
          mode: 'frontend',
          applied,
          totalOps: ops.length,
          entityIds: [],
          done,
          undone: [...undone, ...ops.slice(index).map((op) => op.label || op.kind)],
        };
      }
      const op = ops[index]!;
      const label = op.label || op.kind;
      const payload = payloadRecord(op.payload);
      const store = useSandboxWorkbenchStore.getState();
      const before = selectSandboxWorkbenchOwnerState(store, LEGACY_SANDBOX_OWNER_KEY);
      run.reportProgress(index + 1, ops.length, label);

      if (op.kind === 'sandbox_refresh') {
        if (!before.activeSession) undone.push(`${label}（无活动会话）`);
        else {
          store.refreshSession(LEGACY_SANDBOX_OWNER_KEY);
          done.push(label);
          applied += 1;
        }
      } else if (op.kind === 'sandbox_set_viewport') {
        const viewport = payload.viewport as SandboxViewportPreset;
        if (!VIEWPORTS.has(viewport)) undone.push(`${label}（viewport 无效）`);
        else {
          store.setViewportPreset(viewport, LEGACY_SANDBOX_OWNER_KEY);
          run.ledger.record(
            run.runId,
            () => useSandboxWorkbenchStore.getState().setViewportPreset(
              before.viewportPreset,
              LEGACY_SANDBOX_OWNER_KEY,
            ),
            label,
          );
          done.push(label);
          applied += 1;
        }
      } else if (op.kind === 'sandbox_set_inspector') {
        if (typeof payload.open !== 'boolean') undone.push(`${label}（open 无效）`);
        else {
          store.setInspectorOpen(payload.open, LEGACY_SANDBOX_OWNER_KEY);
          run.ledger.record(
            run.runId,
            () => useSandboxWorkbenchStore.getState().setInspectorOpen(
              before.inspectorOpen,
              LEGACY_SANDBOX_OWNER_KEY,
            ),
            label,
          );
          done.push(label);
          applied += 1;
        }
      } else if (op.kind === 'sandbox_set_mode') {
        const mode = payload.mode as SandboxWorkbenchMode;
        if (!MODES.has(mode) || !before.activeSession) undone.push(`${label}（mode 无效或无会话）`);
        else {
          store.setWorkbenchMode(mode, LEGACY_SANDBOX_OWNER_KEY);
          run.ledger.record(
            run.runId,
            () => useSandboxWorkbenchStore.getState().setWorkbenchMode(
              before.activeSession!.mode,
              LEGACY_SANDBOX_OWNER_KEY,
            ),
            label,
          );
          done.push(label);
          applied += 1;
        }
      } else {
        undone.push(`${label}（不支持的 sandbox op）`);
      }
      await run.pacing.tick();
    }

    return {
      status: undone.length === 0 ? 'completed' : applied > 0 ? 'partial' : 'failed',
      mode: 'frontend',
      applied,
      totalOps: ops.length,
      entityIds: [],
      done,
      undone,
    };
  },

  abort(runId: string): AcrReceipt {
    return {
      status: 'cancelled',
      mode: 'frontend',
      applied: 0,
      totalOps: 0,
      entityIds: [],
      done: [],
      undone: [`run ${runId} 已停止`],
    };
  },
};

export function registerSandboxDriver(stage: StageManagerApi): void {
  stage.registerDriver(sandboxDriver);
}
