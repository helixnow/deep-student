/**
 * 文件与媒体边界（`src/cmd/apkg_import.rs`、`src/cmd/anki_connect.rs:114-175,2145-2159`）。
 * 只做纯路径/IO 处理；错误以 Rust `AppError` 的 serde 值抛出由 index.ts 负责。
 * 所有本地文件访问都经 `local-runtime.ts` 端口（桌面 `node:fs`，移动端不可用）。
 */
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { hostPath as path } from '../../../platform/util/path.ts';
import { commandError } from './command-errors.ts';
export { appError, appErrorWithDetails, commandError, type AppErrorType, type AppErrorValue } from './command-errors.ts';
import type { PathFlavor } from '../../../platform/files/api.ts';
import {
  sanitizeFilenameComponent as sanitizeFilenameComponentFor,
  sanitizeFilenameWithExtension as sanitizeFilenameWithExtensionFor,
} from './card-utils.ts';
import { ankiLocalRuntime } from './local-runtime.ts';

/** `apkg_importer_service.rs:18-29`。 */
export const APKG_ERROR_INVALID_INPUT = 'apkg_invalid_input';
export const APKG_ERROR_NOT_FOUND = 'apkg_not_found';
export const APKG_ERROR_NOT_FILE = 'apkg_not_file';
export const APKG_ERROR_IO = 'apkg_io';

/** `src/cmd/apkg_import.rs:246`。 */
export const ANKI_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

const HOST_FLAVOR: PathFlavor = path.sep === '\\' ? 'win32' : 'posix';

/** `src/cmd/anki_connect.rs:114-148`，按宿主平台的 `Path::file_name`。 */
export function sanitizeFilenameComponent(raw: string, fallback: string): string {
  return sanitizeFilenameComponentFor(raw, fallback, HOST_FLAVOR);
}

/** `src/cmd/anki_connect.rs:150-165`。 */
export function sanitizeFilenameWithExtension(raw: string, fallbackName: string, extension: string): string {
  return sanitizeFilenameWithExtensionFor(raw, fallbackName, extension, HOST_FLAVOR);
}

/** `src/cmd/anki_connect.rs:167-175`。 */
export function buildSafeOutputPath(outputDir: string, suggestedName: string, fallbackName: string, extension: string): string {
  return path.join(outputDir, sanitizeFilenameWithExtension(suggestedName, fallbackName, extension));
}

/** `src/cmd/apkg_import.rs:248-268`。 */
export function ankiMediaMime(filePath: string): string | null {
  const extension = path.extname(filePath).replace(/^\./, '').toLowerCase();
  if (!extension) return null;
  switch (extension) {
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'bmp': return 'image/bmp';
    case 'avif': return 'image/avif';
    case 'mp3': return 'audio/mpeg';
    case 'ogg': case 'oga': return 'audio/ogg';
    case 'opus': return 'audio/opus';
    case 'wav': return 'audio/wav';
    case 'm4a': case 'aac': return 'audio/mp4';
    case 'flac': return 'audio/flac';
    case 'webm': return 'audio/webm';
    case 'mp4': return 'video/mp4';
    default: return null;
  }
}

/** Rust `std::fs::canonicalize`：解析符号链接并要求目标存在。 */
function canonicalize(target: string): string | null {
  try {
    return ankiLocalRuntime().realpath(target);
  } catch {
    return null;
  }
}

export function isInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' ? true : relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** `src/cmd/apkg_import.rs:270-301` 的同步实现（`read_anki_media_in`）。 */
export async function readAnkiMediaIn(mediaRoot: string, targetPath: string): Promise<string> {
  const notAllowed = () => commandError('Validation', '只能读取已导入的卡片媒体', APKG_ERROR_INVALID_INPUT);
  const root = canonicalize(mediaRoot);
  if (root === null) throw notAllowed();
  const target = canonicalize(targetPath.trim());
  if (target === null || !isInsideRoot(root, target)) throw notAllowed();
  const mime = ankiMediaMime(target);
  if (mime === null) throw notAllowed();
  let metadata: { kind: string; size: number } | null;
  try {
    metadata = ankiLocalRuntime().stat(target);
  } catch {
    metadata = null;
  }
  if (metadata === null || metadata.kind !== 'file' || metadata.size > ANKI_MEDIA_MAX_BYTES) throw notAllowed();
  let bytes: Uint8Array;
  try {
    bytes = ankiLocalRuntime().readBytes(target);
  } catch (error) {
    throw commandError('FileSystem', `读取卡片媒体失败: ${ioErrorText(error)}`, APKG_ERROR_IO);
  }
  return `data:${mime};base64,${toBase64(bytes)}`;
}

/** `std::io::Error` 的 Display（`<strerror> (os error <errno>)`）。 */
export function ioErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: unknown; errno?: unknown; message?: unknown };
    const strerror: Record<string, string> = {
      EACCES: 'Permission denied',
      EEXIST: 'File exists',
      EISDIR: 'Is a directory',
      EIO: 'Input/output error',
      EMFILE: 'Too many open files',
      ENAMETOOLONG: 'File name too long',
      ENOENT: 'No such file or directory',
      ENOSPC: 'No space left on device',
      ENOTDIR: 'Not a directory',
      EPERM: 'Operation not permitted',
      EROFS: 'Read-only file system',
    };
    if (typeof e.code === 'string' && strerror[e.code] !== undefined && typeof e.errno === 'number') {
      return `${strerror[e.code]} (os error ${Math.abs(e.errno)})`;
    }
    if (typeof e.message === 'string') return e.message;
  }
  return String(error);
}

/** `save_json_file` / `AnkiService.saveJsonFile` 的写入失败（文案同 Rust `写入文件失败: {}`）。 */
export class JsonWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonWriteError';
  }
}

/** `src/cmd/anki_connect.rs:2145-2159`。 */
export async function writeJsonToTemp(tempDir: string, content: string, suggestedName: string): Promise<string> {
  const filename = buildSafeOutputPath(tempDir, suggestedName.trim(), 'anki_cards', 'json');
  try {
    await ankiLocalRuntime().writeFile(filename, content);
  } catch (error) {
    throw new JsonWriteError(`写入文件失败: ${ioErrorText(error)}`);
  }
  return filename;
}

/** `src/cmd/apkg_import.rs:24-59`。 */
export async function validateApkgPath(rawPath: string): Promise<string> {
  if (!rawPath.trim()) throw commandError('Validation', 'APKG 文件路径不能为空', APKG_ERROR_INVALID_INPUT);
  let metadata: { kind: string; size: number };
  try {
    metadata = ankiLocalRuntime().stat(rawPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw commandError('NotFound', `APKG 文件不存在: ${rawPath}`, APKG_ERROR_NOT_FOUND);
    }
    throw commandError('FileSystem', `无法读取 APKG 文件信息 (${rawPath}): ${ioErrorText(error)}`, APKG_ERROR_IO);
  }
  if (metadata.kind !== 'file') throw commandError('Validation', `APKG 路径必须指向文件: ${rawPath}`, APKG_ERROR_NOT_FILE);
  return rawPath;
}
