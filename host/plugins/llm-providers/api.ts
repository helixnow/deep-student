/** L01 public service boundary. Stream events retain the Rust variant names. */
import type { OcrEngineInfo } from './src/ocr/factory.ts';
import type { EmbeddingChunker } from './src/multimodal/embedding-chunker.ts';
import type {
  EmbeddingServiceConfig, MultimodalEmbeddingService, MultimodalEmbeddingServiceRuntime,
} from './src/multimodal/embedding-service.ts';
import type { AttachmentPreview, AttachmentPreviewPage } from './src/multimodal/page-indexer.ts';
import type {
  CodexPrepareOptions, CodexRequestConfig, CodexSendOptions, PreparedProviderRequest,
} from './src/openai-codex/prepare.ts';
import type { CodexRequestAuth } from './src/openai-codex/types.ts';
import type { CodexAuthState } from './src/openai-codex/types.ts';
import type { LlmReplayService } from './src/replay/service.ts';
export type { CodexAuthState } from './src/openai-codex/types.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
/** Host ToolCall numeric handoff; neither helper repairs prior ordinary JSON parsing/copying. */
export { cloneProviderToolCall, stringifyProviderToolCall } from './src/tool-call-values.ts';

/** providers/mod.rs:17 */
export interface ProviderRequest {
  url: string;
  headers: [string, string][];
  body: JsonValue;
}

/** providers/mod.rs:39. `value` is the tuple variant's payload; Done has none. */
export type StreamEvent =
  | { type: 'ContentChunk' | 'ReasoningChunk' | 'ThoughtSignature'; value: string }
  | { type: 'ResponseReasoningItem' | 'ToolCall' | 'WebSearchCall' | 'Usage' | 'SafetyBlocked'; value: JsonValue }
  | { type: 'Done' };

/** An adapter is stateful and belongs to one in-flight request, as in Rust. */
export interface ProviderAdapter {
  buildRequest(baseUrl: string, apiKey: string, model: string, body: JsonValue): ProviderRequest;
  requiresExplicitStreamCompletion(): boolean;
  parseStream(line: string): StreamEvent[];
  finishStream(): StreamEvent[];
}

export type ProviderKind = 'openai' | 'openai_responses' | 'anthropic' | 'gemini';
export { OpenAIAdapter, openaiEndpointUrl, normalizeOllamaRootBaseUrl, normalizeOpenaiNonstreamResponse } from './src/providers/openai-chat.ts';
export { OpenAIResponsesAdapter } from './src/providers/openai-responses.ts';
export { GeminiAdapter } from './src/providers/gemini.ts';
export {
  AdapterError, buildGeminiRequest, buildGeminiRequestWithVersion, convertGeminiNonstreamResponseToOpenai,
  isSyntheticToolCallId, parseGeminiStreamLine,
} from './src/adapters/gemini-openai-converter.ts';
export type { GeminiPendingToolCall } from './src/adapters/gemini-openai-converter.ts';
export {
  AnthropicAdapter, buildUsageEvent, claudeGeneration, convertAnthropicResponseToOpenai, mapBudgetTokensToEffort,
} from './src/providers/anthropic.ts';
export { CodexAuthError } from './src/openai-codex/error.ts';
export { CodexRequestAuth } from './src/openai-codex/types.ts';
export type { BrowserLoginStart, DeviceLoginStart } from './src/openai-codex/types.ts';
export { buildCodexRequestHeaders, prepareCodexResponsesBody, codexSseToResponsesJson, codexResponsesEndpoint } from './src/openai-codex/protocol.ts';
export {
  effectiveCodexProtocol, prepareProviderRequest, sendCodexRequestWithSingleRefresh,
  sendCodexStreamRequestWithSingleRefresh, stablePromptCacheKey, isCodexOAuthConfig,
  type CodexPrepareOptions, type CodexRequestConfig, type CodexSendOptions,
  type PreparedProviderRequest,
} from './src/openai-codex/prepare.ts';

export { EmbeddingChunker, EmbeddingTokenLimits, batchChunkTexts } from './src/multimodal/embedding-chunker.ts';
export type { ChunkAggregation, ChunkResult } from './src/multimodal/embedding-chunker.ts';
export {
  MultimodalInput as MultimodalInputBuilder, IndexProgressEvent as IndexProgressEventBuilder,
  toVLEmbeddingInput, imageAsBase64, imageAsUrl, indexingModeFromStr, indexingModeAsStr, vectorTableSuffix,
  requiresVLEmbeddingModel, requiresVLSummaryModel, requiresTextEmbeddingModel,
} from './src/multimodal/types.ts';
export {
  DEFAULT_BATCH_SIZE, DEFAULT_SUMMARY_CONCURRENCY, VL_EMBED_BACKOFF_BASE_MS, VL_EMBED_BACKOFF_MAX_MS,
  VL_EMBED_MAX_ATTEMPTS, MultimodalEmbeddingService, callVlEmbeddingWithRetry, defaultEmbeddingServiceConfig,
  embedBatchWithProgress, isTransientEmbeddingError, looksLikeValidBase64, pagesToInputs,
  prepareInputsWithFallback, vlEmbedBackoffDelay,
} from './src/multimodal/embedding-service.ts';
export type {
  EmbeddingProgress, EmbeddingServiceConfig, MultimodalEmbeddingModelConfig, MultimodalEmbeddingRuntime,
  MultimodalEmbeddingServiceRuntime, RetryOptions, TextEmbeddingModelConfig,
} from './src/multimodal/embedding-service.ts';
export { parseAttachmentPreview, parseAttachmentPreviewJson, parseAttachmentPreviewPage } from './src/multimodal/page-indexer.ts';
export type {
  AttachmentPreview, AttachmentPreviewPage, TextbookPreview, TextbookPreviewPage,
} from './src/multimodal/page-indexer.ts';

export { BaseOcrAdapter } from './src/ocr/base.ts';
export { DeepSeekOcrAdapter, extractMarkdownText, parseDeepseekGrounding } from './src/ocr/deepseek.ts';
export type { DeepseekGroundingSpan } from './src/ocr/deepseek.ts';
export { GenericVlmAdapter, Glm4vOcrAdapter } from './src/ocr/generic.ts';
export { PaddleOcrVlAdapter, extractJsonFromResponse, parsePaddleJsonResponse } from './src/ocr/paddle.ts';
export type { ParsedPaddleResponse } from './src/ocr/paddle.ts';
export {
  SystemOcrAdapter, isPlatformSupported as isSystemOcrPlatformSupported, performSystemOcr,
  setSystemOcrBinding, systemOcrBinding,
} from './src/ocr/system.ts';
export type { SystemOcrNativeBinding } from './src/ocr/system.ts';
export { OcrAdapterFactory, ocrEngineInfoToJson } from './src/ocr/factory.ts';
export type { OcrEngineInfo } from './src/ocr/factory.ts';
export {
  cachedRemoteImage, prepareRemoteImages, remoteImageBase64Payload, remoteImageFetcher, setRemoteImageFetcher, setRemoteImageDownloader, type RemoteImageDownloader,
} from './src/media/remote-image.ts';
export type { RemoteImageFetcher } from './src/media/remote-image.ts';
export {
  OcrError, OcrImageSource, isDedicatedOcrEngine, isImportPreferredOcrEngine, isNativeOcrEngine,
  ocrEngineDisplayName, ocrEngineRecommendedModel, ocrEngineTypeFromStr, ocrModeFromStr, tryOcrEngineTypeFromStr,
} from './src/ocr/types.ts';
export type { OcrAdapterConfig, OcrErrorKind, OcrRequest } from './src/ocr/types.ts';
export { LATEX_OUTPUT_BRIEF, LATEX_OUTPUT_BRIEF_EN } from './src/ocr/prompts.ts';

/** multimodal/types.rs:32,128,164. Absent Options are omitted on the wire. */
export interface MultimodalInput {
  text?: string;
  image?: MultimodalImage;
  instruction?: string;
  video?: MultimodalVideo;
}
export type MultimodalImage = { data: string; media_type: string } | { url: string };
export type MultimodalVideo = { url: string } | { frames: MultimodalImage[]; fps: number };
export interface VLEmbeddingInputItem { text?: string; image?: string; instruction?: string }
export interface VLRerankerResult { index: number; relevance_score: number }
export type MultimodalIndexingMode = 'vl_embedding' | 'vl_summary_then_text_embed';
export interface IndexProgressEvent {
  sourceType: string;
  sourceId: string;
  phase: string;
  currentPage: number;
  totalPages: number;
  indexedPages: number;
  skippedPages: number;
  progressPercent: number;
  message: string;
}

/** ocr_adapters/types.rs */
export type OcrEngineType = 'deepseek_ocr' | 'paddle_ocr_vl' | 'paddle_ocr_vl_v1' | 'glm4v_ocr' | 'generic_vlm' | 'system_ocr';
export type OcrTaskType = 'FreeText' | 'Structured';
export type OcrMode = 'grounding' | 'free_ocr' | 'formula' | 'table' | 'chart';
export interface OcrRegion {
  label: string;
  text: string;
  bbox_normalized?: number[];
  bbox_pixels?: number[];
  confidence?: number;
  raw_output?: string;
}
export interface OcrPageResult {
  page_index: number;
  image_path: string;
  image_width: number;
  image_height: number;
  regions: OcrRegion[];
  markdown_text?: string;
  engine: OcrEngineType;
  mode: OcrMode;
  processing_time_ms?: number;
}
export interface OcrAdapter {
  engineType(): OcrEngineType;
  displayName(): string;
  supportsMode(mode: OcrMode): boolean;
  buildPrompt(mode: OcrMode): string;
  buildCustomPrompt(customPrompt: string, mode: OcrMode): string;
  parseResponse(response: string, imageWidth: number, imageHeight: number, pageIndex: number, imagePath: string, mode: OcrMode): OcrPageResult;
  recommendedMaxTokens(mode: OcrMode): number;
  recommendedTemperature(): number;
  requiresHighDetail(): boolean;
  getExtraRequestParams(): JsonValue | null;
  recommendedRepetitionPenalty(): number | null;
}

export type {
  CodexAuthStatus, CodexLoginKind, CodexAuthPhase, CodexAuthErrorDto,
  CodexUsageSnapshot, CodexRateLimits, CodexRateLimitWindow,
} from '../../../contracts/ipc/generated/L01-llm-providers.ts';

/** Plugin logger subset passed into adapters/services (Rust `log` crate port). */
export interface PluginLogger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/** Constructor access is through Cordis, never another lane's implementation. */
export interface LlmAdapterService {
  /** providers/mod.rs:98,828,2306,3809: one fresh stateful adapter per request. */
  createAdapter(kind: ProviderKind): ProviderAdapter;
  /**
   * providers/mod.rs:3509 `create_base64_payload`: download http(s) image parts
   * through the platform SSRF-checked cache and rewrite them to `data:` URLs.
   * Callers must await this before the synchronous `buildRequest`.
   * Optional so existing test doubles that only implement `createAdapter` stay valid.
   */
  prepareRemoteImages?(body: JsonValue): Promise<JsonValue>;
}

/**
 * The single active Codex OAuth manager also used by the five IPC commands.
 * L02 must call this service instead of keeping a second credential/session copy.
 */
export interface LlmCodexAuthService {
  status(): Promise<CodexAuthState>;
  requestAuth(forceRefresh?: boolean): Promise<CodexRequestAuth>;
  refreshAfterUnauthorized(observedGeneration: number): Promise<CodexRequestAuth>;
  markReauthenticationRequired(observedGeneration: number): Promise<boolean>;
  responsesEndpoint(): Promise<string>;
  /** model2_pipeline.rs:4966 `prepare_provider_request`. */
  prepareRequest(
    adapter: ProviderAdapter,
    config: CodexRequestConfig,
    body: JsonValue,
    options?: CodexPrepareOptions,
  ): Promise<PreparedProviderRequest>;
  /**
   * model2_pipeline.rs:5037 `send_codex_request_with_single_refresh`:
   * stream send + `bridge_codex_nonstream_response` (non-stream JSON).
   */
  sendWithSingleRefresh(
    request: PreparedProviderRequest,
    options?: CodexSendOptions,
  ): Promise<Response>;
  /** model2_pipeline.rs:5055 `send_codex_stream_request_with_single_refresh`: stream primitive. */
  sendStreamWithSingleRefresh(
    request: PreparedProviderRequest,
    options?: CodexSendOptions,
  ): Promise<Response>;
}

/** ocr_adapters/factory.rs exposed to media/docs consumers. */
export interface LlmOcrService {
  readonly version: 1;
  /** ocr_adapters/factory.rs:20 `OcrAdapterFactory::create`. */
  createAdapter(engine: OcrEngineType): OcrAdapter;
  /** ocr_adapters/factory.rs:37 `OcrAdapterFactory::create_from_str`. */
  createAdapterFromStr(engine: string): OcrAdapter;
  /** ocr_adapters/factory.rs:66 `OcrAdapterFactory::available_engines`. */
  availableEngines(): OcrEngineType[];
  /** ocr_adapters/factory.rs:80 `OcrAdapterFactory::engine_info_list`. */
  engineInfoList(): OcrEngineInfo[];
  /** ocr_adapters/factory.rs:190 `OcrEngineInfo` serialization. */
  engineInfoToJson(info: OcrEngineInfo): JsonObject;
}

/**
 * multimodal/* exposed to indexing consumers. The embedding service receives
 * the L02 runtime through the published minimal interface.
 */
export interface LlmMultimodalService {
  readonly version: 1;
  /** multimodal/embedding_service.rs:149 `MultimodalEmbeddingService`. */
  createEmbeddingService(
    runtime: MultimodalEmbeddingServiceRuntime,
    config?: EmbeddingServiceConfig,
  ): MultimodalEmbeddingService;
  /** multimodal/embedding_chunker.rs:149 `EmbeddingChunker`. */
  createChunker(maxTokens: number): EmbeddingChunker;
  /** multimodal/page_indexer.rs `parse_attachment_preview`. */
  parseAttachmentPreview(value: JsonValue): AttachmentPreview;
  /**
   * Same decoder from the stored `preview_json` text (multimodal_service.rs:1378
   * `serde_json::from_str`): integer literal forms, the 64-bit range and
    * repeated fields are judged from the text, in serde input order. Unknown fields
    * use IgnoredAny; struct sequences follow declaration order/defaults. Consumers
    * holding the text should use this, rather than pre-parsing a JsonValue.
    * Failures keep the `invalid attachment preview: ...` context and include the
    * original JsonSyntaxError as cause (Rust-style detail and UTF-8 line/column).
   */
  parseAttachmentPreviewJson(text: string): AttachmentPreview;
  /** multimodal/page_indexer.rs `parse_attachment_preview_page`. */
  parseAttachmentPreviewPage(value: JsonValue): AttachmentPreviewPage;
}

/**
 * Deterministic LLM replay provider for tests and G3 replays: chat completions, embeddings and audio
 * transcriptions, answered by the same code as host/e2e/streaming/wave0/llm-service.ts
 * (src/replay/answer.ts). Mounted only on request, never by an official profile; L02 hands it
 * exactly the requests addressed to {@link LLM_REPLAY_ORIGIN}.
 */
export { LLM_REPLAY_ORIGIN, createLlmReplay, isLlmReplayUrl } from './src/replay/service.ts';
export type { LlmReplayConfig, LlmReplayService, ReplayRequestEnd, ReplayRequestLog } from './src/replay/service.ts';
export { LLM_REPLAY_SCRIPTS, type LlmReplayScriptId } from './src/replay/builtin.ts';
export { providerSidecarScripts, validateReplayScripts } from './src/replay/scripts.ts';
export type {
  ReplayDerivedRound, ReplayDerivedScript, ReplayFrame, ReplayResponse, ReplayResponseScript, ReplayRound, ReplayRoundScript, ReplayScript,
} from './src/replay/wire.ts';
export { llmReplayPlugin } from './src/replay/plugin.ts';

/** ARCHITECTURE.md §3 service descriptors (versioned, lowerCamelCase names). */
export const llmAdaptersService = { name: 'llmAdapters', version: '1.0.0' } as const;
export const llmOcrService = { name: 'llmOcr', version: '1.0.0' } as const;
export const llmMultimodalService = { name: 'llmMultimodal', version: '1.0.0' } as const;
export const llmCodexAuthService = { name: 'llmCodexAuth', version: '1.0.0' } as const;
export const llmReplayService = { name: 'llmReplay', version: '1.0.0' } as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    llmAdapters: LlmAdapterService;
    llmOcr: LlmOcrService;
    llmMultimodal: LlmMultimodalService;
    llmCodexAuth: LlmCodexAuthService;
    /** Present only while `llmReplayPlugin` is installed; read with `ctx.reflect.get('llmReplay', false)`. */
    llmReplay: LlmReplayService;
  }
}
export { decodeBase64Url, encodeBase64, encodeBase64Url } from './src/base64.ts';
