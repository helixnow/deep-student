/**
 * `src/cmd/textbooks.rs:786-818` `vfs_get_file_blob_path`: resolve a `files`
 * row to its on-disk VFS blob path for `pdfstream://` previews.
 *
 * The Rust command returns `AppError::configuration` when no VFS database is
 * configured and `AppError::database` for every query failure; missing rows,
 * NULL blob hashes and missing files all return `null`.
 */
import { existsSync, realpathSync } from 'node:fs';
import { AppError } from '../../../platform/errors/api.ts';
import type { VfsDatabase } from '../../vfs/api.ts';
import { containedBlobPath, type BlobRealpath } from '../../vfs-index/api.ts';
import { blobRelativePath, fileBlobHash } from '../repository/textbook-files.ts';

export class VfsBlobPathError extends Error {
  readonly appError: ReturnType<typeof AppError.database>;

  constructor(appError: ReturnType<typeof AppError.database>) {
    super(appError.message);
    this.name = 'VfsBlobPathError';
    this.appError = appError;
  }
}

function databaseError(detail: string, error: unknown): VfsBlobPathError {
  const message = error instanceof Error ? error.message : String(error);
  return new VfsBlobPathError(AppError.database(`${detail}: ${message}`));
}

export function getFileBlobPath(
  database: VfsDatabase | undefined,
  id: string,
  fileExists: (path: string) => boolean = existsSync,
  realpath: BlobRealpath = realpathSync,
): string | null {
  if (database === undefined) {
    throw new VfsBlobPathError(AppError.configuration('VFS database not configured'));
  }
  let conn;
  try { conn = database.getConnSafe(); }
  catch (error) {
    throw databaseError('获取 VFS 连接失败', error);
  }
  let hash: string | null;
  try { hash = fileBlobHash(conn, id); }
  catch (error) {
    throw databaseError('查询 blob_hash 失败', error);
  }
  if (hash === null) return null;
  let relativePath: string | null;
  try { relativePath = blobRelativePath(conn, hash); }
  catch (error) {
    throw databaseError('查询 blob 路径失败', error);
  }
  if (relativePath === null) return null;
  // RUST-FIX(RF-W04-blob-relative-path-escape): Rust hands out blobs_dir.join(relative_path) unchecked.
  const path = containedBlobPath(database.blobsDir(), relativePath, realpath);
  return path !== null && fileExists(path) ? path : null;
}
