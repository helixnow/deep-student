import type { CapabilitySnapshot, CapabilityState, ProcessingProgress as WireProcessingProgress, ProcessingIssue } from '../../../contracts/ipc/generated/_shared.ts';
export type { CapabilitySnapshot, CapabilityState, ProcessingIssue };
/** Host counters remain exact; the kernel converts bigint only at the IPC boundary.
 *  percent stays the internal f32 number; only the outbound snapshot may be null. */
export type ProcessingProgress = Omit<WireProcessingProgress, 'currentPage' | 'totalPages' | 'percent'> & {
  currentPage?: number | bigint | null;
  totalPages?: number | bigint | null;
  percent: number;
};
/** serde_json serializes non-finite f32 values as null; counters stay exact until IPC. */
export type ProcessingProgressSnapshot = Omit<ProcessingProgress, 'percent'> & { percent: number | null };
export type {
  MediaProcessingProgressEvent, MediaProcessingCompletedEvent, MediaProcessingErrorEvent,
  MediaTranscriptionProgressEvent, MediaTranscriptionCompletedEvent,
} from '../../../contracts/ipc/generated/L12-vfs-index.ts';
import { VfsLanceStore as VfsLanceStoreClass, type LanceConnection } from './src/lance-store.ts';
export const buildLanceFilterExprFull = VfsLanceStoreClass.buildFilterExprFull;
export type {
  LanceConnection, LanceSearchFilter, LanceSearchRequest, LanceTable, LanceTableDiagnostic, LanceTableSchema,
  LanceVectorColumn,
} from './src/lance-store.ts';
export type { VfsIndexProfile } from './repository/embedding-dim.ts';
/** VFS Lance boundary; this lane provides it as `lanceEngine` over F7 `vector`. */
export interface LanceEngineService {
  connect(path: string): Promise<LanceConnection>;
}
export const lanceEngineService = { name: 'lanceEngine', version: '1.0.0' } as const;
export const retrievalService = { name: 'retrieval', version: '1.0.0' } as const;
/** `retrieval` search entry points consumed under the tool executor's cancellation (rs:299-321 tokio::select). */
export const retrievalCancellableService = { name: 'retrievalCancellable', version: '1.0.0' } as const;
export const vfsIndexService = { name: 'vfsIndex', version: '1.0.0' } as const;
/** Table-owner unit sync consumed by L13b `vfs_sync_resource_units`. */
export const vfsUnitBuilderService = { name: 'vfsUnitBuilder', version: '1.0.0' } as const;
/** Table-owner Unit/Segment/dimension maintenance consumed by L13b index admin commands. */
export const vfsIndexMaintenanceService = { name: 'vfsIndexMaintenance', version: '1.0.0' } as const;

/** `UnitBuildInput` from `vfs/unit_builder/trait_def.rs`; same keys as the sync command. */
export interface UnitBuildInput {
  resourceId: string;
  resourceType: string;
  data?: string | null;
  ocrText?: string | null;
  ocrPagesJson?: string | null;
  blobHash?: string | null;
  pageCount?: number | null;
  extractedText?: string | null;
  previewJson?: string | null;
}
export type SyncUnitInput = UnitBuildInput;
export interface UnitBuilderService {
  /** `index_service.rs::sync_resource_units`: one connection, one `sync_units` savepoint. */
  syncResourceUnits(input: UnitBuildInput): import('../vfs-repos/api.ts').VfsIndexUnit[];
  /**
   * Async `indexing.rs::sync_resource_to_units` used by the full indexer; the
   * only difference is legacy multi-page PDF re-extraction via F7 pdfium.
   */
  syncResourceUnitsForResourceAsync?(
    resourceId: string,
  ): Promise<import('../vfs-repos/api.ts').VfsIndexUnit[]>;
}
export interface DeleteIndexResult {
  resourceId: string;
  deletedUnitCount: number;
  lanceRowIds: string[];
}
export interface VfsIndexMaintenanceService {
  /** `index_service.rs::reset_unit_index`: one IMMEDIATE transaction with the resource scheduler state. */
  resetUnitIndex(unitId: string, mode: string): void;
  /** `index_service.rs::delete_resource_index`: SQLite/orphan-queue/dimension-count portion. */
  deleteResourceIndex(resourceId: string): DeleteIndexResult;
}

export type QueryModality = 'text' | 'image' | 'mixed';export type ActiveGenerationModel = 'text' | 'multimodal';
export type CapabilityKind = 'text_embedding' | 'multimodal_embedding' | 'text_model' | 'multimodal_model' | 'ocr';
export type GenerationRoute = 'text_model_direct' | 'multimodal_model_direct' | 'multimodal_observation_then_text_model' | 'ocr_then_text_model' | 'text_model_without_image' | 'unavailable';
export interface GenerationPlan {
  route: GenerationRoute;
  activeModel: ActiveGenerationModel | null;
  fallbackFrom: ActiveGenerationModel | null;
  sendsOriginalImages: boolean;
  usesOcr: boolean;
  degraded: boolean;
}
export interface IndexProfileCapability {
  profileId: string;
  dimension: number;
  modality: string;
  embeddingProtocol: string;
  modelConfigId: string | null;
  runtimeModelFingerprint?: string | null;
  configured: boolean;
  active: boolean;
  healthy: boolean;
  circuitOpen: boolean;
  protocolCompatible: boolean;
  indexCompatible: boolean;
  weight: number;
}
export type RetrievalRouteKind = 'full_text' | 'text_embedding' | 'multimodal_text' | 'multimodal_image';
export type QueryDerivationKind = 'multimodal_observation' | 'ocr';
export interface QueryDerivationProvenance { kind: QueryDerivationKind; modelConfigId?: string | null }
export interface PlannedQueryDerivation { kind: QueryDerivationKind; conditionalOnImageEmbeddingMiss: boolean }
export interface PlannedRetrievalRoute {
  routeId: string;
  kind: RetrievalRouteKind;
  profileId: string | null;
  modelConfigId: string | null;
  expectedModelFingerprint?: string | null;
  dimension: number | null;
  modality: string;
  weight: number;
  fetchLimit: number;
  queryDerivation?: QueryDerivationProvenance | null;
}
export interface RetrievalPlan {
  queryModality: QueryModality;
  topK: number;
  routes: PlannedRetrievalRoute[];
  imageFallbackChain: PlannedQueryDerivation[];
  imageFallbackUnavailableReason?: string | null;
}
export interface MediaTimeRange { startMs: number; endMs: number }
export interface RetrievalIdentity { resourceId: string; chunkIndex: number; pageIndex: number | null; timeRange?: MediaTimeRange | null }
export interface RetrievalHit {
  identity: RetrievalIdentity;
  embeddingId: string;
  text: string;
  title: string | null;
  resourceType: string | null;
  sourceId: string | null;
  folderId: string | null;
  blobHash: string | null;
  imageUrl: string | null;
  rawScore: number | null;
  metadata: unknown;
}
export interface RetrievalRouteResult { route: PlannedRetrievalRoute; hits: RetrievalHit[]; elapsedMs: number }
export interface RetrievalRouteFailure {
  routeId: string; profileId: string | null; dimension: number | null;
  error: string; timedOut: boolean; queryDerivation?: QueryDerivationProvenance | null;
}
export interface RetrievalHitProvenance {
  routeId: string; routeKind: RetrievalRouteKind; profileId: string | null; dimension: number | null;
  modality: string; rawRank: number; rawScore: number | null; routeWeight: number; rrfContribution: number;
  queryDerivation?: QueryDerivationProvenance | null;
}
export interface FusedRetrievalHit {
  hit: RetrievalHit; rrfScore: number; normalizedScore?: number | null; rerankScore?: number | null;
  provenance: RetrievalHitProvenance[];
}
export interface FusedRetrievalResult { hits: FusedRetrievalHit[]; failures: RetrievalRouteFailure[] }
export interface UnifiedRetrievalRequest {
  queryText: string | null; queryImageBase64: string | null; queryImageMediaType: string | null;
  queryModality: QueryModality; topK: number; folderIds: string[] | null;
  resourceIds: string[] | null; resourceTypes: string[] | null;
}
export interface QueryDerivationAttempt {
  provenance: QueryDerivationProvenance; succeeded: boolean; derivedQuery?: string | null;
  error?: string | null; elapsedMs: number;
}
export interface UnifiedRetrievalResponse {
  capabilitySnapshot: CapabilitySnapshot; plan: RetrievalPlan; result: FusedRetrievalResult;
  queryDerivations: QueryDerivationAttempt[];
}

// Internal Lance records retain the Rust field names; serialized API types above use serde names.
export interface VfsLanceRow {
  embedding_id: string; resource_id: string; unit_id: string; resource_type: string;
  folder_id: string | null; chunk_index: number; text: string; metadata_json: string | null;
  created_at: string; index_profile_id: string; generation: number | bigint; embedding: number[];
}
export interface VfsLanceSearchResult {
  embedding_id: string; resource_id: string; unit_id: string; resource_type: string;
  folder_id: string | null; chunk_index: number; text: string; score: number;
  metadata_json: string | null; index_profile_id: string;
  /** Internal i64 stays exact (`bigint` when F7 returns it); never an IPC field. */
  generation: number | bigint;
  page_index: number | null; source_id: string | null;
}
export interface VfsLanceStore {
  ensureModelProfile(modality: string, dim: number, modelConfigId: string,
    modelName?: string | null): import('./repository/embedding-dim.ts').VfsIndexProfile;
  ensureModelProfileWithFingerprint(modality: string, dim: number, modelConfigId: string,
    modelName: string | null | undefined, expectedFingerprint: string):
    import('./repository/embedding-dim.ts').VfsIndexProfile;
  nextUnitGeneration(unitId: string, modality: string): number | bigint;  writeChunks(modality: string, rows: readonly VfsLanceRow[]): Promise<void>;
  ensureTable(modality: string, dim: number): Promise<import('./src/lance-store.ts').LanceTable>;
  deleteByUnitExceptIds(modality: string, resourceId: string, unitId: string,
    keepEmbeddingIds: readonly string[]): Promise<number>;
  discardUncommittedRows(modality: string, resourceId: string,
    embeddingIds: readonly string[]): Promise<void>;
  deleteByResource(modality: string, resourceId: string): Promise<number>;
  deleteByResourceExceptDim(modality: string, resourceId: string, keepDim: number): Promise<number>;
  deleteByResourceExceptIds(modality: string, resourceId: string,
    keepIds: readonly string[]): Promise<number>;
  vectorSearch(modality: string, queryEmbedding: readonly number[], topK: number,
    folderIds: readonly string[] | null, resourceTypes: readonly string[] | null):
    Promise<VfsLanceSearchResult[]>;
  hybridSearch(modality: string, queryText: string, queryEmbedding: readonly number[],
    topK: number, folderIds: readonly string[] | null, resourceTypes: readonly string[] | null):
    Promise<VfsLanceSearchResult[]>;
  vectorSearchFull(modality: string, queryEmbedding: readonly number[], topK: number,
    folderIds: readonly string[] | null, resourceIds: readonly string[] | null,
    resourceTypes: readonly string[] | null): Promise<VfsLanceSearchResult[]>;
  hybridSearchFull(modality: string, queryText: string, queryEmbedding: readonly number[],
    topK: number, folderIds: readonly string[] | null, resourceIds: readonly string[] | null,
    resourceTypes: readonly string[] | null): Promise<VfsLanceSearchResult[]>;
  deleteByEmbeddingIds(modality: string, embeddingIds: readonly string[]): Promise<number>;
  /** Compatibility overload from the initial interface publication; Rust scans all dimensions. */
  deleteByEmbeddingIds(modality: string, dim: number, embeddingIds: readonly string[]): Promise<number>;
  ensureProfileReady(profileId: string): Promise<void>;
  vectorSearchProfileFull(profileId: string, queryEmbedding: readonly number[], topK: number,
    folderIds: readonly string[] | null, resourceIds: readonly string[] | null,
    resourceTypes: readonly string[] | null, mountedResourceIds?: readonly string[] | null): Promise<VfsLanceSearchResult[]>;
  ftsSearchProfileFull(profileId: string, queryText: string, topK: number,
    folderIds: readonly string[] | null, resourceIds: readonly string[] | null,
    resourceTypes: readonly string[] | null, mountedResourceIds?: readonly string[] | null): Promise<VfsLanceSearchResult[]>;
  optimizeTable(modality: string, dim: number): Promise<void>;
  optimizeAll(modality: string): Promise<number>;
  maybeOptimizeAll(): Promise<number>;
  getTableStats(modality: string): Promise<Array<[string, number]>>;
  diagnoseTableSchema(modality: string):
    Promise<import('./src/lance-store.ts').LanceTableDiagnostic[]>;
  dropTable(tableName: string): Promise<void>;
  sweepRetiredProfileTables(): Promise<number>;
  clearAll(modality: string): Promise<number>;
}
export type ProcessingStage = 'pending' | 'text_extraction' | 'page_rendering' | 'page_compression'
  | 'image_compression' | 'ocr_processing' | 'vector_indexing' | 'completed' | 'completed_with_issues'
  | 'error' | 'queued' | 'decode' | 'vad' | 'asr' | 'indexing';
export interface ProcessingStatus {
  fileId: string; stage: string; progress: ProcessingProgressSnapshot;
  error?: string | null; startedAt?: number | bigint | null; completedAt?: number | bigint | null;
}
export {
  processingStageAsString, processingStageFromString, compareProcessingStages,
  defaultProcessingProgress, hasRetriableFailure,
} from './src/pdf-processing.ts';
export interface PdfProcessingService {
  startPipeline(fileId: string, startFromStage?: ProcessingStage | null): Promise<void>;
  mediaTempDir(): string;
  cancelMedia(fileId: string): boolean;
  getStatus(fileId: string): ProcessingStatus | null;
  cancel(fileId: string): boolean;
  retry(fileId: string): Promise<void>;
  isRunning(fileId: string): boolean;
  runningCount(): number;
  recoverStuckTasks(): string[];
  backfillMissingPreviews(): number;
}
export interface VfsIndexingApi {
  getIndexingConfig(): IndexingConfig;
  getChunkingConfig(): ChunkingConfig;
  getSearchConfig(): SearchConfig;
  indexResource(resourceId: string, folderId?: string | null,
    progress?: EmbeddingProgressCallback | null): Promise<[number, number]>;
  getPendingResources(): string[];
  markResourcePending(resourceId: string): void;
  markResourceFailed(resourceId: string, error: string): void;
  recoverStuckIndexing(): number;
  checkNeedsReindex(resourceId: string): boolean;
  deleteResourceIndex(resourceId: string): Promise<void>;
  reindexResource(resourceId: string, folderId?: string | null,
    progress?: EmbeddingProgressCallback | null): Promise<[number, number]>;
  indexQuestion(questionId: string, examId: string): Promise<[number, number]>;
  indexExamQuestions(examId: string): Promise<[number, number]>;
  processPendingBatch(batchSize: number): Promise<[number, number]>;
  prepareUnitsWithoutEmbedding(limit: number): number;
  drainLanceOrphanQueue(limit: number): Promise<number>;
}
export interface VfsSearchApi {
  searchFts(query: string, topK: number): VfsSearchResult[];
  getEmbeddingStats(): VfsEmbeddingStats;
}
export interface VfsFullSearchApi {
  vectorSearch(query: string, params: VfsSearchParams): Promise<VfsSearchResult[]>;
  hybridSearch(query: string, params: VfsSearchParams): Promise<VfsSearchResult[]>;
  search(query: string, params: VfsSearchParams, enableReranking: boolean): Promise<VfsSearchResult[]>;
  searchWithEmbedding(query: string, queryEmbedding: readonly number[],
    params: VfsSearchParams, enableReranking: boolean): Promise<VfsSearchResult[]>;
  searchWithResourceInfo(query: string, params: VfsSearchParams,
    enableReranking: boolean): Promise<VfsSearchResult[]>;
  crossDimensionSearch(query: string, params: VfsSearchParams): Promise<VfsSearchResult[]>;
  searchCrossDimension(query: string, params: VfsSearchParams,
    rerank: boolean, enableReranking: boolean): Promise<VfsSearchResult[]>;
  searchCrossDimensionWithResourceInfo(query: string, params: VfsSearchParams,
    enableReranking: boolean): Promise<VfsSearchResult[]>;
  generateQueryEmbedding(query: string): Promise<number[]>;
  getLanceStats(modality: string): Promise<Array<[string, number]>>;
  optimizeLanceTables(modality: string): Promise<number>;
}
export interface VfsMultimodalApi {
  isConfigured(): Promise<boolean>;
  search(query: string, topK: number, folderIds?: readonly string[] | null,
    resourceTypes?: readonly string[] | null): Promise<import('./src/multimodal.ts').VfsMultimodalSearchResult[]>;
  searchFull(query: string, topK: number, folderIds?: readonly string[] | null,
    resourceIds?: readonly string[] | null, resourceTypes?: readonly string[] | null):
    Promise<import('./src/multimodal.ts').VfsMultimodalSearchResult[]>;
  deleteResourceIndex(resourceId: string): Promise<void>;
  indexResourcePages(resourceId: string, resourceType: string, folderId: string | null,
    pages: readonly import('./src/multimodal.ts').VfsMultimodalPage[]):
    Promise<import('./src/multimodal.ts').VfsMultimodalIndexResult>;
  indexResourceBySource(sourceType: string, sourceId: string, folderId: string | null):
    Promise<import('./src/multimodal.ts').VfsMultimodalIndexResult>;
  getStats(): Promise<import('./src/multimodal.ts').VfsMultimodalStats>;
  /** `multimodal_service.rs::process_pending_batch` (mm/both batch indexing). */
  processPendingBatch(limit: number): Promise<[number, number]>;
}
/** `index_service.rs::StateStats` (camelCase wire). */
export interface VfsIndexStateStats {
  pending: number;
  indexing: number;
  indexed: number;
  failed: number;
  disabled: number;
}
/** `index_service.rs::DimensionStat` (camelCase wire). */
export interface VfsIndexDimensionStat {
  dimension: number;
  modality: string;
  count: number;
}
/** `index_service.rs::IndexStatusSummary` (camelCase wire). */
export interface VfsIndexStatusSummary {
  totalUnits: number;
  textStats: VfsIndexStateStats;
  mmStats: VfsIndexStateStats;
  dimensions: VfsIndexDimensionStat[];
}
/**
 * L18 media transcription capability consumed by the shared PDF/media task
 * scheduler. Mirrors `vfs/hooks.rs::MediaTranscriber` +
 * `MediaTranscriptionRequest/Summary`; provider naming is `mediaTranscriber`.
 */
export interface MediaTranscriptionProgressUpdate {
  stage: string;
  percent: number;
  completedSegments?: number | null;
  totalSegments?: number | null;
}
export interface MediaTranscriptionRequest {
  fileId: string;
  tempDir: string;
  /** `false` only for imported subtitles, which skip ASR configuration. */
  imported: boolean;
  signal: AbortSignal;
  onProgress(update: MediaTranscriptionProgressUpdate): void;
}
export interface MediaTranscriptionResult {
  transcriptChars: number;
  doneSegments: number;
  totalSegments: number;
  failedSegments: number;
}
export interface MediaTranscriberService {
  transcribe(request: MediaTranscriptionRequest): Promise<MediaTranscriptionResult>;
}
export interface VfsIndexService {
  lance: VfsLanceStore;
  pdf: PdfProcessingService;
  indexing: VfsIndexingApi;
  search: VfsSearchApi;
  fullSearch?: VfsFullSearchApi;
  multimodal: VfsMultimodalApi;
  /**
   * `index_service.rs::get_status_summary` via L11 owner repositories.
   * Optional so consumer test doubles from other lanes stay valid; production
   * `vfsIndex` always provides it.
   */
  getStatusSummary?(): VfsIndexStatusSummary;
  /** Legacy `kb_chunks_v2_d*` store (Rust `LanceVectorStore` KB slice). */
  legacyKb?: LegacyKbStoreApi;
}
export interface LegacyKbStoreApi {
  getLancePath(): string;
  addDocumentRecordWithLibrary(
    documentId: string,
    fileName: string,
    filePath: string | null,
    fileSize: number | null,
    subLibraryId: string,
  ): void;
  addChunks(chunks: ReadonlyArray<{
    chunk: {
      id: string;
      document_id: string;
      chunk_index: number;
      text: string;
      metadata: Readonly<Record<string, unknown>>;
    };
    embedding: readonly number[];
  }>): Promise<void>;
  clearAll(): Promise<void>;
}
/**
 * L02 `ApiConfig` fields that define the vector space. The full object is
 * returned by `llmEmbeddingModels.getEmbeddingModelConfig()`; optional fields
 * keep test doubles and legacy callers source-compatible.
 */
export interface EmbeddingModelConfig {
  id: string;
  model: string;
  baseUrl?: string | null;
  providerType?: string | null;
  providerScope?: string | null;
  apiProtocol?: string | null;
  modelAdapter?: string | null;
}
/** Minimal L02/L11 dependency surface, pending their api.ts publication. */
export interface EmbeddingRuntime {
  getEmbeddingModelConfig(): Promise<EmbeddingModelConfig>;
  callEmbeddingApi(texts: string[], modelId: string): Promise<number[][]>;
  modelFingerprintForConfig(config: EmbeddingModelConfig, modality: string): string;
}
export type EmbeddingProgressCallback = (processed: number, total: number) => void;
export interface ChunkWithEmbedding { chunk: TextChunk; embedding: number[] }
export interface EmbeddingResult {
  chunks: ChunkWithEmbedding[]; embedding_dim: number; model_config_id: string;
  model_name: string; model_fingerprint: string; modality: string;
}
export interface IndexChunksResult {
  count: number; dim: number; embedding_ids: string[]; model_config_id: string | null;
  index_profile_id: string | null; generation: number | bigint | null;
}
export interface EmbeddingPipelineStore {
  ensureModelProfileWithFingerprint(modality: string, dim: number, modelConfigId: string,
    modelName: string | null, expectedFingerprint: string): { id: string };
  nextUnitGeneration(unitId: string, modality: string): number | bigint;
  writeChunks(modality: string, rows: readonly VfsLanceRow[]): Promise<void>;
  deleteByResource(modality: string, resourceId: string): Promise<number>;
}
export { VfsEmbeddingService, VfsEmbeddingPipeline, chunksToLanceRows } from './src/embedding.ts';
export { containedBlobPath, containedBlobPathAsync, type BlobConfine, type BlobRealpath } from './src/blob-path.ts';
export interface RetrievalService {
  search(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse>;
  searchMultimodal(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse>;
  retrieve(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse>;
  inspectCapabilities(): Promise<CapabilitySnapshot>;
}
/**
 * `RetrievalService.search`/`searchMultimodal` with the caller's cancellation. A signal aborted
 * before the call starts no retrieval; an abort during the call settles at once with an
 * `AbortError` and discards the result. Routes already in flight still run to completion
 * (each bounded by its route timeout) and record their circuit outcome.
 */
export interface CancellableRetrievalService {
  search(request: UnifiedRetrievalRequest, signal: AbortSignal | null): Promise<UnifiedRetrievalResponse>;
  searchMultimodal(request: UnifiedRetrievalRequest, signal: AbortSignal | null): Promise<UnifiedRetrievalResponse>;
}
export interface ChunkingConfig { strategy: string; chunkSize: number; chunkOverlap: number; minChunkSize: number }
export interface IndexingConfig { enabled: boolean; batchSize: number; intervalSecs: number; maxConcurrent: number; retryDelaySecs: number; maxRetries: number }
export interface SearchConfig { defaultTopK: number; enableHybrid: boolean; enableReranking: boolean }
export interface TextChunk { index: number; text: string; start_pos: number; end_pos: number; page_index: number | null; source_id: string | null }
export interface PageText { page_index: number; text: string; source_id: string | null }
export type IndexableResourceType = 'note' | 'translation' | 'exam' | 'textbook' | 'essay' | 'file' | 'mindmap' | 'insight_card' | 'image' | 'retrieval';
export interface VfsSearchParams { query: string; folderIds?: string[] | null; resourceIds?: string[] | null; resourceTypes?: string[] | null; modality: string; topK: number }
export interface VfsSearchResult {
  embeddingId: string; resourceId: string; chunkIndex: number; chunkText: string; score: number;
  resourceTitle?: string | null; resourceType?: string | null; pageIndex?: number | null; sourceId?: string | null;
}
export interface VfsDimensionStat { dimension: number; modality: string; recordCount: number; tableName: string }
export interface VfsEmbeddingStats { totalEmbeddings: number; totalResourcesIndexed: number; dimensions: VfsDimensionStat[] }
export type VfsSearchMode = 'vector' | 'full_text' | 'hybrid';
export {
  defaultChunkingConfig, defaultIndexingConfig, defaultSearchConfig, chunkText, chunkTextWithPages,
  isTextQualityAcceptable, extractIndexableContent, extractIndexablePages, extractMindmapText,
} from './src/indexing.ts';
export {
  MAX_SCORED_DOC_CHARS, defaultBm25Options, isCjkChar, tokenize,
  bm25Idf, bm25Idf as idf, bm25Scores, type Bm25Options,
} from './src/lexical-bm25.ts';
export {
  availableCapability, unavailableCapability, runtimeAvailable, embeddingAvailable, capabilityAvailable,
  planGeneration, planRetrieval, planDerivedTextRoutes, normalizeRouteFamilyWeights,
  fuseRouteResults, fuseRouteResultsPooled, applyMaxPerResource, applyMmrDiversity,
} from './src/retrieval-planner.ts';
declare module '@deepseek-ai/cordis' {
  interface Context {
    vfsIndex: VfsIndexService;
    retrieval: RetrievalService;
    retrievalCancellable: CancellableRetrievalService;
    lanceEngine: LanceEngineService;
    vfsIndexMaintenance: VfsIndexMaintenanceService;
    /** Optional L18 provider; resolved on every call by the media task runner. */
    mediaTranscriber: MediaTranscriberService;
  }
}
