/**
 * SQLite lexical search services.
 *
 * `VfsSearchService` / `VfsFullSearchService` from
 * `crates/dstu-vfs/src/vfs/indexing.rs`: FTS rows, cross-dimension search,
 * RRF/rerank post-processing and resource enrichment. Vector routes live in
 * `retrieval-service.ts`.
 */
import { nanoid } from 'nanoid';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import type { ChunkingConfig, EmbeddingProgressCallback, IndexingConfig, PageText, SearchConfig, TextChunk, VfsEmbeddingStats } from '../api.ts';
import {
  chunkText, chunkTextWithPages, defaultChunkingConfig, extractIndexableContent,
  extractIndexablePages, normalizeCompatibilityRrfScore, searchExecutionBackend,
} from './indexing.ts';
import type { LaneLogger } from './logger.ts';
import { listAll } from '../repository/embedding-dim.ts';
import {
  INDEX_STATE_INDEXED, INDEX_STATE_INDEXING, INDEX_STATE_PENDING,
  claimPendingResources, getBool, getConfig, getI32, getIndexState, getPendingResources,
  markFailed, markIndexed, markIndexing, markPending, markDisabledWithReason,
  refreshCountsFromSegments, setIndexState,
  type IndexState,
} from '../repository/index-state.ts';
import {
  clearTextIndexRowsForResource, contentHashChanged, getExamIdForResource,
  getExamPreviewJson, getFileExtractedTextById, getFileExtractedTextByResource,
  getFileExtractedTextForRecovery, getFileOcrPagesById, getFileOcrPagesByResource,
  getResourceOcrValue, getTextbookFileColumns, getTextbookPageColumns, getUnitIdAt,
  hasLegacyUnpagedPdf, hasMediaTranscript, incrementEmbeddingDimCountRow,
  insertIndexingUnitRow, insertPlaceholderSegmentRow, listOrphanQueueEntries,
  listPrepareCandidates, markUnitIndexedRow, recoverStuckIndexingRows,
  updateOrphanRetry, updateResourceOcrTextIfEmpty,
} from '../repository/index-content.ts';
import {
  MODALITY_MULTIMODAL, MODALITY_TEXT,
  ensurePrimaryUnit, getFullResource, getNoteFolderId, getNoteRecord,
  getPendingTextUnits, getResourceOcrText, getUnitsByResource,
  markTextUnitsFailedWithoutDim, markTextUnitsState, markUnitTextIndexed,
  purgeIndexArtifactsByResource, registerAndIncrementEmbeddingDim,
  replaceSegmentsByUnitAndModality, searchFtsRows, setUnitIndexProfile, setUnitTextState,
  embeddingStats,
  type CreateSegmentInput, type VfsIndexUnit, type VfsResourceRecord,
} from '../repository/index-units.ts';
import { deleteLanceOrphan } from '../repository/index-segment.ts';
import { getResource, isSourceSoftDeleted, sourceDisplayTitle } from '../repository/retrieval.ts';
import type { VfsEmbeddingPipeline } from './embedding.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
import { getIndexingConfig, messageOf } from './indexing-content.ts';
export interface DimensionStat {
  dimension: number;
  modality: string;
  record_count: number;
  table_name: string;
}

/** `VfsSearchService` (SQLite lexical stats; vector search is profile-aware elsewhere). */
export class VfsSearchService {
  private readonly db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.db = db;
  }

  searchFts(query: string, topK: number): import('../api.ts').VfsSearchResult[] {
    return searchFtsRows(this.db, query, topK).map((row) => ({
      embeddingId: row.embeddingId,
      resourceId: row.resourceId,
      chunkIndex: row.chunkIndex,
      chunkText: row.chunkText,
      score: 1.0,
      resourceTitle: null,
      resourceType: null,
      pageIndex: null,
      sourceId: null,
    }));
  }

  getEmbeddingStats(): VfsEmbeddingStats {
    const { totalEmbeddings, totalResourcesIndexed } = embeddingStats(this.db);
    return {
      totalEmbeddings,
      totalResourcesIndexed,
      dimensions: listAll(this.db).map((dim) => ({
        dimension: dim.dimension,
        modality: dim.modality,
        recordCount: dim.record_count,
        tableName: dim.lance_table_name,
      })),
    };
  }
}

export { defaultChunkingConfig };

// ---------------------------------------------------------------- full search

export interface UnifiedSearchBackend {
  search(request: import('../api.ts').UnifiedRetrievalRequest): Promise<import('../api.ts').UnifiedRetrievalResponse>;
  searchMultimodal(request: import('../api.ts').UnifiedRetrievalRequest): Promise<import('../api.ts').UnifiedRetrievalResponse>;
}

export interface RerankRuntime {
  rerank(query: string, results: readonly import('../api.ts').VfsSearchResult[]):
    Promise<import('../api.ts').VfsSearchResult[]>;
}

export interface EmbeddingQueryRuntime {
  generateEmbedding(text: string): Promise<number[]>;
}

export interface FullSearchDeps {
  readonly db: SqlExecutor;
  readonly backend: UnifiedSearchBackend;
  readonly rerank?: RerankRuntime;
  readonly embedding?: EmbeddingQueryRuntime;
  readonly lanceStats?: {
    getTableStats(modality: string): Promise<Array<[string, number]>>;
    optimizeAll(modality: string): Promise<number>;
  };
  readonly logger?: LaneLogger;
}

/**
 * `VfsFullSearchService`: compatibility wrappers over the unified profile
 * planner. Raw cross-space scores are never compared; only normalized RRF is
 * exposed.
 */
export class VfsFullSearchService {
  private readonly db: SqlExecutor;
  private readonly backend: UnifiedSearchBackend;
  private readonly rerankRuntime: RerankRuntime | undefined;
  private readonly embeddingRuntime: EmbeddingQueryRuntime | undefined;
  private readonly lanceStats: FullSearchDeps['lanceStats'];
  private readonly logger: LaneLogger | undefined;

  constructor(deps: FullSearchDeps) {
    this.db = deps.db;
    this.backend = deps.backend;
    this.rerankRuntime = deps.rerank;
    this.embeddingRuntime = deps.embedding;
    this.lanceStats = deps.lanceStats;
    this.logger = deps.logger;
  }

  async vectorSearch(query: string, params: import('../api.ts').VfsSearchParams): Promise<import('../api.ts').VfsSearchResult[]> {
    return this.crossDimensionSearch(query, params);
  }

  async hybridSearch(query: string, params: import('../api.ts').VfsSearchParams): Promise<import('../api.ts').VfsSearchResult[]> {
    return this.crossDimensionSearch(query, params);
  }

  async search(
    query: string,
    params: import('../api.ts').VfsSearchParams,
    enableReranking: boolean,
  ): Promise<import('../api.ts').VfsSearchResult[]> {
    return this.searchCrossDimension(query, params, true, enableReranking);
  }

  async searchWithEmbedding(
    query: string,
    _queryEmbedding: readonly number[],
    params: import('../api.ts').VfsSearchParams,
    enableReranking: boolean,
  ): Promise<import('../api.ts').VfsSearchResult[]> {
    return this.searchCrossDimension(query, params, true, enableReranking);
  }

  async generateQueryEmbedding(query: string): Promise<number[]> {
    if (this.embeddingRuntime === undefined) {
      throw new Error('VfsFullSearchService.generateQueryEmbedding requires L02 embedding@1');
    }
    return this.embeddingRuntime.generateEmbedding(query);
  }

  async searchWithResourceInfo(
    query: string,
    params: import('../api.ts').VfsSearchParams,
    enableReranking: boolean,
  ): Promise<import('../api.ts').VfsSearchResult[]> {
    const results = await this.searchCrossDimension(query, params, true, enableReranking);
    return enrichAndFilterResults(this.db, results, this.logger);
  }

  async getLanceStats(modality: string): Promise<Array<[string, number]>> {
    if (this.lanceStats === undefined) throw new Error('Lance engine service is not available');
    return this.lanceStats.getTableStats(modality);
  }

  async optimizeLanceTables(modality: string): Promise<number> {
    if (this.lanceStats === undefined) throw new Error('Lance engine service is not available');
    return this.lanceStats.optimizeAll(modality);
  }

  async crossDimensionSearch(
    query: string,
    params: import('../api.ts').VfsSearchParams,
  ): Promise<import('../api.ts').VfsSearchResult[]> {
    const request: import('../api.ts').UnifiedRetrievalRequest = {
      queryText: query,
      queryImageBase64: null,
      queryImageMediaType: null,
      queryModality: 'text',
      topK: params.topK,
      folderIds: params.folderIds ?? null,
      resourceIds: params.resourceIds ?? null,
      resourceTypes: params.resourceTypes ?? null,
    };
    const response = params.modality === 'image' || params.modality === 'multimodal'
      ? await this.backend.searchMultimodal(request)
      : await this.backend.search(request);
    const best = response.result.hits[0]?.rrfScore ?? 0;
    return response.result.hits.map((fused) => ({
      embeddingId: fused.hit.embeddingId,
      resourceId: fused.hit.identity.resourceId,
      chunkIndex: fused.hit.identity.chunkIndex,
      chunkText: fused.hit.text,
      score: normalizeCompatibilityRrfScore(fused.rrfScore, best),
      resourceTitle: fused.hit.title,
      resourceType: fused.hit.resourceType,
      pageIndex: fused.hit.identity.pageIndex,
      sourceId: fused.hit.sourceId,
    }));
  }

  async searchCrossDimension(
    query: string,
    params: import('../api.ts').VfsSearchParams,
    enableCrossDimension: boolean,
    enableReranking: boolean,
  ): Promise<import('../api.ts').VfsSearchResult[]> {
    // The legacy flag is wire-compatible only: both values select the unified
    // profile planner (Rust `search_execution_backend`).
    const backend = searchExecutionBackend(enableCrossDimension);
    let results: import('../api.ts').VfsSearchResult[];
    switch (backend) {
      case 'unified_profile_planner':
        results = await this.crossDimensionSearch(query, params);
        break;
      default: {
        const exhaustive: never = backend;
        throw new Error(`Unsupported search execution backend: ${String(exhaustive)}`);
      }
    }
    // RUST-FIX(RF-W04-rag-search-rerank-flag): Rust also gated on the stored `search.enable_reranking` (default false, no UI writes it), so `enableReranking: true` never reranked here.
    if (enableReranking && results.length > 0 && this.rerankRuntime !== undefined) {
      try {
        results = await this.rerankRuntime.rerank(query, results);
      } catch (rerankError) {
        this.logger?.warn(`[VfsFullSearchService] Reranker failed, retaining RRF order: ${messageOf(rerankError)}`);
      }
    }
    return results;
  }

  async searchCrossDimensionWithResourceInfo(
    query: string,
    params: import('../api.ts').VfsSearchParams,
    enableReranking: boolean,
  ): Promise<import('../api.ts').VfsSearchResult[]> {
    const results = await this.searchCrossDimension(query, params, true, enableReranking);
    return enrichAndFilterResults(this.db, results, this.logger);
  }
}

function enrichAndFilterResults(
  db: SqlExecutor,
  results: readonly import('../api.ts').VfsSearchResult[],
  logger?: LaneLogger,
): import('../api.ts').VfsSearchResult[] {
  const enriched: import('../api.ts').VfsSearchResult[] = [];
  for (const result of results) {
    const resource = getResource(db, result.resourceId);
    if (resource === undefined) continue;
    if (resource.sourceId !== null && isSourceSoftDeleted(db, resource.sourceId, logger)) continue;
    let metadataTitle: string | null = null;
    if (resource.metadataJson !== null) {
      try {
        const parsed = JSON.parse(resource.metadataJson) as Record<string, unknown>;
        const title = parsed['title'];
        if (typeof title === 'string' && rustTrim(title) !== '') metadataTitle = title;
      } catch (error) {
        // Rust treats malformed metadata as absent.
        logger?.warn(`[VFS::Search] Failed to parse resource metadata: ${messageOf(error)}`);
      }
    }
    const title = metadataTitle
      ?? (resource.sourceId === null ? null : sourceDisplayTitle(db, resource.sourceId))
      ?? resource.sourceId
      ?? resource.id;
    enriched.push({
      ...result,
      resourceTitle: title,
      resourceType: resource.resourceType,
      sourceId: result.sourceId ?? resource.sourceId,
    });
  }
  return enriched;
}
