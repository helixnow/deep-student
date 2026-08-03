export type WorkspaceId = string;
export type AgentId = string;
export type MessageId = string;
export type DocumentId = string;

export type WorkspaceStatus = 'active' | 'completed' | 'archived';
export type AgentRole = 'coordinator' | 'worker';
export type AgentStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'closed';
export type MessageType = 'task' | 'progress' | 'result' | 'query' | 'correction' | 'broadcast';
export type MessageStatus = 'pending' | 'delivered' | 'processed';
export type InboxStatus = 'unread' | 'read' | 'processed';
export type DocumentType = 'plan' | 'research' | 'artifact' | 'notes';

export interface Workspace {
  id: WorkspaceId;
  name?: string;
  status: WorkspaceStatus;
  creatorSessionId: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceAgent {
  sessionId: AgentId;
  workspaceId: WorkspaceId;
  role: AgentRole;
  skillId?: string;
  status: AgentStatus;
  joinedAt: string;
  lastActiveAt: string;
  metadata?: Record<string, unknown>;
  /** C12：inbox 未消费消息数（后端 workspace_list_agents 回传，查询失败为 0） */
  pendingInboxCount?: number;
}

/**
 * 契约 C8：后端 token 归集对象（camelCase）。
 * 事件 payload 的外层键名是 snake_case 的 `token_usage`，值本身即此形状（可能为 null）。
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source?: string;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export interface AgentCompletionEnvelope {
  workspaceId: WorkspaceId;
  agentSessionId: AgentId;
  /** 派发该子代理的主代理会话 ID（异步唤醒用） */
  parentSessionId?: string;
  taskId?: string;
  runId?: string;
  correlationId?: string;
  status: Extract<AgentStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'closed'>;
  finalOutput?: string;
  error?: string;
  completedAt?: string;
  /** C8：子代理本次运行的 token 用量（camelCase TokenUsage），后端读不到时缺省 */
  tokenUsage?: TokenUsage;
}

export interface WorkspaceMessage {
  id: MessageId;
  workspaceId: WorkspaceId;
  senderSessionId: AgentId;
  targetSessionId?: AgentId;
  messageType: MessageType;
  content: string;
  status: MessageStatus;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface InboxItem {
  id: number;
  sessionId: AgentId;
  messageId: MessageId;
  priority: number;
  status: InboxStatus;
  createdAt: string;
}

export interface WorkspaceDocument {
  id: DocumentId;
  workspaceId: WorkspaceId;
  docType: DocumentType;
  title: string;
  content: string;
  version: number;
  updatedBy: AgentId;
  updatedAt: string;
}

export interface WorkspaceContext {
  workspaceId: WorkspaceId;
  key: string;
  value: unknown;
  updatedBy: AgentId;
  updatedAt: string;
}

export interface CreateWorkspaceResult {
  workspaceId: WorkspaceId;
  status: string;
  message: string;
}

export interface CreateAgentResult {
  agentSessionId: AgentId;
  workspaceId: WorkspaceId;
  role: AgentRole;
  status: string;
}

export interface SendMessageResult {
  messageId: MessageId;
  status: string;
  isBroadcast: boolean;
}

export interface QueryAgentsResult {
  agents: Array<{
    sessionId: AgentId;
    role: AgentRole;
    status: AgentStatus;
    skillId?: string;
  }>;
}

export interface QueryMessagesResult {
  messages: Array<{
    id: MessageId;
    sender: AgentId;
    target?: AgentId;
    type: MessageType;
    content: string;
    createdAt: string;
  }>;
}

export interface QueryDocumentsResult {
  documents: Array<{
    id: DocumentId;
    title: string;
    type: DocumentType;
    version: number;
  }>;
}

export interface ContextResult {
  key: string;
  value: unknown;
  updatedBy?: AgentId;
  updatedAt?: string;
  found?: boolean;
}

export interface DocumentResult {
  id: DocumentId;
  title: string;
  content: string;
  type: DocumentType;
  version: number;
  updatedBy: AgentId;
  updatedAt: string;
  found?: boolean;
}

export interface WorkspaceState {
  currentWorkspaceId: WorkspaceId | null;
  workspace: Workspace | null;
  agents: WorkspaceAgent[];
  messages: WorkspaceMessage[];
  documents: WorkspaceDocument[];
  isLoading: boolean;
  error: string | null;
}
