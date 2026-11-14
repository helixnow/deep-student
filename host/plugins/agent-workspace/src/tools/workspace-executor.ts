/**
 * `chat_v2/tools/workspace_executor.rs` 的移植：工作区协作的 8 个 agent 工具。
 *
 * 工具语义、JSON 字段、系统提示词、深度限制、任务持久化与 worker 派发顺序
 * 都按 Rust 分支逐条对齐。宿主依赖（chat_v2 会话表、worker 后台管线、事件、
 * 工具块持久化）通过 `WorkspaceExecutorContext` 注入；其他 lane 尚未发布
 * 的服务以最小接口表达，缺失时明确失败而不是静默成功。
 */
import type {
  AgentRole, JsonValue, MessageType, WorkspaceDocument,
} from '../../api.ts';
import {
  AgentProfileResolver, type AgentProfileSelection,
} from '../workspace/agent-profile.ts';
import type { WorkspaceCoordinator } from '../workspace/coordinator.ts';
import { newSubagentTask } from '../workspace/subagent-task.ts';
import { newWorkspaceDocument } from '../workspace/types.ts';
import { ulid } from '../workspace/util.ts';
import { toRfc3339 as nowRfc3339 } from '../../../../platform/time/index.ts';
import {
  stripToolNamespace, successResult,
  type ToolCall, type ToolResultInfo, type ToolSensitivity,
} from './shared.ts';
import { takeChars } from '../../../../platform/util/portable.ts';

export const WORKSPACE_WORKER_READY_EVENT = 'workspace_worker_ready';
export const WORKSPACE_NAMESPACE = 'workspace';

export const toolNames = {
  CREATE: 'workspace_create',
  CREATE_AGENT: 'workspace_create_agent',
  SEND: 'workspace_send',
  QUERY: 'workspace_query',
  SET_CONTEXT: 'workspace_set_context',
  GET_CONTEXT: 'workspace_get_context',
  UPDATE_DOCUMENT: 'workspace_update_document',
  READ_DOCUMENT: 'workspace_read_document',
} as const;

/** `ChatV2Repo::get_session_with_conn` + `create_session_with_conn` 的最小接口。 */
export interface WorkspaceAgentSessionRecord {
  id: string;
  mode: string;
  title: string | null;
  description: string | null;
  summary_hash: string | null;
  title_locked: boolean;
  persist_status: 'active';
  created_at: string;
  updated_at: string;
  metadata: JsonValue | null;
  group_id: string | null;
  tags_hash: string | null;
  tags: string[] | null;
}

export interface WorkspaceAgentSessionStore {
  /** 返回会话 metadata；会话不存在返回 `null`。数据库错误应抛出。 */
  sessionMetadata(sessionId: string): JsonValue | null;
  createSession(session: WorkspaceAgentSessionRecord): void;
}

export interface WorkspaceAgentRunRequest {
  workspaceId: string;
  agentSessionId: string;
  requesterSessionId: string;
  reminder: null;
}

export interface WorkspaceAgentRunResult {
  messageId: string;
}

export interface WorkerReadyEvent {
  workspace_id: string;
  agent_session_id: string;
  skill_id: string | null;
  runtime_managed: true;
}

/**
 * 工具执行上下文：Rust `ExecutionContext` 中本模块实际使用的部分。
 * `chatV2Db` / `runWorkspaceAgentBackend` / `skillContents` 对应其他 lane 的
 * 服务；未注入时按 Rust 的「服务不可用」错误失败（fail-closed）。
 */
export interface WorkspaceExecutorContext {
  sessionId: string;
  blockId?: string | null;
  chatV2Db?: WorkspaceAgentSessionStore | null;
  runWorkspaceAgentBackend?:
    | ((request: WorkspaceAgentRunRequest) => Promise<WorkspaceAgentRunResult>)
    | null;
  skillContents?: ReadonlyMap<string, string> | null;
  emitToolCallStart?: ((toolName: string, args: JsonValue, callId: string | null) => void) | null;
  emitToolCallEnd?: ((payload: JsonValue) => void) | null;
  emitToolCallError?: ((error: string) => void) | null;
  saveToolBlock?: ((result: ToolResultInfo) => void) | null;
  emitWorkerReady?: ((event: WorkerReadyEvent) => void) | null;
  /** Rust `log::warn!` 出口；生产注入 kernel `ctx.logger`。 */
  warn?: ((message: string) => void) | null;
  /** Rust `log::info!` 出口。 */
  info?: ((message: string) => void) | null;
  now?: (() => string) | null;
  newUlid?: (() => string) | null;
}

type JsonObject = { [key: string]: JsonValue };

function objectOf(value: JsonValue | undefined): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function requiredString(args: JsonValue, key: string): string {
  const value = objectOf(args)?.[key];
  if (typeof value !== 'string') throw new Error(`${key} is required`);
  return value;
}

function optionalString(args: JsonValue, key: string): string | null {
  const value = objectOf(args)?.[key];
  return typeof value === 'string' ? value : null;
}

function optionalLimit(args: JsonValue): number {
  const value = objectOf(args)?.['limit'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 50;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `subagent_executor::build_profile_skill_snapshot` 的等价实现。 */
export function buildProfileSkillSnapshot(
  skillIds: readonly string[],
  available: ReadonlyMap<string, string> | null | undefined,
): Record<string, string> {
  if (skillIds.length === 0) return {};
  if (available == null) {
    throw new Error(
      `Profile requires skills [${skillIds.join(', ')}], but the current runtime has no skill content registry`,
    );
  }
  const snapshot: Record<string, string> = {};
  const missing: string[] = [];
  for (const skillId of skillIds) {
    const content = available.get(skillId);
    if (content === undefined) missing.push(skillId);
    else snapshot[skillId] = content;
  }
  if (missing.length > 0) {
    throw new Error(
      `Profile skills are unavailable in the current runtime: [${missing.join(', ')}]. ` +
      'Refusing to create a worker that would silently ignore them.',
    );
  }
  return snapshot;
}

function workerSystemPrompt(workspaceName: string, workspaceId: string, skillId: string | null): string {
  return `# 子代理执行协议

你是工作区「${workspaceName}」中的 **Worker 子代理**。

## 基本信息
- 工作区 ID: ${workspaceId}
- 技能: ${skillId ?? '通用'}

## 核心职责

专注执行主代理分配给你的任务，并给出完整、可验证的最终回答。
最终回答会由运行时自动交付给主代理；\`builtin-workspace_send\` 仅用于进度、提问或中间协作。

## 工具使用

你可以使用以下工具：
- \`builtin-workspace_send\`: 发送进度、问题或中间协作消息
- \`builtin-workspace_query\`: 查询工作区信息`;
}

function coordinatorSystemPrompt(workspaceName: string, workspaceId: string): string {
  return `你是工作区「${workspaceName}」中的协调者 (Coordinator)。\n` +
    `工作区 ID: ${workspaceId}\n\n` +
    '你可以使用 workspace_send 工具向工作区发送消息，' +
    '也可以使用 workspace_query 查询工作区状态。';
}

function parseMessageType(raw: string): MessageType {
  switch (raw) {
    case 'progress': return 'progress';
    case 'result': return 'result';
    case 'query': return 'query';
    case 'correction': return 'correction';
    case 'broadcast': return 'broadcast';
    default: return 'task';
  }
}

function parseDocumentType(raw: string): WorkspaceDocument['docType'] {
  switch (raw) {
    case 'plan': return 'plan';
    case 'research': return 'research';
    case 'artifact': return 'artifact';
    default: return 'notes';
  }
}

export class WorkspaceToolExecutor {
  private readonly coordinator: WorkspaceCoordinator;
  private readonly context: WorkspaceExecutorContext;

  constructor(
    coordinator: WorkspaceCoordinator,
    context: WorkspaceExecutorContext,
  ) {
    this.coordinator = coordinator;
    this.context = context;
  }

  private now(): string {
    return this.context.now?.() ?? nowRfc3339();
  }

  private nextUlid(): string {
    return this.context.newUlid?.() ?? ulid();
  }

  /** 先剥 `workspace_`，再回退到 `builtin-` / `mcp_`（与 Rust 一致）。 */
  private static stripNamespace(toolName: string): string {
    const prefix = `${WORKSPACE_NAMESPACE}_`;
    return toolName.startsWith(prefix)
      ? toolName.slice(prefix.length)
      : stripToolNamespace(toolName);
  }

  private ensureWorkspaceMember(workspaceId: string, sessionId: string): void {
    this.coordinator.ensureMemberOrCreator(workspaceId, sessionId);
  }

  private workspaceName(workspaceId: string): string {
    const workspace = this.coordinator.getWorkspace(workspaceId);
    if (workspace === null) throw new Error(`Workspace not found: ${workspaceId}`);
    return workspace.name ?? workspaceId.slice(0, Math.min(8, workspaceId.length));
  }

  async executeCreate(args: JsonValue): Promise<JsonValue> {
    const name = optionalString(args, 'name');
    const workspace = this.coordinator.createWorkspace(this.context.sessionId, name);
    const coordinatorAgent = this.coordinator.registerAgent(
      workspace.id,
      this.context.sessionId,
      'coordinator',
      null,
      null,
    );
    return {
      workspace_id: workspace.id,
      status: 'created',
      message: 'Workspace created successfully. You are registered as the coordinator.',
      snapshotAgents: [{
        session_id: coordinatorAgent.sessionId,
        role: 'coordinator',
        status: 'idle',
        skill_id: null,
      }],
      snapshotName: name ?? workspace.id.slice(0, Math.min(8, workspace.id.length)),
      snapshotCreatedAt: this.now(),
    };
  }

  async executeCreateAgent(args: JsonValue): Promise<JsonValue> {
    const workspaceId = requiredString(args, 'workspace_id');
    const skillId = optionalString(args, 'skill_id');
    const roleStr = optionalString(args, 'role') ?? 'worker';
    const initialTask = optionalString(args, 'initial_task');
    const role: AgentRole = roleStr === 'coordinator' ? 'coordinator' : 'worker';
    const isWorker = role === 'worker';

    this.ensureWorkspaceMember(workspaceId, this.context.sessionId);

    const agentSessionId = `agent_${skillId ?? 'worker'}_${this.nextUlid()}`;

    const chatV2Db = this.context.chatV2Db;
    if (chatV2Db == null) throw new Error('chat_v2_db not available for creating agent session');

    let creatorMetadata: JsonValue | null;
    try {
      creatorMetadata = chatV2Db.sessionMetadata(this.context.sessionId);
    } catch (error) {
      throw new Error(`Failed to query creator session for depth: ${messageOf(error)}`);
    }
    const creatorDepthRaw = objectOf(creatorMetadata)?.['subagent_depth'];
    const creatorDepth = typeof creatorDepthRaw === 'number'
      && Number.isInteger(creatorDepthRaw) && creatorDepthRaw >= 0
      ? creatorDepthRaw
      : 0;
    const MAX_SUBAGENT_DEPTH = 3;
    if (isWorker && creatorDepth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `Maximum subagent nesting depth (${MAX_SUBAGENT_DEPTH}) exceeded. Current depth: ${creatorDepth}. ` +
        'Recursive subagent creation is not allowed to prevent resource exhaustion.',
      );
    }

    const workspaceName = this.workspaceName(workspaceId);
    const systemPrompt = isWorker
      ? workerSystemPrompt(workspaceName, workspaceId, skillId)
      : coordinatorSystemPrompt(workspaceName, workspaceId);

    const recommendedModels: JsonValue[] = [];
    let workerProfile = null;
    if (isWorker) {
      const selection: AgentProfileSelection = { skillId };
      workerProfile = AgentProfileResolver.resolve(selection);
    }
    const profileSkillContents = workerProfile === null
      ? {}
      : buildProfileSkillSnapshot(workerProfile.skills, this.context.skillContents);

    const metadata: JsonObject = {
      workspace_id: workspaceId,
      role: roleStr,
      skill_id: skillId,
      system_prompt: systemPrompt,
      recommended_models: recommendedModels,
    };
    if (isWorker) {
      metadata['parent_session_id'] = this.context.sessionId;
      metadata['is_subagent'] = true;
      metadata['subagent_depth'] = creatorDepth + 1;
      if (Object.keys(profileSkillContents).length > 0) {
        metadata['profile_skill_contents'] = profileSkillContents;
      }
    }

    const now = this.now();
    try {
      chatV2Db.createSession({
        id: agentSessionId,
        mode: 'agent',
        title: `Agent: ${skillId ?? 'Worker'}`,
        description: `工作区 ${workspaceId.slice(0, Math.min(8, workspaceId.length))} 的 Agent`,
        summary_hash: null,
        title_locked: true,
        persist_status: 'active',
        created_at: now,
        updated_at: now,
        metadata,
        group_id: null,
        tags_hash: null,
        tags: null,
      });
    } catch (error) {
      throw new Error(`Failed to create agent session: ${messageOf(error)}`);
    }

    const agentMetadata = workerProfile === null
      ? null
      : AgentProfileResolver.persistIntoMetadata(null, workerProfile);
    const agent = this.coordinator.registerAgent(
      workspaceId,
      agentSessionId,
      role,
      skillId,
      agentMetadata,
    );

    const hasInitialTask = initialTask !== null;
    if (initialTask !== null) {
      this.coordinator.sendMessage(
        workspaceId,
        this.context.sessionId,
        agentSessionId,
        'task',
        initialTask,
      );
      if (isWorker) {
        try {
          const taskManager = this.coordinator.getTaskManager(workspaceId);
          const taskData = newSubagentTask(
            workspaceId,
            agentSessionId,
            skillId,
            initialTask,
          );
          taskManager.createTask(taskData);
        } catch (error) {
          // Rust 记录 warn 后继续创建，不中断 agent 创建。
          this.context.warn?.(`[WorkspaceExecutor] Failed to persist worker task: ${messageOf(error)}`);
        }
      }
    }

    let dispatchedRunId: string | null = null;
    if (isWorker && hasInitialTask) {
      const runBackend = this.context.runWorkspaceAgentBackend;
      if (runBackend == null) {
        throw new Error('runWorkspaceAgentBackend is not configured for worker runtime');
      }
      const run = await runBackend({
        workspaceId,
        agentSessionId,
        requesterSessionId: this.context.sessionId,
        reminder: null,
      });
      dispatchedRunId = run.messageId;

      const event: WorkerReadyEvent = {
        workspace_id: workspaceId,
        agent_session_id: agentSessionId,
        skill_id: skillId,
        runtime_managed: true,
      };
      try {
        this.context.emitWorkerReady?.(event);
        this.context.info?.(`[WorkspaceExecutor] Emitted worker_ready observation event for agent: ${agentSessionId}`);
      } catch (error) {
        // Rust 仅记录 warn，派发结果不回滚。
        this.context.warn?.(`[WorkspaceExecutor] Failed to emit worker_ready event: ${messageOf(error)}`);
      }
    }

    let snapshotAgents: JsonObject[] = [];
    try {
      snapshotAgents = this.coordinator.listAgents(workspaceId).map(agentItem => ({
        session_id: agentItem.sessionId,
        role: agentItem.role,
        status: agentItem.status,
        skill_id: agentItem.skillId,
      }));
      // boundary-allow empty-catch: Rust `list_agents(...).unwrap_or_default()`，快照失败不阻断创建
    } catch (error) {
      void error;
    }

    return {
      agent_session_id: agent.sessionId,
      workspace_id: agent.workspaceId,
      role: roleStr,
      skill_id: skillId,
      status: isWorker && hasInitialTask ? 'dispatched' : 'created',
      auto_run: isWorker && hasInitialTask,
      run_id: dispatchedRunId,
      message: isWorker && hasInitialTask
        ? `Worker agent created and dispatched by the backend runtime. Session ID: ${agentSessionId}`
        : `Agent session created with system prompt configured. Session ID: ${agentSessionId}`,
      snapshotAgents,
      snapshotCreatedAt: this.now(),
    };
  }

  async executeSend(args: JsonValue): Promise<JsonValue> {
    const workspaceId = requiredString(args, 'workspace_id');
    const content = requiredString(args, 'content');
    const targetId = optionalString(args, 'target_session_id');
    const messageType = parseMessageType(optionalString(args, 'message_type') ?? 'task');
    if (targetId !== null && messageType === 'broadcast') {
      throw new Error('Broadcast message must not specify target_session_id');
    }
    const message = this.coordinator.sendMessage(
      workspaceId,
      this.context.sessionId,
      targetId,
      messageType,
      content,
    );
    return {
      message_id: message.id,
      status: 'sent',
      is_broadcast: message.targetSessionId === null,
    };
  }

  async executeQuery(args: JsonValue): Promise<JsonValue> {
    const workspaceId = requiredString(args, 'workspace_id');
    this.coordinator.ensureMemberOrCreator(workspaceId, this.context.sessionId);
    const queryType = optionalString(args, 'query_type') ?? 'agents';
    const limit = optionalLimit(args);

    const serializeAgents = (): JsonObject => ({
      agents: this.coordinator.listAgents(workspaceId).map(agent => ({
        session_id: agent.sessionId,
        role: agent.role,
        status: agent.status,
        skill_id: agent.skillId,
      })),
    });
    const serializeMessages = (): JsonObject => ({
      messages: this.coordinator.listMessages(workspaceId, limit).map(message => ({
        id: message.id,
        sender: message.senderSessionId,
        target: message.targetSessionId,
        type: message.messageType,
        content: message.content,
        created_at: message.createdAt,
      })),
    });
    const serializeDocuments = (): JsonObject => ({
      documents: this.coordinator.listDocuments(workspaceId).map(document => ({
        id: document.id,
        title: document.title,
        type: document.docType,
        version: document.version,
      })),
    });
    const serializeContext = (): JsonObject => ({
      context: this.coordinator.listContext(workspaceId).map(item => ({
        key: item.key,
        value: item.value,
        updated_by: item.updatedBy,
        updated_at: item.updatedAt,
      })),
    });
    const serializeTasks = (): JsonObject => {
      const taskManager = this.coordinator.getTaskManager(workspaceId);
      const tasks = taskManager.listRecentTasks(limit);
      return {
        tasks: tasks.map(task => ({
          task_id: task.id,
          agent_session_id: task.agentSessionId,
          status: task.status,
          initial_task: task.initialTask === null
            ? null
            : takeChars(task.initialTask, 300),
          result_summary: task.resultSummary,
          created_at: task.createdAt,
          started_at: task.startedAt,
          completed_at: task.completedAt,
        })),
      };
    };

    switch (queryType) {
      case 'agents': return serializeAgents();
      case 'messages': return serializeMessages();
      case 'documents': return serializeDocuments();
      case 'context': return serializeContext();
      case 'tasks': return serializeTasks();
      case 'all': {
        const merged: JsonObject = {};
        for (const section of [
          serializeAgents(),
          serializeMessages(),
          serializeDocuments(),
          serializeContext(),
          serializeTasks(),
        ]) {
          Object.assign(merged, section);
        }
        return merged;
      }
      default:
        throw new Error(`Unknown query_type: ${queryType}`);
    }
  }

  async executeSetContext(args: JsonValue): Promise<JsonValue> {
    const workspaceId = requiredString(args, 'workspace_id');
    const key = requiredString(args, 'key');
    const value = objectOf(args)?.['value'] ?? null;
    this.coordinator.setContext(workspaceId, key, value, this.context.sessionId);
    return { key, status: 'set' };
  }

  async executeGetContext(args: JsonValue): Promise<JsonValue> {
    const workspaceId = requiredString(args, 'workspace_id');
    const key = requiredString(args, 'key');
    this.ensureWorkspaceMember(workspaceId, this.context.sessionId);
    const item = this.coordinator.getContext(workspaceId, key);
    if (item === null) return { key, value: null, found: false };
    return {
      key: item.key,
      value: item.value,
      updated_by: item.updatedBy,
      updated_at: item.updatedAt,
    };
  }

  async executeUpdateDocument(args: JsonValue): Promise<JsonValue> {
    const workspaceId = requiredString(args, 'workspace_id');
    const title = requiredString(args, 'title');
    const content = requiredString(args, 'content');
    const document = newWorkspaceDocument(
      workspaceId,
      parseDocumentType(optionalString(args, 'doc_type') ?? 'notes'),
      title,
      content,
      this.context.sessionId,
    );
    this.coordinator.saveDocument(workspaceId, document);
    return { document_id: document.id, title: document.title, status: 'saved' };
  }

  async executeReadDocument(args: JsonValue): Promise<JsonValue> {
    const workspaceId = requiredString(args, 'workspace_id');
    const documentId = requiredString(args, 'document_id');
    this.ensureWorkspaceMember(workspaceId, this.context.sessionId);
    const document = this.coordinator.getDocument(workspaceId, documentId);
    if (document === null) return { document_id: documentId, found: false };
    return {
      id: document.id,
      title: document.title,
      content: document.content,
      type: document.docType,
      version: document.version,
      updated_by: document.updatedBy,
      updated_at: document.updatedAt,
    };
  }

  /** `can_handle`：同时接受规范形与历史双前缀形。 */
  canHandle(toolName: string): boolean {
    const stripped = WorkspaceToolExecutor.stripNamespace(toolName);
    const canonical = stripToolNamespace(toolName);
    const names: readonly string[] = Object.values(toolNames);
    return names.includes(stripped) || names.includes(canonical);
  }

  sensitivityLevel(_toolName: string): ToolSensitivity {
    return 'low';
  }

  name(): string {
    return 'WorkspaceToolExecutor';
  }

  async execute(call: ToolCall): Promise<ToolResultInfo> {
    const started = performance.now();
    const toolName = WorkspaceToolExecutor.stripNamespace(call.name);
    this.context.emitToolCallStart?.(call.name, call.arguments, call.id);
    let result: JsonValue;
    try {
      switch (toolName) {
        case toolNames.CREATE: result = await this.executeCreate(call.arguments); break;
        case toolNames.CREATE_AGENT: result = await this.executeCreateAgent(call.arguments); break;
        case toolNames.SEND: result = await this.executeSend(call.arguments); break;
        case toolNames.QUERY: result = await this.executeQuery(call.arguments); break;
        case toolNames.SET_CONTEXT: result = await this.executeSetContext(call.arguments); break;
        case toolNames.GET_CONTEXT: result = await this.executeGetContext(call.arguments); break;
        case toolNames.UPDATE_DOCUMENT: result = await this.executeUpdateDocument(call.arguments); break;
        case toolNames.READ_DOCUMENT: result = await this.executeReadDocument(call.arguments); break;
        default: throw new Error(`Unknown workspace tool: ${toolName}`);
      }
    } catch (error) {
      const durationMs = Math.trunc(performance.now() - started);
      const message = messageOf(error);
      this.context.emitToolCallError?.(message);
      const failure: ToolResultInfo = {
        toolCallId: call.id,
        blockId: this.context.blockId ?? undefined,
        toolName: call.name,
        input: call.arguments,
        output: null,
        success: false,
        error: message,
        durationMs,
      };
      try {
        this.context.saveToolBlock?.(failure);
      } catch (saveError) {
        // Rust 仅 warn，工具结果仍返回。
        this.context.warn?.(`[WorkspaceToolExecutor] Failed to save tool block: ${messageOf(saveError)}`);
      }
      return failure;
    }

    const durationMs = Math.trunc(performance.now() - started);
    this.context.emitToolCallEnd?.({ result, durationMs });
    const success = successResult(
      call.id,
      this.context.blockId ?? null,
      call.name,
      call.arguments,
      result,
      durationMs,
    );
    try {
      this.context.saveToolBlock?.(success);
    } catch (saveError) {
      // Rust 仅 warn，工具结果仍返回。
      this.context.warn?.(`[WorkspaceToolExecutor] Failed to save tool block: ${messageOf(saveError)}`);
    }
    return success;
  }
}

/** `get_workspace_tool_schemas`：8 个工具的 JSON schema，字段顺序与 Rust 一致。 */
export function getWorkspaceToolSchemas(): JsonValue[] {
  return [
    {
      name: toolNames.CREATE,
      description: 'Create a new workspace for multi-agent collaboration',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional name for the workspace' },
        },
      },
    },
    {
      name: toolNames.CREATE_AGENT,
      description: 'Register a new agent in the workspace',
      input_schema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID' },
          agent_session_id: { type: 'string', description: 'The session ID for the new agent' },
          role: {
            type: 'string',
            enum: ['coordinator', 'worker'],
            description: 'Agent role (default: worker)',
          },
          skill_id: { type: 'string', description: 'Optional skill ID for the agent' },
        },
        required: ['workspace_id', 'agent_session_id'],
      },
    },
    {
      name: toolNames.SEND,
      description: 'Send a message to agents in the workspace',
      input_schema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID' },
          content: { type: 'string', description: 'Message content' },
          target_session_id: {
            type: 'string',
            description: 'Target agent session ID (omit for broadcast)',
          },
          message_type: {
            type: 'string',
            enum: ['task', 'progress', 'result', 'query', 'correction', 'broadcast'],
            description: 'Message type (default: task)',
          },
        },
        required: ['workspace_id', 'content'],
      },
    },
    {
      name: toolNames.QUERY,
      description: 'Query workspace information',
      input_schema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID' },
          query_type: {
            type: 'string',
            enum: ['agents', 'messages', 'documents', 'context', 'tasks', 'all'],
            description: "Type of query (default: agents). Use 'tasks' to poll background subagent task status/result after subagent_call with wait=false.",
          },
          limit: { type: 'integer', description: 'Maximum number of results (default: 50)' },
        },
        required: ['workspace_id'],
      },
    },
    {
      name: toolNames.SET_CONTEXT,
      description: 'Set a shared context value in the workspace',
      input_schema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID' },
          key: { type: 'string', description: 'Context key' },
          value: { description: 'Context value (any JSON value)' },
        },
        required: ['workspace_id', 'key', 'value'],
      },
    },
    {
      name: toolNames.GET_CONTEXT,
      description: 'Get a shared context value from the workspace',
      input_schema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID' },
          key: { type: 'string', description: 'Context key' },
        },
        required: ['workspace_id', 'key'],
      },
    },
    {
      name: toolNames.UPDATE_DOCUMENT,
      description: 'Create or update a document in the workspace',
      input_schema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID' },
          title: { type: 'string', description: 'Document title' },
          content: { type: 'string', description: 'Document content' },
          doc_type: {
            type: 'string',
            enum: ['plan', 'research', 'artifact', 'notes'],
            description: 'Document type (default: notes)',
          },
        },
        required: ['workspace_id', 'title', 'content'],
      },
    },
    {
      name: toolNames.READ_DOCUMENT,
      description: 'Read a document from the workspace',
      input_schema: {
        type: 'object',
        properties: {
          workspace_id: { type: 'string', description: 'The workspace ID' },
          document_id: { type: 'string', description: 'Document ID' },
        },
        required: ['workspace_id', 'document_id'],
      },
    },
  ];
}
