/** Ports the variant pipeline (multi_variant.rs) drives: the L04 variant state owner
 * (VariantExecutionContext / ParallelExecutionManager) and the owner services it reads.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ChatV2Emitter, SharedContext, TokenUsage, Variant, VariantMeta, ToolResultInfo } from '../../chat/api.ts';
import type {
  LLMManager, LlmModel2Streaming, LlmOcrModels, LlmStreamEvents, StreamEventSink as LlmStreamEventSink,
} from '../../llm/api.ts';
import type { WindowRef } from '../../../kernel/api.ts';
import type { PipelineContext } from './pipeline-context.ts';
import type { LegacyChatMessage } from './microcompact.ts';
import type { PersistenceBlock } from './persistence-port.ts';
import type { ExecutionOwnerStore, SessionToolFaceBaselines } from './execution-runtime.ts';
import type { PipelineHistoryLoader } from './history-loader.ts';
import type { ContextCompilationPorts } from './context-compiler.ts';
import type { RendererCapabilities } from './prompt-builder.ts';
import type { SessionSkillState } from './skill-injection.ts';
import type { RetrievalPageImageBudget } from './retrieval-images.ts';
import type { ToolRounds } from './tool-round.ts';

type Log = Pick<Context['logger'], 'info' | 'warn' | 'error' | 'debug'>;

/** L04 VariantExecutionContext surface (variant_context.rs) consumed by the variant pipeline. */
export interface VariantExecution {
  variantId(): string; modelId(): string; messageId(): string; cancelToken(): AbortSignal; isCancelled(): boolean;
  /** The variant's own cancellation token owner (Rust registers ctx.cancel_token() itself). */
  cancelController(): AbortController;
  emitter(): ChatV2Emitter; setConfigId(id: string): void; getConfigId(): string | null;
  setMeta(meta: VariantMeta): void; getMeta(): VariantMeta | null; status(): string; error(): string | null;
  blockIds(): string[]; setContentBlockId(id: string): void; setThinkingBlockId(id: string): void;
  getContentBlockId(): string | null; getThinkingBlockId(): string | null; appendContent(text: string): void;
  appendReasoning(text: string): void; getAccumulatedContent(): string; getAccumulatedReasoning(): string | null;
  setUsage(usage: TokenUsage): void; getUsage(): TokenUsage; addToolCall(call: { id: string; name: string; arguments: unknown }): void;
  takeToolCalls(): { id: string; name: string; arguments: unknown }[]; addToolResult(result: ToolResultInfo): void;
  getToolResults(): ToolResultInfo[]; incrementToolRound(): number; addInterleavedBlock(block: PersistenceBlock): number;
  appendInterleavedBlockContent(blockId: string, text: string): boolean; getInterleavedBlocks(): PersistenceBlock[];
  setPendingReasoning(text: string | null): void; resetForNewRound(): void;
  emitStart(type: string, blockId: string, payload: unknown | null): void;
  emitChunk(type: string, blockId: string, chunk: string): void;
  emitEnd(type: string, blockId: string, result: unknown | null): void;
  startStreaming(): void; complete(): void; fail(error: string): void; cancel(): void; toVariant(): Variant;
}
export interface VariantExecutionManager {
  createVariant(id: string, model: string, message: string, shared: SharedContext, emitter: ChatV2Emitter): VariantExecution;
  getFirstSuccess(): string | null; successCount(): number; errorCount(): number;
}
export const VARIANT_OWNER_METHODS = ['createParallelExecutionManager'] as const;

export interface VariantDependencies {
  llm: LLMManager; ocr: LlmOcrModels; streamEvents: LlmStreamEvents; model2: LlmModel2Streaming; log: Log;
  readSetting(key: string): string | null;
  owner: ExecutionOwnerStore;
  /** L04 `createParallelExecutionManager(controller)`. */
  createManager(controller: AbortController): VariantExecutionManager;
  history: PipelineHistoryLoader;
  compilePorts: ContextCompilationPorts;
  toolFace: SessionToolFaceBaselines;
  toolRounds: ToolRounds | null;
  connection(): import('../../../platform/storage/api.ts').DatabaseHandle;
  windowEmitter(window: WindowRef, sessionId: string, streamGeneration: number | null): ChatV2Emitter;
  streamSinkFor(emitter: ChatV2Emitter): LlmStreamEventSink;
  rendererCapabilities(): RendererCapabilities;
  loadEffectiveSkillState(sessionId: string, options: PipelineContext['options']): SessionSkillState;
  compactForRequest(sessionId: string, options: PipelineContext['options'], excludeIds: readonly string[],
    emitter: ChatV2Emitter, signal: AbortSignal | null, error: unknown): Promise<boolean>;
  buildRetrievalPageImageInjection(results: readonly ToolResultInfo[], budget: RetrievalPageImageBudget): LegacyChatMessage | null;
  /** Optional owner effects: Rust Option providers / non-fatal side effects. */
  incrementResourceRefsWithinSave(ids: readonly string[]): void;
  triggerAutoMemoryExtraction(memoryEnabled: boolean | null | undefined, userContent: string, assistant: string,
    results: readonly ToolResultInfo[]): void;
  /** ChatV2Repo::update_session_skill_state_v2 (L04); Rust discards the result. */
  updateSessionSkillState(sessionId: string, state: RestoredSkillState): void;
  missing(capability: string, consequence: string): void;
}

/** types.rs SessionSkillState restored from a variant snapshot, `.without_branch_local_skills()` applied. */
export interface RestoredSkillState {
  manualPinnedSkillIds: string[]; modeRequiredBundleIds: string[]; agenticSessionSkillIds: string[];
  branchLocalSkillIds: string[]; effectiveAllowedExternalServers: string[]; version: number; legacyMigrated: boolean;
}
