/**
 * VFS `files`/`blobs` reads used by `src/cmd/textbooks.rs::vfs_get_file_blob_path`.
 * SQL stays in the lane repository as required by the host boundary rules.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';

/** `SELECT blob_hash FROM files WHERE id = ?1`；无行与 NULL 都返回 null。 */
export function fileBlobHash(conn: SqlExecutor, id: string): string | null {
  return conn.pluck<string | null>('SELECT blob_hash FROM files WHERE id = ?1', [id]) ?? null;
}

/** `VfsBlobRepo::get_blob_with_conn` 的 relative_path 读取；无行返回 null。 */
export function blobRelativePath(conn: SqlExecutor, hash: string): string | null {
  return conn.pluck<string>('SELECT relative_path FROM blobs WHERE hash = ?1', [hash]) ?? null;
}
