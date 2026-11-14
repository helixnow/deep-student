/**
 * `chatWorkerRuntime`: workspace_handlers.rs worker runtime for the L05/L06 executors
 * (WorkspaceTool workspace_executor.rs:351, Subagent subagent_executor.rs:203/266,
 * SuperSession super_session_executor.rs:206) plus the ChatV2Repo session seam they use.
 */
import type { WindowRef } from '../../../kernel/api.ts';
import type { JsonValue, WorkspaceAgentSessionStore, WorkspaceCoordinator } from '../../agent-workspace/api.ts';
import type { ChatSession, ChatV2Database, RunAgentRequest, RunAgentResponse } from '../api.ts';
import { createSession, getSession } from '../repository/sessions.ts';
import { ChatV2Error } from './error.ts';
import type { ChatLogger } from './logger.ts';
import type { ChatV2State } from './state.ts';
import { requireCoordinator } from './workspace-actions.ts';
import { cancelWorkspaceAgentBackend } from './workspace-runtime.ts';
import { runWorkspaceAgentBackend, type WorkerRuntimeDeps } from './workspace-run-agent.ts';

export interface ChatWorkerRuntimeService {
  /** False until L03 `execute` and the L05/L06 worker surfaces are bound (same gate as `workspace_run_agent`). */
  isRunAvailable(): boolean;
  /** `run_workspace_agent_backend`; Rust `Err(String)` rejects with an Error carrying that text. */
  runWorkspaceAgentBackend(request: RunAgentRequest, window: WindowRef): Promise<RunAgentResponse>;
  /** `cancel_workspace_agent_backend`: trusted backend entry, no membership check. */
  cancelWorkspaceAgentBackend(workspaceId: string, agentSessionId: string): Promise<void>;
  /** `ChatV2Repo::get_session_with_conn` / `create_session_with_conn` on the chat_v2 database. */
  readonly sessionStore: WorkspaceAgentSessionStore;
}

export interface WorkerRuntimeServiceDeps {
  db: ChatV2Database;
  state: ChatV2State;
  log: ChatLogger;
  coordinator: () => WorkspaceCoordinator | undefined;
  runtime: () => WorkerRuntimeDeps | undefined;
}

type WorkspaceAgentSessionRecord = Parameters<WorkspaceAgentSessionStore['createSession']>[0];

function chatSessionFromRecord(record: WorkspaceAgentSessionRecord): ChatSession {
  return {
    id: record.id, mode: record.mode, title: record.title, description: record.description,
    summaryHash: record.summary_hash, titleLocked: record.title_locked, persistStatus: record.persist_status,
    createdAt: record.created_at, updatedAt: record.updated_at, metadata: record.metadata,
    groupId: record.group_id, tagsHash: record.tags_hash, tags: record.tags,
  };
}

export function createWorkerRuntimeService(deps: WorkerRuntimeServiceDeps): ChatWorkerRuntimeService {
  return {
    isRunAvailable: () => deps.runtime() !== undefined,
    async runWorkspaceAgentBackend(request, window) {
      const runtime = deps.runtime();
      if (runtime === undefined) {
        throw new ChatV2Error('Other', 'Worker runtime is not available: chat pipeline execute or workspace surfaces missing');
      }
      return runWorkspaceAgentBackend(runtime, request, window);
    },
    cancelWorkspaceAgentBackend: (workspaceId, agentSessionId) => cancelWorkspaceAgentBackend(
      requireCoordinator(deps.coordinator()), deps.state, workspaceId, agentSessionId, deps.log),
    sessionStore: {
      sessionMetadata: sessionId => (getSession(deps.db.getConn(), sessionId)?.metadata ?? null) as JsonValue | null,
      createSession: record => createSession(deps.db.getConn(), chatSessionFromRecord(record)),
    },
  };
}
