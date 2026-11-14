/**
 * Skill package kernel: zip scan (limits + path guards), heuristic risk grading,
 * and the staging → commit → rollback installer. Ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:867–2414`.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { open as openFile, realpath as realpathFile, stat as statFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { renameSyncWithRetry } from '../../../platform/util/durable-fs.ts';
import type { SkillImportZipResult, SkillRequiresProbe } from '../api.ts';
import { debugPath, fail, ioMessage, type SkillFiles } from './files.ts';
import { parseRequires, probeRequires } from './requires.ts';
import {
  assessSkillPackageRisk, countYamlListItems, isPortableSkillPathComponent, isSafeZipEntry,
  rootSkillIdFromFrontmatter, zipSkillPrefix, type SkillFileBytes, type ZipScanOutcome,
} from './package-core.ts';
import {
  buildZip, MAX_SKILL_PACKAGE_ZIP_BYTES, readZipEntries, readZipEntry, ZipBudgetExceeded,
  zipEntryCountPreflight, DEFAULT_ZIP_SCAN_LIMITS, type ZipEntry, type ZipScanLimits,
} from './zip.ts';
import { runZipTask, isZipWorkerInfrastructureError } from './workers/zip-pool.ts';

export { MAX_SKILL_PACKAGE_ZIP_BYTES };

const MAX_PACKAGE_ZIP_BYTES = MAX_SKILL_PACKAGE_ZIP_BYTES;

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * skill_install_executor.rs:217–258 `read_zip_from_runtime` after root resolution: canonical containment
 * (`Path::starts_with`, component-wise), regular file, size cap before and while reading.
 */
export async function readRuntimeZipBytes(root: string, relative: string, summary: string): Promise<Uint8Array> {
  let rootCanon: string;
  try { rootCanon = await realpathFile(root); }
  catch (error) { throw new Error(`Failed to canonicalize runtime root: ${errorText(error)}`); }
  let targetCanon: string;
  try { targetCanon = await realpathFile(path.join(root, relative)); }
  catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') throw new Error(`Skill package file not found at ${summary}`);
    throw new Error(`Failed to resolve skill package path: ${errorText(error)}`);
  }
  const inside = path.relative(rootCanon, targetCanon);
  if (inside === '..' || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) {
    throw new Error('Path escapes the selected runtime root');
  }
  let size: number;
  try {
    const meta = await statFile(targetCanon);
    if (!meta.isFile()) throw new Error('Skill package source must be a regular file');
    size = meta.size;
  } catch (error) {
    if (error instanceof Error && error.message === 'Skill package source must be a regular file') throw error;
    throw new Error(`Failed to stat skill package file: ${errorText(error)}`);
  }
  if (size > MAX_PACKAGE_ZIP_BYTES) {
    throw new Error(`Skill package too large (${size} bytes > ${MAX_PACKAGE_ZIP_BYTES} bytes)`);
  }
  let handle: FileHandle;
  try { handle = await openFile(targetCanon, 'r'); }
  catch (error) { throw new Error(`Failed to open skill package file: ${errorText(error)}`); }
  try {
    const buffer = new Uint8Array(MAX_PACKAGE_ZIP_BYTES + 1);
    let length = 0;
    for (;;) {
      let read: number;
      try { ({ bytesRead: read } = await handle.read(buffer, length, buffer.length - length, null)); }
      catch (error) { throw new Error(`Failed to read skill package file: ${errorText(error)}`); }
      if (read === 0) break;
      length += read;
      if (length > MAX_PACKAGE_ZIP_BYTES) {
        throw new Error(`Skill package grew beyond the ${MAX_PACKAGE_ZIP_BYTES} byte limit while being read`);
      }
    }
    return buffer.slice(0, length);
  } finally { await handle.close(); }
}
const MAX_SKILL_FILE_BYTES = 2 * 1024 * 1024;

// Portable path guards, SKILL.md discovery and the risk grader live in `package-core.ts` so the
// mobile host can run the same installer rules without `node:fs` / `node:crypto`.
export {
  assessSkillPackageRisk, countPromptInjectionHits, countYamlListItems, isPortableSkillPathComponent,
  isSafeZipEntry, normalizeUnicodeForInjectionScan, rootSkillIdFromFrontmatter, zipSkillPrefix,
} from './package-core.ts';
export type { SkillFileBytes, ZipScanOutcome } from './package-core.ts';

/** Port of skills.rs:1390 `scan_skill_zip_bytes_with_limits`. */
export function scanSkillZipBytesWithLimits(zipBytes: Uint8Array, limits: ZipScanLimits): ZipScanOutcome {
  const declaredEntries = zipEntryCountPreflight(zipBytes);
  if (declaredEntries > limits.maxEntries) {
    throw new Error(`Zip contains too many entries (${declaredEntries} > ${limits.maxEntries})`);
  }

  const packageSha256 = createHash('sha256').update(zipBytes).digest('hex');
  const entries = readZipEntries(zipBytes);
  if (entries.length > limits.maxEntries) {
    throw new Error(`Zip contains too many entries (${entries.length} > ${limits.maxEntries})`);
  }

  const entryNames: string[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (Buffer.byteLength(name) > limits.maxEntryNameBytes) {
      throw new Error(`Zip entry name is too long (${Buffer.byteLength(name)} bytes > ${limits.maxEntryNameBytes} bytes)`);
    }
    entryNames.push(name);
  }

  const found = zipSkillPrefix(entryNames);
  if (!found) throw new Error('Zip must contain a SKILL.md (at root or in a skill folder)');
  const [prefix, foundSkillId] = found;
  let skillId = foundSkillId;
  if (!/^[\p{Alphabetic}\p{N}_-]+$/u.test(skillId)) {
    throw new Error('Skill folder name contains invalid characters');
  }

  const extracted: Array<[string, Uint8Array]> = [];
  let totalBytes = 0;
  const extractedPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory || entry.name.endsWith('/')) continue;
    const rawName = entry.name;
    if (!isSafeZipEntry(rawName)) continue;
    if (entry.size > limits.maxFileBytes) {
      throw new Error(`Zip entry too large: ${rawName} (${entry.size} bytes > ${limits.maxFileBytes} bytes)`);
    }
    const norm = rawName.replaceAll('\\', '/');
    let relative: string;
    if (!prefix) relative = norm;
    else if (norm.startsWith(prefix)) relative = norm.slice(prefix.length);
    else continue;
    if (!relative || relative.includes('..')) continue;
    if (relative.toLowerCase() === 'skill.md') relative = 'SKILL.md';
    const lower = relative.toLowerCase();
    if (extractedPaths.has(lower)) throw new Error(`Zip contains duplicate path: ${relative}`);
    extractedPaths.add(lower);

    const remainingTotal = Math.max(0, limits.maxTotalBytes - totalBytes);
    const readBudget = Math.min(limits.maxFileBytes, remainingTotal) + 1;
    let bytes: Uint8Array;
    try {
      bytes = readZipEntry(zipBytes, entry, readBudget);
    } catch (error) {
      if (!(error instanceof ZipBudgetExceeded)) throw error;
      if (remainingTotal < limits.maxFileBytes) {
        throw new Error(`Zip actual uncompressed size exceeds limit (${limits.maxTotalBytes} bytes)`);
      }
      let actual = limits.maxFileBytes + 1;
      try { actual = readZipEntry(zipBytes, entry, limits.maxFileBytes + 1).length; } catch (error) { warn('failed to measure oversized zip entry', error); }
      throw new Error(`Zip entry decompressed size exceeds per-file limit: ${rawName} (${actual} bytes > ${limits.maxFileBytes} bytes)`);
    }
    const actualBytes = bytes.length;
    if (actualBytes > limits.maxFileBytes) {
      throw new Error(`Zip entry decompressed size exceeds per-file limit: ${rawName} (${actualBytes} bytes > ${limits.maxFileBytes} bytes)`);
    }
    if (actualBytes > remainingTotal) {
      throw new Error(`Zip actual uncompressed size exceeds limit (${limits.maxTotalBytes} bytes)`);
    }
    totalBytes += actualBytes;
    extracted.push([relative, bytes]);
  }

  if (!extracted.length) throw new Error('No extractable files found in zip');
  if (!prefix) {
    const frontmatterSkillId = rootSkillIdFromFrontmatter(extracted.map(([relative, bytes]) => ({ relative, bytes })));
    if (frontmatterSkillId !== null) skillId = frontmatterSkillId;
  }

  const [riskLevel, riskSignals] = assessSkillPackageRisk(extracted.map(([relative, bytes]) => ({ relative, bytes })));
  return { skillId, files: extracted, packageSha256, riskLevel, riskSignals };
}

/** Port of skills.rs:1386 `scan_skill_zip_bytes`. */
export function scanSkillZipBytes(zipBytes: Uint8Array): ZipScanOutcome {
  return scanSkillZipBytesWithLimits(zipBytes, DEFAULT_ZIP_SCAN_LIMITS);
}

// ------------------------------------------------------------------ staging

export interface SkillPackageLogger {
  warn?(message: string): void;
}

const defaultPackageLogger: SkillPackageLogger = {
  warn: message => process.emitWarning(message),
};

function warn(message: string, error: unknown): void {
  warnWith(defaultPackageLogger, message, error);
}

function warnWith(logger: SkillPackageLogger, message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  logger.warn?.(`[agent-skills] ${message}: ${detail}`);
}

function removePathIfExists(target: string): void {
  let metadata;
  try { metadata = lstatSync(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isDirectory() && !metadata.isSymbolicLink()) rmSync(target, { recursive: true, force: true });
  else rmSync(target, { force: true });
}

/** skills.rs:1556 `sync_directory`: `#[cfg(not(unix))]` is a no-op; a Windows directory handle cannot be flushed (EPERM). */
function syncDirectory(target: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(target, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function walkTree(root: string): Array<{ path: string; relative: string; kind: 'file' | 'directory' | 'symlink' }> {
  const out: Array<{ path: string; relative: string; kind: 'file' | 'directory' | 'symlink' }> = [];
  const visit = (current: string, relative: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) out.push({ path: child, relative: childRelative, kind: 'symlink' });
      else if (entry.isDirectory()) {
        out.push({ path: child, relative: childRelative, kind: 'directory' });
        visit(child, childRelative);
      } else if (entry.isFile()) out.push({ path: child, relative: childRelative, kind: 'file' });
    }
  };
  visit(root, '');
  return out;
}

function syncDirectoryTree(root: string): void {
  const directories = [root];
  for (const entry of walkTree(root)) {
    if (entry.kind === 'symlink') throw new Error(`Symlinks are not allowed in staged skill directories: ${debugPath(entry.path)}`);
    if (entry.kind === 'directory') directories.push(entry.path);
  }
  for (const directory of directories.reverse()) {
    try { syncDirectory(directory); }
    catch (error) { throw new Error(`Failed to fsync staged directory ${debugPath(directory)}: ${ioMessage(error)}`); }
  }
}

function copySkillDirectoryToStaging(source: string, staging: string): void {
  for (const entry of walkTree(source)) {
    const target = path.join(staging, ...entry.relative.split('/'));
    if (entry.kind === 'symlink') {
      throw new Error(`Cannot transactionally update a skill containing symlinks: ${debugPath(entry.path)}`);
    }
    if (entry.kind === 'directory') {
      try { mkdirSync(target, { recursive: true }); }
      catch (error) { throw new Error(`Failed to create staged directory ${debugPath(target)}: ${ioMessage(error)}`); }
      continue;
    }
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      const bytes = readFileSync(entry.path);
      const fd = openSync(target, 'w');
      try { writeSync(fd, bytes); fsyncSync(fd); }
      finally { closeSync(fd); }
      chmodSync(target, statSync(entry.path).mode);
    } catch (error) {
      throw new Error(`Failed to copy existing skill file ${debugPath(entry.path)}: ${ioMessage(error)}`);
    }
  }
}

/** Port of skills.rs:1709 `safe_staged_relative_path`. */
export function safeStagedRelativePath(relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error(`Invalid staged skill path: ${debugPath(relative)}`);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid staged skill path: ${debugPath(relative)}`);
  }
  return path.join(...parts);
}

export class CommittedSkillDirectory {
  _liveDir: string;
  _backupDir: string | null;
  _finalized = false;
  _logger: SkillPackageLogger;

  constructor(
    liveDir: string,
    backupDir: string | null,
    logger: SkillPackageLogger = defaultPackageLogger,
  ) {
    this._liveDir = liveDir;
    this._backupDir = backupDir;
    this._logger = logger;
  }

  _rollbackInner(): void {
    const parent = path.dirname(this._liveDir);
    const discarded = path.join(parent, `.skill.rollback-discard-${randomUUID()}`);
    const liveExists = existsSync(this._liveDir) || isSymlink(this._liveDir);
    try {
      if (liveExists) renameSyncWithRetry(this._liveDir, discarded);
      if (this._backupDir !== null) {
        try { renameSyncWithRetry(this._backupDir, this._liveDir); }
        catch (error) {
          if (liveExists) { try { renameSyncWithRetry(discarded, this._liveDir); } catch (restoreError) { warnWith(this._logger, 'failed to restore discarded skill after rollback', restoreError); } }
          throw new Error(`Failed to restore previous skill: ${ioMessage(error)}`);
        }
      }
      if (liveExists) {
        try { removePathIfExists(discarded); }
        catch (error) { warnWith(this._logger, 'failed to remove rolled-back replacement', error); }
      }
      this._backupDir = null;
      this._finalized = true;
      try { syncDirectory(parent); }
      catch (error) { throw new Error(`Failed to fsync skills base after rollback: ${ioMessage(error)}`); }
    } catch (error) {
      if (existsSync(discarded) && !existsSync(this._liveDir)) { try { renameSyncWithRetry(discarded, this._liveDir); } catch (error) { warnWith(this._logger, 'failed to restore discarded skill', error); } }
      throw error;
    }
  }

  rollback(): void {
    if (this._finalized) return;
    this._rollbackInner();
  }

  finalize(): void {
    if (this._backupDir !== null) {
      try { removePathIfExists(this._backupDir); }
      catch (error) { warnWith(this._logger, 'failed to remove finalized rollback backup', error); }
      this._backupDir = null;
    }
    const parent = path.dirname(this._liveDir);
    try { syncDirectory(parent); } catch (error) { warnWith(this._logger, 'failed to fsync skills base after finalize', error); }
    this._finalized = true;
  }
}

function isSymlink(target: string): boolean {
  try { return lstatSync(target).isSymbolicLink(); }
  catch { return false; }
}

export class StagedSkillDirectory {
  _liveDir: string;
  _stagingDir: string;
  _overwrite: boolean;
  _logger: SkillPackageLogger;

  private constructor(
    liveDir: string,
    stagingDir: string,
    overwrite: boolean,
    logger: SkillPackageLogger,
  ) {
    this._liveDir = liveDir;
    this._stagingDir = stagingDir;
    this._overwrite = overwrite;
    this._logger = logger;
  }

  static create(
    liveDir: string,
    overwrite: boolean,
    preserveExisting: boolean,
    logger: SkillPackageLogger = defaultPackageLogger,
  ): StagedSkillDirectory {
    const parent = path.dirname(liveDir);
    if (!parent || parent === liveDir) throw new Error(`Skill directory has no parent: ${debugPath(liveDir)}`);
    try { mkdirSync(parent, { recursive: true }); }
    catch (error) { throw new Error(`Failed to create skills base ${debugPath(parent)}: ${ioMessage(error)}`); }
    const name = path.basename(liveDir);
    const stagingDir = path.join(parent, `.${name}.staging-${randomUUID()}`);
    try { mkdirSync(stagingDir); }
    catch (error) { throw new Error(`Failed to create skill staging directory ${debugPath(stagingDir)}: ${ioMessage(error)}`); }
    const staged = new StagedSkillDirectory(liveDir, stagingDir, overwrite, logger);
    try {
      if (preserveExisting && existsSync(liveDir)) copySkillDirectoryToStaging(liveDir, stagingDir);
    } catch (error) {
      staged.dispose();
      throw error;
    }
    return staged;
  }

  get liveDir(): string { return this._liveDir; }
  get stagingDir(): string { return this._stagingDir; }

  /** Rust `Drop`: remove the staging tree if it was not published. */
  dispose(): void {
    if (!this._stagingDir) return;
    try { removePathIfExists(this._stagingDir); } catch (error) { warnWith(this._logger, 'failed to remove staging directory', error); }
    this._stagingDir = '';
  }

  writeFile(relative: string, bytes: Uint8Array): void {
    const safe = safeStagedRelativePath(relative);
    const target = path.join(this._stagingDir, safe);
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      const fd = openSync(target, 'w');
      try { writeSync(fd, bytes); fsyncSync(fd); }
      finally { closeSync(fd); }
    } catch (error) {
      throw new Error(`Failed to write staged file ${debugPath(target)}: ${ioMessage(error)}`);
    }
  }

  commit(): CommittedSkillDirectory {
    return this._commitInner(false, null, null);
  }

  commitIfFileUnchanged(relative: string, expectedSha256: string): CommittedSkillDirectory {
    return this._commitInner(false, { relative: safeStagedRelativePath(relative), expectedSha256 }, null);
  }

  commitIfManifestUnchanged(expected: ReadonlyArray<readonly [string, string]>, ignoredPaths: readonly string[]): CommittedSkillDirectory {
    return this._commitInner(false, null, { expected: expected.map(([p, h]) => [p, h] as [string, string]), ignored: [...ignoredPaths] });
  }

  _commitInner(
    injectFailureAfterBackup: boolean,
    expectedLiveFile: { relative: string; expectedSha256: string } | null,
    expectedLiveManifest: { expected: Array<[string, string]>; ignored: string[] } | null,
  ): CommittedSkillDirectory {
    try {
      syncDirectoryTree(this._stagingDir);

      if (expectedLiveFile !== null) {
        const liveFile = path.join(this._liveDir, expectedLiveFile.relative);
        let bytes: Buffer;
        try { bytes = readFileSync(liveFile); }
        catch (error) { throw new Error(`Failed to re-read live skill precondition ${debugPath(liveFile)}: ${ioMessage(error)}`); }
        const actual = createHash('sha256').update(bytes).digest('hex');
        if (actual !== expectedLiveFile.expectedSha256) {
          throw new Error(`Live skill changed before commit: expected SHA-256 ${expectedLiveFile.expectedSha256}, got ${actual}`);
        }
      }

      if (expectedLiveManifest !== null) {
        const ignored = new Set(expectedLiveManifest.ignored.map(value => value.replaceAll('\\', '/').toLowerCase()));
        const actual: Array<[string, string]> = [];
        if (existsSync(this._liveDir)) {
          for (const entry of walkTree(this._liveDir)) {
            if (entry.kind === 'symlink') {
              throw new Error(`Live skill changed before commit: symlink found at ${debugPath(entry.path)}`);
            }
            if (entry.kind !== 'file') continue;
            if (ignored.has(entry.relative.toLowerCase())) continue;
            const bytes = readFileSync(entry.path);
            actual.push([entry.relative, createHash('sha256').update(bytes).digest('hex')]);
          }
        }
        actual.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
        const expected = [...expectedLiveManifest.expected].sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error('Live skill package changed before commit; create a new proposal from the current package');
        }
      }

      const liveExists = existsSync(this._liveDir) || isSymlink(this._liveDir);
      if (liveExists && !this._overwrite) {
        throw new Error(`Skill directory already exists: ${debugPath(this._liveDir)}. Pass overwrite=true to replace.`);
      }

      const parent = path.dirname(this._liveDir);
      let backupDir: string | null = null;
      if (liveExists) {
        const name = path.basename(this._liveDir);
        const backup = path.join(parent, `.${name}.backup-${randomUUID()}`);
        try { renameSyncWithRetry(this._liveDir, backup); }
        catch (error) { throw new Error(`Failed to move existing skill ${debugPath(this._liveDir)} to rollback backup: ${ioMessage(error)}`); }
        try { syncDirectory(parent); }
        catch (syncError) {
          try { renameSyncWithRetry(backup, this._liveDir); }
          catch (restoreError) {
            throw new Error(`Failed to fsync skills base (${ioMessage(syncError)}), and failed to restore the previous skill (${ioMessage(restoreError)}). Rollback backup: ${debugPath(backup)}`);
          }
          throw new Error(`Failed to fsync skills base after creating rollback backup: ${ioMessage(syncError)}`);
        }
        backupDir = backup;
      }

      if (injectFailureAfterBackup) {
        if (backupDir !== null) {
          try { renameSyncWithRetry(backupDir, this._liveDir); }
          catch (restoreError) {
            throw new Error(`Injected failure, and failed to restore the previous skill (${ioMessage(restoreError)}). Rollback backup: ${debugPath(backupDir)}`);
          }
          try { syncDirectory(parent); } catch (error) { warnWith(this._logger, 'failed to fsync skills base after injected failure restore', error); }
          backupDir = null;
        }
        throw new Error('Injected failure after existing skill backup');
      }

      try { renameSyncWithRetry(this._stagingDir, this._liveDir); }
      catch (commitError) {
        if (backupDir !== null) {
          try { renameSyncWithRetry(backupDir, this._liveDir); syncDirectory(parent); }
          catch (restoreError) {
            throw new Error(`Failed to publish staged skill (${ioMessage(commitError)}), and failed to restore the previous skill (${ioMessage(restoreError)}). Rollback backup: ${debugPath(backupDir)}`);
          }
          backupDir = null;
        }
        throw new Error(`Failed to publish staged skill: ${ioMessage(commitError)}`);
      }

      try { syncDirectory(parent); }
      catch (syncError) {
        const committed = new CommittedSkillDirectory(this._liveDir, backupDir, this._logger);
        try {
          committed.rollback();
          throw new Error(`Failed to fsync committed skill directory (${ioMessage(syncError)}); the previous skill was restored.`);
        } catch (rollbackError) {
          if (rollbackError instanceof Error && rollbackError.message.includes('the previous skill was restored')) throw rollbackError;
          throw new Error(`Failed to fsync committed skill directory (${ioMessage(syncError)}), and rollback failed (${ioMessage(rollbackError)}).`);
        }
      }

      this._stagingDir = '';
      return new CommittedSkillDirectory(this._liveDir, backupDir, this._logger);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
}

// ------------------------------------------------------------------ installer

export interface ScannedSkillPackage {
  result: SkillImportZipResult;
  files: Array<[string, Uint8Array]>;
  skillDir: string;
}

export class PreparedSkillPackage {
  _result: SkillImportZipResult;
  _staged: StagedSkillDirectory;

  constructor(result: SkillImportZipResult, staged: StagedSkillDirectory) {
    this._result = result;
    this._staged = staged;
  }

  get result(): SkillImportZipResult { return this._result; }

  /** Rust `StagedSkillDirectory::drop`: release an unprepared/uncommitted staging tree. */
  dispose(): void { this._staged.dispose(); }

  writeStagedFile(relative: string, bytes: Uint8Array): void {
    this._staged.writeFile(relative, bytes);
  }

  commit(): [SkillImportZipResult, CommittedSkillDirectory] {
    let committed: CommittedSkillDirectory;
    try { committed = this._staged.commit(); }
    catch (error) { fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }
    return [this._result, committed!];
  }
}

export interface VirtualZipReader {
  (uri: string, maxBytes: number): Uint8Array;
}

const VIRTUAL_SCHEMES = ['content://', 'asset://', 'ph://', 'image://', 'camera://'];
const ANDROID_SAF_PREFIXES = ['primary:', 'secondary:', 'raw:'];

/** Port of `unified_file_manager::is_virtual_uri` (SPECIAL_SCHEMES + SAF prefixes). */
export function isVirtualUri(value: string): boolean {
  const lower = value.trimStart().toLowerCase();
  return VIRTUAL_SCHEMES.some(scheme => lower.startsWith(scheme))
    || ANDROID_SAF_PREFIXES.some(prefix => lower.startsWith(prefix));
}

export class SkillPackages {
  _files: SkillFiles;
  _logger: SkillPackageLogger;
  constructor(files: SkillFiles, logger: SkillPackageLogger = defaultPackageLogger) {
    this._files = files;
    this._logger = logger;
  }

  async scanForBase(zipBytes: Uint8Array, basePath: string): Promise<ScannedSkillPackage> {
    if (!zipBytes.length) fail('INVALID_INPUT', 'Skill package is empty');
    if (zipBytes.length > MAX_PACKAGE_ZIP_BYTES) {
      fail('INVALID_INPUT', `Skill package too large (${zipBytes.length} bytes > ${MAX_PACKAGE_ZIP_BYTES} bytes)`);
    }
    const expandedBase = this._files.expandPath(basePath);
    this._files.validatePath(expandedBase);

    let scan: ZipScanOutcome;
    try { scan = await runZipTask<ZipScanOutcome>('scanSkillPackage', { zipBytes }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isZipWorkerInfrastructureError(error)) {
        return fail('IO_ERROR', `Zip import task failed: ${message}`);
      }
      return fail('INVALID_INPUT', message);
    }

    const skillDir = path.join(expandedBase, scan.skillId);
    this._files.validatePath(path.join(skillDir, 'SKILL.md'));

    let scriptsCount = 0;
    let referencesCount = 0;
    let skillMdContent = '';
    for (const [relative, bytes] of scan.files) {
      const lower = relative.replaceAll('\\', '/').toLowerCase();
      if (lower.startsWith('scripts/')) scriptsCount++;
      if (lower.startsWith('references/')) referencesCount++;
      if (lower === 'skill.md') skillMdContent = Buffer.from(bytes).toString('utf8');
    }
    const allowedToolsCount = skillMdContent
      ? countYamlListItems(skillMdContent, 'allowed-tools') + countYamlListItems(skillMdContent, 'allowedTools')
      : 0;
    let requires: SkillRequiresProbe | undefined;
    if (skillMdContent) requires = await probeRequires(parseRequires(skillMdContent));

    const result: SkillImportZipResult = {
      skill_id: scan.skillId,
      path: skillDir,
      files_extracted: scan.files.length,
      scripts_count: scriptsCount,
      references_count: referencesCount,
      allowed_tools_count: allowedToolsCount,
      package_sha256: scan.packageSha256,
      risk_level: scan.riskLevel,
      risk_signals: scan.riskSignals,
    };
    if (requires !== undefined) result.requires = requires;
    return { result, files: scan.files, skillDir };
  }

  async prepare(zipBytes: Uint8Array, basePath: string, overwrite: boolean): Promise<PreparedSkillPackage> {
    const scanned = await this.scanForBase(zipBytes, basePath);
    if (existsSync(scanned.skillDir) && !overwrite) {
      fail('INVALID_INPUT', `Skill directory already exists: ${debugPath(scanned.skillDir)}. Pass overwrite=true to replace.`);
    }
    let staged: StagedSkillDirectory;
    try { staged = StagedSkillDirectory.create(scanned.skillDir, overwrite, false, this._logger); }
    catch (error) { return fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }
    for (const [relative, bytes] of scanned.files) {
      try { staged.writeFile(relative, bytes); }
      catch (error) {
        staged.dispose();
        return fail('IO_ERROR', error instanceof Error ? error.message : String(error));
      }
    }
    return new PreparedSkillPackage(scanned.result, staged);
  }

  async install(zipBytes: Uint8Array, basePath: string, overwrite: boolean, dryRun: boolean): Promise<SkillImportZipResult> {
    if (dryRun) return (await this.scanForBase(zipBytes, basePath)).result;
    const prepared = await this.prepare(zipBytes, basePath, overwrite);
    try {
      const [result, committed] = prepared.commit();
      committed.finalize();
      return result;
    } finally {
      prepared.dispose();
    }
  }

  async readZipBytes(zipPath: string, readVirtual: VirtualZipReader): Promise<Uint8Array> {
    if (isVirtualUri(zipPath)) {
      const uri = zipPath.trim();
      let bytes: Uint8Array;
      try { bytes = readVirtual(uri, MAX_PACKAGE_ZIP_BYTES); }
      catch (error) { return fail('IO_ERROR', `Failed to read zip: ${error instanceof Error ? error.message : String(error)}`); }
      if (bytes.length > MAX_PACKAGE_ZIP_BYTES) {
        fail('INVALID_INPUT', `Zip file too large (> ${MAX_PACKAGE_ZIP_BYTES} bytes)`);
      }
      return bytes;
    }

    const expanded = this._files.expandPath(zipPath);
    // Rust uses tokio::fs here (skills.rs:2378-2413); keep all local file IO off
    // the Host event loop while preserving the take(MAX+1) bound and stages.
    let metadata;
    try { metadata = await statFile(expanded); }
    catch { return fail('INVALID_INPUT', `Zip file not found: ${debugPath(expanded)}`); }
    if (!metadata.isFile()) return fail('INVALID_INPUT', `Zip file not found: ${debugPath(expanded)}`);
    if (metadata.size > MAX_PACKAGE_ZIP_BYTES) {
      fail('INVALID_INPUT', `Zip file too large (${metadata.size} bytes > ${MAX_PACKAGE_ZIP_BYTES} bytes)`);
    }
    let handle: FileHandle;
    try { handle = await openFile(expanded, 'r'); }
    catch (error) {
      return fail('IO_ERROR', `Failed to open zip ${debugPath(expanded)}: ${ioMessage(error)}`);
    }
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      // Rust `file.take(MAX + 1).read_to_end`: never allocate the whole file
      // when it grows past the limit after the metadata check.
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, MAX_PACKAGE_ZIP_BYTES + 1));
      while (total <= MAX_PACKAGE_ZIP_BYTES) {
        const remaining = MAX_PACKAGE_ZIP_BYTES + 1 - total;
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, remaining), null);
        if (bytesRead === 0) break;
        chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
        total += bytesRead;
      }
    } catch (error) {
      return fail('IO_ERROR', `Failed to read zip ${debugPath(expanded)}: ${ioMessage(error)}`);
    } finally {
      try { await handle.close(); }
      catch (error) { this._logger.warn?.(`[agent-skills] failed to close zip ${debugPath(expanded)}: ${ioMessage(error)}`); }
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.length > MAX_PACKAGE_ZIP_BYTES) {
      fail('INVALID_INPUT', `Zip grew beyond the ${MAX_PACKAGE_ZIP_BYTES} byte limit while being read`);
    }
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async importZip(
    zipPath: string, basePath: string, overwrite: boolean, dryRun: boolean | null | undefined, readVirtual: VirtualZipReader,
  ): Promise<SkillImportZipResult> {
    const bytes = await this.readZipBytes(zipPath, readVirtual);
    return this.install(bytes, basePath, overwrite, dryRun ?? false);
  }
}

export const DEFAULT_AGENT_SKILLS_BASE = '~/.deep-student/skills';
export const MAX_SKILL_FILE_BYTES_LIMIT = MAX_SKILL_FILE_BYTES;

/** Deterministic repack helper shared by tap install/export (deflate zip). */
export function repackZip(files: readonly SkillFileBytes[]): Uint8Array {
  return buildZip(files.map(file => ({ name: file.relative, bytes: file.bytes })));
}
