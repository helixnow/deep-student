/** vfs/handlers.rs 文件/Blob 读取命令（handlers.rs:2710-2905）。 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { VfsError } from '../../vfs/portable.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import type { VfsIndexMaintenanceService, VfsLanceStore } from '../../vfs-index/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type {
  BlobRepository,
  FileRepository,
  ResourceRepository,
  VfsFile,
} from '../../vfs-repos/api.ts';
import type {
  VfsBlobBase64Result,
  VfsFileContentResult,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';

export interface FileDeps {
  readonly conn: () => DatabaseHandle;
  readonly files: FileRepository;
  readonly blobs: BlobRepository;
  readonly resources: ResourceRepository;
  readonly blobsDir: () => string;
  /** `ctx.files`：blob 字节读取（移动端同一套异步接口）。 */
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly deleteIndex: (resourceId: string) => Promise<void>;
  readonly log: Context['logger'];
}

function fail(error: unknown): never {
  if (error instanceof CommandError) throw error;
  if (error instanceof VfsError) throw new CommandError(error.toString());
  if (error instanceof Error) throw new CommandError(error.message);
  throw error;
}

function readError(prefix: string, error: unknown): Error {
  return new Error(`${prefix}: ${error instanceof Error ? error.message : String(error)}`);
}

export function isFileId(fileId: string): boolean {
  return fileId.startsWith('file_') || fileId.startsWith('tb_');
}

/** handlers.rs:2714-2727 */
export function getFile(deps: FileDeps, fileId: string): VfsFile | null {
  if (!isFileId(fileId)) return fail(new Error(`Invalid file ID format: ${fileId}`));
  try {
    return deps.files.getFile(deps.conn(), fileId);
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:2728-2748 */
export function listFiles(
  deps: FileDeps,
  fileType: string | null,
  limit: number | null,
  offset: number | null,
): VfsFile[] {
  try {
    return fileType === null
      ? deps.files.listFiles(deps.conn(), limit ?? 100, offset ?? 0)
      : deps.files.listFilesByType(deps.conn(), fileType, limit ?? 100, offset ?? 0);
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:2782-2858 */
export async function getFileContent(deps: FileDeps, fileId: string): Promise<VfsFileContentResult> {
  if (!isFileId(fileId)) return fail(new Error(`Invalid file ID format: ${fileId}`));
  try {
    const conn = deps.conn();
    const file = deps.files.getFile(conn, fileId);
    if (file === null) return { content: null, found: false };

    if (file.blobHash !== undefined) {
      const path = deps.blobs.getBlobPath(conn, deps.blobsDir(), file.blobHash);
      if (path !== null) {
        const data = await deps.readBytes(path);
        return { content: toBase64(data), found: true };
      }
    }
    if (file.resourceId !== undefined) {
      const resource = deps.resources.getResource(conn, file.resourceId);
      if (resource !== null && resource.data !== undefined && resource.data !== null) {
        // Legacy inline rows store '' when the upload path never wrote bytes
        // (small files used to skip vfs_blobs). Do not report an empty body as
        // found while the file still points at a blob: the blob read above is
        // authoritative and an empty data column means "no inline content".
        if (resource.data !== '' || file.blobHash === undefined) {
          return { content: resource.data, found: true };
        }
      }
    }
    return { content: null, found: false };
  } catch (error) {
    return fail(error);
  }
}

/** handlers.rs:2858-2904 */
export async function getBlobBase64(deps: FileDeps, blobHash: string): Promise<VfsBlobBase64Result> {
  deps.log.debug('[VFS::handlers] vfs_get_blob_base64: hash=%s', blobHash);
  try {
    let conn: DatabaseHandle;
    try { conn = deps.conn(); } catch (error) { throw readError('获取数据库连接失败', error); }
    let blob;
    try { blob = deps.blobs.getBlob(conn, blobHash); } catch (error) { throw readError('获取 blob 元数据失败', error); }
    if (blob === null) return fail(new Error(`Blob 不存在: ${blobHash}`));
    let path;
    try { path = deps.blobs.getBlobPath(conn, deps.blobsDir(), blobHash); } catch (error) { throw readError('获取 blob 路径失败', error); }
    if (path === null) return fail(new Error(`Blob 文件路径不存在: ${blobHash}`));
    let data: Uint8Array;
    try {
      data = await deps.readBytes(path);
    } catch (error) {
      return fail(readError('读取 blob 文件失败', error));
    }
    deps.log.info('[VFS::handlers] vfs_get_blob_base64: hash=%s, size=%d bytes', blobHash, data.byteLength);
    return {
      base64: toBase64(data),
      mimeType: blob.mimeType ?? 'image/jpeg',
      size: blob.size,
    };
  } catch (error) {
    return fail(error);
  }
}

/**
 * handlers.rs:2750-2782：先做索引清理（失败只警告），再软删除文件。
 */
export async function deleteIndexFull(maintenance: VfsIndexMaintenanceService, lance: VfsLanceStore,
  log: Context['logger'], resourceId: string): Promise<void> {
  const result = maintenance.deleteResourceIndex(resourceId);
  await lance.deleteByResource('text', resourceId);
  await lance.deleteByResource('multimodal', resourceId);
  if (result.deletedUnitCount > 0 || result.lanceRowIds.length > 0) {
    log.info('[VfsIndexService] Full deletion completed for resource %s: %d units, %d vectors',
      resourceId, result.deletedUnitCount, result.lanceRowIds.length);
  }
}

export async function deleteFile(deps: FileDeps, fileId: string): Promise<null> {
  if (!fileId.startsWith('file_')) return fail(new Error(`Invalid file ID format: ${fileId}`));
  let resourceId: string | null;
  try {
    resourceId = deps.files.getResourceIdByFileId(deps.conn(), fileId);
  } catch (error) {
    return fail(error);
  }
  if (resourceId !== null) {
    try {
      await deps.deleteIndex(resourceId);
    } catch (error) {
      deps.log.warn('[VfsFileRepo] Failed to cleanup index for file %s (resource %s): %s',
        fileId, resourceId, error);
    }
  }
  try {
    deps.files.deleteFile(deps.conn(), fileId);
  } catch (error) {
    return fail(error);
  }
  return null;
}
