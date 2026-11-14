/**
 * Path classification and local file access from unified_file_manager.rs.
 *
 * Implemented: path classification, `copy_file`, SAF persist queue, and the
 * read-side helpers used by `textbooks_add` / `read_file_bytes` / `get_file_size`
 * / `hash_file` (`read_all_bytes_bounded`, `get_file_size`, `hash_file_sha256`,
 * `resolve_file_info` with magic-byte detection, `is_opaque_document_id`). Virtual URIs (`content://`
 * etc.) are Android SAF concepts and have no desktop equivalent in Electron;
 * the virtual branch fails closed with the Rust error wording instead of
 * silently reading a local path.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../errors/api.ts';
import { errorText, renameSyncWithRetry } from './data-space-files.ts';
import { storageLog } from './logging.ts';
import { rustTrim, utf8ByteLength } from '../util/portable.ts';
import {
  decodePath,
  detectExtensionFromHead,
  extractExtension,
  extractFileName,
  isAndroidSafPath,
  isOpaqueDocumentId,
  isSpecialScheme,
  isVirtualUri,
  pathExtension,
  rejectDoubleEncodedVirtualUri,
  sanitizeFileNameForFs,
} from './file-names.ts';

export {
  DOUBLE_ENCODED_VIRTUAL_URI_REJECTED,
  detectExtensionFromHead,
  extractExtension,
  extractFileName,
  isOpaqueDocumentId,
  isVirtualUri,
  rejectDoubleEncodedVirtualUri,
  sanitizeFileNameForFs,
} from './file-names.ts';
export type { ReadHead } from './file-names.ts';

export type PathKind = { kind: 'local'; path: string } | { kind: 'virtual'; uri: string };

const LOG_TARGET = 'dstu_storage::unified_file_manager';

function normalizeLocalPath(input: string): string {
  if (input.startsWith('file://')) return input.slice('file://'.length);
  if (input.startsWith('tauri://localhost/')) return `/${input.slice('tauri://localhost/'.length)}`;
  if (input.startsWith('tauri://')) return `/${input.slice('tauri://'.length)}`;
  return input;
}

function sanitizeUnicode(input: string): string {
  const filtered = input.replace(/[\u200B-\u200D\uFEFF\u00AD\u2060\u2061-\u2064\u202A-\u202E\u2066-\u2069]/g, '');
  return filtered
    .replace(/／/g, '/')
    .replace(/＼/g, '\\')
    .replace(/．/g, '.')
    .replace(/：/g, ':')
    .replace(/＊/g, '*')
    .replace(/？/g, '?')
    .replace(/＜/g, '<')
    .replace(/＞/g, '>')
    .replace(/｜/g, '|')
    .replace(/＂/g, '"');
}

/** unified_file_manager.rs:397. */
export function sanitizeForLegacy(input: string): string {
  const sanitized = sanitizeUnicode(input);
  if (isSpecialScheme(sanitized)) return sanitized;
  return decodePath(normalizeLocalPath(sanitized));
}

/** unified_file_manager.rs:73. */
export function classifyPath(rawPath: string): PathKind {
  const trimmed = rustTrim(rawPath.replace(/^\0+|\0+$/g, ''));
  if (!trimmed) throw AppError.validation('路径不能为空');

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

/** unified_file_manager.rs:509. */
export function lexicalNormalizePath(input: string): string {
  const parsed = path.parse(input);
  const rest = input.slice(parsed.root.length);
  const out: string[] = [];
  for (const part of rest.split(path.sep)) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out[out.length - 1] === '..' || (out.length === 0 && !parsed.root)) out.push('..');
      else if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join(path.sep);
  if (parsed.root) return joined ? `${parsed.root}${joined}` : parsed.root;
  return joined;
}

/** unified_file_manager.rs:492. */
export function canonicalizeLenient(input: string): string {
  try { return fs.realpathSync(input); }
  catch (error) { storageLog(LOG_TARGET, 'debug', `canonicalize ${input} 失败，回退词法归一化: ${errorText(error)}`); }
  const normalized = lexicalNormalizePath(input);
  const parent = path.dirname(normalized);
  if (parent && parent !== '.' && parent !== normalized) {
    try { return path.join(fs.realpathSync(parent), path.basename(normalized)); }
    catch (error) { storageLog(LOG_TARGET, 'debug', `canonicalize 父目录 ${parent} 失败: ${errorText(error)}`); }
  }
  return normalized;
}

function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  const climbs = relative === '..' || relative.startsWith(`..${path.sep}`);
  return relative === '' || (!climbs && !path.isAbsolute(relative));
}

/** unified_file_manager.rs:441. */
export function denyHiddenLocalPath(appDirs: readonly string[], rawPath: string): void {
  if (isVirtualUri(rawPath)) return;

  const resolved = canonicalizeLenient(sanitizeForLegacy(rawPath));
  const inAppDirs = appDirs.some((dir) => {
    let real = dir;
    try { real = fs.realpathSync(dir); }
    catch (error) { storageLog(LOG_TARGET, 'debug', `canonicalize 应用目录 ${dir} 失败: ${errorText(error)}`); }
    return containsPath(real, resolved);
  });
  if (inAppDirs) return;

  const hasHiddenComponent = resolved
    .split(path.sep)
    .some((part) => part !== '.' && part !== '..' && part.startsWith('.'));
  if (hasHiddenComponent) throw AppError.validation(`拒绝读取隐藏路径: ${rawPath}`);
}

/** unified_file_manager.rs:181 (local branch). */
export function openReadStream(rawPath: string): fs.ReadStream {
  const classified = classifyPath(rawPath);
  if (classified.kind === 'virtual') {
    throw AppError.file_system(`读取文件失败: ${classified.uri} (虚拟路径在当前平台不可用)`);
  }
  let fd: number;
  try { fd = fs.openSync(classified.path, 'r'); }
  catch (error) { throw AppError.file_system(`读取文件失败: ${classified.path} (${errorText(error)})`); }
  return fs.createReadStream('', { fd, autoClose: true });
}

// ------------------------------------------------------------------ 读取侧公开面（textbooks_add 等消费者）

function displayOf(kind: PathKind): string {
  return kind.kind === 'local' ? kind.path : kind.uri;
}

/** `open_reader` 的同步打开：本地按 Rust 文案报错；虚拟 URI 在桌面无 SAF，与 openReadStream 同样 fail-close。 */
function openReaderFd(kind: PathKind): number {
  if (kind.kind === 'virtual') {
    throw AppError.file_system(`读取文件失败: ${kind.uri} (虚拟路径在当前平台不可用)`);
  }
  try { return fs.openSync(kind.path, 'r'); }
  catch (error) { throw AppError.file_system(`读取文件失败: ${kind.path} (${errorText(error)})`); }
}

async function openReaderHandle(kind: PathKind): Promise<fsp.FileHandle> {
  if (kind.kind === 'virtual') {
    throw AppError.file_system(`读取文件失败: ${kind.uri} (虚拟路径在当前平台不可用)`);
  }
  try { return await fsp.open(kind.path, 'r'); }
  catch (error) { throw AppError.file_system(`读取文件失败: ${kind.path} (${errorText(error)})`); }
}

/**
 * unified_file_manager.rs:206 `read_all_bytes_bounded`：带上限的全量读取。
 * 本地文件先 `metadata().len()` 预检（超限报 validation 并带实际大小）；实际读取最多
 * `maxBytes + 1` 字节（Rust `take(max_bytes.saturating_add(1))`），防预检后文件增长（TOCTOU）。
 * 异步实现只为不阻塞主进程事件循环，错误种类、文案与 Rust 同步版逐条一致。
 */
export async function readAllBytesBounded(rawPath: string, maxBytes: number): Promise<Buffer> {
  const kind = classifyPath(rawPath);
  if (kind.kind === 'local') {
    let size: number;
    try { size = (await fsp.stat(kind.path)).size; }
    catch (error) { throw AppError.file_system(`获取文件信息失败: ${kind.path} (${errorText(error)})`); }
    if (size > maxBytes) {
      throw AppError.validation(`文件过大: ${size} 字节，超过读取上限 ${maxBytes} 字节: ${kind.path}`);
    }
  }

  const handle = await openReaderHandle(kind);
  const cap = maxBytes + 1;
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const want = Math.min(64 * 1024, cap - total);
      const buffer = Buffer.allocUnsafe(want);
      let read: number;
      try { ({ bytesRead: read } = await handle.read(buffer, 0, want, null)); }
      catch (error) { throw AppError.file_system(`读取文件失败: ${displayOf(kind)} (${errorText(error)})`); }
      if (read === 0) break;
      chunks.push(read === want ? buffer : buffer.subarray(0, read));
      total += read;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (total > maxBytes) {
    throw AppError.validation(`文件过大: 超过读取上限 ${maxBytes} 字节: ${displayOf(kind)}`);
  }
  return Buffer.concat(chunks, total);
}

/**
 * unified_file_manager.rs:677 `get_file_size`：本地文件取 metadata 长度；虚拟 URI 在 Rust 中流式累计，
 * 桌面上打开即按 `open_reader` 的文案失败。
 */
export function getFileSize(rawPath: string): number {
  const kind = classifyPath(rawPath);
  if (kind.kind === 'local') {
    try { return fs.statSync(kind.path).size; }
    catch (error) { throw AppError.file_system(`获取文件信息失败: ${kind.path} (${errorText(error)})`); }
  }
  // Rust 对虚拟 URI 经 `open_reader` 流式累计；桌面无 SAF，打开即按同一文案失败。
  throw AppError.file_system(`读取文件失败: ${kind.uri} (虚拟路径在当前平台不可用)`);
}

/** unified_file_manager.rs:711 `hash_file_sha256`：64KB 分块流式 SHA-256，返回小写十六进制。 */
export async function hashFileSha256(rawPath: string): Promise<string> {
  const kind = classifyPath(rawPath);
  const handle = await openReaderHandle(kind);
  const hasher = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      let read: number;
      try { ({ bytesRead: read } = await handle.read(buffer, 0, buffer.length, null)); }
      catch (error) { throw AppError.file_system(`读取文件失败: ${displayOf(kind)} (${errorText(error)})`); }
      if (read === 0) break;
      hasher.update(buffer.subarray(0, read));
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hasher.digest('hex');
}

/** 所有支持导入的文件扩展名（小写）。unified_file_manager.rs:760。 */
const SUPPORTED_IMPORT_EXTENSIONS: readonly string[] = [
  'pdf', 'docx', 'txt', 'md', 'xlsx', 'xls', 'ods', 'html', 'htm', 'pptx', 'epub', 'rtf', 'csv',
  'json', 'xml',
];

/** unified_file_manager.rs:854 `read_first_bytes`。 */
function readFirstBytes(rawPath: string, n: number): Buffer {
  const kind = classifyPath(rawPath);
  const fd = openReaderFd(kind);
  try {
    const buffer = Buffer.alloc(n);
    let total = 0;
    while (total < n) {
      let read: number;
      try { read = fs.readSync(fd, buffer, total, n - total, null); }
      catch (error) { throw AppError.file_system(`读取文件头失败: ${displayOf(kind)} (${errorText(error)})`); }
      if (read === 0) break;
      total += read;
    }
    return buffer.subarray(0, total);
  } finally { fs.closeSync(fd); }
}

/** Rust `.ok()`：读取失败一律视为无法识别。 */
function tryReadFirstBytes(rawPath: string, n: number): Buffer | null {
  try { return readFirstBytes(rawPath, n); } catch { return null; }
}

/** unified_file_manager.rs:768 `detect_extension_from_magic`：识别逻辑见 {@link detectExtensionFromHead}。 */
export function detectExtensionFromMagic(rawPath: string): string | null {
  return detectExtensionFromHead((n) => tryReadFirstBytes(rawPath, n));
}

/**
 * unified_file_manager.rs:1014 `resolve_file_info`：返回 `[显示名, 扩展名 | null]`。
 * 1. URI 末段已有扩展名，且扩展名受支持或名字不是不透明 ID → 直接用；
 * 2. 否则用 magic bytes 检测，名字不透明或无扩展名时补上检测到的扩展名；
 * 3. 仍无法识别 → 原名（清洗后）+ URI 扩展名。
 * 与 Rust 一样从不抛错。
 */
export function resolveFileInfo(rawPath: string): [name: string, extension: string | null] {
  const uriName = extractFileName(rawPath);
  const rawExt = pathExtension(uriName);
  const uriExt = rawExt ? rawExt.toLowerCase() : null;

  if (uriExt !== null && (SUPPORTED_IMPORT_EXTENSIONS.includes(uriExt) || !isOpaqueDocumentId(uriName))) {
    return [sanitizeFileNameForFs(uriName), uriExt];
  }

  const detected = detectExtensionFromMagic(rawPath);
  if (detected !== null) {
    const safeName = isOpaqueDocumentId(uriName) || uriExt === null
      ? `${sanitizeFileNameForFs(uriName)}.${detected}`
      : sanitizeFileNameForFs(uriName);
    return [safeName, detected];
  }
  return [sanitizeFileNameForFs(uriName), uriExt];
}

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0;
  while (offset < chunk.length) {
    offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
  }
}

/**
 * unified_file_manager.rs:252 `copy_file`：本地路径流式复制 + 长度/SHA-256 回读校验。
 * 虚拟 URI 在 Electron 桌面没有 SAF 对应实现，按 Rust 的同一错误形状 fail-close。
 */
export async function copyFileVerified(source: string, target: string): Promise<number> {
  const sourceKind = classifyPath(source);
  const targetKind = classifyPath(target);
  if (sourceKind.kind === 'virtual') {
    throw AppError.file_system(`读取文件失败: ${sourceKind.uri} (虚拟路径在当前平台不可用)`);
  }
  if (targetKind.kind === 'virtual') {
    throw AppError.file_system(`写入文件失败: ${targetKind.uri} (虚拟路径在当前平台不可用)`);
  }

  const targetParent = path.dirname(targetKind.path);
  try { fs.mkdirSync(targetParent, { recursive: true }); }
  catch (error) { throw AppError.file_system(`创建目录失败: ${targetParent} (${errorText(error)})`); }
  let readFd: number;
  try { readFd = fs.openSync(sourceKind.path, 'r'); }
  catch (error) { throw AppError.file_system(`读取文件失败: ${sourceKind.path} (${errorText(error)})`); }
  let writeFd: number;
  try { writeFd = fs.openSync(targetKind.path, 'w'); }
  catch (error) {
    fs.closeSync(readFd);
    throw AppError.file_system(`写入文件失败: ${targetKind.path} (${errorText(error)})`);
  }

  let copied: { bytes: number; digest: Uint8Array };
  try {
    copied = await digestCopy(
      fs.createReadStream('', { fd: readFd, autoClose: true }),
      (chunk) => writeAll(writeFd, chunk),
      `${sourceKind.path} -> ${targetKind.path}`,
    );
  } finally {
    fs.closeSync(writeFd);
  }

  let verifyFd: number;
  try { verifyFd = fs.openSync(targetKind.path, 'r'); }
  catch (error) {
    // Rust wraps `open_reader`'s own `读取文件失败: …` inside this message.
    throw AppError.file_system(
      `目标回读失败，已停止并不得报成功: ${targetKind.path} (读取文件失败: ${targetKind.path} (${errorText(error)}))`,
    );
  }
  const verified = await digestRead(fs.createReadStream('', { fd: verifyFd, autoClose: true }), targetKind.path);
  ensureIdenticalCopy(copied.bytes, copied.digest, verified.bytes, verified.digest, targetKind.path);
  return copied.bytes;
}

/** unified_file_manager.rs:299. */
export async function digestCopy(
  reader: AsyncIterable<Uint8Array>,
  write: (chunk: Uint8Array) => void,
  label: string,
): Promise<{ bytes: number; digest: Uint8Array }> {
  const hasher = createHash('sha256');
  let total = 0;
  try {
    for await (const chunk of reader) {
      hasher.update(chunk);
      write(chunk);
      total += chunk.length;
    }
  } catch (error) {
    throw AppError.file_system(`复制文件失败 (${label}): ${errorText(error)}`);
  }
  return { bytes: total, digest: new Uint8Array(hasher.digest()) };
}

/** unified_file_manager.rs:324. */
export async function digestRead(
  reader: AsyncIterable<Uint8Array>,
  label: string,
): Promise<{ bytes: number; digest: Uint8Array }> {
  const hasher = createHash('sha256');
  let total = 0;
  try {
    for await (const chunk of reader) {
      hasher.update(chunk);
      total += chunk.length;
    }
  } catch (error) {
    throw AppError.file_system(`回读文件失败 (${label}): ${errorText(error)}`);
  }
  return { bytes: total, digest: new Uint8Array(hasher.digest()) };
}

/** unified_file_manager.rs:342. */
export function ensureIdenticalCopy(
  copied: number,
  sourceDigest: Uint8Array,
  verified: number,
  targetDigest: Uint8Array,
  targetLabel: string,
): void {
  const sameDigest = Buffer.from(sourceDigest).equals(Buffer.from(targetDigest));
  if (copied !== verified || !sameDigest) {
    throw AppError.file_system(
      `目标回读校验失败: ${targetLabel}（已写 ${copied} 字节，回读 ${verified} 字节，内容不一致则拒绝报成功）`,
    );
  }
}

/** unified_file_manager.rs:357. */
export function requiredTempCopyBytes(sourceBytes: number): number {
  // Rust `saturating_mul(2)` on u64.
  return sourceBytes > Number.MAX_SAFE_INTEGER / 2 ? Number.MAX_SAFE_INTEGER : sourceBytes * 2;
}

/** unified_file_manager.rs:361. */
export function ensureEnoughTempSpace(available: number, sourceBytes: number, label: string): void {
  const required = requiredTempCopyBytes(sourceBytes);
  if (available < required) {
    throw AppError.file_system(
      `临时物化空间不足，已停止以免半包: ${label}（源 ${sourceBytes} 字节，需要约 ${required} 字节，可用 ${available} 字节）`,
    );
  }
}

export const PENDING_SAF_PERSIST_FILE = 'pending_saf_persist.uri';
export const PENDING_SAF_PERSIST_DIR = 'pending_saf_persist';

/** unified_file_manager.rs:586. */
function persistableSafEntryName(uri: string): string {
  const digest = createHash('sha256').update(uri).digest();
  return `${digest.subarray(0, 8).toString('hex')}.uri`;
}

/** unified_file_manager.rs:593. */
export function persistableSafQueueFile(appDataDir: string, uri: string): string {
  return path.join(appDataDir, PENDING_SAF_PERSIST_DIR, persistableSafEntryName(uri));
}

/** unified_file_manager.rs:603. */
export function queuePersistableSafUri(appDataDir: string, uri: string): void {
  rejectDoubleEncodedVirtualUri(uri);
  const trimmed = rustTrim(uri);
  if (!trimmed.toLowerCase().startsWith('content://')) return;
  if (utf8ByteLength(trimmed) > 8 * 1024 || /[\n\r]/.test(trimmed)) {
    throw AppError.validation('SAF persist 队列拒绝过长或含换行的 URI');
  }
  const queueDir = path.join(appDataDir, PENDING_SAF_PERSIST_DIR);
  try { fs.mkdirSync(queueDir, { recursive: true }); }
  catch (error) {
    throw AppError.file_system(`创建 SAF persist 队列目录失败: ${queueDir} (${errorText(error)})`);
  }
  const destination = persistableSafQueueFile(appDataDir, trimmed);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, trimmed); }
  catch (error) {
    throw AppError.file_system(`写入 SAF persist 队列失败: ${temporary} (${errorText(error)})`);
  }
  try { renameSyncWithRetry(temporary, destination); }
  catch (error) {
    try { fs.unlinkSync(temporary); }
    catch (cleanupError) { storageLog(LOG_TARGET, 'warn', `清理 SAF persist 队列临时文件失败 ${temporary}: ${errorText(cleanupError)}`); }
    throw AppError.file_system(`提交 SAF persist 队列失败: ${destination} (${errorText(error)})`);
  }
}
