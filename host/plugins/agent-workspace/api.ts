import type {} from '@deepseek-ai/cordis';
import type { RuntimeRoot, WorkspaceWarningEvent } from '../../../contracts/ipc/generated/L05-agent-workspace.ts';
import type { SleepManager, WakeResultInfo } from './src/workspace/sleep-manager.ts';
import type { SubagentTaskManager } from './src/workspace/subagent-task.ts';
import type { PermissionPreset, ToolSensitivity } from './src/approval-scope/core.ts';
export { createTransformSandboxBackend, transformSandboxPolicy } from './src/tools/transform-sandbox.ts';
export type { AsyncTransformSandboxBackend, TransformSandboxNativePort } from './src/tools/transform-sandbox.ts';
export { createPlatformSandboxBackend, sandboxPolicy } from './src/tools/shell-sandbox.ts';
export type { SandboxBackend, SandboxCommand, SandboxPolicy, SandboxEffectReport } from './src/tools/shell-sandbox.ts';
export type { SleepManager, WakeResultInfo, WakeUpPayload, WakeReason, WakeReceiver } from './src/workspace/sleep-manager.ts';
export type { SubagentTaskManager } from './src/workspace/subagent-task.ts';
export { newSleepBlockData } from './src/workspace/sleep-manager.ts';
export { newSubagentTask } from './src/workspace/subagent-task.ts';
export { WorkspaceInjector, InjectionThrottle, MAX_INJECTED_MESSAGE_CHARS } from './src/workspace/injector.ts';
export type { InjectionResult, WorkspaceInjectionCoordinator } from './src/workspace/injector.ts';
export {
  immutableShellCommandGuard, ShellCommandGuardEffect, analyzeShellCommand,
  isPrivilegeEscalationToolForArgs, neverRememberApprovalForArgs, redactToolArgumentsForDisplay,
  runtimeRootBindingFromArgs, makeRuntimeScopeKey, makeRuntimeApprovalScope,
  isShellRuntimeToolForArgs, ignoresBroadApprovalBypassForArgs,
  normalizedShellRuntimeLocation, attachRuntimeRootApprovalBinding, attachShellEnvPolicyFacts,
} from './src/approval-scope.ts';
export type { RuntimeApprovalScope, ShellCommandAnalysis, PermissionPreset, ToolSensitivity } from './src/approval-scope.ts';
export { enforceForCall as enforceShellCommandPolicy, applyToSensitivity as applyShellCommandSensitivity,
  SHELL_COMMAND_RULES_KEY } from './src/tools/shell-policy.ts';
export type { ShellPolicyDecision } from './src/tools/shell-policy.ts';
export { isExternalMcpCall, toolApprovalSource, toolApprovalDomain, resolveEffectiveSensitivity,
  GLOBAL_TOOL_APPROVAL_BYPASS_KEY } from './src/tool-approval-policy.ts';
export { envPolicyFacts } from './src/tools/shell-env.ts';
export { runtimeSupportReadRoots } from './src/tools/shell-execute/context.ts';
/** Rust approval_scope.rs:141: namespace-aware local-shell classification, not a schema heuristic. */
export { isLocalShellExecuteTool } from './src/approval-scope/classification.ts';
export type { ShellCommandGuardDecision } from './src/approval-scope.ts';
export { HEADLESS_ALLOWED_TOOLS, CHATANKI_READONLY_TOOLS } from './src/workspace/tool-registry.ts';
export {
  runtimeRootById, revalidateRuntimeRoot, authorizeRuntimeRootPath, runtimeRootsForSession,
  runtimeRootBindingToken, artifactRoot, tempRoot, SKILL_TRUST_KEY_PREFIX, resolveStagedFileInTempRoot,
} from './src/runtime-roots.ts';
export type { StagedFile, RuntimeRootDeps, SettingsLike, AuthorizeRuntimeRootOutcome, RuntimeRootApprovalBinding } from './src/runtime-roots.ts';
export { skillPackageRuntimeRoot } from './src/skill-packages.ts';
export { removeSessionFileIrreversible } from './src/write-backups.ts';
/**
 * `workspace_change_set::write_bytes` for owner-delegated writes (media Office `output_target=workspace`).
 * `(root, checkpointRoot, rootId, relativePath, content, expectedCurrentHash?) => MutationReceipt`; a non-null
 * expected hash requires the current file to match, null/undefined requires the target not to exist.
 */
export { writeBytes } from './src/workspace-change-set.ts';
export type { MutationReceipt as WorkspaceMutationReceipt } from './src/workspace-change-set.ts';
export type { SkillPathOptions } from './src/skill-packages.ts';
export { resolveGroupPreferredRuntimeRoot } from './src/tools/workspace-fs-contribution.ts';
export type { GroupPreferredRuntimeRoot } from './src/tools/workspace-fs-contribution.ts';
export { shellRuntimeApprovalBinding } from './src/runtime-root-approval.ts';
export { immutableCommandGuardForToolCall, shellCommandDecision, effectiveSensitivity,
  resolveLocalShellApprovalArguments, runtimeApprovalScope, vfsFileExists } from './src/tool-approval-gate.ts';
export type { ApprovalGateCall, LocalShellApprovalDeps, LocalShellApprovalResult } from './src/tool-approval-gate.ts';
/**
 * F3-V2-05 owner operation: delete workspace_index on the caller's SqlExecutor.
 * Returns void, missing id is a no-op, SQL errors propagate unchanged. Does not
 * start/commit a transaction or remove files. F3 calls this after preparing the
 * journal intent and before releasing its workspace_deletion_prepare savepoint.
 */
export { deleteWorkspaceIndex as deleteWorkspaceIndexWithConn } from './repository/chat-v2-repository.ts';

/** L13/L19 executor context: session and loaded skill roots come from the caller. */
export interface RuntimeRootLookupContext {
  session_id?: string;
  skill_package_roots?: Readonly<Record<string, string>> | null;
}
/** DstuUploadRoots port: lookup never creates artifact/temp directories. */
export interface RuntimeRootsService {
  rootById(rootId: string, context: RuntimeRootLookupContext): RuntimeRoot;
  revalidate(root: RuntimeRoot): string;
  /** `Path::is_dir` for AGENTS.md root candidates (group project root, workspace root); false on any metadata error. */
  isDirectory?(path: string): boolean;
  /** `std::env::current_dir().ok()`. */
  currentDir?(): string | null;
}

/** L04 b0ed6a135 candidate; remove this narrow consumer view once its API is integrated. */
export interface WorkspaceChatSessionDeletion {
  deleteSessionV2(sessionId: string): void;
}
export {
  createVfsResolver, escapeXmlContent, escapeXmlAttr,
  blocksToContent, imageBlock, inferMediaTypeFromName, textBlock,
  resolveEssay, resolveInsightCard, resolveMindmap, resolveNote, resolveTranslation,
} from './src/vfs-resolver.ts';
export type { ContentBlock } from './src/vfs-resolver.ts';
export { textbookFileRow } from './repository/vfs-resolver-repository.ts';
export type AgentVfsResolver = ReturnType<typeof import('./src/vfs-resolver.ts').createVfsResolver>;
export { completionMessageExists, nowCompletionTimestamp } from './src/workspace/completion-outbox.ts';
export type { CompletionDelivery, NewCompletionDelivery, CompletionDeliveryState, EnqueueOutcome } from './src/workspace/completion-outbox.ts';
export type AgentCompletionOutbox = Pick<import('./src/workspace/completion-outbox.ts').CompletionOutbox,
  'enqueue' | 'get' | 'getByRunId' | 'markDeliveredByDeliveryId' | 'reclaimExpiredClaims'
  | 'claimPending' | 'releaseClaim' | 'markDelivered' | 'markExpired'>;
export type { VfsResourceRef, VfsContextRefData, VfsResolverServices, VfsResolverLogger } from './src/vfs-resolver.ts';
export * from './src/config.ts';
export * from './src/utf8-paged-read.ts';
export { normalizeRuntimeRelativePath, safeSessionDir, cleanupSessionRuntimeRoots, sessionRoot,
  effectiveRuntimeRootId, explicitRuntimeRootIdFromArgs, redactPathForDisplay } from './src/runtime-paths.ts';

// 跨 lane 消费面（不得复制实现）：
// - L04 工具花名册：workspace tool executor + schemas
// - L24 chatanki 只读卡面：worker→coordinator 只读作用域注册表
export {
  WorkspaceToolExecutor, getWorkspaceToolSchemas, WORKSPACE_WORKER_READY_EVENT,
  toolNames as workspaceToolNames,
} from './src/tools/workspace-executor.ts';
export type {
  WorkspaceAgentSessionStore, WorkspaceAgentRunRequest, WorkspaceAgentRunResult,
  WorkspaceExecutorContext, WorkerReadyEvent,
} from './src/tools/workspace-executor.ts';
export {
  WorkspaceCardReadScopeGuard, installWorkspaceCardReadScope, workspaceCardReadScope,
} from './src/workspace/card-read-scope.ts';
export type { WorkspaceCardReadScope } from './src/workspace/card-read-scope.ts';
/** `card_read_scope.rs` lookup for card readers in other plugins; a missing service reads as "not installed". */
export interface AgentCardReadScopeService {
  lookup(sessionId: string): import('./src/workspace/card-read-scope.ts').WorkspaceCardReadScope | null;
}

// 自定义子代理 profile（Rust `workspace/custom_agents.rs`，消费方 L06 SubagentExecutor）。
export {
  AgentProfileResolver, DEFAULT_PROFILE_ID, WORKER_PROFILE_ID, EXPLORER_PROFILE_ID,
} from './src/workspace/agent-profile.ts';
/**
 * `(modelId: string, configs: readonly PersonaModelConfig[]) => void`.
 * configs is the caller's current runtime model catalog; ids match configuration ids, not model names.
 * Throws Error with Rust's full PERSONA_MODEL_NOT_FOUND / DISABLED / UNSUPPORTED message.
 * The calling command preserves that string in its own Result/CommandError boundary.
 */
export { validatePersonaModelConfig } from './src/workspace/agent-profile.ts';
export {
  loadCustomProfiles, findCustomProfile, customProfileSource, listCustomAgentFiles, frontmatterSummary, safeToolSet,
} from './src/workspace/custom-agents.ts';
export type {
  AgentProfile, AgentProfileSelection, AgentRuntimeConfig, CustomProfileSource, PersonaModelConfig,
} from './src/workspace/agent-profile.ts';
export type {
  CustomAgentFileInfo, FrontmatterSummary,
} from './src/workspace/custom-agents.ts';

export type { RuntimeRoot, RuntimeRootKind, RuntimeRootAccess, RuntimeDirectoryPage,
  RuntimeFilePreview, SkillTrustState, WorkspaceWarningEvent } from '../../../contracts/ipc/generated/L05-agent-workspace.ts';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type WorkspaceStatus = 'active' | 'completed' | 'archived';
export type AgentRole = 'coordinator' | 'worker';
export type AgentStatus = 'idle' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'closed';
export type MessageType = 'task' | 'progress' | 'result' | 'query' | 'correction' | 'broadcast';
export type MessageStatus = 'pending' | 'delivered' | 'processed';
export type InboxStatus = 'unread' | 'read' | 'processed';
export type DocumentType = 'plan' | 'research' | 'artifact' | 'notes';

// Domain values use their serde names; timestamps are RFC3339 UTC strings.
export interface Workspace {
  id: string; name: string | null; status: WorkspaceStatus; creatorSessionId: string;
  createdAt: string; updatedAt: string; metadata?: JsonValue;
}
export interface WorkspaceAgent {
  sessionId: string; workspaceId: string; role: AgentRole; skillId: string | null;
  status: AgentStatus; joinedAt: string; lastActiveAt: string; metadata?: JsonValue;
}
export interface WorkspaceMessage {
  id: string; workspaceId: string; senderSessionId: string; targetSessionId: string | null;
  messageType: MessageType; content: string; status: MessageStatus; createdAt: string; metadata?: JsonValue;
}
export interface InboxItem {
  id: number; sessionId: string; messageId: string; priority: number; status: InboxStatus; createdAt: string;
}
export interface WorkspaceDocument {
  id: string; workspaceId: string; docType: DocumentType; title: string; content: string;
  version: number; updatedBy: string; updatedAt: string;
}
export interface WorkspaceContext {
  workspaceId: string; key: string; value: JsonValue; updatedBy: string; updatedAt: string;
}
export type SubagentTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
export interface SubagentTaskData {
  id: string; workspaceId: string; agentSessionId: string; skillId: string | null;
  initialTask: string | null; status: SubagentTaskStatus; createdAt: string;
  startedAt: string | null; completedAt: string | null; resultSummary: string | null;
}
export type WakeCondition = { type: 'any_message' | 'result_message' | 'all_completed' } | { type: 'timeout'; ms: number };
export type SleepStatus = 'sleeping' | 'awakened' | 'timeout' | 'cancelled';
export interface SleepBlockData {
  id: string; workspaceId: string; coordinatorSessionId: string; awaitingAgents: string[];
  wakeCondition: WakeCondition; status: SleepStatus; timeoutAt: string | null; createdAt: string;
  awakenedAt: string | null; awakenedBy: string | null; awakenMessage: string | null;
  messageId: string | null; blockId: string | null;
}
export interface WorkspaceCoordinator {
  customAgentsDir(): string;
  customAgentsPendingDir(): string;
  createWorkspace(creatorSessionId: string, name: string | null): Workspace;
  getWorkspace(workspaceId: string): Workspace | null;
  closeWorkspace(workspaceId: string): void;
  deleteWorkspace(workspaceId: string): void;
  registerAgent(workspaceId: string, sessionId: string, role: AgentRole, skillId: string | null, metadata: JsonValue | null): WorkspaceAgent;
  unregisterAgent(workspaceId: string, sessionId: string): void;
  updateAgentStatus(workspaceId: string, sessionId: string, status: AgentStatus): void;
  listAgents(workspaceId: string): WorkspaceAgent[];
  getAgent(workspaceId: string, sessionId: string): WorkspaceAgent | null;
  updateAgentMetadata(workspaceId: string, sessionId: string, metadata: JsonValue | null): void;
  hasAgentSentMessageSince(workspaceId: string, agentSessionId: string, since: string): boolean;
  sendMessage(workspaceId: string, senderId: string, targetId: string | null, messageType: MessageType, content: string): WorkspaceMessage;
  updateMessageMetadata(workspaceId: string, messageId: string, metadata: JsonValue): void;
  drainInbox(workspaceId: string, sessionId: string, limit: number): WorkspaceMessage[];
  peekInbox(workspaceId: string, sessionId: string): WorkspaceMessage[];
  pendingInboxCount(workspaceId: string, sessionId: string): number;
  hasPendingMessages(workspaceId: string, sessionId: string): boolean;
  reEnqueueMessage(workspaceId: string, sessionId: string, messageId: string): void;
  setContext(workspaceId: string, key: string, value: JsonValue, updatedBy: string): void;
  getContext(workspaceId: string, key: string): WorkspaceContext | null;
  listContext(workspaceId: string): WorkspaceContext[];
  saveDocument(workspaceId: string, doc: WorkspaceDocument): void;
  getDocument(workspaceId: string, docId: string): WorkspaceDocument | null;
  listDocuments(workspaceId: string): WorkspaceDocument[];
  listMessages(workspaceId: string, limit: number): WorkspaceMessage[];
  getTaskManager(workspaceId: string): SubagentTaskManager;
  getSleepManager(workspaceId: string): SleepManager;
  emitWarning(warning: WorkspaceWarningEvent): void;
  emitCoordinatorAwakened(info: WakeResultInfo): void;
  shutdownAllSleeps(): void;
  ensureMemberOrCreator(workspaceId: string, sessionId: string): void;
  isMemberOrCreatorSession(workspaceId: string, sessionId: string): boolean;
  /**
   * `workspace_change_set::write_bytes` for owner-delegated writes (media Office `output_target=workspace`):
   * hash-bound overwrite with a checkpoint under `checkpointRoot`, no-clobber create when `expectedCurrentHash` is null.
   */
  writeBytes(root: string, checkpointRoot: string, rootId: string, relativePath: string, content: Uint8Array,
    expectedCurrentHash: string | null): import('./src/workspace-change-set.ts').MutationReceipt;
  incrementMessageRetryCount(workspaceId: string, messageId: string): number;
  loadedWorkspaceIds(): string[];
  enterMaintenanceMode(): Promise<void>;
  exitMaintenanceMode(): void;
  isInMaintenanceMode(): boolean;
}
export interface ApprovalResponse {
  sessionId: string; toolCallId: string; toolName: string; approved: boolean;
  reason: string | null; remember: boolean; rememberSession: boolean;
}
export interface ApprovalRespondResult { delivered: boolean; settingKey: string | null }
export interface ApprovalManager {
  register(toolCallId: string): Promise<ApprovalResponse>;
  registerWithScope(sessionId: string, toolCallId: string, toolName: string, argumentsValue: JsonValue): Promise<ApprovalResponse>;
  respond(response: ApprovalResponse): boolean;
  respondWithResult(response: ApprovalResponse): ApprovalRespondResult;
  cancelWithSession(sessionId: string, toolCallId: string): boolean;
  rejectAllPending(reason: string): number;
  cancel(toolCallId: string): boolean;
  checkRemembered(toolName: string, argumentsValue: JsonValue): boolean | null;
  checkSessionRemembered(sessionId: string, toolName: string, argumentsValue: JsonValue): boolean | null;
  clearSessionRemembered(sessionId: string): void;
  clearRemembered(toolName: string, argumentsValue: JsonValue): void;
  clearAllRemembered(): void;
  defaultTimeout(): number;
  pendingCount(): number;
}
/** Additional tool-runtime capabilities of the real agentApproval provider. */
export interface ToolApprovalManager extends ApprovalManager {
  registerWithPermissionPreset(sessionId: string, toolCallId: string, toolName: string, argumentsValue: JsonValue,
    preset: PermissionPreset, sensitivity: ToolSensitivity): Promise<ApprovalResponse>;
  generateDescription(toolName: string, argumentsValue: JsonValue): string;
}
// 工具执行器工厂：L04 的工具花名册从这里实例化本 lane 的 executor。
// Rust `AppExecutorRoster` 由 app 层组装；Host 侧花名册归 L04，故本 lane 只
// 发布构造入口，不复制花名册的策略与注册逻辑。
export {
  createAgentWorkspaceToolExecutors,
} from './src/tools/executors.ts';
export type {
  AgentWorkspaceToolExecutors, GitRunShell,
} from './src/tools/executors.ts';
export * from './src/handout-ir.ts';
export * from './src/bounded-output-artifact.ts';
export * from './src/project-knowledge-dag.ts';

/** 服务版本描述（ARCHITECTURE.md §3）：小版本只增不改。 */
export const agentWorkspaceService = { name: 'agentWorkspace', version: '1.0.0' } as const;
export const agentApprovalService = { name: 'agentApproval', version: '1.0.0' } as const;
export const agentWorkspaceToolsService = { name: 'agentWorkspaceTools', version: '1.0.0' } as const;
export const agentVfsResolverService = { name: 'agentVfsResolver', version: '1.0.0' } as const;
export const agentCompletionOutboxService = { name: 'agentCompletionOutbox', version: '1.0.0' } as const;
export const runtimeRootsService = { name: 'runtimeRoots', version: '1.0.0' } as const;
export const agentTransformSandboxService = { name: 'agentTransformSandbox', version: '1.0.0' } as const;
export const agentCardReadScopeService = { name: 'agentCardReadScope', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTransformSandbox: import('./src/tools/transform-sandbox.ts').AsyncTransformSandboxBackend;
    runtimeRoots: RuntimeRootsService;
    agentVfsResolver: AgentVfsResolver;
    agentCompletionOutbox: AgentCompletionOutbox;
    agentWorkspace: WorkspaceCoordinator;
    agentApproval: ToolApprovalManager;
    agentWorkspaceTools: import('./src/tools/executors.ts').AgentWorkspaceToolExecutors;
    agentCardReadScope: AgentCardReadScopeService;
  }
}
