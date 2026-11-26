import { create } from 'zustand';
import type {
  AgentMeshSessionSnapshot,
  CustomCliTemplate,
  DetectedMeshAgent,
  MeshCheckpointRecord,
  MeshDiffSummary,
  MeshFileLease,
  MeshPendingApproval,
  MeshThreadState,
  MeshThreadStatus,
  PeerExchangeRecord,
  SwarmBoardPost,
  SwarmSessionState,
  WorkbenchOpenState,
  WorkspaceBinding,
} from '../types';

const ACTIVE_EXTERNAL_STATUSES: ReadonlySet<MeshThreadStatus> = new Set([
  'running',
  'waiting_children',
  'waiting_approval',
]);

export function isExternalThreadActiveStatus(status: MeshThreadStatus | undefined): boolean {
  return status !== undefined && ACTIVE_EXTERNAL_STATUSES.has(status);
}

export interface AgentMeshStoreState {
  hostBridgeConnected: boolean;
  agents: DetectedMeshAgent[];
  customTemplates: CustomCliTemplate[];
  workspaceBindings: Record<string, WorkspaceBinding>;
  selectedCliBySession: Record<string, string | null>;
  selectedCliModelBySession: Record<string, string | null>;
  selectedCliEffortBySession: Record<string, string | null>;
  threads: Record<string, MeshThreadState>;
  sessionThreadOrder: Record<string, string[]>;
  peerExchanges: Record<string, PeerExchangeRecord[]>;
  checkpoints: Record<string, MeshCheckpointRecord[]>;
  fileLeases: MeshFileLease[];
  swarmBySession: Record<string, SwarmSessionState>;
  workbenchOpen: WorkbenchOpenState;

  // Actions
  setHostBridgeConnected: (connected: boolean) => void;
  setAgents: (agents: DetectedMeshAgent[]) => void;
  upsertCustomTemplate: (template: CustomCliTemplate) => void;
  removeCustomTemplate: (templateId: string) => void;
  setWorkspaceBindingState: (chatSessionId: string, binding: WorkspaceBinding | null) => void;
  setSelectedCliForSession: (chatSessionId: string, agentId: string | null) => void;
  setSelectedCliModelForSession: (chatSessionId: string, model: string | null) => void;
  setSelectedCliEffortForSession: (chatSessionId: string, effort: string | null) => void;
  upsertThread: (thread: MeshThreadState) => void;
  patchThread: (
    threadId: string,
    updater: Partial<MeshThreadState> | ((prev: MeshThreadState) => MeshThreadState),
  ) => void;
  markThreadReverted: (threadId: string, revertedAt?: number) => void;
  upsertPeerExchange: (exchange: PeerExchangeRecord) => void;
  upsertCheckpoint: (checkpoint: MeshCheckpointRecord) => void;
  markCheckpointReverted: (chatSessionId: string, checkpointId: string, threadId?: string) => void;
  setFileLeases: (leases: MeshFileLease[], rootPath?: string) => void;
  setSwarmState: (chatSessionId: string, swarm: SwarmSessionState | null) => void;
  appendSwarmBoardPost: (chatSessionId: string, post: SwarmBoardPost) => void;
  markSwarmCircuitBreaker: (chatSessionId: string, autonomousHops: number, maxAutonomousHops: number) => void;
  hydrateSessionSnapshot: (snapshot: AgentMeshSessionSnapshot) => void;
  setWorkbenchOpen: (next: Partial<WorkbenchOpenState> & { open: boolean }) => void;
  resetStore: () => void;
}

const INITIAL_WORKBENCH_STATE: WorkbenchOpenState = {
  open: false,
  sessionId: null,
  focusThreadId: null,
};

function createInitialDataState() {
  return {
    hostBridgeConnected: false,
    agents: [] as DetectedMeshAgent[],
    customTemplates: [] as CustomCliTemplate[],
    workspaceBindings: {} as Record<string, WorkspaceBinding>,
    selectedCliBySession: {} as Record<string, string | null>,
    selectedCliModelBySession: {} as Record<string, string | null>,
    selectedCliEffortBySession: {} as Record<string, string | null>,
    threads: {} as Record<string, MeshThreadState>,
    sessionThreadOrder: {} as Record<string, string[]>,
    peerExchanges: {} as Record<string, PeerExchangeRecord[]>,
    checkpoints: {} as Record<string, MeshCheckpointRecord[]>,
    fileLeases: [] as MeshFileLease[],
    swarmBySession: {} as Record<string, SwarmSessionState>,
    workbenchOpen: { ...INITIAL_WORKBENCH_STATE },
  };
}

export const useAgentMeshStore = create<AgentMeshStoreState>((set) => ({
  ...createInitialDataState(),

  setHostBridgeConnected: (connected) => {
    set({ hostBridgeConnected: connected });
  },

  setAgents: (agents) => {
    set({ agents: [...agents] });
  },

  upsertCustomTemplate: (template) => {
    set((state) => {
      const idx = state.customTemplates.findIndex((item) => item.id === template.id);
      if (idx === -1) {
        return { customTemplates: [...state.customTemplates, template] };
      }
      const next = [...state.customTemplates];
      next[idx] = template;
      return { customTemplates: next };
    });
  },

  removeCustomTemplate: (templateId) => {
    set((state) => ({
      customTemplates: state.customTemplates.filter((item) => item.id !== templateId),
    }));
  },

  setWorkspaceBindingState: (chatSessionId, binding) => {
    if (!chatSessionId) return;
    set((state) => {
      const next = { ...state.workspaceBindings };
      if (!binding || !binding.rootPath.trim()) {
        delete next[chatSessionId];
      } else {
        next[chatSessionId] = binding;
      }
      return { workspaceBindings: next };
    });
  },

  setSelectedCliForSession: (chatSessionId, agentId) => {
    if (!chatSessionId) return;
    set((state) => {
      const normalized = agentId?.trim() ? agentId.trim().replace(/^@+/, '') : null;
      const prevAgent = state.selectedCliBySession[chatSessionId] ?? null;
      const next = { ...state.selectedCliBySession };
      const nextModels = { ...state.selectedCliModelBySession };
      const nextEfforts = { ...state.selectedCliEffortBySession };
      if (!normalized || normalized === 'deepstudent') {
        delete next[chatSessionId];
        delete nextModels[chatSessionId];
        delete nextEfforts[chatSessionId];
      } else {
        next[chatSessionId] = normalized;
        if (prevAgent && prevAgent !== normalized) {
          delete nextModels[chatSessionId];
          delete nextEfforts[chatSessionId];
        }
      }
      return {
        selectedCliBySession: next,
        selectedCliModelBySession: nextModels,
        selectedCliEffortBySession: nextEfforts,
      };
    });
  },

  setSelectedCliModelForSession: (chatSessionId, model) => {
    if (!chatSessionId) return;
    set((state) => {
      const trimmed = model?.trim() || null;
      const next = { ...state.selectedCliModelBySession };
      if (!trimmed) {
        delete next[chatSessionId];
      } else {
        next[chatSessionId] = trimmed;
      }
      return { selectedCliModelBySession: next };
    });
  },

  setSelectedCliEffortForSession: (chatSessionId, effort) => {
    if (!chatSessionId) return;
    set((state) => {
      const trimmed = effort?.trim() || null;
      const next = { ...state.selectedCliEffortBySession };
      if (!trimmed || trimmed === 'off') {
        delete next[chatSessionId];
      } else {
        next[chatSessionId] = trimmed;
      }
      return { selectedCliEffortBySession: next };
    });
  },

  upsertThread: (thread) => {
    set((state) => {
      const existing = state.threads[thread.threadId];
      const merged: MeshThreadState = existing
        ? {
            ...existing,
            ...thread,
            childSubagents: thread.childSubagents ?? existing.childSubagents,
            toolCalls: thread.toolCalls ?? existing.toolCalls,
          }
        : thread;
      const prevOrder = state.sessionThreadOrder[merged.chatSessionId] ?? [];
      const nextOrder = prevOrder.includes(merged.threadId)
        ? prevOrder
        : [...prevOrder, merged.threadId];
      return {
        threads: {
          ...state.threads,
          [merged.threadId]: merged,
        },
        sessionThreadOrder: {
          ...state.sessionThreadOrder,
          [merged.chatSessionId]: nextOrder,
        },
      };
    });
  },

  patchThread: (threadId, updater) => {
    set((state) => {
      const existing = state.threads[threadId];
      if (!existing) return state;
      const updated =
        typeof updater === 'function'
          ? updater(existing)
          : { ...existing, ...updater, updatedAt: updater.updatedAt ?? Date.now() };
      return {
        threads: {
          ...state.threads,
          [threadId]: updated,
        },
      };
    });
  },

  markThreadReverted: (threadId, revertedAt = Date.now()) => {
    set((state) => {
      const existing = state.threads[threadId];
      if (!existing) return state;
      return {
        threads: {
          ...state.threads,
          [threadId]: {
            ...existing,
            revertedAt,
            updatedAt: revertedAt,
          },
        },
      };
    });
  },

  upsertPeerExchange: (exchange) => {
    set((state) => {
      const list = state.peerExchanges[exchange.chatSessionId] ?? [];
      const idx = list.findIndex((item) => item.id === exchange.id);
      const nextList =
        idx === -1
          ? [...list, exchange]
          : list.map((item, i) => (i === idx ? { ...item, ...exchange } : item));
      return {
        peerExchanges: {
          ...state.peerExchanges,
          [exchange.chatSessionId]: nextList,
        },
      };
    });
  },

  upsertCheckpoint: (checkpoint) => {
    set((state) => {
      const list = state.checkpoints[checkpoint.chatSessionId] ?? [];
      const idx = list.findIndex((item) => item.checkpointId === checkpoint.checkpointId);
      const nextList =
        idx === -1
          ? [...list, checkpoint]
          : list.map((item, i) => (i === idx ? { ...item, ...checkpoint } : item));
      return {
        checkpoints: {
          ...state.checkpoints,
          [checkpoint.chatSessionId]: nextList,
        },
      };
    });
  },

  markCheckpointReverted: (chatSessionId, checkpointId, threadId) => {
    const now = Date.now();
    set((state) => {
      const list = state.checkpoints[chatSessionId] ?? [];
      const nextCheckpoints = list.map((cp) =>
        cp.checkpointId === checkpointId ? { ...cp, reverted: true } : cp,
      );
      const resolvedThreadId =
        threadId ?? list.find((cp) => cp.checkpointId === checkpointId)?.threadId;
      const nextThreads =
        resolvedThreadId && state.threads[resolvedThreadId]
          ? {
              ...state.threads,
              [resolvedThreadId]: {
                ...state.threads[resolvedThreadId],
                revertedAt: now,
                updatedAt: now,
              },
            }
          : state.threads;
      return {
        checkpoints: {
          ...state.checkpoints,
          [chatSessionId]: nextCheckpoints,
        },
        threads: nextThreads,
      };
    });
  },

  setFileLeases: (leases, rootPath) => {
    set((state) => {
      if (!rootPath) {
        return { fileLeases: [...leases] };
      }
      const preserved = state.fileLeases.filter((lease) => lease.rootPath !== rootPath);
      return { fileLeases: [...preserved, ...leases] };
    });
  },

  setSwarmState: (chatSessionId, swarm) => {
    if (!chatSessionId) return;
    set((state) => {
      const next = { ...state.swarmBySession };
      if (!swarm) {
        delete next[chatSessionId];
      } else {
        next[chatSessionId] = swarm;
      }
      return { swarmBySession: next };
    });
  },

  appendSwarmBoardPost: (chatSessionId, post) => {
    if (!chatSessionId) return;
    set((state) => {
      const existing = state.swarmBySession[chatSessionId];
      if (!existing) return state;
      const alreadyExists = existing.board.some((entry) => entry.seq === post.seq);
      const nextBoard = alreadyExists
        ? existing.board.map((entry) => (entry.seq === post.seq ? post : entry))
        : [...existing.board, post].sort((a, b) => a.seq - b.seq);
      return {
        swarmBySession: {
          ...state.swarmBySession,
          [chatSessionId]: {
            ...existing,
            headSeq: Math.max(existing.headSeq, post.seq),
            board: nextBoard,
            updatedAt: post.createdAt || Date.now(),
          },
        },
      };
    });
  },

  markSwarmCircuitBreaker: (chatSessionId, autonomousHops, maxAutonomousHops) => {
    if (!chatSessionId) return;
    set((state) => {
      const existing = state.swarmBySession[chatSessionId];
      if (!existing) return state;
      return {
        swarmBySession: {
          ...state.swarmBySession,
          [chatSessionId]: {
            ...existing,
            status: 'paused',
            autonomousHops,
            maxAutonomousHops,
            circuitBreakerTripped: true,
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  hydrateSessionSnapshot: (snapshot) => {
    const { chatSessionId } = snapshot;
    if (!chatSessionId) return;
    set((state) => {
      const nextBindings = { ...state.workspaceBindings };
      if (snapshot.workspaceBinding !== undefined) {
        if (snapshot.workspaceBinding && snapshot.workspaceBinding.rootPath) {
          nextBindings[chatSessionId] = snapshot.workspaceBinding;
        } else {
          delete nextBindings[chatSessionId];
        }
      }

      const nextThreads = { ...state.threads };
      const nextOrder = [...(state.sessionThreadOrder[chatSessionId] ?? [])];
      if (snapshot.threads) {
        for (const thread of snapshot.threads) {
          nextThreads[thread.threadId] = thread;
          if (!nextOrder.includes(thread.threadId)) {
            nextOrder.push(thread.threadId);
          }
        }
      }

      const nextSwarm = { ...state.swarmBySession };
      if (snapshot.swarm !== undefined) {
        if (snapshot.swarm) {
          nextSwarm[chatSessionId] = snapshot.swarm;
        } else {
          delete nextSwarm[chatSessionId];
        }
      }

      return {
        workspaceBindings: nextBindings,
        threads: nextThreads,
        sessionThreadOrder: {
          ...state.sessionThreadOrder,
          [chatSessionId]: nextOrder,
        },
        peerExchanges:
          snapshot.peerExchanges !== undefined
            ? { ...state.peerExchanges, [chatSessionId]: snapshot.peerExchanges }
            : state.peerExchanges,
        checkpoints:
          snapshot.checkpoints !== undefined
            ? { ...state.checkpoints, [chatSessionId]: snapshot.checkpoints }
            : state.checkpoints,
        fileLeases: snapshot.fileLeases !== undefined ? snapshot.fileLeases : state.fileLeases,
        swarmBySession: nextSwarm,
      };
    });
  },

  setWorkbenchOpen: ({ open, sessionId, focusThreadId }) => {
    set((state) => ({
      workbenchOpen: {
        open,
        sessionId: sessionId !== undefined ? sessionId : state.workbenchOpen.sessionId,
        focusThreadId: focusThreadId !== undefined ? focusThreadId : state.workbenchOpen.focusThreadId,
      },
    }));
  },

  resetStore: () => {
    set(createInitialDataState());
  },
}));

// ============================================================================
// Pure Selectors
// ============================================================================

const EMPTY_INSTALLED_AGENTS: readonly DetectedMeshAgent[] = Object.freeze([]);
const EMPTY_SESSION_THREADS: readonly MeshThreadState[] = Object.freeze([]);

let lastAgentsSourceRef: readonly DetectedMeshAgent[] | null = null;
let lastInstalledAgentsResult: DetectedMeshAgent[] = EMPTY_INSTALLED_AGENTS as DetectedMeshAgent[];

export function selectInstalledExternalAgents(state: AgentMeshStoreState): DetectedMeshAgent[] {
  if (state.agents.length === 0) {
    return EMPTY_INSTALLED_AGENTS as DetectedMeshAgent[];
  }
  if (state.agents === lastAgentsSourceRef) {
    return lastInstalledAgentsResult;
  }
  lastAgentsSourceRef = state.agents;
  const filtered = state.agents.filter((agent) => agent.driverKind !== 'builtin' && agent.installed);
  lastInstalledAgentsResult =
    filtered.length === 0 ? (EMPTY_INSTALLED_AGENTS as DetectedMeshAgent[]) : filtered;
  return lastInstalledAgentsResult;
}

export function selectActiveExternalThreadForSession(
  state: AgentMeshStoreState,
  chatSessionId: string | null | undefined,
): MeshThreadState | null {
  if (!chatSessionId) return null;
  const order = state.sessionThreadOrder[chatSessionId];
  if (!order || order.length === 0) return null;
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const thread = state.threads[order[i]];
    if (thread && isExternalThreadActiveStatus(thread.status)) {
      return thread;
    }
  }
  return null;
}

export function selectSessionThreads(
  state: AgentMeshStoreState,
  chatSessionId: string | null | undefined,
): MeshThreadState[] {
  if (!chatSessionId) return EMPTY_SESSION_THREADS as MeshThreadState[];
  const order = state.sessionThreadOrder[chatSessionId];
  if (!order || order.length === 0) return EMPTY_SESSION_THREADS as MeshThreadState[];
  const result: MeshThreadState[] = [];
  for (const id of order) {
    const thread = state.threads[id];
    if (thread) result.push(thread);
  }
  return result.length === 0 ? (EMPTY_SESSION_THREADS as MeshThreadState[]) : result;
}

export function selectSelectedCliForSession(
  state: AgentMeshStoreState,
  chatSessionId: string | null | undefined,
): string | null {
  if (!chatSessionId) return null;
  return state.selectedCliBySession[chatSessionId] ?? null;
}

export function selectSelectedCliModelForSession(
  state: AgentMeshStoreState,
  chatSessionId: string | null | undefined,
): string | null {
  if (!chatSessionId) return null;
  return state.selectedCliModelBySession[chatSessionId] ?? null;
}

export function selectSelectedCliEffortForSession(
  state: AgentMeshStoreState,
  chatSessionId: string | null | undefined,
): string | null {
  if (!chatSessionId) return null;
  return state.selectedCliEffortBySession[chatSessionId] ?? null;
}

export function selectHasSessionMeshActivity(
  state: AgentMeshStoreState,
  chatSessionId: string | null | undefined,
): boolean {
  if (!chatSessionId) return false;
  const order = state.sessionThreadOrder[chatSessionId];
  if (order && order.length > 0) {
    for (const id of order) {
      const thread = state.threads[id];
      if (!thread) continue;
      if (thread.timelineMode !== 'native_chat') return true;
      if ((thread.diffSummary?.filesChanged ?? 0) > 0 && !thread.revertedAt) return true;
    }
  }
  const exchangeCount = state.peerExchanges[chatSessionId]?.length ?? 0;
  return exchangeCount > 0;
}

export function resetAgentMeshStore(): void {
  useAgentMeshStore.getState().resetStore();
}

export type { MeshDiffSummary, MeshPendingApproval };
