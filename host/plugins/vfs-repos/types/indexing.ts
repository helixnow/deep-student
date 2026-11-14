/** Indexing contracts: embedding dimensions, index state/config, units and segments. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** VfsEmbedding mirrors embedding_repo.rs serde output. */
export interface VfsEmbedding {
  id: string; resourceId: string; chunkIndex: number; chunkText: string; embeddingDim: number;
  modality: string; startPos: number | null; endPos: number | null; metadataJson: string | null;
  createdAt: number; updatedAt: number;
}
/** VfsEmbeddingDimension mirrors embedding_repo.rs serde output. */
export interface VfsEmbeddingDimension {
  dimension: number; modality: string; recordCount: number; lanceTableName: string;
  createdAt: number; lastUsedAt: number; modelConfigId: string | null; modelName: string | null;
}
/** IndexState mirrors embedding_repo.rs `IndexState` serde output. */
export interface EmbeddingIndexState {
  state: string; hash: string | null; error: string | null; indexedAt: number | null; retryCount: number;
}
export interface EmbeddingDimensionRepository {
  registerDimension(conn: SqlExecutor, dimension: number, modality: string, modelConfigId: string | null): string;
  registerDimensionWithModel(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string | null, modelName: string | null): string;
  getDimension(conn: SqlExecutor, dimension: number, modality: string): VfsEmbeddingDimension | null;
  listDimensions(conn: SqlExecutor): VfsEmbeddingDimension[];
  listDimensionsWithModelBinding(conn: SqlExecutor): VfsEmbeddingDimension[];
  updateRecordCount(conn: SqlExecutor, dimension: number, modality: string, count: number): void;
  incrementRecordCount(conn: SqlExecutor, dimension: number, modality: string, delta: number): void;
  getLanceTableName(dimension: number, modality: string): string;
  updateModelAssignment(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string, modelName: string): boolean;
}
export interface IndexStateRepository {
  getIndexState(conn: SqlExecutor, resourceId: string): EmbeddingIndexState | null;
  setIndexState(conn: SqlExecutor, resourceId: string, state: string,
    hash: string | null, error: string | null): void;
  markPending(conn: SqlExecutor, resourceId: string): void;
  markIndexing(conn: SqlExecutor, resourceId: string): void;
  markIndexed(conn: SqlExecutor, resourceId: string, hash: string): void;
  markFailed(conn: SqlExecutor, resourceId: string, error: string): void;
  reviveConfigBlocked(conn: SqlExecutor): number;
  requeuePagedPdfsOnce(conn: SqlExecutor): number;
  markDisabled(conn: SqlExecutor, resourceId: string): void;
  markDisabledWithReason(conn: SqlExecutor, resourceId: string, reason: string): void;
  getPendingResources(conn: SqlExecutor, limit: number, maxRetries: number): string[];
  claimPendingResources(conn: SqlExecutor, limit: number, maxRetries: number): string[];
  getDisabledResources(conn: SqlExecutor, limit: number): string[];
  getResourcesNeedingReindex(conn: SqlExecutor, limit: number): Array<[string, string]>;
  getMmIndexState(conn: SqlExecutor, resourceId: string): EmbeddingIndexState | null;
  setMmIndexState(conn: SqlExecutor, resourceId: string, state: string, error: string | null): void;
  markMmPending(conn: SqlExecutor, resourceId: string): void;
  markMmIndexing(conn: SqlExecutor, resourceId: string): void;
  markMmIndexed(conn: SqlExecutor, resourceId: string): void;
  markMmFailed(conn: SqlExecutor, resourceId: string, error: string): void;
  markMmDisabled(conn: SqlExecutor, resourceId: string): void;
  getMmPendingResources(conn: SqlExecutor, limit: number, maxRetries: number): string[];
  claimMmIndexingResources(conn: SqlExecutor, resourceIds: readonly string[], maxRetries: number): string[];
}
export interface IndexingConfigRepository {
  getConfig(conn: SqlExecutor, key: string): string | null;
  setConfig(conn: SqlExecutor, key: string, value: string): void;
  getBool(conn: SqlExecutor, key: string, defaultValue: boolean): boolean;
  getI32(conn: SqlExecutor, key: string, defaultValue: number): number;
  getF64(conn: SqlExecutor, key: string, defaultValue: number): number;
}
/**
 * VfsIndexUnit mirrors index_unit_repo.rs. Generations are Rust i64: number when
 * within Number.MAX_SAFE_INTEGER, bigint beyond it (R12-09), never rounded.
 */
export type IndexState = 'pending' | 'indexing' | 'indexed' | 'failed' | 'disabled';
export interface VfsIndexUnit {
  id: string; resourceId: string; unitIndex: number; imageBlobHash: string | null;
  imageMimeType: string | null; textContent: string | null; textSource: string | null;
  contentHash: string | null; textRequired: boolean; textState: IndexState;
  textError: string | null; textIndexedAt: number | null; textChunkCount: number;
  textEmbeddingDim: number | null; textProfileId: string | null; textGeneration: number | bigint;
  mmRequired: boolean; mmState: IndexState; mmError: string | null; mmIndexedAt: number | null;
  mmEmbeddingDim: number | null; mmProfileId: string | null; mmGeneration: number | bigint;
  createdAt: number; updatedAt: number;
}
export interface CreateUnitInput {
  resourceId: string; unitIndex: number; imageBlobHash: string | null;
  imageMimeType: string | null; textContent: string | null; textSource: string | null;
}
export interface SyncUnitsResult { units: VfsIndexUnit[]; orphanedLanceRowIds: string[] }
export interface SyncMultimodalUnitsResult { units: VfsIndexUnit[]; orphanedLanceRowIds: string[] }
export interface UnitStats {
  total: number; textPending: number; textIndexing: number; textIndexed: number;
  textFailed: number; textDisabled: number; mmPending: number; mmIndexing: number;
  mmIndexed: number; mmFailed: number; mmDisabled: number;
}
export interface IndexUnitRepository {
  create(conn: SqlExecutor, input: CreateUnitInput): VfsIndexUnit;
  getById(conn: SqlExecutor, id: string): VfsIndexUnit | null;
  getByResource(conn: SqlExecutor, resourceId: string): VfsIndexUnit[];
  update(conn: SqlExecutor, unit: VfsIndexUnit): void;
  setIndexProfile(conn: SqlExecutor, unitId: string, modality: string,
    profileId: string, generation: number | bigint): void;
  delete(conn: SqlExecutor, id: string): boolean;
  deleteUnsafe(conn: SqlExecutor, id: string): boolean;
  deleteByResource(conn: SqlExecutor, resourceId: string): number;
  deleteByResourceUnsafe(conn: SqlExecutor, resourceId: string): number;
  purgeIndexArtifactsByResource(conn: SqlExecutor, resourceId: string): number;
  sweepOrphanIndexUnits(conn: SqlExecutor): number;
  setTextState(conn: SqlExecutor, id: string, state: IndexState, error: string | null): void;
  setTextIndexed(conn: SqlExecutor, id: string, chunkCount: number, embeddingDim: number): void;
  setMmState(conn: SqlExecutor, id: string, state: IndexState, error: string | null): void;
  setMmIndexed(conn: SqlExecutor, id: string, embeddingDim: number): void;
  listPendingText(conn: SqlExecutor, limit: number): VfsIndexUnit[];
  listPendingMm(conn: SqlExecutor, limit: number): VfsIndexUnit[];
  getStats(conn: SqlExecutor): UnitStats;
  getByResourceAndIndex(conn: SqlExecutor, resourceId: string, unitIndex: number): VfsIndexUnit | null;
  batchCreate(conn: SqlExecutor, inputs: readonly CreateUnitInput[]): VfsIndexUnit[];
  syncUnits(conn: SqlExecutor, resourceId: string, inputs: readonly CreateUnitInput[]): SyncUnitsResult;
  syncMultimodalUnits(conn: SqlExecutor, resourceId: string, inputs: readonly CreateUnitInput[],
    forceRebuild: boolean): SyncMultimodalUnitsResult;
  clearMultimodalIndex(conn: SqlExecutor, resourceId: string): number;
}
/** VfsIndexSegment mirrors index_segment_repo.rs `VfsIndexSegment`. */
export interface VfsIndexSegment {
  id: string; unitId: string; segmentIndex: number; modality: string; embeddingDim: number;
  lanceRowId: string; contentText: string | null; contentHash: string | null;
  startPos: number | null; endPos: number | null; metadataJson: string | null;
  indexProfileId: string | null; generation: number | bigint; createdAt: number; updatedAt: number;
}
/** CreateSegmentInput mirrors index_segment_repo.rs. */
export interface CreateSegmentInput {
  unitId: string; segmentIndex: number; modality: string; embeddingDim: number;
  lanceRowId: string; contentText: string | null; contentHash: string | null;
  startPos: number | null; endPos: number | null; metadataJson: string | null;
}
export interface ModalityDimStats { modality: string; embeddingDim: number; count: number }
export interface LanceTableExpectedCount {
  lanceTableName: string; segmentCount: number; pendingOrphanCount: number;
}
export interface IndexSegmentRepository {
  enqueueLanceOrphan(conn: SqlExecutor, lanceRowId: string, resourceId: string | null): void;
  enqueueLanceOrphansByUnit(conn: SqlExecutor, unitId: string, modality: string | null): number;
  normalizeDimsModality(modality: string): string;
  create(conn: SqlExecutor, input: CreateSegmentInput): VfsIndexSegment;
  batchCreate(conn: SqlExecutor, inputs: readonly CreateSegmentInput[]): VfsIndexSegment[];
  getById(conn: SqlExecutor, id: string): VfsIndexSegment | null;
  getByUnit(conn: SqlExecutor, unitId: string): VfsIndexSegment[];
  getByUnitAndModality(conn: SqlExecutor, unitId: string, modality: string): VfsIndexSegment[];
  deleteByUnit(conn: SqlExecutor, unitId: string): number;
  deleteByUnitUnsafe(conn: SqlExecutor, unitId: string): number;
  deleteByUnitAndModality(conn: SqlExecutor, unitId: string, modality: string): number;
  deleteByUnitAndModalityUnsafe(conn: SqlExecutor, unitId: string, modality: string): number;
  replaceByUnitAndModality(conn: SqlExecutor, resourceId: string, unitId: string,
    modality: string, inputs: readonly CreateSegmentInput[]): VfsIndexSegment[];
  enqueueAndDeleteByResourceAndModality(conn: SqlExecutor, resourceId: string, modality: string): number;
  deleteByLanceRowId(conn: SqlExecutor, lanceRowId: string): boolean;
  deleteByLanceRowIdUnsafe(conn: SqlExecutor, lanceRowId: string): boolean;
  delete(conn: SqlExecutor, id: string): boolean;
  countByModalityAndDim(conn: SqlExecutor, modality: string, embeddingDim: number): number;
  listLanceRowIdsByUnit(conn: SqlExecutor, unitId: string): string[];
  listLanceRowIdsByUnitAndModality(conn: SqlExecutor, unitId: string, modality: string): string[];
  getModalityDimStats(conn: SqlExecutor): ModalityDimStats[];
  listExpectedLanceRowCounts(conn: SqlExecutor): LanceTableExpectedCount[];
  countPendingLanceOrphans(conn: SqlExecutor): number;
}
/** VfsEmbeddingDim mirrors embedding_dim_repo.rs serde output. */
export interface VfsEmbeddingDim {
  dimension: number; modality: string; lanceTableName: string; recordCount: number;
  createdAt: number; lastUsedAt: number; modelConfigId: string | null; modelName: string | null;
  activeProfileId: string | null; modelFingerprint: string | null; embeddingProtocol: string;
  activeGeneration: number; annMetric: string; annIndexVersion: number;
}
/** VfsIndexProfile mirrors embedding_dim_repo.rs serde output. */
export interface VfsIndexProfile {
  id: string; modelFingerprint: string; modelConfigId: string | null; modelName: string | null;
  dimension: number; modality: string; embeddingProtocol: string; schemaVersion: number;
  lanceTableName: string; activeGeneration: number; state: string; annMetric: string;
  annIndexVersion: number; createdAt: number; updatedAt: number;
}
export interface DimensionCascadeCleanup { deletedSegments: number; lanceTableNames: string[] }
/** Fields of llm_manager::ApiConfig that participate in the vector-space fingerprint. */
export interface EmbeddingModelConfig {
  id: string; model: string; baseUrl: string; providerType?: string | null;
  providerScope?: string | null; apiProtocol?: string | null; modelAdapter: string;
}
export interface EmbeddingDimRepository {
  embeddingProtocolForModality(modality: string): string;
  modelFingerprint(modelConfigId: string, modelName: string, protocol: string): string;
  modelFingerprintWithTransport(modelConfigId: string, modelName: string, protocol: string,
    providerType: string | null, providerScope: string | null, baseUrl: string | null,
    apiProtocol: string | null, modelAdapter: string | null): string;
  modelFingerprintForConfig(config: EmbeddingModelConfig, modality: string): string;
  generateLanceTableName(modality: string, dimension: number): string;
  generateProfileLanceTableName(modality: string, dimension: number, fingerprint: string): string;
  register(conn: SqlExecutor, dimension: number, modality: string): VfsEmbeddingDim;
  registerWithModel(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string | null, modelName: string | null): VfsEmbeddingDim;
  registerWithModelFingerprint(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string | null, modelName: string | null, fingerprintOverride: string | null): VfsEmbeddingDim;
  getByKey(conn: SqlExecutor, dimension: number, modality: string): VfsEmbeddingDim | null;
  listAll(conn: SqlExecutor): VfsEmbeddingDim[];
  listByModality(conn: SqlExecutor, modality: string): VfsEmbeddingDim[];
  updateCount(conn: SqlExecutor, dimension: number, modality: string, count: number): void;
  incrementCount(conn: SqlExecutor, dimension: number, modality: string, delta: number): void;
  decrementCount(conn: SqlExecutor, dimension: number, modality: string, delta: number): void;
  delete(conn: SqlExecutor, dimension: number, modality: string): boolean;
  createDimension(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string | null, modelName: string | null): VfsEmbeddingDim;
  getActiveProfile(conn: SqlExecutor, dimension: number, modality: string): VfsIndexProfile | null;
  getProfileById(conn: SqlExecutor, profileId: string): VfsIndexProfile | null;
  beginProfileRebuild(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string, modelName: string): VfsIndexProfile;
  activateProfile(conn: SqlExecutor, profileId: string, minSegmentCount: number): VfsIndexProfile;
  listActiveProfiles(conn: SqlExecutor, modality: string | null): VfsIndexProfile[];
  setAnnStatus(conn: SqlExecutor, dimension: number, modality: string, metric: string, version: number): void;
  setProfileAnnStatus(conn: SqlExecutor, profileId: string, metric: string, version: number): void;
  deleteDimensionCascade(conn: SqlExecutor, dimension: number, modality: string): number;
  deleteDimensionCascadeCollect(conn: SqlExecutor, dimension: number, modality: string): DimensionCascadeCleanup;
  hasIndexingUnitsForDimension(conn: SqlExecutor, dimension: number, modality: string): boolean;
  listLanceTableNames(conn: SqlExecutor): string[];
  updateModelBinding(conn: SqlExecutor, dimension: number, modality: string,
    modelConfigId: string, modelName: string): boolean;
  clearModelBinding(conn: SqlExecutor, dimension: number, modality: string): boolean;
  listByModel(conn: SqlExecutor, modelConfigId: string): VfsEmbeddingDim[];
  listWithModelBinding(conn: SqlExecutor): VfsEmbeddingDim[];
  refreshCountsFromSegments(conn: SqlExecutor): void;
}
