import type { Context } from '@deepseek-ai/cordis';
import {
  applyAgentMeshBackendEvent,
  registerAgentMeshHostBridge,
  type GenericAgentMeshHostCaller,
} from './hostBridge';
import { useAgentMeshStore } from './store/useAgentMeshStore';
import type { AgentMeshBackendEvent } from './types';
import {
  DEFAULT_HETEROGENEOUS_AGENTS,
  getMeshWorkbenchHostAdapter,
  pushMeshWorkbenchEvent,
  selectActiveExternalThreadCount,
  selectPendingApprovalCount,
  setMeshWorkbenchHostAdapter,
  useAgentMeshWorkbenchStore,
  type AgentMeshWorkbenchState,
} from './workbenchBridge';
import type {
  MeshAdapterCapabilities,
  MeshAgentInfo,
  MeshApprovalDecision as WorkbenchApprovalDecision,
  MeshBoardMessage,
  MeshCenterViewMode,
  MeshCheckpointRecord as WorkbenchCheckpointRecord,
  MeshCustomCliTemplate,
  MeshDiffSummary as WorkbenchDiffSummary,
  MeshDriverKind,
  MeshExternalThread,
  MeshFileDiffEntry,
  MeshFileLease as WorkbenchFileLease,
  MeshMemberStatus,
  MeshMessagePriority,
  MeshPeerExchange,
  MeshPendingApproval as WorkbenchPendingApproval,
  MeshRevertResult,
  MeshSafetyPreferences,
  MeshSenderKind,
  MeshSubagentNode,
  MeshSwarmControlAction,
  MeshSwarmControlInput,
  MeshSwarmMember,
  MeshSwarmSession,
  MeshThreadStatus as WorkbenchThreadStatus,
  MeshToolCallItem as WorkbenchToolCallItem,
  MeshWorkbenchHostAdapter,
  MeshWorkbenchOpenState,
} from './workbench-types';
import type { MeshSettingsSectionProps } from './components/MeshSettingsSection';

export type {
  MeshAdapterCapabilities,
  MeshAgentInfo,
  WorkbenchApprovalDecision,
  MeshBoardMessage,
  MeshCenterViewMode,
  WorkbenchCheckpointRecord,
  MeshCustomCliTemplate,
  WorkbenchDiffSummary,
  MeshDriverKind,
  MeshExternalThread,
  MeshFileDiffEntry,
  WorkbenchFileLease,
  MeshMemberStatus,
  MeshMessagePriority,
  MeshPeerExchange,
  WorkbenchPendingApproval,
  MeshRevertResult,
  MeshSafetyPreferences,
  MeshSenderKind,
  MeshSubagentNode,
  MeshSwarmControlAction,
  MeshSwarmControlInput,
  MeshSwarmMember,
  MeshSwarmSession,
  WorkbenchThreadStatus,
  WorkbenchToolCallItem,
  MeshWorkbenchHostAdapter,
  MeshWorkbenchOpenState,
  MeshSettingsSectionProps,
};

export {
  DEFAULT_HETEROGENEOUS_AGENTS,
  getMeshWorkbenchHostAdapter,
  pushMeshWorkbenchEvent,
  selectActiveExternalThreadCount,
  selectPendingApprovalCount,
  setMeshWorkbenchHostAdapter,
  useAgentMeshWorkbenchStore,
  type AgentMeshWorkbenchState,
};
export { SwarmCapsuleBar, type SwarmCapsuleBarProps } from './components/SwarmCapsuleBar';

export const AGENT_MESH_UI_EVENT_CHANNEL = 'dstu/agent-mesh:event';

let storeOpenSyncInstalled = false;
let syncingOpenFlag = false;

/**
 * Installs bidirectional `workbenchOpen` & external-thread synchronization between
 * `useAgentMeshStore` (used by `InputBarV2` / `InlineExternalTurnCard`) and
 * `useAgentMeshWorkbenchStore` (used by `SwarmCapsuleBar` / `AgentControlCenter` / `/agents` / `/swarm` / `AgentMeshWorkbench`).
 */
export function ensureAgentMeshStoresSynced(): void {
  if (storeOpenSyncInstalled) return;
  storeOpenSyncInstalled = true;

  let prevInlineOpen = useAgentMeshStore.getState().workbenchOpen;
  let prevInlineThreads = useAgentMeshStore.getState().threads;
  useAgentMeshStore.subscribe((state) => {
    if (state.threads !== prevInlineThreads) {
      prevInlineThreads = state.threads;
      for (const thread of Object.values(state.threads)) {
        pushMeshWorkbenchEvent({
          type: 'thread_updated',
          chatSessionId: thread.chatSessionId,
          thread,
        });
      }
    }

    if (state.workbenchOpen === prevInlineOpen || syncingOpenFlag) return;
    prevInlineOpen = state.workbenchOpen;
    syncingOpenFlag = true;
    try {
      const wb = useAgentMeshWorkbenchStore.getState();
      if (state.workbenchOpen.open) {
        wb.openWorkbench({
          sessionId: state.workbenchOpen.sessionId,
          selectedThreadId: state.workbenchOpen.focusThreadId ?? undefined,
          centerView: state.workbenchOpen.focusThreadId ? 'stream' : undefined,
        });
      } else if (wb.workbench.open) {
        wb.closeWorkbench();
      }
    } finally {
      syncingOpenFlag = false;
    }
  });

  let prevWbOpen = useAgentMeshWorkbenchStore.getState().workbench;
  useAgentMeshWorkbenchStore.subscribe((state) => {
    if (state.workbench === prevWbOpen || syncingOpenFlag) return;
    prevWbOpen = state.workbench;
    syncingOpenFlag = true;
    try {
      useAgentMeshStore.getState().setWorkbenchOpen({
        open: state.workbench.open,
        sessionId: state.workbench.sessionId,
        focusThreadId: state.workbench.selectedThreadId,
      });
    } finally {
      syncingOpenFlag = false;
    }
  });
}

/**
 * Dispatches a single Host push event to BOTH `useAgentMeshStore` and `useAgentMeshWorkbenchStore`.
 */
export function dispatchAgentMeshBackendEvent(payload: unknown): void {
  applyAgentMeshBackendEvent(payload as AgentMeshBackendEvent);
  pushMeshWorkbenchEvent(payload);
}

/**
 * Connects a UI plugin's `ctx.ui.host` handle to BOTH the composer/inline store (`hostBridge.ts`)
 * AND the 3-pane Workbench store (`workbenchBridge.ts`), plus subscribes to `dstu/agent-mesh:event`.
 * Automatically revokes both Host adapters and the push-event listener on plugin unload.
 */
export function connectMeshWorkbenchPlugin(ctx: Context): () => void {
  ensureAgentMeshStoresSynced();

  const hostMap = ctx.ui.host as Record<
    string,
    Record<string, (...args: unknown[]) => Promise<unknown>> | undefined
  >;
  const callRemote = (method: string, ...args: unknown[]): Promise<unknown> => {
    const remote = hostMap.agentMesh ?? hostMap.dstuAgentMesh;
    const fn = remote?.[method];
    if (typeof fn !== 'function') return Promise.resolve(null);
    return args.length === 0 ? fn() : fn(...args);
  };

  const workbenchAdapter: MeshWorkbenchHostAdapter = {
    probeAgents: (opts) => callRemote('probeAgents', opts),
    getWorkspaceBinding: (input) => callRemote('getWorkspaceBinding', input),
    setWorkspaceBinding: (input) => callRemote('setWorkspaceBinding', input),
    startTurn: (input) => callRemote('startTurn', input),
    steerTurn: (input) => callRemote('steerTurn', input),
    interruptTurn: (input) => callRemote('interruptTurn', input),
    respondApproval: (input) => callRemote('respondApproval', input),
    setHumanControlled: (input) => callRemote('setHumanControlled', input),
    getSessionSnapshot: (input) => callRemote('getSessionSnapshot', input),
    getCheckpointDiff: (input) => callRemote('getCheckpointDiff', input),
    revertCheckpoint: (input) => callRemote('revertCheckpoint', input),
    swarmControl: (input) => callRemote('swarmControl', input),
    saveCustomCliTemplate: (tpl) => callRemote('saveCustomCliTemplate', tpl),
    deleteCustomCliTemplate: (input) => callRemote('deleteCustomCliTemplate', input),
  };

  const genericCaller: GenericAgentMeshHostCaller = (method, ...args) =>
    callRemote(method, ...args);

  const detachWorkbenchAdapter = setMeshWorkbenchHostAdapter(workbenchAdapter);
  const detachHostBridge = registerAgentMeshHostBridge(genericCaller);

  let detachEvents: (() => void) | undefined;
  try {
    detachEvents = ctx.ui.host.on('event', (payload: unknown) => {
      dispatchAgentMeshBackendEvent(payload);
    });
  } catch {
    // Headless test kernels without an `events` transport skip push subscription cleanly.
  }

  return () => {
    detachEvents?.();
    detachHostBridge();
    detachWorkbenchAdapter();
  };
}
