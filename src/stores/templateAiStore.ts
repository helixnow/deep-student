/**
 * 模板 AI 状态管理
 * 
 * 管理模板生成会话的状态、消息历史和候选模板
 */

import { create } from 'zustand';
import { CreateTemplateRequest } from '../types';

// 模板 AI 会话类型
export interface TemplateAISession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  templateId?: string;
}

// 模板 AI 消息类型
export interface TemplateAIMessage {
  id: string;
  session_id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  created_at?: string;
  thinking_content?: string;
  candidateTemplate?: CreateTemplateRequest;
}

export interface TemplateAIStreamState {
  isStreaming: boolean;
  currentContent: string;
  thinkingContent: string;
  error?: string;
  tokensUsed?: number;
}

interface TemplateAIStore {
  // 当前活跃会话
  activeSessionId: string | null;
  
  // 会话列表
  sessions: TemplateAISession[];
  
  // 当前会话的消息
  messages: TemplateAIMessage[];
  
  // 流式状态
  streamState: TemplateAIStreamState;
  
  // 最新生成的候选模板
  latestCandidate: CreateTemplateRequest | null;
  
  // 校验警告
  validationWarnings: string[];
  
  // 模板摘要与改动
  latestSummary: Record<string, any> | null;
  recentChanges: Record<string, any> | null;
  
  // Actions
  setActiveSession: (sessionId: string | null) => void;
  setSessions: (sessions: TemplateAISession[]) => void;
  setMessages: (messages: TemplateAIMessage[]) => void;
  addMessage: (message: TemplateAIMessage) => void;
  
  setStreamState: (state: Partial<TemplateAIStreamState>) => void;
  resetStreamState: () => void;
  
  setLatestCandidate: (template: CreateTemplateRequest | null) => void;
  setValidationWarnings: (warnings: string[]) => void;
  setLatestSummary: (summary: Record<string, any> | null) => void;
  setRecentChanges: (changes: Record<string, any> | null) => void;
  
  reset: () => void;
}

const initialStreamState: TemplateAIStreamState = {
  isStreaming: false,
  currentContent: '',
  thinkingContent: '',
  error: undefined,
};

export const useTemplateAIStore = create<TemplateAIStore>((set) => ({
  activeSessionId: null,
  sessions: [],
  messages: [],
  streamState: initialStreamState,
  latestCandidate: null,
  validationWarnings: [],
  latestSummary: null,
  recentChanges: null,

  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
  
  setSessions: (sessions) => set({ sessions }),
  
  setMessages: (messages) => set({ messages }),
  
  addMessage: (message) =>
    set((state) => ({
      messages: [...state.messages, message],
    })),
  
  setStreamState: (newState) =>
    set((state) => ({
      streamState: { ...state.streamState, ...newState },
    })),
  
  resetStreamState: () => set({ streamState: initialStreamState }),
  
  setLatestCandidate: (template) => set({ latestCandidate: template }),
  
  setValidationWarnings: (warnings) => set({ validationWarnings: warnings }),

  setLatestSummary: (summary) => set({ latestSummary: summary }),
  
  setRecentChanges: (changes) => set({ recentChanges: changes }),
  
  reset: () =>
    set({
      activeSessionId: null,
      sessions: [],
      messages: [],
      streamState: initialStreamState,
      latestCandidate: null,
      validationWarnings: [],
      latestSummary: null,
      recentChanges: null,
    }),
}));


