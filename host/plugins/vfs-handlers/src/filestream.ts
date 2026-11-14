/** file_stream_protocol.rs:215-299,719-741. Whitelist roots are owned by F2 Main. */
import * as path from '../../../platform/util/path.ts';
import { FileError, type FileKind, type FileScope } from '../../../platform/files/api.ts';
import type { Context } from '@deepseek-ai/cordis';

/** `ctx.files` 中访问检查用到的部分（移动端同一套异步语义）。 */
export interface FilestreamFiles {
  stat(path: string, options?: { readonly followSymlinks?: boolean }): Promise<{ readonly kind: FileKind }>;
  /** 只能对允许根内的目录建作用域；根外目录抛 `OutsideRoots`。 */
  scope(directory: string): FileScope;
}

const extensions = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac', 'aac', 'opus', 'weba', 'aiff', 'aif', 'caf',
  'mp4', 'webm', 'mov', 'm4v', 'ogv', 'mpg', 'mpeg', '3gp', 'mkv', 'avi',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'pdf', 'bin']);
export function isAllowedMediaExtension(extension: string): boolean { return extensions.has(extension.toLowerCase()); }
function comparable(value: string, windows: boolean): string {
  return windows ? value.replaceAll('/', '\\').replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '').toLowerCase() : value;
}
function relative(file: string, root: string, windows: boolean): string | null {
  const api = windows ? path.win32 : path.posix;
  const rel = api.relative(comparable(root, windows), comparable(file, windows));
  return rel === '..' || rel.startsWith(`..${api.sep}`) || api.isAbsolute(rel) ? null : rel;
}
export function hasHiddenSegmentWithin(file: string, roots: readonly string[], windows = false): boolean {
  const matched = roots.filter(root => relative(file, root, windows) !== null)
    .sort((a, b) => b.split(windows ? /[\\/]/ : /\//).length - a.split(windows ? /[\\/]/ : /\//).length);
  if (!matched.length) return true;
  return relative(file, matched[0]!, windows)!.split(windows ? /[\\/]/ : /\//).some(segment => segment.startsWith('.'));
}
export function extensionPermitted(file: string, blobs: readonly string[], windows = false): boolean {
  if (blobs.some(root => relative(file, root, windows) !== null)) return true;
  return isAllowedMediaExtension((windows ? path.win32 : path.posix).extname(file).slice(1));
}

/**
 * 真实路径与“普通文件”判定交给 `ctx.files` 作用域：作用域对目标做真实路径包含判断，
 * 符号链接不能借它离开根目录（替代 Rust 的 `canonicalize` + `metadata().is_file()`）。
 * 白名单根不在允许根内（桌面 `~/Documents` 等）时 `ctx.files` 无法为其建作用域，
 * 此时只做词法包含判断；移动端没有这类根。
 */
async function isRegularFileWithin(files: FilestreamFiles, root: string, file: string, windows: boolean): Promise<boolean> {
  let scope: FileScope;
  try { scope = files.scope(root); } catch (error) {
    if (error instanceof FileError && error.kind === 'OutsideRoots') return true;
    return false;
  }
  // The whitelist root may be spelled differently from the scope root (Windows verbatim prefix).
  const rel = relative(file, scope.root, windows) ?? relative(file, root, windows);
  if (rel === null) return false;
  try { return (await scope.stat(rel)).kind === 'file'; } catch { return false; }
}

export async function checkAccess(
  files: FilestreamFiles,
  file: string,
  roots: readonly string[],
  blobs: readonly string[],
  windows = false,
): Promise<boolean> {
  if (file === '') return false;
  const matched = roots.filter(root => relative(file, root, windows) !== null)
    .sort((a, b) => b.split(windows ? /[\\/]/ : /\//).length - a.split(windows ? /[\\/]/ : /\//).length);
  if (!matched.length) return false;
  if (hasHiddenSegmentWithin(file, roots, windows)) return false;
  if (!extensionPermitted(file, blobs, windows)) return false;
  return isRegularFileWithin(files, matched[0]!, file, windows);
}

/**
 * Rust `canonicalize` fails for an empty or missing path (before the Shell request).
 * Paths outside every allowed root cannot be probed by `ctx.files`; the whitelist decides them.
 */
async function canonicalizable(files: FilestreamFiles, file: string): Promise<boolean> {
  if (file === '') return false;
  try { await files.stat(file); return true; }
  catch (error) { return error instanceof FileError && error.kind === 'OutsideRoots'; }
}

export async function filestreamCheckAccess(ctx: Context, file: string, blobsDir: string, files: FilestreamFiles): Promise<boolean> {
  // Rust canonicalizes before resolving the whitelist.
  if (!(await canonicalizable(files, file))) return false;
  const roots = await ctx.shell.request<string[]>('app.pdfStreamAllowedDirs', {});
  return checkAccess(files, file, [...roots, blobsDir], [blobsDir], ctx.app.platform === 'win32');
}
