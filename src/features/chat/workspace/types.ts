export type WorkspaceId = string;
export type AgentId = string;
export type MessageId = string;
export type DocumentId = string;

export type WorkspaceStatus = 'active' | 'completed' | 'archived';
export type AgentRole = 'coordinator' | 'worker';
export type AgentStatus = 'idle' | 'running' | 'completed' | 'failed';
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
