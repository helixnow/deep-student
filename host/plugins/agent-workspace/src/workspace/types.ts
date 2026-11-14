// workspace/types.rs —— 多 Agent 协作 workspace 的领域类型与构造函数。
//
// 术语：本模块的 `Workspace` 指「多 Agent 协作 workspace」，与 runtime_roots.rs
// 中的 "workspace root"（磁盘工作目录）不是同一概念。
import type {
  AgentRole, AgentStatus, DocumentType, JsonValue, MessageStatus, MessageType,
  Workspace, WorkspaceAgent, WorkspaceContext, WorkspaceDocument, WorkspaceMessage,
} from '../../api.ts';
import { ulid } from './util.ts';
import { toRfc3339 as nowRfc3339 } from '../../../../platform/time/index.ts';

export interface HistoryInjectionConfig {
  enabled: boolean;
  maxMessages: number;
  messageTypes: string[];
  sinceMinutes: number;
}

/** `HistoryInjectionConfig::default_config()`。 */
export function defaultHistoryInjectionConfig(): HistoryInjectionConfig {
  return {
    enabled: true,
    maxMessages: 10,
    messageTypes: ['task', 'result', 'broadcast'],
    sinceMinutes: 60,
  };
}

export function generateWorkspaceId(): string {
  return `ws_${ulid()}`;
}

export function generateMessageId(): string {
  return `wsmsg_${ulid()}`;
}

export function generateDocumentId(): string {
  return `wsdoc_${ulid()}`;
}

/** `Workspace::new`：status=active、name=None、metadata=None。 */
export function newWorkspace(id: string, creatorSessionId: string): Workspace {
  const now = nowRfc3339();
  return {
    id,
    name: null,
    status: 'active',
    creatorSessionId,
    createdAt: now,
    updatedAt: now,
  };
}

/** `WorkspaceAgent::new`：status=idle、skill_id=None、metadata=None。 */
export function newWorkspaceAgent(
  sessionId: string,
  workspaceId: string,
  role: AgentRole,
): WorkspaceAgent {
  const now = nowRfc3339();
  return {
    sessionId,
    workspaceId,
    role,
    skillId: null,
    status: 'idle',
    joinedAt: now,
    lastActiveAt: now,
  };
}

/** `WorkspaceMessage::new`：status=pending、metadata=None。 */
export function newWorkspaceMessage(
  workspaceId: string,
  senderSessionId: string,
  targetSessionId: string | null,
  messageType: MessageType,
  content: string,
): WorkspaceMessage {
  return {
    id: generateMessageId(),
    workspaceId,
    senderSessionId,
    targetSessionId,
    messageType,
    content,
    status: 'pending',
    createdAt: nowRfc3339(),
  };
}

/** `WorkspaceMessage::is_broadcast`。 */
export function isBroadcast(message: WorkspaceMessage): boolean {
  return message.targetSessionId === null;
}

/** `WorkspaceDocument::new`：version=1。 */
export function newWorkspaceDocument(
  workspaceId: string,
  docType: DocumentType,
  title: string,
  content: string,
  updatedBy: string,
): WorkspaceDocument {
  return {
    id: generateDocumentId(),
    workspaceId,
    docType,
    title,
    content,
    version: 1,
    updatedBy,
    updatedAt: nowRfc3339(),
  };
}

export function newWorkspaceContext(
  workspaceId: string,
  key: string,
  value: JsonValue,
  updatedBy: string,
): WorkspaceContext {
  return { workspaceId, key, value, updatedBy, updatedAt: nowRfc3339() };
}

const WORKSPACE_STATUSES = ['active', 'completed', 'archived'] as const;
const AGENT_ROLES = ['coordinator', 'worker'] as const;
const AGENT_STATUSES = ['idle', 'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'closed'] as const;
const MESSAGE_TYPES = ['task', 'progress', 'result', 'query', 'correction', 'broadcast'] as const;
const MESSAGE_STATUSES = ['pending', 'delivered', 'processed'] as const;
const INBOX_STATUSES = ['unread', 'read', 'processed'] as const;
const DOCUMENT_TYPES = ['plan', 'research', 'artifact', 'notes'] as const;

function includes<T extends string>(values: readonly T[], value: string): value is T {
  return (values as readonly string[]).includes(value);
}

/** serde `#[serde(rename_all = "snake_case")]` 枚举解析；非法值交给调用方兜底。 */
export function parseWorkspaceStatus(value: string): Workspace['status'] {
  return includes(WORKSPACE_STATUSES, value) ? value : 'active';
}

export function parseAgentRole(value: string): AgentRole {
  return includes(AGENT_ROLES, value) ? value : 'worker';
}

export function parseAgentStatus(value: string): AgentStatus {
  return includes(AGENT_STATUSES, value) ? value : 'idle';
}

export function parseMessageType(value: string): MessageType {
  return includes(MESSAGE_TYPES, value) ? value : 'task';
}

export function parseMessageStatus(value: string): MessageStatus {
  return includes(MESSAGE_STATUSES, value) ? value : 'pending';
}

export function parseInboxStatus(value: string): (typeof INBOX_STATUSES)[number] {
  return includes(INBOX_STATUSES, value) ? value : 'unread';
}

export function parseDocumentType(value: string): DocumentType {
  return includes(DOCUMENT_TYPES, value) ? value : 'notes';
}
