/**
 * `paperLibrary` service: the VFS owner side of memory's `paper_save`
 * (`chat_v2/tools/paper_save_executor.rs:582-740`, which works on `ctx.vfs_db`).
 *
 * Unlike `vfs_download_paper` there is no upload saga or savepoint: Rust writes
 * the blob, renders the preview and inserts the file row as separate autocommit
 * steps on one `get_conn_safe()` connection, and the executor maps each failure.
 */
import type { PaperFileInput, PaperFileRecord, PaperLibraryPort, PaperPreview, PaperUnitInput } from '../../memory/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { UnitBuilderService } from '../../vfs-index/api.ts';
import { DEFAULT_PDF_PREVIEW_CONFIG, type PdfPreviewJson, type VfsReposService } from '../../vfs-repos/api.ts';
import { ownerAttachmentProcessing } from './upload-file.ts';

export interface PaperLibraryDeps {
  conn(): SqlExecutor;
  blobsDir(): string;
  repos: VfsReposService;
  /** Resolved per call like the upload commands (vfsUnitBuilder is optional on a host). */
  unitBuilder(): UnitBuilderService;
  /** `ctx.pdf_processing_service`; `null` ⇔ the Rust `None` branch (no pipeline). */
  pdf(): { startPipeline(fileId: string, stage: 'ocr_processing'): Promise<unknown> } | null;
}

export function createPaperLibrary(deps: PaperLibraryDeps): PaperLibraryPort {
  const library: PaperLibraryPort = {
    getFileBySha256(sha256) {
      const file = deps.repos.files.getBySha256(deps.conn(), sha256);
      return file === null ? null : { id: file.id, status: file.status };
    },
    storeBlob(bytes) {
      return deps.repos.blobs.storeBlob(deps.conn(), deps.blobsDir(), bytes, 'application/pdf', 'pdf').hash;
    },
    async renderPreview(bytes): Promise<PaperPreview> {
      const processing = ownerAttachmentProcessing(deps.repos);
      const result = await processing.renderPdf(deps.conn(), deps.blobsDir(), bytes, DEFAULT_PDF_PREVIEW_CONFIG);
      return {
        // `.and_then(|p| serde_json::to_string(p).ok())`
        previewJson: result.previewJson === null ? null : JSON.stringify(result.previewJson satisfies PdfPreviewJson),
        extractedText: result.extractedText,
        pageCount: result.pageCount,
      };
    },
    createFile(input: PaperFileInput): PaperFileRecord {
      const file = deps.repos.files.createFileWithDocDataInFolder(deps.conn(), input.sha256, input.fileName,
        input.sizeBytes, 'pdf', 'application/pdf', input.blobHash, null, input.folderId, input.previewJson,
        input.extractedText, input.pageCount);
      return {
        id: file.id, resourceId: file.resourceId ?? null, pageCount: file.pageCount ?? null,
        extractedText: file.extractedText ?? null, previewJson: file.previewJson ?? null,
      };
    },
    syncResourceUnits(input: PaperUnitInput): number {
      return deps.unitBuilder().syncResourceUnits({
        resourceId: input.resourceId, resourceType: 'file', data: null, ocrText: null, ocrPagesJson: null,
        blobHash: input.blobHash, pageCount: input.pageCount, extractedText: input.extractedText,
        previewJson: input.previewJson,
      }).length;
    },
  };
  const pdf = deps.pdf();
  if (pdf !== null) {
    library.startPipeline = async (fileId) => { await pdf.startPipeline(fileId, 'ocr_processing'); };
  }
  return library;
}
