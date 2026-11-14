// Rust: chatanki_executor.rs:10162–10390 (APKG resource ownership + byte resolution)
// and 20700–20760 (import result projection). VFS/L16 own file rows and blob storage;
// this module owns the bounded read order and the AppError shaped failures.
import { sha256HexSync } from '../../../platform/crypto/sync.ts';
import type { ChatAnkiSessionResourceLookup } from '../api.ts';
import {
  ChatAnkiApkgError, type ChatAnkiApkgImportResult, type ChatAnkiApkgVfs, type ChatAnkiVfsFile,
} from './apkg-port.ts';
import { errorText } from './execution.ts';
import { rustTrim } from '../../../platform/util/text.ts';

export const MAX_APKG_ARCHIVE_BYTES = 256 * 1024 * 1024;

export interface ResolvedApkgResource {
  bytes: Uint8Array;
  sourceName: string;
}

function apkgError(
  type: ChatAnkiApkgError['type'], errorCode: string, message: string,
): ChatAnkiApkgError {
  return new ChatAnkiApkgError(type, errorCode, message);
}

/** chatanki_executor.rs:10178–10207. */
export function verifyApkgResourceInSessionContext(
  lookup: ChatAnkiSessionResourceLookup,
  sessionId: string,
  resourceId: string,
): void {
  let refs;
  try {
    refs = lookup.resolveSessionUserRefs(sessionId, [resourceId]);
  } catch (caught) {
    throw apkgError(
      'NotFound', 'apkg_not_found',
      `APKG resource is not available in the current chat session: ${errorText(caught)}`,
    );
  }
  if (refs !== null && refs.some((ref) => ref.resourceId === resourceId)) return;
  throw apkgError(
    'NotFound', 'apkg_not_found',
    `APKG resource is not available in the current chat session: ${resourceId}`,
  );
}

function boundedBytes(bytes: Uint8Array, sourceId: string): Uint8Array {
  if (bytes.length > MAX_APKG_ARCHIVE_BYTES) {
    throw apkgError(
      'Validation', 'apkg_limit_exceeded',
      `APKG resource '${sourceId}' exceeds the import size limit`,
    );
  }
  return bytes;
}

function verifyApkgOriginalPathSha256(file: ChatAnkiVfsFile, bytes: Uint8Array): void {
  const expected = rustTrim(file.sha256);
  if (expected.length !== 64 || !/^[0-9A-Fa-f]{64}$/u.test(expected)) return;
  const actual = sha256HexSync(bytes);
  if (actual.toLowerCase() === expected.toLowerCase()) return;
  throw apkgError(
    'Validation', 'apkg_resource_mismatch',
    `APKG resource '${file.id}' no longer matches its recorded SHA-256`,
  );
}

function hasParentTraversal(path: string): boolean {
  return path.split(/[/\\]/u).some((component) => component === '..');
}

/** chatanki_executor.rs:10262–10347: blob first, then verified original path. */
export function loadApkgVfsFileBytes(
  vfs: ChatAnkiApkgVfs, file: ChatAnkiVfsFile,
): Uint8Array {
  if (file.blobHash !== null) {
    const blob = vfs.readBlob(file.blobHash);
    if (blob !== null) return boundedBytes(blob, file.id);
  }
  if (rustTrim(file.sha256).length > 0) {
    const blob = vfs.readBlob(file.sha256);
    if (blob !== null) return boundedBytes(blob, file.id);
  }
  if (file.size > MAX_APKG_ARCHIVE_BYTES) {
    throw apkgError(
      'Validation', 'apkg_limit_exceeded',
      `APKG resource '${file.id}' exceeds the import size limit`,
    );
  }
  const originalPath = file.originalPath;
  if (originalPath !== null && !vfs.isVirtualUri(originalPath)
    && !hasParentTraversal(originalPath) && vfs.isFile(originalPath)) {
    const stat = vfs.statFile(originalPath);
    if (stat !== null && stat.size > MAX_APKG_ARCHIVE_BYTES) {
      throw apkgError(
        'Validation', 'apkg_limit_exceeded',
        `APKG resource '${file.id}' exceeds the import size limit`,
      );
    }
    const bytes = boundedBytes(vfs.readFile(originalPath), file.id);
    verifyApkgOriginalPathSha256(file, bytes);
    return bytes;
  }
  throw apkgError(
    'NotFound', 'apkg_not_found',
    `APKG resource '${file.id}' has no readable original_path or VFS blob`,
  );
}

/** chatanki_executor.rs:10209–10260. */
export function resolveApkgResourceBytes(
  vfs: ChatAnkiApkgVfs, rawResourceId: string,
): ResolvedApkgResource {
  const trimmed = rustTrim(rawResourceId);
  const resolved = vfs.resolveApkgFile(trimmed);
  if (resolved === null) {
    throw apkgError('NotFound', 'apkg_not_found', `APKG resource not found: ${trimmed}`);
  }
  const sourceId = rustTrim(resolved.resourceId);
  if (!sourceId.startsWith('file_') && !sourceId.startsWith('att_')) {
    throw apkgError(
      'Validation', 'apkg_invalid_input',
      `Resource '${trimmed}' does not resolve to a file_/att_ attachment`,
    );
  }
  const sourceName = rustTrim(resolved.file.fileName).length === 0
    ? sourceId
    : resolved.file.fileName;
  return { bytes: loadApkgVfsFileBytes(vfs, resolved.file), sourceName };
}

/** L16 `ApkgImportResult` serde projection: empty optional sections are omitted. */
export function apkgImportResultForTool(
  result: ChatAnkiApkgImportResult,
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    documentId: result.documentId,
    importedCards: result.importedCards,
    importedTemplates: result.importedTemplates,
    mediaSkipped: result.mediaSkipped,
    mediaImported: result.mediaImported,
  };
  const report = result.mediaReport;
  const reportEmpty = report.declared === 0 && report.imported === 0
    && report.skipped === 0 && report.skips.length === 0;
  if (!reportEmpty) {
    const skips = report.skips.map((skip) => ({
      reason: skip.reason,
      count: skip.count,
      ...(skip.filenames.length === 0 ? {} : { filenames: [...skip.filenames] }),
    }));
    output.mediaReport = {
      declared: report.declared,
      imported: report.imported,
      skipped: report.skipped,
      ...(skips.length === 0 ? {} : { skips }),
      ...(report.mediaDir === null ? {} : { mediaDir: report.mediaDir }),
    };
  }
  if (result.warnings.length > 0) output.warnings = [...result.warnings];
  if (result.reviewEnqueue !== null) {
    output.reviewEnqueue = {
      enqueued: result.reviewEnqueue.enqueued,
      withHistory: result.reviewEnqueue.withHistory,
      suspended: result.reviewEnqueue.suspended,
    };
  }
  return output;
}
