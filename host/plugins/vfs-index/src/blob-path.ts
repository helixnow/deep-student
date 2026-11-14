/**
 * Read-side guard for `blobs.relative_path`. The column travels through record sync, so a
 * remote peer can rewrite it; joining it onto `vfs_blobs` unchecked lets `../` or an absolute
 * path point a read at any file the app can open.
 *
 * Same rule as Rust's deletion guard `VfsBlobRepo::safe_blob_path` (`blob_repo.rs:894`) and the
 * vfs-repos `BlobRepository.resolveBlobPath`, plus a realpath check on the final target so a
 * last-component symbolic link cannot leave `vfs_blobs` either. Kept here rather than calling
 * vfs-repos: that one needs `node:fs`, so callers inject `realpath` instead.
 */
import { isAbsolute, join, posix, relative, sep, win32 } from '../../../platform/util/path.ts';

/** Synchronous `realpath` that throws with `code: 'ENOENT'` for a missing path, like `fs.realpathSync`. */
export type BlobRealpath = (path: string) => string;

/**
 * 真实路径包含判断（异步）：相对路径在 `blobsDir` 内且真实路径仍不越界时返回 true。
 * 由 `ctx.files` 作用域实现（移动端同一套语义）；目标不存在也算包含（没有东西能把它引到别处）。
 */
export type BlobConfine = (relativePath: string) => Promise<boolean>;

const DRIVE_PREFIX = /^[A-Za-z]:/;

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function strictlyInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * `blobsDir` joined with `relativePath`, or null when the stored path is empty, absolute
 * (POSIX, drive or UNC form), has a `..` segment under either separator, or resolves outside
 * `blobsDir` through a symbolic link. Without `realpath` only the lexical checks run. A target
 * that does not exist yet keeps the joined path: nothing on disk can redirect it.
 */
// RUST-FIX(RF-W04-blob-relative-path-escape): Rust only guards deletions; reads join relative_path unchecked.
export function containedBlobPath(blobsDir: string, relativePath: string, realpath?: BlobRealpath): string | null {
  if (relativePath === '' || relativePath.includes('\u0000')) return null;
  if (posix.isAbsolute(relativePath) || win32.isAbsolute(relativePath) || DRIVE_PREFIX.test(relativePath)) return null;
  if (relativePath.split(/[\\/]/).some((part) => part === '..')) return null;
  const path = join(blobsDir, relativePath);
  if (!strictlyInside(blobsDir, path)) return null;
  if (realpath === undefined) return path;
  let realTarget: string;
  try {
    realTarget = realpath(path);
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? path : null;
  }
  let realRoot: string;
  try {
    realRoot = realpath(blobsDir);
  } catch {
    return null;
  }
  return strictlyInside(realRoot, realTarget) ? path : null;
}

/**
 * `containedBlobPath` 的异步版本：词法规则相同，再用 `BlobConfine`（`ctx.files` 作用域）
 * 判断真实路径。`confine` 抛错视为越界。
 */
export async function containedBlobPathAsync(
  blobsDir: string,
  relativePath: string,
  confine?: BlobConfine,
): Promise<string | null> {
  const lexical = containedBlobPath(blobsDir, relativePath);
  if (lexical === null || confine === undefined) return lexical;
  try {
    return (await confine(relativePath)) ? lexical : null;
  } catch {
    return null;
  }
}
