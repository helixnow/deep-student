// workspace/repo.rs —— 行 ↔ 领域对象映射与 Rust 错误文案。
import type {
  AgentRole, AgentStatus, DocumentType, InboxItem, InboxStatus, JsonValue, MessageStatus,
  MessageType, Workspace, WorkspaceAgent, WorkspaceContext, WorkspaceDocument, WorkspaceMessage,
  WorkspaceStatus,
} from '../../api.ts';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import * as sql from '../../repository/workspace-repository.ts';
import type {
  AgentRow, ContextRow, DocumentRow, InboxRow, MessageRow, WorkspaceRow,
} from '../../repository/workspace-repository.ts';
import {
  parseAgentRole, parseAgentStatus, parseDocumentType, parseInboxStatus, parseMessageStatus,
  parseMessageType, parseWorkspaceStatus,
} from './types.ts';
import { EPOCH_RFC3339 } from './util.ts';
import { toRfc3339 as nowRfc3339, toRfc3339, parseRfc3339 } from '../../../../platform/time/index.ts';
import { silentWorkspaceLogger, type WorkspaceLogger } from './logger.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampOrEpoch(value: string): string {
  const parsed = parseRfc3339(value);
  return parsed === null ? EPOCH_RFC3339 : toRfc3339(parsed.epochNanos);
}

function metadataJson(value: JsonValue | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseMetadata(value: string | null): JsonValue | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return undefined;
  }
}

function parseContextValue(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    status: parseWorkspaceStatus(row.status),
    creatorSessionId: row.creator_session_id,
    createdAt: timestampOrEpoch(row.created_at),
    updatedAt: timestampOrEpoch(row.updated_at),
    metadata: parseMetadata(row.metadata_json),
  };
}

function rowToAgent(row: AgentRow, logger: WorkspaceLogger): WorkspaceAgent {
  return {
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    role: parseAgentRole(row.role),
    skillId: row.skill_id,
    status: parseAgentStatus(row.status),
    joinedAt: timestampOrEpochLogged(row.joined_at, 'joined_at', logger),
    lastActiveAt: timestampOrEpochLogged(row.last_active_at, 'last_active_at', logger),
    metadata: parseMetadata(row.metadata_json),
  };
}

function timestampOrEpochLogged(
  value: string,
  field: string,
  logger: WorkspaceLogger,
): string {
  const parsed = parseRfc3339(value);
  if (parsed !== null) return toRfc3339(parsed.epochNanos);
  logger.warn(`[WorkspaceRepo] Failed to parse ${field} '${value}': invalid RFC3339, using epoch fallback`);
  return EPOCH_RFC3339;
}

function rowToMessage(row: MessageRow): WorkspaceMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    senderSessionId: row.sender_session_id,
    targetSessionId: row.target_session_id,
    messageType: parseMessageType(row.message_type),
    content: row.content,
    status: parseMessageStatus(row.status),
    createdAt: timestampOrEpoch(row.created_at),
    metadata: parseMetadata(row.metadata_json),
  };
}

function rowToInboxItem(row: InboxRow): InboxItem {
  return {
    id: Number(row.id),
    sessionId: row.session_id,
    messageId: row.message_id,
    priority: Number(row.priority),
    status: parseInboxStatus(row.status) as InboxStatus,
    createdAt: timestampOrEpoch(row.created_at),
  };
}

function rowToDocument(row: DocumentRow): WorkspaceDocument {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    docType: parseDocumentType(row.doc_type) as DocumentType,
    title: row.title,
    content: row.content,
    version: Number(row.version),
    updatedBy: row.updated_by,
    updatedAt: timestampOrEpoch(row.updated_at),
  };
}

function rowToContext(row: ContextRow): WorkspaceContext {
  return {
    workspaceId: row.workspace_id,
    key: row.key,
    value: parseContextValue(row.value_json),
    updatedBy: row.updated_by,
    updatedAt: timestampOrEpoch(row.updated_at),
  };
}

export class WorkspaceRepo {
  private readonly db: SqlExecutor;
  private readonly logger: WorkspaceLogger;

  constructor(
    db: SqlExecutor,
    logger: WorkspaceLogger = silentWorkspaceLogger,
  ) {
    this.db = db;
    this.logger = logger;
  }

  saveWorkspace(workspace: Workspace): void {
    try {
      sql.saveWorkspace(this.db, {
        id: workspace.id,
        name: workspace.name,
        status: workspace.status,
        creatorSessionId: workspace.creatorSessionId,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        metadataJson: metadataJson(workspace.metadata),
      });
    } catch (error) {
      throw new Error(`Failed to save workspace: ${messageOf(error)}`);
    }
  }

  getWorkspace(): Workspace | null {
    let row: WorkspaceRow | undefined;
    try {
      row = sql.getWorkspace(this.db);
    } catch (error) {
      throw new Error(`Failed to query workspace: ${messageOf(error)}`);
    }
    return row === undefined ? null : rowToWorkspace(row);
  }

  updateWorkspaceStatus(status: WorkspaceStatus): void {
    try {
      sql.updateWorkspaceStatus(this.db, status, nowRfc3339());
    } catch (error) {
      throw new Error(`Failed to update workspace status: ${messageOf(error)}`);
    }
  }

  saveAgent(agent: WorkspaceAgent): void {
    try {
      sql.saveAgent(this.db, {
        sessionId: agent.sessionId,
        workspaceId: agent.workspaceId,
        role: agent.role,
        skillId: agent.skillId,
        status: agent.status,
        joinedAt: agent.joinedAt,
        lastActiveAt: agent.lastActiveAt,
        metadataJson: metadataJson(agent.metadata),
      });
    } catch (error) {
      throw new Error(`Failed to save agent: ${messageOf(error)}`);
    }
  }

  getAgent(sessionId: string): WorkspaceAgent | null {
    let row: AgentRow | undefined;
    try {
      row = sql.getAgent(this.db, sessionId);
    } catch (error) {
      throw new Error(`Failed to query agent: ${messageOf(error)}`);
    }
    return row === undefined ? null : rowToAgent(row, this.logger);
  }

  listAgents(): WorkspaceAgent[] {
    let rows: AgentRow[];
    try {
      rows = sql.listAgents(this.db);
    } catch (error) {
      throw new Error(`Failed to query agents: ${messageOf(error)}`);
    }
    const agents: WorkspaceAgent[] = [];
    for (const row of rows) agents.push(rowToAgent(row, this.logger));
    return agents;
  }

  updateAgentStatus(sessionId: string, status: AgentStatus): void {
    try {
      sql.updateAgentStatus(this.db, sessionId, status, nowRfc3339());
    } catch (error) {
      throw new Error(`Failed to update agent status: ${messageOf(error)}`);
    }
  }

  updateAgentMetadata(sessionId: string, metadata: JsonValue | undefined): void {
    let changes: number;
    try {
      changes = sql.updateAgentMetadata(this.db, sessionId, metadataJson(metadata), nowRfc3339());
    } catch (error) {
      throw new Error(messageOf(error));
    }
    if (changes === 0) throw new Error(`Agent not found: ${sessionId}`);
  }

  deleteAgent(sessionId: string): void {
    try {
      sql.deleteAgent(this.db, sessionId);
    } catch (error) {
      throw new Error(`Failed to delete agent: ${messageOf(error)}`);
    }
  }

  saveMessage(message: WorkspaceMessage): void {
    try {
      sql.saveMessage(this.db, {
        id: message.id,
        workspaceId: message.workspaceId,
        senderSessionId: message.senderSessionId,
        targetSessionId: message.targetSessionId,
        messageType: message.messageType,
        content: message.content,
        status: message.status,
        createdAt: message.createdAt,
        metadataJson: metadataJson(message.metadata),
      });
    } catch (error) {
      throw new Error(`Failed to save message: ${messageOf(error)}`);
    }
  }

  getMessage(messageId: string): WorkspaceMessage | null {
    let row: MessageRow | undefined;
    try {
      row = sql.getMessage(this.db, messageId);
    } catch (error) {
      throw new Error(`Failed to query message: ${messageOf(error)}`);
    }
    return row === undefined ? null : rowToMessage(row);
  }

  listMessages(limit: number): WorkspaceMessage[] {
    let rows: MessageRow[];
    try {
      rows = sql.listMessages(this.db, limit);
    } catch (error) {
      throw new Error(`Failed to query messages: ${messageOf(error)}`);
    }
    return rows.map(rowToMessage);
  }

  hasAgentSentMessageSince(agentSessionId: string, since: string): boolean {
    try {
      return sql.hasAgentSentMessageSince(this.db, agentSessionId, since);
    } catch (error) {
      throw new Error(`Failed to count messages: ${messageOf(error)}`);
    }
  }

  updateMessageStatus(messageId: string, status: MessageStatus): void {
    try {
      sql.updateMessageStatus(this.db, messageId, status);
    } catch (error) {
      throw new Error(`Failed to update message status: ${messageOf(error)}`);
    }
  }

  updateMessageMetadata(messageId: string, metadata: JsonValue | undefined): void {
    try {
      sql.updateMessageMetadata(this.db, messageId, metadataJson(metadata));
    } catch (error) {
      throw new Error(`Failed to update message metadata: ${messageOf(error)}`);
    }
  }

  addToInbox(sessionId: string, messageId: string, priority: number): number {
    try {
      return sql.addToInbox(this.db, sessionId, messageId, priority, nowRfc3339());
    } catch (error) {
      throw new Error(`Failed to add to inbox: ${messageOf(error)}`);
    }
  }

  getUnreadInbox(sessionId: string, limit: number): InboxItem[] {
    let rows: InboxRow[];
    try {
      rows = sql.getUnreadInbox(this.db, sessionId, limit);
    } catch (error) {
      throw new Error(`Failed to query inbox: ${messageOf(error)}`);
    }
    return rows.map(rowToInboxItem);
  }

  countUnreadInbox(sessionId: string): number {
    try {
      return sql.countUnreadInbox(this.db, sessionId);
    } catch (error) {
      throw new Error(`Failed to count unread inbox: ${messageOf(error)}`);
    }
  }

  markInboxProcessed(inboxIds: readonly number[]): void {
    try {
      sql.markInboxProcessed(this.db, inboxIds);
    } catch (error) {
      throw new Error(`Failed to mark inbox processed: ${messageOf(error)}`);
    }
  }

  markInboxProcessedByMessage(sessionId: string, messageId: string): void {
    try {
      sql.markInboxProcessedByMessage(this.db, sessionId, messageId);
    } catch (error) {
      throw new Error(`Failed to mark inbox processed by message: ${messageOf(error)}`);
    }
  }

  getUnreadInboxMessages(sessionId: string): WorkspaceMessage[] {
    let rows: MessageRow[];
    try {
      rows = sql.getUnreadInboxMessages(this.db, sessionId);
    } catch (error) {
      throw new Error(`Failed to query unread inbox messages: ${messageOf(error)}`);
    }
    return rows.map(rowToMessage);
  }

  getAllUnreadInbox(): InboxItem[] {
    let rows: InboxRow[];
    try {
      rows = sql.getAllUnreadInbox(this.db);
    } catch (error) {
      throw new Error(`Failed to query all unread inbox: ${messageOf(error)}`);
    }
    return rows.map(rowToInboxItem);
  }

  saveDocument(doc: WorkspaceDocument): void {
    try {
      sql.saveDocument(this.db, {
        id: doc.id,
        workspaceId: doc.workspaceId,
        docType: doc.docType as DocumentType,
        title: doc.title,
        content: doc.content,
        version: doc.version,
        updatedBy: doc.updatedBy,
        updatedAt: doc.updatedAt,
      });
    } catch (error) {
      throw new Error(`Failed to save document: ${messageOf(error)}`);
    }
  }

  getDocument(docId: string): WorkspaceDocument | null {
    let row: DocumentRow | undefined;
    try {
      row = sql.getDocument(this.db, docId);
    } catch (error) {
      throw new Error(`Failed to query document: ${messageOf(error)}`);
    }
    return row === undefined ? null : rowToDocument(row);
  }

  listDocuments(): WorkspaceDocument[] {
    let rows: DocumentRow[];
    try {
      rows = sql.listDocuments(this.db);
    } catch (error) {
      throw new Error(`Failed to query documents: ${messageOf(error)}`);
    }
    return rows.map(rowToDocument);
  }

  setContext(context: WorkspaceContext): void {
    try {
      sql.setContext(this.db, {
        workspaceId: context.workspaceId,
        key: context.key,
        valueJson: JSON.stringify(context.value),
        updatedBy: context.updatedBy,
        updatedAt: context.updatedAt,
      });
    } catch (error) {
      throw new Error(`Failed to set context: ${messageOf(error)}`);
    }
  }

  getContext(key: string): WorkspaceContext | null {
    let row: ContextRow | undefined;
    try {
      row = sql.getContext(this.db, key);
    } catch (error) {
      throw new Error(`Failed to query context: ${messageOf(error)}`);
    }
    return row === undefined ? null : rowToContext(row);
  }

  listContext(): WorkspaceContext[] {
    let rows: ContextRow[];
    try {
      rows = sql.listContext(this.db);
    } catch (error) {
      throw new Error(`Failed to query contexts: ${messageOf(error)}`);
    }
    return rows.map(rowToContext);
  }
}
