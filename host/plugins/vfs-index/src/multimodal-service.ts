/**
 * `crates/dstu-vfs/src/vfs/multimodal_service.rs` service orchestration.
 *
 * The pure request/provenance/scoring helpers live in `multimodal.ts`, Lance
 * row building in `multimodal-rows.ts`, progress events in `multimodal-progress.ts`. Page
 * indexing mirrors `index_resource_pages_with_options`: durable blob
 * provenance, owner-side Unit sync, batched multimodal embeddings, Lance append
 * and the SQLite segment-ledger switch. L02 supplies the frozen VL embedding
 * configuration (`llmEmbeddingModels`) and the embedding transport
 * (`embedding@1`); both are resolved per call by the runtime adapter.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { fromBase64, toBase64 } from '../../../platform/crypto/encoding.ts';
import { JsonSyntaxError } from '../../../platform/util/portable.ts';
import { parseAttachmentPreviewJson, type AttachmentPreview } from '../../llm-providers/api.ts';
import type {
  CreateSegmentInput, EmbeddingModelConfig, VfsIndexUnit, VfsReposService,
} from '../../vfs-repos/api.ts';
import type {
  UnifiedRetrievalRequest, UnifiedRetrievalResponse, VfsLanceStore,
} from '../api.ts';
import {
  MultimodalInput,
  normalizeMultimodalRrfScore, unifiedMultimodalRequest,
  type MultimodalInput as MultimodalInputValue,
  type VfsMultimodalIndexResult, type VfsMultimodalPage,
  type VfsMultimodalSearchResult, type VfsMultimodalStats,
} from './multimodal.ts';
import {
  MODALITY_MULTIMODAL, clearMultimodalIndex, listMultimodalDimensions,
  setResourceMmState, setUnitMmStateRow, setUnitIndexProfile,
} from '../repository/index-units.ts';
import {
  getImageFileInfo, getSourcePreview, updateBusinessMmState,
} from '../repository/multimodal-source.ts';
import { getResourceType, resolveResourceFolderId } from '../repository/index-content.ts';
import { refreshCountsFromSegments } from '../repository/index-state.ts';
import { inTransaction } from './indexing-content.ts';
import type { LaneLogger } from './logger.ts';
import {
  MM_INDEX_PROGRESS_EVENT, progressEvent, type IndexProgressEvent, type ProgressSink,
} from './multimodal-progress.ts';
import { buildMultimodalLanceRows, provenance } from './multimodal-rows.ts';

export interface MultimodalSearchBackend {
  searchMultimodal(request: UnifiedRetrievalRequest): Promise<UnifiedRetrievalResponse>;
}

/** L02 VL embedding config carrying the full vector-space identity. */
export interface MultimodalModelConfig extends EmbeddingModelConfig {}

/** Minimal L02 multimodal embedding surface (config + transport). */
export interface MultimodalEmbeddingCapability {
  isConfigured(): Promise<boolean>;
  getModelConfig(): Promise<MultimodalModelConfig>;
  embed(inputs: readonly MultimodalInputValue[], modelId: string): Promise<number[][]>;
}

export interface VfsMultimodalDeps {
  readonly db: SqlExecutor;
  readonly blobsDir?: string;
  readonly backend: MultimodalSearchBackend;
  readonly lanceStore: VfsLanceStore;
  readonly embedding?: MultimodalEmbeddingCapability;
  /** L11 owner repositories; lazily resolved so plugin load order is irrelevant. */
  readonly repositories?: () => VfsReposService | undefined;
  /** `ctx.files.readBytes`：多模态页面图片字节（移动端同一套异步接口）。 */
  readonly readBytes?: (path: string) => Promise<Uint8Array>;
  /** Cordis logger (`ctx.logger('vfs-index')`); diagnostics only. */
  readonly logger?: LaneLogger;
  /** Backend events (`ctx.backendEvents`): carries `mm_index_progress`. */
  readonly events?: { emit(channel: string, payload: unknown): void };
}

export { MM_INDEX_PROGRESS_EVENT, type IndexProgressEvent };

/** Rust `InvalidState` is retryable; the by-source caller resets to pending. */
class MultimodalAssignmentChangedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultimodalAssignmentChangedError';
  }
}

interface IndexOptions {
  forceRebuild: boolean;
  refreshCounts: boolean;
}

const EMBED_READ_BATCH = 8;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function base64Payload(encoded: string): string {
  const separator = encoded.lastIndexOf(';base64,');
  return separator === -1 ? encoded : encoded.slice(separator + ';base64,'.length);
}

function imageExtension(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    default: return 'png';
  }
}

export class VfsMultimodalService {
  private readonly db: SqlExecutor;
  private readonly blobsDir: string | undefined;
  private readonly backend: MultimodalSearchBackend;
  private readonly lanceStore: VfsLanceStore;
  private readonly embedding: MultimodalEmbeddingCapability | undefined;
  private readonly repositories: (() => VfsReposService | undefined) | undefined;
  private readonly readBytes: ((path: string) => Promise<Uint8Array>) | undefined;
  private readonly logger: LaneLogger | undefined;
  private readonly events: VfsMultimodalDeps['events'];

  constructor(deps: VfsMultimodalDeps) {
    this.db = deps.db;
    this.blobsDir = deps.blobsDir;
    this.backend = deps.backend;
    this.lanceStore = deps.lanceStore;
    this.embedding = deps.embedding;
    this.repositories = deps.repositories;
    this.readBytes = deps.readBytes;
    this.logger = deps.logger;
    this.events = deps.events;
  }

  /**
   * The command-facing entry points (`indexResourcePages`, `indexResourceBySource`) are the
   * counterparts of Rust's `*_with_progress(.., Some(progress_tx))` calls in handlers.rs:6081/6420,
   * whose relay emits every event as `mm_index_progress`; emit failures are ignored (`let _ =`).
   * The background batch path passes no sink, like Rust's `None`.
   */
  private progressSink(): ProgressSink {
    const events = this.events;
    if (events === undefined) return null;
    return (event) => {
      try {
        events.emit(MM_INDEX_PROGRESS_EVENT, event);
      } catch (error) {
        this.logger?.debug(`[VfsMultimodalService] mm_index_progress emit failed: ${messageOf(error)}`);
      }
    };
  }

  async isConfigured(): Promise<boolean> {
    if (this.embedding === undefined) return false;
    return this.embedding.isConfigured();
  }

  async search(
    query: string,
    topK: number,
    folderIds: readonly string[] | null = null,
    resourceTypes: readonly string[] | null = null,
  ): Promise<VfsMultimodalSearchResult[]> {
    return this.searchFull(query, topK, folderIds, null, resourceTypes);
  }

  async searchFull(
    query: string,
    topK: number,
    folderIds: readonly string[] | null = null,
    resourceIds: readonly string[] | null = null,
    resourceTypes: readonly string[] | null = null,
  ): Promise<VfsMultimodalSearchResult[]> {
    return this.searchInputFull(
      { text: query, image: null, instruction: null, video: null },
      topK, folderIds, resourceIds, resourceTypes,
    );
  }

  async searchInputFull(
    queryInput: MultimodalInput,
    topK: number,
    folderIds: readonly string[] | null = null,
    resourceIds: readonly string[] | null = null,
    resourceTypes: readonly string[] | null = null,
  ): Promise<VfsMultimodalSearchResult[]> {
    const response = await this.backend.searchMultimodal(
      unifiedMultimodalRequest(queryInput, topK, folderIds, resourceIds, resourceTypes),
    );
    const best = response.result.hits[0]?.rrfScore ?? 0;
    return response.result.hits.map((fused) => {
      const [metadataBlobHash, unitId] = provenance(fused.hit.metadata);
      return {
        embedding_id: fused.hit.embeddingId,
        resource_id: fused.hit.identity.resourceId,
        unit_id: unitId,
        resource_type: fused.hit.resourceType ?? 'unknown',
        page_index: fused.hit.identity.pageIndex ?? fused.hit.identity.chunkIndex,
        text_content: fused.hit.text,
        blob_hash: fused.hit.blobHash ?? metadataBlobHash,
        score: normalizeMultimodalRrfScore(fused.rrfScore, best),
        folder_id: fused.hit.folderId,
      };
    });
  }

  /**
   * `multimodal_service.rs::process_pending_batch`: claim pending mm resources,
   * index each one, then refresh dimension counts once for the batch.
   */
  async processPendingBatch(limit: number): Promise<[number, number]> {
    const repos = this.requireRepositories();
    const db = this.db;
    const batchLimit = Math.min(100, Math.max(1, limit));
    const pending = repos.embeddingUnits.listPendingMm(db, batchLimit);
    const candidateIds: string[] = [];
    const seen = new Set<string>();
    for (const unit of pending) {
      if (seen.has(unit.resourceId)) continue;
      seen.add(unit.resourceId);
      candidateIds.push(unit.resourceId);
    }
    const maxRetries = repos.indexingConfig.getI32(db, 'indexing.max_retries', 3);
    const resourceIds = repos.indexStates.claimMmIndexingResources(db, candidateIds, maxRetries);
    if (resourceIds.length < candidateIds.length) {
      this.logger?.info(
        `[VfsMultimodalService] process_pending_batch: claimed ${resourceIds.length}/${candidateIds.length} resources (rest busy, backing off, or over retry limit)`,
      );
    }
    let success = 0;
    let failed = 0;
    for (const resourceId of resourceIds) {
      const resourceType = getResourceType(db, resourceId);
      const folderId = resolveResourceFolderId(db, resourceId);
      const pages: VfsMultimodalPage[] = repos.embeddingUnits.getByResource(db, resourceId)
        .filter((unit) => unit.mmRequired && unit.imageBlobHash !== null)
        .map((unit) => ({
          page_index: unit.unitIndex,
          image_base64: null,
          image_mime: unit.imageMimeType,
          // OCR/native text stays a separate unit artifact and is not sent to ME.
          text_content: null,
          blob_hash: unit.imageBlobHash,
        }));
      try {
        // Incremental rebuild: only pages whose image changed become pending;
        // batch-level count refresh happens after the loop.
        await this.indexResourcePagesWithOptions(
          resourceId, resourceType, folderId, pages,
          { forceRebuild: false, refreshCounts: false },
        );
        success += 1;
      } catch (error) {
        failed += 1;
        this.logger?.warn(
          `[VfsMultimodalService] Pending resource ${resourceId} failed: ${messageOf(error)}`,
        );
        // Most failure paths already wrote failed/pending; recover resources
        // still stuck in `indexing` from the claim.
        const state = repos.indexStates.getMmIndexState(db, resourceId);
        if (state?.state === 'indexing') {
          repos.indexStates.markMmFailed(db, resourceId, messageOf(error));
        }
      }
    }
    if (success > 0 || failed > 0) {
      try {
        repos.embeddingDims.refreshCountsFromSegments(db);
      } catch (error) {
        this.logger?.warn(
          `[VfsMultimodalService] Failed to refresh embedding_dim counts after batch: ${messageOf(error)}`,
        );
      }
    }
    return [success, failed];
  }

  async deleteResourceIndex(resourceId: string): Promise<void> {
    await this.clearResourceMultimodalIndex(resourceId);
  }

  async getStats(): Promise<VfsMultimodalStats> {
    const dims = listMultimodalDimensions(this.db);
    return {
      total_records: dims.reduce((sum, dim) => sum + dim.record_count, 0),
      dimensions: dims.map((dim) => dim.dimension),
    };
  }

  async indexResourcePages(
    resourceId: string,
    resourceType: string,
    folderId: string | null,
    pages: readonly VfsMultimodalPage[],
    forceRebuild = true,
  ): Promise<VfsMultimodalIndexResult> {
    return this.indexResourcePagesWithOptions(
      resourceId, resourceType, folderId, pages,
      { forceRebuild, refreshCounts: true },
      this.progressSink(),
    );
  }

  private async indexResourcePagesWithOptions(
    resourceId: string,
    resourceType: string,
    folderId: string | null,
    inputPages: readonly VfsMultimodalPage[],
    options: IndexOptions,
    progress: ProgressSink = null,
  ): Promise<VfsMultimodalIndexResult> {
    if (inputPages.length === 0) {
      await this.clearResourceMultimodalIndex(resourceId);
      return { indexed_pages: 0, dimension: 0, failed_pages: [] };
    }

    this.logger?.info(
      `[VfsMultimodalService] Indexing ${inputPages.length} pages for resource ${resourceId} (type=${resourceType})`,
    );

    // 1. Model configuration. OCR/TM never participate; pages go to ME directly.
    if (this.embedding === undefined) {
      throw new Error('L02 multimodal embedding service is not available');
    }
    if (!(await this.embedding.isConfigured())) {
      throw new Error(
        '还没有启用多模态索引：请在「设置 → 模型 → 模型分配 → 嵌入维度管理」中新建一个多模态维度并绑定多模态嵌入模型（已有多个时把要用的设为默认）',
      );
    }
    const repos = this.requireRepositories();
    const blobsDir = this.requireBlobsDir();

    // 2. Durable provenance: persist inline images, then validate blobs.
    const pages = inputPages.map((page) => ({ ...page }));
    const failedPages: number[] = [];
    for (const page of pages) {
      if (page.blob_hash === null) {
        if (page.image_base64 === null) {
          failedPages.push(page.page_index);
          continue;
        }
        const encoded = base64Payload(page.image_base64);
        const data = fromBase64(encoded);
        if (data.length === 0) {
          failedPages.push(page.page_index);
          continue;
        }
        const mime = page.image_mime ?? 'image/png';
        const blob = repos.blobs.storeBlob(this.db, blobsDir, data, mime, imageExtension(mime));
        page.blob_hash = blob.hash;
        page.image_base64 = null;
      }
      if (repos.blobs.getBlobPath(this.db, blobsDir, page.blob_hash) === null) {
        failedPages.push(page.page_index);
        continue;
      }
      if (page.image_mime === null) page.image_mime = 'image/png';
    }
    if (failedPages.length > 0) {
      throw new Error(`多模态页面缺少可读取的原图或 blob_hash: [${failedPages.join(', ')}]`);
    }

    // 3. One Unit per page; only the image side is owned here.
    const units = inTransaction(this.db, (tx) => repos.embeddingUnits.syncMultimodalUnits(
      tx,
      resourceId,
      pages.map((page) => ({
        resourceId,
        unitIndex: page.page_index,
        imageBlobHash: page.blob_hash,
        imageMimeType: page.image_mime,
        textContent: null,
        textSource: null,
      })),
      options.forceRebuild,
    )).units;
    if (options.refreshCounts) {
      repos.embeddingDims.refreshCountsFromSegments(this.db);
    }

    // 4. Short-circuit when every Unit already has exactly one active segment.
    const allCurrent = units.every((unit) => unit.mmState === 'indexed'
      && repos.embeddingSegments.getByUnitAndModality(
        this.db, unit.id, MODALITY_MULTIMODAL,
      ).length === 1);
    if (!options.forceRebuild && allCurrent) {
      const dimension = units[0]?.mmEmbeddingDim ?? 0;
      this.setResourceState(resourceId, 'indexed', null);
      return { indexed_pages: units.length, dimension, failed_pages: [] };
    }

    // Freeze one concrete ME configuration for the whole logical batch.
    const modelConfig = await this.embedding.getModelConfig();
    const fingerprint = repos.embeddingDims.modelFingerprintForConfig(
      modelConfig, MODALITY_MULTIMODAL,
    );

    this.setUnitsState(units, 'indexing', null);
    this.setResourceState(resourceId, 'indexing', null);

    const unitByIndex = new Map(units.map((unit) => [unit.unitIndex, unit]));

    // 5. Stream embeddings in read batches; image bytes never outlive a batch.
    // Progress relays the embedding service's per-call events (start, one batch of
    // DEFAULT_BATCH_SIZE = 8 ≥ chunk, done) with the chunk offset added (multimodal_service.rs:446-468).
    const totalPages = pages.length;
    const skippedPages = failedPages.length;
    const relay = (offset: number, completed: number, message: string): void => {
      progress?.(progressEvent(
        resourceType, resourceId, totalPages, 'embedding', message,
        Math.min(offset + completed + skippedPages, totalPages), offset + completed, skippedPages,
      ));
    };
    const embeddings: number[][] = [];
    try {
      for (let start = 0; start < pages.length; start += EMBED_READ_BATCH) {
        const chunk = pages.slice(start, start + EMBED_READ_BATCH);
        const inputs: MultimodalInputValue[] = [];
        for (const page of chunk) {
          const blobHash = page.blob_hash;
          if (blobHash === null) throw new Error(`多模态页面 ${page.page_index} 缺少 blob_hash`);
          const blobPath = repos.blobs.getBlobPath(this.db, blobsDir, blobHash);
          if (blobPath === null) {
            throw new Error(`多模态页面 ${page.page_index} 的 blob ${blobHash} 不存在`);
          }
          const data = await this.readBlobBytes(blobPath);
          if (data.length === 0) {
            throw new Error(`多模态页面 ${page.page_index} 的 blob ${blobHash} 为空`);
          }
          inputs.push(MultimodalInput.imageBase64(
            toBase64(data),
            page.image_mime ?? 'image/png',
          ));
        }
        relay(start, 0, `开始多模态嵌入: 0/${inputs.length}`);
        const chunkEmbeddings = await this.embedding.embed(inputs, modelConfig.id);
        if (chunkEmbeddings.length !== inputs.length) {
          throw new Error(
            `多模态嵌入数量不匹配: expected=${inputs.length}, actual=${chunkEmbeddings.length}`,
          );
        }
        relay(start, inputs.length, `多模态嵌入进度: ${inputs.length}/${inputs.length}`);
        relay(start, inputs.length, `多模态嵌入完成: ${inputs.length}/${inputs.length}`);
        embeddings.push(...chunkEmbeddings);
      }
    } catch (error) {
      const message = messageOf(error);
      this.setUnitsState(units, 'failed', message);
      this.setResourceState(resourceId, 'failed', message);
      throw new Error(message.startsWith('多模态嵌入生成失败') || message.startsWith('多模态页面')
        ? message : `多模态嵌入生成失败: ${message}`);
    }

    if (embeddings.length !== pages.length) {
      const message = `多模态嵌入数量不匹配: expected=${pages.length}, actual=${embeddings.length}`;
      this.setUnitsState(units, 'failed', message);
      this.setResourceState(resourceId, 'failed', message);
      throw new Error(message);
    }

    await this.ensureAssignmentUnchanged(modelConfig, fingerprint);
    const dimension = embeddings[0]?.length ?? 0;
    if (dimension === 0 || embeddings.some((embedding) => embedding.length !== dimension)) {
      const message = '多模态嵌入维度为空或批次内不一致';
      this.setUnitsState(units, 'failed', message);
      this.setResourceState(resourceId, 'failed', message);
      throw new Error(message);
    }

    // Same dimension does not imply the same vector space: activate the
    // fingerprint-specific profile before Lance writes.
    const profile = this.lanceStore.ensureModelProfileWithFingerprint(
      MODALITY_MULTIMODAL, dimension, modelConfig.id, modelConfig.model, fingerprint,
    );

    // 6. Build Lance rows with fresh per-Unit generations.
    const rows = buildMultimodalLanceRows(pages, embeddings, unitByIndex, {
      resourceId, resourceType, folderId, profileId: profile.id,
      nextGeneration: (unitId) => this.lanceStore.nextUnitGeneration(unitId, MODALITY_MULTIMODAL),
    });

    // 7. No empty window: append Lance rows first, then switch the SQLite ledger.
    try {
      await this.ensureAssignmentUnchanged(modelConfig, fingerprint);
    } catch (error) {
      this.resetPending(units, resourceId);
      throw error;
    }
    try {
      await this.lanceStore.writeChunks(MODALITY_MULTIMODAL, rows);
    } catch (error) {
      if (error instanceof MultimodalAssignmentChangedError) {
        this.resetPending(units, resourceId);
      }
      throw error;
    }

    try {
      inTransaction(this.db, (tx) => {
        for (const row of rows) {
          const unit = unitByIndex.get(row.chunk_index);
          if (unit === undefined) throw new Error(`Lance row page ${row.chunk_index} has no Unit`);
          setUnitIndexProfile(
            tx, unit.id, MODALITY_MULTIMODAL, profile.id, row.generation,
          );
          const segment: CreateSegmentInput = {
            unitId: unit.id,
            segmentIndex: 0,
            modality: MODALITY_MULTIMODAL,
            embeddingDim: dimension,
            lanceRowId: row.embedding_id,
            contentText: row.text === '' ? null : row.text,
            contentHash: unit.contentHash,
            startPos: null,
            endPos: null,
            metadataJson: row.metadata_json,
          };
          repos.embeddingSegments.replaceByUnitAndModality(
            tx, resourceId, unit.id, MODALITY_MULTIMODAL, [segment],
          );
          repos.embeddingUnits.setMmIndexed(tx, unit.id, dimension);
        }
        if (options.refreshCounts) repos.embeddingDims.refreshCountsFromSegments(tx);
      });
    } catch (error) {
      const message = `多模态 Segment 账本提交失败: ${messageOf(error)}`;
      try {
        await this.lanceStore.discardUncommittedRows(
          MODALITY_MULTIMODAL, resourceId, rows.map((row) => row.embedding_id),
        );
      } catch (cleanupError) {
        this.logger?.warn(
          `[VfsMultimodalService] Failed to reclaim uncommitted rows for ${resourceId}: ${messageOf(cleanupError)}`,
        );
      }
      this.setUnitsState(units, 'failed', message);
      this.setResourceState(resourceId, 'failed', message);
      throw new Error(message);
    }

    // New generations are active; retire old rows only after the ledger switch.
    for (const row of rows) {
      try {
        await this.lanceStore.deleteByUnitExceptIds(
          MODALITY_MULTIMODAL, resourceId, row.unit_id, [row.embedding_id],
        );
      } catch (error) {
        this.logger?.warn(
          `[VfsMultimodalService] Deferred cleanup for Unit ${row.unit_id} failed: ${messageOf(error)}`,
        );
      }
    }
    try {
      await this.lanceStore.deleteByResourceExceptDim(MODALITY_MULTIMODAL, resourceId, dimension);
    } catch (error) {
      this.logger?.warn(
        `[VfsMultimodalService] Failed to cleanup retired multimodal profiles for ${resourceId}: ${messageOf(error)}`,
      );
    }
    this.setResourceState(resourceId, 'indexed', null);

    this.logger?.info(
      `[VfsMultimodalService] Successfully indexed ${rows.length} pages for resource ${resourceId} (dim=${dimension})`,
    );
    progress?.(progressEvent(
      resourceType, resourceId, pages.length, 'saving', '正在保存索引...',
      pages.length, rows.length, failedPages.length,
    ));
    return { indexed_pages: rows.length, dimension, failed_pages: failedPages };
  }

  async indexResourceBySource(
    sourceType: string,
    sourceId: string,
    folderId: string | null,
    forceRebuild = true,
  ): Promise<VfsMultimodalIndexResult> {
    this.logger?.info(
      `[VfsMultimodalService] index_resource_by_source: type=${sourceType}, id=${sourceId}`,
    );
    const source = getSourcePreview(this.db, sourceType, sourceId);
    if (source.resourceId === null) {
      throw new Error(`Resource not found: ${sourceType}:${sourceId}`);
    }
    const resourceId = source.resourceId;

    let pages: VfsMultimodalPage[] = [];
    if (source.previewJson !== null) {
      let preview: AttachmentPreview;
      try {
        preview = parseAttachmentPreviewJson(source.previewJson);
      } catch (error) {
        // L01 retains serde's original detail/position separately from its own context.
        if (error instanceof Error && error.cause instanceof JsonSyntaxError) {
          throw new Error(`Failed to parse preview_json: ${error.cause.message}`, { cause: error.cause });
        }
        throw error;
      }
      pages = preview.pages.flatMap((page) => page.blob_hash === undefined
        ? []
        : [{
          page_index: Number(BigInt.asIntN(32, page.page_index)),
          image_base64: null,
          image_mime: page.mime_type ?? 'image/png',
          text_content: null,
          blob_hash: page.blob_hash,
        }]);
    } else if (sourceType === 'image') {
      const image = getImageFileInfo(this.db, sourceId);
      if (image !== null && image.blobHash !== null) {
        this.logger?.info(
          `[VfsMultimodalService] Image fallback: using blob_hash=${image.blobHash} for single-page index`,
        );
        pages = [{
          page_index: 0,
          image_base64: null,
          image_mime: image.mimeType ?? 'image/png',
          text_content: null,
          blob_hash: image.blobHash,
        }];
      } else {
        this.logger?.warn(
          `[VfsMultimodalService] Image ${sourceId} has no blob_hash, cannot index`,
        );
      }
    } else {
      this.logger?.warn(
        `[VfsMultimodalService] Resource ${sourceId} has no preview_json in business table`,
      );
    }

    const progress = this.progressSink();
    progress?.(progressEvent(sourceType, sourceId, pages.length, 'preparing', '准备多模态索引...', 0, 0, 0));

    if (pages.length === 0) {
      this.logger?.warn(
        `[VfsMultimodalService] No pages found for resource ${sourceId} (type=${sourceType})`,
      );
      await this.clearResourceMultimodalIndex(resourceId);
      updateBusinessMmState(this.db, sourceType, sourceId, 'disabled', null, 0, 0, this.requireRepositories());
      progress?.(progressEvent(sourceType, sourceId, 0, 'completed', '无可索引内容', 0, 0, 0));
      return { indexed_pages: 0, dimension: 0, failed_pages: [] };
    }

    updateBusinessMmState(this.db, sourceType, sourceId, 'indexing', null, 0, 0, this.requireRepositories());
    try {
      // Inner page events are keyed by the VFS resource id, as in Rust.
      const result = await this.indexResourcePagesWithOptions(
        resourceId, sourceType, folderId, pages,
        { forceRebuild, refreshCounts: true },
        progress,
      );
      const indexedPagesJson = result.indexed_pages > 0
        ? JSON.stringify(pages
          .filter((page) => !result.failed_pages.includes(page.page_index))
          .map((page) => ({
            page_index: page.page_index,
            blob_hash: page.blob_hash,
            embedding_dim: result.dimension,
            indexing_mode: 'vl_embedding',
            indexed_at: new Date().toISOString(),
          })))
        : null;
      updateBusinessMmState(
        this.db, sourceType, sourceId, 'indexed', indexedPagesJson,
        result.dimension, result.indexed_pages, this.requireRepositories(),
      );
      progress?.(progressEvent(
        sourceType, sourceId, pages.length, 'completed', `索引完成: ${result.indexed_pages} 页`,
        pages.length, result.indexed_pages, result.failed_pages.length,
      ));
      return result;
    } catch (error) {
      const retryable = error instanceof MultimodalAssignmentChangedError;
      const message = messageOf(error);
      updateBusinessMmState(
        this.db, sourceType, sourceId,
        retryable ? 'pending' : 'failed',
        retryable ? null : message,
        0,
        0,
        this.requireRepositories(),
      );
      progress?.(progressEvent(sourceType, sourceId, pages.length, retryable ? 'pending' : 'failed', message, 0, 0, 0));
      throw error;
    }
  }

  // ---------------------------------------------------------------- helpers

  private requireRepositories(): VfsReposService {
    const repos = this.repositories?.();
    if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
    return repos;
  }

  private requireBlobsDir(): string {
    if (this.blobsDir === undefined) throw new Error('VFS blob directory is not configured');
    return this.blobsDir;
  }

  private readBlobBytes(path: string): Promise<Uint8Array> {
    if (this.readBytes === undefined) throw new Error('待接线：files（ctx.files 文件服务）');
    return this.readBytes(path);
  }

  private async ensureAssignmentUnchanged(
    config: MultimodalModelConfig,
    fingerprint: string,
  ): Promise<void> {
    if (this.embedding === undefined) throw new Error('L02 multimodal embedding service is not available');
    let current: MultimodalModelConfig;
    try {
      current = await this.embedding.getModelConfig();
    } catch (error) {
      throw new MultimodalAssignmentChangedError(
        `Multimodal embedding assignment became unavailable while a batch was running: ${messageOf(error)}`,
      );
    }
    const repos = this.requireRepositories();
    const currentFingerprint = repos.embeddingDims.modelFingerprintForConfig(
      current, MODALITY_MULTIMODAL,
    );
    if (current.id !== config.id || current.model !== config.model
      || currentFingerprint !== fingerprint) {
      throw new MultimodalAssignmentChangedError(
        `Multimodal embedding assignment changed while the batch was running: ${config.id}/${config.model} -> ${current.id}/${current.model}`,
      );
    }
  }

  private resetPending(units: readonly VfsIndexUnit[], resourceId: string): void {
    this.setUnitsState(units, 'pending', null);
    this.setResourceState(resourceId, 'pending', null);
  }

  private setUnitsState(
    units: readonly VfsIndexUnit[],
    state: 'pending' | 'indexing' | 'indexed' | 'failed',
    error: string | null,
  ): void {
    const repos = this.repositories?.();
    for (const unit of units) {
      if (repos !== undefined) {
        if (state === 'indexed') repos.embeddingUnits.setMmIndexed(this.db, unit.id, unit.mmEmbeddingDim ?? 0);
        else repos.embeddingUnits.setMmState(this.db, unit.id, state, error);
        continue;
      }
      setUnitMmStateRow(this.db, unit.id, state, error, Date.now());
    }
  }

  private setResourceState(resourceId: string, state: string, error: string | null): void {
    const repos = this.repositories?.();
    if (repos !== undefined) {
      if (state === 'failed') {
        repos.indexStates.markMmFailed(this.db, resourceId, error ?? 'multimodal indexing failed');
      } else {
        repos.indexStates.setMmIndexState(this.db, resourceId, state, error);
      }
      return;
    }
    setResourceMmState(this.db, resourceId, state, error);
  }

  private async clearResourceMultimodalIndex(resourceId: string): Promise<void> {
    const repos = this.repositories?.();
    inTransaction(this.db, (tx) => {
      if (repos !== undefined) {
        repos.embeddingUnits.clearMultimodalIndex(tx, resourceId);
        repos.embeddingDims.refreshCountsFromSegments(tx);
      } else {
        clearMultimodalIndex(tx, resourceId);
        refreshCountsFromSegments(tx);
      }
    });
    try {
      await this.lanceStore.deleteByResource(MODALITY_MULTIMODAL, resourceId);
    } catch (error) {
      this.logger?.warn(
        `[VfsMultimodalService] Direct Lance cleanup failed for ${resourceId}: ${messageOf(error)}; queued for retry`,
      );
    }
    this.setResourceState(resourceId, 'disabled', null);
  }
}
