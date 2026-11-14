/**
 * Indexing services from `crates/dstu-vfs/src/vfs/indexing.rs`.
 *
 * The implementation is split by responsibility:
 * - `indexing-content.ts`: configuration reads, content/page resolution, OCR page parsing;
 * - `full-indexing.ts`: `VfsFullIndexingService` (embedding + Lance orchestration);
 * - `search-service.ts`: `VfsSearchService` / `VfsFullSearchService`;
 * - this file: the deprecated SQLite-only `VfsIndexingService` and the public re-exports.
 */
import { nanoid } from 'nanoid';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ChunkingConfig, IndexingConfig, SearchConfig } from '../api.ts';
import { chunkText } from './indexing.ts';
import {
  checkNeedsReindex, getChunkingConfig, getIndexingConfig, getSearchConfig, inTransaction,
  messageOf, resolveIndexableContent,
} from './indexing-content.ts';
import {
  INDEX_STATE_INDEXED, INDEX_STATE_INDEXING, getIndexState, getPendingResources, markFailed, markPending,
  setIndexState,
} from '../repository/index-state.ts';
import {
  getUnitIdAt, incrementEmbeddingDimCountRow, insertIndexingUnitRow,
  insertPlaceholderSegmentRow, markUnitIndexedRow,
} from '../repository/index-content.ts';
import {
  MODALITY_TEXT, getFullResource, purgeIndexArtifactsByResource,
  registerAndIncrementEmbeddingDim,
} from '../repository/index-units.ts';

export * from './indexing-content.ts';
export * from './full-indexing.ts';
export * from './search-service.ts';

export class VfsIndexingService {
  private readonly db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.db = db;
  }

  getIndexingConfig(): IndexingConfig {
    return getIndexingConfig(this.db);
  }

  getChunkingConfig(): ChunkingConfig {
    return getChunkingConfig(this.db);
  }

  getSearchConfig(): SearchConfig {
    return getSearchConfig(this.db);
  }

  /**
   * Deprecated Rust `VfsIndexingService::index_resource`: SQLite metadata only.
   * It intentionally uses `placeholder_no_lance_*` row ids.
   */
  indexResource(resourceId: string, embeddingDim: number): number {
    const db = this.db;
    const resource = getFullResource(db, resourceId);
    if (resource === undefined) {
      throw new Error(`Resource not found: ${resourceId}`);
    }
    const content = resolveIndexableContent(db, resource);
    if (content === null || content === '') {
      setIndexState(db, resourceId, INDEX_STATE_INDEXED, resource.hash, null);
      return 0;
    }
    const chunks = chunkText(content, this.getChunkingConfig());
    if (chunks.length === 0) {
      setIndexState(db, resourceId, INDEX_STATE_INDEXED, resource.hash, null);
      return 0;
    }
    try {
      return inTransaction(db, (tx) => {
        setIndexState(tx, resourceId, INDEX_STATE_INDEXING, null, null);
        purgeIndexArtifactsByResource(tx, resourceId);
        registerAndIncrementEmbeddingDim(tx, embeddingDim, MODALITY_TEXT, 0);
        const now = Date.now();
        const existingUnitId = getUnitIdAt(tx, resourceId, 0);
        let unitId: string;
        if (existingUnitId !== null) {
          unitId = existingUnitId;
        } else {
          unitId = `unit_${nanoid(10)}`;
          insertIndexingUnitRow(tx, unitId, resourceId, now);
        }
        for (const chunk of chunks) {
          insertPlaceholderSegmentRow(tx, {
            id: `seg_${nanoid(10)}`,
            unitId,
            segmentIndex: chunk.index,
            modality: MODALITY_TEXT,
            embeddingDim,
            lanceRowId: `placeholder_no_lance_${nanoid(10)}`,
            contentText: chunk.text,
            startPos: chunk.start_pos,
            endPos: chunk.end_pos,
          }, now);
        }
        markUnitIndexedRow(tx, unitId, now, chunks.length, embeddingDim);
        incrementEmbeddingDimCountRow(tx, embeddingDim, MODALITY_TEXT, chunks.length, now);
        setIndexState(tx, resourceId, INDEX_STATE_INDEXED, resource.hash, null);
        return chunks.length;
      });
    } catch (error) {
      // Rust `mark_failed(...)?`: a marker failure replaces the original error.
      markFailed(this.db, resourceId, messageOf(error));
      throw error;
    }
  }

  getPendingResources(): string[] {
    const config = this.getIndexingConfig();
    return getPendingResources(this.db, config.batchSize, config.maxRetries);
  }

  markResourcePending(resourceId: string): void {
    markPending(this.db, resourceId);
  }

  markResourceFailed(resourceId: string, error: string): void {
    markFailed(this.db, resourceId, error);
  }

  checkNeedsReindex(resourceId: string): boolean {
    return checkNeedsReindex(this.db, resourceId);
  }
}
