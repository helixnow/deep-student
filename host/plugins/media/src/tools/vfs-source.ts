/**
 * `{Docx,Pptx,Xlsx}ToolExecutor::load_*_bytes`: VFS `files` row → local
 * `original_path` (skipping virtual URIs and `..` traversal, and content other
 * than the recorded `sha256`) → `blob_hash` blob → `sha256` blob. Blob lookup
 * failures fall through, as the Rust `if let Ok(Some(path))` does; only the
 * final read reports an error.
 */
import { readFile, stat } from 'node:fs/promises';
import { sha256HexSync } from '../../../../platform/crypto/sync.ts';
import { isVirtualUri } from '../../../../platform/storage/file-names.ts';
import type { VfsDatabase } from '../../../vfs/api.ts';
import type { VfsReposService } from '../../../vfs-repos/api.ts';
import { errorText, type ToolLogger } from './runtime.ts';

export type VfsFileRepos = Pick<VfsReposService, 'files' | 'blobs'>;

function blobPath(
  database: VfsDatabase, repos: VfsFileRepos, hash: string,
): string | null {
  try { return repos.blobs.getBlobPath(database.getConnSafe(), database.blobsDir(), hash); }
  catch { return null; }
}

/** Copies keep the source digest as a prefix (`<sha256>_copy_<id>`), so only the leading 64 hex digits count. */
function isRecordedContent(sha256: string, bytes: Uint8Array): boolean {
  const recorded = /^[0-9a-f]{64}/i.exec(sha256.trim())?.[0];
  return recorded !== undefined && recorded.toLowerCase() === sha256HexSync(bytes);
}

/** `Path::exists`: any metadata error counts as absent. */
async function exists(path: string): Promise<boolean> {
  return await stat(path).then(() => true, () => false);
}

export async function loadVfsFileBytes(
  database: VfsDatabase | null,
  repos: VfsFileRepos,
  resourceId: string,
  executorName: string,
  log: ToolLogger,
): Promise<Buffer> {
  if (database === null) throw new Error('VFS database not available');
  let file;
  try { file = repos.files.getFile(database.getConnSafe(), resourceId); }
  catch (error) { throw new Error(`VFS 查询失败: ${errorText(error)}`); }
  if (file === null) throw new Error(`文件不存在: ${resourceId}`);

  const originalPath = file.originalPath;
  if (originalPath !== undefined) {
    if (isVirtualUri(originalPath)) {
      log.debug(`[${executorName}] Skipping virtual URI original_path: ${originalPath}`);
    } else if (originalPath.replaceAll('\\', '/').split('/').some(segment => segment === '..')) {
      log.warn(`[${executorName}] Rejecting original_path with traversal: ${originalPath}`);
    } else if (await exists(originalPath)) {
      let bytes: Buffer;
      try { bytes = await readFile(originalPath); }
      catch (error) { throw new Error(`文件读取失败: ${errorText(error)}`); }
      // RUST-FIX(RF-W04-office-original-path-content): Rust returns whatever file a synced original_path names.
      if (isRecordedContent(file.sha256, bytes)) return bytes;
      log.warn(`[${executorName}] Ignoring original_path whose content is not the recorded file: ${originalPath}`);
    }
  }

  if (file.blobHash !== undefined) {
    const path = blobPath(database, repos, file.blobHash);
    if (path !== null) {
      try { return await readFile(path); }
      catch (error) { throw new Error(`Blob 读取失败: ${errorText(error)}`); }
    }
  }

  if (file.sha256 !== '') {
    const path = blobPath(database, repos, file.sha256);
    if (path !== null) {
      try { return await readFile(path); }
      catch (error) { throw new Error(`Blob 读取失败 (sha256): ${errorText(error)}`); }
    }
  }

  throw new Error(`无法加载文件内容: ${resourceId} (无可用 blob_hash 或 original_path)`);
}
