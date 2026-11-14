/** L04 public service surface. Rust sources: chat_v2/{database,types,events,tools/executor}.rs. */
import type { Context } from '@deepseek-ai/cordis';
import type { WindowRef } from '../../kernel/api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../platform/storage/api.ts';
import type { ParsedDateTime } from '../../platform/time/api.ts';
import type { PlanAuthorityState, SessionAuthorityState } from './src/session-authority.ts';
export type { PlanAuthorityState, PlanStatus, SessionAuthorityState } from './src/session-authority.ts';
export { newPendingPlan, bindPlanToCall, markPlanApproved, markPlanExpired,
  isPlanBatchActive, isPlanActiveForBinding, sessionAuthorityFromMetadata,
  applySessionAuthorityMetadata } from './src/session-authority.ts';
import type { BlockReplayData } from './repository/block-replay.ts';
export type { BlockReplayData } from './repository/block-replay.ts';
import type { CompactionRecord } from './repository/compactions.ts';
export type { CompactionRecord } from './repository/compactions.ts';
export { historyBoundaryId } from './repository/compactions.ts';
import type {
  ChatSession, ChatMessage, MessageBlock, SessionState, McpToolSchema, ToolResultInfo, TokenUsage, Variant, SharedContext, ReplaySkillPayloadSnapshot,
} from '../../../contracts/ipc/generated/L04-chat-session.ts';

export type * from '../../../contracts/ipc/generated/L04-chat-session.ts';
export { ChatV2Error } from './src/error.ts';
export type { ChatV2ErrorData } from './src/error.ts';
export { ChatV2State, StreamGuard, AgentKillSwitch, KILL_SWITCH_BLOCKED_MESSAGE,
  KILL_SWITCH_STATE_UNAVAILABLE_MESSAGE, KILL_SWITCH_CHANGED_EVENT } from './src/state.ts';
export type { StreamRegistration } from './src/state.ts';
export { MessageSender, createSendExecution, runSendMessagePipeline, runSendMessagePipelineOwned } from './src/send-message.ts';
export type { BackendSendRequest, ChatSendExecution, SendPipelinePort, SendGoalRuntime, MessageSenderDeps } from './src/send-message.ts';
export { GoalRuntime } from './src/goal-runtime.ts';
export type { GoalRuntimeDeps } from './src/goal-runtime.ts';
export type { CompactionPipelinePort } from './src/compaction-actions.ts';
export { VariantExecutionContext, ParallelExecutionManager } from './src/variant-context.ts';
export type { EmergencyCancelHook } from './src/kill-switch.ts';
export type { StaleAnkiBlockReaper } from './src/stale-anki-reaper.ts';
export { markAllWorkersCancelled } from './src/workspace-runtime.ts';
export { attachmentError, attachmentNotFoundError, requiredAttachmentId, localizedAttachmentFailure } from './src/attachment-errors.ts';
export { loadSessionRagScope } from './src/retrieval-scope.ts';
export { decodeVfsContextRefData } from './src/context-restore.ts';
export interface ChatAttachmentErrors {
  requiredId(args: unknown, key: string): string;
  notFound(detail: string): string;
  localize(error: string): string;
}
/** `load_session_rag_scope(db, session_id)` (builtin_retrieval_executor.rs): the caller passes `ctx.chat_v2_db`. */
export interface ChatRetrievalScope { loadSessionRagScope(database: ChatV2Database, sessionId: string): string[] | null }
export { generateVariantId, newVariant, setVariantStreaming, setVariantSuccess, setVariantError,
  setVariantCancelled, setVariantInterrupted, canContinueVariant, isVariantTerminal, variantWithUsage,
  setVariantUsage, getVariantUsage, addVariantBlock, newSharedContext, sharedContextHasSources,
  isMultiVariant, getActiveBlockIds, addVariant, removeVariant, variantCount, selectBestActiveVariant } from './src/variant-values.ts';
export { canActivateVariant, canRetryVariant, getVariant } from './src/variant-actions.ts';
export { tokenUsageFromApi, tokenUsageFromApiWithCache, tokenUsageFromEstimate, tokenUsageZero,
  tokenUsageHasTokens, tokenSourceDisplay, accumulateTokenUsage } from './src/types.ts';
export { ChatExecutionContext, emitToolProgressLine } from './src/execution-context.ts';
export type { ExecutionContextInit } from './src/execution-context.ts';
export { ToolExecutorRegistry, getToolTimeoutSecs, getExecutorTimeoutSecs,
  registryCancelledError, registryTimeoutError } from './src/executor-registry.ts';
export type { ToolApprovalPolicyPort, ToolRiskSnapshot } from './src/executor-registry.ts';
export { BUILTIN_DESCRIPTORS, lookupToolDescriptor, isHeadlessReadonly, isPtcAllowed, grantsScopeHint } from './src/tool-descriptors.ts';
export { canonicalToolShortName, isControlTool, toolAllowEntryMatches, isToolAllowedByExecutionPolicy } from './src/tool-policy.ts';
export { registerAskUserCallback, handleAskUserResponse } from './src/ask-user.ts';
export type { AskUserResponse, AskUserResolver } from './src/ask-user.ts';
export { getSession as getSessionWithConn, createSession as createSessionWithConn,
  updateSession as updateSessionWithConn, listSessions as listSessionsWithConn,
  countSessions as countSessionsWithConn, updateSessionGroup as updateSessionGroupWithConn } from './repository/sessions.ts';
export { createMessage as createMessageWithConn, getMessage as getMessageWithConn,
  updateMessage as updateMessageWithConn,
  loadSessionMessagesPage as loadSessionMessagesPageWithConn,
  loadSessionMessagesWindow as loadSessionMessagesWindowWithConn } from './repository/messages.ts';
export { createBlock as createBlockWithConn, createBlocksBatch as createBlocksBatchWithConn,
  getCompactionSummaryMessageIds as getCompactionSummaryMessageIdsWithConn } from './repository/blocks.ts';
export { getGoal as goalGetWithConn, insertGoal as goalInsertWithConn,
  updateStatus as goalUpdateStatusWithConn, addUsage as goalAddUsageWithConn } from './repository/goals.ts';
export { saveSessionState as saveSessionStateWithConn } from './repository/session-state.ts';
export type { SessionSkillState } from './repository/session-state.ts';
export { getGroup as getGroupWithConn, listGroups as listGroupsWithConn,
  createGroup as createGroupWithConn, updateGroup as updateGroupWithConn,
  archiveGroup as archiveGroupWithConn, restoreGroup as restoreGroupWithConn,
  softDeleteGroup as softDeleteGroupWithConn, permanentlyDeleteGroup as permanentlyDeleteGroupWithConn,
  listSessionIdsOwnedByGroup } from './repository/groups.ts';
export { getSessionTags as getSessionTagsWithConn, getTagsForSessions as getTagsForSessionsWithConn,
  addManualTag as addManualTagWithConn, removeTag as removeTagWithConn,
  listAllTags as listAllTagsWithConn, searchContent as searchContentWithDateRange } from './repository/search.ts';
export { generateMessageId, generateBlockId, newUserMessage, newAssistantMessage,
  newMessageBlock, newContentBlock, newThinkingBlock, newToolBlock,
  setBlockRunning, setBlockSuccess, setBlockError, appendBlockContent } from './src/message-values.ts';
export type { AttachmentInput, UserMessageParams, UserMessageResult } from './src/user-message-builder.ts';
export { newUserMessageParams, buildUserMessage, convertAttachmentInputToMeta,
  extractUserRefsSnapshot, createUserRefsSnapshot } from './src/user-message-builder.ts';
export { newContextRef, newContextSnapshot, addUserContextRef, addRetrievalContextRef,
  contextSnapshotHasRefs, contextSnapshotAllResourceIds, contextRefToSendRef, sendRefToContextRef } from './src/context-snapshot.ts';
export type { WorkspaceRuntimeCoordinator, WorkspaceRuntimeTaskManager, WorkspaceWakeInfo } from './src/workspace-runtime.ts';
export { cancelWorkspaceAgentBackend } from './src/workspace-runtime.ts';
/** grants.rs: G02 DelegatedGrant registry; L03 hooks.rs:340 reads it before the allowlist gate. */
export {
  lookupGrantForSession, ensureGrantLive, checkGrantLiveness, grantDenialMessage, grantEffectiveTools,
  currentEpochFor, currentGlobalEpoch, revokeAllGrants, revokeGrantsFor, toolScopeAllows,
  toolScopeFromAllowEntry, scopesFromAllowedTools, DELEGATED_GRANT_SCHEMA_VERSION,
} from './src/grants.ts';
export type { DelegatedGrant, GrantDenial, ToolScope, ObjectScope } from './src/grants.ts';
export type { ToolFacePrefixSnapshot, MicrocompactAnchor } from './src/session-metadata.ts';
export { markAvailableSkillsSnapshotStale as markAvailableSkillsSnapshotStaleWithConn } from './src/session-metadata.ts';
export { AGENTS_MD_MAX_CHARS, AgentsMdError, globalAgentsRoot, resolveAgentsMdPath,
  ensureAgentsMdWithinRoot, sanitizeAgentsMdContent, truncateAgentsMdContent,
  readAgentsMdFile, loadAgentsInstructions } from './src/agents-md.ts';
/** Requested L02 seam; currently missing from LLMManager's published service. */
export type { OcrManager } from './src/ocr.ts';
export { ChatV2EventEmitter as ChatV2Emitter, BackendEventsSink, NoopEventSink,
  EVENT_PHASE, EVENT_TYPE, SESSION_EVENT_TYPE, CHUNK_BATCH_WINDOW_MS, CHUNK_BATCH_MAX_BYTES,
  buildGoalUpdatedPayload, clearSessionSequenceCounter, emitFailureCount,
  nextSessionSequenceId } from './src/events.ts';
export type { BackendEvent, SessionEvent, ExecutionEventSink, BackendEventsLike,
  EventLogger } from './src/events.ts';

export type AuthorityMode = 'ask' | 'plan' | 'craft';
export type PermissionPreset = 'cautious' | 'relaxed' | 'full_access' | 'danger_full_access';
export type ToolSensitivity = 'low' | 'medium' | 'high';
export type ToolConcurrency = 'read_only' | 'safe_parallel' | 'serial';
export interface ToolCall { id: string; name: string; arguments: unknown; }

/** Connections and transactions are supplied by F3, never a second SQLite driver. */
export interface ChatV2Database {
  getConn(): DatabaseHandle;
  getConnSafe(): DatabaseHandle;
  dbPath(): string;
  isInMaintenanceMode(): boolean;
  getSchemaVersion(): number;
  getStatistics(): {
    session_count: number; message_count: number; block_count: number;
    attachment_count: number; schema_version: number;
  };
}

export interface ChatV2EventEmitter {
  emitStart(type: string, messageId: string, blockId: string | null, payload: unknown | null, variantId: string | null): void;
  emitChunk(type: string, blockId: string, chunk: string, variantId: string | null): void;
  emitEnd(type: string, blockId: string, result: unknown | null, variantId: string | null): void;
  emitError(type: string, blockId: string, error: string, variantId: string | null): void;
  emitStartWithMeta(type: string, messageId: string, blockId: string | null, payload: unknown | null, variantId: string | null, skillStateVersion: number | null, roundId: string | null): void;
  emitEndWithMeta(type: string, blockId: string, result: unknown | null, variantId: string | null, skillStateVersion: number | null, roundId: string | null): void;
  emitErrorWithMeta(type: string, blockId: string, error: string, variantId: string | null, skillStateVersion: number | null, roundId: string | null): void;
}

/** Backend-owned context; snake_case fields retain the Rust executor vocabulary. */
export interface ExecutionContext {
  session_id: string;
  message_id: string;
  block_id: string;
  variant_id: string | null;
  skill_state_version: number | null;
  round_id: string | null;
  tool_call_id: string | null;
  emitter: ChatV2EventEmitter;
  services: Context;
  canvas_note_id: string | null;
  tauri_window: WindowRef | null;
  chat_v2_db: ChatV2Database | null;
  skill_contents: Record<string, string> | null;
  skill_embedded_tools: Record<string, McpToolSchema[]> | null;
  skill_admission_errors: Record<string, string> | null;
  skill_package_roots: Record<string, string> | null;
  execution_allowed_tools: string[] | null;
  cancellation_token: AbortSignal | null;
  shell_guard_approved: boolean;
  shell_authority_admission: [AuthorityMode, PermissionPreset] | null;
  admitted_tool_dispatcher: AdmittedToolDispatcher | null;
  rag_top_k: number | null;
  rag_enable_reranking: boolean | null;
  memory_enabled: boolean;
  rag_enabled: boolean;
  web_search_enabled: boolean;
  /** executor.rs `question_authoring_config`: the turn's resolved chat model (tool_loop.rs:3367). */
  question_authoring_config: import('../llm/api.ts').ApiConfig | null;
  hasFrontend(): boolean;
  tryWindow(): WindowRef | null;
  windowRef(): WindowRef;
  runId(): string;
  isCancelled(): boolean;
  /** executor.rs:294 `question_authoring_route`. */
  questionAuthoringRoute(): Record<string, unknown> | null;
  saveToolBlock(result: ToolResultInfo): void;
  emitToolCallStart(toolName: string, input: unknown, toolCallId: string | null): void;
  emitToolCallEnd(result: unknown | null): void;
  emitToolCallError(error: string): void;
  emitToolProgress(phase: string, percent: number | null, message: string | null): void;
  emitToolProgressPayload(payload: unknown): void;
}

export interface AdmittedToolDispatcher {
  dispatchWithAdmission(call: ToolCall, context: ExecutionContext): Promise<ToolResultInfo>;
}
export interface ToolExecutor {
  canHandle(toolName: string): boolean;
  execute(call: ToolCall, context: ExecutionContext): Promise<ToolResultInfo>;
  sensitivityLevel?(toolName: string): ToolSensitivity;
  sensitivityLevelForCall?(toolName: string, args: unknown): ToolSensitivity;
  hasDynamicSensitivity?(toolName: string): boolean;
  concurrencyClass?(toolName: string): ToolConcurrency;
  managesCancellation?(toolName: string): boolean;
  resultCharBudget?(toolName: string): number | null;
  name(): string;
}

export interface ChatSessionService {
  readonly database: ChatV2Database;
  createMessageSender(deps: import('./src/send-message.ts').MessageSenderDeps): import('./src/send-message.ts').MessageSender;
  createSendExecution(pipeline: import('./src/send-message.ts').SendPipelinePort,
    state: import('./src/state.ts').ChatV2State): import('./src/send-message.ts').ChatSendExecution;
  createGoalRuntime(deps: import('./src/goal-runtime.ts').GoalRuntimeDeps): import('./src/goal-runtime.ts').GoalRuntime;
  /**
   * The GoalRuntime of chat's own send binding (present while chatPipeline.execute, llm and backgroundTasks are
   * bound). Sharing it lets `cancelInFlight` reach continuations started by other senders.
   */
  activeGoalRuntime(): import('./src/goal-runtime.ts').GoalRuntime | undefined;
  registerEmergencyCancelHook(hook: import('./src/kill-switch.ts').EmergencyCancelHook): import('../../kernel/api.ts').Disposer;
  /**
   * `register_stale_anki_block_reaper`: the first registrant wins; a second call
   * throws `SlotOccupied` until the first disposer runs.
   */
  registerStaleAnkiBlockReaper(reaper: import('./src/stale-anki-reaper.ts').StaleAnkiBlockReaper): import('../../kernel/api.ts').Disposer;
  loadAgentsInstructions(workspaceRoot: string | null): string | null;
  createExecutionContext(init: import('./src/execution-context.ts').ExecutionContextInit): import('./src/execution-context.ts').ChatExecutionContext;
  createVariantExecutionContext(variantId: string, modelId: string, messageId: string, shared: SharedContext,
    emitter: import('./src/events.ts').ChatV2EventEmitter, parent: AbortSignal): import('./src/variant-context.ts').VariantExecutionContext;
  createParallelExecutionManager(controller?: AbortController): import('./src/variant-context.ts').ParallelExecutionManager;
  createExecutorRegistry(executors: readonly ToolExecutor[], approval: import('./src/executor-registry.ts').ToolApprovalPolicyPort): import('./src/executor-registry.ts').ToolExecutorRegistry;
  assembleExecutorRegistry(additional: readonly ToolExecutor[], approval: import('./src/executor-registry.ts').ToolApprovalPolicyPort,
    workspace: boolean): import('./src/executor-registry.ts').ToolExecutorRegistry;
  isToolAllowedByExecutionPolicy(toolName: string, args: unknown, allowed: readonly string[] | null): boolean;
  hasReplayMetadata(snapshot: ReplaySkillPayloadSnapshot): boolean;
  tokenUsageFromApi(prompt: number, completion: number, reasoning: number | null): TokenUsage;
  tokenUsageFromApiWithCache(prompt: number, completion: number, reasoning: number | null, cached: number | null): TokenUsage;
  tokenUsageFromEstimate(prompt: number, completion: number, precise: boolean): TokenUsage;
  tokenUsageZero(): TokenUsage;
  tokenUsageHasTokens(usage: TokenUsage): boolean;
  accumulateTokenUsage(usage: TokenUsage, other: TokenUsage): void;
  newVariant(modelId: string, configId?: string | null, id?: string): Variant;
  setVariantStreaming(variant: Variant): void;
  setVariantSuccess(variant: Variant): void;
  setVariantError(variant: Variant, error: string): void;
  setVariantCancelled(variant: Variant): void;
  variantWithUsage(variant: Variant, usage: TokenUsage): Variant;
  setVariantUsage(variant: Variant, usage: TokenUsage): void;
  getVariantUsage(variant: Variant): TokenUsage | null;
  newSharedContext(): SharedContext;
  sharedContextHasSources(context: SharedContext): boolean;
  isMultiVariant(message: ChatMessage): boolean;
  getActiveBlockIds(message: ChatMessage): string[];
  addVariant(message: ChatMessage, variant: Variant): void;
  removeVariant(message: ChatMessage, variantId: string): boolean;
  variantCount(message: ChatMessage): number;
  selectBestActiveVariant(message: ChatMessage): void;
  buildUserMessage(params: import('./src/user-message-builder.ts').UserMessageParams): import('./src/user-message-builder.ts').UserMessageResult;
  newUserMessage(sessionId: string, blockIds: string[]): ChatMessage;
  newAssistantMessage(sessionId: string): ChatMessage;
  newMessageBlock(messageId: string, type: string, blockIndex: number): import('./repository/blocks.ts').StoredBlock;
  setBlockRunning(block: MessageBlock): void;
  setBlockSuccess(block: MessageBlock): void;
  setBlockError(block: MessageBlock, error: string): void;
  appendBlockContent(block: MessageBlock, chunk: string): void;
  getFrozenToolSchemaOrder(sessionId: string): string[];
  mergeFrozenToolSchemaOrder(sessionId: string, baseline: readonly string[]): void;
  getAvailableSkillsSnapshot(sessionId: string): string | null;
  /** `ChatV2Repo::update_session_skill_state_v2` (repo.rs:3688-3714). */
  updateSessionSkillStateV2(sessionId: string, skillState: import('./repository/session-state.ts').SessionSkillState): void;
  freezeAvailableSkillsSnapshot(sessionId: string, snapshot: string): string;
  getToolFacePrefix(sessionId: string): import('./src/session-metadata.ts').ToolFacePrefixSnapshot | null;
  advanceToolFacePrefix(sessionId: string, snapshot: import('./src/session-metadata.ts').ToolFacePrefixSnapshot): void;
  getMicrocompactAnchor(sessionId: string): import('./src/session-metadata.ts').MicrocompactAnchor | null;
  setMicrocompactAnchor(sessionId: string, anchor: import('./src/session-metadata.ts').MicrocompactAnchor): void;
  getSession(sessionId: string): ChatSession | null;
  getSessionAuthorityState(sessionId: string): SessionAuthorityState;
  setSessionPlanState(sessionId: string, plan: PlanAuthorityState | null): ChatSession;
  /** Exact chrono time from platform/time parseRfc3339/parseChronoDateTimeUtc; Date loses sub-ms expiry. */
  consumeSessionPlanBinding(sessionId: string, bindingKey: string, now: ParsedDateTime): boolean;
  createSession(session: ChatSession): void;
  updateSession(session: ChatSession): void;
  deleteSessionV2(sessionId: string): void;
  getMessage(messageId: string): ChatMessage | null;
  getSessionMessages(sessionId: string): ChatMessage[];
  getSessionMessageIdsWithConn(conn: SqlExecutor, sessionId: string): string[];
  getMessagesByIdsWithConn(conn: SqlExecutor, sessionId: string, messageIds: string[]): ChatMessage[];
  getHistoryBlocksWithReplayWithConn(conn: SqlExecutor, messageIds: readonly string[]): [Map<string, import('./repository/blocks.ts').StoredBlock[]>, Map<string, BlockReplayData>];
  createMessage(message: ChatMessage): void;
  createMessageWithConn(conn: SqlExecutor, message: ChatMessage): void;
  getMessageWithConn(conn: SqlExecutor, messageId: string): ChatMessage | null;
  updateMessageWithConn(conn: SqlExecutor, message: ChatMessage): void;
  getCompactionSummaryMessageIdsWithConn(conn: SqlExecutor, sessionId: string): string[];
  markAvailableSkillsSnapshotStaleWithConn(conn: SqlExecutor, sessionId: string): number | bigint | null;
  createBlockWithConn(conn: SqlExecutor, block: import('./repository/blocks.ts').BlockInput): void;
  getMessageBlocksWithConn(conn: SqlExecutor, messageId: string): import('./repository/blocks.ts').StoredBlock[];
  listBlockPositionsWithConn(conn: SqlExecutor, messageId: string, type: string): [number, string][];
  updateMessage(message: ChatMessage): void;
  getBlock(blockId: string): MessageBlock | null;
  getMessageBlocks(messageId: string): MessageBlock[];
  createBlock(block: MessageBlock): void;
  appendBlockIdToMessageWithConn(conn: SqlExecutor, messageId: string, blockId: string): void;
  /**
   * `append_block_id_to_message_block_ids` (pipeline/tool_loop.rs:2718-2768) on the caller's connection.
   * Throws `Error` with the Rust `String` message: `Failed to read message: …`,
   * `Failed to update message block_ids: …` or `Failed to create message: …`.
   */
  appendWorkspaceInjectionBlockIdWithConn(conn: SqlExecutor, sessionId: string, messageId: string, blockId: string): void;
  updateBlock(block: MessageBlock): void;
  updateBlockReplayWithConn(conn: SqlExecutor, blockId: string, replay: BlockReplayData): void;
  getBlockReplayMapWithConn(conn: SqlExecutor, messageId: string): Map<string, BlockReplayData>;
  copyBlockReplayWithConn(conn: SqlExecutor, sourceBlockId: string, targetBlockId: string): void;
  clearBlockLlmContentWithConn(conn: SqlExecutor, blockId: string): void;
  createCompactionWithConn(conn: SqlExecutor, record: CompactionRecord): void;
  getActiveCompactionWithConn(conn: SqlExecutor, sessionId: string): CompactionRecord | null;
  getCompactionByIdWithConn(conn: SqlExecutor, compactionId: string): CompactionRecord | null;
  listCompactionsWithConn(conn: SqlExecutor, sessionId: string): CompactionRecord[];
  setSessionLastCompactionWithConn(conn: SqlExecutor, sessionId: string, compactionId: string): void;
  clearSessionLastCompactionWithConn(conn: SqlExecutor, sessionId: string): void;
  invalidateCompactionForMessageWithConn(conn: SqlExecutor, sessionId: string, messageId: string): boolean;
  loadSessionState(sessionId: string): SessionState | null;
}

export const chatSessionService = { name: 'chatSession', version: '1.0.0' } as const;
export const chatStateService = { name: 'chatState', version: '1.0.0' } as const;
export type { ChatWorkerRuntimeService } from './src/worker-runtime-service.ts';
export const chatWorkerRuntimeService = { name: 'chatWorkerRuntime', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatAttachmentErrors: ChatAttachmentErrors;
    chatRetrievalScope: ChatRetrievalScope;
    chatSession: ChatSessionService;
    chatState: import('./src/state.ts').ChatV2State;
    chatWorkerRuntime: import('./src/worker-runtime-service.ts').ChatWorkerRuntimeService;
  }
}
