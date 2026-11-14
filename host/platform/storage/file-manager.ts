/**
 * Note asset path safety from dstu-storage/src/file_manager.rs:865-912, plus the
 * `adjust_image_quality_{bytes,base64}` policy from file_manager.rs:74-167.
 *
 * The policy (high/unknown/auto thresholds/500 KB no-op/invalid fallback) belongs
 * to F3. Decode/resize/JPEG encoding is delegated to the native image service
 * (`NativeImage.dimensions` + `resizeAndEncodeJpeg`); tests inject the same small
 * port, and production callers must pass the real `ctx.nativeImage`. The codec is
 * still RGBA8 + sharp on the F7 branch, so the byte/pixel-equivalent JPEG test
 * remains pending until F7 provides an `image = 0.24.9` encoder or approved
 * cross-vectors (see `native-needs.md`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../errors/api.ts';
import { decodeBase64Standard, rustTrim } from '../util/portable.ts';
import { storageLog } from './logging.ts';

/** The subset of `nativeImage` required by the Rust image-quality policy. */
export interface ImageQualityCodec {
  dimensions(bytes: Uint8Array): Promise<{ width: number; height: number }>;
  resizeAndEncodeJpeg(
    bytes: Uint8Array,
    options: { maxDimension: number; quality: number },
  ): Promise<Uint8Array>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `FileManager::adjust_image_quality_bytes` (file_manager.rs:74-167).
 *
 * All no-op/failure branches return the original bytes; only the resize/encode
 * step is delegated to the native codec. `resizeAndEncodeJpeg` receives
 * `{ maxDimension, quality }` exactly as the Rust policy resolves them.
 */
export async function adjustImageQualityBytes(
  imageData: Uint8Array,
  visionQuality: string,
  codec: ImageQualityCodec,
): Promise<Uint8Array> {
  if (visionQuality === 'high') return imageData;

  let size: { width: number; height: number };
  try {
    size = await codec.dimensions(imageData);
  } catch (error) {
    storageLog('dstu_storage::file_manager', 'error', `⚠️ [图片压缩] 图片加载失败: ${errorText(error)}`);
    return imageData;
  }

  const megapixels = (size.width * size.height) / 1_000_000;
  let maxDimension: number;
  let quality: number;
  switch (visionQuality) {
    case 'low':
      maxDimension = 768;
      quality = 60;
      break;
    case 'medium':
      maxDimension = 1024;
      quality = 75;
      break;
    case 'auto':
      if (megapixels > 4.0) {
        maxDimension = 768;
        quality = 60;
      } else if (megapixels > 2.0) {
        maxDimension = 1024;
        quality = 75;
      } else {
        return imageData;
      }
      break;
    default:
      return imageData;
  }

  const needsResize = size.width > maxDimension || size.height > maxDimension;
  if (!needsResize && imageData.byteLength < 500_000) return imageData;

  try {
    return await codec.resizeAndEncodeJpeg(imageData, { maxDimension, quality });
  } catch (error) {
    storageLog('dstu_storage::file_manager', 'error', `⚠️ [图片压缩] JPEG 编码失败: ${errorText(error)}`);
    return imageData;
  }
}

/** `FileManager::adjust_image_quality_base64` (file_manager.rs:56-69). */
export async function adjustImageQualityBase64(
  base64Data: string,
  visionQuality: string,
  codec: ImageQualityCodec,
): Promise<string> {
  if (visionQuality === 'high') return base64Data;
  const decoded = decodeBase64Standard(base64Data);
  if (decoded.error !== undefined) {
    storageLog('dstu_storage::file_manager', 'error', `⚠️ [图片压缩] Base64 解码失败: ${decoded.error}`);
    return base64Data;
  }
  return Buffer.from(await adjustImageQualityBytes(new Uint8Array(decoded.bytes), visionQuality, codec)).toString('base64');
}

/** file_manager.rs:865 `validate_note_asset_path_segment`。 */
export function validateNoteAssetPathSegment(label: string, value: string): void {
  const trimmed = rustTrim(value);
  if (trimmed === '') throw AppError.validation(`${label} 不能为空`);
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw AppError.validation(`${label} 不允许包含路径分隔符`);
  }
  if (trimmed === '..' || trimmed === '.') throw AppError.validation(`${label} 非法`);

  const parsed = path.parse(trimmed);
  if (path.isAbsolute(trimmed) || parsed.root !== '' || parsed.dir !== '') {
    throw AppError.validation(`${label} 含非法路径成分`);
  }
  if (trimmed.length >= 2 && trimmed[1] === ':') throw AppError.validation(`${label} 含盘符前缀`);
}

/** file_manager.rs:897 `portable_relative_path`。 */
export function portableRelativePath(value: string): string {
  return value.replaceAll('\\', '/');
}

/** file_manager.rs:901 `resolve_note_assets_dir`。 */
export function resolveNoteAssetsDir(writableDir: string, subject: string, noteId: string): string {
  validateNoteAssetPathSegment('subject', subject);
  validateNoteAssetPathSegment('note_id', noteId);
  const root = path.join(writableDir, 'notes_assets');
  const dir = path.join(root, subject, noteId);
  const relative = path.relative(root, dir);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw AppError.validation('拒绝访问：笔记资源路径越界');
  }
  return dir;
}

// ------------------------------------------------------------------ FileManager paths (file_manager.rs:167-272)

const FILE_MANAGER_TARGET = 'dstu_storage::file_manager';

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === 'win32';
}

function isSeparator(char: string | undefined, platform: NodeJS.Platform): boolean {
  return char === '/' || (isWindows(platform) && char === '\\');
}

/** `Path::is_absolute`：Unix 以 `/` 开头；Windows 需要盘符+根或 UNC/verbatim 前缀。 */
export function rustPathIsAbsolute(value: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!isWindows(platform)) return value.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value);
}

/** `PathBuf::join`（不做规范化，保留 `..` 等组件，供后续逐段检查）。 */
export function rustPathJoin(base: string, child: string, platform: NodeJS.Platform = process.platform): string {
  if (rustPathIsAbsolute(child, platform)) return child;
  if (isWindows(platform) && isSeparator(child[0], platform)) {
    // has_root without prefix: keep only the base prefix (std `PathBuf::push`).
    const prefix = /^[A-Za-z]:/.exec(base)?.[0] ?? '';
    return prefix + child;
  }
  if (base === '' || isSeparator(base[base.length - 1], platform)) return base + child;
  return base + (isWindows(platform) ? '\\' : '/') + child;
}

function hasParentDirComponent(value: string, platform: NodeJS.Platform): boolean {
  const parts = isWindows(platform) ? value.split(/[\\/]/) : value.split('/');
  return parts.includes('..');
}

/** `Path::starts_with`（按组件比较）。 */
function pathStartsWith(child: string, base: string, platform: NodeJS.Platform): boolean {
  if (child === base) return true;
  const prefix = isSeparator(base[base.length - 1], platform) ? base : base + path.sep;
  return child.startsWith(prefix);
}

/**
 * file_manager.rs:237 `FileManager::resolve_image_path`：绝对路径原样返回；否则剥 `images/` 前缀与
 * 前导 `/`，拼到 `imagesDir`。可 canonicalize 时必须落在 canonical(imagesDir) 内（越界返回 imagesDir）；
 * 不可 canonicalize（文件尚不存在）时含 `..` 组件即返回 imagesDir。
 */
export function resolveImagePath(imagesDir: string, relativePath: string, platform: NodeJS.Platform = process.platform): string {
  if (rustPathIsAbsolute(relativePath, platform)) return relativePath;
  const stripped = relativePath.startsWith('images/') ? relativePath.slice('images/'.length) : relativePath;
  const trimmed = stripped.replace(/^\/+/, '');
  const candidate = rustPathJoin(imagesDir, trimmed, platform);

  let canonical: string | undefined;
  try { canonical = fs.realpathSync.native(candidate); } catch { canonical = undefined; }
  if (canonical !== undefined) {
    let base: string | undefined;
    try { base = fs.realpathSync.native(imagesDir); } catch { base = undefined; }
    if (base !== undefined) {
      if (pathStartsWith(canonical, base, platform)) return canonical;
      storageLog(FILE_MANAGER_TARGET, 'warn', `路径遍历拦截: ${canonical} 不在 ${base} 内`);
      return imagesDir;
    }
  }

  if (hasParentDirComponent(candidate, platform)) {
    storageLog(FILE_MANAGER_TARGET, 'warn', `路径遍历拦截: 检测到 '..' 组件 in ${relativePath}`);
    return imagesDir;
  }
  return candidate;
}

function ioErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rust `let _ = std::fs::remove_file(&probe)`: the result is discarded (debug trace only). */
function removeProbe(probe: string): void {
  try { fs.rmSync(probe); }
  catch (error) { storageLog(FILE_MANAGER_TARGET, 'debug', `[文件系统] 删除写入探针失败（忽略） ${probe}: ${ioErrorText(error)}`); }
}

/** file_manager.rs:170 `ensure_writable`：创建目录并写入/删除 `.write_test` 探针。 */
/** 创建目录并写入 `.write_test` 探针；成功返回 null，失败返回阶段与错误（探针总会尝试删除）。 */
function probeWritable(dir: string): { stage: 'create' | 'write'; error: unknown } | null {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (error) { return { stage: 'create', error }; }
  const probe = path.join(dir, '.write_test');
  try {
    fs.writeFileSync(probe, 'ok');
  } catch (error) {
    removeProbe(probe);
    return { stage: 'write', error };
  }
  removeProbe(probe);
  return null;
}

function ensureWritable(dir: string): boolean {
  const failure = probeWritable(dir);
  if (failure === null) return true;
  const what = failure.stage === 'create' ? '创建目录失败' : '目录不可写';
  storageLog(FILE_MANAGER_TARGET, 'error', `⚠️ [文件系统] ${what} ${dir}: ${ioErrorText(failure.error)}`);
  return false;
}

/**
 * 持久数据（数据库、笔记资源、备份根、Anki 媒体等）的应用数据目录：只用活动槽目录，不可写时抛
 * `file_system` 错误，绝不回退到别处。
 *
 * RUST-FIX(RF-W07-persistent-app-data-no-silent-relocation): Rust 所有调用方都走
 * `get_writable_app_data_dir` 的回退链，活动槽不可写时持久数据被静默写进 `data_dir()/DeepStudent`
 * 或 `temp_dir()/deep_student_data`，之后活动槽恢复可写就再也读不到。
 */
export function getPersistentAppDataDir(appDataDir: string): string {
  const failure = probeWritable(appDataDir);
  if (failure === null) return appDataDir;
  const what = failure.stage === 'create' ? '创建目录失败' : '目录不可写';
  storageLog(FILE_MANAGER_TARGET, 'error', `⚠️ [文件系统] ${what} ${appDataDir}: ${ioErrorText(failure.error)}`);
  throw AppError.file_system(`持久数据目录不可用（${what}）: ${appDataDir} (${ioErrorText(failure.error)})`);
}

/**
 * file_manager.rs:169 `FileManager::get_writable_app_data_dir`，只供临时/可再生的数据（OCR 暂存、
 * 翻译 temp、导出 staging）使用：依次尝试 `appDataDir`（活动槽目录）、`dirs::data_dir()/DeepStudent`
 * （`osDataDir` 为 null 时跳过）、`temp_dir()/deep_student_data`；最后一项不可写时仍返回并 warn。
 */
export function getTempAppDataDir(appDataDir: string, osDataDir: string | null, tempDir: string): string {
  if (ensureWritable(appDataDir)) return appDataDir;
  if (osDataDir !== null) {
    const candidate = path.join(osDataDir, 'DeepStudent');
    if (ensureWritable(candidate)) return candidate;
  }
  const tempAppData = path.join(tempDir, 'deep_student_data');
  if (!ensureWritable(tempAppData)) {
    storageLog(FILE_MANAGER_TARGET, 'warn', `⚠️ [文件系统] 无法获取稳定的持久目录，临时使用 ${tempAppData}`);
  }
  return tempAppData;
}

/**
 * file_manager.rs:169 `FileManager::get_writable_app_data_dir`（行为不变）。
 * @deprecated 持久数据用 {@link getPersistentAppDataDir}，临时数据用 {@link getTempAppDataDir}。
 */
export function getWritableAppDataDir(appDataDir: string, osDataDir: string | null, tempDir: string): string {
  return getTempAppDataDir(appDataDir, osDataDir, tempDir);
}
