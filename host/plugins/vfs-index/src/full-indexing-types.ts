/** Collaborator seams of `VfsFullIndexingService` (`indexing.rs`): Lance store, events, unit sync and OCR recovery. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ChunkingConfig, VfsLanceRow } from '../api.ts';
import type { LaneLogger } from './logger.ts';
import type { VfsResourceRecord } from '../repository/index-units.ts';
import type { VfsEmbeddingPipeline } from './embedding.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
import type { VfsService } from '../../vfs/api.ts';

export interface IndexEventSink {
  emit(channel: string, payload: unknown): void;
}

export interface IndexingLanceStore {
  nextUnitGeneration(unitId: string, modality: string): number | bigint;
  ensureModelProfileWithFingerprint(
    modality: string, dim: number, modelConfigId: string,
    modelName: string | null, expectedFingerprint: string,
  ): { id: string };
  writeChunks(modality: string, rows: readonly VfsLanceRow[]): Promise<void>;
  deleteByResource(modality: string, resourceId: string): Promise<number>;
  deleteByEmbeddingIds(modality: string, ids: readonly string[]): Promise<number>;
  deleteByUnitExceptIds?(
    modality: string, resourceId: string, unitId: string, keepIds: readonly string[],
  ): Promise<unknown>;
  discardUncommittedRows?(
    modality: string, resourceId: string, embeddingIds: readonly string[],
  ): Promise<unknown>;
  sweepRetiredProfileTables?(): Promise<number>;
  getTableStats?(modality: string): Promise<Array<[string, number]>>;
  optimizeAll?(modality: string): Promise<number>;
}

export interface OcrRecovery {
  recover(
    resource: VfsResourceRecord,
    emit: (event: Record<string, unknown>) => void,
  ): Promise<string | null>;
}

export interface IndexUnitSync {
  syncResourceUnits(resourceId: string): number | void;
  /** Legacy-PDF page re-extraction needs the async F7 pdfium API. */
  syncResourceUnitsAsync?(resourceId: string): Promise<number | void>;
}

export interface VfsFullIndexingDeps {
  readonly db: SqlExecutor;
  readonly pipeline: VfsEmbeddingPipeline;
  readonly lanceStore: IndexingLanceStore;
  /** Existing native-provider lifecycle, corresponding to Rust VECTOR_INDEX_AVAILABLE. */
  readonly vectorIndexAvailable?: () => boolean;
  readonly chunkingConfig?: ChunkingConfig;
  readonly events?: IndexEventSink;
  readonly unitSync?: IndexUnitSync;
  readonly ocrRecovery?: OcrRecovery;
  /** L11 `vfsRepo`.questions; required only for `indexQuestion`. */
  readonly questionRepo?: QuestionRepository;
  readonly mediaIndex?: () => Pick<VfsService['mediaIndex'], 'unitTimeRanges' | 'rangeForUnit' | 'segmentMetadataJson'>;
  /** Cordis logger (`ctx.logger('vfs-index')`); diagnostics only. */
  readonly logger?: LaneLogger;
}
