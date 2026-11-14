/** handlers.rs:1649-1978. Attachment reads/deletion use L11's AttachmentRepository. */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { FileError, type FileOperations } from '../../../platform/files/api.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { FileRepository, FolderRepository, VfsAttachment } from '../../vfs-repos/api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { VfsAttachmentContentResult } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { AttachmentConfig } from '../../vfs/api.ts';
import { containedBlobPath } from '../../vfs-index/api.ts';
import { questionImagePaths } from '../repository/attachment-config.ts';
export interface AttachmentService {
  getById(id: string): VfsAttachment | null;
  resolveFileId(id: string): string | null;
  getContent(id: string): string | null;
  getContentBounded(id: string, maxBytes: number): string | null;
  deleteAttachment(id: string): void;
}
export interface AttachmentDeps {
  /** attachment_config.rs `AttachmentConfig` (L13 `ctx.vfs.attachmentConfig`, stored through L17 memoryConfig). */
  config: Pick<AttachmentConfig, 'getRootFolderId' | 'getRootFolderTitle' | 'setRootFolderId' | 'createRootFolder' | 'getOrCreateRootFolder'>;
  conn(): SqlExecutor;
  blobsDir(): string;
  /** `ctx.files.scope(blobsDir)`：img_ 引用的 blob 读取（作用域内真实路径校验 + 异步读取）。 */
  blobScope(): FileOperations;
  folders: FolderRepository;
  files: FileRepository;
  service?: AttachmentService;
  log: Context['logger'];
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function command<T>(fn: () => T): T { try { return fn(); } catch (error) { throw new CommandError(message(error)); } }
async function asyncCommand<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (error) { throw new CommandError(message(error)); }
}
function service(deps: AttachmentDeps) {
  if (deps.service === undefined) throw new Error('L11 vfsAttachments 服务未发布');
  return deps.service;
}
function valid(id: string, prefixes: string[]) {
  if (!prefixes.some(prefix => id.startsWith(prefix))) throw new Error(`Invalid attachment ID format: ${id}`);
}
export function getConfig(deps: AttachmentDeps) {
  return command(() => {
    const attachmentRootFolderId = deps.config.getRootFolderId();
    return { attachmentRootFolderId, attachmentRootFolderTitle: deps.config.getRootFolderTitle() };
  });
}
export function setRootFolder(deps: AttachmentDeps, id: string) {
  return command(() => {
    if (!deps.folders.folderExists(deps.conn(), id)) throw new Error(`Folder not found: ${id}`);
    deps.config.setRootFolderId(id); return null;
  });
}
export function createRootFolder(deps: AttachmentDeps, title: string) {
  return command(() => deps.config.createRootFolder(title));
}
export function getOrCreateRootFolder(deps: AttachmentDeps) {
  return command(() => deps.config.getOrCreateRootFolder());
}
export function get(deps: AttachmentDeps, id: string) {
  deps.log.debug('[VFS::handlers] vfs_get_attachment: id=%s', id);
  return command(() => { valid(id, ['att_', 'file_']); return service(deps).getById(id); });
}
export function remove(deps: AttachmentDeps, id: string) {
  deps.log.info('[VFS::handlers] vfs_delete_attachment: id=%s', id);
  return command(() => { valid(id, ['att_']); service(deps).deleteAttachment(id); return null; });
}
export function content(deps: AttachmentDeps, id: string, maxBytes: number | null): Promise<VfsAttachmentContentResult> {
  deps.log.info('[VFS::handlers] vfs_get_attachment_content: START id=%s', id);
  return asyncCommand(async () => {
    try { valid(id, ['att_', 'file_', 'tb_', 'img_', 'res_']); }
    catch (error) { deps.log.error('[VFS::handlers] Invalid attachment ID format: %s', id); throw error; }
    if (id.startsWith('res_')) {
      const resolved = service(deps).resolveFileId(id);
      if (resolved === null) {
        deps.log.warn('[VFS::handlers] vfs_get_attachment_content: resource not linked to a file: %s', id);
        return { content: null, found: false };
      }
      deps.log.info('[VFS::handlers] vfs_get_attachment_content: resolved %s -> %s', id, resolved);
      id = resolved;
    }
    if (id.startsWith('img_')) {
      const scope = deps.blobScope();
      for (const { relative, hash } of questionImagePaths(deps.conn(), id, deps.log)) {
        // RUST-FIX(RF-W04-blob-relative-path-escape): Rust reads blobs_dir.join(relative_path) unchecked.
        // Lexical guard first, then the blob scope re-checks the real path (a symlink may not leave blobs_dir).
        if (containedBlobPath(deps.blobsDir(), relative) === null) {
          deps.log.warn('[VFS::handlers] img_ blob path escapes the blob directory: hash=%s', hash);
          continue;
        }
        let size: number;
        try {
          size = (await scope.stat(relative)).size;
        } catch (error) {
          if (error instanceof FileError && error.kind === 'OutsideRoots') {
            deps.log.warn('[VFS::handlers] img_ blob path escapes the blob directory: hash=%s', hash);
          } else {
            deps.log.warn('[VFS::handlers] img_ blob file not found: %s', relative);
          }
          continue;
        }
        if (maxBytes !== null && size > maxBytes) {
          throw new Error(`attachment content exceeds preview limit: ${size} > ${maxBytes} bytes`);
        }
        try {
          const data = await scope.readBytes(relative);
          deps.log.info('[VFS::handlers] vfs_get_attachment_content: img_ resolved via blob hash=%s, size=%d', hash, data.byteLength);
          return { content: toBase64(data), found: true };
        }
        catch (error) { deps.log.warn('[VFS::handlers] img_ blob read failed: %s', message(error)); }
      }
      deps.log.warn('[VFS::handlers] vfs_get_attachment_content: img_ ID not resolved: %s', id);
      return { content: null, found: false };
    }
    const metadata = deps.files.getFile(deps.conn(), id);
    deps.log.info('[VFS::handlers] vfs_get_attachment_content: file meta for %s: resource_id=%s, blob_hash=%s, original_path=%s',
      id, metadata?.resourceId ?? null, metadata?.blobHash ?? null, metadata?.originalPath ?? null);
    try {
      const value = maxBytes === null ? service(deps).getContent(id) : service(deps).getContentBounded(id, maxBytes);
      if (value === null) deps.log.warn('[VFS::handlers] vfs_get_attachment_content: NOT FOUND id=%s', id);
      else deps.log.info('[VFS::handlers] vfs_get_attachment_content: SUCCESS id=%s, content_len=%d', id, utf8ByteLength(value));
      return { content: value, found: value !== null };
    } catch (error) {
      deps.log.error('[VFS::handlers] vfs_get_attachment_content: ERROR id=%s, error=%s', id, message(error));
      return { content: null, found: false, error: message(error) };
    }
  });
}
