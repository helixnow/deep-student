/**
 * `src/commands.rs:8494 get_image_as_base64` → `dstu-storage/src/file_manager.rs:389`.
 * Accepts app-relative paths plus `file://` / `tauri://` / `asset://` URLs, then
 * confines the resolved file to the app data directory before building a data URL.
 */
import { existsSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostPath as path } from '../../../platform/util/path.ts';
import { AppError } from '../../../platform/errors/api.ts';

export class ImageBase64Error extends Error {
  readonly appError: ReturnType<typeof AppError.validation>;

  constructor(error: ReturnType<typeof AppError.validation>) {
    super(error.message);
    this.name = 'ImageBase64Error';
    this.appError = error;
  }
}

function hexValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

/** `urlencoding::decode`：百分号转义非 UTF-8 序列时返回原文（Rust 的 `.unwrap_or_else`）。 */
export function urlDecodeLossy(raw: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < raw.length;) {
    const code = raw.charCodeAt(index);
    if (code === 0x25 && index + 2 < raw.length) {
      const high = hexValue(raw.charCodeAt(index + 1));
      const low = hexValue(raw.charCodeAt(index + 2));
      if (high >= 0 && low >= 0) {
        bytes.push(high * 16 + low);
        index += 3;
        continue;
      }
    }
    const char = String.fromCodePoint(raw.codePointAt(index)!);
    bytes.push(...Buffer.from(char, 'utf8'));
    index += char.length;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return raw;
  }
}

/** Rust `Path::starts_with`（按路径组件比较，不是字符串前缀）。 */
function pathStartsWith(candidate: string, base: string): boolean {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function requestedPath(appDataDir: string, relativePath: string): string {
  let raw = relativePath;
  if (raw.startsWith('tauri://localhost/')) raw = raw.replace('tauri://localhost/', '/');
  else if (raw.startsWith('tauri://')) raw = raw.replace('tauri://', '/');
  if (raw.startsWith('asset://localhost/')) raw = raw.replace('asset://localhost/', '/');
  else if (raw.startsWith('asset://')) raw = raw.replace('asset://', '/');
  if (raw.startsWith('file:///')) raw = raw.replace('file:///', '/');
  else if (raw.startsWith('file://')) raw = raw.replace('file://', '/');

  let decoded = urlDecodeLossy(raw);
  if (!decoded.startsWith('/')
    && (decoded.startsWith('Users/') || decoded.startsWith('home/')
      || decoded.startsWith('Volumes/') || decoded.startsWith('private/')
      || decoded.startsWith('var/'))) {
    decoded = `/${decoded}`;
  }
  const looksWindowsDrive = decoded.length > 2 && decoded[1] === ':'
    && (decoded[2] === '/' || decoded[2] === '\\');
  const absolute = path.isAbsolute(decoded) || looksWindowsDrive;
  return absolute ? decoded : path.join(appDataDir, decoded);
}

/** `FileManager::infer_mime_from_path`（扩展名大小写不敏感，默认 jpeg）。 */
export function inferImageMime(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.heif')) return 'image/heif';
  return 'image/jpeg';
}

/** `FileManager::get_image_as_base64`：返回 `data:<mime>;base64,<payload>`。 */
export async function getImageAsBase64(appDataDir: string, relativePath: string): Promise<string> {
  const requested = requestedPath(appDataDir, relativePath);
  let base: string;
  try {
    base = realpathSync(appDataDir);
  } catch (error) {
    throw new ImageBase64Error(AppError.file_system(
      `解析app_data_dir失败: ${error instanceof Error ? error.message : String(error)}`));
  }
  let canonical = requested;
  try { canonical = realpathSync(requested); } catch { canonical = requested; }
  if (!pathStartsWith(canonical, base)) {
    throw new ImageBase64Error(AppError.validation('拒绝访问：超出应用数据目录'));
  }
  if (!existsSync(canonical)) {
    throw new ImageBase64Error(AppError.not_found(`图片文件不存在: ${canonical}`));
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(canonical);
  } catch (error) {
    throw new ImageBase64Error(AppError.file_system(
      `读取图片文件失败: ${error instanceof Error ? error.message : String(error)}`));
  }
  return `data:${inferImageMime(canonical)};base64,${bytes.toString('base64')}`;
}
