import { create } from 'zustand';
import type {
  WorkspaceId,
  Workspace,
  WorkspaceAgent,
  WorkspaceMessage,
  WorkspaceDocument,
  WorkspaceState,
  AgentStatus,
} from './types';

// ============================================================
// 状态解析 / 会话归属辅助（供 events.ts / api.ts / TauriAdapter 使用）
// ============================================================

const VALID_AGENT_STATUSES: ReadonlySet<string> = new Set<AgentStatus>([
  'idle',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

/**
 * 🔧 事件 payload 类型守卫：把后端事件里的裸 string 状态解析为 AgentStatus。
 * 非法值打印警告并回退 'idle'，避免未知状态污染 store。
 */
export function parseAgentStatus(value: unknown): AgentStatus {
  if (typeof value === 'string' && VALID_AGENT_STATUSES.has(value)) {
    return value as AgentStatus;
  }
  console.warn(
    `[WorkspaceStore] Unknown agent status "${String(value)}", falling back to "idle"`
  );
  return 'idle';
}

/**
 * 判断会话 ID 是否是工作区 Worker 会话（agent_ 或 subagent_ 前缀）
 */
export function isWorkerSessionId(sessionId: string): boolean {
  return sessionId.startsWith('agent_') || sessionId.startsWith('subagent_');
}

/**
 * 校验某会话是否与指定工作区关联：
 * - 会话是该工作区的 creator（coordinator），或
 * - 会话在 store.agents 中登记为该工作区成员（含 agent_/subagent_ 前缀的 Worker）
 */
export function isSessionAssociatedWithWorkspace(
  sessionId: string,
  workspaceId: WorkspaceId
): boolean {
  const state = useWorkspaceStore.getState();
  const workspace = state.workspace;
  if (workspace?.id === workspaceId && workspace.creatorSessionId === sessionId) {
    return true;
  }
  return state.agents.some(
    (a) => a.sessionId === sessionId && a.workspaceId === workspaceId
  );
}

/**
 * 🔧 修复 workspaceId 跨会话串台：
 * 仅当会话确实属于当前工作区时才返回 currentWorkspaceId，
 * 否则返回 undefined（发送消息时不附加 workspaceId）。
 */
export function resolveWorkspaceIdForSession(sessionId: string): WorkspaceId | undefined {
  const state = useWorkspaceStore.getState();
  const workspaceId = state.currentWorkspaceId;
  if (!workspaceId) {
    return undefined;
  }
  return isSessionAssociatedWithWorkspace(sessionId, workspaceId) ? workspaceId : undefined;
}

interface WorkspaceActions {
  setCurrentWorkspace: (workspaceId: WorkspaceId | null) => void;
  setWorkspace: (workspace: Workspace | null) => void;
  setAgents: (agents: WorkspaceAgent[]) => void;
  addAgent: (agent: WorkspaceAgent) => void;
  updateAgentStatus: (sessionId: string, status: WorkspaceAgent['status']) => void;
  removeAgent: (sessionId: string) => void;
  setMessages: (messages: WorkspaceMessage[]) => void;
  addMessage: (message: WorkspaceMessage) => void;
  setDocuments: (documents: WorkspaceDocument[]) => void;
  addDocument: (document: WorkspaceDocument) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const initialState: WorkspaceState = {
  currentWorkspaceId: null,
  workspace: null,
  agents: [],
  messages: [],
  documents: [],
  isLoading: false,
  error: null,
};

export const useWorkspaceStore = create<WorkspaceState & WorkspaceActions>((set) => ({
  ...initialState,

  setCurrentWorkspace: (workspaceId) => set({ currentWorkspaceId: workspaceId }),

  setWorkspace: (workspace) => set({ workspace }),

  setAgents: (agents) => set({ agents }),

  addAgent: (agent) =>
    set((state) => ({
      agents: [...state.agents.filter((a) => a.sessionId !== agent.sessionId), agent],
    })),

  updateAgentStatus: (sessionId, status) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.sessionId === sessionId ? { ...a, status, lastActiveAt: new Date().toISOString() } : a
      ),
    })),

  removeAgent: (sessionId) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.sessionId !== sessionId),
    })),

  setMessages: (messages) => set({ messages }),

  // 🔧 P24 修复：添加去重逻辑，避免重复消息
  addMessage: (message) =>
    set((state) => {
      // 检查是否已存在相同 ID 的消息
      if (state.messages.some((m) => m.id === message.id)) {
        return state; // 已存在，不重复添加
      }
      return { messages: [...state.messages, message] };
    }),

  setDocuments: (documents) => set({ documents }),

  addDocument: (document) =>
    set((state) => ({
      documents: [...state.documents.filter((d) => d.id !== document.id), document],
    })),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  reset: () => set(initialState),
}));
