// workspace/repo.rs 的 SQL 与行查询。
import type { SqlExecutor } from '../../../platform/storage/api.ts';

export interface WorkspaceRow {
  id: string;
  name: string | null;
  status: string;
  creator_session_id: string;
  created_at: string;
  updated_at: string;
  metadata_json: string | null;
}

export interface AgentRow {
  session_id: string;
  workspace_id: string;
  role: string;
  skill_id: string | null;
  status: string;
  joined_at: string;
  last_active_at: string;
  metadata_json: string | null;
}

export interface MessageRow {
  id: string;
  workspace_id: string;
  sender_session_id: string;
  target_session_id: string | null;
  message_type: string;
  content: string;
  status: string;
  created_at: string;
  metadata_json: string | null;
}

export interface InboxRow {
  id: number;
  session_id: string;
  message_id: string;
  priority: number;
  status: string;
  created_at: string;
}

export interface DocumentRow {
  id: string;
  workspace_id: string;
  doc_type: string;
  title: string;
  content: string;
  version: number;
  updated_by: string;
  updated_at: string;
}

export interface ContextRow {
  workspace_id: string;
  key: string;
  value_json: string;
  updated_by: string;
  updated_at: string;
}

export interface WorkspaceRecord {
  id: string;
  name: string | null;
  status: string;
  creatorSessionId: string;
  createdAt: string;
  updatedAt: string;
  metadataJson: string | null;
}

export interface AgentRecord {
  sessionId: string;
  workspaceId: string;
  role: string;
  skillId: string | null;
  status: string;
  joinedAt: string;
  lastActiveAt: string;
  metadataJson: string | null;
}

export interface MessageRecord {
  id: string;
  workspaceId: string;
  senderSessionId: string;
  targetSessionId: string | null;
  messageType: string;
  content: string;
  status: string;
  createdAt: string;
  metadataJson: string | null;
}

export interface InboxRecord {
  id: number;
  sessionId: string;
  messageId: string;
  priority: number;
  status: string;
  createdAt: string;
}

export interface DocumentRecord {
  id: string;
  workspaceId: string;
  docType: string;
  title: string;
  content: string;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface ContextRecord {
  workspaceId: string;
  key: string;
  valueJson: string;
  updatedBy: string;
  updatedAt: string;
}

export function saveWorkspace(db: SqlExecutor, record: WorkspaceRecord): void {
  db.run(
    `INSERT OR REPLACE INTO workspace (id, name, status, creator_session_id, created_at, updated_at, metadata_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    [record.id, record.name, record.status, record.creatorSessionId, record.createdAt, record.updatedAt, record.metadataJson],
  );
}

export function getWorkspace(db: SqlExecutor): WorkspaceRow | undefined {
  return db.get<WorkspaceRow>(
    'SELECT id, name, status, creator_session_id, created_at, updated_at, metadata_json FROM workspace LIMIT 1',
  );
}

export function updateWorkspaceStatus(db: SqlExecutor, status: string, updatedAt: string): void {
  db.run('UPDATE workspace SET status = ?1, updated_at = ?2', [status, updatedAt]);
}

export function saveAgent(db: SqlExecutor, record: AgentRecord): void {
  db.run(
    `INSERT OR REPLACE INTO agent (session_id, workspace_id, role, skill_id, status, joined_at, last_active_at, metadata_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    [
      record.sessionId, record.workspaceId, record.role, record.skillId, record.status,
      record.joinedAt, record.lastActiveAt, record.metadataJson,
    ],
  );
}

export function getAgent(db: SqlExecutor, sessionId: string): AgentRow | undefined {
  return db.get<AgentRow>(
    'SELECT session_id, workspace_id, role, skill_id, status, joined_at, last_active_at, metadata_json FROM agent WHERE session_id = ?1',
    [sessionId],
  );
}

export function listAgents(db: SqlExecutor): AgentRow[] {
  return db.all<AgentRow>(
    'SELECT session_id, workspace_id, role, skill_id, status, joined_at, last_active_at, metadata_json FROM agent ORDER BY joined_at',
  );
}

export function updateAgentStatus(db: SqlExecutor, sessionId: string, status: string, lastActiveAt: string): void {
  db.run('UPDATE agent SET status = ?1, last_active_at = ?2 WHERE session_id = ?3', [status, lastActiveAt, sessionId]);
}

export function updateAgentMetadata(
  db: SqlExecutor,
  sessionId: string,
  metadataJson: string | null,
  lastActiveAt: string,
): number {
  return db.run(
    'UPDATE agent SET metadata_json = ?1, last_active_at = ?2 WHERE session_id = ?3',
    [metadataJson, lastActiveAt, sessionId],
  ).changes;
}

export function deleteAgent(db: SqlExecutor, sessionId: string): void {
  db.run('DELETE FROM agent WHERE session_id = ?1', [sessionId]);
}

export function saveMessage(db: SqlExecutor, record: MessageRecord): void {
  db.run(
    `INSERT INTO message (id, workspace_id, sender_session_id, target_session_id, message_type, content, status, created_at, metadata_json)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    [
      record.id, record.workspaceId, record.senderSessionId, record.targetSessionId,
      record.messageType, record.content, record.status, record.createdAt, record.metadataJson,
    ],
  );
}

export function getMessage(db: SqlExecutor, messageId: string): MessageRow | undefined {
  return db.get<MessageRow>(
    'SELECT id, workspace_id, sender_session_id, target_session_id, message_type, content, status, created_at, metadata_json FROM message WHERE id = ?1',
    [messageId],
  );
}

export function listMessages(db: SqlExecutor, limit: number): MessageRow[] {
  return db.all<MessageRow>(
    `SELECT id, workspace_id, sender_session_id, target_session_id, message_type, content, status, created_at, metadata_json
     FROM message ORDER BY created_at DESC LIMIT ?1`,
    [limit],
  );
}

export function hasAgentSentMessageSince(db: SqlExecutor, agentSessionId: string, since: string): boolean {
  const count = db.pluck<number>(
    'SELECT COUNT(*) FROM message WHERE sender_session_id = ?1 AND created_at > ?2',
    [agentSessionId, since],
  );
  return Number(count ?? 0) > 0;
}

export function updateMessageStatus(db: SqlExecutor, messageId: string, status: string): void {
  db.run('UPDATE message SET status = ?1 WHERE id = ?2', [status, messageId]);
}

export function updateMessageMetadata(db: SqlExecutor, messageId: string, metadataJson: string | null): void {
  db.run('UPDATE message SET metadata_json = ?1 WHERE id = ?2', [metadataJson, messageId]);
}

export function addToInbox(db: SqlExecutor, sessionId: string, messageId: string, priority: number, createdAt: string): number {
  const result = db.run(
    "INSERT INTO inbox (session_id, message_id, priority, status, created_at) VALUES (?1, ?2, ?3, 'unread', ?4)",
    [sessionId, messageId, priority, createdAt],
  );
  return Number(result.lastInsertRowid);
}

export function getUnreadInbox(db: SqlExecutor, sessionId: string, limit: number): InboxRow[] {
  return db.all<InboxRow>(
    `SELECT id, session_id, message_id, priority, status, created_at FROM inbox
     WHERE session_id = ?1 AND status = 'unread' ORDER BY priority DESC, id ASC LIMIT ?2`,
    [sessionId, limit],
  );
}

export function countUnreadInbox(db: SqlExecutor, sessionId: string): number {
  const count = db.pluck<number>("SELECT COUNT(*) FROM inbox WHERE session_id = ?1 AND status = 'unread'", [sessionId]);
  return Number(count ?? 0);
}

export function markInboxProcessed(db: SqlExecutor, inboxIds: readonly number[]): void {
  if (inboxIds.length === 0) return;
  const placeholders = inboxIds.map(() => '?').join(',');
  db.run(`UPDATE inbox SET status = 'processed' WHERE id IN (${placeholders})`, inboxIds);
}

export function markInboxProcessedByMessage(db: SqlExecutor, sessionId: string, messageId: string): void {
  db.run(
    "UPDATE inbox SET status = 'processed' WHERE session_id = ?1 AND message_id = ?2 AND status = 'unread'",
    [sessionId, messageId],
  );
}

export function getUnreadInboxMessages(db: SqlExecutor, sessionId: string): MessageRow[] {
  return db.all<MessageRow>(
    `SELECT m.id, m.workspace_id, m.sender_session_id, m.target_session_id,
            m.message_type, m.content, m.status, m.created_at, m.metadata_json
     FROM inbox i JOIN message m ON m.id = i.message_id
     WHERE i.session_id = ?1 AND i.status = 'unread' ORDER BY i.id ASC`,
    [sessionId],
  );
}

export function getAllUnreadInbox(db: SqlExecutor): InboxRow[] {
  return db.all<InboxRow>(
    `SELECT id, session_id, message_id, priority, status, created_at FROM inbox
     WHERE status = 'unread' ORDER BY priority DESC, id ASC`,
  );
}

export function saveDocument(db: SqlExecutor, record: DocumentRecord): void {
  db.run(
    `INSERT OR REPLACE INTO document (id, workspace_id, doc_type, title, content, version, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    [
      record.id, record.workspaceId, record.docType, record.title, record.content,
      record.version, record.updatedBy, record.updatedAt,
    ],
  );
}

export function getDocument(db: SqlExecutor, docId: string): DocumentRow | undefined {
  return db.get<DocumentRow>(
    'SELECT id, workspace_id, doc_type, title, content, version, updated_by, updated_at FROM document WHERE id = ?1',
    [docId],
  );
}

export function listDocuments(db: SqlExecutor): DocumentRow[] {
  return db.all<DocumentRow>(
    'SELECT id, workspace_id, doc_type, title, content, version, updated_by, updated_at FROM document ORDER BY updated_at DESC',
  );
}

export function setContext(db: SqlExecutor, record: ContextRecord): void {
  db.run(
    `INSERT OR REPLACE INTO context (workspace_id, key, value_json, updated_by, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
    [record.workspaceId, record.key, record.valueJson, record.updatedBy, record.updatedAt],
  );
}

export function getContext(db: SqlExecutor, key: string): ContextRow | undefined {
  return db.get<ContextRow>(
    'SELECT workspace_id, key, value_json, updated_by, updated_at FROM context WHERE key = ?1',
    [key],
  );
}

export function listContext(db: SqlExecutor): ContextRow[] {
  return db.all<ContextRow>(
    'SELECT workspace_id, key, value_json, updated_by, updated_at FROM context ORDER BY key',
  );
}
