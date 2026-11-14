/** index_handlers.rs: thin command mapping over L11 repositories and L12 indexing. */
import { CommandError } from '../../../kernel/api.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { VfsReposService, VfsIndexUnit } from '../../vfs-repos/api.ts';
import type { VfsIndexService, VfsIndexMaintenanceService, UnitBuilderService } from '../../vfs-index/api.ts';
import type { Commands, DeleteIndexResult, UnitIndexStatus,
  dstu_vfs__vfs__index_service__IndexStatusSummary as Summary,
  EmbeddingDimInfo } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import { allIndexStatus, type IndexStatusArgs } from '../repository/index-status.ts';
import { indexDiagnostics } from '../repository/index-diagnostics.ts';

export type SyncUnitInput = Commands['vfs_sync_resource_units']['args'];
export type { UnitBuilderService } from '../../vfs-index/api.ts';
export interface MultimodalBatchService { processPendingBatch(limit: number): Promise<[number, number]> }
export interface IndexAdminDeps {
  maintenance: VfsIndexMaintenanceService;
  log: Context['logger'];
  conn(): DatabaseHandle;
  repos: VfsReposService;
  index: VfsIndexService;
  vectorAvailable: boolean;
  unitBuilder?: UnitBuilderService;
  multimodalBatch?: MultimodalBatchService;
}
export const VECTOR_UNAVAILABLE = '此版本不包含向量索引，无需建立索引：资料检索会自动使用关键词搜索。';
function requireVector(deps: IndexAdminDeps): void {
  if (!deps.vectorAvailable) throw new Error(VECTOR_UNAVAILABLE);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function fail(error: unknown): never { throw error instanceof CommandError ? error : new CommandError(message(error)); }
export function getAllIndexStatus(deps: IndexAdminDeps, args: IndexStatusArgs) {
  deps.log.info('[VFS::handlers] vfs_get_all_index_status: folder=%s, type=%s, state=%s', args.folderId ?? null, args.resourceType ?? null, args.stateFilter ?? null);
  try { return allIndexStatus(deps.conn(), args, deps.log); } catch (error) { return fail(error); }
}
export function debugIndexStatus(deps: IndexAdminDeps, resourceId: string | null) {
  deps.log.info('[VFS::handlers] vfs_debug_index_status: resource_id=%s', resourceId);
  try { return indexDiagnostics(deps.conn(), deps.log); } catch (error) { return fail(error); }
}
export type { IndexStatusArgs };

function unitStatus(unit: VfsIndexUnit): UnitIndexStatus {
  return { unitId: unit.id, resourceId: unit.resourceId, unitIndex: unit.unitIndex,
    hasImage: unit.imageBlobHash !== null, hasText: unit.textContent !== null, textSource: unit.textSource,
    textRequired: unit.textRequired, textState: unit.textState, textError: unit.textError,
    textChunkCount: unit.textChunkCount, textEmbeddingDim: unit.textEmbeddingDim,
    mmRequired: unit.mmRequired, mmState: unit.mmState, mmError: unit.mmError,
    mmEmbeddingDim: unit.mmEmbeddingDim, updatedAt: unit.updatedAt };
}
export function getStatus(deps: IndexAdminDeps): Summary {
  try {
    // index_handlers.rs vfs_unified_index_status -> L12 index_service.rs::get_status_summary.
    if (deps.index.getStatusSummary === undefined) throw new Error('vfsIndex.getStatusSummary is not available');
    return deps.index.getStatusSummary();
  } catch (error) { return fail(error); }
}
export function getResourceUnits(deps: IndexAdminDeps, resourceId: string): UnitIndexStatus[] {
  try { return deps.repos.embeddingUnits.getByResource(deps.conn(), resourceId).map(unitStatus); }
  catch (error) { return fail(error); }
}
export function listDimensions(deps: IndexAdminDeps): EmbeddingDimInfo[] {
  try { return deps.repos.embeddingDims.listAll(deps.conn()).map(d => ({ dimension: d.dimension,
    modality: d.modality, lanceTableName: d.lanceTableName, recordCount: d.recordCount })); }
  catch (error) { return fail(error); }
}
export function reindexUnit(deps: IndexAdminDeps, id: string, mode: string): boolean {
   try { requireVector(deps); deps.maintenance.resetUnitIndex(id, mode); return true; }
  catch (error) { return fail(error); }
}
export function syncResourceUnits(deps: IndexAdminDeps, input: SyncUnitInput): UnitIndexStatus[] {
  try {
    if (deps.unitBuilder === undefined) throw new Error('vfsUnitBuilder 未发布 syncResourceUnits');
    return deps.unitBuilder.syncResourceUnits(input).map(unitStatus);
  } catch (error) { return fail(error); }
}
export async function batchIndex(deps: IndexAdminDeps, mode: string, size: number | null) {
  try {
    requireVector(deps);
    const limit = Math.min(100, Math.max(1, size ?? 10));
    deps.log.info('[VFS::index_handlers] vfs_unified_batch_index: mode=%s, batch_size=%d (raw=%d)', mode, limit, size ?? 10);
    if (!['text', 'mm', 'both'].includes(mode)) {
      throw new Error(`vfs_unified_batch_index: unsupported mode '${mode}'; expected text, mm, or both`);
    }
    let successCount = 0;
    let failCount = 0;
    if (mode === 'text' || mode === 'both') {
      deps.index.indexing.getIndexingConfig();
      const [success, fail] = await deps.index.indexing.processPendingBatch(limit);
      successCount += success; failCount += fail;
    }
    if (mode === 'mm' || mode === 'both') {
      if (deps.multimodalBatch === undefined) throw new Error('vfsIndex.multimodal 未发布 processPendingBatch');
      const [success, fail] = await deps.multimodalBatch.processPendingBatch(limit);
      successCount += success; failCount += fail;
    }
    deps.log.info('[VFS::index_handlers] vfs_unified_batch_index completed: mode=%s, success=%d, fail=%d', mode, successCount, failCount);
    return { successCount, failCount, total: successCount + failCount };
  } catch (error) { return fail(error); }
}
export async function deleteResourceIndex(deps: IndexAdminDeps, id: string): Promise<DeleteIndexResult> {
  deps.log.info('[VFS::index_handlers] vfs_delete_resource_index: resource_id=%s', id);
  const result: DeleteIndexResult = { sqliteOk: false, lanceTextOk: false, lanceMmOk: false, warnings: [], retryable: false };
  try { deps.maintenance.deleteResourceIndex(id); result.sqliteOk = true; }
  catch (error) { result.warnings.push(`SQLite deletion failed: ${message(error)}`); result.retryable = true; return result; }
  for (const modality of ['text', 'multimodal'] as const) {
    try {
      await deps.index.lance.deleteByResource(modality, id);
      if (modality === 'text') result.lanceTextOk = true; else result.lanceMmOk = true;
    } catch (error) {
      deps.log.warn(`[VFS::index_handlers] Failed to delete ${modality} vectors for resource %s: %s`, id, message(error));
      result.warnings.push(`Failed to delete ${modality} vectors: ${message(error)}`);
      result.retryable = true;
    }
  }
  return result;
}
