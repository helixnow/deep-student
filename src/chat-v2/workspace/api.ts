/**
 * 工作区 API 封装
 * 
 * 提供工作区相关的 Tauri invoke 封装
 */

import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { sessionManager } from '../core/session/sessionManager';
import type {
  WorkspaceId,
  Workspace,
  WorkspaceAgent,
  WorkspaceMessage,
  WorkspaceDocument,
  AgentRole,
  MessageType,
} from './types';
import { useWorkspaceStore } from './workspaceStore';

// ============================================================
// 请求/响应类型
// ============================================================

export interface CreateWorkspaceRequest {
  name?: string;
}

export interface CreateWorkspaceResponse {
  workspace_id: string;
  name?: string;
  status: string;
}

export interface CreateAgentRequest {
  workspace_id: string;
  requester_session_id: string;
  skill_id?: string;
  role?: string;
  initial_task?: string;
  /** 技能的系统提示词（由前端 skills 系统提供） */
  system_prompt?: string;
}

export interface CreateAgentResponse {
  agent_session_id: string;
  workspace_id: string;
  role: string;
  skill_id?: string;
  status: string;
}

export interface SendMessageRequest {
  workspace_id: string;
  content: string;
  target_session_id?: string;
  message_type?: string;
}

export interface SendMessageResponse {
  message_id: string;
  is_broadcast: boolean;
}

export interface WorkspaceInfo {
  id: string;
  name?: string;
  status: string;
  creator_session_id: string;
  created_at: string;
  updated_at: string;
}

export interface AgentInfo {
  session_id: string;
  role: string;
  status: string;
  skill_id?: string;
  joined_at: string;
  last_active_at: string;
}

export interface MessageInfo {
  id: string;
  sender_session_id: string;
  target_session_id?: string;
  message_type: string;
  content: string;
  status: string;
  created_at: string;
}

export interface DocumentInfo {
  id: string;
  doc_type: string;
  title: string;
  version: number;
  updated_by: string;
  updated_at: string;
}

// ============================================================
// API 方法
// ============================================================

/**
 * 创建工作区
 * 
 * 🔧 P1-1 修复：创建成功后自动设置 currentWorkspaceId，
 * 确保前端事件监听能正确处理后续的工作区事件
 */
export async function createWorkspace(
  sessionId: string,
  request: CreateWorkspaceRequest
): Promise<CreateWorkspaceResponse> {
  const response = await invoke<CreateWorkspaceResponse>('workspace_create', {
    sessionId,
    request,
  });
  
  // 🔧 P1-1 修复：自动设置 currentWorkspaceId
  // 注意：不需要 reset()，因为 agents/messages 按 workspaceId 隔离，UI 层应该过滤
  useWorkspaceStore.getState().setCurrentWorkspace(response.workspace_id);
  useWorkspaceStore.getState().setWorkspace({
    id: response.workspace_id,
    name: response.name,
    status: response.status as 'active' | 'completed' | 'archived',
    creatorSessionId: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  
  console.log(`[Workspace API] Created workspace ${response.workspace_id}, reset and set as currentWorkspaceId`);
  
  return response;
}

/**
 * 获取工作区信息
 */
export async function getWorkspace(
  sessionId: string,
  workspaceId: string
): Promise<WorkspaceInfo | null> {
  return invoke<WorkspaceInfo | null>('workspace_get', {
    sessionId,
    workspaceId,
  });
}

/**
 * 关闭工作区
 */
export async function closeWorkspace(sessionId: string, workspaceId: string): Promise<void> {
  return invoke<void>('workspace_close', {
    sessionId,
    workspaceId,
  });
}

/**
 * 删除工作区
 */
export async function deleteWorkspace(sessionId: string, workspaceId: string): Promise<void> {
  return invoke<void>('workspace_delete', {
    sessionId,
    workspaceId,
  });
}

/**
 * 创建 Agent
 */
export async function createAgent(
  request: CreateAgentRequest
): Promise<CreateAgentResponse> {
  return invoke<CreateAgentResponse>('workspace_create_agent', {
    request,
  });
}

/**
 * 列出工作区中的 Agent
 */
export async function listAgents(sessionId: string, workspaceId: string): Promise<AgentInfo[]> {
  return invoke<AgentInfo[]>('workspace_list_agents', {
    sessionId,
    workspaceId,
  });
}

/**
 * 发送消息到工作区
 */
export async function sendMessage(
  sessionId: string,
  request: SendMessageRequest
): Promise<SendMessageResponse> {
  return invoke<SendMessageResponse>('workspace_send_message', {
    sessionId,
    request,
  });
}

/**
 * 列出工作区消息
 */
export async function listMessages(
  sessionId: string,
  workspaceId: string,
  limit?: number
): Promise<MessageInfo[]> {
  return invoke<MessageInfo[]>('workspace_list_messages', {
    sessionId,
    workspaceId,
    limit,
  });
}

/**
 * 设置工作区上下文
 */
export async function setContext(
  sessionId: string,
  workspaceId: string,
  key: string,
  value: unknown
): Promise<void> {
  return invoke<void>('workspace_set_context', {
    sessionId,
    workspaceId,
    key,
    value,
  });
}

/**
 * 获取工作区上下文
 */
export async function getContext(
  sessionId: string,
  workspaceId: string,
  key: string
): Promise<unknown | null> {
  return invoke<unknown | null>('workspace_get_context', {
    sessionId,
    workspaceId,
    key,
  });
}

/**
 * 列出工作区文档
 */
export async function listDocuments(
  sessionId: string,
  workspaceId: string
): Promise<DocumentInfo[]> {
  return invoke<DocumentInfo[]>('workspace_list_documents', {
    sessionId,
    workspaceId,
  });
}

/**
 * 获取工作区文档内容
 */
export async function getDocument(
  sessionId: string,
  workspaceId: string,
  documentId: string
): Promise<string | null> {
  return invoke<string | null>('workspace_get_document', {
    sessionId,
    workspaceId,
    documentId,
  });
}

/**
 * 列出所有活跃工作区
 */
export async function listAllWorkspaces(sessionId: string): Promise<WorkspaceInfo[]> {
  return invoke<WorkspaceInfo[]>('workspace_list_all', {
    sessionId,
  });
}

/**
 * 手动刷新工作区快照（agents/messages/documents）
 * 用于事件丢失或需要强制同步的场景
 */
export async function refreshWorkspaceSnapshot(
  sessionId: string,
  workspaceId: string,
  options?: { messageLimit?: number; restoreExecutions?: boolean }
): Promise<void> {
  const store = useWorkspaceStore.getState();
  const currentWorkspaceId = store.currentWorkspaceId;
  if (currentWorkspaceId && currentWorkspaceId !== workspaceId) {
    return;
  }

  const messageLimit = options?.messageLimit ?? 50;

  const [agentsData, messagesData, documentsData] = await Promise.all([
    listAgents(sessionId, workspaceId).catch((e) => {
      console.warn('[Workspace API] Failed to refresh agents:', e);
      return [] as AgentInfo[];
    }),
    listMessages(sessionId, workspaceId, messageLimit).catch((e) => {
      console.warn('[Workspace API] Failed to refresh messages:', e);
      return [] as MessageInfo[];
    }),
    listDocuments(sessionId, workspaceId).catch((e) => {
      console.warn('[Workspace API] Failed to refresh documents:', e);
      return [] as DocumentInfo[];
    }),
  ]);

  const convertedAgents: WorkspaceAgent[] = agentsData.map((a) => ({
    sessionId: a.session_id,
    workspaceId,
    role: a.role as WorkspaceAgent['role'],
    skillId: a.skill_id,
    status: a.status as WorkspaceAgent['status'],
    joinedAt: a.joined_at,
    lastActiveAt: a.last_active_at,
  }));

  const convertedMessages: WorkspaceMessage[] = messagesData.map((m) => ({
    id: m.id,
    workspaceId,
    senderSessionId: m.sender_session_id,
    targetSessionId: m.target_session_id,
    messageType: m.message_type as WorkspaceMessage['messageType'],
    content: m.content,
    status: m.status as WorkspaceMessage['status'],
    createdAt: m.created_at,
  }));

  const convertedDocuments: WorkspaceDocument[] = documentsData.map((d) => ({
    id: d.id,
    workspaceId,
    docType: d.doc_type as WorkspaceDocument['docType'],
    title: d.title,
    content: '',
    version: d.version,
    updatedBy: d.updated_by,
    updatedAt: d.updated_at,
  }));

  const latestWorkspaceId = useWorkspaceStore.getState().currentWorkspaceId;
  if (latestWorkspaceId && latestWorkspaceId !== workspaceId) {
    return;
  }

  store.setAgents(convertedAgents);
  store.setMessages(convertedMessages);
  store.setDocuments(convertedDocuments);

  if (options?.restoreExecutions !== false) {
    try {
      await restoreExecutions(workspaceId, sessionId);
    } catch (e: unknown) {
      console.warn('[Workspace API] Failed to restore executions during refresh:', e);
    }
  }
}

function resolveWorkspaceRequesterSessionId(
  workspaceId: string,
  requesterSessionId?: string
): string {
  if (requesterSessionId) {
    return requesterSessionId;
  }

  const currentSessionId = sessionManager.getCurrentSessionId();
  if (currentSessionId) {
    return currentSessionId;
  }

  const state = useWorkspaceStore.getState();
  const workspace = state.workspace;
  if (workspace?.id === workspaceId && workspace.creatorSessionId) {
    return workspace.creatorSessionId;
  }

  throw new Error(i18n.t('chatV2:workspace.unableToResolveSessionId', 'Unable to resolve requester session ID for workspace command'));
}

// ============================================================
// Worker 执行相关
// ============================================================

export interface RunAgentRequest {
  workspace_id: string;
  agent_session_id: string;
  requester_session_id: string;
  /** 🆕 P38: 系统提醒消息，用于子代理没发消息时的重试 */
  reminder?: string;
}

export interface RunAgentResponse {
  agentSessionId: string;
  messageId: string;
  status: string;
}

/**
 * 运行 Worker Agent（Headless 执行）
 * 
 * 启动指定 Agent 的 Pipeline 执行，从 inbox 获取消息作为输入。
 * Worker 会自动处理 inbox 中的任务消息，并在空闲期继续检查新消息。
 * 
 * @param reminder 🆕 P38: 可选的系统提醒消息，用于子代理没发消息时的重试提醒
 */
export async function runAgent(
  workspaceId: string,
  agentSessionId: string,
  reminder?: string,
  requesterSessionId?: string
): Promise<RunAgentResponse> {
  const resolvedRequesterSessionId = resolveWorkspaceRequesterSessionId(
    workspaceId,
    requesterSessionId
  );

  const response = await invoke<{
    agent_session_id: string;
    message_id: string;
    status: string;
  }>('workspace_run_agent', {
    request: {
      workspace_id: workspaceId,
      agent_session_id: agentSessionId,
      requester_session_id: resolvedRequesterSessionId,
      reminder,
    },
  });
  
  return {
    agentSessionId: response.agent_session_id,
    messageId: response.message_id,
    status: response.status,
  };
}

/**
 * 取消 Worker Agent 执行
 */
export async function cancelAgent(
  workspaceId: string,
  agentSessionId: string,
  requesterSessionId?: string
): Promise<boolean> {
  const resolvedRequesterSessionId = resolveWorkspaceRequesterSessionId(
    workspaceId,
    requesterSessionId
  );

  return invoke<boolean>('workspace_cancel_agent', {
    sessionId: resolvedRequesterSessionId,
    workspaceId,
    agentSessionId,
  });
}

// ============================================================
// Agent 会话管理
// ============================================================

export interface AgentSessionInfo {
  id: string;
  mode: string;
  title?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: {
    workspace_id?: string;
    role?: string;
    skill_id?: string;
    system_prompt?: string;
  };
}

/**
 * 🆕 2026-01-20: 列出 Agent 会话（Worker 会话）
 * 
 * 用于工作区面板显示 Agent 会话列表
 */
export async function listAgentSessions(
  workspaceId?: string,
  limit?: number
): Promise<AgentSessionInfo[]> {
  // 🔧 批判性修复：后端使用 camelCase 序列化
  const sessions = await invoke<Array<{
    id: string;
    mode: string;
    title?: string;
    description?: string;
    createdAt: string;  // 后端 serde rename_all = "camelCase"
    updatedAt: string;
    metadata?: Record<string, unknown>;
  }>>('chat_v2_list_agent_sessions', {
    workspaceId,
    limit,
  });
  
  return sessions.map(s => ({
    id: s.id,
    mode: s.mode,
    title: s.title,
    description: s.description,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    metadata: s.metadata as AgentSessionInfo['metadata'],
  }));
}

// ============================================================
// 重启恢复相关
// ============================================================

export interface RestoreExecutionsResponse {
  /** 恢复的子代理任务数量 */
  subagent_tasks_restored: number;
  /** 恢复的子代理 session IDs */
  restored_agent_ids: string[];
  /** 是否有活跃的睡眠块 */
  has_active_sleeps: boolean;
  /** 活跃睡眠块 IDs */
  active_sleep_ids: string[];
}

/**
 * 🆕 重启后恢复被中断的执行
 * 
 * 这个函数应该在 workspace 加载后调用，用于：
 * 1. 恢复 pending/running 状态的子代理任务
 * 2. 检查并报告活跃的睡眠块状态
 */
export async function restoreExecutions(
  workspaceId: string,
  requesterSessionId?: string
): Promise<RestoreExecutionsResponse> {
  const resolvedRequesterSessionId = resolveWorkspaceRequesterSessionId(
    workspaceId,
    requesterSessionId
  );

  return invoke<RestoreExecutionsResponse>('workspace_restore_executions', {
    sessionId: resolvedRequesterSessionId,
    workspaceId,
  });
}

// ============================================================
// 睡眠/唤醒相关
// ============================================================

export interface ManualWakeRequest {
  workspace_id: string;
  requester_session_id: string;
  sleep_id: string;
  message?: string;
}

export interface ManualWakeResponse {
  success: boolean;
  sleep_id: string;
}

/**
 * 手动唤醒睡眠中的 Coordinator
 */
export async function manualWake(
  workspaceId: string,
  sleepId: string,
  message?: string,
  requesterSessionId?: string
): Promise<ManualWakeResponse> {
  const resolvedRequesterSessionId = resolveWorkspaceRequesterSessionId(
    workspaceId,
    requesterSessionId
  );

  return invoke<ManualWakeResponse>('workspace_manual_wake', {
    request: {
      workspace_id: workspaceId,
      requester_session_id: resolvedRequesterSessionId,
      sleep_id: sleepId,
      message,
    },
  });
}

/**
 * 取消睡眠
 */
export async function cancelSleep(
  workspaceId: string,
  sleepId: string,
  requesterSessionId?: string
): Promise<boolean> {
  const resolvedRequesterSessionId = resolveWorkspaceRequesterSessionId(
    workspaceId,
    requesterSessionId
  );

  return invoke<boolean>('workspace_cancel_sleep', {
    sessionId: resolvedRequesterSessionId,
    workspaceId,
    sleepId,
  });
}

// ============================================================
// 导出统一 API 对象
// ============================================================
// 注意：Skill API 已移除，技能系统由前端 src/chat-v2/skills/ 管理

export const workspaceApi = {
  createWorkspace,
  getWorkspace,
  closeWorkspace,
  deleteWorkspace,
  createAgent,
  listAgents,
  sendMessage,
  listMessages,
  setContext,
  getContext,
  listDocuments,
  getDocument,
  listAllWorkspaces,
  refreshWorkspaceSnapshot,
  runAgent,
  cancelAgent,
  listAgentSessions,
  restoreExecutions,
  manualWake,
  cancelSleep,
};

export default workspaceApi;
