/** Port of dstu-vfs blob_repo.rs. Physical paths are supplied by the caller. */
import { logError, logInfo, logWarn } from './logger.ts';
import { createHasherSync, sha256HexSync } from '../../../platform/crypto/sync.ts';
import { hostPath as path, basename, dirname, join, win32 } from '../../../platform/util/path.ts';
import { nanoid } from 'nanoid';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { vfsReposLocalRuntime, type LocalWriteHandle } from '../src/local-runtime.ts';
import {
  VfsRepositoryError,
  type BlobRepository,
  type StagedBlob,
  type VfsBlob,
} from '../api.ts';
import { databaseResult } from './errors.ts';
import { utcNow } from './timestamps.ts';

export interface BlobDeletionIntent {
  operationId: string;
  hash: string;
  relativePath: string;
  expectedHash: string | null;
  size: number | null;
}

type BlobSource = { kind: 'bytes'; data: Uint8Array } | { kind: 'staged'; staged: StagedBlob };

function localRuntime() {
  return vfsReposLocalRuntime();
}

class StagedBlobValue implements StagedBlob {
  path: string | null;
  hash = '';
  size = 0;
  constructor(path: string) { this.path = path; }
  dispose(): void {
    if (this.path !== null) {
      try { localRuntime().removeForce(this.path); }
      catch (error) { logWarn('[VFS::BlobRepo] Failed to remove staged blob:', error); }
      this.path = null;
    }
  }
}

/**
 * blob_repo.rs:299 `absolute_path.with_extension(format!("{}.tmp", nanoid))`: only the final component's
 * extension is replaced (a leading-dot name has none), so the temp file stays beside the blob.
 */
export function blobTempPath(absolutePath: string, id: string, flavor: Pick<typeof path, 'basename'> = path): string {
  const name = flavor.basename(absolutePath);
  const dot = name.lastIndexOf('.');
  const end = absolutePath.lastIndexOf(name) + (dot > 0 ? dot : name.length);
  return `${absolutePath.slice(0, end)}.${id}.tmp`;
}
function invalidState(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_OPERATION', `INVALID_STATE: ${message}`);
}
function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}
function pathParse(path: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Failed to parse path '${path}': ${reason}`);
}
function ioError(prefix: string, error: unknown): VfsRepositoryError {
  const message = error instanceof Error ? error.message : String(error);
  return new VfsRepositoryError('VFS_IO', `IO error: ${prefix}: ${message}`);
}
function conflict(key: string, message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_CONFLICT', `CONFLICT(${key}): ${message}`, { key });
}
function notFound(hash: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `blob not found: ${hash}`, { resourceType: 'blob', id: hash });
}
function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : undefined;
}

export function computeBlobHash(data: Uint8Array): string {
  return sha256HexSync(data);
}

/** Rust `build_blob_path`: `{first-2-chars}/{hash}.{ext ?? "bin"}`. */
export function buildBlobPath(blobsDir: string, hash: string, extension?: string | null): [string, string] {
  const prefix = hash.slice(0, Math.min(2, hash.length));
  const ext = extension ?? 'bin';
  const relativePath = `${prefix}/${hash}.${ext}`;
  return [relativePath, join(blobsDir, relativePath)];
}

function readBlobRow(row: Record<string, unknown>): VfsBlob {
  const blob: VfsBlob = {
    hash: String(row.hash),
    relativePath: String(row.relative_path),
    size: Number(row.size),
    refCount: Number(row.ref_count),
    createdAt: Number(row.created_at),
  };
  if (typeof row.mime_type === 'string') blob.mimeType = row.mime_type;
  return blob;
}

function ensureDeletionBoundary(conn: SqlExecutor): void {
  try { conn.exec('PRAGMA synchronous = FULL'); }
  catch {
    throw invalidState('blob physical deletion requires an autocommit connection after metadata commit');
  }
}

function withSavepoint<T>(conn: SqlExecutor, name: string, run: () => T): T {
  conn.exec(`SAVEPOINT ${name}`);
  try {
    const result = run();
    conn.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try { conn.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name};`); }
    catch (rollbackError) { logWarn('[VFS::BlobRepo] Savepoint rollback failed:', rollbackError); }
    throw error;
  }
}

function strictlyInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The existing file must realpath strictly inside realpath(vfs_blobs), the vfs-index
 * `containedBlobPath` rule. A missing target keeps the joined path, except a dangling symlink:
 * a later write through it would create its target wherever it points.
 */
function realTargetInside(blobsDir: string, target: string): boolean {
  let realTarget: string;
  try { realTarget = localRuntime().realpath(target); }
  catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 'ENOENT') return false;
    try { return localRuntime().lstat(target).kind !== 'symlink'; }
    catch { return true; }
  }
  let realRoot: string;
  try { realRoot = localRuntime().realpath(blobsDir); }
  catch { return false; }
  return strictlyInside(realRoot, realTarget);
}

/**
 * `blobs.relative_path` arrives through sync, so it is resolved only when it is relative on every
 * platform, has no `..`, no existing directory between vfs_blobs and the file is a symlink, and
 * the file itself resolves inside vfs_blobs.
 */
function containedBlobPath(blobsDir: string, relativePath: string): string | null {
  if (relativePath === '' || win32.parse(relativePath).root !== '') return null;
  const parts = relativePath.split(/[\\/]/);
  if (parts.some(part => part === '..')) return null;
  let current = blobsDir;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let isLink: boolean;
    try { isLink = localRuntime().lstat(current).kind === 'symlink'; }
    catch { break; }
    if (isLink) return null;
  }
  const target = join(blobsDir, relativePath);
  return realTargetInside(blobsDir, target) ? target : null;
}

const BLOB_PATH_REASON = 'blob path must remain inside vfs_blobs';

function safeBlobPath(
  blobsDir: string,
  relativePath: string,
  reason = 'blob deletion path must remain relative to vfs_blobs',
): string {
  const resolved = containedBlobPath(blobsDir, relativePath);
  if (resolved === null) throw pathParse(relativePath, reason);
  return resolved;
}

function computeFileHash(path: string): string {
  try { return computeBlobHash(localRuntime().readFile(path)); }
  catch (error) { throw ioError(`Failed to hash ${path}`, error); }
}

function quarantinePath(path: string, operationId: string): string {
  return join(dirname(path), `${basename(path)}.deleting-${operationId}`);
}

export class BlobRepo implements BlobRepository {
  storeBlob(conn: SqlExecutor, blobsDir: string, data: Uint8Array, mimeType?: string | null, extension?: string | null): VfsBlob {
    return databaseResult(() => this.storeSource(conn, blobsDir, { kind: 'bytes', data }, mimeType ?? null, extension ?? null));
  }

  stageStream(blobsDir: string, chunks: Iterable<Uint8Array>, maxBytes: number): StagedBlob {
    return databaseResult(() => {
      const stagingDir = join(blobsDir, '.staging');
      try { localRuntime().mkdirp(stagingDir); }
      catch (error) { throw ioError('Failed to create blob staging dir', error); }
      const staged = new StagedBlobValue(join(stagingDir, `${nanoid(16)}.tmp`));
      const hash = createHasherSync('SHA-256');
      try {
        for (const chunk of chunks) {
          staged.size += chunk.length;
          if (staged.size > maxBytes) {
            throw invalidArgument('content', `File too large: max ${Math.trunc(maxBytes / (1024 * 1024))}MB`);
          }
          hash.update(chunk);
          localRuntime().appendFile(staged.path!, chunk);
        }
        staged.hash = hash.digestHex();
        return staged;
      } catch (error) {
        staged.dispose();
        if (error instanceof VfsRepositoryError) throw error;
        throw ioError('Failed to write staged blob', error);
      }
    });
  }

  storeStagedBlob(conn: SqlExecutor, blobsDir: string, staged: StagedBlob, mimeType?: string | null, extension?: string | null): VfsBlob {
    return databaseResult(() => {
      if (staged.path === null) throw new VfsRepositoryError('VFS_INTERNAL', 'Internal error: staged blob already consumed');
      return this.storeSource(conn, blobsDir, { kind: 'staged', staged }, mimeType ?? null, extension ?? null);
    });
  }

  private storeSource(conn: SqlExecutor, blobsDir: string, source: BlobSource, mimeType: string | null, extension: string | null): VfsBlob {
    const hash = source.kind === 'bytes' ? computeBlobHash(source.data) : source.staged.hash;
    const dataLength = source.kind === 'bytes' ? source.data.length : source.staged.size;

    // Reserve the write lock before the first read when an enclosing SAVEPOINT is
    // deferred (Rust checks is_autocommit; a no-op UPDATE is safe in both modes).
    conn.run('UPDATE blobs SET ref_count = ref_count WHERE 0');

    const pending = Number(conn.pluck<number>(`SELECT EXISTS(
        SELECT 1 FROM __file_deletion_journal
        WHERE target_kind = 'blob' AND entity_key = ?1 AND state = 'prepared')`, [hash]) ?? 0) !== 0;
    if (pending) {
      throw conflict('blob.deletion_prepared',
        `Blob ${hash} has a prepared deletion; retry after deletion recovery`);
    }

    const existingRelativePath = conn.pluck<string | null>('SELECT relative_path FROM blobs WHERE hash = ?1', [hash]) ?? null;
    // RUST-FIX(RF-W10-blob-path-containment): blob_repo.rs reuses the stored relative_path unchecked.
    const [relativePath, absolutePath] = existingRelativePath === null
      ? buildBlobPath(blobsDir, hash, extension)
      : [existingRelativePath, safeBlobPath(blobsDir, existingRelativePath, BLOB_PATH_REASON)];

    try { localRuntime().mkdirp(dirname(absolutePath)); }
    catch (error) {
      logError('[VFS::BlobRepo] Failed to create blob directory:', error);
      throw ioError('Failed to create blob directory', error);
    }

    let shouldWrite: boolean;
    try { shouldWrite = localRuntime().stat(absolutePath).size !== dataLength; }
    catch { shouldWrite = true; }

    if (source.kind === 'staged') {
      if (shouldWrite) {
        const stagedPath = source.staged.path;
        if (stagedPath === null) throw new VfsRepositoryError('VFS_INTERNAL', 'Internal error: staged blob already consumed');
        try { localRuntime().rename(stagedPath, absolutePath); }
        catch (error) {
          logError('[VFS::BlobRepo] Failed to move staged blob into place:', error);
          throw ioError('Failed to move staged blob into place', error);
        }
        source.staged.path = null;
      }
    } else if (shouldWrite) {
      const tempPath = blobTempPath(absolutePath, nanoid(8));
      const removeTemp = (): void => {
        try { localRuntime().removeForce(tempPath); }
        catch (cleanupError) { logWarn('[VFS::BlobRepo] Failed to remove temp blob file:', cleanupError); }
      };
      // blob_repo.rs:301-322: create / write_all / flush fail as separate branches.
      let handle: LocalWriteHandle;
      try { handle = localRuntime().openWrite(tempPath); }
      catch (error) {
        logError('[VFS::BlobRepo] Failed to create temp blob file:', error);
        removeTemp();
        throw ioError('Failed to create temp blob file', error);
      }
      // Rust drops the File after a write error; only the first failure is reported.
      let failure: { stage: 'write' | 'flush'; error: unknown } | null = null;
      try { handle.write(source.data); }
      catch (error) { failure = { stage: 'write', error }; }
      try { handle.close(); }
      catch (error) { failure ??= { stage: 'flush', error }; }
      if (failure !== null) {
        logError(`[VFS::BlobRepo] Failed to ${failure.stage} temp blob file:`, failure.error);
        removeTemp();
        throw ioError(`Failed to ${failure.stage} temp blob file`, failure.error);
      }
      try { localRuntime().rename(tempPath, absolutePath); }
      catch (error) {
        removeTemp();
        logError('[VFS::BlobRepo] Failed to rename temp blob to final path:', error);
        throw ioError('Failed to rename temp blob to final path', error);
      }
    }

    const now = Date.now();
    const stored = withSavepoint(conn, 'blob_store_metadata', () => {
      const row = conn.get<{ ref_count: number; created_at: number }>(`INSERT INTO blobs
          (hash, relative_path, size, mime_type, ref_count, created_at)
        VALUES (?1, ?2, ?3, ?4, 1, ?5)
        ON CONFLICT(hash) DO UPDATE SET ref_count = ref_count + 1
        RETURNING ref_count, created_at`, [hash, relativePath, dataLength, mimeType, now]);
      conn.run(`UPDATE __file_deletion_journal
          SET state = 'cancelled', cancelled_at = ?2,
              last_error = 'blob recreated before deletion was published'
        WHERE target_kind = 'blob' AND entity_key = ?1 AND state IN ('prepared', 'ready')`,
      [hash, utcNow()]);
      conn.run('DELETE FROM __blob_deletion_queue WHERE hash = ?1', [hash]);
      if (row === undefined) throw new VfsRepositoryError('VFS_STORAGE', 'Database error: INSERT returned no row');
      return row;
    });

    const blob: VfsBlob = {
      hash, relativePath, size: dataLength, refCount: Number(stored.ref_count), createdAt: Number(stored.created_at),
    };
    if (mimeType !== null) blob.mimeType = mimeType;
    return blob;
  }

  getBlob(conn: SqlExecutor, hash: string): VfsBlob | null {
    return databaseResult(() => {
      const row = conn.get('SELECT hash, relative_path, size, mime_type, ref_count, created_at FROM blobs WHERE hash = ?1', [hash]);
      return row === undefined ? null : readBlobRow(row);
    });
  }

  blobExists(conn: SqlExecutor, hash: string): boolean {
    return databaseResult(() => Number(conn.pluck<number>(
      'SELECT COUNT(*) FROM blobs WHERE hash = ?1', [hash]) ?? 0) > 0);
  }

  getBlobPath(conn: SqlExecutor, blobsDir: string, hash: string): string | null {
    return databaseResult(() => {
      const blob = this.getBlob(conn, hash);
      if (blob === null) return null;
      // RUST-FIX(RF-W10-blob-path-containment): blob_repo.rs get_blob_path joins the synced relative_path unchecked.
      const resolved = containedBlobPath(blobsDir, blob.relativePath);
      if (resolved === null) {
        logWarn(`[VFS::BlobRepo] Ignoring blob ${hash}: relative_path is outside vfs_blobs: ${blob.relativePath}`);
      }
      return resolved;
    });
  }

  resolveBlobPath(blobsDir: string, relativePath: string): string | null {
    return containedBlobPath(blobsDir, relativePath);
  }

  incrementRef(conn: SqlExecutor, hash: string): number {
    return databaseResult(() => {
      const row = conn.get<{ ref_count: number }>(
        'UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?1 RETURNING ref_count', [hash]);
      if (row === undefined) throw notFound(hash);
      return Number(row.ref_count);
    });
  }

  decrementRef(conn: SqlExecutor, hash: string): number {
    return databaseResult(() => {
      const row = conn.get<{ ref_count: number }>(
        'UPDATE blobs SET ref_count = MAX(0, ref_count - 1) WHERE hash = ?1 RETURNING ref_count', [hash]);
      if (row === undefined) throw notFound(hash);
      return Number(row.ref_count);
    });
  }

  cleanupBlob(conn: SqlExecutor, blobsDir: string, hash: string): boolean {
    return databaseResult(() => {
      ensureDeletionBoundary(conn);
      this.recoverPreparedBlobDeletionsInternal(conn, blobsDir);
      return this.cleanupBlobAfterRecovery(conn, blobsDir, hash);
    });
  }

  private cleanupBlobAfterRecovery(conn: SqlExecutor, blobsDir: string, hash: string): boolean {
    const blob = this.getBlob(conn, hash);
    if (blob === null || blob.refCount > 0) return false;
    const intent = this.prepareBlobDeletion(conn, blobsDir, blob);
    if (intent === null) return false;
    this.finishBlobDeletion(conn, blobsDir, intent);
    return true;
  }

  recoverPreparedBlobDeletions(conn: SqlExecutor, blobsDir: string): number {
    return databaseResult(() => {
      ensureDeletionBoundary(conn);
      return this.recoverPreparedBlobDeletionsInternal(conn, blobsDir);
    });
  }

  private recoverPreparedBlobDeletionsInternal(conn: SqlExecutor, blobsDir: string): number {
    const rows = conn.all(`SELECT operation_id, entity_key, local_path, expected_hash, size
      FROM __file_deletion_journal
      WHERE target_kind = 'blob' AND state = 'prepared'
      ORDER BY prepared_at, operation_id`);
    let recovered = 0;
    for (const row of rows) {
      this.finishBlobDeletion(conn, blobsDir, {
        operationId: String(row.operation_id),
        hash: String(row.entity_key),
        relativePath: String(row.local_path),
        expectedHash: row.expected_hash === null ? null : String(row.expected_hash),
        size: row.size === null ? null : Number(row.size),
      });
      recovered++;
    }
    return recovered;
  }

  prepareBlobDeletion(conn: SqlExecutor, blobsDir: string, blob: VfsBlob): BlobDeletionIntent | null {
    ensureDeletionBoundary(conn);
    const filePath = safeBlobPath(blobsDir, blob.relativePath);
    let expectedHash: string | null = null;
    let size: number | null;
    if (localRuntime().exists(filePath)) {
      expectedHash = computeFileHash(filePath);
      try { size = localRuntime().stat(filePath).size; }
      catch { size = null; }
    } else {
      size = blob.size;
    }
    const intent: BlobDeletionIntent = {
      operationId: globalThis.crypto.randomUUID(), hash: blob.hash, relativePath: blob.relativePath, expectedHash, size,
    };
    const preparedAt = utcNow();
    return withSavepoint(conn, 'blob_deletion_prepare', () => {
      conn.run(`INSERT INTO __file_deletion_journal (
          operation_id, target_kind, entity_key, local_path,
          expected_hash, size, state, prepared_at
        ) VALUES (?1, 'blob', ?2, ?3, ?4, ?5, 'prepared', ?6)`, [
        intent.operationId, intent.hash, intent.relativePath, intent.expectedHash, intent.size, preparedAt,
      ]);
      const deleted = conn.run('DELETE FROM blobs WHERE hash = ?1 AND ref_count = 0', [intent.hash]).changes;
      return deleted === 1 ? intent : null;
    });
  }

  private finishBlobDeletion(conn: SqlExecutor, blobsDir: string, intent: BlobDeletionIntent): void {
    ensureDeletionBoundary(conn);
    const filePath = safeBlobPath(blobsDir, intent.relativePath);
    const quarantine = quarantinePath(filePath, intent.operationId);
    let conflictInfo: [string, string] | null = null;
    if (localRuntime().exists(quarantine)) {
      conflictInfo = this.blobBaselineConflict(intent, quarantine);
      if (conflictInfo === null) {
        try { localRuntime().remove(quarantine); }
        catch (error) { throw ioError(`Failed to delete claimed blob ${intent.hash}`, error); }
      }
    } else if (localRuntime().exists(filePath)) {
      conflictInfo = this.blobBaselineConflict(intent, filePath);
      if (conflictInfo === null) {
        try { localRuntime().rename(filePath, quarantine); }
        catch (error) { throw ioError(`Failed to claim blob ${intent.hash} for deletion`, error); }
        try { localRuntime().remove(quarantine); }
        catch (error) { throw ioError(`Failed to delete claimed blob ${intent.hash}`, error); }
      }
    }
    if (conflictInfo !== null) {
      this.cancelBlobBaselineConflict(conn, intent, conflictInfo[0], conflictInfo[1]);
    }
    this.markBlobDeletionReady(conn, intent);
  }

  private blobBaselineConflict(intent: BlobDeletionIntent, path: string): [string, string] | null {
    const actual = computeFileHash(path);
    if (intent.expectedHash !== null && intent.expectedHash === actual) return null;
    return [intent.expectedHash ?? '<missing baseline>', actual];
  }

  private cancelBlobBaselineConflict(conn: SqlExecutor, intent: BlobDeletionIntent, expected: string, actual: string): never {
    const message = `blob content changed after prepare: expected=${expected}, actual=${actual}`;
    conn.run(`UPDATE __file_deletion_journal
        SET state = 'cancelled', cancelled_at = ?2, last_error = ?3
      WHERE operation_id = ?1 AND state = 'prepared'`, [intent.operationId, utcNow(), message]);
    throw conflict('blob.deletion_content_changed',
      `Blob deletion ${intent.operationId} cancelled because ${intent.relativePath} changed (expected ${expected}, actual ${actual})`);
  }

  private markBlobDeletionReady(conn: SqlExecutor, intent: BlobDeletionIntent): void {
    const readyAt = utcNow();
    withSavepoint(conn, 'blob_deletion_ready', () => {
      conn.run(`INSERT INTO __blob_deletion_queue (hash, relative_path, size, deleted_at, retry_count)
        VALUES (?1, ?2, ?3, ?4, 0)
        ON CONFLICT(hash) DO UPDATE SET
          relative_path = excluded.relative_path, size = excluded.size,
          deleted_at = excluded.deleted_at, retry_count = 0`,
      [intent.hash, intent.relativePath, intent.size, readyAt]);
      const updated = conn.run(`UPDATE __file_deletion_journal
          SET state = 'ready', ready_at = ?2, last_error = NULL
        WHERE operation_id = ?1 AND state IN ('prepared', 'ready')`, [intent.operationId, readyAt]).changes;
      if (updated !== 1) {
        throw invalidState(`blob deletion operation ${intent.operationId} cannot advance to ready`);
      }
    });
  }

  removeUnregisteredBlobFile(conn: SqlExecutor, blobsDir: string, hash: string): boolean {
    return databaseResult(() => {
      if (hash.length < 2) return false;
      if (this.blobExists(conn, hash)) return false;
      const prefixDir = join(blobsDir, hash.slice(0, 2));
      let entries: string[];
      try { entries = localRuntime().readdir(prefixDir); }
      catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw ioError(`Failed to enumerate orphan blob directory ${prefixDir}`, error);
      }
      let removed = false;
      for (const name of entries) {
        if (!name.startsWith(hash) || name.endsWith('.tmp')) continue;
        if (this.blobExists(conn, hash)) return removed;
        try { localRuntime().remove(join(prefixDir, name)); }
        catch (error) { throw ioError(`Failed to remove unregistered orphan blob file ${name}`, error); }
        removed = true;
      }
      return removed;
    });
  }

  cleanupUnreferenced(conn: SqlExecutor, blobsDir: string): number {
    return databaseResult(() => {
      ensureDeletionBoundary(conn);
      this.recoverPreparedBlobDeletionsInternal(conn, blobsDir);
      const hashes = conn.all<{ hash: string }>('SELECT hash FROM blobs WHERE ref_count = 0').map(row => row.hash);
      let cleaned = 0;
      for (const hash of hashes) {
        if (this.cleanupBlobAfterRecovery(conn, blobsDir, hash)) cleaned++;
      }
      this.sweepStaleTempFiles(blobsDir);
      logInfo(`[VFS::BlobRepo] Cleaned up ${cleaned} unreferenced blobs`);
      return cleaned;
    });
  }

  private sweepStaleTempFiles(blobsDir: string): void {
    const staleAge = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let removed = 0;
    let prefixEntries: string[];
    try { prefixEntries = localRuntime().readdir(blobsDir); }
    catch { return; }
    for (const prefix of prefixEntries) {
      const prefixPath = join(blobsDir, prefix);
      try { if (localRuntime().stat(prefixPath).kind !== 'directory') continue; }
      catch { continue; }
      let files: string[];
      try { files = localRuntime().readdir(prefixPath); }
      catch { continue; }
      for (const file of files) {
        if (!file.endsWith('.tmp')) continue;
        const path = join(prefixPath, file);
        try {
          const age = now - localRuntime().stat(path).mtimeMs;
          if (age > staleAge) { localRuntime().removeForce(path); removed += 1; }
        } catch (error) { logWarn('[VFS::BlobRepo] Failed to sweep stale temp file:', error); }
      }
    }
    if (removed > 0) logInfo(`[VFS::BlobRepo] Removed ${removed} stale temp files from blobs dir`);
  }
}
