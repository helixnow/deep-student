/**
 * `pdfstream_check_access`（src-tauri/src/commands.rs:4213-4264）。
 *
 * 校验顺序与 `dstu-vfs/src/pdf_protocol.rs` 的 pdfstream 协议一致：
 * canonicalize → 目录白名单（含 VFS blobs） → `.pdf` 扩展名 → 常规文件。
 */
import { realpathSync, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { formatIoError } from './shell/errors.ts';
import type { ShellPlatform } from './shell/tauri-config.ts';

export interface PdfStreamAccess {
  available: boolean;
  size: number | null;
  reason: string | null;
}

/** Rust `windows_comparable_path_text`：去 verbatim/UNC 前缀、统一斜杠、去尾分隔符、大小写折叠。 */
export function windowsComparablePathText(path: string): string {
  const unified = path.replaceAll('/', '\\');
  const stripped = unified.startsWith('\\\\?\\UNC\\')
    ? `\\\\${unified.slice('\\\\?\\UNC\\'.length)}`
    : unified.startsWith('\\\\?\\')
      ? unified.slice('\\\\?\\'.length)
      : unified;
  return stripped.replace(/\\+$/, '').toLowerCase();
}

/** Rust `windows_path_starts_with` / `Path::starts_with` 的组件边界判定。 */
export function pathIsWithin(path: string, dir: string, platform: ShellPlatform): boolean {
  if (platform !== 'win32') {
    const relative = posix.relative(dir, path);
    return relative === '' || (!relative.startsWith(`..${posix.sep}`) && relative !== '..' && !posix.isAbsolute(relative));
  }
  const comparablePath = windowsComparablePathText(path);
  const comparableDir = windowsComparablePathText(dir);
  if (comparableDir === '') return false;
  if (comparablePath === comparableDir) return true;
  return comparablePath.startsWith(`${comparableDir}\\`);
}

function denied(reason: string): PdfStreamAccess {
  return { available: false, size: null, reason };
}

export function checkPdfStreamAccess(path: string, allowedDirs: readonly string[], platform: ShellPlatform): PdfStreamAccess {
  let canonical: string;
  try {
    canonical = realpathSync.native(path);
  } catch (error) {
    return denied(`文件不存在或不可读: ${formatIoError(error, platform)}`);
  }

  const allowed = allowedDirs.map((dir) => {
    try {
      return realpathSync.native(dir);
    } catch {
      return dir;
    }
  });
  if (!allowed.some((dir) => pathIsWithin(canonical, dir, platform))) {
    return denied('路径不在 pdfstream 白名单目录内');
  }

  const extension = (platform === 'win32' ? win32 : posix).extname(canonical);
  if (extension.toLowerCase() !== '.pdf') return denied('非 PDF 文件');

  let size: number | null;
  try {
    const metadata = statSync(canonical);
    if (!metadata.isFile()) return denied('路径不是常规文件');
    size = metadata.size;
  } catch {
    // Rust：canonicalize 已成功，metadata 失败时 available=true、size=None。
    return { available: true, size: null, reason: null };
  }
  return { available: true, size, reason: null };
}
