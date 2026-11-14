/** vfs/index_service.rs; SQLite writes go through L11's published owner repositories. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { CreateSegmentInput, VfsIndexUnit } from '../../vfs-repos/api.ts';
import type { VfsDatabase } from '../api.ts';
import { vfsRepositories } from '../repository/services.ts';
import { VfsError } from './error.ts';
import { UnitBuilderRegistry, type UnitBuildInput } from './unit-builders.ts';
import { transcriptUnitsForResource } from './media-index.ts';

export interface DeleteIndexResult { resourceId: string; deletedUnitCount: number; lanceRowIds: string[] }
export interface UnitIndexLog { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void }
export interface IndexLanceDeletion { deleteByResource(modality: string, resourceId: string): Promise<number> }

export class VfsUnitIndexService {
  readonly builders = new UnitBuilderRegistry();
  readonly database: VfsDatabase;
  readonly log: UnitIndexLog;
  constructor(database: VfsDatabase, log: UnitIndexLog) {
    this.database = database;
    this.log = log;
  }
  syncResourceUnits(input: UnitBuildInput): VfsIndexUnit[] {
    const conn = this.database.getConn();
    const units = this.syncResourceUnitsWithConn(conn, input);
    if (units.length > 0) vfsRepositories().indexStates.setIndexState(conn, input.resourceId, 'pending', null, null);
    return units;
  }
  syncResourceUnitsWithConn(conn: SqlExecutor, input: UnitBuildInput): VfsIndexUnit[] {
    const transcript = input.resourceType === 'file' ? transcriptUnitsForResource(conn, input.resourceId) : null;
    const units = transcript ?? this.builders.build(input)?.units;
    if (units === undefined) throw new VfsError('InvalidArgument', { param: 'resource_type', reason: `Unsupported resource type: ${input.resourceType}` });
    const result = vfsRepositories().embeddingUnits.syncUnits(conn, input.resourceId, units);
    if (result.orphanedLanceRowIds.length > 0) this.log.info(
      '[VfsIndexService] sync_resource_units: %s stale LanceDB vectors for resource %s enqueued into __lance_orphan_queue',
      result.orphanedLanceRowIds.length, input.resourceId);
    return result.units;
  }
  getResourceUnits(id: string) {
    return vfsRepositories().embeddingUnits.getByResource(this.database.getConn(), id).map(u => ({
      unitId: u.id, resourceId: u.resourceId, unitIndex: u.unitIndex, hasImage: u.imageBlobHash !== null,
      hasText: u.textContent !== null, textSource: u.textSource, textRequired: u.textRequired,
      textState: u.textState, textError: u.textError, textChunkCount: u.textChunkCount, textEmbeddingDim: u.textEmbeddingDim,
      mmRequired: u.mmRequired, mmState: u.mmState, mmError: u.mmError, mmEmbeddingDim: u.mmEmbeddingDim, updatedAt: u.updatedAt,
    }));
  }
  getStatusSummary() {
    const conn = this.database.getConn(), repos = vfsRepositories();
    const s = repos.embeddingUnits.getStats(conn);
    return { totalUnits: s.total,
      textStats: { pending: s.textPending, indexing: s.textIndexing, indexed: s.textIndexed, failed: s.textFailed, disabled: s.textDisabled },
      mmStats: { pending: s.mmPending, indexing: s.mmIndexing, indexed: s.mmIndexed, failed: s.mmFailed, disabled: s.mmDisabled },
      dimensions: repos.embeddingSegments.getModalityDimStats(conn).map(d => ({ dimension: d.embeddingDim, modality: d.modality, count: d.count })) };
  }
  listPendingText(limit: number) { return vfsRepositories().embeddingUnits.listPendingText(this.database.getConn(), limit); }
  listPendingMm(limit: number) { return vfsRepositories().embeddingUnits.listPendingMm(this.database.getConn(), limit); }
  setTextIndexing(id: string) { vfsRepositories().embeddingUnits.setTextState(this.database.getConn(), id, 'indexing', null); }
  setTextIndexed(id: string, count: number, dim: number) { vfsRepositories().embeddingUnits.setTextIndexed(this.database.getConn(), id, count, dim); }
  setTextFailed(id: string, error: string) { vfsRepositories().embeddingUnits.setTextState(this.database.getConn(), id, 'failed', error); }
  setMmIndexing(id: string) { vfsRepositories().embeddingUnits.setMmState(this.database.getConn(), id, 'indexing', null); }
  setMmIndexed(id: string, dim: number) { vfsRepositories().embeddingUnits.setMmIndexed(this.database.getConn(), id, dim); }
  setMmFailed(id: string, error: string) { vfsRepositories().embeddingUnits.setMmState(this.database.getConn(), id, 'failed', error); }
  resetUnitIndex(id: string, mode: string): void {
    const conn = this.database.getConn(), repos = vfsRepositories();
    conn.exec('BEGIN IMMEDIATE');
    try {
      const unit = repos.embeddingUnits.getById(conn, id);
      if (unit === null) throw new VfsError('NotFound', { resource_type: 'Unit', id });
      if (!['text', 'mm', 'both'].includes(mode)) throw new VfsError('Other', `unsupported index reset mode '${mode}'; expected text, mm, or both`);
      if (mode !== 'mm') {
        repos.embeddingUnits.setTextState(conn, id, unit.textRequired ? 'pending' : 'disabled', null);
        if (unit.textRequired) repos.indexStates.setIndexState(conn, unit.resourceId, 'pending', null, null);
      }
      if (mode !== 'text') {
        const pending = unit.mmRequired && unit.imageBlobHash !== null;
        repos.embeddingUnits.setMmState(conn, id, pending ? 'pending' : 'disabled', null);
        if (pending) repos.indexStates.setMmIndexState(conn, unit.resourceId, 'pending', null);
      }
      conn.exec('COMMIT');
    } catch (error) {
      try { conn.exec('ROLLBACK'); }
      catch (rollbackError) { this.log.warn('[VfsIndexService] reset rollback failed: %s', rollbackError); }
      throw error;
    }
  }
  deleteResourceIndex(id: string): DeleteIndexResult {
    const conn = this.database.getConn(), repos = vfsRepositories();
    const units = repos.embeddingUnits.getByResource(conn, id);
    const lanceRowIds = units.flatMap(u => repos.embeddingSegments.listLanceRowIdsByUnit(conn, u.id));
    repos.embeddingUnits.purgeIndexArtifactsByResource(conn, id);
    repos.embeddingDims.refreshCountsFromSegments(conn);
    if (lanceRowIds.length > 0) this.log.info('[VfsIndexService] Deleted %s units, %s LanceDB row IDs pending for resource %s', units.length, lanceRowIds.length, id);
    return { resourceId: id, deletedUnitCount: units.length, lanceRowIds };
  }
  async deleteResourceIndexFull(id: string, lance: IndexLanceDeletion): Promise<DeleteIndexResult> {
    const result = this.deleteResourceIndex(id);
    await lance.deleteByResource('text', id);
    await lance.deleteByResource('multimodal', id);
    if (result.deletedUnitCount > 0 || result.lanceRowIds.length > 0) this.log.info(
      '[VfsIndexService] Full deletion completed for resource %s: %s units, %s vectors', id, result.deletedUnitCount, result.lanceRowIds.length);
    return result;
  }
  createSegment(input: CreateSegmentInput) { return vfsRepositories().embeddingSegments.create(this.database.getConn(), input); }
  batchCreateSegments(inputs: CreateSegmentInput[]) { return vfsRepositories().embeddingSegments.batchCreate(this.database.getConn(), inputs); }
  registerDimension(dim: number, modality: string): void { vfsRepositories().embeddingDims.register(this.database.getConn(), dim, modality); }
  listDimensions() { return vfsRepositories().embeddingDims.listAll(this.database.getConn()); }
  getUnitById(id: string) { return vfsRepositories().embeddingUnits.getById(this.database.getConn(), id); }
}
