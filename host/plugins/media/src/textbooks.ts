/**
 * `src/cmd/textbooks.rs`: the file-facing parts of `textbooks_relink` —
 * `unified_file_manager::{hash_file_sha256, read_all_bytes_bounded}` on local
 * paths plus the legacy `Textbook` DTO conversion (`VfsTextbook::to_textbook`).
 */
import { createHash } from 'node:crypto';
import { mkdir, open, stat, type FileHandle } from 'node:fs/promises';
import { dirname } from '../../../platform/util/path.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { VfsTextbook } from '../../vfs-repos/api.ts';
import type { Textbook } from '../../../../contracts/ipc/generated/L18-media-docs.ts';

/** 教材/文档导入单文件读取上限（`textbooks.rs` MAX_TEXTBOOK_IMPORT_BYTES）。 */
export const MAX_TEXTBOOK_IMPORT_BYTES = 200 * 1024 * 1024;

export class TextbookFileError extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'TextbookFileError';
    this.appError = appError;
  }
}

function fileSystem(message: string): never {
  throw new TextbookFileError(AppError.file_system(message));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `unified_file_manager::classify_path`/`decode_path` 的本地路径分支：
 * 去 NUL/空白、拒绝空路径、还原 `file://`/`tauri://` 前缀并做百分号解码。
 * 虚拟 URI（content:// 等）不属于桌面命令调用方，保持原样交给 Node 打开。
 */
export function localPathOf(rawPath: string): string {
  const trimmed = rawPath.replace(/^\0+|\0+$/g, '').trim();
  if (trimmed === '') {
    throw new TextbookFileError(AppError.validation('路径不能为空'));
  }
  let normalized = trimmed;
  if (normalized.startsWith('file://')) normalized = normalized.slice('file://'.length);
  else if (normalized.startsWith('tauri://localhost/')) {
    normalized = `/${normalized.slice('tauri://localhost/'.length)}`;
  } else if (normalized.startsWith('tauri://')) {
    normalized = `/${normalized.slice('tauri://'.length)}`;
  }
  if (normalized.includes('://')) return normalized;
  try { return decodeURIComponent(normalized); }
  catch { return normalized; }
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try { await handle.close(); }
  catch { // boundary-allow empty-catch: Rust `File` drop 忽略关闭失败
  }
}

/** `unified_file_manager::hash_file_sha256`：64 KiB 分块 SHA-256。 */
export async function hashFileSha256(rawPath: string): Promise<string> {
  const path = localPathOf(rawPath);
  let handle: FileHandle;
  try { handle = await open(path, 'r'); }
  catch (error) {
    return fileSystem(`读取文件失败: ${path} (${errorText(error)})`);
  }
  try {
    const hasher = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      let read: number;
      try { ({ bytesRead: read } = await handle.read(buffer, 0, buffer.length, null)); }
      catch (error) {
        return fileSystem(`读取文件失败: ${path} (${errorText(error)})`);
      }
      if (read === 0) break;
      hasher.update(buffer.subarray(0, read));
    }
    return hasher.digest('hex');
  } finally {
    await closeQuietly(handle);
  }
}

/** `unified_file_manager::read_all_bytes_bounded`（本地路径分支）：读到上限 + 1 字节为止。 */
export async function readAllBytesBounded(rawPath: string, maxBytes: number): Promise<Uint8Array> {
  const path = localPathOf(rawPath);
  let size: number;
  try { size = (await stat(path)).size; }
  catch (error) {
    return fileSystem(`获取文件信息失败: ${path} (${errorText(error)})`);
  }
  if (size > maxBytes) {
    throw new TextbookFileError(AppError.validation(
      `文件过大: ${size} 字节，超过读取上限 ${maxBytes} 字节: ${path}`));
  }
  let handle: FileHandle;
  try { handle = await open(path, 'r'); }
  catch (error) {
    return fileSystem(`读取文件失败: ${path} (${errorText(error)})`);
  }
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
    const limit = maxBytes + 1;
    let total = 0;
    for (;;) {
      const want = Math.min(buffer.length, limit - total);
      if (want <= 0) break;
      let read: number;
      try { ({ bytesRead: read } = await handle.read(buffer, 0, want, null)); }
      catch (error) {
        return fileSystem(`读取文件失败: ${path} (${errorText(error)})`);
      }
      if (read === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, read)));
      total += read;
    }
    if (total > maxBytes) {
      throw new TextbookFileError(AppError.validation(
        `文件过大: 超过读取上限 ${maxBytes} 字节: ${path}`));
    }
    return Buffer.concat(chunks);
  } finally {
    await closeQuietly(handle);
  }
}

/** `unified_file_manager::write_text_file`（本地路径分支）：缺父目录先建，截断写入。 */
export async function writeTextFile(rawPath: string, content: string): Promise<void> {
  const path = localPathOf(rawPath);
  const parent = dirname(path);
  let parentExists = true;
  try { await stat(parent); }
  catch { parentExists = false; }
  if (!parentExists) {
    try { await mkdir(parent, { recursive: true }); }
    catch (error) {
      return fileSystem(`创建目录失败: ${parent} (${errorText(error)})`);
    }
  }
  let handle: FileHandle;
  try { handle = await open(path, 'w'); }
  catch (error) {
    return fileSystem(`写入文件失败: ${path} (${errorText(error)})`);
  }
  try {
    try { await handle.writeFile(content, 'utf8'); }
    catch (error) {
      return fileSystem(`写入文件失败: ${path} (${errorText(error)})`);
    }
  } finally {
    await closeQuietly(handle);
  }
}

/** `VfsTextbook::to_textbook`（`textbooks_db.rs`）。 */
export function toTextbook(textbook: VfsTextbook): Textbook {
  return {
    id: textbook.id,
    sha256: textbook.sha256,
    file_name: textbook.fileName,
    file_path: textbook.originalPath ?? '',
    size: textbook.size,
    page_count: textbook.pageCount ?? null,
    tags_json: JSON.stringify(textbook.tags),
    favorite: textbook.isFavorite ? 1 : 0,
    last_opened_at: textbook.lastOpenedAt ?? null,
    last_page: textbook.lastPage ?? null,
    bookmarks_json: JSON.stringify(textbook.bookmarks),
    cover_key: textbook.coverKey ?? null,
    origin_json: null,
    status: textbook.status,
    created_at: textbook.createdAt,
    updated_at: textbook.updatedAt,
  };
}

/** `path.extension()` 小写（Rust `Path::extension` → `to_lowercase`）。 */
export function extensionOf(fileName: string): string | null {
  const index = fileName.lastIndexOf('.');
  if (index <= 0 || index === fileName.length - 1) return null;
  return fileName.slice(index + 1).toLowerCase();
}
