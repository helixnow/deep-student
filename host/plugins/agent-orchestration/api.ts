import type { Context } from '@deepseek-ai/cordis';
import type { TodoList } from './src/todo.ts';
import type { PersistedTodoList } from './repository/todo.ts';
import type {
  AutomationCreateCommandRequest, AutomationUpdateCommandRequest, DeliverInboxRequest,
  DeliverOutcome, HeadlessSessionMode, SuperSessionSettings, SuperSessionState,
} from '../../../contracts/ipc/generated/L06-agent-orchestration.ts';
// Decoded Rust struct (u64 fields exact, D3), not the IPC request shape.
import type { TrustedAutomationProfile, TrustedU64 } from './src/trusted-profile.ts';

export type { Context, HeadlessSessionMode, SuperSessionSettings, SuperSessionState, TrustedAutomationProfile, TrustedU64 };
export { buildProfileSkillSnapshot } from './src/subagent-args.ts';
export type { IncomingTrigger, IngestOutcome } from './src/inbound.ts';
export type { SendMessagePipeline, SendMessageRequest, SuperInboxStreamRegistration } from './src/super-inbox-drain.ts';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------
// 工具执行器面（L04 `ToolExecutorRegistry` 消费；对应 `src-tauri` 中
// `chat_v2/tools/*_executor.rs` 的 `can_handle`/schema/纯逻辑部分）。
//
// 执行器的跨 lane 依赖（chat_v2 仓储、VFS、workspace coordinator）由 L04/L05
// 在组装时注入；本 lane 只发布与 Rust 等价的判定、schema 与可复用核心。
// ---------------------------------------------------------------------------

export {
  ATTEMPT_COMPLETION_TOOL_NAME, attemptCompletionSchema, executeAttemptCompletion,
  isAttemptCompletion, parseAttemptCompletionParams,
} from './src/attempt-completion.ts';
export type {
  AttemptCompletionParams, AttemptCompletionResult, DeclaredArtifact,
} from './src/attempt-completion.ts';

export {
  SELF_INSPECT_TOOL_NAME, assembleSelfInspectPayload, canHandleSelfInspectTool, isSensitiveJsonKey,
  mcpEntryRevision, parseInspectSection, redactSensitiveJson, sanitizeMcpServerEntry,
  selfInspectSensitivityLevel,
} from './src/self-inspect.ts';
export type { InspectSection, SelfInspectPayloadParts } from './src/self-inspect.ts';

export {
  createSubContext, DEFAULT_PACK_TIMEOUT_SECS, MAX_CONCURRENCY, MAX_SUB_TOOLS,
  TOOL_PACK_EXECUTOR_NAME, TOOL_PACK_TOOL_NAME, canHandleToolPack,
} from './src/tool-pack.ts';
export type { ToolPackContext } from './src/tool-pack.ts';

// ---------------------------------------------------------------------------
// 工具描述符面（L07 `agent-skills` 的 legacy provider / PTC 准入策略消费；
// 对应 Rust `chat_v2/tool_descriptors.rs:46–725` 的静态注册表与纯判定）。
// ---------------------------------------------------------------------------
export { BUILTIN_DESCRIPTORS, isPtcAllowed } from './src/tool-descriptors.ts';
export type {
  GrantsScopeHint, SideEffectClass, ToolDescriptor, ToolSensitivity,
} from './src/tool-descriptors.ts';

export {
  TODO_NAMESPACE, TODO_TOOL_NAMES, createTodoList, createTodoStep, todoAddSchema, todoCompletedCount,
  todoCurrentRunning, todoGetSchema, todoInitSchema, todoIsAllDone, todoNextPending, todoToolSchemas,
  todoTotalCount, todoUpdateSchema,
} from './src/todo.ts';
export type { TodoList, TodoStatus, TodoStep, TodoTimestamp, TodoToolSchema } from './src/todo.ts';
/** L04 continue_message: same-connection read and shared executor memory, todo_executor.rs:265–349. */
export { loadPersistedTodoListWithConn, restoreTodoListFromDbWithConn } from './repository/todo.ts';
/** L03 tool-round: caller-owned connection/transaction write, todo_executor.rs:224–261. */
export { persistTodoListWithConn } from './repository/todo.ts';
export type { PersistedTodoList } from './repository/todo.ts';
export { getTodoList } from './src/todo-store.ts';

export interface AgentTodoService {
  /** todo_executor.rs:213–222: fresh chat_v2 connection per call; does not change executor memory. */
  persistTodoList(sessionId: string, messageId: string, variantId: string | null, list: TodoList): void;
  loadPersistedTodoList(sessionId: string): PersistedTodoList | null;
  /** Caller must acquire its stream registration before restoring (send_message.rs:2080–2107). */
  restoreTodoListFromDb(sessionId: string): TodoList | null;
  /** Clone of the executor-owned session store, not a separate continue-message cache. */
  getTodoList(sessionId: string): TodoList | null;
}

export {
  TASK_AUDIT_SCHEMA_VERSION, buildTaskAuditManifest, canHandleTaskAuditTool, isSecretKey,
  missingRequestedLayers, redactSecrets, taskAuditSensitivityLevel,
} from './src/task-audit.ts';
export type {
  AuditApproval, AuditExportArgs, AuditOutput, AuditToolCall, ChangeCoverage, ConnectorAuditTarget,
  TaskObjectHandleLike,
} from './src/task-audit.ts';

export {
  ROLE_PACK_EXECUTOR_NAME, ROLE_PACK_REGISTRY_REVISION, ROLE_PACK_TOOL_NAMES, canHandleRolePackTool,
  executeRolePackRead, findRolePack, rolePackConcurrencyClass, rolePackProvenance, rolePackRegistry,
  rolePackSensitivityLevel, selectedRolePack, validateRolePackInput,
} from './src/role-packs.ts';
export type { RolePack, RolePackWorkflow } from './src/role-packs.ts';

export {
  AGENT_PROFILE_METADATA_KEY, DEFAULT_PROFILE_ID, EXPLORER_PROFILE_ID, WORKER_PROFILE_ID,
  builtInAgentProfile, resolveAgentProfile,
} from './src/agent-profile.ts';
export type {
  AgentPermissions, AgentProfile, AgentProfileOverride, AgentProfileSelection, ApprovalPolicy,
  ContextInheritance, CustomAgentProfileDefinition, ReasoningEffort, ResolveAgentProfileOptions,
  SandboxMode,
} from './src/agent-profile.ts';

// L04 `CustomAgentExecutor` 复用的人设校验/原子写/共享文件锁。
export {
  atomicWrite, lockCustomAgentFiles, resolvePersonaPath, validatePersonaContent,
  withCustomAgentFileLock,
} from './src/custom-agent.ts';
export type { PersonaContentSummary } from './src/custom-agent.ts';
/** Production executor; registered by this plugin through `agentTools` when `agentWorkspace` exists. */
export { CUSTOM_AGENT_EXECUTOR_NAME, CustomAgentExecutor } from './src/custom-agent-executor.ts';

export {
  MAX_MESSAGE_PAGE_SIZE, MAX_SESSION_IMPORT_BLOCKS, MAX_SESSION_IMPORT_MESSAGES,
  MAX_TOOL_FIELD_CHARS, MAX_TOOL_OUTPUT_PREVIEW_CHARS, SESSION_TOOL_NAMES, blockToSummary,
  canHandleSessionTool, executeSessionGetMessagesWithDb, executeSessionListWithDb,
  hasDynamicSessionSensitivity, importSessionPayload, isSessionTool, markdownExportToToolValue,
  messageToToolValue, parseBoundedU32, parseExportRange, parseRoleFilter, parseSearchDateRange,
  prepareSessionExportWithDb, remapImportedSession, renderSessionMarkdown, resolveExportTitle,
  selectExportMessages, sessionSensitivityLevel, sessionSensitivityLevelForCall, toolOutputSummary,
} from './src/session-tools.ts';
export type {
  ImportRemapStats, PreparedSessionExport, RemappedImport, SessionAttachment, SessionBlock,
  SessionExportRange, SessionMessage, SessionMessageVariant,
} from './src/session-tools.ts';
export type { SessionImportRepository } from './repository/session-tools.ts';

export {
  LIST_RECENT_TASKS_LIMIT, LIST_RESULT_PREVIEW_CHARS, LIST_TASK_PREVIEW_CHARS,
  NOT_SUPER_SESSION_MESSAGE, closeWorkerCore, listWorkersCore, loadWorker, mergeSuperAgentMetadata,
  requireSuperTurn, taskSummary, workerTitle,
} from './src/super-session-exec.ts';

// L19 media-docs 消费的 legacy headless 白名单（headless.rs:584–637）。
export { LEGACY_HEADLESS_ALLOWED_TOOLS } from './src/headless.ts';
/** L04 worker schema injection: Rust headless.rs:664–1133, fresh list in Rust order. */
export { headlessToolSchemas } from './src/headless.ts';
export type { HeadlessToolSchema } from './src/headless-schemas.ts';
/** L04 composes these into L03 ChatToolRuntime.gate; no registry or alternate policy store here. */
export {
  trustedAutomationError,
  isTrustedAutomationPreauthorized as trustedAutomationPreauthorized,
  isToolAllowedByExecutionPolicy as executionPolicyAllows,
  installTrustedAutomationSession,
} from './src/headless.ts';
export type { TrustedSessionGuard } from './src/headless.ts';
// F2 `systemNotification` 的公开消费面（已合入 main 的 `electron/api.ts`）。
export type {
  SystemNotificationOutcome, SystemNotificationPort, SystemNotificationRequest,
} from './src/automation-notifications.ts';
export type {
  SuperTaskManager, SuperWorkerAgent, SuperWorkerCoordinator,
} from './src/super-session-exec.ts';

/** headless.rs:1192–1263; cancellation is caller-owned, not window-owned. */
export interface HeadlessTurnRequest {
  prompt: string;
  sessionMode: HeadlessSessionMode;
  namedSessionId?: string | null;
  modelId?: string | null;
  source: string;
  title?: string | null;
  hardTimeoutSecs?: number | null;
  maxToolRounds?: number | null;
  trustedProfile?: TrustedAutomationProfile | null;
  cancellationToken?: AbortSignal | null;
}
export interface HeadlessTurnResult {
  sessionId: string;
  assistantMessageId: string;
  status: string;
  summary: string;
  durationMs: number;
  error?: string;
}
export interface HeadlessSessionTurn {
  sessionId: string;
  prompt: string;
  modelId?: string | null;
  systemPromptAppend?: string | null;
  timeoutMs: number;
  cancellationToken?: AbortSignal | null;
}
export interface HeadlessTurnOutcome {
  sessionId: string;
  assistantMessageId: string;
  content: string;
  durationMs: number;
}

/**
 * Additive service boundary for L03/L04 and the shell.
 *
 * 跨 lane 能力只在依赖服务实际发布后注册（ACCEPTANCE O1 的协调结论）：
 * - `deliverInbox` 需要 `chat.send@1`；
 * - `runHeadlessTurn` / `runHeadlessAgentTurn` 需要 `chatSession`/`chatPipeline`
 *   上的 headless 执行入口。
 * 依赖缺失时这些成员为 `undefined`，而不是固定抛错的占位实现。
 */
export interface AgentSubagentService {
  getState(): SuperSessionState;
  setEnabled(enabled: boolean): SuperSessionState;
  ensure(): SuperSessionState;
  getSettings(): SuperSessionSettings;
  setSettings(settings: SuperSessionSettings): void;
  isEnabled(): boolean;
  onSessionRemoved(sessionId: string, hard: boolean): void;
  cancelWorkersDispatchedIn(sessionId: string, messageIds: string[]): void;
  /** `window` 是回合流事件的发送目标（Rust 命令注入的 `Window`）。 */
  deliverInbox?(request: DeliverInboxRequest, window: import('../../kernel/api.ts').WindowRef): Promise<DeliverOutcome>;
  runHeadlessTurn?(request: HeadlessTurnRequest): Promise<HeadlessTurnResult>;
  runHeadlessAgentTurn?(request: HeadlessSessionTurn): Promise<HeadlessTurnOutcome>;
}
/**
 * 与外壳 `electron/shell/background-residency.ts` 的 `BackgroundResidencyState` 同形；读不到的项一律为 false：
 * - `automation`：`should_keep_automation_background`（`automations.rs:4779-4792`）；
 * - `superAgent`：`super_agent.enabled` trim 后为 `"true"` 或 `"1"`（`state.rs:226-236`）；
 * - `quickAssistant`：`quick_assistant.background_enabled === "true"`；
 * - `notificationsDisabled`：`system-notification-policy === "never"`。
 */
export interface BackgroundResidencyState {
  automation: boolean;
  superAgent: boolean;
  quickAssistant: boolean;
  notificationsDisabled: boolean;
}

export interface AgentAutomationService {
  list(): Json;
  create(request: AutomationCreateCommandRequest): Promise<Json>;
  update(request: AutomationUpdateCommandRequest): Promise<Json>;
  setEnabled(automationId: string, expectedVersion: number, enabled: boolean): Promise<Json>;
  delete(automationId: string, expectedVersion: number): Promise<Json>;
  runNow(automationId: string, expectedVersion: number): Promise<Json>;
  runs(automationId: string | null, limit: number | null): Json;
  retryRun(runId: string): Promise<Json>;
  cancelRun(runId: string): Promise<Json>;
  summary(): Json;
  setBackgroundEnabled(enabled: boolean): Json;
  shouldKeepBackground(): boolean;
  /** 关窗后台驻留的判定（`lib.rs:1714-1760`），经 `meta.remote` 开放给本地窗口；外壳在主窗口关闭时调用。 */
  backgroundResidency(): BackgroundResidencyState;
  pauseScheduler(): void;
  resumeScheduler(): void;
  isSchedulerPaused(): boolean;
  markAppExiting(): void;
  appIsExiting(): boolean;
  cancelActiveRunsForEmergencyStop(): void;
}

/** `agentSubagent` 服务版本描述（ARCHITECTURE.md §3）。 */
export const agentSubagentService = { name: 'agentSubagent', version: '1.0.0' } as const;
/** `agentAutomation` 服务版本描述（ARCHITECTURE.md §3）。 */
export const agentAutomationService = { name: 'agentAutomation', version: '1.0.0' } as const;
export const agentTodoService = { name: 'agentTodo', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentSubagent: AgentSubagentService;
    agentAutomation: AgentAutomationService;
    agentTodo: AgentTodoService;
  }
}
