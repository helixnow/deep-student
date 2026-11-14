/**
 * `dstu-docs/src/pdfium_utils.rs`: Linux candidate discovery for `libpdfium.so`.
 * Tauri's resource directory is named after `productName` (this project:
 * "Deep Student"), so the first-level child directories are scanned instead of
 * hard-coding a directory name (#480). Loading PDFium itself needs the F7
 * native adapter and remains unmigrated.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from '../../../platform/util/path.ts';

export const PDFIUM_LIB_NAME = 'libpdfium.so';

/**
 * 扫描 `root` 的一级子目录，把其中存在的 `libpdfium.so` 追加到候选列表。
 * 目录缺失或不可读时静默返回（与 Rust `read_dir` 失败分支一致）。
 */
export function pushExistingPdfiumInChildDirs(paths: string[], root: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    const candidate = join(root, name, PDFIUM_LIB_NAME);
    let isFile = false;
    try { isFile = statSync(candidate).isFile(); }
    catch { isFile = false; }
    if (isFile && !paths.includes(candidate)) paths.push(candidate);
  }
}
