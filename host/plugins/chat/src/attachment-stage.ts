/**
 * `chat_v2_stage_context_attachments` (attachment_stage_executor.rs:210-1295, 1305-1456, 1763-1922).
 *
 * Send-time materialization of binary ContextRefs into the session temp root.
 * The owner reads stay with their owners: VFS attachment rows/content via
 * `vfsRepo.attachments` (incl. L11 `getInlineDataWithConn` for :1350-1362),
 * ZIP entry metadata via F4 `ZipArchive.inspectByIndex`, task-object handles and
 * corpus manifests via agent-skills, runtime roots via agent-workspace.
 * This file owns only the stage file naming / `.staged_index.json` / bounded IO /
 * archive scan limits / pagination flow that live in the Rust executor itself.
 */
import * as path from '../../../platform/util/path.ts';
import { utf8Encode } from '../../../platform/crypto/encoding.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import { decodeBase64Standard } from '../../../platform/util/portable.ts';
import { ioMessage } from '../../../platform/paths/io-error.ts';
import type { AttachmentRepository, VfsAttachmentContentSource } from '../../vfs-repos/api.ts';
import { normalizeRuntimeRelativePath } from '../../agent-workspace/portable.ts';
import {
  TaskObjectHandleBuilder, buildCorpusManifest, corpusManifestModelNotice, derivedEdge,
  hashTransformParams, managedLocator, withParamsHash,
} from '../../agent-skills/portable.ts';
import type {
  CorpusManifest, DerivedEdge, ManagedLocator, ObjectCapabilities, TaskObjectHandle,
} from '../../agent-skills/api.ts';
import { chatWorkspaceRuntime } from './runtime-roots.ts';
import type {
  AutoStageContextAttachmentFailure, AutoStageContextAttachmentInput, AutoStageContextAttachmentsResult,
} from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { errorText } from './logger.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';
import type { ZipIndexEntry } from '../../../platform/util/zip.ts';
import {
  chatLocalFs, LocalFsUnavailableError, type ChatZipArchive, type LocalReadHandle, type LocalStat, type LocalWriteHandle,
} from './local-fs.ts';

/** `readZip(bytes)` 的端口版：移动端没有 ZIP 解析（`node:zlib`）时按不可用报错。 */
function openZip(bytes: Uint8Array): ChatZipArchive {
  const parse = chatLocalFs().zip;
  if (parse === undefined) throw new LocalFsUnavailableError('read zip');
  return parse(bytes);
}

// ---------------------------------------------------------------- constants (:209-246)
export const STAGE_SUBDIR = 'attachments';
export const EXTRACT_SUBDIR = 'extracted';
export const STAGE_INDEX_FILE = '.staged_index.json';
export const MAX_STAGE_BYTES = 256 * 1024 * 1024;
const MAX_STAGE_INDEX_BYTES = 256 * 1024;
const MAX_STAGE_INDEX_ENTRIES = 2_048;
const FILE_IO_BUFFER_BYTES = 64 * 1024;
const MAX_SUFFIX_ATTEMPTS = 100;
export const MAX_FILE_NAME_CHARS = 120;
export const MAX_AUTO_STAGE_ITEMS = 64;
export const MAX_CORPUS_ITEMS = 4_096;
const MAX_ARCHIVE_ENTRIES = 4_096;
const MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSION_RATIO = 200;
const MAX_ARCHIVE_MANIFEST_ENTRIES = 200;

const READ_ONLY_MATERIALIZABLE: ObjectCapabilities = {
  readable: true, materializable: true, writable: false, shareable: false, sendable: false, deletable: false,
};

export interface StagedFile { relativePath: string; sizeBytes: number; sha256: string; reused: boolean }
export type AttachmentPayload = { kind: 'disk'; path: string } | { kind: 'bytes'; data: Uint8Array };
export interface ResolvedAttachment { name: string; mimeType: string | null; payload: AttachmentPayload }

/** Owner surfaces consumed here (vfs-repos `AttachmentRepository` + L11 `getInlineDataWithConn`). */
export type StageAttachmentRepository = Pick<AttachmentRepository, 'getById' | 'getContentSource'> & {
  getInlineDataWithConn(conn: DatabaseHandle, fileId: string): string | null;
};
export interface StageVfsDatabase { getConnSafe(): DatabaseHandle; blobsDir(): string }
export interface StageContextDeps {
  dataDir: string;
  vfsDatabase(): StageVfsDatabase;
  attachments(): StageAttachmentRepository;
}

// ---------------------------------------------------------------- archive scan (:338-510)
function archiveFormat(name: string, mimeType: string | null): 'zip' | 'rar' | '7z' | null {
  const lowerName = name.toLowerCase();
  const mime = rustTrim(mimeType ?? '').toLowerCase();
  if (lowerName.endsWith('.zip') || mime === 'application/zip' || mime === 'application/x-zip-compressed') return 'zip';
  if (lowerName.endsWith('.rar') || mime === 'application/vnd.rar' || mime === 'application/x-rar-compressed') return 'rar';
  if (lowerName.endsWith('.7z') || mime === 'application/x-7z-compressed') return '7z';
  return null;
}

function startsWithBytes(header: Uint8Array, signature: readonly number[]): boolean {
  return header.length >= signature.length && signature.every((byte, index) => header[index] === byte);
}

function validateArchiveSignature(file: string, format: string): void {
  let handle: LocalReadHandle;
  try { handle = chatLocalFs().openRead(file); }
  catch (error) { throw new Error(`Failed to open archive: ${ioMessage(error)}`); }
  const buffer = new Uint8Array(8);
  let read: number;
  try { read = handle.read(buffer); }
  catch (error) { throw new Error(`Failed to read archive signature: ${ioMessage(error)}`); }
  finally { handle.close(); }
  const header = buffer.subarray(0, read);
  const valid = format === 'zip'
    ? startsWithBytes(header, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(header, [0x50, 0x4b, 0x05, 0x06])
      || startsWithBytes(header, [0x50, 0x4b, 0x07, 0x08])
    : format === 'rar'
      ? startsWithBytes(header, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00])
        || startsWithBytes(header, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
      : format === '7z' ? startsWithBytes(header, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) : false;
  if (!valid) throw new Error(`Archive signature does not match declared ${format} format`);
}

export function scanZipArchive(file: string): Record<string, unknown> {
  validateArchiveSignature(file, 'zip');
  let bytes: Uint8Array;
  try { bytes = chatLocalFs().readBytes(file); }
  catch (error) { throw new Error(`Failed to open ZIP archive: ${ioMessage(error)}`); }
  let archive: ChatZipArchive;
  try { archive = openZip(bytes); } catch (error) { throw new Error(`Invalid ZIP archive: ${errorText(error)}`); }
  const count = archive.entries.length;
  if (count > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`Archive contains too many entries: ${count} exceeds ${MAX_ARCHIVE_ENTRIES}`);
  }
  let totalUncompressed = 0;
  let maxEntryUncompressed = 0;
  const entries: Record<string, unknown>[] = [];
  for (let index = 0; index < count; index += 1) {
    let entry: ZipIndexEntry;
    try { entry = archive.inspectByIndex(index); }
    catch (error) { throw new Error(`Failed to inspect ZIP entry ${index}: ${errorText(error)}`); }
    const name = entry.name;
    if (entry.enclosedName === null) throw new Error(`Archive entry has unsafe path: ${name}`);
    if (entry.unixMode !== null && (entry.unixMode & 0o170000) === 0o120000) {
      throw new Error(`Archive entry is a symbolic link: ${name}`);
    }
    const uncompressed = entry.size;
    const compressed = entry.compressedSize;
    if (uncompressed > MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error(`Archive entry is too large after extraction: ${name}`);
    }
    if (uncompressed > 0
      && (compressed === 0 || Math.floor(uncompressed / Math.max(compressed, 1)) > MAX_ARCHIVE_COMPRESSION_RATIO)) {
      throw new Error(`Archive entry exceeds compression ratio limit: ${name}`);
    }
    totalUncompressed += uncompressed;
    if (!Number.isSafeInteger(totalUncompressed)) throw new Error('Archive expanded size overflow');
    if (totalUncompressed > MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('Archive total expanded size exceeds limit');
    }
    maxEntryUncompressed = Math.max(maxEntryUncompressed, uncompressed);
    if (entries.length < MAX_ARCHIVE_MANIFEST_ENTRIES) {
      entries.push({ path: name, directory: entry.isDirectory, compressedSize: compressed, uncompressedSize: uncompressed });
    }
  }
  return {
    format: 'zip', scanned: true, safeToExtract: true, entryCount: count,
    totalUncompressedBytes: totalUncompressed, maxEntryUncompressedBytes: maxEntryUncompressed,
    entries, entriesTruncated: count > MAX_ARCHIVE_MANIFEST_ENTRIES,
    limits: {
      maxEntries: MAX_ARCHIVE_ENTRIES,
      maxTotalUncompressedBytes: MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES,
      maxEntryUncompressedBytes: MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES,
      maxCompressionRatio: MAX_ARCHIVE_COMPRESSION_RATIO,
    },
  };
}

export function scanArchiveForStage(file: string, name: string, mimeType: string | null): Record<string, unknown> | null {
  const format = archiveFormat(name, mimeType);
  if (format === null) return null;
  if (format === 'zip') return scanZipArchive(file);
  validateArchiveSignature(file, format);
  return {
    format, scanned: false, safeToExtract: false,
    reason: 'Entry-level scanning is unavailable for this archive format; no extraction was performed',
  };
}

export function scanStagedArchiveOrCleanup(tempRootPath: string, staged: StagedFile, name: string,
  mimeType: string | null): Record<string, unknown> | null {
  const stagedPath = path.join(tempRootPath, staged.relativePath);
  try { return scanArchiveForStage(stagedPath, name, mimeType); }
  catch (error) {
    if (!staged.reused) {
      removeIgnoringError(stagedPath);
      const parent = path.dirname(stagedPath);
      const index = loadStageIndex(parent);
      index.delete(staged.sha256);
      saveStageIndex(parent, index);
    }
    throw error;
  }
}

// ---------------------------------------------------------------- naming (:750-809)
function splitStemExt(name: string): [string, string | null] {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return [name.slice(0, dot), name.slice(dot + 1)];
  return [name, null];
}

function trimDots(value: string): string {
  let start = 0, end = value.length;
  while (start < end && value[start] === '.') start += 1;
  while (end > start && value[end - 1] === '.') end -= 1;
  return value.slice(start, end);
}

/** `sanitize_file_name` (:761-787); length counted in Unicode scalar values like `chars()`. */
export function sanitizeFileName(raw: string): string {
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    cleaned += '<>:"/\\|?*'.includes(ch) || code < 0x20 ? '_' : ch;
  }
  const trimmed = rustTrim(trimDots(rustTrim(cleaned)));
  if (trimmed === '') return 'attachment';
  let name = trimmed;
  if (Array.from(name).length > MAX_FILE_NAME_CHARS) {
    const [stem, ext] = splitStemExt(name);
    const extLen = ext === null ? 0 : Array.from(ext).length + 1;
    const keep = Math.max(MAX_FILE_NAME_CHARS - extLen, 1);
    const stemShort = Array.from(stem).slice(0, keep).join('');
    name = ext === null ? stemShort : `${stemShort}.${ext}`;
  }
  return name;
}

export function checkStageSize(len: number | bigint): void {
  if (BigInt(len) > BigInt(MAX_STAGE_BYTES)) {
    throw new Error(`Attachment too large to stage: ${len} bytes exceeds the ${MAX_STAGE_BYTES / (1024 * 1024)} MB limit`);
  }
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHasherSync('SHA-256').update(bytes).digestHex();
}

function isPlainStageFileName(name: string): boolean {
  return name !== '' && !name.includes('/') && !(chatLocalFs().platform === 'win32' && name.includes('\\'))
    && sanitizeFileName(name) === name && name !== STAGE_INDEX_FILE;
}

// ---------------------------------------------------------------- stage index (:811-861)
function lstat(target: string): LocalStat | null {
  try { return chatLocalFs().lstat(target); } catch { return null; }
}

/** HashMap semantics: lookups only; serialized order is irrelevant to readers. */
export function loadStageIndex(stageDir: string): Map<string, string> {
  const file = path.join(stageDir, STAGE_INDEX_FILE);
  const meta = lstat(file);
  if (meta === null || meta.kind !== 'file' || meta.size > MAX_STAGE_INDEX_BYTES) return new Map();
  let raw: Uint8Array;
  try {
    const handle = chatLocalFs().openRead(file);
    try {
      const buffer = new Uint8Array(MAX_STAGE_INDEX_BYTES + 1);
      let total = 0;
      for (;;) {
        const read = handle.read(buffer.subarray(total));
        if (read === 0) break;
        total += read;
        if (total >= buffer.length) break;
      }
      raw = buffer.subarray(0, total);
    } finally { handle.close(); }
  } catch { return new Map(); }
  if (raw.length > MAX_STAGE_INDEX_BYTES) return new Map();
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return new Map(); }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return new Map(); }
  // serde_json HashMap<String,String>: any non-string value fails the whole parse → default.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
  const index = new Map<string, string>();
  for (const [hash, name] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof name !== 'string') return new Map();
    index.set(hash, name);
  }
  if (index.size > MAX_STAGE_INDEX_ENTRIES) return new Map();
  for (const [hash, name] of [...index]) {
    if (!(hash.length === 64 && isPlainStageFileName(name))) index.delete(hash);
  }
  return index;
}

export function saveStageIndex(stageDir: string, index: Map<string, string>): void {
  if (index.size > MAX_STAGE_INDEX_ENTRIES) return;
  const raw = JSON.stringify(Object.fromEntries(index));
  if (utf8ByteLength(raw) > MAX_STAGE_INDEX_BYTES) return;
  const file = path.join(stageDir, STAGE_INDEX_FILE);
  if (lstat(file)?.kind === 'symlink') return;
  writeIgnoringError(file, raw);
}

// ---------------------------------------------------------------- bounded IO (:863-966)
function sha256FileBounded(file: string, maxBytes: number): [string, number] {
  let input: LocalReadHandle;
  try { input = chatLocalFs().openRead(file); }
  catch (error) { throw new Error(`Failed to open file: ${ioMessage(error)}`); }
  try {
    let declared: number;
    try { declared = input.size(); }
    catch (error) { throw new Error(`Failed to stat file: ${ioMessage(error)}`); }
    checkStageSize(declared);
    const hasher = createHasherSync('SHA-256');
    const buffer = new Uint8Array(FILE_IO_BUFFER_BYTES);
    let total = 0;
    for (;;) {
      let read: number;
      try { read = input.read(buffer); }
      catch (error) { throw new Error(`Failed to read file: ${ioMessage(error)}`); }
      if (read === 0) break;
      total += read;
      if (total > maxBytes) {
        throw new Error(`Attachment grew beyond the ${maxBytes / (1024 * 1024)} MB limit while hashing`);
      }
      hasher.update(buffer.subarray(0, read));
    }
    return [hasher.digestHex(), total];
  } finally { input.close(); }
}

function sameContent(file: string, sha256: string, size: number): boolean {
  try {
    const [hash, actual] = sha256FileBounded(file, MAX_STAGE_BYTES);
    return hash === sha256 && actual === size;
  } catch { return false; }
}

function copyFileBounded(source: string, target: string, expectedSize: number, expectedSha256: string): void {
  let input: LocalReadHandle;
  try { input = chatLocalFs().openRead(source); }
  catch (error) { throw new Error(`Failed to open staged attachment source: ${ioMessage(error)}`); }
  try {
    let size: number;
    try { size = input.size(); }
    catch (error) { throw new Error(`Failed to stat staged attachment source: ${ioMessage(error)}`); }
    checkStageSize(size);
    let output: LocalWriteHandle;
    try { output = chatLocalFs().openExclusive(target); }
    catch (error) { throw new Error(`Failed to create staged attachment: ${ioMessage(error)}`); }
    let failed = true;
    try {
      const hasher = createHasherSync('SHA-256');
      const buffer = new Uint8Array(FILE_IO_BUFFER_BYTES);
      let total = 0;
      for (;;) {
        let read: number;
        try { read = input.read(buffer); }
        catch (error) { throw new Error(`Failed to read staged attachment: ${ioMessage(error)}`); }
        if (read === 0) break;
        total += read;
        checkStageSize(total);
        try { writeAll(output, buffer.subarray(0, read)); }
        catch (error) { throw new Error(`Failed to write staged attachment: ${ioMessage(error)}`); }
        hasher.update(buffer.subarray(0, read));
      }
      if (total !== expectedSize || hasher.digestHex() !== expectedSha256) {
        throw new Error('Attachment source changed while it was being staged');
      }
      failed = false;
    } finally {
      output.close();
      if (failed) removeIgnoringError(target);
    }
  } finally { input.close(); }
}

/** `let _ = std::fs::remove_file(...)`: the cleanup outcome is deliberately discarded. */
function removeIgnoringError(target: string): boolean {
  try { chatLocalFs().removeForce(target); return true; } catch { return false; }
}

/** `let _ = std::fs::remove_dir_all(...)`: drops a half-extracted directory. */
function removeDirIgnoringError(target: string): boolean {
  try { chatLocalFs().removeDirForce(target); return true; } catch { return false; }
}

/** The stage index is only a cache: a failed write is deliberately discarded. */
function writeIgnoringError(file: string, raw: string): boolean {
  return chatLocalFs().writeTextIgnoring(file, raw);
}

function writeAll(output: LocalWriteHandle, bytes: Uint8Array): void {
  output.write(bytes);
}

function writeBytesCreateNew(target: string, bytes: Uint8Array): void {
  let output: LocalWriteHandle;
  try { output = chatLocalFs().openExclusive(target); }
  catch (error) { throw new Error(`Failed to create staged attachment: ${ioMessage(error)}`); }
  try { writeAll(output, bytes); }
  catch (error) { throw new Error(`Failed to write staged attachment: ${ioMessage(error)}`); }
  finally { output.close(); }
}

function stageRelativePath(fileName: string): string { return `${STAGE_SUBDIR}/${fileName}`; }

function canonical(target: string, label: string): string {
  try { return chatLocalFs().realpath(target); }
  catch (error) { throw new Error(`Failed to canonicalize ${label}: ${ioMessage(error)}`); }
}

function within(child: string, root: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// ---------------------------------------------------------------- staging (:968-1229)
export function stagePayloadIntoTempRoot(tempRootPath: string, requestedName: string, payload: AttachmentPayload): StagedFile {
  return stageIntoTempRoot(tempRootPath, requestedName, payload);
}

/** Shared body of `stage_disk_into_temp_root` / `stage_bytes_into_temp_root`; only hashing and the final write differ. */
function stageIntoTempRoot(tempRootPath: string, requestedName: string, payload: AttachmentPayload): StagedFile {
  let sha256: string, size: number;
  if (payload.kind === 'disk') [sha256, size] = sha256FileBounded(payload.path, MAX_STAGE_BYTES);
  else { size = payload.data.length; checkStageSize(size); sha256 = ''; }

  const fileName = sanitizeFileName(requestedName);
  const relative = normalizeRuntimeRelativePath(stageRelativePath(fileName));
  if (relative.split(path.sep).filter(part => part !== '').length !== 2) {
    throw new Error('Sanitized file name must resolve to a plain file name');
  }
  const stageDir = path.join(tempRootPath, STAGE_SUBDIR);
  try { chatLocalFs().mkdirp(stageDir); }
  catch (error) { throw new Error(`Failed to create stage dir: ${ioMessage(error)}`); }
  const rootCanon = canonical(tempRootPath, 'temp root');
  const stageDirCanon = canonical(stageDir, 'stage dir');
  if (!within(stageDirCanon, rootCanon)) throw new Error('Stage directory escapes the temp root');
  if (payload.kind === 'bytes') sha256 = sha256Hex(payload.data);

  const index = loadStageIndex(stageDirCanon);
  const existingName = index.get(sha256);
  if (existingName !== undefined) {
    const meta = lstat(path.join(stageDirCanon, existingName));
    if (meta !== null && meta.kind === 'file' && meta.size === size
      && sameContent(path.join(stageDirCanon, existingName), sha256, size)) {
      return { relativePath: stageRelativePath(existingName), sizeBytes: meta.size, sha256, reused: true };
    }
    index.delete(sha256);
  }

  const [stem, ext] = splitStemExt(fileName);
  let chosen: string | null = null;
  for (let attempt = 0; attempt <= MAX_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? fileName : ext === null ? `${stem}_${attempt}` : `${stem}_${attempt}.${ext}`;
    const target = path.join(stageDirCanon, candidate);
    const meta = lstat(target);
    if (meta === null) { chosen = candidate; break; }
    if (meta.kind === 'symlink') continue;
    if (meta.kind === 'file' && meta.size === size && sameContent(target, sha256, size)) {
      index.set(sha256, candidate);
      saveStageIndex(stageDirCanon, index);
      return { relativePath: stageRelativePath(candidate), sizeBytes: meta.size, sha256, reused: true };
    }
  }
  if (chosen === null) throw new Error(`Too many name conflicts in the staging directory for '${fileName}'`);

  const target = path.join(stageDirCanon, chosen);
  const parentCanon = canonical(path.dirname(target), 'stage parent dir');
  if (!within(parentCanon, rootCanon)) throw new Error('Stage target escapes the temp root');
  if (payload.kind === 'disk') copyFileBounded(payload.path, target, size, sha256);
  else writeBytesCreateNew(target, payload.data);

  index.set(sha256, chosen);
  saveStageIndex(stageDirCanon, index);
  return { relativePath: stageRelativePath(chosen), sizeBytes: size, sha256, reused: false };
}

// ---------------------------------------------------------------- managed extract (:519-744)
/** `resolve_staged_file_in_temp_root`: a regular, non-symlink file that stays inside the temp root. */
export function resolveStagedFileInTempRoot(tempRootPath: string, relativePath: string): string {
  const relative = normalizeRuntimeRelativePath(relativePath);
  const rootCanon = canonical(tempRootPath, 'temp root');
  const meta = lstat(path.join(tempRootPath, relative));
  if (meta === null) throw new Error(`Staged file not found: ${relativePath}`);
  if (meta.kind !== 'file') throw new Error('Staged path must be a regular file');
  let targetCanon: string;
  try { targetCanon = chatLocalFs().realpath(path.join(tempRootPath, relative)); }
  catch (error) { throw new Error(`Failed to resolve staged file path: ${ioMessage(error)}`); }
  if (!within(targetCanon, rootCanon)) throw new Error('Staged path escapes the session temp root');
  return targetCanon;
}

function createUniqueExtractDir(tempRootPath: string, requestedName: string): [string, string] {
  const baseName = sanitizeFileName(requestedName);
  const extractBase = path.join(tempRootPath, EXTRACT_SUBDIR);
  try { chatLocalFs().mkdirp(extractBase); }
  catch (error) { throw new Error(`Failed to create extract base dir: ${ioMessage(error)}`); }
  const rootCanon = canonical(tempRootPath, 'temp root');
  const baseCanon = canonical(extractBase, 'extract base dir');
  if (!within(baseCanon, rootCanon)) throw new Error('Extract directory escapes the temp root');
  for (let attempt = 0; attempt <= MAX_SUFFIX_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? baseName : `${baseName}_${attempt}`;
    const relative = `${EXTRACT_SUBDIR}/${candidate}`;
    let plain: boolean;
    try { plain = normalizeRuntimeRelativePath(relative).split(path.sep).filter(part => part !== '').length === 2; }
    catch { plain = false; }
    if (!plain) throw new Error('Sanitized extract dir name must resolve to a plain name');
    const target = path.join(baseCanon, candidate);
    let created: boolean;
    try { created = chatLocalFs().mkdirExclusive(target); }
    catch (error) { throw new Error(`Failed to create extract dir: ${ioMessage(error)}`); }
    if (created) return [target, relative];
  }
  throw new Error(`Too many name conflicts in the extract directory for '${baseName}'`);
}

/** `extract_zip_into_temp_root`: full scan first, then per-entry re-validation and bounded writes. */
export function extractZipIntoTempRoot(tempRootPath: string, zipRelativePath: string,
  targetDirName: string | null): Record<string, unknown> {
  const zipPath = resolveStagedFileInTempRoot(tempRootPath, zipRelativePath);
  const fileName = path.basename(zipPath);
  const format = archiveFormat(fileName, null);
  if (format !== null && format !== 'zip') {
    throw new Error(`EXTRACT_UNSUPPORTED_FORMAT: '${format}' archives are not supported; only zip can be extracted. `
      + 'Ask the user to re-package as zip, or (desktop only) use local_shell_execute.');
  }
  scanZipArchive(zipPath);
  const requested = targetDirName === null || rustTrim(targetDirName) === ''
    ? splitStemExt(fileName)[0] : rustTrim(targetDirName);
  const [extractDir, extractRelative] = createUniqueExtractDir(tempRootPath, requested);
  const extractDirCanon = canonical(extractDir, 'extract dir');
  try {
    let bytes: Uint8Array;
    try { bytes = chatLocalFs().readBytes(zipPath); }
    catch (error) { throw new Error(`Failed to open ZIP archive: ${ioMessage(error)}`); }
    let archive: ChatZipArchive;
    try { archive = openZip(bytes); } catch (error) { throw new Error(`Invalid ZIP archive: ${errorText(error)}`); }
    if (archive.entries.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Archive contains too many entries: ${archive.entries.length} exceeds ${MAX_ARCHIVE_ENTRIES}`);
    }
    let totalWritten = 0, fileCount = 0, dirCount = 0;
    const manifest: { path: string; sizeBytes: number }[] = [];
    for (let index = 0; index < archive.entries.length; index += 1) {
      let entry: ZipIndexEntry;
      try { entry = archive.inspectByIndex(index); }
      catch (error) { throw new Error(`Failed to read ZIP entry ${index}: ${errorText(error)}`); }
      const entryName = entry.name;
      const enclosed = entry.enclosedName;
      if (enclosed === null) throw new Error(`Archive entry has unsafe path: ${entryName}`);
      if (entry.unixMode !== null && (entry.unixMode & 0o170000) === 0o120000) {
        throw new Error(`Archive entry is a symbolic link: ${entryName}`);
      }
      const dest = path.join(extractDirCanon, enclosed);
      if (entry.isDirectory) {
        try { chatLocalFs().mkdirp(dest); }
        catch (error) { throw new Error(`Failed to create dir '${entryName}': ${ioMessage(error)}`); }
        dirCount += 1;
        continue;
      }
      const parent = path.dirname(dest);
      try { chatLocalFs().mkdirp(parent); }
      catch (error) { throw new Error(`Failed to create parent dir for '${entryName}': ${ioMessage(error)}`); }
      if (!within(canonical(parent, 'entry parent dir'), extractDirCanon)) {
        throw new Error(`Archive entry escapes extract dir: ${entryName}`);
      }
      let output: LocalWriteHandle;
      try { output = chatLocalFs().openExclusive(dest); }
      catch (error) { throw new Error(`Failed to create extracted file '${entryName}': ${ioMessage(error)}`); }
      let data: Uint8Array;
      try {
        try { data = archive.read(archive.entries[index]!, { maxOutputLength: MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES + 1 }); }
        catch (error) {
          if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
            throw new Error(`Archive entry is too large after extraction: ${entryName}`);
          }
          throw new Error(`Failed to extract '${entryName}': ${errorText(error)}`);
        }
        if (data.length > MAX_ARCHIVE_ENTRY_UNCOMPRESSED_BYTES) {
          throw new Error(`Archive entry is too large after extraction: ${entryName}`);
        }
        try { writeAll(output, data); }
        catch (error) { throw new Error(`Failed to extract '${entryName}': ${ioMessage(error)}`); }
      } finally { output.close(); }
      totalWritten += data.length;
      if (!Number.isSafeInteger(totalWritten)) throw new Error('Archive expanded size overflow');
      if (totalWritten > MAX_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES) throw new Error('Archive total expanded size exceeds limit');
      fileCount += 1;
      if (manifest.length < MAX_ARCHIVE_MANIFEST_ENTRIES) {
        const parts = enclosed.split(path.sep).filter(part => part !== '' && part !== '.');
        manifest.push({ path: `${extractRelative}/${parts.join('/')}`, sizeBytes: data.length });
      }
    }
    return {
      success: true, format: 'zip', root_id: 'temp', extract_dir: extractRelative, source: zipRelativePath,
      fileCount, directoryCount: dirCount, totalUncompressedBytes: totalWritten, files: manifest,
      filesTruncated: fileCount > MAX_ARCHIVE_MANIFEST_ENTRIES,
      hint: '解压完成：可用 workspace_file_list / workspace_file_read（root_id=temp, path=extract_dir 下的相对路径）继续处理；此工具是移动端等无 shell 环境下的受管解包途径。',
    };
  } catch (error) {
    removeDirIgnoringError(extractDirCanon);
    throw error;
  }
}

// ---------------------------------------------------------------- base64 (:1236-1286)
export function decodeBase64Payload(input: string, maxBytes = MAX_STAGE_BYTES): Uint8Array {
  let payload = input;
  if (input.startsWith('data:')) {
    const comma = input.indexOf(',');
    if (comma < 0) throw new Error('Invalid data URL format');
    payload = input.slice(comma + 1);
  }
  payload = rustTrim(payload);
  const encodedLen = utf8ByteLength(payload);
  const groups = Math.floor((encodedLen + 3) / 4);
  let padding = 0;
  for (let i = payload.length - 1; i >= 0 && padding < 2 && payload[i] === '='; i -= 1) padding += 1;
  const decodedUpperBound = groups * 3 - padding;
  if (decodedUpperBound < 0) throw new Error('Base64 decoded length overflow');
  if (decodedUpperBound > maxBytes) {
    throw new Error(`Attachment too large to stage: decoded base64 may exceed ${maxBytes} bytes`);
  }
  const decoded = decodeBase64Standard(payload);
  if (decoded.error !== undefined) throw new Error(`Failed to decode base64 content: ${decoded.error}`);
  if (decoded.bytes.length > maxBytes) {
    throw new Error(`Attachment too large to stage: ${decoded.bytes.length} decoded bytes exceeds ${maxBytes} bytes`);
  }
  return decoded.bytes;
}

// ---------------------------------------------------------------- VFS resolve (:1305-1384)
export function resolveVfsAttachment(deps: Pick<StageContextDeps, 'vfsDatabase' | 'attachments'>,
  fileId: string): ResolvedAttachment | null {
  let conn: DatabaseHandle;
  try { conn = deps.vfsDatabase().getConnSafe(); } catch (error) { throw new Error(errorText(error)); }
  const repo = deps.attachments();
  let record;
  try { record = repo.getById(conn, fileId); } catch (error) { throw new Error(errorText(error)); }
  if (record === null) return null;
  const name = rustTrim(record.name) === '' ? fileId : record.name;
  const mimeType = rustTrim(record.mimeType) === '' ? null : record.mimeType;

  let source: VfsAttachmentContentSource | null;
  try { source = repo.getContentSource(conn, deps.vfsDatabase().blobsDir(), fileId); }
  catch (error) { throw new Error(errorText(error)); }
  if (source !== null) {
    if (source.kind === 'file') {
      let size: number;
      try { size = chatLocalFs().stat(source.path).size; }
      catch (error) { throw new Error(`Failed to stat attachment source: ${ioMessage(error)}`); }
      checkStageSize(size);
      return { name, mimeType, payload: { kind: 'disk', path: source.path } };
    }
    return { name, mimeType, payload: { kind: 'bytes', data: decodeBase64Payload(source.data) } };
  }

  let content: string | null;
  try { content = repo.getInlineDataWithConn(conn, fileId); } catch (error) { throw new Error(errorText(error)); }
  if (content !== null && content !== '') {
    let bytes: Uint8Array;
    if (content.startsWith('data:')) bytes = decodeBase64Payload(content);
    else { bytes = utf8Encode(content); checkStageSize(bytes.length); }
    return { name, mimeType, payload: { kind: 'bytes', data: bytes } };
  }
  throw new Error(`Attachment ${fileId} has no raw content available in VFS`);
}

// ---------------------------------------------------------------- per-item stage (:1386-1456)
export interface AutoStagedContextAttachmentValue {
  resourceId: string; sourceId: string; rootId: string; relativePath: string; sizeBytes: number;
  sha256: string; reused: boolean; mediaType?: string; objectHandle: TaskObjectHandle;
}

function stageContextAttachment(deps: StageContextDeps, sessionId: string,
  input: AutoStageContextAttachmentInput): AutoStagedContextAttachmentValue {
  const resolved = resolveVfsAttachment(deps, input.sourceId);
  if (resolved === null) throw new Error(`Attachment source not found in VFS: ${input.sourceId}`);
  const requestedName = rustTrim(input.displayName) === '' ? resolved.name : rustTrim(input.displayName);
  const temp = chatWorkspaceRuntime().sessionRoot(deps.dataDir, sessionId, 'temp', true);
  const staged = stagePayloadIntoTempRoot(temp.path, requestedName, resolved.payload);
  scanStagedArchiveOrCleanup(temp.path, staged, requestedName, resolved.mimeType);

  const locator = managedLocator(temp.id, staged.relativePath);
  // serde_json preserve_order (src-tauri/Cargo.toml:101): json! insertion order.
  const stageParamsHash = hashTransformParams({
    resource_id: input.resourceId, source_id: input.sourceId, display_name: input.displayName,
  });
  const objectHandle = new TaskObjectHandleBuilder(
    `attachment:${input.sourceId}:${staged.sha256}`, 'file', resolved.name, 'chat_context_ref')
    .tool('send_time_attachment_stage')
    .derivedEdge(withParamsHash(derivedEdge(input.resourceId, 'attachment.stage_context'), stageParamsHash))
    .derivedEdge(withParamsHash(derivedEdge(input.sourceId, 'attachment.stage_context'), stageParamsHash))
    .mediaType(resolved.mimeType ?? undefined)
    .sizeBytes(staged.sizeBytes)
    .sha256(staged.sha256)
    .locator(locator)
    .capabilities({ ...READ_ONLY_MATERIALIZABLE })
    .build();
  return {
    resourceId: input.resourceId, sourceId: input.sourceId, rootId: temp.id,
    relativePath: staged.relativePath, sizeBytes: staged.sizeBytes, sha256: staged.sha256,
    reused: staged.reused, ...(resolved.mimeType === null ? {} : { mediaType: resolved.mimeType }), objectHandle,
  };
}

// ---------------------------------------------------------------- Rust-order serde (manifest bytes/sha)
function edgeJson(edge: DerivedEdge): Record<string, unknown> {
  return { sourceHandleId: edge.sourceHandleId, transformId: edge.transformId,
    ...(edge.transformParamsHash === undefined ? {} : { transformParamsHash: edge.transformParamsHash }),
    observedAt: edge.observedAt };
}

/** Field order of dstu-core `TaskObjectHandle` (task_objects.rs:222-243) for `to_string_pretty`. */
function handleJson(handle: TaskObjectHandle): Record<string, unknown> {
  const p = handle.provenance;
  const out: Record<string, unknown> = {
    schemaVersion: handle.schemaVersion, handleId: handle.handleId, kind: handle.kind, displayName: handle.displayName,
  };
  if (handle.mediaType !== undefined) out.mediaType = handle.mediaType;
  if (handle.sizeBytes !== undefined) out.sizeBytes = handle.sizeBytes;
  if (handle.sha256 !== undefined) out.sha256 = handle.sha256;
  if (handle.locator !== undefined) out.locator = { rootId: handle.locator.rootId, relativePath: handle.locator.relativePath };
  if (handle.providerRef !== undefined) out.providerRef = handle.providerRef;
  if (handle.acl !== undefined) out.acl = handle.acl;
  const c = handle.capabilities;
  out.capabilities = { readable: c.readable, materializable: c.materializable, writable: c.writable,
    shareable: c.shareable, sendable: c.sendable, deletable: c.deletable };
  if (handle.expiresAt !== undefined) out.expiresAt = handle.expiresAt;
  out.provenance = {
    source: p.source,
    ...(p.sourceUri === undefined ? {} : { sourceUri: p.sourceUri }),
    ...(p.server === undefined ? {} : { server: p.server }),
    ...(p.tool === undefined ? {} : { tool: p.tool }),
    ...(p.derivedFrom.length === 0 ? {} : { derivedFrom: p.derivedFrom.map(edgeJson) }),
    observedAt: p.observedAt,
  };
  return out;
}

function manifestJson(manifest: CorpusManifest): Record<string, unknown> {
  return {
    schemaVersion: manifest.schemaVersion, manifestId: manifest.manifestId, totalCount: manifest.totalCount,
    pageSize: manifest.pageSize,
    pages: manifest.pages.map(page => ({ pageNo: page.pageNo,
      objectHandles: page.objectHandles.map(entry => ({ handle: handleJson(entry.handle), refCount: entry.refCount })) })),
    createdAt: manifest.createdAt, sourceSessionId: manifest.sourceSessionId,
  };
}

// ---------------------------------------------------------------- corpus manifest (:1763-1836)
export interface CorpusManifestPayloadValue { manifest: CorpusManifest; objectHandle: TaskObjectHandle; modelNotice: string }

function materializeCorpusManifest(deps: StageContextDeps, sessionId: string, handles: TaskObjectHandle[],
  pageSize: number, carriedCount: number): CorpusManifestPayloadValue {
  const manifestId = `corpus_${globalThis.crypto.randomUUID()}`;
  const manifest = buildCorpusManifest(manifestId, sessionId, handles, pageSize);
  const manifestText = JSON.stringify(manifestJson(manifest), null, 2);
  const artifacts = chatWorkspaceRuntime().sessionRoot(deps.dataDir, sessionId, 'artifact', true);
  const locator: ManagedLocator = managedLocator('artifacts', `corpus/${manifestId}.json`);
  const rootCanon = canonical(artifacts.path, 'artifacts root');
  const target = path.join(rootCanon, locator.relativePath);
  const parent = path.dirname(target);
  try { chatLocalFs().mkdirp(parent); }
  catch (error) { throw new Error(`Failed to create corpus manifest dir: ${ioMessage(error)}`); }
  const parentCanon = canonical(parent, 'corpus manifest dir');
  if (!within(parentCanon, rootCanon)) throw new Error('Corpus manifest target escapes the artifacts root');
  try { chatLocalFs().writeText(target, manifestText); }
  catch (error) { throw new Error(`Failed to write corpus manifest: ${ioMessage(error)}`); }

  const pageParamsHash = hashTransformParams({ manifest_id: manifestId, page_size: pageSize });
  const edges = manifest.pages.flatMap(page => page.objectHandles)
    .map(entry => withParamsHash(derivedEdge(entry.handle.handleId, 'corpus.paginate'), pageParamsHash));
  const objectHandle = new TaskObjectHandleBuilder(`corpus_manifest:${manifestId}`, 'artifact',
    `corpus manifest (${manifest.totalCount} objects)`, 'chat_context_ref')
    .tool('send_time_attachment_stage')
    .derivedEdges(edges)
    .mediaType('application/json')
    .sizeBytes(utf8ByteLength(manifestText))
    .sha256(sha256Hex(manifestText))
    .locator({ ...locator })
    .capabilities({ ...READ_ONLY_MATERIALIZABLE })
    .build();
  return { manifest, objectHandle, modelNotice: corpusManifestModelNotice(manifest, carriedCount, locator) };
}

// ---------------------------------------------------------------- command (:1849-1922)
export async function stageContextAttachments(deps: StageContextDeps, sessionId: string,
  items: AutoStageContextAttachmentInput[]): Promise<AutoStageContextAttachmentsResult> {
  if (rustTrim(sessionId) === '') throw new Error('sessionId is required for attachment materialization');
  const expectedItems = items.length;
  if (expectedItems > MAX_CORPUS_ITEMS) {
    throw new Error(`Too many context attachments: ${expectedItems} exceeds the ${MAX_CORPUS_ITEMS} item corpus ceiling. `
      + 'Split the batch and retry; no items were staged or silently dropped.');
  }
  const paginated = expectedItems > MAX_AUTO_STAGE_ITEMS;
  const stagedAll: AutoStagedContextAttachmentValue[] = [];
  const failures: AutoStageContextAttachmentFailure[] = [];
  for (const input of items) {
    try { stagedAll.push(stageContextAttachment(deps, sessionId, input)); }
    catch (error) { failures.push({ resourceId: input.resourceId, sourceId: input.sourceId, error: errorText(error) }); }
  }
  const observedItems = stagedAll.length + failures.length;
  const carriedCount = Math.min(stagedAll.length, MAX_AUTO_STAGE_ITEMS);
  const corpusManifest = paginated
    ? materializeCorpusManifest(deps, sessionId, stagedAll.map(staged => staged.objectHandle), MAX_AUTO_STAGE_ITEMS, carriedCount)
    : null;
  if (paginated) stagedAll.length = Math.min(stagedAll.length, MAX_AUTO_STAGE_ITEMS);
  return {
    expectedItems, observedItems, coverageComplete: observedItems === expectedItems, truncated: paginated,
    attachments: stagedAll as AutoStageContextAttachmentsResult['attachments'], failures,
    ...(corpusManifest === null ? {} : { corpusManifest: corpusManifest as unknown as NonNullable<AutoStageContextAttachmentsResult['corpusManifest']> }),
  };
}
