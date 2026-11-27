/**
 * In-place binary file content update (`vfs_update_file_content`).
 *
 * Updates the VFS blob + `files` / `resources` metadata in-place (preserving `file.id`,
 * folder membership, bookmarks, and references), re-syncs text extraction & RAG units,
 * and—when `syncOriginalPath !== false` and `file.originalPath` points to a valid local
 * path—atomically overwrites the external source file via `local-runtime`.
 */
import type { Context } from '@deepseek-ai/cordis';
import { CommandError } from '../../../kernel/api.ts';
import { createWebCrypto } from '../../../platform/crypto/web.ts';
import { toHex } from '../../../platform/crypto/encoding.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';
import type { VfsFile, VfsReposService } from '../../vfs-repos/api.ts';
import type { UnitBuilderService } from '../../vfs-index/api.ts';
import { updatedEvent } from './dstu-types.ts';
import { VfsError } from './error.ts';
import { fs, LocalRuntimeUnavailableError } from './local-runtime.ts';
import { emitDstuWatchEvent, type LocationDeps } from './locations.ts';
import { nanoid } from './nanoid.ts';
import { fileToDstuNode } from './node-converters.ts';
import { decodeStandardBase64 } from './upload-attachment.ts';
import {
  extensionForMime,
  message,
  ownerAttachmentProcessing,
  type PlainTextCodeExtensions,
} from './upload-file.ts';
import type { UploadSaga } from './upload-saga.ts';

export interface VfsUpdateFileContentParams {
  fileId: string;
  base64Content: string;
  syncOriginalPath?: boolean | null;
}

export interface VfsUpdateFileContentResult {
  file: VfsFile;
  sha256: string;
  originalPathSynced: boolean;
  originalPathError?: string;
}

export interface UpdateFileContentDeps {
  conn(): SqlExecutor;
  blobsDir(): string;
  repos: VfsReposService;
  unitBuilder(): UnitBuilderService | undefined;
  docs(): PlainTextCodeExtensions | undefined;
  createSaga(): UploadSaga;
  withSavepoint<T>(conn: SqlExecutor, name: string, work: () => T): T;
  locationDeps: LocationDeps;
  log: Context['logger'];
}

const MIB = 1024 * 1024;
const PARSEABLE_EXTENSIONS = new Set([
  'docx', 'xlsx', 'xls', 'xlsb', 'ods', 'pptx', 'epub', 'rtf',
  'txt', 'md', 'markdown', 'html', 'htm', 'csv', 'json', 'xml', 'vtt',
]);
const VIRTUAL_SCHEMES = ['content://', 'asset://', 'ph://', 'image://', 'camera://', 'tauri://'];
const SAF_PREFIXES = ['primary:', 'secondary:', 'raw:'];

function extensionOf(name: string): string | null {
  const base = name.split('/').pop() ?? name;
  const index = base.lastIndexOf('.');
  if (index <= 0) return null;
  return base.slice(index + 1).toLowerCase();
}

function inferMimeFromName(fileName: string): string {
  switch (extensionOf(fileName)) {
    case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'pdf': return 'application/pdf';
    case 'epub': return 'application/epub+zip';
    case 'csv': return 'text/csv';
    case 'md':
    case 'markdown': return 'text/markdown';
    case 'txt': return 'text/plain';
    case 'json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

function normalizeWritableLocalPath(rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (trimmed === '') return null;
  const lower = trimmed.toLowerCase();
  if (VIRTUAL_SCHEMES.some((scheme) => lower.startsWith(scheme))) return null;
  if (SAF_PREFIXES.some((prefix) => lower.startsWith(prefix))) return null;
  let candidate = trimmed;
  if (lower.startsWith('file://')) {
    try {
      candidate = decodeURIComponent(trimmed.slice('file://'.length));
    } catch {
      candidate = trimmed.slice('file://'.length);
    }
  } else if (trimmed.includes('://')) {
    return null;
  }
  const segments = candidate.split(/[\\/]+/).filter((seg) => seg !== '' && seg !== '.');
  if (segments.some((seg) => seg === '..' || seg.startsWith('.'))) {
    return null;
  }
  return candidate;
}

function syncOriginalFileAtomically(
  rawOriginalPath: string,
  bytes: Uint8Array,
  log: Context['logger'],
): { synced: boolean; error?: string } {
  const localPath = normalizeWritableLocalPath(rawOriginalPath);
  if (localPath === null) {
    return { synced: false, error: 'Original path is virtual or hidden and cannot be overwritten' };
  }
  const tempPath = `${localPath}.${nanoid(8)}.dstu-tmp`;
  try {
    if (fs.existsSync(localPath)) {
      const stat = fs.lstatSync(localPath);
      if (stat.isDirectory() || stat.isSymbolicLink()) {
        return { synced: false, error: 'Original path is a directory or symlink' };
      }
    }
    fs.writeFileSync(tempPath, bytes);
    fs.renameSyncWithRetry(tempPath, localPath);
    return { synced: true };
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (cleanupError) {
      log.warn('[VFS::handlers] Failed to clean temp original file %s: %s', tempPath, message(cleanupError));
    }
    if (error instanceof LocalRuntimeUnavailableError) {
      return { synced: false };
    }
    return { synced: false, error: message(error) };
  }
}

export async function updateFileContentCommand(
  deps: UpdateFileContentDeps,
  params: VfsUpdateFileContentParams,
): Promise<VfsUpdateFileContentResult> {
  try {
    return await updateFileContent(deps, params);
  } catch (error) {
    throw error instanceof CommandError ? error : new CommandError(message(error));
  }
}

async function updateFileContent(
  deps: UpdateFileContentDeps,
  params: VfsUpdateFileContentParams,
): Promise<VfsUpdateFileContentResult> {
  const { log, repos } = deps;
  const fileId = params.fileId.trim();
  if (fileId === '') {
    throw new Error(new VfsError('InvalidArgument', { param: 'file_id', reason: 'fileId must not be empty' }).message);
  }

  let content: Uint8Array;
  try {
    content = decodeStandardBase64(params.base64Content);
  } catch (error) {
    throw new Error(message(error));
  }

  let conn = deps.conn();
  const current = repos.files.getFile(conn, fileId);
  if (current === null || current.deletedAt !== undefined || current.status !== 'active') {
    throw new Error(new VfsError('NotFound', { resource_type: 'File', id: fileId }).message);
  }

  const mimeType = current.mimeType && current.mimeType !== 'application/octet-stream'
    ? current.mimeType
    : inferMimeFromName(current.fileName);
  const maxSize = repos.attachments.maxUploadSizeBytes(mimeType);
  if (content.length > maxSize) {
    const mb2 = (content.length / MIB).toFixed(2);
    throw new Error(new VfsError('InvalidArgument', {
      param: 'base64_content',
      reason: `File too large: max ${Math.floor(maxSize / MIB)}MB, got ${mb2}MB`,
    }).message);
  }

  const sha256 = toHex(await createWebCrypto().digest('SHA-256', content));
  const blobsDir = deps.blobsDir();
  const blobExtension = extensionForMime(current.fileName, mimeType);

  let extractedText: string | null = null;
  let pageCount: number | null = current.pageCount ?? null;
  let pagedTextPages: string[] | null = null;
  const ext = extensionOf(current.fileName);
  const docsService = deps.docs();
  const isParseable = ext !== null && (
    PARSEABLE_EXTENSIONS.has(ext)
    || (docsService?.isPlainTextCodeExtension(ext) ?? false)
  );
  if (isParseable) {
    try {
      const processing = ownerAttachmentProcessing(repos);
      let pages: string[] | null = null;
      try {
        pages = await processing.extractPagedText(current.fileName, content);
      } catch (pagedErr) {
        log.debug('[VFS::handlers] Paged text extraction skipped for %s: %s', current.fileName, message(pagedErr));
        pages = null;
      }
      if (pages !== null && pages.length > 0) {
        const joined = pages.join('\n\n').trim();
        pageCount = pages.length;
        pagedTextPages = pages;
        extractedText = joined;
      } else {
        const text = await processing.extractText(current.fileName, content);
        if (text !== null && text.trim() !== '') {
          extractedText = text;
        }
      }
    } catch (error) {
      log.warn('[VFS::handlers] vfs_update_file_content text extraction degraded for %s: %s',
        current.fileName, message(error));
    }
  }

  const ocrPagesJson = pagedTextPages === null ? null : JSON.stringify(pagedTextPages);
  const saga = deps.createSaga();
  conn = deps.conn();

  let updatedFile: VfsFile;
  let previousBlobHash: string | null = null;
  let newBlobHash: string;
  try {
    const persistedPath = await repos.blobs.persistBlob(conn, blobsDir, content, blobExtension);
    const outcome = deps.withSavepoint(conn, 'vfs_update_file_content_saga', () => {
      const storedBlob = repos.blobs.storeBlob(conn, blobsDir, content, mimeType, blobExtension, persistedPath);
      const replaced = repos.files.replaceFileContentWithConn(conn, fileId, {
        sha256,
        size: content.length,
        blobHash: storedBlob.hash,
        extractedText,
        pageCount,
        ocrPagesJson,
      });
      return {
        blobHash: storedBlob.hash,
        file: replaced.file,
        previousBlobHash: replaced.previousBlobHash,
      };
    });
    newBlobHash = outcome.blobHash;
    updatedFile = outcome.file;
    previousBlobHash = outcome.previousBlobHash;
    saga.commit();
  } catch (error) {
    saga.abort(conn, blobsDir);
    try {
      repos.blobs.removeUnregisteredBlobFile(conn, blobsDir, sha256);
    } catch (cleanupError) {
      log.error('[VFS::handlers] Failed to clean orphan blob %s: %s', sha256, message(cleanupError));
    }
    throw new Error(message(error));
  }

  if (previousBlobHash !== null && previousBlobHash !== newBlobHash) {
    try {
      repos.blobs.cleanupBlob(deps.conn(), blobsDir, previousBlobHash);
    } catch (error) {
      log.warn('[VFS::handlers] Cleanup of previous blob %s deferred: %s', previousBlobHash, message(error));
    }
  }

  const unitBuilder = deps.unitBuilder();
  if (updatedFile.resourceId !== undefined && unitBuilder !== undefined) {
    try {
      const units = unitBuilder.syncResourceUnits({
        resourceId: updatedFile.resourceId,
        resourceType: 'file',
        data: null,
        ocrText: null,
        ocrPagesJson,
        blobHash: updatedFile.blobHash ?? null,
        pageCount: updatedFile.pageCount ?? null,
        extractedText: updatedFile.extractedText ?? null,
        previewJson: updatedFile.previewJson ?? null,
      });
      log.info('[VFS::handlers] Re-synced %d units for updated file %s (text_len=%d)',
        units.length, updatedFile.id, utf8ByteLength(extractedText ?? ''));
    } catch (error) {
      const indexErr = message(error);
      log.warn('[VFS::handlers] Failed to re-sync units for %s: %s', updatedFile.id, indexErr);
      try {
        repos.indexStates.markFailed(deps.conn(), updatedFile.resourceId, indexErr);
      } catch (markError) {
        log.error('[VFS::handlers] Failed to mark index retry state for %s: %s',
          updatedFile.resourceId, message(markError));
      }
    }
  }

  let originalPathSynced = false;
  let originalPathError: string | undefined;
  if (params.syncOriginalPath !== false && updatedFile.originalPath) {
    const syncOutcome = syncOriginalFileAtomically(updatedFile.originalPath, content, log);
    originalPathSynced = syncOutcome.synced;
    if (syncOutcome.error !== undefined) {
      originalPathError = syncOutcome.error;
      log.warn('[VFS::handlers] Original path overwrite skipped/failed for %s (%s): %s',
        updatedFile.id, updatedFile.originalPath, syncOutcome.error);
    }
  }

  try {
    emitDstuWatchEvent(deps.locationDeps, updatedEvent(`/${updatedFile.id}`, fileToDstuNode(updatedFile)));
  } catch (error) {
    log.warn('[VFS::handlers] Failed to emit dstu:change for %s: %s', updatedFile.id, message(error));
  }

  return {
    file: updatedFile,
    sha256,
    originalPathSynced,
    ...(originalPathError === undefined ? {} : { originalPathError }),
  };
}
