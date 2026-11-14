/**
 * Single-writer hand-off for tables owned by L11.
 *
 * Production and standalone service callers bind the real `vfsRepo` service
 * for their database handle. State/profile writes require that owner; the
 * indexing transaction helper carries the binding onto the transaction handle.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';

const OWNERS = new WeakMap<object, VfsReposService>();

/** L11's published generation-preserving write contract (R12-09). */
export type IndexUnitProfileWrites = Pick<VfsReposService['embeddingUnits'], 'setIndexProfile'>;

/**
 * Exact L11 write surface (`ds-mig/L11-vfs-repos` `types/files.ts`,
 * `types/content.ts`). Main `7b7136676` merged the PDF/media setters; L11
 * WP-001 (`a8af0619c`) merged the exact conditional / timestamp-less OCR and
 * stuck-index recovery methods. These members are read structurally; a missing
 * method is reported as an error and L12 keeps no second SQL writer.
 */
export interface PdfFileOwnerWrites {
  updatePdfExtractedText(conn: SqlExecutor, fileId: string, extractedText: string,
    pageCount: number | null): void;
  updatePdfPreview(conn: SqlExecutor, fileId: string, previewJson: string,
    pageCount: number): void;
  updatePdfPreviewOnly(conn: SqlExecutor, fileId: string, previewJson: string): void;
  updatePdfOcrPages(conn: SqlExecutor, fileId: string, ocrPagesJson: string): void;
  updateCompressedBlobHash(conn: SqlExecutor, fileId: string, blobHash: string): void;
  cancelProcessing(conn: SqlExecutor, fileId: string): number;
  markProcessingRecovered(conn: SqlExecutor, fileId: string): number;
  setProcessingError(conn: SqlExecutor, fileId: string, error: string,
    completedAt: number): void;
  updateProcessingProgress(conn: SqlExecutor, fileId: string, progressJson: string): void;
  applyProcessingStatus(conn: SqlExecutor, fileId: string, stage: string,
    progressJson: string | null, completedAt: number | null, now: number,
    issueSummary: string | null): void;
  applyMultimodalIndexState(conn: SqlExecutor, fileId: string, state: string,
    indexedPagesJsonOrError: string | null): void;
}

export interface PdfResourceOwnerWrites {
  saveOcrTextForFile(conn: SqlExecutor, fileId: string, ocrText: string): number;
  /**
   * Exact `indexing.rs:1082/3485` cache write:
   * `UPDATE resources SET ocr_text = ?1 WHERE id = ?2 AND (ocr_text IS NULL OR ocr_text = '')`.
   * It must not update `updated_at`. Published by L11 `resources.ts`; when absent
   * L12 reports the missing method instead of issuing a second SQL write.
   */
  saveOcrTextIfEmptyWithConn?(conn: SqlExecutor, resourceId: string, ocrText: string): void;
  /**
   * Exact `indexing.rs:3354/3949` image-OCR cache write:
   * `UPDATE resources SET ocr_text = ?1 WHERE id = ?2` (no `updated_at`).
   * Published by L11 `resources.ts`; when absent L12 reports the missing method
   * instead of using `saveOcrText`, which would add a timestamp.
   */
  saveOcrTextWithoutTimestampWithConn?(
    conn: SqlExecutor, resourceId: string, ocrText: string,
  ): void;
}

export interface PdfExamOwnerWrites {
  applyMultimodalIndexState(conn: SqlExecutor, examId: string, state: string,
    indexedPagesJsonOrError: string | null, embeddingDim: number): void;
}

/**
 * L11-owned startup recovery for `vfs_index_units` + `resources`
 * (`indexing.rs:1978-2046`). C2 dispatched the reset-table owner to L11; L12 only
 * schedules the call and must not keep a second reset SQL writer.
 */
export interface VfsRecoveryOwnerWrites {
  recoverStuckIndexingWithConn?(conn: SqlExecutor, at: number): number;
}

export function pdfFileOwnerWrites(db: SqlExecutor): Partial<PdfFileOwnerWrites> | undefined {
  const files = vfsTableOwners(db)?.files as unknown;
  return files !== null && typeof files === 'object'
    ? files as Partial<PdfFileOwnerWrites>
    : undefined;
}

export function pdfExamOwnerWrites(db: SqlExecutor): Partial<PdfExamOwnerWrites> | undefined {
  const exams = vfsTableOwners(db)?.exams as unknown;
  return exams !== null && typeof exams === 'object'
    ? exams as Partial<PdfExamOwnerWrites>
    : undefined;
}

export function pdfResourceOwnerWrites(
  repositories: VfsReposService,
): Partial<PdfResourceOwnerWrites> {
  return repositories.resources as unknown as Partial<PdfResourceOwnerWrites>;
}

/** L11 `maintenance` recovery surface (`vfs-repos/repository/maintenance.ts`). */
export function vfsRecoveryOwnerWrites(db: SqlExecutor): Partial<VfsRecoveryOwnerWrites> | undefined {
  const maintenance = vfsTableOwners(db)?.maintenance as unknown;
  return maintenance !== null && typeof maintenance === 'object'
    ? maintenance as Partial<VfsRecoveryOwnerWrites>
    : undefined;
}

/** Fail explicitly while main has not merged the L11 branch write surface. */
function missingOwner(path: string): never {
  throw new Error(`L11 vfsRepo.${path} 未集成（待 ds-mig/L11-vfs-repos 合入）`);
}

export function requirePdfFileOwnerMethod<K extends keyof PdfFileOwnerWrites>(
  owner: Partial<PdfFileOwnerWrites> | undefined,
  method: K,
): PdfFileOwnerWrites[K] {
  const fn = owner?.[method];
  if (owner === undefined || typeof fn !== 'function') missingOwner(`files.${method}`);
  return fn.bind(owner) as PdfFileOwnerWrites[K];
}

export function requirePdfExamOwnerMethod<K extends keyof PdfExamOwnerWrites>(
  owner: Partial<PdfExamOwnerWrites> | undefined,
  method: K,
): PdfExamOwnerWrites[K] {
  const fn = owner?.[method];
  if (owner === undefined || typeof fn !== 'function') missingOwner(`exams.${method}`);
  return fn.bind(owner) as PdfExamOwnerWrites[K];
}

export function pdfFileOwnerFromRepositories(
  repositories: VfsReposService,
): Partial<PdfFileOwnerWrites> {
  return repositories.files as unknown as Partial<PdfFileOwnerWrites>;
}

export function pdfExamOwnerFromRepositories(
  repositories: VfsReposService,
): Partial<PdfExamOwnerWrites> {
  return repositories.exams as unknown as Partial<PdfExamOwnerWrites>;
}

export function bindVfsTableOwners(db: SqlExecutor, repositories: VfsReposService): void {
  OWNERS.set(db as object, repositories);
}

export function unbindVfsTableOwners(db: SqlExecutor): void {
  OWNERS.delete(db as object);
}

export function vfsTableOwners(db: SqlExecutor): VfsReposService | undefined {
  return OWNERS.get(db as object);
}

export function requireVfsTableOwners(db: SqlExecutor): VfsReposService {
  const owner = vfsTableOwners(db);
  if (owner === undefined) throw new Error('L11 vfsRepo service is not available');
  return owner;
}
