/**
 * `chat.send@1` for the Super inbox (super_session/inbox.rs:900-973): send_message.rs
 * `run_send_message_pipeline_owned` on the chat-owned send execution, plus the goal/runtime.rs turn-end hooks.
 * The delivery owns the stream registration; the pipeline saves the user message (skip_user_message_save = None).
 */
import type { WindowRef } from '../../../kernel/api.ts';
import type { BackgroundTasks } from '../../../platform/diagnostics/api.ts';
import type { SendMessagePipeline, SendMessageRequest } from '../../agent-orchestration/api.ts';
import { escapeXmlContent } from '../../agent-workspace/portable.ts';
import type { BackendSendRequest, ChatSessionService, ChatV2State, SendPipelinePort } from '../../chat/api.ts';

export const SUPER_INBOX_SEND_SERVICE = 'chat.send@1';

export interface SuperInboxSendDeps {
  sessions(): ChatSessionService;
  state(): ChatV2State | undefined;
  background(): BackgroundTasks | undefined;
  /** `undefined` once chat-pipeline is disposed: a pending goal continuation then stops (goal/runtime.rs). */
  port(): SendPipelinePort | undefined;
  /** goal/runtime.rs:435 `resolve_emit_window`. */
  resolveWindow(): WindowRef | null;
  emit(event: string, payload: unknown): void;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Service "${name}" is not published; chat.send@1 cannot run the send pipeline without it.`);
  return value;
}

function backendRequest(request: SendMessageRequest): BackendSendRequest {
  return {
    sessionId: request.sessionId,
    content: request.content,
    options: { ...request.options, skipUserMessageSave: request.skipUserMessageSave },
    userMessageId: request.userMessageId,
    assistantMessageId: request.assistantMessageId,
    userContextRefs: request.userContextRefs,
    pathMap: request.pathMap,
    workspaceId: request.workspaceId,
  };
}

export function createSuperInboxSendPipeline(deps: SuperInboxSendDeps): SendMessagePipeline {
  const port = (): SendPipelinePort => required(deps.port(), 'chatPipeline');
  let goals: ReturnType<ChatSessionService['createGoalRuntime']> | undefined;
  const goalRuntime = () => goals ??= deps.sessions().createGoalRuntime({
    state: required(deps.state(), 'chatState'),
    background: required(deps.background(), 'backgroundTasks'),
    pipeline: deps.port,
    resolveWindow: deps.resolveWindow,
    events: { emit: deps.emit },
    escapeObjective: escapeXmlContent,
  });
  return {
    runSendMessage: (window, request, registration) => deps.sessions()
      .createSendExecution(port(), required(deps.state(), 'chatState'))
      .runSendMessage(window, backendRequest(request), registration),
    spawnGoalContinuation: (window, sessionId) => { goalRuntime().spawnContinuation(window, sessionId); },
    settleActiveGoal: (window, sessionId, status) => { goalRuntime().settleActive(window, sessionId, status); },
  };
}
