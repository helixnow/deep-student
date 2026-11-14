import type {} from '@deepseek-ai/cordis';
import type { WindowRef } from '../../kernel/api.ts';
import type { ContextCompilationPorts } from './src/context-compiler.ts';
export type { ContextCompilationPorts } from './src/context-compiler.ts';
import type { ContextCompilerLlmCalls } from './src/context-compiler-owner.ts';
export type { ContextCompilerLlmCalls } from './src/context-compiler-owner.ts';
import type { CanonicalFileBlobLookup } from './src/canonical-image-payloads.ts';
export type { CanonicalFileBlobLookup } from './src/canonical-image-payloads.ts';
import type { ChatV2State, SharedContext } from '../chat/api.ts';
export { getBlockTypeForToolStatic } from './src/tool-block-type.ts';
export {
  encodeToolNameForApi, decodeToolNameFromApi, buildOpenAiFunctionToolSchema, prepareExternalTool,
  prepareExternalToolSchema, normalizeToolNameForApi, isMcpToolAllowedByPolicy,
  isExternalMcpToolName, isLoadSkillsToolName,
} from './src/canonical-tools.ts';
export { LATEX_RULES } from './src/prompt-builder.ts';
export { textPart, imagePart } from './src/microcompact.ts';
export { ResponseTimeline, ArtifactReferenceDeduplicator, rejectTruncatedToolBatch, type ResponseSegment } from './src/response-timeline.ts';
export {
  ExtractiveTurnCompactor, buildConversationTurnUnits, type ConversationTurnUnit, type ExtractiveCompactionPlan,
} from './src/extractive-compaction.ts';
import type { PipelinePersistenceStore } from './src/persistence-port.ts';
import type { PipelineFinalStore, PipelinePostCommitEffects } from './src/persistence-port.ts';
import type { PipelineFinalPersistence } from './src/final-persistence.ts';
export type { PipelineFinalStore, PipelinePostCommitEffects } from './src/persistence-port.ts';
export type { PipelineFinalPersistence } from './src/final-persistence.ts';
import type { TextExecutionDependencies, TextTurnExecution, UnifiedTextStream } from './src/text-execution.ts';
export type { TextExecutionDependencies, TextExecutionEffects, PreparedTextTurn, UnifiedTextStream, TextTurnExecution } from './src/text-execution.ts';
import type { PipelinePersistence } from './src/incremental-persistence.ts';
export type { PipelinePersistenceStore, PersistenceBlock, UserMessageBuildParams } from './src/persistence-port.ts';
export type { PipelinePersistence } from './src/incremental-persistence.ts';
import type { PipelineHistoryStore } from './src/history-port.ts';
import type { PipelineHistoryLoader } from './src/history-loader.ts';
export type { PipelineHistoryStore, HistoryCompactionRecord } from './src/history-port.ts';
export type { PipelineHistoryLoader } from './src/history-loader.ts';
import type { StreamHooksGuard } from './src/stream-hooks-guard.ts';
import type { LlmStreamHooks } from '../llm/api.ts';
export type { StreamHooksGuard } from './src/stream-hooks-guard.ts';
import type {
  CanonicalContentPart, ChatMessage, ContextRef, MessageBlock, McpToolSchema,
  ReplaySkillPayloadSnapshot, SendMessageRequest, SourceInfo, ToolResultInfo,
} from '../../../contracts/ipc/generated/L04-chat-session.ts';
import type { SendContextRef, SendOptions } from '../../../contracts/ipc/generated/_shared.ts';
import type { ActiveGenerationModel } from '../vfs-index/api.ts';
import type { ChatV2Emitter } from '../chat/api.ts';
import type { CompactionModelConfig, CompactionTriggerState } from './src/compaction-budget.ts';
import type { TailSelection, TurnRange } from './src/segmentation.ts';
import type { CompactionPromptMessage, CompactionPromptProfile } from './src/compaction-prompts.ts';
import type { ArtifactLocator, FinalizationContext, FinalizationReport } from './src/finalizer.ts';
import type { ProfilePromptInput, RendererCapabilities, SystemPromptParts } from './src/prompt-builder.ts';
import type {
  LegacyChatMessage, MicrocompactAnchor, MultimodalContentPart,
} from './src/microcompact.ts';
import type { ToolFacePrefixSnapshot } from './src/tool-face.ts';
import type { ContentBlock, RuntimeFactsOptions } from './src/context.ts';
import type { PipelineContext } from './src/pipeline-context.ts';
export type { PipelineContext } from './src/pipeline-context.ts';
import type {
  GenerationModelConfig, OcrRuntimeCandidate, StrictModelResult,
} from './src/model-selection.ts';
import type {
  CanonicalVfsImage, ImageBudgetCandidate, ReusedArtifactCoverage,
  ResolvedCanonicalImage, RuntimeImage,
} from './src/images.ts';
import type {
  RetrievalPageImageBudget, RetrievalPageImageCandidate,
} from './src/retrieval-images.ts';
import type {
  BudgetDelta, BudgetDimension, BudgetExceeded, BudgetLedger, BudgetLimits,
  BudgetLimitsSnapshot, BudgetRemaining, BudgetUsage, BudgetUsageSnapshot,
  ChildBudgetAttachment, DelegatedBudgetSpec,
} from './src/budget.ts';
import type { SqlExecutor } from '../../platform/storage/api.ts';
import type {
  ApiNameSource, CanonicalExternalToolConfig, PreparedExternalToolSchema,
} from './src/canonical-tools.ts';
import type {
  SessionSkillState, SkillInjectionAnchors, SkillInjectionAudit, TransientSkillMessages,
} from './src/skill-injection.ts';
import type {
  CompactionOutcome, CompactionSkipReason, SummaryCommitResult,
} from './src/compaction-outcome.ts';
import type {
  BlockEventPhase, ChatV2StreamingAdapter, StreamEventSink, StreamedTextSegment,
  StreamingAdapterOptions, StreamingToolCall, WrapTokenFilter,
} from './src/llm-adapter.ts';
import type { ExecutableToolCall } from './src/tool-order.ts';
import type {
  VariantAdapterOptions, VariantMessageBlock, VariantStreamContext,
  VariantStreamingAdapter,
} from './src/variant-adapter.ts';
import type { ModelExecutionSnapshot } from './src/execution-snapshot.ts';
import type { AuthorityMetadataState } from './src/authority-mode.ts';
import type { BackendSendOptions } from './src/persistence.ts';
import type { AuthorityAdmission, ToolAdmission, LocalShellCallClassifier } from './src/hooks.ts';
export type { LocalShellCallClassifier } from './src/hooks.ts';
import type { ShellCommandGuardDecision } from '../agent-workspace/api.ts';
import type { RagSourceInfo } from './src/retrieval.ts';
import type { ToolResultsToMessagesOptions } from './src/history.ts';
import type { SessionMetadata } from './src/summary.ts';
import type { ContextImageCompileStrategy, PreprocessStageResult } from './src/preprocess.ts';
import type { LlmStreamWaitOutcome, StreamIdleTracker } from './src/stream-watchdog.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Requested L04 replay writer: repo.rs::BlockReplayData/update_block_replay_with_conn.
 * The caller owns the connection/transaction. L04 retains missing-column compatibility.
 * No production provider is installed until L04 publishes this repository surface.
 */
export interface BlockReplayData {
  llmContent: string | null;
  toolCallId: string | null;
  roundText: string | null;
}
export interface ReplaySidecarWriter {
  updateBlockReplayWithConn(conn: SqlExecutor, blockId: string, data: BlockReplayData): void;
}

/** context.rs:98-156; internal fields retain their Rust names. */
export interface CitationAssignment { type_index: number; is_new: boolean }
export interface CitationLedger {
  assign(group: string, identity: string): CitationAssignment;
  len(): number;
  isEmpty(): boolean;
}

export interface LocalShellRuntimeContract {
  os: string;
  sandbox_backend: string;
  shell_path: string | null;
  shell_kind: string;
  invocation: string | null;
  output_encoding: string | null;
  execution_supported: boolean;
}

/** finalizer.rs:133; serde does not rename these fields. */
export interface DeclaredArtifact { path: string; sha256: string | null; root_id: string | null }

export type ToolSensitivity = 'low' | 'medium' | 'high';
export type AuthorityMode = 'ask' | 'plan' | 'craft';
export type PermissionPreset = 'cautious' | 'relaxed' | 'full_access' | 'danger_full_access';
/** Minimal L04 state view used by authority_mode.rs. Plan activity remains owned by L04. */
export interface AuthorityState {
  authorityMode: AuthorityMode;
  permissionPreset: PermissionPreset;
  plan: { isActiveForBinding(bindingKey: string, now: Date): boolean } | null;
}
export type AuthorityGateDecision = { kind: 'allow' }
  | { kind: 'blockAsk'; message: string; toolName: string }
  | { kind: 'waitPlanGate'; summary: string };
export interface PlanGateRequest {
  sessionId: string; planId: string; toolCallId: string; toolName: string;
  summary: string; timeoutSeconds: number; arguments: JsonValue;
}
export interface PlanGateResponse {
  sessionId: string; planId: string; toolCallId: string; approved: boolean; reason?: string;
}
export interface PlanGateManager {
  withTimeout(timeoutSeconds: number): this;
  defaultTimeout(): number;
  register(sessionId: string, toolCallId: string, planId: string): Promise<PlanGateResponse>;
  respond(response: PlanGateResponse): boolean;
  cancel(sessionId: string, toolCallId: string): void;
}

/** Wire shape of chat_v2::types::TokenUsage (camelCase, absent optionals omitted). */
export interface PipelineTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: 'api' | 'tiktoken' | 'heuristic' | 'mixed';
  reasoningTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  lastRoundPromptTokens?: number | null;
  lastRoundInputTokens?: number | null;
}

export type { CompactionModelConfig, CompactionTriggerState } from './src/compaction-budget.ts';
export type { TailSelection, TurnRange } from './src/segmentation.ts';
export type { CompactionPromptMessage, CompactionPromptProfile } from './src/compaction-prompts.ts';
export type {
  FinalizationContext, FinalizationReport, FinalizationVerdict, ExceptionKind,
} from './src/finalizer.ts';
export type {
  ProfilePromptInput, RendererCapabilities, SystemPromptParts,
} from './src/prompt-builder.ts';
export type { LegacyChatMessage, MicrocompactAnchor } from './src/microcompact.ts';
export type { ToolFacePrefixSnapshot } from './src/tool-face.ts';
export type { ContentBlock, RuntimeFactsOptions } from './src/context.ts';
export type {
  GenerationModelConfig, OcrRuntimeCandidate, StrictModelResult,
} from './src/model-selection.ts';
export type { MultimodalContentPart } from './src/microcompact.ts';
export type {
  CanonicalVfsImage, ImageBudgetCandidate, ReusedArtifactCoverage,
  ResolvedCanonicalImage, RuntimeImage,
} from './src/images.ts';
export type {
  RetrievalPageImageBudget, RetrievalPageImageCandidate,
} from './src/retrieval-images.ts';
export type {
  BudgetDelta, BudgetDimension, BudgetExceeded, BudgetLedger, BudgetLimits,
  BudgetLimitsSnapshot, BudgetRemaining, BudgetUsage, BudgetUsageSnapshot,
  ChildBudgetAttachment, DelegatedBudgetSpec,
} from './src/budget.ts';
export type {
  ApiNameSource, CanonicalExternalToolConfig, PreparedExternalToolSchema,
} from './src/canonical-tools.ts';
export type {
  SessionSkillState, SkillInjectionAnchors, SkillInjectionAudit, TransientSkillMessages,
} from './src/skill-injection.ts';
export type {
  CompactionOutcome, CompactionSkipReason, SummaryCommitResult,
} from './src/compaction-outcome.ts';
export type {
  BlockEventPhase, StreamingAdapterOptions, StreamingToolCall, StreamEventSink,
  StreamedTextSegment, WrapTokenFilter,
} from './src/llm-adapter.ts';
export type { ExecutableToolCall } from './src/tool-order.ts';
export type {
  VariantAdapterOptions, VariantBlockEvent, VariantMessageBlock, VariantStreamContext,
  VariantStreamingAdapter,
} from './src/variant-adapter.ts';
export type {
  ChatGenerationPlan, GenerationPlan, GenerationRoute, ModelExecutionSnapshot,
} from './src/execution-snapshot.ts';
export type { BackendSendOptions } from './src/persistence.ts';
export type { AuthorityMetadataState } from './src/authority-mode.ts';
export type { AuthorityAdmission, ToolAdmission } from './src/hooks.ts';
export type { RagSourceInfo } from './src/retrieval.ts';
export type { SearchInput } from './src/retrieval.ts';
export type { ToolResultsToMessagesOptions } from './src/history.ts';
export type { SessionMetadata } from './src/summary.ts';
export type {
  ContextImageCompileStrategy, PreprocessStageError, PreprocessStageResult,
} from './src/preprocess.ts';
export type { LlmStreamWaitOutcome, StreamIdleTracker } from './src/stream-watchdog.ts';
/** Internal request extends the decoded wire request with Rust serde(skip) options. */
export type PipelineSendRequest = Omit<SendMessageRequest, 'options'> & { options?: BackendSendOptions | null };

/** P1 command-layer contract, published before runtime composition.
 * Rust pipeline.rs:599/705, pipeline/multi_variant.rs:86/3053, compaction.rs:431.
 * All promises settle after final persistence and terminal emission, not at task spawn.
 * L04 owns stream registration/StreamGuard; L03 owns provider hooks and per-turn cleanup.
 * This type is not a declaration that the currently installed helper service implements it.
 */
export interface ChatPipelineExecution {
  execute(window: WindowRef, request: PipelineSendRequest, cancellation: AbortSignal,
    state: ChatV2State | null): Promise<string>;
  /** Headless entry. Rejects parallelModelIds.length >= 2 before emitting or saving. */
  executeWithEmitter(emitter: ChatV2Emitter, request: PipelineSendRequest, cancellation: AbortSignal,
    state: ChatV2State | null): Promise<string>;
  /** handlers/send_message.rs:1175–1207/1628–1657: same execute, skipUserMessageSave=true.
   * Keeps the supplied user/assistant IDs, refs, replay options and stream generation.
   * L04 performs retry/edit deletion and restoration before calling this entry.
   */
  executeWithExistingUser(window: WindowRef, request: PipelineSendRequest, cancellation: AbortSignal,
    state: ChatV2State | null): Promise<string>;
  executeMultiVariant(window: WindowRef, request: PipelineSendRequest, modelIds: string[],
    cancellation: AbortSignal, state: ChatV2State | null): Promise<string>;
  /** multi_variant.rs:2831 execute_variants_retry_batch: one emitter, shared context, parallel variants.
   * Rejects an empty `variants` with ChatV2Error::Validation('No variant IDs provided for batch retry').
   */
  executeVariantsRetryBatch(window: WindowRef, sessionId: string, messageId: string, variants: VariantRetrySpec[],
    userContent: string, userAttachments: import('./src/pipeline-context.ts').AttachmentInput[],
    sharedContext: SharedContext, options: BackendSendOptions, cancellation: AbortSignal,
    state: ChatV2State | null): Promise<void>;
  executeVariantRetry(window: WindowRef, sessionId: string, messageId: string, variantId: string,
    modelId: string, userContent: string, userAttachments: import('./src/pipeline-context.ts').AttachmentInput[],
    sharedContext: SharedContext, options: BackendSendOptions, cancellation: AbortSignal): Promise<void>;
  /** compaction.rs:431. Hard DB/transaction errors reject; soft skip/failure is an outcome.
   * null model has no Model2 fallback. null memoryEnabled is manual/global policy, not false.
   * The signal is optional in Rust; null preserves callers without a cancellation token.
   */
  runCompactionForSession(sessionId: string, modelId: string | null, reason: string,
    excludeIds: string[], contextLimit: number | null, memoryEnabled: boolean | null,
    cancellation: AbortSignal | null): Promise<CompactionOutcome>;
}
export type SendPipelinePort = Pick<ChatPipelineExecution, 'execute'>;
/** pipeline/constants.rs:109 VariantRetrySpec (backend-internal; camelCase TS fields). */
export interface VariantRetrySpec {
  variantId: string;
  modelId: string;
  configId: string;
  isMultimodal: boolean;
  meta: import('../../../contracts/ipc/generated/L04-chat-session.ts').VariantMeta | null;
}
/** Target composed service for command consumers; runtime publication follows the P1 batches. */
export type ExecutableChatPipelineService = ChatPipelineService & ChatPipelineExecution;

/** Incrementally published service surface; execution methods are added with their implementation.
 * P1 batch 1: single-variant execute / executeWithEmitter / executeWithExistingUser (pipeline.rs:599/705).
 * P1 batch 4: runCompactionForSession (compaction.rs:431).
 * P1 batch 3: executeMultiVariant / executeVariantRetry / executeVariantsRetryBatch (multi_variant.rs:86/3053/2831);
 * they reject with ChatV2Error::Other before any effect until L04 publishes createParallelExecutionManager.
 */
export interface ChatPipelineService extends ChatPipelineExecution {
  /** Bind published owner operations to the central gate; no alternate registry or policy implementation. */
  bindToolRuntime(authority: import('./src/tool-runtime.ts').ToolRuntimeAuthorityOwner,
    todo: import('./src/tool-runtime.ts').ToolRuntimeTodoOwner): import('./src/tool-round.ts').ChatToolRuntime;
  /** P1 compiler; owner ports are explicit until their complete high-level APIs are integrated. */
  compileFrozenContext(execution: PipelineContext, ports: ContextCompilationPorts): Promise<void>;
  /** Requires an actual L02 high-level owner instance; never resolves a candidate type as a service. */
  bindContextCompilationPorts(owner: ContextCompilerLlmCalls, fileBlob: CanonicalFileBlobLookup): ContextCompilationPorts;
  resolveCanonicalImagePayloads(parts: readonly CanonicalContentPart[],
    fileBlob: CanonicalFileBlobLookup): Promise<(ResolvedCanonicalImage | null)[]>;
  /** P1 pre-emission stage: canonical descriptors come from the request compiler's owner reads. */
  freezeExecutionContext(execution: PipelineContext,
    buildCanonical: () => CanonicalContentPart[]): Promise<import('../llm/api.ts').ApiConfig>;
  createPipelineContext(request: PipelineSendRequest): PipelineContext;
  immutableCommandGuardForToolCall(call: import('../chat/api.ts').ToolCall,
    classify?: LocalShellCallClassifier): ShellCommandGuardDecision | null;
  createPersistence(store: PipelinePersistenceStore): PipelinePersistence;
  createFinalPersistence(store: PipelineFinalStore, effects: PipelinePostCommitEffects): PipelineFinalPersistence;
  createPreparedTextExecution(dependencies: TextExecutionDependencies): TextTurnExecution;
  createUnifiedTextStream(sink: import('../llm/api.ts').StreamEventSink,
    window?: import('../../kernel/api.ts').WindowRef | null): UnifiedTextStream;
  createStreamHooksGuard(streamEvent: string, owner: LlmStreamHooks): StreamHooksGuard;
  createHistoryLoader(store: PipelineHistoryStore): PipelineHistoryLoader;
  validateToolChain(messages: readonly LegacyChatMessage[]): boolean;
  getBlockTypeForToolStatic(toolName: string): string;
  createSessionEventEmitter(sessionId: string,
    options?: { streamGeneration?: number; batching?: boolean }): ChatV2Emitter;
  bindStreamingSink(emitter: ChatV2Emitter): StreamEventSink;
  createVariantStreamContext(emitter: ChatV2Emitter, variantId: string, modelId: string,
    messageId: string, options?: { now?: () => number }): VariantStreamContext;
  /** history.rs::resolve_history_context_snapshot_v2, using the injected L05 resolver. */
  resolveHistoryContextSnapshot(originalContent: string, message: ChatMessage,
    vfsConnection: SqlExecutor): Promise<[string, string[]]>;
  persistUserLlmContentEarly(execution: PipelineContext, writer: ReplaySidecarWriter): void;
  persistReplaySidecar(conn: SqlExecutor, execution: PipelineContext, userBlockId: string | null,
    dirtyBlocks: ReadonlySet<string> | null, writer: ReplaySidecarWriter): void;
  tryFinalizeTaskCompletion(ctx: PipelineContext, locator?: ArtifactLocator | null): FinalizationReport | null;
  finalizeTaskCompletion(ctx: PipelineContext, locator?: ArtifactLocator | null): void;
  citationLedgerForReply(sessionId: string, messageId: string, variantId?: string | null): CitationLedger;
  localShellContractForPlatform(platform: string): LocalShellRuntimeContract;
  sanitizeRetrievalOutputForLlm(toolName: string, output: JsonValue): JsonValue | null;
  planGateManager: PlanGateManager;
  requiresToolApproval(state: AuthorityState, baseSensitivity: ToolSensitivity | null,
    effectiveSensitivity: ToolSensitivity | null, immutableCommandGuardAsks: boolean,
    externalMcp: boolean, privilegeEscalation: boolean): boolean;
  evaluateAuthorityGate(state: AuthorityState, toolName: string, sensitivity: ToolSensitivity | null,
    bindingKey: string | null, now: Date): AuthorityGateDecision;
  planCallBindingKey(toolName: string, args: JsonValue, roundId: string | null): string;
  /** Window-level freeze + digest. `null` means the window has not emitted any tool yet. */
  freezeToolFace(tools: JsonValue[], frozenNames: string[], frozenSchemas: Map<string, JsonValue>): string | null;
  mergeFrozenToolSchemaOrderBaseline(entry: string[], baseline: readonly string[]): void;
  parseApiUsage(usage: unknown): PipelineTokenUsage | null;
  usableTokens(config: CompactionModelConfig | null): number;
  effectiveUsableTokens(config: CompactionModelConfig | null, contextLimit: number | null): number;
  shouldCompact(state: CompactionTriggerState, config: CompactionModelConfig | null): boolean;
  shouldCompactAfterTool(state: CompactionTriggerState, config: CompactionModelConfig | null,
    predictedToolOutputTokens: number): boolean;
  estimateMessageTokens(message: ChatMessage, blocksByMessage: ReadonlyMap<string, readonly MessageBlock[]>,
    modelId?: string | null): number;
  splitIntoTurns(messages: readonly ChatMessage[]): TurnRange[];
  selectTail(messages: readonly ChatMessage[], turns: readonly TurnRange[], budgetTokens: number,
    blocksByMessage: ReadonlyMap<string, readonly MessageBlock[]>, modelId?: string | null): TailSelection | null;
  compactionProfileForMode(mode: string | null): CompactionPromptProfile;
  summaryIsStructurallyValid(summary: string, profile: CompactionPromptProfile): boolean;
  buildStaticFallbackSummary(profile: CompactionPromptProfile, chunkText: string,
    hardCapTokens: number, modelId?: string | null): string;
  extractOpaqueIdentifiers(text: string, cap: number): string[];
  missingIdentifiers(summary: string, identifiers: readonly string[]): string[];
  renderMessagesForPrompt(messages: readonly ChatMessage[],
    blocksByMessage: ReadonlyMap<string, readonly MessageBlock[]>, start: number, end: number,
    perMsgTokenCap: number, modelId?: string | null): string;
  makeSummarySystemMessage(summaryText: string, compactionId: string): CompactionPromptMessage;
  truncateTextToTokenBudget(text: string, tokenBudget: number, modelId?: string | null): string;
  splitTextToTokenBudget(text: string, tokenBudget: number, modelId?: string | null): string[];
  buildMemoryFlushSegmentId(sessionId: string, previousCompactionId: string | null,
    startMessageId: string, endMessageIdExclusive: string, ordinal: number): string;
  splitMemoryFlushSegment(text: string): string[];
  finalizeTask(context: FinalizationContext): FinalizationReport;
  parseDeclaredArtifacts(input: unknown): DeclaredArtifact[];
  parseRendererCapabilities(raw: string | null): RendererCapabilities;
  buildSystemPrompt(input: ProfilePromptInput): SystemPromptParts;
  microcompactBatchEligibleTurns(history: readonly LegacyChatMessage[]): number;
  advanceMicrocompactAnchor(previous: MicrocompactAnchor | null,
    activeCompactionId: string | null, batchEligibleUserTurns: number): [MicrocompactAnchor, number];
  microcompactOldToolOutputs(history: LegacyChatMessage[], eligibleUserTurns: number): number;
  convergeToolFaceOrdersByVariantIndex(baselines: readonly (readonly string[])[]):
    { generationBump: number; order: string[] };
  toolFacePrefixFromMetadata(metadata: unknown): ToolFacePrefixSnapshot | null;
  advanceToolFacePrefixIntoMetadata(metadata: unknown, snapshot: ToolFacePrefixSnapshot):
    { metadata: unknown; wrote: boolean };
  wrapUserMessageText(userContent: string, injectedContext?: string | null): string;
  buildRuntimeFactsBlock(userContent: string, options?: RuntimeFactsOptions): string;
  buildInjectedContextBlocks(runtimeFacts: string, refs: readonly SendContextRef[],
    turnVolatile?: string | null): ContentBlock[];
  collectInjectedContextTextAndImages(blocks: readonly ContentBlock[]):
    { text: string; images: string[] };
  combineUserContent(userContent: string, runtimeFacts: string, refs: readonly SendContextRef[],
    turnVolatile?: string | null): { text: string; images: string[] };
  generationModelKind(config: GenerationModelConfig, dedicatedOcrIds: ReadonlySet<string>):
    ActiveGenerationModel | null;
  auxiliaryMmEligible(config: GenerationModelConfig, activeConfigId: string,
    dedicatedOcrIds: ReadonlySet<string>): boolean;
  isDedicatedOcrCandidate(candidate: OcrRuntimeCandidate): boolean;
  requestedGenerationModel(requestedModelId: string | null | undefined,
    selected: GenerationModelConfig | null | undefined,
    configs: readonly GenerationModelConfig[]): ActiveGenerationModel | null;
  selectGenerationConfig(configs: readonly GenerationModelConfig[],
    initiallySelected: GenerationModelConfig | null | undefined, planned: ActiveGenerationModel,
    dedicatedOcrIds: ReadonlySet<string>): GenerationModelConfig | null;
  resolveStrictRequestedModel(strict: boolean, requestedModelId: string | null | undefined,
    configs: readonly GenerationModelConfig[],
    dedicatedOcrIds: ReadonlySet<string>): StrictModelResult;
  applySendOverrides(config: GenerationModelConfig, options: SendOptions): void;
  requestedActiveModelId(options: SendOptions): string | null;
  canonicalContentForFreeze(existing: readonly CanonicalContentPart[],
    build: () => CanonicalContentPart[]): CanonicalContentPart[];
  selectImagesWithBudget(candidates: readonly ImageBudgetCandidate[], totalBudget: number,
    historyBudget: number): Set<string>;
  collectRuntimeImages(messages: readonly LegacyChatMessage[], currentIndex: number,
    currentCanonical: readonly CanonicalContentPart[]): RuntimeImage[];
  applyExistingDerivedArtifacts(messages: LegacyChatMessage[],
    images: readonly RuntimeImage[]): ReusedArtifactCoverage;
  overrideMessageImagesWithCanonical(message: LegacyChatMessage,
    canonical: readonly (ResolvedCanonicalImage | null)[]): number;
  retainSelectedImagesForMultimodal(messages: LegacyChatMessage[],
    selected: ReadonlySet<string>): void;
  stripAllImages(messages: LegacyChatMessage[], selected: ReadonlySet<string>,
    addBudgetPlaceholder: boolean): void;
  appendObservation(message: LegacyChatMessage, observation: string): void;
  sniffImageMime(bytes: Uint8Array): string | null;
  canonicalContentFromMessageMetadata(message: LegacyChatMessage):
    CanonicalContentPart[] | null;
  appendPreviewImages(images: CanonicalVfsImage[], seen: Set<string>,
    containerResourceId: string, sourceId: string, sourceName: string,
    fallbackContentHash: string, previewJson: string | null | undefined): void;
  collectRetrievalPageImageCandidates(results: readonly ToolResultInfo[]):
    RetrievalPageImageCandidate[];
  countRequestImages(messages: readonly LegacyChatMessage[]): number;
  canonicalImageBlobHashes(canonical: readonly CanonicalContentPart[]): Set<string>;
  createRetrievalPageImageBudget(imageBudget: number, imagesInRequest: number,
    alreadyReferencedBlobs: ReadonlySet<string>): RetrievalPageImageBudget;
  resolveRetrievalPageImages(candidates: readonly RetrievalPageImageCandidate[]):
    (ResolvedCanonicalImage | null)[];
  buildRetrievalPageImageInjection(results: readonly ToolResultInfo[],
    budget: RetrievalPageImageBudget): LegacyChatMessage | null;
  buildRetrievalPageImageMessage(
    images: readonly (readonly [RetrievalPageImageCandidate, ResolvedCanonicalImage])[]):
    LegacyChatMessage | null;
  insertRetrievalPageImageMessage(messages: LegacyChatMessage[], roundLastToolCallId: string,
    message: LegacyChatMessage): boolean;
  resolveBudgetLimits(read: (key: string) => string | null | undefined): BudgetLimits;
  effectiveBudgetLimits(): BudgetLimits;
  configureBudgetSettingsReader(read: ((key: string) => string | null | undefined)
    | null): void;
  attachChildToTree(parentSessionId: string, childSessionId: string,
    declared?: DelegatedBudgetSpec | null, limits?: BudgetLimits): ChildBudgetAttachment;
  treeKeyForSession(sessionId: string): string | null;
  budgetLedgerForTree(key: string): BudgetLedger | null;
  tryConsumeTreeBudget(key: string, delta: BudgetDelta, limits?: BudgetLimits):
    { ok: true; remaining: BudgetRemaining } | { ok: false; exceeded: BudgetExceeded };
  recordTreeUsage(key: string, delta: BudgetDelta, limits?: BudgetLimits): BudgetRemaining;
  reserveChildSpec(declared: DelegatedBudgetSpec | null | undefined,
    remaining: BudgetRemaining): Required<DelegatedBudgetSpec>;
  persistBudgetSnapshot(db: SqlExecutor, ledger: BudgetLedger): void;
  restoreBudgetLedgersFromDb(db: SqlExecutor): void;
  readBudgetSetting(db: SqlExecutor, key: string): string | null;
  readBudgetSettingFromFile(path: string, key: string): string | null;
  normalizeToolNameForApi(name: string): string | null;
  encodeToolNameForApi(name: string): string | null;
  decodeToolNameFromApi(name: string): string | null;
  prepareExternalToolSchema(tool: McpToolSchema, includeServerSuffix: boolean):
    PreparedExternalToolSchema | null;
  isMcpToolAllowedByPolicy(tool: McpToolSchema, whitelist: readonly string[],
    blacklist: readonly string[]): boolean;
  isExternalMcpToolName(toolName: string): boolean;
  isLoadSkillsToolName(toolName: string): boolean;
  orderedSkillIdsForInjection(skillState: SessionSkillState,
    dependencies?: ReadonlyMap<string, readonly string[]> | null,
    alreadyInjected?: ReadonlySet<string>): Array<[string, number]>;
  buildTransientSkillMessagesWithAudit(skillState: SessionSkillState,
    skillContents: ReadonlyMap<string, string>,
    skillDependencies?: ReadonlyMap<string, readonly string[]> | null,
    tokenBudget?: number | null,
    alreadyInjected?: ReadonlySet<string>): TransientSkillMessages;
  insertTransientSkillMessages(messages: LegacyChatMessage[], insertionIndex: number,
    transientSkillMessages: readonly LegacyChatMessage[]): void;
  buildInLoopSkillMessages(loadedSkillIds: readonly string[],
    skillContents: ReadonlyMap<string, string>,
    skillDependencies: ReadonlyMap<string, readonly string[]> | null | undefined,
    tokenBudget: number | null | undefined, alreadyInjected: ReadonlySet<string>,
    skillStateVersion: number): TransientSkillMessages;
  insertSkillMessagesAfterToolResult(messages: LegacyChatMessage[], toolCallId: string,
    roundLastToolCallId: string | null | undefined,
    skillMessages: readonly LegacyChatMessage[]): void;
  anchoredSkillIdsInHistory(history: readonly LegacyChatMessage[]): Set<string>;
  rebuildAnchoredSkillMessages(skillIds: readonly string[],
    skillContents: ReadonlyMap<string, string> | null | undefined): LegacyChatMessage[];
  rebuildAnchoredSkillMessagesGated(skillIds: readonly string[],
    skillContents: ReadonlyMap<string, string> | null | undefined,
    anchors: SkillInjectionAnchors | null | undefined,
    mismatchedSkillIds?: string[]): LegacyChatMessage[];
  skillBodyDigest(skillId: string, body: string): string;
  serializeSkillInjectionAnchors(anchors: SkillInjectionAnchors): string;
  parseSkillInjectionAnchors(raw: string): SkillInjectionAnchors | null;
  transientSkillMessageSkillId(message: LegacyChatMessage): string | null;
  compactionStatus(outcome: CompactionOutcome): 'compacted' | 'notNeeded' | 'skipped' | 'failed';
  compactionReasonCode(outcome: CompactionOutcome): CompactionSkipReason | null;
  compactionDidCompact(outcome: CompactionOutcome): boolean;
  compactionTokenEstimates(outcome: CompactionOutcome): [number | null, number | null];
  compactionIsFailed(outcome: CompactionOutcome): boolean;
  cooldownSecondsForOutcome(outcome: CompactionOutcome): number | null;
  validatedCompactionModelId(modelId: string | null | undefined): string | null;
  runSummaryCommitPost<T, E>(summarize: () => Promise<SummaryCommitResult<T, E>>,
    persist: (prepared: T) => SummaryCommitResult<boolean, E>,
    postCommit: (prepared: T) => Promise<void>): Promise<SummaryCommitResult<T, E>>;
  createStreamingAdapter(sink: StreamEventSink, messageId: string,
    options: StreamingAdapterOptions): ChatV2StreamingAdapter;
  identityWrapTokenFilter(): WrapTokenFilter;
  orderToolCallsForExecution<T extends ExecutableToolCall>(toolCalls: readonly T[]): T[];
  parsePermissionPreset(raw: string): PermissionPreset | null;
  permissionPresetWireName(preset: PermissionPreset): string;
  craftDefaultAuthorityState(): AuthorityMetadataState;
  authorityStateFromMetadata(metadata: unknown): AuthorityMetadataState;
  authorityStateToMetadata(state: AuthorityMetadataState,
    metadata?: unknown): Record<string, unknown>;
  createVariantStreamingAdapter(ctx: VariantStreamContext,
    options: VariantAdapterOptions): VariantStreamingAdapter;
  authoritativeContentResult(content: string): { content: string };
  parseModelExecutionSnapshot(value: unknown): ModelExecutionSnapshot | null;
  serializeModelExecutionSnapshot(snapshot: ModelExecutionSnapshot): Record<string, unknown>;
  executionSnapshotFromMessageMetadata(metadata: unknown): ModelExecutionSnapshot | null;
  buildReplaySkillPayloadSnapshot(options: BackendSendOptions): ReplaySkillPayloadSnapshot | null;
  replaySnapshotHasMetadata(snapshot: ReplaySkillPayloadSnapshot): boolean;
  extractCitedMemoryNoteIds(finalContent: string,
    toolResults: ReadonlyArray<Pick<ToolResultInfo, 'success' | 'output'>>): string[];
  approvalManagerRequired(sensitivity: ToolSensitivity | null): boolean;
  defaultPipelineHookNames(): string[];
  createToolAdmission(argumentsValue: JsonValue): ToolAdmission;
  shellGuardAdmitted(asks: boolean, required: boolean, satisfied: boolean): boolean;
  sourceUserCanonicalBeforeAssistant(messages: readonly ChatMessage[],
    assistantMessageId: string): CanonicalContentPart[] | null;
  effectiveMaxToolRounds(maxToolRecursion: number | null | undefined): number | null;
  isConfigIdFormat(id: string): boolean;
  truncateText(text: string, maxLen: number): string;
  sourceInfoFromRagSource(rag: RagSourceInfo): SourceInfo;
  filterRetrievalResults(sources: readonly SourceInfo[], minScore?: number,
    relativeThreshold?: number, maxResults?: number): SourceInfo[];
  executeRetrievals(sessionId: string): void;
  normalizeToolNameForSkillMatch(toolName: string): string;
  skillAllowsTool(toolName: string, allowed: string): boolean;
  skillAllowsToolOnServer(toolName: string, serverId: string | null | undefined,
    allowed: string): boolean;
  generateBlockId(): string;
  readonly defaultToolTimeoutMs: number;
  readonly defaultRagTopK: number;
  readonly defaultGraphTopK: number;
  readonly defaultMultimodalTopK: number;
  readonly defaultContextLimit: number;
  buildUserContentFromContextRefs(refs: readonly SendContextRef[]): ContentBlock[];
  convertToContextRefs(refs: readonly SendContextRef[]): ContextRef[];
  combinedUserContent(userContent: string, refs: readonly SendContextRef[],
    options?: RuntimeFactsOptions & { turnVolatile?: string | null }):
    { text: string; images: string[] };
  contentBlocksOrdered(userContent: string, refs: readonly SendContextRef[],
    options?: RuntimeFactsOptions & { turnVolatile?: string | null }): ContentBlock[];
  contentTextFromBlocks(blocks: readonly MessageBlock[]): string;
  toolResultsToMessages(toolResults: readonly ToolResultInfo[],
    options?: ToolResultsToMessagesOptions): LegacyChatMessage[];
  createToolCall(id: string, name: string, args: JsonValue): ExecutableToolCall;
  planParallelSegments(flags: readonly boolean[]):
    [boolean, { start: number; end: number }][];
  isTransientToolError(error: string): boolean;
  isRetryableLlmError(error: string): boolean;
  annotateAutoRetry(info: ToolResultInfo, retries: number): ToolResultInfo;
  pinToolResultToBlock(info: ToolResultInfo, logicalBlockId: string): ToolResultInfo;
  buildRunScopedStreamEvent(sessionId: string, scopeId: string, runId: string,
    generation: number | bigint | null): string;
  runBoundedOrdered<T>(operations: readonly (() => Promise<T>)[], limit: number): Promise<T[]>;
  mergeRoundResultsInCallOrder(calls: readonly { id: string }[], executed: ToolResultInfo[],
    synthetic: ToolResultInfo[]): ToolResultInfo[];
  readonly parallelToolConcurrency: number;
  readonly toolTransientRetryBackoffMs: readonly number[];
  parseSessionMetadataResponse(response: string): SessionMetadata | null;
  fallbackSessionMetadata(userContent: string): SessionMetadata;
  computeContentHash(userContent: string, assistantContent: string): string;
  buildSessionMetadataPrompt(userContent: string, assistantContent: string): string;
  shouldGenerateSessionMetadata(userContent: string, assistantContent: string,
    session: { titleLocked: boolean; summaryHash: string | null } | null,
    sessionId?: string): boolean;
  readonly sessionMetadataPrompt: string;
  contextImageCompileStrategy(modelIsMultimodal: boolean,
    hasImages: boolean): ContextImageCompileStrategy;
  finalizeVisualObservation(observation: string | null): [string, boolean];
  runPreprocessStage<T>(parent: AbortSignal | null, turnDeadline: number, stageTimeout: number,
    operation: (signal: AbortSignal) => Promise<T>): Promise<PreprocessStageResult<T>>;
  readonly unavailableImageObservation: string;
  readonly visualPreprocessTurnBudgetMs: number;
  createStreamIdleTracker(): StreamIdleTracker;
  waitLlmStreamWithIdleTimeout<T>(future: Promise<T>, idleLimitMs: number, totalLimitMs: number,
    cancelOnIdle: boolean, idleElapsed: () => number,
    now?: () => number): Promise<LlmStreamWaitOutcome<T>>;
  readonly streamWatchdogTickMs: number;
  readonly streamWatchdogStallGapMs: number;
}

/** Tool runtime composed by L03 from L04 registry/context, L05 approval-scope/approval manager,
 * and L06 trusted automation. L03 keeps every gate branch,
 * ordering, retry and persistence step (tool_loop.rs:1823–3585, hooks.rs).
 */
export type { ChatToolRuntime, ToolContextInit, DispatchToolCall, ToolConcurrency } from './src/tool-round.ts';
export type { ToolRuntimeAuthorityOwner, ToolRuntimeTodoOwner } from './src/tool-runtime.ts';
export type {
  ApprovalGatePorts, ToolApprovalManagerPort, PendingPlan, ApprovalWait, GateToolCall,
} from './src/approval-gate.ts';
export const chatToolRuntimeService = { name: 'chatToolRuntime', version: '1.0.0' } as const;

/** @stable chat.pipeline service descriptor (ARCHITECTURE.md appendix A). */
export const chatPipelineService = { name: 'chatPipeline', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    chatPipeline: ChatPipelineService;
    chatToolRuntime: import('./src/tool-round.ts').ChatToolRuntime;
    /** Super inbox send entry (send_message.rs `run_send_message_pipeline_owned`). */
    'chat.send@1': import('../agent-orchestration/api.ts').SendMessagePipeline;
  }
}
