import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { ClearMediaCacheParams } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import * as repo from '../repository/media-cache.ts';
import { requireMaintenance, type VfsMaintenanceService } from './maintenance-needs.ts';
import { clearVectorCacheDirectory, type VectorCacheFiles } from './vector-cache-files.ts';
export interface MediaCacheDeps {
  maintenance?: VfsMaintenanceService;
  conn(): SqlExecutor;
  blobsDir(): string;
  repos: VfsReposService;
  /** `ctx.files`：Lance 缓存目录的统计与删除（移动端同一套异步接口）。 */
  files: VectorCacheFiles & repo.MediaCacheFiles;
  log: Context['logger'];
}
function command<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
}
async function asyncCommand<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) { throw new CommandError(error instanceof Error ? error.message : String(error)); }
}
export function stats(deps: MediaCacheDeps) {
  deps.log.info('[VFS::handlers] vfs_get_media_cache_stats: Starting...');
  return asyncCommand(async () => {
    const stats = await repo.mediaCacheStats(deps.conn(), deps.blobsDir(), message => deps.log.warn(message), deps.files);
    deps.log.info('[VFS::handlers] vfs_get_media_cache_stats: total_size=%d bytes, pdf_preview=%d, compressed=%d, ocr=%d, vector=%d',
      stats.totalSize, stats.pdfPreviewCount, stats.compressedImageCount, stats.ocrTextCount, stats.vectorIndexCount);
    return stats;
  });
}
export function clear(deps: MediaCacheDeps, params: ClearMediaCacheParams) {
  deps.log.info('[VFS::handlers] vfs_clear_media_cache: pdf=%s, compressed=%s, ocr=%s, vector=%s', params.clearPdfPreview, params.clearCompressedImages, params.clearOcrText, params.clearVectorIndex);
  return asyncCommand(async () => {
    const result = await requireMaintenance(deps.maintenance)
      .clearMediaCache(params, lanceDir => clearVectorCacheDirectory(deps.files, lanceDir));
    deps.log.info('[VFS::handlers] vfs_clear_media_cache: Complete! freed %d bytes, reset %d files', result.totalBytesFreed, result.filesReset);
    return result;
  });
}
export function ocrInfo(deps: MediaCacheDeps, id: string) {
  deps.log.info('[VFS::handlers] vfs_get_resource_ocr_info: resource_id=%s', id);
  return command(() => repo.resourceOcrInfo(deps.conn(), id, message => deps.log.warn(message)));
}
export function clearOcr(deps: MediaCacheDeps, id: string) {
  deps.log.info('[VFS::handlers] vfs_clear_resource_ocr: resource_id=%s', id);
  return command(() => {
    requireMaintenance(deps.maintenance).clearResourceOcr(id);
    try { deps.repos.indexStates.markPending(deps.conn(), id); }
    catch (error) { deps.log.warn('[VFS::handlers] Failed to mark resource as pending after OCR clear: %s', String(error)); }
    deps.log.info('[VFS::handlers] Cleared OCR data for resource %s and marked as pending', id);
    return true;
  });
}
export function textChunks(deps: MediaCacheDeps, id: string) {
  deps.log.info('[VFS::handlers] vfs_get_resource_text_chunks: resource_id=%s', id);
  return command(() => {
    const chunks = repo.resourceTextChunks(deps.conn(), id);
    deps.log.info('[VFS::handlers] Found %d text chunks for resource %s', chunks.length, id);
    return chunks;
  });
}
export type { ClearMediaCacheParams };
