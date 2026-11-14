// workspace/emitter.rs —— 工作区事件发射器。
//
// Rust 版本持有 `AppHandle` 直接 emit；Node/Host 侧产线代码只接受注入的事件回调
// （不导入 kernel），载荷字段名与 Rust serde 输出逐字一致（均为 snake_case）。
import type { WorkspaceAgent, WorkspaceDocument, WorkspaceMessage } from '../../api.ts';
import { silentWorkspaceLogger, type WorkspaceLogger } from './logger.ts';

export const workspaceEvents = {
  MESSAGE_RECEIVED: 'workspace_message_received',
  AGENT_JOINED: 'workspace_agent_joined',
  AGENT_LEFT: 'workspace_agent_left',
  AGENT_STATUS_CHANGED: 'workspace_agent_status_changed',
  DOCUMENT_UPDATED: 'workspace_document_updated',
  WORKSPACE_CLOSED: 'workspace_closed',
  COORDINATOR_AWAKENED: 'workspace_coordinator_awakened',
  WORKSPACE_WARNING: 'workspace_warning',
} as const;

export type WorkspaceEventName = (typeof workspaceEvents)[keyof typeof workspaceEvents];

/** Rust `log::warn!` 文案里的事件短名（与 emitter.rs 逐条一致）。 */
const EVENT_LOG_NAMES: Record<WorkspaceEventName, string> = {
  workspace_message_received: 'message_received',
  workspace_agent_joined: 'agent_joined',
  workspace_agent_left: 'agent_left',
  workspace_agent_status_changed: 'agent_status_changed',
  workspace_document_updated: 'document_updated',
  workspace_closed: 'workspace_closed',
  workspace_coordinator_awakened: 'coordinator_awakened',
  workspace_warning: 'workspace_warning',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MessagePayload {
  id: string;
  sender_session_id: string;
  target_session_id: string | null;
  message_type: string;
  content: string;
  status: string;
  created_at: string;
}

export interface WorkspaceMessageEvent {
  workspace_id: string;
  message: MessagePayload;
}

export interface AgentPayload {
  session_id: string;
  role: string;
  status: string;
  skill_id: string | null;
  joined_at: string;
  last_active_at: string;
}

export interface WorkspaceAgentEvent {
  workspace_id: string;
  agent: AgentPayload;
}

export interface AgentStatusEvent {
  workspace_id: string;
  session_id: string;
  status: string;
}

export interface DocumentPayload {
  id: string;
  doc_type: string;
  title: string;
  version: number;
  updated_by: string;
  updated_at: string;
}

export interface WorkspaceDocumentEvent {
  workspace_id: string;
  document: DocumentPayload;
}

export interface WorkspaceClosedEvent {
  workspace_id: string;
}

export interface CoordinatorAwakenedEvent {
  workspace_id: string;
  coordinator_session_id: string;
  sleep_id: string;
  awakened_by: string;
  awaken_message: string | null;
  wake_reason: string;
}

export interface WorkspaceWarningEvent {
  workspace_id: string;
  code: string;
  message: string;
  agent_session_id: string | null;
  message_id: string | null;
  retry_count: number | null;
  max_retries: number | null;
}

/** Host 侧事件出口（由组合根注入 kernel 的 emit，测试注入记录器）。 */
export type WorkspaceEventSink = (event: WorkspaceEventName, payload: unknown) => void;

export function messagePayload(message: WorkspaceMessage): MessagePayload {
  return {
    id: message.id,
    sender_session_id: message.senderSessionId,
    target_session_id: message.targetSessionId,
    message_type: message.messageType,
    content: message.content,
    status: message.status,
    created_at: message.createdAt,
  };
}

export function agentPayload(agent: WorkspaceAgent): AgentPayload {
  return {
    session_id: agent.sessionId,
    role: agent.role,
    status: agent.status,
    skill_id: agent.skillId,
    joined_at: agent.joinedAt,
    last_active_at: agent.lastActiveAt,
  };
}

export function documentPayload(document: WorkspaceDocument): DocumentPayload {
  return {
    id: document.id,
    doc_type: document.docType,
    title: document.title,
    version: document.version,
    updated_by: document.updatedBy,
    updated_at: document.updatedAt,
  };
}

export class WorkspaceEmitter {
  private readonly sink: WorkspaceEventSink | null;
  private readonly logger: WorkspaceLogger;

  constructor(
    sink: WorkspaceEventSink | null,
    logger: WorkspaceLogger = silentWorkspaceLogger,
  ) {
    this.sink = sink;
    this.logger = logger;
  }

  /** Rust `emit(...).map_err(|e| log::warn!(...))`：事件失败不改变业务结果。 */
  private send(event: WorkspaceEventName, payload: unknown): void {
    if (!this.sink) return;
    try {
      this.sink(event, payload);
    } catch (error) {
      this.logger.warn(`[WorkspaceEmitter] Failed to emit ${EVENT_LOG_NAMES[event]}: ${messageOf(error)}`);
    }
  }

  emitMessageReceived(workspaceId: string, message: WorkspaceMessage): void {
    const event: WorkspaceMessageEvent = { workspace_id: workspaceId, message: messagePayload(message) };
    this.send(workspaceEvents.MESSAGE_RECEIVED, event);
  }

  emitAgentJoined(workspaceId: string, agent: WorkspaceAgent): void {
    const event: WorkspaceAgentEvent = { workspace_id: workspaceId, agent: agentPayload(agent) };
    this.send(workspaceEvents.AGENT_JOINED, event);
  }

  emitAgentLeft(workspaceId: string, sessionId: string): void {
    const event: WorkspaceAgentEvent = {
      workspace_id: workspaceId,
      agent: {
        session_id: sessionId,
        role: '',
        status: 'left',
        skill_id: null,
        joined_at: '',
        last_active_at: '',
      },
    };
    this.send(workspaceEvents.AGENT_LEFT, event);
  }

  emitAgentStatusChanged(workspaceId: string, sessionId: string, status: string): void {
    const event: AgentStatusEvent = { workspace_id: workspaceId, session_id: sessionId, status };
    this.send(workspaceEvents.AGENT_STATUS_CHANGED, event);
  }

  emitDocumentUpdated(workspaceId: string, document: WorkspaceDocument): void {
    const event: WorkspaceDocumentEvent = {
      workspace_id: workspaceId,
      document: documentPayload(document),
    };
    this.send(workspaceEvents.DOCUMENT_UPDATED, event);
  }

  emitWorkspaceClosed(workspaceId: string): void {
    const event: WorkspaceClosedEvent = { workspace_id: workspaceId };
    this.send(workspaceEvents.WORKSPACE_CLOSED, event);
  }

  emitCoordinatorAwakened(
    workspaceId: string,
    coordinatorSessionId: string,
    sleepId: string,
    awakenedBy: string,
    awakenMessage: string | null,
    wakeReason: string,
  ): void {
    const event: CoordinatorAwakenedEvent = {
      workspace_id: workspaceId,
      coordinator_session_id: coordinatorSessionId,
      sleep_id: sleepId,
      awakened_by: awakenedBy,
      awaken_message: awakenMessage,
      wake_reason: wakeReason,
    };
    if (!this.sink) {
      this.logger.warn('[WorkspaceEmitter] No app_handle, cannot emit coordinator_awakened');
      return;
    }
    this.send(workspaceEvents.COORDINATOR_AWAKENED, event);
  }

  emitWarning(warning: WorkspaceWarningEvent): void {
    this.send(workspaceEvents.WORKSPACE_WARNING, warning);
  }
}
