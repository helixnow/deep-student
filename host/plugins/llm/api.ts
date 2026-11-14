/** L02 llm@1. Wire types retain Rust serde names; service methods use camelCase. */
import type { Context } from '@deepseek-ai/cordis';
import type { OcrEngineType, OcrTaskType } from '../llm-providers/api.ts';
import type {
  ApiConfig, ApiConfig__De, FailoverPolicy, ModelAssignments, ModelAssignments__De,
  ModelProfile, ModelProfile__De, VendorConfig, VendorConfig__De,
} from '../../../contracts/ipc/generated/L02-llm-manager.ts';

export type {
  ApiConfig, ApiConfig__De, FailoverPolicy, FailoverPolicy__De,
  ModelAssignments, ModelAssignments__De, ModelProfile, ModelProfile__De,
  VendorConfig, VendorConfig__De, OpenCodeGoUsage,
} from '../../../contracts/ipc/generated/L02-llm-manager.ts';
export type { Context };
export type { EssayGradingService } from './src/essay_grading/api.ts';
export const essayGradingService = { name: 'essayGrading', version: '1.0.0' } as const;
export type { GradingMode, ScoreDimension } from './src/essay_grading/types.ts';
export { canonicalModeId } from './src/essay_grading/types.ts';
export { EssayGradingError, resolveGradingMode } from './src/essay_grading/pipeline.ts';
export { f32Json, gradingScoreToWire } from './src/essay_grading/f32.ts';
export {
  LLM_ERROR_CODE_KEY, LLM_ERROR_CODE_EMPTY_RESPONSE, LLM_ERROR_CODE_CONTEXT_WINDOW_EXCEEDED,
  LLM_ERROR_CODE_COMPACTION_REQUIRED, llmErrorCode, providerBodyIndicatesContextWindow,
} from './src/routing.ts';
export {
  effectiveApiProtocolForConfig, requestAdapterIdForConfig,
  type ProtocolConfigLike,
} from './src/protocol.ts';
export { AUTH_MODE_OPENAI_CODEX_OAUTH, AUTH_MODE_NONE } from './src/protocol.ts';
export {
  computeReasoningStateScope, canReplayReasoningState, sanitizeHistoryReasoningForTarget,
  pickCanonicalReasoningText, deduplicateReasoningChunks,
} from './src/reasoning_state_scope.ts';
export { scopedPromptCacheKey, resolveToolChoicePreservingCache, normalizeProviderUsageWithCache } from './src/prompt_cache.ts';
export { mapSiliconFlowReasoningOverride, resolveAlwaysThinkingFallback } from './src/reasoning_level_map.ts';
/** Stable pure request-policy functions shared with L01. */
export { applyReasoningConfig } from './src/question_authoring.ts';
export { preparePlainProviderRequest } from './src/prepared_request.ts';
export { prepareProviderRequest } from './src/prepared_request.ts';
export { providerAdapterForConfig } from './src/provider_adapter.ts';
export { applyGenerationParams } from './src/generation.ts';
export { applyOfficialDeepseekGenerationParams } from './src/adapters/deepseek.ts';
export { deepseekDocumentPurpose, isOfficialDeepseekFlashResponses, uploadDeepseekDocument } from './src/deepseek_files.ts';
export { resolveQuirks, type ProviderQuirks } from './src/provider_quirks.ts';
export { defaultSingleShotOptions, runSingleShot, bodyForMode } from './src/single_shot_stream.ts';
export type { SingleShotOptions, SingleShotCompletion, SingleShotSender, SingleShotResponse,
  DeltaCallback, TransportMode } from './src/single_shot_stream.ts';
export { runStreamingCompletion } from './src/stream_sink.ts';
/** Pure Rust helpers shared with L18's VLM components (no state, no I/O):
 * adapters/zhipu.rs `ZhipuAdapter::supports_thinking_static`, model2_pipeline.rs `sanitize_url_for_log`,
 * single_shot_stream.rs `is_retryable_http_status`. */
export { isRetryableHttpStatus } from './src/single_shot_stream.ts';
export { sanitizeUrlForLog } from './src/audit.ts';
import { ZhipuAdapter as ZhipuAdapterForThinking } from './src/adapters/zhipu.ts';
export function supportsThinkingStatic(model: string): boolean {
  return ZhipuAdapterForThinking.supportsThinkingStatic(model);
}
export type { StreamingSinkOptions } from './src/stream_sink.ts';

/** Rust LLMManager::single_shot_completion; requestBody is OpenAI-shaped, never mutated.
 * onDelta returning false stops delivery (completion.aborted=true). AbortSignal cancellation
 * rejects; a failure after delivered output returns completion.interrupted without retrying.
 * Timeouts are milliseconds; nullable arguments correspond to Rust Option.
 */
export interface LlmStreamingService {
  singleShotCompletion(config: ApiConfig, requestBody: import('../../platform/errors/api.ts').JsonValue,
    apiKey: string | null, sessionId: string | null, buildErrorContext: string,
    opts: import('./src/single_shot_stream.ts').SingleShotOptions,
    onDelta?: import('./src/single_shot_stream.ts').DeltaCallback | null,
  ): Promise<import('./src/single_shot_stream.ts').SingleShotCompletion>;
}
export const llmStreamingService = { name: 'llmStreaming', version: '1.0.0' } as const;
/** Rust LLMManager::get_http_client: proxy, redirect and configured timeout semantics. */
export interface LlmHttp { fetch: typeof fetch }
export const llmHttpService = { name: 'llmHttp', version: '1.0.0' } as const;
export interface LlmAdapterInfos {
  listAdapterInfos(): { value: string; label: string; description: string }[];
}
export const llmAdapterInfosService = { name: 'llmAdapterInfos', version: '1.0.0' } as const;
export interface LlmEmbeddingModels {
  getEmbeddingModelConfig(): Promise<ApiConfig>;
  getVlEmbeddingModelConfig(): Promise<ApiConfig>;
  adoptDefaultMultimodalEmbedding(dimension: number, modelConfigId: string): Promise<boolean>;
  healDefaultMultimodalEmbedding(candidates: readonly (readonly [number, string])[]): Promise<boolean>;
}
export const llmEmbeddingModelsService = { name: 'llmEmbeddingModels', version: '1.0.0' } as const;

/** rag_extension.rs:1009/1025. AppError-shaped rejections, no CommandError wrapper.
 * Preserves response array order (ignores index), f32 vectors, L01 chunking/MeanPooling.
 * No internal retry. Retry-After above MAX_SAFE_INTEGER stays bigint inside Host (D3).
 */
export interface TextEmbeddingService {
  generateEmbedding(text: string): Promise<number[]>;
  callEmbeddingApi(texts: string[], modelConfigId: string): Promise<number[][]>;
}
export const embeddingService = { name: 'embedding@1', version: '1.0.0' } as const;
/** models.rs RetrievedChunk (snake_case serde shape); `score` is f32. */
export interface RetrievedChunk {
  chunk: { id: string; document_id: string; chunk_index: number; text: string; metadata: Record<string, unknown> };
  score: number;
}
/** rag_extension.rs:302/499/744/1313 (WP-023/024). AppError-shaped rejections, no internal retry.
 * Text rerank keeps the API result order and drops out-of-range indexes; multimodal results sort by score desc.
 */
export interface LlmReranker {
  getRerankerModelConfig(): Promise<ApiConfig>;
  getVlRerankerModelConfig(): Promise<ApiConfig>;
  isMultimodalRerankingConfigured(): Promise<boolean>;
  callRerankerApi(query: string, chunks: RetrievedChunk[], modelConfigId: string): Promise<RetrievedChunk[]>;
  callMultimodalRerankerApi(query: import('../llm-providers/api.ts').MultimodalInput,
    documents: readonly import('../llm-providers/api.ts').MultimodalInput[]): Promise<import('../llm-providers/api.ts').VLRerankerResult[]>;
}
export const llmRerankerService = { name: 'llmReranker', version: '1.0.0' } as const;
export { embeddingErrorKind, embeddingErrorRetryAfterSecs } from './src/rag_extension.ts';
export type { EmbeddingFailure } from './src/rag_extension.ts';

export type { OcrModelConfig, OcrRuntimeCandidate } from './src/ocr_runtime.ts';
export { SYSTEM_OCR_CONFIG_ID, isDiscontinuedOcrModel } from './src/ocr_runtime.ts';
export { migrateGlmOcrModels, migratePaddleOcrModels } from './src/ocr_models_service.ts';
export interface LlmOcrModels {
  getAvailableOcrModels(): Promise<import('./src/ocr_runtime.ts').OcrModelConfig[]>;
  getOcrModelConfig(): Promise<ApiConfig>;
  getOcrConfigsByPriority(task: OcrTaskType): Promise<(readonly [ApiConfig, OcrEngineType])[]>;
  getFreeTextOcrCandidatesByPriority(): Promise<import('./src/ocr_runtime.ts').OcrRuntimeCandidate<ApiConfig>[]>;
  inspectFreeTextOcrAvailable(): Promise<boolean>;
  getOcrModelConfigForEngine(engine: OcrEngineType): Promise<ApiConfig>;
  isOcrThinkingEnabled(): boolean;
  getOcrEngineType(): Promise<OcrEngineType>;
  getOcrConfigWithEffectiveEngine(): Promise<readonly [ApiConfig, OcrEngineType]>;
}
export const llmOcrModelsService = { name: 'llmOcrModels', version: '1.0.0' } as const;
export interface LlmRagService {
  translateText(text: string, srcLang: string, tgtLang: string, customPrompt: string | null): Promise<string>;
}
export const llmRagService = { name: 'llmRag', version: '1.0.0' } as const;
export interface ExamSegmentationCard {
  question_label: string;
  bbox: { x: number; y: number; width: number; height: number };
  ocr_text: string | null;
  tags: string[];
  extra_metadata: import('../../platform/errors/api.ts').JsonValue;
  card_id: string;
}
/** Page/file OCR owner exits (exam_engine.rs:685–1067, mod.rs:7394). Errors are AppError values;
 * HTTP failures keep details.status / retry_after_ms / retry_after_seconds. Relative paths resolve
 * through F3 `fileManagerPaths.resolveImagePath` (`<active slot>/images`, FileManager::resolve_image_path). */
export interface LlmOcrPages {
  /** call_ocr_page_with_fallback: per-engine page OCR, global breaker, 4xx stop, 2×5xx → next, system-OCR whole page. */
  callOcrPageWithFallback(pagePath: string, pageIndex: number, task: OcrTaskType): Promise<ExamSegmentationCard[]>;
  /** test_ocr_with_engine (remote engines only; native system OCR is the caller's performSystemOcr branch). */
  testOcrWithEngine(imagePath: string, engineType: OcrEngineType, configId: string | null):
    Promise<{ text: string; regions: import('../llm-providers/api.ts').OcrRegion[] }>;
  /** call_ocr_free_text_with_fallback: progressive hedging over all free-text candidates. */
  callOcrFreeTextWithFallback(imagePath: string): Promise<string>;
  /** call_dedicated_ocr_free_text_with_fallback: dedicated OCR engines only, cancellable. */
  callDedicatedOcrFreeTextWithFallback(imagePath: string, cancellation: AbortSignal): Promise<string>;
}
export const llmOcrPagesService = { name: 'llmOcrPages', version: '1.0.0' } as const;
/** F3 `fileManagerPaths` as read by llm (`resolveImagePath`). */
export interface LlmFileManagerPaths {
  /** file_manager.rs:169 fallback chain, for temporary data only (RF-W07-persistent-app-data-no-silent-relocation). */
  getTempAppDataDir(): string;
  resolveImagePath(path: string): string;
}
/** File-based FreeOCR exits for command owners (translation ocr_extract_text, chat compiler).
 * Failures reject with CommandError carrying the original AppError value. */
export interface LlmFileOcr {
  callOcrFreeTextWithFallback(imagePath: string): Promise<string>;
  callDedicatedOcrFreeTextWithFallback(imagePath: string, cancellation: AbortSignal): Promise<string>;
}
export const llmFileOcrService = { name: 'llmFileOcr', version: '1.0.0' } as const;
export interface LlmOcrRegions {
  /** Image bytes are read by the caller; dimensions and region assembly retain Rust semantics. */
  parse(content: string, imageBytes: Uint8Array, imagePath: string, pageIndex: number,
    engineOverride?: OcrEngineType | null): Promise<ExamSegmentationCard[]>;
}
export const llmOcrRegionsService = { name: 'llmOcrRegions', version: '1.0.0' } as const;
export type { PreparedOcrRequest } from './src/exam_engine.ts';
export type PreparedOcrCandidate =
  | { kind: 'remote'; request: import('./src/exam_engine.ts').PreparedOcrRequest }
  | { kind: 'systemOcr'; idx: number; imageBytes: Uint8Array };
export interface LlmOcrHedge {
  prepareCandidates(dataUrl: string, candidates: readonly import('./src/ocr_runtime.ts').OcrRuntimeCandidate<ApiConfig>[],
    systemImage: Uint8Array | null): Promise<PreparedOcrCandidate[]>;
  /** Candidates must already have completed image/request preparation. */
  runPrepared(candidates: readonly PreparedOcrCandidate[], cancellation?: AbortSignal): Promise<string>;
}
export const llmOcrHedgeService = { name: 'llmOcrHedge', version: '1.0.0' } as const;
export { IncrementalJsonArrayParser } from './src/question_parsing_service.ts';
export interface LlmQuestionParsing {
  parse(prompt: string, modelConfigId?: string | null): Promise<string>;
  parseStreaming(prompt: string, modelConfigId: string | null,
    onQuestion: (value: import('../../platform/errors/api.ts').JsonValue) => boolean): Promise<import('../../platform/errors/api.ts').JsonValue[]>;
}
export const llmQuestionParsingService = { name: 'llmQuestionParsing', version: '1.0.0' } as const;
export interface Model2HistoryMessage {
  role: string;
  content: string;
  stateScope?: string | null;
  thinking_content?: string | null;
  thought_signature?: string | null;
  metadata?: { [key: string]: import('../../platform/errors/api.ts').JsonValue } | null;
  tool_call?: { id: string; tool_name: string; args_json: import('../../platform/errors/api.ts').JsonValue } | null;
  tool_result?: { call_id: string } | null;
  doc_attachments?: { name: string; text_content?: string | null }[] | null;
  image_base64?: string[] | null;
  image_paths?: string[] | null;
  multimodal_content?: ({ type: 'text'; text: string } | { type: 'image_url'; mediaType: string; base64: string })[] | null;
}
export interface LlmModel2Messages {
  build(config: ApiConfig, history: readonly Model2HistoryMessage[], systemPrompt: string | null,
    requestHasTools: boolean, injectionTexts: readonly string[]): import('../../platform/errors/api.ts').JsonValue[];
}
export const llmModel2MessagesService = { name: 'llmModel2Messages', version: '1.0.0' } as const;
export type { PreparedProviderRequest } from './src/prepared_request.ts';
export interface LlmProviderRequests {
  /** Live request preparation, including remote images and the shared active Codex session. */
  prepareModel2Async(config: ApiConfig, body: import('../../platform/errors/api.ts').JsonValue, streamEvent: string,
    messageId: string | null, cacheDebugEnabled: boolean): Promise<{
      request: import('./src/prepared_request.ts').PreparedProviderRequest;
      codexRequest: import('../llm-providers/api.ts').PreparedProviderRequest | null;
      adapter: import('../llm-providers/api.ts').ProviderAdapter;
      requiresExplicitStreamCompletion: boolean;
    }>;
  prepareModel2(config: ApiConfig, body: import('../../platform/errors/api.ts').JsonValue, streamEvent: string,
    messageId: string | null, cacheDebugEnabled: boolean): {
      request: import('./src/prepared_request.ts').PreparedProviderRequest;
      adapter: import('../llm-providers/api.ts').ProviderAdapter;
      requiresExplicitStreamCompletion: boolean;
    };
}
export const llmProviderRequestsService = { name: 'llmProviderRequests', version: '1.0.0' } as const;
export interface Model2ToolCall { id: string; tool_name: string; args_json: import('../../platform/errors/api.ts').JsonValue }
/** Optional callbacks correspond to Rust LLMStreamHooks' default methods. */
export interface LlmStreamHooks {
  onContentChunk?(text: string): void;
  onReasoningChunk?(text: string): void;
  onResponseReasoningItem?(item: import('../../platform/errors/api.ts').JsonValue): void;
  onThoughtSignature?(signature: string): void;
  onToolCallStart?(id: string, name: string): void;
  onToolCallArgsDelta?(id: string, delta: string): void;
  onToolCall?(message: Model2HistoryMessage): void;
  onToolResult?(message: Model2HistoryMessage): void;
  onUsage?(usage: import('../../platform/errors/api.ts').JsonValue): void;
  onWebSearch?(payload: import('../../platform/errors/api.ts').JsonValue): void;
  onComplete?(text: string, reasoning: string | null): void;
}
export interface Model2EventOptions {
  streamEvent: string;
  requestId: string;
  sink: StreamEventSink;
  requireTerminalSuccess: boolean;
  isCodex: boolean;
}
export interface Model2EventSnapshot {
  content: string;
  reasoning: string;
  chunkCount: number;
  usage: import('../../platform/errors/api.ts').JsonValue | null;
  toolCalls: Model2ToolCall[];
  terminalSuccess: boolean;
  terminalFailure: string | null;
  ended: boolean;
}
export interface Model2EventCollector {
  readonly ended: boolean;
  dispatch(events: readonly import('../llm-providers/api.ts').StreamEvent[]): void;
  /** Called after the outer stream termination check, including the cancelled path. */
  finishPending(): void;
  /** After termination/payload validation: notify tools, then completion (unless cancelled). */
  complete(wasCancelled: boolean, enableChainOfThought: boolean): void;
  snapshot(): Model2EventSnapshot;
}
export interface LlmStreamEvents {
  registerStreamHooks(streamEvent: string, hooks: LlmStreamHooks): void;
  unregisterStreamHooks(streamEvent: string): void;
  unregisterStreamHooksIfOwner(streamEvent: string, owner: LlmStreamHooks): boolean;
  create(options: Model2EventOptions): Model2EventCollector;
}
export const llmStreamEventsService = { name: 'llmStreamEvents', version: '1.0.0' } as const;
export interface UnifiedModel2StreamInput {
  context: Record<string, import('../../platform/errors/api.ts').JsonValue>;
  chatHistory: Model2HistoryMessage[];
  subject: string;
  enableChainOfThought: boolean;
  enableThinking: boolean;
  taskContext: string | null;
  sink: StreamEventSink;
  streamEvent: string;
  messageId?: string | null;
  traceId?: string | null;
  window?: import('../../kernel/api.ts').WindowRef | null;
  disableTools?: boolean;
  maxInputTokensOverride?: number | null;
  modelOverrideId?: string | null;
  systemPromptOverride?: string | null;
  paramOverrides?: ParamOverrides;
  reasoningEffortOverride?: string | null;
  thinkingBudgetOverride?: number | null;
}
export interface StandardModel2Output {
  assistant_message: string;
  raw_response: string | null;
  chain_of_thought_details: import('../../platform/errors/api.ts').JsonValue | null;
  cancelled: boolean;
}
export interface LlmModel2Streaming {
  /** Rust call_unified_model_2_stream; hooks are registered on llmStreamEvents by the caller. */
  callUnifiedModel2Stream(input: UnifiedModel2StreamInput): Promise<StandardModel2Output>;
  callUnifiedModel2StreamWithConfig(config: ApiConfig, establishRetries: number,
    input: UnifiedModel2StreamInput): Promise<StandardModel2Output>;
}
export const llmModel2StreamingService = { name: 'llmModel2Streaming', version: '1.0.0' } as const;
export type { Model2UsageRecorder } from './src/model2_streaming_service.ts';
export type { WebSearchFallback } from './src/model2_request.ts';
export type { McpFrontendBridge, LlmMcpTools } from './src/mcp_tools_service.ts';
export const llmMcpToolsService = { name: 'llmMcpTools', version: '1.0.0' } as const;
export type { AnkiModelRole, RoutingMode, RoleDecision, AnkiRoutingSlots, AnkiRoutingPlan } from './src/anki_model_routing.ts';
export { parseRoutingMode, planRouting } from './src/anki_model_routing.ts';
export interface LlmAnkiRouting {
  probeAnkiRoutingSlots(): Promise<import('./src/anki_model_routing.ts').AnkiRoutingSlots>;
  resolveAnkiRoleDecision(role: import('./src/anki_model_routing.ts').AnkiModelRole,
    mode: import('./src/anki_model_routing.ts').RoutingMode): Promise<import('./src/anki_model_routing.ts').RoleDecision | null>;
}
export const llmAnkiRoutingService = { name: 'llmAnkiRouting', version: '1.0.0' } as const;

export interface ImagePayload { mime: string; base64: string }
/** Rust dstu-storage `CallerType` wire shape (`Display`: unit name or `other:<name>`). */
export type LlmCallerType = 'chat_v2' | 'translation' | 'anki' | 'analysis' | 'exam_sheet' | 'memory'
  | 'vfs_indexing' | 'embedding' | 'reranker' | 'voice_input' | 'media_transcription' | { other: string };
/** F3 owner port for `record_llm_usage_cache_ext_with_identity` (dstu-storage llm_usage/mod.rs:264).
 * Nullable fields correspond to Rust Option (NULL in the table, not zero). */
export interface LlmUsageRecorder {
  cacheDebugEnabled(): boolean;
  recordLlmUsageCacheExtWithIdentity(record: import('./src/usage.ts').UsageTokens & {
    callerType: LlmCallerType; model: string; sessionId: string | null; variantId: string | null; runId: string | null;
    durationMs: number | null; success: boolean; errorMessage: string | null; adapter: string | null;
    tokenSource: 'api' | 'heuristic' | 'mixed' | null;
  }): void;
}
/** Rust LLMManager raw-prompt exits (model2_pipeline.rs:8570–8838): real provider adapters,
 * failover (model2 exits only), RAW_PROMPT audit and usage records. Errors are AppError values. */
export interface LlmRawPrompt {
  /** call_with_config_id_raw_prompt (model2_pipeline.rs:8682): config id → model name → Model2 (warn),
   * force_json=false, caller chat_v2, task 'compaction', failover, no agent session.
   * Returns the unchanged output; errors propagate. Caller-owned cancellation aborts HTTP/retry waits
   * and rejects with signal.reason. HPIAS owns its 90s timeout and deterministic fallback. */
  callWithConfigIdRawPrompt(configId: string, prompt: string, signal?: AbortSignal): Promise<StandardModel2Output>;
  /** call_agent_compaction_raw_prompt (model2_pipeline.rs:8692): config by id, then model name, else model2 (warn);
   * force_json=false, caller chat_v2, task 'compaction', failover; the agent session allows OpenCode Go. */
  callAgentCompactionRawPrompt(configId: string, prompt: string, agentSessionId: string): Promise<StandardModel2Output>;
  /** call_agent_chat_title_raw_prompt (:8867): chat_title model (→ model2), force_json=true, thinking disabled,
   * caller chat_v2, task 'chat_title', failover, agent session scoped. */
  callAgentChatTitleRawPrompt(prompt: string, agentSessionId: string): Promise<StandardModel2Output>;
  /** call_model2_raw_prompt: force_json=true, task 'utility'. */
  callModel2RawPrompt(prompt: string, images: ImagePayload[] | null, callerType: LlmCallerType): Promise<StandardModel2Output>;
  /** call_anki_routed_raw_prompt (model2_pipeline.rs:8632): when `decision.configId` names an enabled text config
   * (not embedding/reranker/image generation) in getApiConfigs, call it with force_json=true, caller 'anki',
   * the given `task` and failover; a missing config or a getApiConfigs failure logs debug and, like a null
   * decision, falls back to callModel2RawPrompt(prompt, images, 'anki') (task 'utility'). Errors are AppError values.
   * Rust has no token (callers drop the future on their timeout); an aborted `signal` stops HTTP/retry waits
   * and rejects with `signal.reason`. */
  callAnkiRoutedRawPrompt(decision: import('./src/anki_model_routing.ts').RoleDecision | null, task: string, prompt: string,
    images: ImagePayload[] | null, signal?: AbortSignal): Promise<StandardModel2Output>;
  /** call_model2_raw_prompt_opts. Optional cancellation models handout.rs dropping the future:
   * aborts HTTP/body reads and retry delays; rejects AppError.validation('cancelled').
   * Other errors, model2/task routing and usage semantics are unchanged. */
  callModel2RawPromptOpts(prompt: string, forceJson: boolean, callerType: LlmCallerType, task: string,
    cancellation?: AbortSignal): Promise<StandardModel2Output>;
  /** call_memory_decision_raw_prompt (model2_pipeline.rs:8842): memory_decision model (→ model2, same
   * resolve_enabled_text_model as getMemoryDecisionModelConfig), force_json=true, thinking unchanged, caller
   * 'memory', task 'memory_decision', no images, failover. Resolves the unchanged StandardModel2Output
   * (snake_case; consumers read `assistant_message`). Missing/disabled config rejects the
   * CommandError from getMemoryDecisionModelConfig; transport errors are the original AppError values.
   * Rust has no token here (consumers drop the future); an aborted `signal` stops HTTP/retry waits
   * and rejects with `signal.reason`, with no further request or usage. */
  callMemoryDecisionRawPrompt(prompt: string, signal?: AbortSignal): Promise<StandardModel2Output>;
  /** call_raw_prompt_with_config_id_and_images: exact config (id or model), no failover, force_json=false. */
  callRawPromptWithConfigIdAndImages(configId: string, prompt: string, images: ImagePayload[],
    callerType: LlmCallerType): Promise<StandardModel2Output>;
  /** Cancelled → AppError.llm('visual observation cancelled'); the in-flight request is aborted. */
  callRawPromptWithConfigIdAndImagesCancellable(configId: string, prompt: string, images: ImagePayload[],
    callerType: LlmCallerType, cancellation: AbortSignal): Promise<StandardModel2Output>;
}
export const llmRawPromptService = { name: 'llmRawPrompt', version: '1.0.0' } as const;
export type { QuestionJsonCompletion } from './src/question_authoring.ts';
export type { DebugPersistConfig } from './src/audit_log.ts';
/** Rust LLMManager::run_question_json (question_authoring.rs:166) and build_debug_persist_config
 * (model2_pipeline.rs:5095). Failures reject with CommandError carrying the original AppError value. */
export interface LlmQuestionAuthoring {
  runQuestionJson(config: ApiConfig, systemPrompt: string, userContent: import('../../platform/errors/api.ts').JsonValue,
    cancel?: AbortSignal | null): Promise<import('./src/question_authoring.ts').QuestionJsonCompletion>;
  /** Some only when setting `debug.persist_logs` is exactly "true"; directory ensured (errors ignored). */
  buildDebugPersistConfig(): import('./src/audit_log.ts').DebugPersistConfig | null;
}
export const llmQuestionAuthoringService = { name: 'llmQuestionAuthoring', version: '1.0.0' } as const;
/** L03 context_compiler.rs:727/857 owner, provided as `llmContextCompiler@1`.
 * Composes the existing exact-config raw multimodal and dedicated file-OCR implementations.
 * Rejects with original AppError values (not IPC CommandError wrappers): raw cancellation is
 * `LLM: visual observation cancelled`; OCR cancellation is `LLM: OCR cancelled`.
 * The caller owns stage deadlines and the OCR temporary file lifetime.
 */
export interface ContextCompilerLlmOwner {
  callRawPromptWithConfigIdAndImagesCancellable(configId: string, prompt: string,
    images: ImagePayload[], callerType: 'chat_v2', cancellation: AbortSignal): Promise<StandardModel2Output>;
  callDedicatedOcrFreeTextWithFallback(imagePath: string, cancellation: AbortSignal): Promise<string>;
}
export const llmContextCompilerService = { name: 'llmContextCompiler', version: '1.0.0' } as const;
export interface StreamEventSink { emit(channel: string, payload: unknown): void }
export interface ParamOverrides {
  temperature?: number | null;
  topP?: number | null;
  frequencyPenalty?: number | null;
  presencePenalty?: number | null;
  maxOutputTokens?: number | null;
}

/** Rust LLMManager::call_unified_model_2 (model2_pipeline.rs:7559): non-streaming, positional Rust arguments.
 * task_context routes the model (contains "planner" → review, "tag_generation"/contains "tag" → tag_generation,
 * else default) with a model2 fallback, then runs background failover (no llm-failover event, no usage record).
 * The prompt is the model2 subject prompt plus `任务上下文` and the context's ocr_text/tags/mistake_type/user_question.
 * Configuration failures reject with CommandError; transport failures with the original AppError value. */
export interface LlmUnifiedModel2 {
  callUnifiedModel2(context: Record<string, import('../../platform/errors/api.ts').JsonValue>,
    chatHistory: readonly Model2HistoryMessage[], subject: string, enableChainOfThought: boolean,
    imagePaths: string[] | null, taskContext: string | null, maxInputTokensOverride: number | null): Promise<StandardModel2Output>;
}

/** Rust LLMManager configuration, routing and run-scoped cancellation surface. */
export interface LLMManager extends LlmUnifiedModel2 {
  getApiConfigs(): Promise<ApiConfig[]>;
  saveApiConfigurations(configs: ApiConfig__De[]): Promise<void>;
  getVendorConfigs(): Promise<VendorConfig[]>;
  saveVendorConfigs(configs: VendorConfig__De[]): Promise<void>;
  getModelProfiles(): Promise<ModelProfile[]>;
  saveModelProfiles(profiles: ModelProfile__De[]): Promise<void>;
  getModelAssignments(): Promise<ModelAssignments>;
  saveModelAssignments(assignments: ModelAssignments__De): Promise<void>;
  getModel2Config(): Promise<ApiConfig>;
  getTranslationModelConfig(): Promise<ApiConfig>;
  getMemoryDecisionModelConfig(): Promise<ApiConfig>;
  getChatTitleModelConfig(): Promise<ApiConfig>;
  selectModelFor(task: string, overrideId?: string | null, overrides?: ParamOverrides): Promise<[ApiConfig, boolean]>;
  getFailoverPolicy(): Promise<FailoverPolicy>;
  saveFailoverPolicy(policy: FailoverPolicy): Promise<void>;
  decryptApiKey(apiKey: string): Promise<string>;
  /** Each subscription replaces the previous watch sender for the same key. */
  subscribeCancelStream(streamEvent: string): Promise<AbortSignal>;
  requestCancelStream(streamEvent: string): Promise<void>;
  consumePendingCancel(streamEvent: string): Promise<boolean>;
  clearCancelStream(streamEvent: string): Promise<void>;
  clearCancelArtifacts(streamEvent: string): Promise<void>;
  cancelStreamsByPrefix(prefix: string): Promise<void>;
}
export type LlmService = LLMManager;

/** 服务版本描述（`docs/plugins/ARCHITECTURE.md` 附录 A）。 */
export const llmService = { name: 'llm', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LLMManager;
    llmStreaming: LlmStreamingService;
    llmHttp: LlmHttp;
    llmAdapterInfos: LlmAdapterInfos;
    llmEmbeddingModels: LlmEmbeddingModels;
    'embedding@1': TextEmbeddingService;
    llmReranker: LlmReranker;
    llmOcrModels: LlmOcrModels;
    llmRag: LlmRagService;
    llmOcrRegions: LlmOcrRegions;
    llmOcrHedge: LlmOcrHedge;
    llmQuestionParsing: LlmQuestionParsing;
    llmModel2Messages: LlmModel2Messages;
    llmProviderRequests: LlmProviderRequests;
    llmStreamEvents: LlmStreamEvents;
    llmModel2Streaming: LlmModel2Streaming;
    llmAnkiRouting: LlmAnkiRouting;
    llmRawPrompt: LlmRawPrompt;
    llmContextCompiler: ContextCompilerLlmOwner;
    llmOcrPages: LlmOcrPages;
    llmFileOcr: LlmFileOcr;
    llmQuestionAuthoring: LlmQuestionAuthoring;
    llmMcpTools: import('./src/mcp_tools_service.ts').LlmMcpTools;
    essayGrading: import('./src/essay_grading/api.ts').EssayGradingService;
  }
}
