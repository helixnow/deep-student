/**
 * Worker runtime: `run_workspace_agent_backend` and the three commands that
 * enter it (`workspace_run_agent`, `workspace_create_agent`,
 * `workspace_restore_executions`). Rust source:
 * `chat_v2/handlers/workspace_handlers.rs:107-302, 680-864, 1075-2137, 2336-2636`.
 *
 * Cross-lane surfaces: L05 coordinator/task/sleep managers, profile resolver,
 * card read scope and completion outbox; L03 `execute` + `attachChildToTree`;
 * L06 `headlessToolSchemas`. The commands are registered only when every
 * required surface is published (see `workerRuntimeSurfaces`).
 */
import {
  AgentProfileResolver, CHATANKI_READONLY_TOOLS, installWorkspaceCardReadScope, newSubagentTask,
  nowCompletionTimestamp, WORKSPACE_WORKER_READY_EVENT, MAX_CONCURRENT_WORKERS, MAX_SUBAGENT_DEPTH,
  WORKER_PIPELINE_CANCEL_GRACE_SECS, WORKER_PIPELINE_TIMEOUT_SECS,
} from '../../agent-workspace/portable.ts';
import type {
  AgentCompletionOutbox, AgentRuntimeConfig, JsonValue, SubagentTaskManager,
  WorkspaceAgent, WorkspaceCardReadScopeGuard, WorkspaceCoordinator,
} from '../../agent-workspace/api.ts';
import { headlessToolSchemas, isAttemptCompletion } from '../../agent-orchestration/portable.ts';
import type { ChildBudgetAttachment, DelegatedBudgetSpec } from '../../chat-pipeline/api.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import { rustTrim } from '../../../platform/util/index.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type {
  ChatV2Database, CreateAgentRequest, CreateAgentResponse, RestoreExecutionsResponse, RunAgentRequest,
  RunAgentResponse, TokenUsage, UnknownSubagentTaskInfo,
} from '../api.ts';
import type { BackendSendRequest } from './send-message.ts';
import { ChatV2Error } from './error.ts';
import { StreamGuard, type ChatV2State } from './state.ts';
import { getSession, createSession } from '../repository/sessions.ts';
import { getMessage } from '../repository/messages.ts';
import { getMessageBlocks } from '../repository/blocks.ts';
import { generateMessageId } from './message-values.ts';
import { newSession } from './types.ts';
import { issueWorkerGrant, type GrantRegistrationGuard } from './grants.ts';
import { debugTaskError, type CompletionDispatcherRuntime } from './completion-dispatcher.ts';
import { Semaphore } from './semaphore.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { ulid } from './ulid.ts';

/** `WORKER_RESULT_SUMMARY_MAX_CHARS`. */
export const WORKER_RESULT_SUMMARY_MAX_CHARS = 4000;
const RESTORE_REMINDER = '继续执行上次中断任务（恢复）';

/** McpToolSchema serialized shape (`rename_all = "camelCase"`, None fields skipped). */
export interface WorkerToolSchema { name: string; description?: string; inputSchema?: unknown }

// ============================================================
// Late-published cross-lane surfaces
// ============================================================

/** L03 execution seam + budget attach (pipeline.rs:599, budget.rs). */
export interface WorkerPipelinePort {
  execute(window: WindowRef, request: BackendSendRequest, cancellation: AbortSignal, state: ChatV2State | null): Promise<string>;
  attachChildToTree(parentSessionId: string, childSessionId: string, declared?: DelegatedBudgetSpec | null): ChildBudgetAttachment;
}
export interface WorkerRuntimeSurfaces {
  /** L06 `headlessToolSchemas` (headless.rs:664). */
  headlessToolSchemas: () => WorkerToolSchema[];
  /** L05 `CHATANKI_READONLY_TOOLS` (custom_agents.rs). */
  chatankiReadonlyTools: readonly string[];
}

/**
 * Feature detection for surfaces requested from L06/L05 but not yet on main.
 * Returns null while any is missing: the worker commands stay unregistered
 * rather than running with a silently reduced tool face.
 */
export function workerRuntimeSurfaces(): WorkerRuntimeSurfaces | null {
  const schemas: unknown = headlessToolSchemas;
  const chatanki: unknown = CHATANKI_READONLY_TOOLS;
  if (typeof schemas !== 'function' || !Array.isArray(chatanki)
    || !chatanki.every(entry => typeof entry === 'string')) return null;
  return {
    headlessToolSchemas: () => (schemas as () => WorkerToolSchema[])(),
    chatankiReadonlyTools: chatanki as readonly string[],
  };
}

export interface WorkerRuntimeDeps {
  coordinator: WorkspaceCoordinator;
  state: ChatV2State;
  db: ChatV2Database;
  pipeline: WorkerPipelinePort;
  outbox: AgentCompletionOutbox | undefined;
  surfaces: WorkerRuntimeSurfaces;
  emit: (event: string, payload: unknown) => void;
  log: ChatLogger;
}

// ============================================================
// Helpers (workspace_handlers.rs:107-302)
// ============================================================

let workerSemaphores: Semaphore[] | null = null;

/** `worker_pipeline_semaphore_for_depth`: one pool per depth; 0/out-of-range clamp. */
function workerSemaphoreForDepth(depth: number): Semaphore {
  workerSemaphores ??= Array.from({ length: MAX_SUBAGENT_DEPTH }, () => new Semaphore(MAX_CONCURRENT_WORKERS));
  const index = Math.min(Math.max(depth, 1), MAX_SUBAGENT_DEPTH) - 1;
  return workerSemaphores[index]!;
}

function metadataField(metadata: unknown, key: string): unknown {
  return metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)[key] : undefined;
}
/** `Value::as_u64`. */
function asU64(value: unknown): number | null {
  if (typeof value === 'bigint') return value >= 0n ? Number(value) : null;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
function asStr(value: unknown): string | null { return typeof value === 'string' ? value : null; }
/** `u64 as u32`. */
function asU32(value: number): number { return Number(BigInt.asUintN(32, BigInt(value))); }

/** `worker_depth_for_scheduling`: any read failure → 1; 0 → 1. */
function workerDepthForScheduling(db: ChatV2Database, agentSessionId: string): number {
  let depth = 1;
  try {
    const session = getSession(db.getConnSafe(), agentSessionId);
    const value = asU64(metadataField(session?.metadata, 'subagent_depth'));
    if (value !== null) depth = asU32(value);
  } catch { depth = 1; }
  return depth === 0 ? 1 : depth;
}

/** `fail_with_drained_rollback`. */
function failWithDrainedRollback(coordinator: WorkspaceCoordinator, workspaceId: string, agentSessionId: string,
  drainedMessageIds: readonly string[], error: string, log: ChatLogger): string {
  const failures: string[] = [];
  for (const messageId of drainedMessageIds) {
    try { coordinator.reEnqueueMessage(workspaceId, agentSessionId, messageId); }
    catch (reason) {
      const detail = `message_id=${messageId}, error=${errorText(reason)}`;
      failures.push(detail);
      log.error(`[Workspace::handlers] Failed to re-enqueue drained message on aborted run: agent_session_id=${agentSessionId}, ${detail}`);
    }
  }
  if (failures.length === 0) return error;
  coordinator.emitWarning({
    workspace_id: workspaceId, code: 'run_agent_requeue_failed',
    message: `Worker run for ${agentSessionId} aborted (${error}), and ${failures.length} drained message(s) could not be re-queued. Please retry the task manually.`,
    agent_session_id: agentSessionId, message_id: drainedMessageIds[0] ?? null, retry_count: null, max_retries: null,
  });
  return `${error} (${failures.length} drained message(s) additionally failed to restore to the inbox; please retry manually)`;
}

/** `truncate_chars`: Unicode scalar count, `…` suffix. */
export function truncateChars(text: string, maxChars: number): string {
  const chars = [...text];
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('')}…`;
}

/** serde_json `invalid type` wording for the persona skill snapshot decode. */
function serdeKind(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return `boolean \`${value}\``;
  if (typeof value === 'number') return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  return Array.isArray(value) ? 'sequence' : 'map';
}

/** `resolve_profile_skill_snapshot`. */
export function resolveProfileSkillSnapshot(skillIds: readonly string[], metadata: unknown): Map<string, string> {
  if (skillIds.length === 0) return new Map();
  const raw = metadataField(metadata, 'profile_skill_contents');
  const available = new Map<string, string>();
  if (raw !== undefined) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Invalid persisted persona skill snapshot: invalid type: ${serdeKind(raw)}, expected a map`);
    }
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value !== 'string') {
        throw new Error(`Invalid persisted persona skill snapshot: invalid type: ${serdeKind(value)}, expected a string`);
      }
      available.set(key, value);
    }
  }
  const selected = new Map<string, string>();
  const missing: string[] = [];
  for (const skillId of skillIds) {
    const content = available.get(skillId);
    if (content === undefined) missing.push(skillId);
    else selected.set(skillId, content);
  }
  if (missing.length > 0) {
    throw new Error(`Persisted persona skill snapshot is missing [${missing.join(', ')}]; refusing to run with silently ignored skills`);
  }
  return selected;
}

/** `worker_assistant_output`: last successful attempt_completion result, else joined content blocks. */
export function workerAssistantOutput(db: ChatV2Database, assistantMessageId: string): string | null {
  let blocks;
  try { blocks = getMessageBlocks(db.getConnSafe(), assistantMessageId); } catch { return null; }
  for (const block of [...blocks].reverse()) {
    if (block.status !== 'success' || block.toolName == null || !isAttemptCompletion(block.toolName)) continue;
    const result = rustTrim(asStr(metadataField(block.toolOutput, 'result')) ?? '');
    if (result !== '') return result;
  }
  const output = rustTrim(blocks.filter(block => block.type === 'content')
    .flatMap(block => block.content == null ? [] : [block.content]).join('\n'));
  return output === '' ? null : output;
}

/** `summarize_worker_assistant_message`. */
function summarizeWorkerAssistantMessage(db: ChatV2Database, assistantMessageId: string): string | null {
  const output = workerAssistantOutput(db, assistantMessageId);
  return output === null ? null : truncateChars(output, WORKER_RESULT_SUMMARY_MAX_CHARS);
}

/** `worker_message_usage`: message meta usage → active variant → any variant. */
export function workerMessageUsage(db: ChatV2Database, assistantMessageId: string): TokenUsage | null {
  let message;
  try { message = getMessage(db.getConnSafe(), assistantMessageId); } catch { return null; }
  if (message === null) return null;
  if (message._meta?.usage != null) return message._meta.usage;
  const variants = message.variants;
  if (variants == null) return null;
  const active = message.activeVariantId ?? null;
  return variants.find(variant => active !== null && variant.id === active)?.usage
    ?? variants.find(variant => variant.usage != null)?.usage ?? null;
}

// ============================================================
// Worker tool schemas (workspace_handlers.rs:1107-1262, 1597-1651)
// ============================================================

/** `chatanki_readonly_worker_tool_schemas`. */
function chatankiReadonlyWorkerToolSchemas(): WorkerToolSchema[] {
  return [
    {
      name: 'builtin-chatanki_get_cards',
      description: '分页读回制卡文档的卡片内容（只读）。documentId 从任务消息中获取；同 workspace coordinator 拥有的文档可读，跨 workspace 一律不可见。',
      inputSchema: {
        type: 'object',
        properties: {
          documentId: { type: 'string', description: '制卡文档 ID（必需，从任务消息中获取）' },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
          filter: { type: 'string', enum: ['all', 'error_only', 'edited_only'], default: 'all' },
        },
        required: ['documentId'],
      },
    },
    {
      name: 'builtin-chatanki_status',
      description: '查询制卡文档的生成进度与卡片统计（只读）。documentId 从任务消息中获取。',
      inputSchema: {
        type: 'object',
        properties: { documentId: { type: 'string', description: '制卡文档 ID（必需）' } },
        required: ['documentId'],
      },
    },
    {
      name: 'builtin-chatanki_analyze',
      description: '预分析制卡材料（只读预估）：给出路由建议、密度指标与推荐参数，不生成任何卡片。content 与 resourceIds 至少提供一个。',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '直接文本材料' },
          goal: { type: 'string', description: '学习目标（参与路由规划）' },
          route: { type: 'string', enum: ['simple_text', 'vlm_light', 'vlm_full'], description: '可选：预演强制路由' },
          resourceIds: { type: 'array', items: { type: 'string' }, description: '可选：会话资源 ID 列表' },
        },
      },
    },
    {
      name: 'builtin-chatanki_list_templates',
      description: '列出本地可用的制卡模板（只读）。',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: '按分类/名称过滤' },
          activeOnly: { type: 'boolean', default: true },
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        },
      },
    },
  ];
}

/** `extend_worker_tool_schemas`: exact allow-list match, no duplicates (fail-closed). */
function extendWorkerToolSchemas(schemas: WorkerToolSchema[], allowedTools: readonly string[],
  surfaces: WorkerRuntimeSurfaces): void {
  for (const schema of [...surfaces.headlessToolSchemas(), ...chatankiReadonlyWorkerToolSchemas()]) {
    if (allowedTools.includes(schema.name) && !schemas.some(existing => existing.name === schema.name)) {
      schemas.push(schema);
    }
  }
}

/** `install_worker_card_read_scope`: fail-closed, any miss → no scope. */
function installWorkerCardReadScope(isWorker: boolean, allowedTools: readonly string[], agents: readonly WorkspaceAgent[],
  workspaceId: string, agentSessionId: string, surfaces: WorkerRuntimeSurfaces, log: ChatLogger): WorkspaceCardReadScopeGuard | null {
  if (!isWorker || !allowedTools.some(tool => surfaces.chatankiReadonlyTools.includes(tool))) return null;
  const coordinatorSessionId = agents.find(agent => agent.role === 'coordinator')?.sessionId;
  if (coordinatorSessionId === undefined) return null;
  try { return installWorkspaceCardReadScope(agentSessionId, workspaceId, coordinatorSessionId); }
  catch (error) {
    log.warn(`[Workspace::handlers] Failed to install card read scope for worker ${agentSessionId}: ${errorText(error)}`);
    return null;
  }
}

function workspaceCollaborationSchemas(): WorkerToolSchema[] {
  return [];
}

// ============================================================
// Completion envelope (workspace_handlers.rs:26-83)
// ============================================================

type AgentCompletionStatus = 'completed' | 'failed' | 'cancelled';
interface AgentCompletionEnvelopeInput {
  workspaceId: string; agentSessionId: string; parentSessionId: string | null; taskId: string | null;
  runId: string; correlationId: string | null; status: AgentCompletionStatus; finalOutput: string | null;
  error: string | null; completedAt: string; tokenUsage: TokenUsage | null;
}
/** Serde field order with `skip_serializing_if = "Option::is_none"`. */
/** `AgentCompletionEnvelope::metadata` = `serde_json::to_value(self)`. */
function envelopeMetadata(payload: string): JsonValue { return JSON.parse(payload); }

export function agentCompletionEnvelope(input: AgentCompletionEnvelopeInput): Record<string, unknown> {
  return {
    type: 'agent_completion',
    workspace_id: input.workspaceId,
    agent_session_id: input.agentSessionId,
    ...(input.parentSessionId === null ? {} : { parent_session_id: input.parentSessionId }),
    ...(input.taskId === null ? {} : { task_id: input.taskId }),
    run_id: input.runId,
    ...(input.correlationId === null ? {} : { correlation_id: input.correlationId }),
    status: input.status,
    ...(input.finalOutput === null ? {} : { final_output: input.finalOutput }),
    ...(input.error === null ? {} : { error: input.error }),
    completed_at: input.completedAt,
    ...(input.tokenUsage === null ? {} : { token_usage: input.tokenUsage }),
  };
}

// ============================================================
// run_workspace_agent_backend (workspace_handlers.rs:1264-2137)
// ============================================================

class ValueError extends Error {}
/** `SendOptions.strict_model_id` is `serde(skip)` (types.rs:2156); L03 reads it from the backend options. */
type WorkerSendOptions = NonNullable<BackendSendRequest['options']> & { strictModelId: boolean };

function isCancelled(error: unknown): boolean {
  return error instanceof ChatV2Error && error.kind === 'Cancelled';
}

/** Rust `{:?}` of AgentStatus/SubagentTaskStatus lowercased by `to_lowercase()` in responses. */
function titleCase(value: string): string { return value.charAt(0).toUpperCase() + value.slice(1); }

/** Pipeline with the wall-clock cap and a cancel grace window (headless-aligned). */
async function executeWithTimeout(deps: WorkerRuntimeDeps, window: WindowRef, request: BackendSendRequest,
  token: AbortController, agentSessionId: string): Promise<string> {
  const running = deps.pipeline.execute(window, request, token.signal, deps.state);
  const settled = running.then(() => 'settled' as const, () => 'settled' as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), WORKER_PIPELINE_TIMEOUT_SECS * 1000); });
  const first = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  if (first === 'settled') return running;
  deps.log.warn(`[Workspace::handlers] Worker pipeline exceeded ${WORKER_PIPELINE_TIMEOUT_SECS}s timeout, cancelling: agent=${agentSessionId}`);
  token.abort();
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([settled, new Promise<void>(resolve => {
    graceTimer = setTimeout(resolve, WORKER_PIPELINE_CANCEL_GRACE_SECS * 1000);
  })]);
  clearTimeout(graceTimer);
  throw new ChatV2Error('Other', `Worker pipeline timed out after ${WORKER_PIPELINE_TIMEOUT_SECS}s`);
}

/**
 * `run_workspace_agent_backend`. Errors are Rust `Err(String)` (thrown as Error
 * with that text); the background pipeline is tracked by `ChatV2State`.
 */
export async function runWorkspaceAgentBackend(deps: WorkerRuntimeDeps, request: RunAgentRequest,
  window: WindowRef): Promise<RunAgentResponse> {
  const { coordinator, state, db, log } = deps;
  const workspaceId = request.workspace_id;
  const agentSessionId = request.agent_session_id;
  const reminder = request.reminder ?? null;

  coordinator.ensureMemberOrCreator(workspaceId, request.requester_session_id);
  log.info(`[Workspace::handlers] [RUN_AGENT_START] workspace_run_agent: workspace_id=${workspaceId}, agent_session_id=${agentSessionId}, has_reminder=${reminder !== null}`);
  log.debug(`[Workspace::handlers] [RUN_AGENT] Step 1: Listing agents for workspace ${workspaceId}`);
  const agents = coordinator.listAgents(workspaceId);
  log.debug(`[Workspace::handlers] [RUN_AGENT] Found ${agents.length} agents in workspace ${workspaceId}`);
  const agent = agents.find(candidate => candidate.sessionId === agentSessionId);
  if (agent === undefined) throw new ValueError(`Agent not found: ${agentSessionId}`);
  const isWorker = agent.role === 'worker';
  if (agent.role === 'coordinator') {
    throw new ValueError('Coordinator agents cannot be auto-run, they are driven by user input');
  }
  if ((agent.status === 'running' || agent.status === 'queued') && state.hasActiveStream(agentSessionId)) {
    return { agent_session_id: agentSessionId, message_id: '', status: agent.status.toLowerCase() };
  }

  coordinator.updateAgentStatus(workspaceId, agentSessionId, 'queued');
  const workerDepth = workerDepthForScheduling(db, agentSessionId);
  const releasePermit = await workerSemaphoreForDepth(workerDepth).acquire();

  let streamGuard: StreamGuard | null = null;
  let spawned = false;
  try {
    let current: WorkspaceAgent | null;
    current = coordinator.getAgent(workspaceId, agentSessionId);
    if (current !== null && (current.status === 'cancelled' || current.status === 'closed')) {
      log.info(`[Workspace::handlers] [RUN_AGENT] Agent ${agentSessionId} was ${titleCase(current.status)} while queued, skipping run`);
      return { agent_session_id: agentSessionId, message_id: '', status: 'cancelled' };
    }

    log.info(`[Workspace::handlers] [RUN_AGENT] Step 2: Draining inbox for agent ${agentSessionId}`);
    const messages = coordinator.drainInbox(workspaceId, agentSessionId, 10);
    log.info(`[Workspace::handlers] [RUN_AGENT] Drained ${messages.length} messages from inbox for agent ${agentSessionId}`);
    if (messages.length === 0) {
      if (reminder !== null) {
        log.info(`[Workspace::handlers] [INBOX_EMPTY_WITH_REMINDER] P38: No inbox messages but has reminder for agent ${agentSessionId}, proceeding with reminder only`);
      } else {
        log.info(`[Workspace::handlers] [INBOX_EMPTY] No pending messages for agent ${agentSessionId}, returning success (idempotent)`);
        try { coordinator.updateAgentStatus(workspaceId, agentSessionId, 'idle'); } catch (error) { discardError(error); /* Rust `let _ =` */ }
        return { agent_session_id: agentSessionId, message_id: '', status: 'idle' };
      }
    }
    const originalMessageIds = messages.map(message => message.id);
    const rollback = (error: string) => new ValueError(
      failWithDrainedRollback(coordinator, workspaceId, agentSessionId, originalMessageIds, error, log));

    let content = messages.length === 0 ? ''
      : messages.map(message => `[来自 ${message.senderSessionId}] ${message.content}`).join('\n\n');
    if (reminder !== null) {
      log.info(`[Workspace::handlers] [RUN_AGENT] P38: Adding reminder to message content for agent ${agentSessionId}`);
      content = content === '' ? reminder : `${reminder}\n\n---\n\n${content}`;
    }

    const registration = state.tryRegisterStreamOwned(agentSessionId);
    if (registration === null) throw rollback('Agent has an active stream. Please wait for completion.');
    const streamGeneration = registration.generation;
    const cancelToken = registration.token;
    streamGuard = new StreamGuard(state, agentSessionId, registration);

    try { coordinator.updateAgentStatus(workspaceId, agentSessionId, 'running'); }
    catch (error) { throw rollback(errorText(error)); }

    if (isWorker) markTaskRunning(coordinator, workspaceId, agentSessionId, log);

    let runtimeConfig: AgentRuntimeConfig | null;
    try { runtimeConfig = AgentProfileResolver.runtimeConfigForAgent(agent); }
    catch (error) {
      log.warn(`[Workspace::handlers] Failed to resolve agent profile for ${agentSessionId}, falling back to legacy session metadata: ${errorText(error)}`);
      runtimeConfig = null;
    }
    let hasPersistedProfile: boolean;
    try { hasPersistedProfile = AgentProfileResolver.fromMetadata(agent.metadata) !== null; }
    catch { hasPersistedProfile = false; }

    let conn;
    try { conn = db.getConnSafe(); }
    catch (error) { throw rollback(`Failed to get db connection: ${errorText(error)}`); }
    let session;
    try { session = getSession(conn, agentSessionId); }
    catch (error) { throw rollback(`Failed to get agent session: ${errorText(error)}`); }
    if (session === null) throw rollback(`Agent session not found: ${agentSessionId}`);

    const metadata = session.metadata ?? null;
    const legacySystemPrompt = asStr(metadataField(metadata, 'system_prompt'));
    let profileSkillContents = new Map<string, string>();
    if (hasPersistedProfile) {
      try { profileSkillContents = resolveProfileSkillSnapshot(runtimeConfig?.skillIds ?? [], metadata); }
      catch (error) { throw rollback(errorText(error)); }
    }
    const profileSkillIds = hasPersistedProfile ? [...(runtimeConfig?.skillIds ?? [])] : [];
    const profileReasoningEffort = hasPersistedProfile ? runtimeConfig?.reasoningEffort ?? null : null;

    let systemPrompt: string | null;
    if (runtimeConfig !== null && hasPersistedProfile) {
      let workspaceName: string | null = null;
      try { workspaceName = coordinator.getWorkspace(workspaceId)?.name ?? null; } catch { workspaceName = null; }
      workspaceName ??= [...workspaceId].slice(0, 8).join('');
      systemPrompt = `${runtimeConfig.systemInstructions}\n\n# 子代理任务环境\n- 工作区名称: ${workspaceName}\n- 工作区 ID: ${workspaceId}\n\n最终回答会由运行时自动交付给父代理。`;
    } else {
      systemPrompt = legacySystemPrompt;
    }

    const recommended = metadataField(metadata, 'recommended_models');
    const recommendedModel = Array.isArray(recommended) ? asStr(recommended[0]) : null;
    const selectedModel = runtimeConfig?.modelId ?? recommendedModel;
    const parentSessionId = asStr(metadataField(metadata, 'parent_session_id'));
    if (selectedModel !== null) log.info(`[Workspace::handlers] Using model: ${selectedModel} for agent: ${agentSessionId}`);

    const workerSchemas = workspaceCollaborationSchemas();
    let workerAllowedTools: string[];
    if (runtimeConfig !== null) {
      extendWorkerToolSchemas(workerSchemas, runtimeConfig.allowedTools, deps.surfaces);
      workerAllowedTools = [...runtimeConfig.allowedTools];
    } else {
      workerAllowedTools = workerSchemas.map(schema => schema.name);
    }

    const cardReadScope = installWorkerCardReadScope(isWorker, workerAllowedTools, agents, workspaceId,
      agentSessionId, deps.surfaces, log);

    // G02-P1 grant + G08 budget binding: same lifetime as the pipeline task.
    let childTaskId = agentSessionId;
    try { childTaskId = coordinator.getTaskManager(workspaceId).getAgentTask(agentSessionId)?.id ?? agentSessionId; }
    catch { childTaskId = agentSessionId; }
    let profileHash = '';
    try { profileHash = AgentProfileResolver.computedHash(AgentProfileResolver.resolveForAgent(agent)); }
    catch { profileHash = ''; }
    const parentTaskId = parentSessionId ?? request.requester_session_id;
    const budgetAttachment = deps.pipeline.attachChildToTree(parentTaskId, agentSessionId, null);
    const grantRegistration: GrantRegistrationGuard = issueWorkerGrant(agentSessionId, parentTaskId, childTaskId,
      workerAllowedTools, profileHash, { ...budgetAttachment.effectiveBudget }, log);

    const assistantMessageId = generateMessageId();
    const options: WorkerSendOptions = {
      systemPromptOverride: systemPrompt,
      // profile.model_id first, legacy recommended_models[0] fallback
      modelId: selectedModel,
      // Persona model references are exact config ids (strict).
      strictModelId: hasPersistedProfile && runtimeConfig?.modelId != null,
      reasoningEffort: profileReasoningEffort,
      ragEnabled: false,
      graphRagEnabled: false,
      memoryEnabled: false,
      mcpToolSchemas: workerSchemas,
      executionAllowedTools: workerAllowedTools,
      activeSkillIds: profileSkillIds.length > 0 ? profileSkillIds : null,
      skillContents: profileSkillContents.size > 0 ? Object.fromEntries(profileSkillContents) : null,
      streamGeneration,
    };
    const sendRequest: BackendSendRequest = {
      sessionId: agentSessionId,
      content,
      userContextRefs: null,
      pathMap: null,
      workspaceId,
      options,
      assistantMessageId,
      userMessageId: null,
    };

    const guard = streamGuard;
    spawned = true;
    void state.spawnTracked(runWorkerPipeline(deps, {
      window, sendRequest, cancelToken, workspaceId, agentSessionId, isWorker, assistantMessageId,
      parentSessionId, taskId: childTaskId === agentSessionId ? null : childTaskId,
      originalMessageIds, skillId: agent.skillId,
      releasePermit, cardReadScope, streamGuard: guard, grantRegistration, budgetAttachment,
    }));

    return { agent_session_id: agentSessionId, message_id: assistantMessageId, status: 'running' };
  } finally {
    if (!spawned) {
      streamGuard?.dispose();
      releasePermit();
    }
  }
}

function markTaskRunning(coordinator: WorkspaceCoordinator, workspaceId: string, agentSessionId: string, log: ChatLogger): void {
  let manager: SubagentTaskManager;
  try { manager = coordinator.getTaskManager(workspaceId); } catch { return; }
  let task;
  try { task = manager.getAgentTask(agentSessionId); } catch { return; }
  if (task === null) return;
  try {
    manager.markRunning(task.id);
    log.info(`[Workspace::handlers] Marked task ${task.id} as running for agent ${agentSessionId}`);
  } catch (error) {
    log.warn(`[Workspace::handlers] Failed to mark task as running: ${debugTaskError(error)}`);
  }
}

interface WorkerPipelineRun {
  window: WindowRef; sendRequest: BackendSendRequest; cancelToken: AbortController;
  workspaceId: string; agentSessionId: string; isWorker: boolean; assistantMessageId: string;
  parentSessionId: string | null; taskId: string | null; originalMessageIds: string[]; skillId: string | null;
  releasePermit: () => void; cardReadScope: WorkspaceCardReadScopeGuard | null; streamGuard: StreamGuard;
  grantRegistration: GrantRegistrationGuard; budgetAttachment: ChildBudgetAttachment;
}

/** The spawned closure (workspace_handlers.rs:1773-2130). Guards drop in Rust order. */
async function runWorkerPipeline(deps: WorkerRuntimeDeps, run: WorkerPipelineRun): Promise<void> {
  const { coordinator, db, log } = deps;
  const { workspaceId, agentSessionId } = run;
  try {
    let result: { ok: true; messageId: string } | { ok: false; error: unknown };
    try {
      result = { ok: true, messageId: await executeWithTimeout(deps, run.window, run.sendRequest, run.cancelToken, agentSessionId) };
    } catch (error) { result = { ok: false, error }; }
    run.releasePermit();
    run.cardReadScope?.release();
    run.streamGuard.dispose();

    const recordCompletionOutbox = (completion: AgentCompletionEnvelopeInput, payload: string): string | null => {
      if (completion.parentSessionId === null) return null;
      const outbox = deps.outbox;
      const deliveryId = `deliv_${ulid()}`;
      try {
        if (outbox === undefined) throw new Error('completion outbox is unavailable');
        outbox.enqueue({ deliveryId, taskId: completion.taskId, runId: completion.runId, workspaceId: completion.workspaceId,
          agentSessionId: completion.agentSessionId, targetSessionId: completion.parentSessionId,
          targetGeneration: completion.correlationId, payloadJson: payload, createdAt: nowCompletionTimestamp() });
        return deliveryId;
      } catch (error) {
        log.warn(`[Workspace::handlers] Failed to record completion outbox (run=${completion.runId}): ${errorText(error)}`);
        return null;
      }
    };
    const settleCompletionOutbox = (deliveryId: string | null) => {
      if (deliveryId === null || deps.outbox === undefined) return;
      try { deps.outbox.markDeliveredByDeliveryId(deliveryId); }
      catch (error) { log.warn(`[Workspace::handlers] Failed to settle completion outbox ${deliveryId}: ${errorText(error)}`); }
    };
    const emitCompletion = (envelope: Record<string, unknown>) => {
      try { deps.emit('workspace_agent_completion', envelope); } catch (error) { discardError(error); /* Rust `let _ =` */ }
    };
    const setStatus = (status: 'completed' | 'cancelled' | 'failed' | 'idle') => {
      try { coordinator.updateAgentStatus(workspaceId, agentSessionId, status); } catch (error) { discardError(error); /* Rust `let _ =` */ }
    };

    let taskManager: SubagentTaskManager | null = null;
    try { taskManager = coordinator.getTaskManager(workspaceId); } catch { taskManager = null; }
    const correlationId = run.originalMessageIds[0] ?? null;

    if (result.ok === true) {
      log.info(`[Workspace::handlers] Agent pipeline completed: agent=${agentSessionId}, message_id=${result.messageId}`);
      if (run.isWorker) {
        const finalOutput = workerAssistantOutput(db, run.assistantMessageId) ?? '';
        const summary = summarizeWorkerAssistantMessage(db, run.assistantMessageId) ?? 'Task completed successfully';
        const input: AgentCompletionEnvelopeInput = {
          workspaceId, agentSessionId, parentSessionId: run.parentSessionId, taskId: run.taskId,
          runId: run.assistantMessageId, correlationId, status: 'completed', finalOutput, error: null,
          completedAt: toRfc3339(), tokenUsage: workerMessageUsage(db, run.assistantMessageId),
        };
        const envelope = agentCompletionEnvelope(input);
        const payload = JSON.stringify(envelope);
        const deliveryId = recordCompletionOutbox(input, payload);
        try {
          const message = coordinator.sendMessage(workspaceId, agentSessionId, run.parentSessionId, 'result', payload);
          settleCompletionOutbox(deliveryId);
          try { coordinator.updateMessageMetadata(workspaceId, message.id, envelopeMetadata(payload)); }
          catch (error) { log.warn(`[Workspace::handlers] Failed to persist completion metadata: ${errorText(error)}`); }
        } catch (error) {
          log.error(`[Workspace::handlers] Failed to deliver runtime completion: ${errorText(error)}`);
        }
        setStatus('completed');
        if (taskManager !== null && run.taskId !== null) {
          try { taskManager.markCompleted(run.taskId, summary); }
          catch (error) { log.warn(`[Workspace::handlers] Failed to mark task completed: ${debugTaskError(error)}`); }
        }
        emitCompletion(envelope);
      } else {
        setStatus('idle');
        if (coordinator.hasPendingMessages(workspaceId, agentSessionId)) {
          log.info(`[Workspace::handlers] Agent has pending messages, triggering continue: agent=${agentSessionId}`);
          try {
            deps.emit(WORKSPACE_WORKER_READY_EVENT, { workspace_id: workspaceId, agent_session_id: agentSessionId, skill_id: run.skillId });
          } catch (error) {
            log.warn(`[Workspace::handlers] Failed to emit worker_ready for continue: ${errorText(error)}`);
          }
        }
      }
      return;
    }

    if (isCancelled(result.error)) {
      log.info(`[Workspace::handlers] Agent pipeline cancelled: agent=${agentSessionId}`);
      setStatus('cancelled');
      if (taskManager !== null && run.taskId !== null) {
        try { taskManager.updateStatus(run.taskId, 'cancelled', 'execution cancelled'); }
        catch (error) { log.warn(`[Workspace::handlers] Failed to mark task cancelled: ${debugTaskError(error)}`); }
      }
      settleTerminal('cancelled', 'execution cancelled');
      return;
    }

    log.error(`[Workspace::handlers] Agent pipeline error: agent=${agentSessionId}, error=${errorText(result.error)}`);
    const errorSummary = truncateChars(errorText(result.error), WORKER_RESULT_SUMMARY_MAX_CHARS);
    setStatus('failed');
    if (taskManager !== null && run.taskId !== null) {
      try { taskManager.markFailed(run.taskId, errorSummary); }
      catch (error) { log.warn(`[Workspace::handlers] Failed to mark task failed: ${debugTaskError(error)}`); }
    }
    settleTerminal('failed', errorSummary);

    function settleTerminal(status: 'cancelled' | 'failed', error: string): void {
      const input: AgentCompletionEnvelopeInput = {
        workspaceId, agentSessionId, parentSessionId: run.parentSessionId, taskId: run.taskId,
        runId: run.assistantMessageId, correlationId, status, finalOutput: null, error,
        completedAt: toRfc3339(), tokenUsage: workerMessageUsage(db, run.assistantMessageId),
      };
      const envelope = agentCompletionEnvelope(input);
      const payload = JSON.stringify(envelope);
      const deliveryId = recordCompletionOutbox(input, payload);
      try {
        const message = coordinator.sendMessage(workspaceId, agentSessionId, run.parentSessionId, 'result', payload);
        settleCompletionOutbox(deliveryId);
        try { coordinator.updateMessageMetadata(workspaceId, message.id, envelopeMetadata(payload)); } catch (error) { discardError(error); /* Rust `let _ =` */ }
      } catch (error) { discardError(error); /* Rust `if let Ok(..)` */ }
      emitCompletion(envelope);
    }
  } finally {
    // Drop order at the end of the spawned task (also on panic): permit/scope/stream already
    // released above on the normal path; these releases are idempotent.
    run.releasePermit();
    run.cardReadScope?.release();
    run.streamGuard.dispose();
    run.grantRegistration.dispose();
    run.budgetAttachment.release();
  }
}

// ============================================================
// Commands
// ============================================================

/** Rust handlers return `Result<_, String>`. */
export function stringError(error: unknown): string { return errorText(error); }

/** `workspace_run_agent` (workspace_handlers.rs:1075-1093). */
export function workspaceRunAgentAction(deps: WorkerRuntimeDeps, request: RunAgentRequest,
  window: WindowRef): Promise<RunAgentResponse> {
  return runWorkspaceAgentBackend(deps, request, window);
}

/** `workspace_create_agent` (workspace_handlers.rs:680-864). */
export async function workspaceCreateAgentAction(deps: WorkerRuntimeDeps, request: CreateAgentRequest,
  window: WindowRef): Promise<CreateAgentResponse> {
  const { coordinator, db, log } = deps;
  coordinator.ensureMemberOrCreator(request.workspace_id, request.requester_session_id);
  const role = request.role === 'coordinator' ? 'coordinator' : 'worker';
  const isWorker = role === 'worker';
  const skillId = request.skill_id ?? null;
  const agentSessionId = `agent_${skillId ?? 'worker'}_${ulid()}`;

  let conn;
  try { conn = db.getConnSafe(); }
  catch (error) { throw new ValueError(`Failed to get db connection: ${errorText(error)}`); }
  let requesterDepth = 0;
  try {
    const requester = getSession(conn, request.requester_session_id);
    const value = asU64(metadataField(requester?.metadata, 'subagent_depth'));
    requesterDepth = value === null ? 0 : asU32(value);
  } catch (error) {
    throw new ValueError(`Failed to query requester session for depth: ${errorText(error)}`);
  }
  const workspacePrefix = [...request.workspace_id].slice(0, 8).join('');
  try {
    createSession(conn, {
      ...newSession(agentSessionId, 'agent'),
      title: `Agent: ${skillId ?? 'Worker'}`,
      description: `工作区 ${workspacePrefix} 的 Agent`,
      summaryHash: null,
      // Agent titles are system-named; locked against auto-summary.
      titleLocked: true,
      metadata: {
        workspace_id: request.workspace_id,
        role,
        skill_id: skillId,
        system_prompt: request.system_prompt ?? null,
        recommended_models: [],
        parent_session_id: request.requester_session_id,
        subagent_depth: requesterDepth + 1,
      },
      groupId: null,
      tagsHash: null,
      tags: null,
    });
  } catch (error) {
    throw new ValueError(`Failed to create agent session: ${errorText(error)}`);
  }

  const agent = coordinator.registerAgent(request.workspace_id, agentSessionId, role, skillId, null);
  const initialTask = request.initial_task ?? null;
  if (initialTask !== null) {
    coordinator.sendMessage(request.workspace_id, request.requester_session_id, agentSessionId, 'task', initialTask);
    if (isWorker) {
      let manager: SubagentTaskManager | null = null;
      try { manager = coordinator.getTaskManager(request.workspace_id); }
      catch (error) { log.warn(`[Workspace::handlers] Failed to get task manager for worker task: ${errorText(error)}`); }
      if (manager !== null) {
        const task = newSubagentTask(request.workspace_id, agentSessionId, skillId, initialTask);
        try {
          manager.createTask(task);
          log.info(`[Workspace::handlers] Persisted worker task: task_id=${task.id}, agent=${agentSessionId}`);
        } catch (error) {
          log.warn(`[Workspace::handlers] Failed to persist worker task: ${debugTaskError(error)}`);
        }
      }
    }
  }

  if (isWorker && initialTask !== null) {
    const run = await runWorkspaceAgentBackend(deps, {
      workspace_id: request.workspace_id, agent_session_id: agentSessionId,
      requester_session_id: request.requester_session_id, reminder: null,
    }, window);
    try {
      deps.emit(WORKSPACE_WORKER_READY_EVENT, { workspace_id: request.workspace_id, agent_session_id: agentSessionId,
        skill_id: skillId, run_id: run.message_id, runtime_managed: true });
      log.info(`[Workspace::handlers] Emitted worker_ready for created agent: ${agentSessionId}`);
    } catch (error) {
      log.warn(`[Workspace::handlers] Failed to emit worker_ready for created agent: ${errorText(error)}`);
    }
  }

  return {
    agent_session_id: agent.sessionId, workspace_id: agent.workspaceId, role,
    skill_id: skillId, status: agent.status.toLowerCase(),
  };
}

/** `workspace_restore_executions` (workspace_handlers.rs:2413-2636). */
export async function workspaceRestoreExecutionsAction(deps: WorkerRuntimeDeps, dispatcher: CompletionDispatcherRuntime,
  sessionId: string, workspaceId: string, window: WindowRef): Promise<RestoreExecutionsResponse> {
  const { coordinator, state, log } = deps;
  coordinator.ensureMemberOrCreator(workspaceId, sessionId);
  log.info(`[Workspace::handlers] workspace_restore_executions: workspace_id=${workspaceId}`);
  const restoredAgentIds: string[] = [];
  dispatcher.ensureStarted();

  const taskManager = coordinator.getTaskManager(workspaceId);
  try {
    const swept = taskManager.sweepOrphanedRunning(agentSessionId => state.hasActiveStream(agentSessionId));
    if (swept.length > 0) {
      log.warn(`[Workspace::handlers] Swept ${swept.length} orphaned running task(s) to unknown: workspace=${workspaceId}, agents=[${swept.map(task => JSON.stringify(task.agentSessionId)).join(', ')}]`);
    }
  } catch (error) {
    log.error(`[Workspace::handlers] Failed to sweep orphaned running tasks: ${debugTaskError(error)}`);
  }

  let unknown: ReturnType<SubagentTaskManager['getUnknownTasks']>;
  try { unknown = taskManager.getUnknownTasks(); }
  catch (error) {
    log.warn(`[Workspace::handlers] Failed to list unknown tasks: ${debugTaskError(error)}`);
    unknown = [];
  }
  const unknownTasks: UnknownSubagentTaskInfo[] = unknown.map(task => ({
    task_id: task.id, agent_session_id: task.agentSessionId, skill_id: task.skillId,
    initial_task: task.initialTask, started_at: task.startedAt, created_at: task.createdAt,
  }));

  let tasksToRestore: ReturnType<SubagentTaskManager['getTasksToRestore']>;
  try { tasksToRestore = taskManager.getTasksToRestore(); }
  catch (error) { throw new ValueError(`Failed to get tasks to restore: ${debugTaskError(error)}`); }

  for (const task of tasksToRestore) {
    log.info(`[Workspace::handlers] Restoring subagent task: agent_session_id=${task.agentSessionId}, status=${titleCase(task.status)}`);
    const hasPending = coordinator.hasPendingMessages(workspaceId, task.agentSessionId);
    const runningWithoutInbox = task.status === 'running' && !hasPending;
    if (!hasPending && !runningWithoutInbox) {
      log.debug(`[Workspace::handlers] Skipping task restore (no pending messages): agent_session_id=${task.agentSessionId}`);
      continue;
    }
    const reminder = runningWithoutInbox ? RESTORE_REMINDER : null;
    try {
      await runWorkspaceAgentBackend(deps, { workspace_id: workspaceId, agent_session_id: task.agentSessionId,
        requester_session_id: sessionId, reminder }, window);
      restoredAgentIds.push(task.agentSessionId);
    } catch (error) {
      log.warn(`[Workspace::handlers] Failed to restore worker through backend runtime: session=${task.agentSessionId}, error=${errorText(error)}`);
      continue;
    }
    try {
      deps.emit(WORKSPACE_WORKER_READY_EVENT, { workspace_id: workspaceId, agent_session_id: task.agentSessionId,
        skill_id: task.skillId, restored: true, reminder, runtime_managed: true });
    } catch (error) {
      log.warn(`[Workspace::handlers] Failed to emit worker_ready for restore: session=${task.agentSessionId}, error=${errorText(error)}`);
    }
  }

  const sleepManager = coordinator.getSleepManager(workspaceId);
  const activeSleepIds = sleepManager.getActiveSleepIds();
  const hasActiveSleeps = activeSleepIds.length > 0;
  if (hasActiveSleeps) log.info(`[Workspace::handlers] Found ${activeSleepIds.length} active sleeps for workspace ${workspaceId}`);
  log.info(`[Workspace::handlers] Restore complete: ${restoredAgentIds.length} tasks restored, ${activeSleepIds.length} active sleeps`);
  return {
    subagent_tasks_restored: restoredAgentIds.length, restored_agent_ids: restoredAgentIds,
    has_active_sleeps: hasActiveSleeps, active_sleep_ids: activeSleepIds, unknown_tasks: unknownTasks,
  };
}

/** Rust `let _ = ...` / `if let Ok(..)`: the failure is deliberately discarded. */
function discardError(error: unknown): unknown { return error; }
