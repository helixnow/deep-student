/**
 * `src-tauri/crates/dstu-storage/src/unified_file_manager.rs` 的桌面分支。
 *
 * 移动端 `content://` / `ph://` / Android SAF 在 Electron 桌面没有对应实现，按 Rust 桌面端
 * `FilePath::Url` 的结果报 `URL is not a valid path`；虚拟路径分支保持与 Rust 相同的分类顺序，
 * 以便桌面端收到移动端路径时得到同样的错误。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, normalize, sep } from 'node:path';
import { CommandError } from '../host/kernel/api.ts';
import { rustTrim, rustTrimStart } from '../host/platform/util/index.ts';
import { formatIoError } from './shell/errors.ts';
import type { ShellPlatform } from './shell/tauri-config.ts';

const SPECIAL_SCHEMES = ['content://', 'asset://', 'ph://', 'image://', 'camera://'];
const SAF_PREFIXES = ['primary:', 'secondary:', 'raw:'];
const MAX_READ_FILE_BYTES = 200 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;

export const DOUBLE_ENCODED_VIRTUAL_URI_REJECTED =
  '路径像是双重编码的安全 URI，已拒绝以免破坏授权。请传入原始 content:// 地址';

export type PathKind =
  | { readonly kind: 'local'; readonly path: string }
  | { readonly kind: 'virtual'; readonly uri: string };

export interface FileOperationDeps {
  readonly platform: ShellPlatform;
  /** Tauri `app_data_dir` / `app_local_data_dir` / `app_cache_dir`（canonicalize 前）。 */
  appDirs(): Promise<readonly string[]>;
}

const validation = (message: string) => new CommandError({ error_type: 'Validation', message, details: null });
const fileSystem = (message: string) => new CommandError({ error_type: 'FileSystem', message, details: null });

function trimPath(input: string): string {
  return rustTrim(input.replace(/^\0+|\0+$/g, ''));
}

function isSpecialScheme(path: string): boolean {
  const lower = rustTrimStart(path).toLowerCase();
  return SPECIAL_SCHEMES.some((scheme) => lower.startsWith(scheme));
}

function isAndroidSafPath(path: string): boolean {
  const lower = rustTrimStart(path).toLowerCase();
  return SAF_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** `urlencoding::decode`：非法百分号编码或非 UTF-8 时返回原文。 */
function decodePath(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

export function isVirtualUri(path: string): boolean {
  const trimmed = rustTrim(path);
  return isSpecialScheme(trimmed) || isAndroidSafPath(trimmed);
}

function normalizeLocalPath(input: string): string {
  if (input.startsWith('file://')) return input.slice('file://'.length);
  if (input.startsWith('tauri://localhost/')) return `/${input.slice('tauri://localhost/'.length)}`;
  if (input.startsWith('tauri://')) return `/${input.slice('tauri://'.length)}`;
  return input;
}

function rejectDoubleEncodedVirtualUri(trimmed: string): void {
  if (isSpecialScheme(trimmed)) return;
  if (isSpecialScheme(decodePath(trimmed))) throw validation(DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
}

export function classifyPath(raw: string): PathKind {
  const trimmed = trimPath(raw);
  if (trimmed === '') throw validation('路径不能为空');
  if (isSpecialScheme(trimmed)) return { kind: 'virtual', uri: trimmed };
  rejectDoubleEncodedVirtualUri(trimmed);
  const decodedForCheck = decodePath(trimmed);
  if (isAndroidSafPath(decodedForCheck)) return { kind: 'virtual', uri: decodedForCheck };
  if (trimmed.startsWith('file://') || trimmed.startsWith('tauri://')) {
    return { kind: 'local', path: decodePath(normalizeLocalPath(trimmed)) };
  }
  if (trimmed.includes('://')) return { kind: 'virtual', uri: trimmed };
  return { kind: 'local', path: decodePath(trimmed) };
}

function displayOf(path: PathKind): string {
  return path.kind === 'local' ? path.path : path.uri;
}

/** `sanitize_unicode`：去掉零宽/双向控制字符，全角分隔符归一为半角。 */
function sanitizeUnicode(input: string): string {
  return Array.from(input)
    .filter((char) => {
      const code = char.codePointAt(0)!;
      if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff || code === 0x00ad || code === 0x2060) return false;
      if (code >= 0x2061 && code <= 0x2064) return false;
      if (code >= 0x202a && code <= 0x202e) return false;
      if (code >= 0x2066 && code <= 0x2069) return false;
      return true;
    })
    .map((char) => {
      switch (char) {
        case '／': return '/';
        case '＼': return '\\';
        case '．': return '.';
        case '：': return ':';
        case '＊': return '*';
        case '？': return '?';
        case '＜': return '<';
        case '＞': return '>';
        case '｜': return '|';
        case '＂': return '"';
        default: return char;
      }
    })
    .join('');
}

function sanitizeForLegacy(input: string): string {
  const sanitized = sanitizeUnicode(input);
  if (isSpecialScheme(sanitized)) return sanitized;
  return decodePath(normalizeLocalPath(sanitized));
}

/** `canonicalize_lenient`：存在时 realpath；否则词法归一化后尽量真实化父目录。 */
export function canonicalizeLenient(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const normalized = normalize(path);
    try {
      return join(realpathSync.native(dirname(normalized)), basename(normalized));
    } catch {
      return normalized;
    }
  }
}

function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

function hasHiddenComponent(path: string): boolean {
  return path
    .split(sep)
    .filter((component) => component !== '' && component !== '.' && component !== '..')
    .some((component) => component.startsWith('.'));
}

/**
 * `deny_hidden_local_path`：拒绝本地路径中的隐藏段；应用数据目录内的路径始终放行。
 * 判定前先做 Unicode 归一化、URL 解码与尽力 realpath，避免 `%2E` 和 `..` 绕过。
 */
export async function denyHiddenLocalPath(raw: string, deps: FileOperationDeps): Promise<void> {
  if (isVirtualUri(raw)) return;
  const resolved = canonicalizeLenient(sanitizeForLegacy(raw));
  let appDirs: readonly string[] = [];
  try {
    appDirs = await deps.appDirs();
  } catch {
    appDirs = [];
  }
  for (const dir of appDirs) {
    const canonical = canonicalizeLenient(dir);
    if (isWithin(resolved, canonical)) return;
  }
  if (hasHiddenComponent(resolved)) throw validation(`拒绝读取隐藏路径: ${raw}`);
}

async function readAllBytes(path: PathKind, deps: FileOperationDeps): Promise<Uint8Array> {
  if (path.kind === 'virtual') throw fileSystem(`读取文件失败: ${path.uri} (URL is not a valid path)`);
  try {
    return new Uint8Array(await readFile(path.path));
  } catch (error) {
    throw fileSystem(`读取文件失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
}

async function readBounded(path: PathKind, limit: number, deps: FileOperationDeps): Promise<Uint8Array> {
  if (path.kind === 'virtual') throw fileSystem(`读取文件失败: ${path.uri} (URL is not a valid path)`);
  let size: number;
  try {
    size = statSync(path.path).size;
  } catch (error) {
    throw fileSystem(`获取文件信息失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
  if (size > limit) throw validation(`文件过大: ${size} 字节，超过读取上限 ${limit} 字节: ${path.path}`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of createReadStream(path.path, { highWaterMark: COPY_BUFFER_BYTES })) {
      const bytes = chunk as Buffer;
      total += bytes.length;
      if (total > limit) throw validation(`文件过大: 超过读取上限 ${limit} 字节: ${path.path}`);
      chunks.push(new Uint8Array(bytes));
    }
  } catch (error) {
    if (error instanceof CommandError) throw error;
    throw fileSystem(`读取文件失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
  return Buffer.concat(chunks, total);
}

export async function readFileText(raw: string, deps: FileOperationDeps): Promise<string> {
  await denyHiddenLocalPath(raw, deps);
  const bytes = await readAllBytes(classifyPath(raw), deps);
  try {
    // String::from_utf8 keeps a leading U+FEFF; TextDecoder strips it unless ignoreBOM is set.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw fileSystem('文件编码不是有效的 UTF-8');
  }
}

export async function readFileBytes(raw: string, maxBytes: number | null, deps: FileOperationDeps): Promise<Uint8Array> {
  await denyHiddenLocalPath(raw, deps);
  const limit = Math.min(maxBytes ?? MAX_READ_FILE_BYTES, MAX_READ_FILE_BYTES);
  return readBounded(classifyPath(raw), limit, deps);
}

/** u64 `metadata().len()`: kept exact as bigint; the kernel serialises it as a JSON number (D3). */
export async function getFileSize(raw: string, deps: FileOperationDeps): Promise<bigint> {
  await denyHiddenLocalPath(raw, deps);
  const path = classifyPath(raw);
  if (path.kind === 'virtual') throw fileSystem(`读取文件失败: ${path.uri} (URL is not a valid path)`);
  try {
    return statSync(path.path, { bigint: true }).size;
  } catch (error) {
    throw fileSystem(`获取文件信息失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
}

export async function hashFile(raw: string, deps: FileOperationDeps): Promise<string> {
  const path = classifyPath(raw);
  if (path.kind === 'virtual') throw fileSystem(`读取文件失败: ${path.uri} (URL is not a valid path)`);
  const hasher = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path.path, { highWaterMark: COPY_BUFFER_BYTES })) hasher.update(chunk as Buffer);
  } catch (error) {
    throw fileSystem(`读取文件失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
  return hasher.digest('hex');
}

async function ensureParent(path: string, deps: FileOperationDeps): Promise<void> {
  const parent = dirname(path);
  if (existsSync(parent)) return;
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    throw fileSystem(`创建目录失败: ${parent} (${formatIoError(error, deps.platform)})`);
  }
}

/** Close without masking the primary error (Rust Drop ignores close failures on the error path). */
async function closeQuietly(handle: FileHandle): Promise<void> {
  await handle.close().catch(() => undefined); // boundary-allow empty-catch: Rust drop(File) discards close errors after an earlier Err
}

export async function saveTextToFile(raw: string, content: string, deps: FileOperationDeps): Promise<void> {
  const path = classifyPath(raw);
  if (path.kind === 'virtual') throw fileSystem(`写入文件失败: ${path.uri} (URL is not a valid path)`);
  await ensureParent(path.path, deps);
  let handle: FileHandle;
  try {
    handle = await open(path.path, 'w');
  } catch (error) {
    throw fileSystem(`写入文件失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
  try {
    await handle.writeFile(new TextEncoder().encode(content));
  } catch (error) {
    await closeQuietly(handle);
    throw fileSystem(`写入文件失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
  try {
    await handle.close();
  } catch (error) {
    throw fileSystem(`刷新文件失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
}

async function openSource(path: PathKind, deps: FileOperationDeps): Promise<FileHandle> {
  if (path.kind === 'virtual') throw fileSystem(`读取文件失败: ${path.uri} (URL is not a valid path)`);
  try {
    return await open(path.path, 'r');
  } catch (error) {
    throw fileSystem(`读取文件失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
}

async function openTarget(path: PathKind, deps: FileOperationDeps): Promise<FileHandle> {
  if (path.kind === 'virtual') throw fileSystem(`写入文件失败: ${path.uri} (URL is not a valid path)`);
  await ensureParent(path.path, deps);
  try {
    return await open(path.path, 'w');
  } catch (error) {
    throw fileSystem(`写入文件失败: ${path.path} (${formatIoError(error, deps.platform)})`);
  }
}

/** `copy_file`：复制 → 回读目标并比较长度与 SHA-256，不一致时 fail-closed。 */
export async function copyFile(sourceRaw: string, targetRaw: string, deps: FileOperationDeps): Promise<void> {
  const source = classifyPath(sourceRaw);
  const target = classifyPath(targetRaw);
  if (source.kind === 'virtual' && source.uri === '') throw validation('源文件路径无效');
  if (target.kind === 'virtual' && target.uri === '') throw validation('目标路径无效');

  const label = `${displayOf(source)} -> ${displayOf(target)}`;
  const reader = await openSource(source, deps);
  let writer: FileHandle;
  try {
    if (target.kind === 'local') {
      const sourceStat = await reader.stat({ bigint: true });
      let targetStat;
      try {
        targetStat = statSync(target.path, { bigint: true });
      } catch (error) {
        // A new destination has no identity to compare.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw fileSystem(`写入文件失败: ${target.path} (${formatIoError(error, deps.platform)})`);
        }
      }
      if (targetStat && sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino) {
        throw validation('源文件和目标文件不能相同');
      }
    }
    writer = await openTarget(target, deps);
  } catch (error) {
    // Rust drops the already-opened reader when `open_writer` returns Err.
    await closeQuietly(reader);
    throw error;
  }
  const sourceHash = createHash('sha256');
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  let copied = 0;
  try {
    for (;;) {
      let read: number;
      try {
        ({ bytesRead: read } = await reader.read(buffer, 0, buffer.length, null));
      } catch (error) {
        throw fileSystem(`复制文件失败 (${label}): ${formatIoError(error, deps.platform)}`);
      }
      if (read === 0) break;
      sourceHash.update(buffer.subarray(0, read));
      try {
        let offset = 0;
        while (offset < read) offset += (await writer.write(buffer, offset, read - offset, null)).bytesWritten;
      } catch (error) {
        throw fileSystem(`复制文件失败 (${label}): ${formatIoError(error, deps.platform)}`);
      }
      copied += read;
    }
  } catch (error) {
    await closeQuietly(writer);
    await closeQuietly(reader);
    throw error;
  }
  await closeQuietly(reader);
  try {
    await writer.close();
  } catch (error) {
    throw fileSystem(`刷新文件失败: ${displayOf(target)} (${formatIoError(error, deps.platform)})`);
  }

  const sourceDigest = sourceHash.digest();
  if (target.kind === 'virtual') throw fileSystem(`目标回读失败，已停止并不得报成功: ${target.uri} (URL is not a valid path)`);
  let verifier: FileHandle;
  try {
    verifier = await open(target.path, 'r');
  } catch (error) {
    throw fileSystem(`目标回读失败，已停止并不得报成功: ${target.path} (${formatIoError(error, deps.platform)})`);
  }
  const targetHash = createHash('sha256');
  let verified = 0;
  try {
    for (;;) {
      let read: number;
      try {
        ({ bytesRead: read } = await verifier.read(buffer, 0, buffer.length, null));
      } catch (error) {
        throw fileSystem(`回读文件失败 (${displayOf(target)}): ${formatIoError(error, deps.platform)}`);
      }
      if (read === 0) break;
      targetHash.update(buffer.subarray(0, read));
      verified += read;
    }
  } finally {
    await closeQuietly(verifier);
  }
  if (copied !== verified || !sourceDigest.equals(targetHash.digest())) {
    throw fileSystem(
      `目标回读校验失败: ${displayOf(target)}（已写 ${copied} 字节，回读 ${verified} 字节，内容不一致则拒绝报成功）`,
    );
  }
}
