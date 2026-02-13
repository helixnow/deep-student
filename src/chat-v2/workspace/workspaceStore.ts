import { create } from 'zustand';
import type {
  WorkspaceId,
  Workspace,
  WorkspaceAgent,
  WorkspaceMessage,
  WorkspaceDocument,
  WorkspaceState,
} from './types';

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
