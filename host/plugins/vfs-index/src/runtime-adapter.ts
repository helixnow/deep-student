/**
 * Adapters for services published by other lanes.
 *
 * L02 publishes model selection/routing (`llm`, `llmEmbeddingModels`,
 * `llmOcrModels`, `llmOcrHedge`, `llmStreaming`); L12 consumes those directly.
 * The actual embedding transport (`embedding@1`), rerank provider (`llmReranker`)
 * and F7 `nativePdfium` are optional and resolved on every call, so provider
 * load order and provider replacement never leave a cached `undefined`.
 * When a capability is absent, the affected route reports an explicit failure
 * while lexical retrieval keeps working.
 */
import * as path from '../../../platform/util/path.ts';
import { fromBase64 } from '../../../platform/crypto/encoding.ts';
import { FileError, type FilesService } from '../../../platform/files/api.ts';
import type { Context } from '../../../kernel/api.ts';
import type { ImageQualityService, StorageService } from '../../../platform/storage/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import {
  defaultSingleShotOptions, type ApiConfig, type LLMManager, type LlmEmbeddingModels,
  type LlmOcrHedge, type LlmOcrModels, type LlmOcrPages, type LlmReranker, type LlmStreamingService,
} from '../../llm/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { VfsService } from '../../vfs/api.ts';
import type { VfsLanceStore } from '../api.ts';
import {
  VfsUnifiedRetriever, type RetrievalRuntime,
} from './retrieval-service.ts';
import type { MultimodalInput as MultimodalInputValue } from './multimodal.ts';
import type {
  OcrEngineType, OcrRuntimeCandidate, RetrievalApiConfig,
} from './unified-retriever.ts';
import type { PdfIndexRunner, PdfOcrConfig, PdfOcrProvider } from './pdf-runtime.ts';
import { defaultPdfOcrConfig, NativePdfStageRuntime } from './pdf-runtime.ts';
import type { MediaTranscriberService } from '../../media/api.ts';

/** Minimal embedding surface expected from L02 (`embedding@1`). */
export interface EmbeddingCapability {
  callEmbeddingApi(texts: string[], modelId: string): Promise<number[][]>;
  callMultimodalEmbeddingApi?(inputs: MultimodalInputValue[], modelId: string): Promise<number[][]>;
}

function dataUrlOf(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

function base64Bytes(base64: string): Uint8Array {
  return fromBase64(base64);
}

/** `LLMManager` surface needed for raw multimodal observation. */
function observationBody(config: ApiConfig, prompt: string,
  image: { mime: string; base64: string }): Record<string, unknown> {
  return {
    model: config.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrlOf(image.mime, image.base64) } },
      ],
    }],
    stream: false,
    temperature: config.temperature,
    max_tokens: config.maxTokensLimit !== null && config.maxTokensLimit > 0
      ? Math.min(config.maxOutputTokens > 0 ? config.maxOutputTokens : 8192, config.maxTokensLimit)
      : config.maxOutputTokens > 0 ? config.maxOutputTokens : 8192,
  };
}

/**
 * Free-text OCR through L02's multi-engine hedge. Rust `call_ocr_page_with_fallback`
 * and `call_ocr_model_raw_prompt` both resolve the same enabled OCR candidates;
 * `llmOcrHedge` owns the engine race and circuit breaker.
 */
async function runFreeTextOcr(ctx: Context, mime: string, base64: string,
  signal?: AbortSignal): Promise<string> {
  const models = optionalService<LlmOcrModels>(ctx, 'llmOcrModels');
  const hedge = optionalService<LlmOcrHedge>(ctx, 'llmOcrHedge');
  if (models === undefined || hedge === undefined) {
    throw new Error('L02 OCR services are not available');
  }
  const candidates = await models.getFreeTextOcrCandidatesByPriority();
  const prepared = await hedge.prepareCandidates(
    dataUrlOf(mime, base64), candidates, base64Bytes(base64),
  );
  return hedge.runPrepared(prepared, signal);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function optionalService<T>(ctx: Context, key: string): T | undefined {
  return ctx.get(key) as T | undefined;
}

/**
 * `ctx.files` 只在真正读写文件字节时取，不放进 `inject`：只装置检索/命令层的
 * 最小宿主（别的 lane 的测试）没有 files，也应能启动。
 */
export function fileService(ctx: Context): FilesService {
  const service = ctx.reflect.get('files', false) as FilesService | undefined;
  if (service === undefined) throw new Error('待接线：files（ctx.files 文件服务）');
  return service;
}

export function createRetrievalRuntime(ctx: Context): RetrievalRuntime {
  // Resolve per call: provider plugins may load or be replaced after L12 apply.
  const llm = (): LLMManager | undefined => optionalService<LLMManager>(ctx, 'llm');
  const embedding = (): EmbeddingCapability | undefined => optionalService<EmbeddingCapability>(ctx, 'embedding@1');
  const ocrModels = (): LlmOcrModels | undefined => optionalService<LlmOcrModels>(ctx, 'llmOcrModels');

  return {
    async getApiConfigs(): Promise<RetrievalApiConfig[]> {
      const manager = llm();
      if (manager === undefined) return [];
      const configs = await manager.getApiConfigs();
      return configs.map((config) => ({
        id: config.id,
        model: config.model,
        enabled: config.enabled,
        isEmbedding: config.isEmbedding,
        isMultimodal: config.isMultimodal,
        isReranker: config.isReranker,
        isImageGeneration: config.isImageGeneration,
        baseUrl: config.baseUrl,
        providerType: config.providerType,
        providerScope: config.providerScope,
        apiProtocol: config.apiProtocol,
        modelAdapter: config.modelAdapter,
      }));
    },
    async getStructuredOcrCandidates() {
      const service = ocrModels();
      if (service === undefined) return [];
      return service.getOcrConfigsByPriority('Structured');
    },
    async getFreeTextOcrCandidates() {
      const service = ocrModels();
      if (service === undefined) return [];
      const candidates = await service.getFreeTextOcrCandidatesByPriority();
      return candidates.map((candidate): OcrRuntimeCandidate => candidate.kind === 'systemOcr'
        ? { kind: 'system_ocr' }
        : {
          kind: 'remote',
          config: candidate.config as unknown as RetrievalApiConfig,
          engineType: candidate.engineType,
        });
    },
    async callEmbeddingApi(texts: string[], modelId: string): Promise<number[][]> {
      const service = embedding();
      if (service === undefined) {
        throw new Error('embedding@1 service is not available');
      }
      return service.callEmbeddingApi(texts, modelId);
    },
    async callMultimodalEmbeddingApi(inputs: MultimodalInputValue[], modelId: string): Promise<number[][]> {
      const service = embedding();
      if (service?.callMultimodalEmbeddingApi === undefined) {
        throw new Error('embedding@1 service does not expose multimodal embedding');
      }
      return service.callMultimodalEmbeddingApi(inputs, modelId);
    },
    async observeImage(configId, prompt, image): Promise<string> {
      const manager = llm();
      const streaming = optionalService<LlmStreamingService>(ctx, 'llmStreaming');
      if (manager === undefined || streaming === undefined) {
        throw new Error('L02 LLM services are not available');
      }
      const configs = await manager.getApiConfigs();
      const config = configs.find((candidate) => candidate.id === configId
        || candidate.model === configId);
      if (config === undefined) {
        throw new Error(`找不到指定的多模态模型配置: ${configId}`);
      }
      if (!config.enabled) {
        throw new Error(`指定的多模态模型已禁用: ${configId}`);
      }
      if (!config.isMultimodal || config.isEmbedding || config.isReranker
        || config.isImageGeneration) {
        throw new Error(`指定配置不是可用于视觉理解的多模态语言模型: ${configId}`);
      }
      const apiKey = await manager.decryptApiKey(config.apiKey);
      const result = await streaming.singleShotCompletion(
        config,
        observationBody(config, prompt, image) as import('../../../platform/errors/api.ts').JsonValue,
        apiKey,
        null,
        'VFS 多模态查询观察失败',
        defaultSingleShotOptions('VFS 多模态查询观察'),
      );
      return result.content;
    },
    async ocrImage(image): Promise<string> {
      return runFreeTextOcr(ctx, image.mime, image.base64);
    },
  };
}

/** Free-text OCR provider for the L12 PDF/image stage runtime. */
export function createPdfOcrProvider(ctx: Context): PdfOcrProvider {
  return {
    async recognizeFile(imagePath): Promise<string> {
      const pages = optionalService<LlmOcrPages>(ctx, 'llmOcrPages');
      if (pages === undefined) throw new Error('L02 llmOcrPages service is not available');
      return pages.callOcrFreeTextWithFallback(imagePath);
    },
    async available(): Promise<boolean> {
      const models = optionalService<LlmOcrModels>(ctx, 'llmOcrModels');
      const hedge = optionalService<LlmOcrHedge>(ctx, 'llmOcrHedge');
      if (models === undefined || hedge === undefined) return false;
      try {
        return await models.inspectFreeTextOcrAvailable();
      } catch {
        // A settings/config read failure means the OCR chain cannot be built.
        return false;
      }
    },
    async recognize(dataUrl, imageBytes, signal): Promise<string> {
      const models = optionalService<LlmOcrModels>(ctx, 'llmOcrModels');
      const hedge = optionalService<LlmOcrHedge>(ctx, 'llmOcrHedge');
      if (models === undefined || hedge === undefined) {
        throw new Error('L02 OCR services are not available');
      }
      // The data URL and original bytes are both needed: remote engines receive
      // the URL and system OCR receives the decoded image.
      const candidates = await models.getFreeTextOcrCandidatesByPriority();
      const prepared = await hedge.prepareCandidates(dataUrl, candidates, imageBytes);
      return hedge.runPrepared(prepared, signal);
    },
  };
}

/** `VfsLanceStore::resolve_lance_base`: `<vfs db dir>/lance/vfs`（目录由连接时经 `ctx.files` 创建）。 */
export function resolveVfsLanceBase(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'lance', 'vfs');
}

/**
 * `ctx.files.scope(blobsDir)` 的真实路径包含判断：命中返回 true（目标不存在也算，
 * 没有东西能把它引到别处），符号链接越界返回 false。
 */
export function blobConfine(files: () => FilesService, blobsDir: string) {
  return async (relativePath: string): Promise<boolean> => {
    const scope = files().scope(blobsDir);
    try {
      await scope.stat(relativePath);
      return true;
    } catch (error) {
      return error instanceof FileError && error.kind === 'NotFound';
    }
  };
}

export function createRetrievalService(
  ctx: Context,
  storage: StorageService,
  lanceStore: VfsLanceStore | null,
): VfsUnifiedRetriever {
  const db = storage.database('vfs');
  const blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
  return new VfsUnifiedRetriever({
    db,
    blobsDir,
    // RUST-FIX(RF-W04-blob-relative-path-escape): hit image paths must not escape vfs_blobs through a symlink.
    blobConfine: blobConfine(() => fileService(ctx), blobsDir),
    lanceStore,
    runtime: createRetrievalRuntime(ctx),
    logger: ctx.logger('vfs-index'),
    attachMediaTimeRanges(hits) {
      if (hits.length === 0) return;
      const vfs = optionalService<VfsService>(ctx, 'vfs');
      if (vfs === undefined) {
        ctx.logger('vfs-index').debug('[MediaIndex] time range enrichment skipped: L13 vfs service is not available');
        return;
      }
      vfs.mediaIndex.attachMediaTimeRanges(vfs.database, hits, ctx.logger('vfs-index'));
    },
  });
}

/** `OcrStrategyConfig::load_from_db` (pdf_processing_service.rs:343). */
export function pdfOcrConfig(ctx: Context): PdfOcrConfig {
  const config = defaultPdfOcrConfig();
  const settings = optionalService<SettingsStore>(ctx, 'settings');
  if (settings === undefined) return config;
  const setting = (key: string): string | null => {
    try { return settings.get(key); }
    catch { return null; }
  };
  const enabled = setting('ocr.enabled');
  if (enabled !== null) config.enabled = enabled.toLowerCase() === 'true';
  const threshold = setting('ocr.pdf_text_threshold');
  if (threshold !== null && /^\+?\d+$/.test(threshold)) {
    const parsed = BigInt(threshold);
    if (parsed <= 18446744073709551615n) {
      config.pdfTextThreshold = parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : parsed;
    }
  }
  const images = setting('ocr.images');
  if (images !== null) config.ocrImages = images.toLowerCase() === 'true';
  const scanned = setting('ocr.scanned_pdf');
  if (scanned !== null) config.ocrScannedPdf = scanned.toLowerCase() === 'true';
  return config;
}

/**
 * Native PDF/image stage runtime. Every provider is resolved lazily so L02/F7
 * plugins that load after L12 are picked up; the caller supplies the full
 * indexer through a closure because it is constructed from the same runtime.
 */
export function createPdfRuntime(
  ctx: Context,
  storage: StorageService,
  getIndexer: () => PdfIndexRunner | undefined,
): NativePdfStageRuntime {
  const db = storage.database('vfs');
  return new NativePdfStageRuntime({
    db,
    blobsDir: path.join(storage.locations.activeDir, 'vfs_blobs'),
    appDataDir: storage.locations.activeDir,
    files: () => fileService(ctx),
    logger: ctx.logger('vfs-index'),
    pdfium: () => optionalService<NativePdfium>(ctx, 'nativePdfium'),
    nativeImage: () => optionalService<NativeImage>(ctx, 'nativeImage'),
    imageQuality: () => optionalService<ImageQualityService>(ctx, 'imageQuality'),
    repositories: () => optionalService<VfsReposService>(ctx, 'vfsRepo'),
    ocr: () => createPdfOcrProvider(ctx),
    indexing: getIndexer,
    transcriber: () => optionalService<MediaTranscriberService>(ctx, 'mediaTranscriber'),
    ocrConfig: () => pdfOcrConfig(ctx),
    async chatModelIsMultimodal(): Promise<boolean> {
      const manager = optionalService<LLMManager>(ctx, 'llm');
      if (manager === undefined) return false;
      try {
        return (await manager.getModel2Config()).isMultimodal;
      } catch {
        return false;
      }
    },
  });
}


// ---------------------------------------------------------------- indexing

import type { EmbeddingRuntime } from '../api.ts';
import {
  VfsFullIndexingService, VfsFullSearchService, VfsSearchService,
  type IndexingLanceStore,
} from './index-service.ts';
import { VfsEmbeddingPipeline } from './embedding.ts';
import {
  VfsMultimodalService, type MultimodalEmbeddingCapability, type MultimodalModelConfig,
} from './multimodal-service.ts';
import { modelFingerprintForConfig } from './unified-retriever.ts';
import { VfsOcrRecovery } from './ocr-recovery.ts';

/**
 * L02 surface for embedding model selection + calls.
 *
 * `llmEmbeddingModels.getEmbeddingModelConfig()` owns the settings/assignment
 * priority, usable-model filtering and fallback chain; the returned full
 * `ApiConfig` is what the vector-space fingerprint hashes.
 */
function embeddingRuntime(ctx: Context): EmbeddingRuntime {
  return {
    async getEmbeddingModelConfig() {
      const models = optionalService<LlmEmbeddingModels>(ctx, 'llmEmbeddingModels');
      if (models === undefined) {
        throw new Error('L02 llmEmbeddingModels service is not available');
      }
      return models.getEmbeddingModelConfig();
    },
    async callEmbeddingApi(texts: string[], modelId: string): Promise<number[][]> {
      const embedding = optionalService<EmbeddingCapability>(ctx, 'embedding@1');
      if (embedding === undefined) {
        throw new Error('embedding@1 service is not available');
      }
      return embedding.callEmbeddingApi(texts, modelId);
    },
    modelFingerprintForConfig(config, modality) {
      return modelFingerprintForConfig({
        ...config,
        enabled: true,
        isEmbedding: true,
        isMultimodal: modality !== 'text',
      }, modality);
    },
  };
}

/**
 * L02 multimodal embedding transport (`embedding@1`) plus the frozen model
 * configuration used to derive the vector-space fingerprint.
 */
function createMultimodalEmbeddingCapability(ctx: Context): MultimodalEmbeddingCapability {
  return {
    async isConfigured(): Promise<boolean> {
      const models = optionalService<LlmEmbeddingModels>(ctx, 'llmEmbeddingModels');
      if (models === undefined) return false;
      try {
        await models.getVlEmbeddingModelConfig();
        return true;
      } catch {
        return false;
      }
    },
    async getModelConfig(): Promise<MultimodalModelConfig> {
      const models = optionalService<LlmEmbeddingModels>(ctx, 'llmEmbeddingModels');
      if (models === undefined) {
        throw new Error('L02 llmEmbeddingModels service is not available');
      }
      const config = await models.getVlEmbeddingModelConfig();
      return {
        id: config.id,
        model: config.model,
        baseUrl: config.baseUrl,
        providerType: config.providerType,
        providerScope: config.providerScope,
        apiProtocol: config.apiProtocol,
        modelAdapter: config.modelAdapter,
      };
    },
    async embed(inputs, modelId): Promise<number[][]> {
      const embedding = optionalService<EmbeddingCapability>(ctx, 'embedding@1');
      if (embedding?.callMultimodalEmbeddingApi === undefined) {
        throw new Error('embedding@1 service is not available');
      }
      return embedding.callMultimodalEmbeddingApi([...inputs], modelId);
    },
  };
}

/** L02 AppError rejections are `{ message }` objects, not `Error`s (Rust `Display` is the message). */
function appErrorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return String(error);
}

/** indexing.rs:4914 `rerank_results` over the L02 `llmReranker` service. */
export function createRerankRuntime(ctx: Context): import('./search-service.ts').RerankRuntime {
  return {
    async rerank(query, results) {
      const manager = optionalService<LLMManager>(ctx, 'llm');
      if (manager === undefined) throw new Error('L02 llm service is not available');
      let modelConfigId: string | null | undefined;
      try { modelConfigId = (await manager.getModelAssignments()).reranker_model_config_id; }
      catch (error) { throw new Error(`获取模型分配失败: ${appErrorMessage(error)}`); }
      // Rust `rerank_results`: no assignment is a debug-level skip, not a failure.
      if (modelConfigId === null || modelConfigId === undefined) return [...results];
      const reranker = optionalService<LlmReranker>(ctx, 'llmReranker');
      if (reranker === undefined) {
        throw new Error('L02 rerank service (llmReranker) is not available');
      }
      let reranked: Awaited<ReturnType<LlmReranker['callRerankerApi']>>;
      try {
        reranked = await reranker.callRerankerApi(query, results.map(r => ({
          chunk: { id: r.embeddingId, document_id: r.resourceId, chunk_index: r.chunkIndex, text: r.chunkText, metadata: {} },
          score: Math.fround(r.score),
        })), modelConfigId);
      } catch (error) { throw new Error(`重排序失败: ${appErrorMessage(error)}`); }
      return reranked.flatMap((rc) => {
        const original = results.find(r => r.embeddingId === rc.chunk.id);
        return original === undefined ? [] : [{ ...original, score: rc.score }];
      });
    },
  };
}

export interface VfsIndexRuntimeServices {
  indexing: VfsFullIndexingService;
  search: VfsSearchService;
  fullSearch: VfsFullSearchService;
  multimodal: VfsMultimodalService;
  recoverStuckIndexing(): number;
}

/** Unit owner service consumed by the background indexer (`indexing.rs::sync_resource_to_units`). */
export interface IndexingUnitSync {
  syncResourceUnitsForResource(resourceId: string): unknown[];
  syncResourceUnitsForResourceAsync(resourceId: string): Promise<unknown[]>;
}

export function createIndexingServices(
  ctx: Context,
  storage: StorageService,
  lanceStore: IndexingLanceStore & VfsLanceStore,
  retriever: VfsUnifiedRetriever,
  unitSync?: IndexingUnitSync,
  vectorIndexAvailable?: () => boolean,
): VfsIndexRuntimeServices {
  const db = storage.database('vfs');
  const logger = ctx.logger('vfs-index');
  const pipeline = new VfsEmbeddingPipeline(embeddingRuntime(ctx), lanceStore, logger);
  const repos = optionalService<VfsReposService>(ctx, 'vfsRepo');
  const blobsDir = path.join(storage.locations.activeDir, 'vfs_blobs');
  const ocrProvider = createPdfOcrProvider(ctx);
  const readBytes = (file: string): Promise<Uint8Array> => fileService(ctx).readBytes(file);
  const ocrRecovery = new VfsOcrRecovery({
    db,
    blobsDir,
    provider: ocrProvider,
    readBytes,
    repositories: () => optionalService<VfsReposService>(ctx, 'vfsRepo'),
    logger,
    events: ctx.backendEvents,
  });
  const indexing = new VfsFullIndexingService({
    db,
    pipeline,
    lanceStore,
    vectorIndexAvailable,
    events: ctx.backendEvents,
    ocrRecovery,
    questionRepo: repos?.questions,
    mediaIndex: () => {
      const vfs = optionalService<VfsService>(ctx, 'vfs');
      if (vfs === undefined) throw new Error('L13 vfs mediaIndex service is not available');
      return vfs.mediaIndex;
    },
    logger,
    ...(unitSync !== undefined
      ? {
        unitSync: {
          syncResourceUnits: (resourceId: string) =>
            unitSync.syncResourceUnitsForResource(resourceId).length,
          syncResourceUnitsAsync: (resourceId: string) =>
            unitSync.syncResourceUnitsForResourceAsync(resourceId).then((units) => units.length),
        },
      }
      : {}),
  });
  const search = new VfsSearchService(db);
  const multimodal = new VfsMultimodalService({
    db,
    blobsDir,
    backend: retriever,
    lanceStore,
    embedding: createMultimodalEmbeddingCapability(ctx),
    readBytes,
    repositories: () => optionalService<VfsReposService>(ctx, 'vfsRepo'),
    logger,
    events: ctx.backendEvents,
  });
  const fullSearch = new VfsFullSearchService({
    db,
    backend: retriever,
    rerank: createRerankRuntime(ctx),
    embedding: pipeline.embeddingService(),
    logger,
    lanceStats: {
      getTableStats: (modality) => {
        if (lanceStore.getTableStats === undefined) {
          return Promise.reject(new Error('Lance table statistics are unavailable'));
        }
        return lanceStore.getTableStats(modality);
      },
      optimizeAll: (modality) => {
        if (lanceStore.optimizeAll === undefined) {
          return Promise.reject(new Error('Lance optimization is unavailable'));
        }
        return lanceStore.optimizeAll(modality);
      },
    },
  });
  return {
    indexing,
    search,
    fullSearch,
    multimodal,
    recoverStuckIndexing: () => VfsFullIndexingService.recoverStuckIndexing(db),
  };
}
