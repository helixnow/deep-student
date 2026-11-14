/**
 * Full embedding/Lance indexing service.
 *
 * `VfsFullIndexingService` from `crates/dstu-vfs/src/vfs/indexing.rs`: unit
 * preparation, text/question indexing, retries and deferred cleanup. Pure
 * content resolution lives in `indexing-content.ts`; SQL lives in `repository/`.
 *
 * L11 has not published `index_unit_repo` / `index_service` in
 * `vfs-repos/api.ts`; unit syncing and OCR are injected. When those services are
 * absent the full indexer still indexes the primary content unit and reports
 * the missing capability instead of fabricating results.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import type { ChunkingConfig, EmbeddingProgressCallback, IndexingConfig, SearchConfig, TextChunk } from '../api.ts';
import { chunkText, chunkTextWithPages, shouldDisableIndexForMissingNote } from './indexing.ts';
import type { LaneLogger } from './logger.ts';
import { isInvalidState, other } from './lance-types.ts';
import {
  INDEX_STATE_INDEXED, claimPendingResources, getPendingResources,
  markFailed, markIndexed, markIndexing, markPending, markDisabledWithReason,
  refreshCountsFromSegments, setIndexState,
} from '../repository/index-state.ts';
import {
  clearTextIndexRowsForResource, contentHashChanged, getFileExtractedTextForRecovery,
  hasLegacyUnpagedPdf, hasMediaTranscript, listOrphanQueueEntries,
  listPrepareCandidates, recoverStuckIndexingRows, updateOrphanRetry,
} from '../repository/index-content.ts';
import {
  MODALITY_MULTIMODAL, MODALITY_TEXT,
  ensurePrimaryUnit, getFullResource, getNoteFolderId, getNoteRecord, getUnitsByResource,
  markTextUnitsFailedWithoutDim, markTextUnitsState, markUnitTextIndexed,
  purgeIndexArtifactsByResource, registerAndIncrementEmbeddingDim,
  replaceSegmentsByUnitAndModality, setUnitIndexProfile, setUnitTextState,
  type CreateSegmentInput,
} from '../repository/index-units.ts';
import { deleteLanceOrphan } from '../repository/index-segment.ts';
import type { VfsEmbeddingPipeline } from './embedding.ts';
import type { QuestionRepository } from '../../vfs-repos/api.ts';
import {
  checkNeedsReindex, emptyContentReason, getIndexingConfig, getSearchConfig, PDF_TEXT_THRESHOLD,
  TRANSCRIPT_TEXT_SOURCE, getChunkingConfig, hasValidText, inTransaction, messageOf,
  requirePendingUnits, resolveIndexableContent, resolveIndexablePages,
} from './indexing-content.ts';
import type {
  IndexEventSink, IndexingLanceStore, IndexUnitSync, OcrRecovery, VfsFullIndexingDeps,
} from './full-indexing-types.ts';
import * as questions from './question-indexing.ts';
export type {
  IndexEventSink, IndexingLanceStore, IndexUnitSync, OcrRecovery, VfsFullIndexingDeps,
} from './full-indexing-types.ts';

export class UnsupportedIndexResourceTypeError extends Error {
  readonly param = 'resource_type';
  constructor() {
    super('Invalid argument \'resource_type\': unsupported for indexing');
    this.name = 'UnsupportedIndexResourceTypeError';
  }
}

export class VfsFullIndexingService {
  private readonly db: SqlExecutor;
  private readonly pipeline: VfsEmbeddingPipeline;
  private readonly lanceStore: IndexingLanceStore;
  private readonly vectorIndexAvailable: () => boolean;
  private readonly chunkingConfig: ChunkingConfig;
  private readonly events: IndexEventSink | undefined;
  private readonly unitSync: IndexUnitSync | undefined;
  private readonly ocrRecovery: OcrRecovery | undefined;
  private readonly questionRepo: QuestionRepository | undefined;
  private readonly mediaIndex: VfsFullIndexingDeps['mediaIndex'];
  private readonly logger: LaneLogger | undefined;
  private readonly attemptedWithoutEmbedding = new Set<string>();

  constructor(deps: VfsFullIndexingDeps) {
    this.db = deps.db;
    this.pipeline = deps.pipeline;
    this.lanceStore = deps.lanceStore;
    this.vectorIndexAvailable = deps.vectorIndexAvailable ?? (() => true);
    this.chunkingConfig = deps.chunkingConfig ?? getChunkingConfig(deps.db);
    this.events = deps.events;
    this.unitSync = deps.unitSync;
    this.ocrRecovery = deps.ocrRecovery;
    this.questionRepo = deps.questionRepo;
    this.mediaIndex = deps.mediaIndex;
    this.logger = deps.logger;
  }

  /** Recover `indexing` rows left behind by a crash. */
  static recoverStuckIndexing(db: SqlExecutor): number {
    return recoverStuckIndexingRows(db, Date.now());
  }

  syncResourceToUnits(resourceId: string): void {
    if (this.unitSync === undefined) return;
    try {
      const units = this.unitSync.syncResourceUnits(resourceId);
      if (typeof units === 'number') {
        this.logger?.debug(`[VfsFullIndexingService] Synced ${units} units for resource ${resourceId}`);
      }
    } catch (error) {
      this.handleUnitSyncError(resourceId, error);
    }
  }

  private async syncResourceToUnitsAsync(resourceId: string): Promise<void> {
    if (this.unitSync === undefined) return;
    try {
      const units = this.unitSync.syncResourceUnitsAsync === undefined
        ? this.unitSync.syncResourceUnits(resourceId)
        : await this.unitSync.syncResourceUnitsAsync(resourceId);
      if (typeof units === 'number') {
        this.logger?.debug(`[VfsFullIndexingService] Synced ${units} units for resource ${resourceId}`);
      }
    } catch (error) {
      this.handleUnitSyncError(resourceId, error);
    }
  }

  private handleUnitSyncError(resourceId: string, error: unknown): void {
    if (error instanceof UnsupportedIndexResourceTypeError
      || (error instanceof Error && /Invalid argument 'resource_type'/.test(error.message))) {
      markDisabledWithReason(this.db, resourceId, '该类型不建立检索索引');
      throw new UnsupportedIndexResourceTypeError();
    }
    // Rust warns and lets legacy indexing continue for non-type errors.
    this.logger?.warn(
      `[VfsFullIndexingService] Failed to sync units for resource ${resourceId}: ${messageOf(error)}`,
    );
  }

  async indexResource(
    resourceId: string,
    folderId: string | null = null,
    progress: EmbeddingProgressCallback | null = null,
  ): Promise<[number, number]> {
    return this.indexResourceWithOptions(resourceId, folderId, progress, true);
  }

  private async indexResourceWithOptions(
    resourceId: string,
    folderId: string | null,
    progress: EmbeddingProgressCallback | null,
    refreshCounts: boolean,
    vectorAvailable = this.vectorIndexAvailable(),
  ): Promise<[number, number]> {
    const db = this.db;
    const existingUnits = getUnitsByResource(db, resourceId);
    const hasValidUnits = existingUnits.some(
      (unit) => unit.textContent !== null || unit.imageBlobHash !== null,
    );
    const contentChanged = contentHashChanged(db, resourceId);
    const hasPendingTextUnit = existingUnits.some(
      (unit) => unit.textRequired && unit.textState === 'pending',
    );
    const legacyUnpagedPdf = hasLegacyUnpagedPdf(db, resourceId);
    const hasTranscriptUnits = existingUnits.some(
      (unit) => unit.textSource === TRANSCRIPT_TEXT_SOURCE,
    );
    let mediaTranscript = hasTranscriptUnits;
    if (!mediaTranscript) {
      try {
        mediaTranscript = hasMediaTranscript(db, resourceId);
      } catch (error) {
        this.logger?.warn(`[VfsFullIndexingService] Failed to probe media transcript: ${messageOf(error)}`);
        mediaTranscript = false;
      }
    }
    // Rust exam units never carry text or images, so `has_valid_units` is always false and
    // indexing.rs:2299 re-syncs exams every time. Exam units carry text here
    // (RUST-FIX(RF-W04-exam-unit-canonical-text)), so keep that re-sync explicitly.
    const examResource = getFullResource(db, resourceId)?.resourceType === 'exam';
    if (!(hasValidUnits && !contentChanged && !hasPendingTextUnit
      && !legacyUnpagedPdf && !mediaTranscript && !examResource)) {
      try {
        await this.syncResourceToUnitsAsync(resourceId);
      } catch (error) {
        if (error instanceof UnsupportedIndexResourceTypeError) return [0, 0];
        throw error;
      }
    }

    const resource = getFullResource(db, resourceId);
    if (resource === undefined) {
      throw new Error(`Resource not found: ${resourceId}`);
    }

    let resolvedFolderId = folderId;
    if (resource.resourceType === 'note' && resource.sourceId !== null) {
      const note = getNoteRecord(db, resource.sourceId);
      if (note === undefined) {
        if (shouldDisableIndexForMissingNote(resource)) {
          await this.deleteResourceIndex(resourceId);
          markDisabledWithReason(db, resourceId, 'note missing');
          return [0, 0];
        }
      } else if (note.deleted) {
        await this.deleteResourceIndex(resourceId);
        markDisabledWithReason(db, resourceId, 'note deleted');
        return [0, 0];
      }
      if (resolvedFolderId === null) {
        resolvedFolderId = getNoteFolderId(db, resource.sourceId);
      }
    }

    if (vectorAvailable) markIndexing(db, resourceId);

    let content = resolveIndexableContent(db, resource, this.logger);
    const transcriptFirstUnit = existingUnits.find(
      (unit) => unit.unitIndex === 0 && unit.textSource === TRANSCRIPT_TEXT_SOURCE,
    )?.textContent ?? null;
    if (transcriptFirstUnit !== null) content = transcriptFirstUnit;

    const needsContentRecovery = transcriptFirstUnit !== null
      ? false
      : resource.resourceType === 'textbook' || resource.resourceType === 'file'
        ? (() => {
          const fileText = getFileExtractedTextForRecovery(
            db, resource.sourceId ?? resource.id,
          );
          return !hasValidText(fileText, PDF_TEXT_THRESHOLD) || !hasValidText(content, 1);
        })()
        : !hasValidText(content, 1);

    let ocrRecovered = false;
    if (needsContentRecovery
      && (resource.resourceType === 'textbook'
        || resource.resourceType === 'image'
        || resource.resourceType === 'file')) {
      if (this.ocrRecovery !== undefined) {
        const kind = resource.resourceType === 'textbook' ? 'Textbook' : resource.resourceType === 'image' ? 'Image' : 'File';
        this.logger?.info(`[VfsFullIndexingService] Resource ${resourceId} (${kind}) needs OCR recovery, attempting auto-OCR...`);
        try {
          const recovered = await this.ocrRecovery.recover(resource, (event) => {
            this.events?.emit('vfs-index-progress', event);
          });
          if (recovered !== null) {
            this.logger?.info(`[VfsFullIndexingService] Auto-OCR succeeded for ${resourceId} (${utf8ByteLength(recovered)} chars)`);
            content = recovered;
            ocrRecovered = true;
          } else {
            this.logger?.info(`[VfsFullIndexingService] Auto-OCR returned no content for ${resourceId}`);
          }
        } catch (ocrError) {
          this.logger?.warn(`[VfsFullIndexingService] Auto-OCR failed for ${resourceId}: ${messageOf(ocrError)}`);
        }
      }
    }

    if (!vectorAvailable) {
      if (ocrRecovered) {
        try { await this.syncResourceToUnitsAsync(resourceId); }
        catch (error) {
          if (!(error instanceof UnsupportedIndexResourceTypeError)) {
            this.logger?.warn(`[VfsFullIndexingService] Lexical ledger re-sync after OCR failed for ${resourceId}: ${messageOf(error)}`);
          }
        }
      }
      this.logger?.debug(`[VfsFullIndexingService] Vector index not compiled in; text ledger refreshed for ${resourceId}`);
      return [0, 0];
    }

    if (!hasValidText(content, 1)) {
      await this.clearEmptyTextIndex(resourceId);
      const reason = emptyContentReason(resource.resourceType);
      setIndexState(db, resourceId, INDEX_STATE_INDEXED, resource.hash, reason);
      // RUST-FIX(RF-W04-empty-text-additional-units-folder): indexing.rs:2535 passes `None` here (its
      // other two call sites pass resolved_folder_id), so these Lance rows miss `folder_id IN (...)` filters.
      await this.indexAdditionalPendingTextUnits(resourceId, resource.resourceType, resolvedFolderId);
      return [0, 0];
    }

    let primaryContent = content!;
    const perPageUnits = (() => {
      const units = getUnitsByResource(db, resourceId);
      const textUnits = units.filter(
        (unit) => unit.textContent !== null && rustTrim(unit.textContent) !== '',
      ).length;
      if ((units.length > 1 || transcriptFirstUnit !== null) && textUnits > 0) {
        return units.find((unit) => unit.unitIndex === 0)?.textContent ?? '';
      }
      return null;
    })();
    if (perPageUnits !== null) primaryContent = perPageUnits;

    const pages = perPageUnits !== null
      ? null
      : resolveIndexablePages(db, resource);
    let chunks = pages !== null
      ? chunkTextWithPages(pages, this.chunkingConfig)
      : chunkText(primaryContent, this.chunkingConfig);
    let transcriptMetadata: string | null = null;
    if (transcriptFirstUnit !== null) {
      const media = this.requireMediaIndex();
      const range = media.rangeForUnit(media.unitTimeRanges(db, resourceId), 0);
      transcriptMetadata = range === null ? null : media.segmentMetadataJson(range);
      chunks = chunks.map((chunk) => ({ ...chunk, page_index: 0 }));
    }
    const chunksForDb = chunks.map((chunk) => ({ ...chunk }));
    if (chunks.length === 0) {
      await this.clearEmptyTextIndex(resourceId);
      setIndexState(
        db, resourceId, INDEX_STATE_INDEXED, resource.hash,
        '文本内容过短，无法生成有效的索引块',
      );
      await this.indexAdditionalPendingTextUnits(resourceId, resource.resourceType, resolvedFolderId);
      return [0, 0];
    }

    const primaryUnitId = ensurePrimaryUnit(db, resourceId);
    let result;
    try {
      result = await this.pipeline.indexChunks(
        resourceId, primaryUnitId, resource.resourceType, resolvedFolderId,
        chunks, MODALITY_TEXT, progress,
      );
    } catch (error) {
      // Rust's Err arm belongs only to index_chunks, not to the later Ok arm
      // (including additional units whose errors have their own recovery).
      this.logger?.error(`[VfsFullIndexingService] Failed to index resource ${resourceId}: ${messageOf(error)}`);
      const retryable = isInvalidState(error);
      try {
        if (retryable) markTextUnitsState(db, resourceId, 'pending', null, { requiredOnly: true });
        else markTextUnitsFailedWithoutDim(db, resourceId, messageOf(error), true);
      } catch (dbError) {
        this.logger?.warn(`[VfsIndexing] Failed to update text_state to 'failed' for resource ${resourceId}: ${messageOf(dbError)}`);
      }
      if (retryable) markPending(db, resourceId);
      else markFailed(db, resourceId, messageOf(error));
      throw error;
    }
    // Rust `Ok(result)` arm (indexing.rs: primary metadata → additional units).
    {
      const count = result.count;
      const dim = result.dim;
      if (result.index_profile_id === null) {
        throw new Error('text indexing result missing index_profile_id');
      }
      if (result.generation === null) {
        throw new Error('text indexing result missing generation');
      }
      const embeddingIds = result.embedding_ids;
      try {
        this.syncSegmentMetadata(
          resourceId, primaryUnitId, chunksForDb, embeddingIds, dim,
          result.index_profile_id, result.generation,
          transcriptMetadata, 'primary',
        );
      } catch (error) {
        const syncError = messageOf(error);
        const retryable = isInvalidState(error);
        try {
          if (retryable) {
            markTextUnitsState(db, resourceId, 'pending', null, { requiredOnly: true });
          } else {
            markTextUnitsFailedWithoutDim(db, resourceId, syncError, true);
          }
        } catch (markerError) {
          this.logger?.warn(`[VfsIndexing] Failed to update text_state to 'failed' for resource ${resourceId}: ${messageOf(markerError)}`);
        }
        this.logger?.error(`[VfsFullIndexingService] Metadata sync failed after Lance write for ${resourceId}: ${syncError}. Rolling back Lance vectors...`);
        try {
          await this.lanceStore.discardUncommittedRows?.(
            MODALITY_TEXT, resourceId, embeddingIds,
          );
        } catch (discardError) {
          this.logger?.error(`[VfsFullIndexingService] Lance rollback failed for ${resourceId}: ${messageOf(discardError)}`);
          if (!retryable) {
            const combined = `${syncError}; rollback failed: ${messageOf(discardError)}`;
            markFailed(db, resourceId, combined);
            throw other(combined);
          }
        }
        if (retryable) markPending(db, resourceId);
        else markFailed(db, resourceId, syncError);
        throw error;
      }

      try {
        await this.lanceStore.deleteByUnitExceptIds?.(
          MODALITY_TEXT, resourceId, primaryUnitId, embeddingIds,
        );
      } catch (cleanupError) {
        this.logger?.warn(`[VfsFullIndexingService] Deferred unit cleanup failed: ${messageOf(cleanupError)}`);
      }

      try {
        await this.indexAdditionalPendingTextUnits(resourceId, resource.resourceType, resolvedFolderId);
      } catch (error) {
        if (isInvalidState(error)) {
          markPending(db, resourceId);
        } else {
          markFailed(db, resourceId, messageOf(error));
        }
        throw error;
      }
      markIndexed(db, resourceId, resource.hash);
      this.logger?.info(`[VfsFullIndexingService] Successfully indexed resource ${resourceId} (${count} chunks, dim=${dim})`);
      if (refreshCounts) {
        try { refreshCountsFromSegments(db); }
        catch (error) {
          this.logger?.warn(`[VfsFullIndexingService] Failed to refresh embedding_dim counts after indexing ${resourceId}: ${messageOf(error)}`);
        }
      }
      return [count, dim];
    }
  }

  /**
   * `VfsFullIndexingService::index_question`: index one question's content,
   * options, answer, explanation, tags and note as a text unit.
   */
  async indexQuestion(questionId: string, examId: string): Promise<[number, number]> {
    return questions.indexQuestion(this.questionIndexing(), questionId, examId);
  }

  /** `VfsFullIndexingService::index_exam_questions` (page 1, page size 1000). */
  async indexExamQuestions(examId: string): Promise<[number, number]> {
    return questions.indexExamQuestions(
      this.questionIndexing(), examId, (questionId) => this.indexQuestion(questionId, examId),
    );
  }

  private questionIndexing(): questions.QuestionIndexingContext {
    return {
      db: this.db, pipeline: this.pipeline, lanceStore: this.lanceStore,
      chunkingConfig: this.chunkingConfig, questionRepo: this.questionRepo, logger: this.logger,
    };
  }

  /** `VfsFullIndexingService::reindex_resource`. */
  async reindexResource(
    resourceId: string,
    folderId: string | null = null,
    progress: EmbeddingProgressCallback | null = null,
  ): Promise<[number, number]> {
    await this.deleteResourceIndex(resourceId);
    return this.indexResource(resourceId, folderId, progress);
  }

  private syncSegmentMetadata(
    resourceId: string,
    unitId: string,
    chunks: readonly TextChunk[],
    embeddingIds: readonly string[],
    dimension: number,
    profileId: string,
    generation: number | bigint,
    metadataJson: string | null,
    role: 'primary' | 'additional',
  ): void {
    if (role === 'primary' && dimension > 0 && (dimension < 64 || dimension > 8192)) {
      this.logger?.warn(`[VfsFullIndexingService] Embedding dimension ${dimension} is outside valid range [64, 8192] for resource ${resourceId}`);
    }
    if (embeddingIds.length !== chunks.length) {
      throw new Error(
        `lance_row_id count mismatch for resource ${resourceId}: embedding_ids=${embeddingIds.length}, chunks=${chunks.length}`,
      );
    }
    inTransaction(this.db, (tx) => {
      setUnitIndexProfile(tx, unitId, MODALITY_TEXT, profileId, generation);
      try {
        setUnitTextState(tx, unitId, 'indexing', null, dimension);
      } catch (error) {
        // indexing.rs:2754-2764 warns for primary; :3132-3140 propagates for additional.
        if (role !== 'primary') throw error;
        this.logger?.warn(`[VfsIndexing] Failed to update text_state to 'indexing' for unit ${unitId}: ${messageOf(error)}`);
      }
      const inputs: CreateSegmentInput[] = chunks.map((chunk, index) => {
        const lanceRowId = embeddingIds[index];
        if (lanceRowId === undefined) {
          throw new Error(`missing embedding_id at index ${index} for resource ${resourceId}`);
        }
        return {
          unitId,
          segmentIndex: chunk.index,
          modality: MODALITY_TEXT,
          embeddingDim: dimension,
          lanceRowId,
          contentText: chunk.text,
          startPos: chunk.start_pos,
          endPos: chunk.end_pos,
          metadataJson,
        };
      });
      replaceSegmentsByUnitAndModality(tx, resourceId, unitId, MODALITY_TEXT, inputs);
      markUnitTextIndexed(tx, unitId, chunks.length, dimension);
      registerAndIncrementEmbeddingDim(tx, dimension, MODALITY_TEXT, chunks.length);
    });
  }

  /** Rust additional-unit status writes use `let _ = conn.execute(...)`. */
  private setAdditionalUnitStateBestEffort(unitId: string, state: 'pending' | 'failed', error: string | null): void {
    try { setUnitTextState(this.db, unitId, state, error); }
    catch {
      // indexing.rs:3072/3078/3115/3212/3218: no status-write diagnostic and
      // no replacement of the original indexing/metadata error.
      return;
    }
  }

  private async indexAdditionalPendingTextUnits(
    resourceId: string,
    resourceType: string,
    folderId: string | null,
  ): Promise<void> {
    const units = requirePendingUnits(this.db, resourceId);
    let transcriptRanges: import('../api.ts').MediaTimeRange[] | undefined;
    for (const unit of units) {
      const text = unit.textContent;
      if (text === null || rustTrim(text) === '') continue;
      const isTranscript = unit.textSource === TRANSCRIPT_TEXT_SOURCE;
      const chunks = chunkText(text, this.chunkingConfig).map((chunk) => (
        isTranscript ? { ...chunk, page_index: unit.unitIndex } : chunk
      ));
      if (chunks.length === 0) continue;
      let transcriptMetadata: string | null = null;
      if (isTranscript) {
        const media = this.requireMediaIndex();
        transcriptRanges ??= media.unitTimeRanges(this.db, resourceId);
        const range = media.rangeForUnit(transcriptRanges, unit.unitIndex);
        transcriptMetadata = range === null ? null : media.segmentMetadataJson(range);
      }
      const source = unit.textSource === null ? 'None' : `Some(${JSON.stringify(unit.textSource)})`;
      this.logger?.info(`[VfsFullIndexingService] Indexing additional text unit ${unit.id} (source=${source}) for resource ${resourceId}`);
      let result;
      try {
        result = await this.pipeline.indexChunks(
          resourceId, unit.id, resourceType, folderId, chunks, MODALITY_TEXT, null,
        );
      } catch (error) {
        if (isInvalidState(error)) {
          this.setAdditionalUnitStateBestEffort(unit.id, 'pending', null);
          throw error;
        }
        this.setAdditionalUnitStateBestEffort(unit.id, 'failed', messageOf(error));
        this.logger?.warn(`[VfsFullIndexingService] Failed to index additional unit ${unit.id} for resource ${resourceId}: ${messageOf(error)}`);
        continue;
      }
      if (result.index_profile_id === null || result.generation === null) {
        throw new Error(`additional Unit ${unit.id} missing index profile identity`);
      }
      if (result.embedding_ids.length !== chunks.length) {
        // Rust indexing.rs:3100-3107 uses let _ for this discard, with no diagnostic.
        await this.lanceStore.discardUncommittedRows?.(
          MODALITY_TEXT, resourceId, result.embedding_ids,
        ).catch(() => undefined);
        this.setAdditionalUnitStateBestEffort(
          unit.id, 'failed',
          `additional unit embedding_id mismatch: unit=${unit.id}, embeddings=${result.embedding_ids.length}, chunks=${chunks.length}`,
        );
        continue;
      }
      try {
        this.syncSegmentMetadata(
          resourceId, unit.id, chunks, result.embedding_ids, result.dim,
          result.index_profile_id, result.generation,
          transcriptMetadata, 'additional',
        );
      } catch (error) {
        try {
          await this.lanceStore.discardUncommittedRows?.(
            MODALITY_TEXT, resourceId, result.embedding_ids,
          );
        } catch (discardError) {
          this.logger?.warn(`[VfsFullIndexingService] Failed to rollback additional unit vectors ${unit.id}: ${messageOf(discardError)}`);
        }
        if (isInvalidState(error)) {
          this.setAdditionalUnitStateBestEffort(unit.id, 'pending', null);
          throw error;
        }
        this.setAdditionalUnitStateBestEffort(unit.id, 'failed', messageOf(error));
        continue;
      }
      try {
        await this.lanceStore.deleteByUnitExceptIds?.(
          MODALITY_TEXT, resourceId, unit.id, result.embedding_ids,
        );
      } catch (cleanupError) {
        this.logger?.warn(`[VfsFullIndexingService] Deferred cleanup for additional Unit ${unit.id} failed: ${messageOf(cleanupError)}`);
      }
      this.logger?.info(`[VfsFullIndexingService] Additional unit ${unit.id} indexed: ${result.count} chunks, dim=${result.dim}`);
    }
  }

  private async clearEmptyTextIndex(resourceId: string): Promise<void> {
    inTransaction(this.db, (tx) => {
      clearTextIndexRowsForResource(tx, resourceId, MODALITY_TEXT);
      refreshCountsFromSegments(tx);
    });
    try {
      await this.lanceStore.deleteByResource(MODALITY_TEXT, resourceId);
    } catch (deleteError) {
      this.logger?.warn(
        `[VfsFullIndexingService] Direct empty-text Lance cleanup failed for ${resourceId}: ${messageOf(deleteError)}; queued for retry`,
      );
    }
  }

  private requireMediaIndex(): ReturnType<NonNullable<VfsFullIndexingDeps['mediaIndex']>> {
    if (this.mediaIndex === undefined) throw new Error('L13 vfs mediaIndex service is not available');
    return this.mediaIndex();
  }

  async deleteResourceIndex(resourceId: string): Promise<void> {
    try {
      await this.lanceStore.deleteByResource(MODALITY_MULTIMODAL, resourceId);
    } catch (error) {
      throw new Error(`Failed to delete multimodal vectors for ${resourceId}: ${messageOf(error)}`);
    }
    await this.pipeline.deleteResourceIndex(resourceId);
    purgeIndexArtifactsByResource(this.db, resourceId);
    try {
      refreshCountsFromSegments(this.db);
    } catch (refreshError) {
      this.logger?.warn(`[VfsFullIndexingService] Failed to refresh embedding counts: ${messageOf(refreshError)}`);
    }
    markPending(this.db, resourceId);
  }

  prepareUnitsWithoutEmbedding(limit: number): number {
    const candidates = listPrepareCandidates(this.db, limit);
    let prepared = 0;
    for (const resourceId of candidates) {
      if (this.attemptedWithoutEmbedding.has(resourceId)) continue;
      this.attemptedWithoutEmbedding.add(resourceId);
      try {
        this.syncResourceToUnits(resourceId);
        prepared += 1;
      } catch (error) {
        this.logger?.warn(`[VfsFullIndexingService] Failed to prepare units for ${resourceId}: ${messageOf(error)}`);
      }
      if (prepared >= limit) break;
    }
    return prepared;
  }

  async processPendingBatch(batchSize: number): Promise<[number, number]> {
    if (!this.vectorIndexAvailable()) return [0, 0];
    try {
      await this.drainLanceOrphanQueue(200);
    } catch (drainError) {
      this.logger?.warn(`[VfsFullIndexingService] drain_lance_orphan_queue failed: ${messageOf(drainError)}`);
    }
    const config = getIndexingConfig(this.db);
    const pending = claimPendingResources(this.db, batchSize, config.maxRetries);
    if (pending.length === 0) return [0, 0];
    const concurrency = Math.max(1, config.maxConcurrent);
    this.logger?.info(`[VfsFullIndexingService] Processing ${pending.length} claimed pending resources (max_concurrent=${concurrency})`);
    let success = 0;
    let failed = 0;
    let index = 0;
    const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
      while (index < pending.length) {
        const current = pending[index];
        index += 1;
        if (current === undefined) break;
        try {
          const [count] = await this.indexResourceWithOptions(current, null, null, false, true);
          success += 1;
          this.logger?.info(`[VfsFullIndexingService] Indexed ${current} (${count} chunks)`);
        } catch (indexError) {
          this.logger?.warn(`[VfsFullIndexingService] Failed to index ${current}: ${messageOf(indexError)}`);
          failed += 1;
        }
      }
    });
    await Promise.all(workers);
    if (success > 0) {
      try {
        refreshCountsFromSegments(this.db);
      } catch (refreshError) {
        this.logger?.warn(`[VfsFullIndexingService] Failed to refresh embedding_dim counts after batch: ${messageOf(refreshError)}`);
      }
    }
    this.logger?.info(`[VfsFullIndexingService] Batch complete: ${success} success, ${failed} failed`);
    return [success, failed];
  }

  async drainLanceOrphanQueue(limit: number): Promise<number> {
    try {
      await this.lanceStore.sweepRetiredProfileTables?.();
    } catch (sweepError) {
      this.logger?.warn(`[VfsFullIndexingService] Retired profile sweep failed: ${messageOf(sweepError)}`);
    }
    const entries = listOrphanQueueEntries(this.db, Date.now(), limit);
    if (entries.length === 0) return 0;
    const ids = entries.map((entry) => entry.lance_row_id);
    let textOk = true;
    let mmOk = true;
    try {
      await this.lanceStore.deleteByEmbeddingIds(MODALITY_TEXT, ids);
    } catch (deleteError) {
      this.logger?.warn(`[VfsFullIndexingService] Orphan text deletion failed: ${messageOf(deleteError)}`);
      textOk = false;
    }
    try {
      await this.lanceStore.deleteByEmbeddingIds(MODALITY_MULTIMODAL, ids);
    } catch (deleteError) {
      this.logger?.warn(`[VfsFullIndexingService] Orphan multimodal deletion failed: ${messageOf(deleteError)}`);
      mmOk = false;
    }
    if (textOk && mmOk) {
      for (const id of ids) deleteLanceOrphan(this.db, id);
      return ids.length;
    }
    for (const entry of entries) {
      const retryCount = entry.retry_count;
      const delaySecs = Math.min(5 * (1 << Math.min(Math.max(retryCount, 0), 10)), 3600);
      updateOrphanRetry(
        this.db, entry.lance_row_id, Date.now() + delaySecs * 1000, 'lance delete failed',
      );
    }
    return 0;
  }

  getIndexingConfig(): IndexingConfig {
    return getIndexingConfig(this.db);
  }

  getChunkingConfig(): ChunkingConfig {
    return this.chunkingConfig;
  }

  getSearchConfig(): SearchConfig {
    return getSearchConfig(this.db);
  }

  getPendingResources(): string[] {
    const config = getIndexingConfig(this.db);
    return getPendingResources(this.db, config.batchSize, config.maxRetries);
  }

  markResourcePending(resourceId: string): void {
    markPending(this.db, resourceId);
  }

  markResourceFailed(resourceId: string, error: string): void {
    markFailed(this.db, resourceId, error);
  }

  recoverStuckIndexing(): number {
    return VfsFullIndexingService.recoverStuckIndexing(this.db);
  }

  checkNeedsReindex(resourceId: string): boolean {
    return checkNeedsReindex(this.db, resourceId);
  }

  chunkingConfigValue(): ChunkingConfig {
    return this.chunkingConfig;
  }
}

// ---------------------------------------------------------------- search service
