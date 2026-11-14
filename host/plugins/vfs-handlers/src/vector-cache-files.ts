/** handlers.rs:7161-7178,7295-7309. Invoked by L11 after OCR and before vector SQL. */
import { join } from '../../../platform/util/path.ts';
import type { FileKind } from '../../../platform/files/api.ts';
import type { VectorCacheFileClearResult } from '../../vfs-repos/api.ts';

/** `ctx.files` 中此文件用到的部分（移动端同一套异步语义）。 */
export interface VectorCacheFiles {
  exists(path: string): Promise<boolean>;
  stat(path: string, options?: { readonly followSymlinks?: boolean }): Promise<{ readonly kind: FileKind; readonly size: number }>;
  readDir(path: string): Promise<readonly { readonly name: string }[]>;
  rm(path: string, options?: { readonly recursive?: boolean; readonly force?: boolean }): Promise<void>;
}

async function isDirectory(files: VectorCacheFiles, path: string): Promise<boolean> {
  // Rust Path::is_dir: any metadata error is `false`.
  try { return (await files.stat(path)).kind === 'directory'; } catch { return false; }
}

async function directoryBytes(files: VectorCacheFiles, path: string): Promise<bigint> {
  if (!(await isDirectory(files, path))) return 0n;
  let size = 0n;
  for (const entry of await files.readDir(path)) {
    const child = join(path, entry.name);
    if (await isDirectory(files, child)) size += await directoryBytes(files, child);
    else size += BigInt((await files.stat(child, { followSymlinks: false })).size);
  }
  return size;
}

/**
 * Rust `remove_dir_all` rejects a regular file at the directory path; `ctx.files.rm` without
 * `recursive` would delete it, so keep Rust's failure instead of widening the delete.
 */
async function removeDirectoryAll(files: VectorCacheFiles, path: string, kind: FileKind): Promise<void> {
  if (kind !== 'directory' && kind !== 'symlink') {
    throw new Error(`Failed to remove directory tree ${path}: not a directory`);
  }
  await files.rm(path, { recursive: true });
}

export async function clearVectorCacheDirectory(
  files: VectorCacheFiles,
  lanceDir: string,
): Promise<VectorCacheFileClearResult> {
  if (!(await files.exists(lanceDir))) return { existed: false, removed: false, bytesFreed: 0 };
  let size: bigint;
  try { size = await directoryBytes(files, lanceDir); }
  catch { size = 0n; } // Rust calculate_dir_size(...).unwrap_or(0); still attempt deletion.
  const entry = await files.stat(lanceDir, { followSymlinks: false });
  await removeDirectoryAll(files, lanceDir, entry.kind); // Owner catches, warns, then continues vector SQL.
  // L11's published VectorCacheFileClearResult represents the count as number.
  return { existed: true, removed: true, bytesFreed: Number(size) };
}
