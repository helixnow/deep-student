// APKG import boundary published through `../api.ts`: the L11 VFS read surface,
// the L16 importer service and the `AppError`-shaped resolution failure.

export type ChatAnkiApkgErrorType =
  | 'NotFound' | 'Validation' | 'Database' | 'FileSystem' | 'Unknown';

/** `AppError` shape used by APKG resolution; `errorCode` mirrors `details.errorCode`. */
export class ChatAnkiApkgError extends Error {
  readonly type: ChatAnkiApkgErrorType;
  readonly errorCode: string;

  constructor(
    type: ChatAnkiApkgErrorType,
    errorCode: string,
    message: string,
  ) {
    super(message);
    this.type = type;
    this.errorCode = errorCode;
    this.name = 'ChatAnkiApkgError';
  }
}

/** L11 VFS file row fields needed to resolve APKG bytes. */
export interface ChatAnkiVfsFile {
  id: string;
  resourceId: string | null;
  fileName: string;
  size: number;
  sha256: string;
  blobHash: string | null;
  originalPath: string | null;
}

export interface ChatAnkiResolvedApkgFile {
  /** Resolved `file_*` / `att_*` attachment id. */
  resourceId: string;
  file: ChatAnkiVfsFile;
}

/** L11 VFS read surface; VFS owns blob/original-path lookup and URI policy. */
export interface ChatAnkiApkgVfs {
  resolveApkgFile(rawResourceId: string): ChatAnkiResolvedApkgFile | null;
  readBlob(hash: string): Uint8Array | null;
  statFile(path: string): { size: number } | null;
  isFile(path: string): boolean;
  isVirtualUri(path: string): boolean;
  readFile(path: string): Uint8Array;
}

export interface ChatAnkiApkgMediaSkip {
  reason: string;
  count: number;
  filenames: string[];
}

export interface ChatAnkiApkgMediaReport {
  declared: number;
  imported: number;
  skipped: number;
  skips: ChatAnkiApkgMediaSkip[];
  mediaDir: string | null;
}

export interface ChatAnkiApkgReviewEnqueueReport {
  enqueued: number;
  withHistory: number;
  suspended: number;
}

/** L16 `ApkgImportResult` (camelCase wire; empty warnings/report omitted). */
export interface ChatAnkiApkgImportResult {
  documentId: string;
  importedCards: number;
  importedTemplates: number;
  mediaSkipped: number;
  mediaImported: number;
  mediaReport: ChatAnkiApkgMediaReport;
  warnings: string[];
  cardIds: string[];
  reviewEnqueue: ChatAnkiApkgReviewEnqueueReport | null;
}

/**
 * L16 `ApkgImporterService`. Media extraction and the `anki_media/` directory
 * remain owned by L16; this lane only supplies bounded bytes or an absolute path.
 */
export interface ChatAnkiApkgImporter {
  importBytes(
    bytes: Uint8Array, sourceName: string | null, sessionId: string | null,
  ): ChatAnkiApkgImportResult;
  importPath(path: string, sessionId: string | null): ChatAnkiApkgImportResult;
}
