/**
 * Workspace commands that only delegate to L05 `WorkspaceCoordinator`.
 * Rust source: `chat_v2/handlers/workspace_handlers.rs:607-1075`.
 *
 * Commands that need the L03 execution runtime (`workspace_run_agent`,
 * `workspace_cancel_agent`, ...) or L05's task manager are not registered.
 */
import { CommandError } from '../../../kernel/api.ts';
import type {
  AgentInfo, CreateWorkspaceRequest, CreateWorkspaceResponse, DocumentInfo,
  MessageInfo, SendMessageResponse, WorkspaceInfo, WorkspaceSendMessageRequest,
} from '../api.ts';
import { AgentProfileResolver } from '../../agent-workspace/portable.ts';
import type { JsonValue, WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { listActiveWorkspaceIndex } from '../repository/workspaces.ts';
import { ChatV2Error } from './error.ts';
import { databaseTimestamp } from './types.ts';
import { errorText, type ChatLogger } from './logger.ts';

/** These Rust handlers return Result<_, String>, including coordinator errors. */
export function workspaceCommandResult<T>(operation: () => T): T {
  try { return operation(); } catch (error) {
    if (error instanceof CommandError) throw error;
    throw new CommandError(errorText(error));
  }
}

/** `chat_v2::types::MessageType` values in serde-kebab order. */
type WorkspaceMessageType = 'task' | 'progress' | 'result' | 'query' | 'correction' | 'broadcast';

export function requireCoordinator(coordinator: WorkspaceCoordinator | undefined): WorkspaceCoordinator {
  if (coordinator === undefined) {
    throw new ChatV2Error('Other', 'WorkspaceCoordinator is not available');
  }
  return coordinator;
}

/** `ensure_workspace_creator` (workspace_handlers.rs:583-599). */
export function ensureWorkspaceCreator(
  coordinator: WorkspaceCoordinator, workspaceId: string, sessionId: string,
): void {
  const workspace = coordinator.getWorkspace(workspaceId);
  if (workspace === null) {
    throw new CommandError(`Workspace not found: ${workspaceId}`);
  }
  if (workspace.creatorSessionId !== sessionId) {
    throw new CommandError('Permission denied: only workspace creator can perform this action');
  }
}

/** `workspace_create` (workspace_handlers.rs:607-621). */
export function workspaceCreateAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, request: CreateWorkspaceRequest,
): CreateWorkspaceResponse {
  const workspace = requireCoordinator(coordinator).createWorkspace(sessionId, request.name ?? null);
  return {
    workspace_id: workspace.id,
    name: workspace.name,
    status: workspace.status.toLowerCase(),
  };
}

/** `workspace_get` (workspace_handlers.rs:623-641). */
export function workspaceGetAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, workspaceId: string,
): WorkspaceInfo | null {
  const service = requireCoordinator(coordinator);
  service.ensureMemberOrCreator(workspaceId, sessionId);
  const workspace = service.getWorkspace(workspaceId);
  if (workspace === null) return null;
  return {
    id: workspace.id,
    name: workspace.name,
    status: workspace.status.toLowerCase(),
    creator_session_id: workspace.creatorSessionId,
    created_at: databaseTimestamp(workspace.createdAt),
    updated_at: databaseTimestamp(workspace.updatedAt),
  };
}

/** Rust `.ok().flatten()` intentionally discards invalid persisted profiles. */
function agentProfileId(metadata: JsonValue | undefined): string | null {
  try { return AgentProfileResolver.fromMetadata(metadata)?.id ?? null; }
  catch { return null; }
}

/** Rust unwrap_or(0), no warning on this particular lookup failure. */
function pendingInboxCount(service: WorkspaceCoordinator, workspaceId: string, sessionId: string): number {
  try { return service.pendingInboxCount(workspaceId, sessionId); }
  catch { return 0; }
}

/** `workspace_list_agents` (workspace_handlers.rs:867-901). */
export function workspaceListAgentsAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, workspaceId: string,
): AgentInfo[] {
  const service = requireCoordinator(coordinator);
  service.ensureMemberOrCreator(workspaceId, sessionId);
  return service.listAgents(workspaceId).map(agent => ({
    session_id: agent.sessionId,
    role: agent.role.toLowerCase(),
    status: agent.status.toLowerCase(),
    skill_id: agent.skillId,
    agent_profile_id: agentProfileId(agent.metadata),
    pending_inbox_count: pendingInboxCount(service, workspaceId, agent.sessionId),
    joined_at: databaseTimestamp(agent.joinedAt),
    last_active_at: databaseTimestamp(agent.lastActiveAt),
  }));
}

/** `workspace_send_message` (workspace_handlers.rs:903-934). */
export function workspaceSendMessageAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, request: WorkspaceSendMessageRequest,
): SendMessageResponse {
  const messageType: WorkspaceMessageType = request.message_type === 'progress'
    || request.message_type === 'result' || request.message_type === 'query'
    || request.message_type === 'correction' || request.message_type === 'broadcast'
    ? request.message_type : 'task';
  if (request.target_session_id !== null && request.target_session_id !== undefined
    && messageType === 'broadcast') {
    throw new CommandError('Broadcast message must not specify target_session_id');
  }
  const message = requireCoordinator(coordinator).sendMessage(
    request.workspace_id, sessionId, request.target_session_id ?? null, messageType, request.content);
  return {
    message_id: message.id,
    is_broadcast: request.target_session_id === null || request.target_session_id === undefined,
  };
}

/** `workspace_list_messages` (workspace_handlers.rs:936-959). */
export function workspaceListMessagesAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, workspaceId: string,
  limit: number | null,
): MessageInfo[] {
  const service = requireCoordinator(coordinator);
  service.ensureMemberOrCreator(workspaceId, sessionId);
  return service.listMessages(workspaceId, limit ?? 50).map(message => ({
    id: message.id,
    sender_session_id: message.senderSessionId,
    target_session_id: message.targetSessionId,
    message_type: message.messageType.toLowerCase(),
    content: message.content,
    status: message.status.toLowerCase(),
    created_at: databaseTimestamp(message.createdAt),
  }));
}

/** `workspace_set_context` (workspace_handlers.rs:961-971). */
export function workspaceSetContextAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, workspaceId: string,
  key: string, value: unknown,
): void {
  requireCoordinator(coordinator).setContext(workspaceId, key, value as JsonValue, sessionId);
}

/** `workspace_get_context` (workspace_handlers.rs:973-984). */
export function workspaceGetContextAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, workspaceId: string, key: string,
): unknown {
  const service = requireCoordinator(coordinator);
  service.ensureMemberOrCreator(workspaceId, sessionId);
  return service.getContext(workspaceId, key)?.value ?? null;
}

/** `workspace_list_documents` (workspace_handlers.rs:986-1007). */
export function workspaceListDocumentsAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, workspaceId: string,
): DocumentInfo[] {
  const service = requireCoordinator(coordinator);
  service.ensureMemberOrCreator(workspaceId, sessionId);
  return service.listDocuments(workspaceId).map(document => ({
    id: document.id,
    doc_type: document.docType.toLowerCase(),
    title: document.title,
    version: document.version,
    updated_by: document.updatedBy,
    updated_at: databaseTimestamp(document.updatedAt),
  }));
}

/** `workspace_get_document` (workspace_handlers.rs:1009-1020). */
export function workspaceGetDocumentAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, workspaceId: string,
  documentId: string,
): string | null {
  const service = requireCoordinator(coordinator);
  service.ensureMemberOrCreator(workspaceId, sessionId);
  return service.getDocument(workspaceId, documentId)?.content ?? null;
}

/** `workspace_list_all` (workspace_handlers.rs:1022-1074). */
export function workspaceListAllAction(
  coordinator: WorkspaceCoordinator | undefined, sessionId: string, db: DatabaseHandle,
  log: ChatLogger,
): WorkspaceInfo[] {
  const service = requireCoordinator(coordinator);
  const result: WorkspaceInfo[] = [];
  for (const workspace of listActiveWorkspaceIndex(db)) {
    try {
      if (service.isMemberOrCreatorSession(workspace.id, sessionId)) result.push(workspace);
    } catch (error) {
      log.warn(`[Workspace::handlers] Failed to check workspace membership: workspace_id=${workspace.id}, error=${errorText(error)}`);
    }
  }
  return result;
}
