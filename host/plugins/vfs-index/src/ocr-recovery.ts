/**
 * `VfsFullIndexingService::try_auto_ocr` / `try_auto_ocr_pdf_pages` /
 * `try_auto_ocr_single_image` (indexing.rs:3271-3960).
 *
 * Indexing-time OCR recovery is deliberately separate from the upload-time PDF
 * pipeline: it reuses the pages rendered into `preview_json`, calls L02's
 * free-text OCR engine chain, then persists `files.ocr_pages_json` and
 * `resources.ocr_text`. All table writes go through L11 owner repositories,
 * using the exact conditional, timestamp-less or SQLite timestamp cache method.
 */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { OcrRecovery } from './full-indexing.ts';
import type { VfsResourceRecord } from '../repository/index-units.ts';
import {
  getFileOcrPagesById, updateResourceOcrTextIfEmpty, updateResourceOcrTextRow,
  updateResourceOcrTextWithoutTimestamp,
} from '../repository/index-content.ts';
import {
  fileExistsRow, getFileBlobHashRow, getFileIdByResourceRow, getFileOcrSourceRow,
  getProcessingProgressJson, setProcessingProgressJson, updateOcrPagesJsonRow,
} from '../repository/pdf.ts';
import { joinOcrPagesText, parseOcrPagesJson } from './indexing-content.ts';
import { processingProgressSnapshot, serializeProcessingProgress, tryParseProcessingProgress } from './pdf-processing.ts';
import { decodePreviewJson, type PreviewJson } from './pdf-preview.ts';
import type { PdfOcrProvider } from './pdf-runtime.ts';
import type { LaneLogger } from './logger.ts';
import { JsonSyntaxError, rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';

const AUTO_OCR_CONCURRENCY = 3;

export interface OcrRecoveryDeps {
  readonly db: SqlExecutor;
  readonly blobsDir: string;
  readonly provider: PdfOcrProvider;
  /** L11 owner repositories; lazily resolved so plugin load order is irrelevant. */
  readonly repositories: () => VfsReposService | undefined;
  /** `ctx.files.readBytes`：OCR 页图片字节（移动端同一套异步接口）。 */
  readonly readBytes: (path: string) => Promise<Uint8Array>;
  readonly logger?: LaneLogger;
  /** `app_handle.emit`; absent like Rust's `app_handle: None`, which skips the readyModes progress events. */
  readonly events?: { emit(event: string, payload: unknown): void };
}

interface FileOcrRow {
  id: string;
  resourceId: string | null;
  previewJson: string | null;
  mimeType: string | null;
  ocrPagesJson: string | null;
}

interface OcrPageResult {
  page_index: number | bigint;
  blocks: Array<{
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export class VfsOcrRecovery implements OcrRecovery {
  private readonly db: SqlExecutor;
  private readonly blobsDir: string;
  private readonly provider: PdfOcrProvider;
  private readonly repositories: () => VfsReposService | undefined;
  private readonly readBytes: (path: string) => Promise<Uint8Array>;
  private readonly logger: LaneLogger | undefined;
  private readonly events: OcrRecoveryDeps['events'];

  constructor(deps: OcrRecoveryDeps) {
    this.db = deps.db;
    this.blobsDir = deps.blobsDir;
    this.provider = deps.provider;
    this.repositories = deps.repositories;
    this.readBytes = deps.readBytes;
    this.logger = deps.logger;
    this.events = deps.events;
  }

  async recover(
    resource: VfsResourceRecord,
    emit: (event: Record<string, unknown>) => void,
  ): Promise<string | null> {
    switch (resource.resourceType) {
      case 'image':
        return this.recoverImage(resource);
      case 'textbook':
      case 'file':
        return this.recoverPdfPages(resource, emit);
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- image

  private async recoverImage(resource: VfsResourceRecord): Promise<string | null> {
    const file = this.findFile(resource);
    if (file === null || file.mimeType === null) return null;
    if (file.mimeType === 'application/pdf') {
      return this.recoverPdfPages(resource, () => undefined);
    }
    if (!file.mimeType.startsWith('image/')) return null;
    return this.recoverSingleImage(resource, file);
  }

  private async recoverSingleImage(
    resource: VfsResourceRecord,
    file: FileOcrRow,
  ): Promise<string | null> {
    const blobHash = getFileBlobHashRow(this.db, file.id);
    if (blobHash === null) return null;
    const blobPath = this.blobPath(blobHash);
    if (blobPath === null) return null;
    const bytes = await this.readBytes(blobPath);
    if (bytes.length === 0) return null;

    this.logger?.info(
      `[try_auto_ocr_single_image] Calling OCR for file ${resource.id} (${file.mimeType})`,
    );
    const ocrText = rustTrim(await this.recognize(file.mimeType ?? 'image/png', bytes));
    if (ocrText === '') return null;
    // `indexing.rs:3354/3949`: image OCR caches without touching `updated_at`.
    this.cacheResourceOcrText(resource.id, ocrText, 'withoutTimestamp');
    return ocrText;
  }

  // ---------------------------------------------------------------- PDF pages

  private async recoverPdfPages(
    resource: VfsResourceRecord,
    emit: (event: Record<string, unknown>) => void,
  ): Promise<string | null> {
    const file = this.findFile(resource);
    if (file === null) {
      this.logger?.info(
        `[try_auto_ocr_pdf_pages] No file_id found for resource ${resource.id}, skipping`,
      );
      return null;
    }

    // Concurrency guard: the upload pipeline may have finished first.
    const existing = file.ocrPagesJson ?? getFileOcrPagesById(this.db, file.id);
    if (existing !== null) {
      const pages = parseOcrPagesJson(existing);
      if (hasValidOcrPages(pages)) {
        const joined = joinOcrPagesText(pages, '第', '页');
        if (joined !== null && joined !== '') {
          this.cacheResourceOcrText(resource.id, joined, 'ifEmpty');
          return joined;
        }
      }
      this.logger?.info(
        `[try_auto_ocr_pdf_pages] Existing ocr_pages_json for file ${file.id} could not be parsed into text, will re-OCR`,
      );
    }

    if (file.mimeType !== null && file.mimeType.startsWith('image/')) {
      return this.recoverSingleImage(resource, file);
    }
    if (file.mimeType !== null && file.mimeType !== 'application/pdf') {
      this.logger?.info(
        `[try_auto_ocr_pdf_pages] File ${resource.id} has unsupported MIME type (${file.mimeType}), skipping OCR`,
      );
      return null;
    }

    if (file.previewJson === null || rustTrim(file.previewJson) === '') {
      this.logger?.info(
        `[try_auto_ocr_pdf_pages] No preview_json for file ${file.id} (resource ${resource.id}), cannot OCR without rendered pages`,
      );
      return null;
    }
    let preview: PreviewJson;
    try {
      preview = decodePreviewJson(file.previewJson);
    } catch (error) {
      if (!(error instanceof JsonSyntaxError)) throw error;
      throw new Error(`Failed to parse preview_json for file ${file.id}: ${error.message}`);
    }
    if (preview.pages.length === 0) {
      this.logger?.info(`[try_auto_ocr_pdf_pages] preview_json has 0 pages for file ${file.id}, skipping`);
      return null;
    }
    if (!(await this.provider.available())) {
      this.logger?.warn(
        `[try_auto_ocr_pdf_pages] OCR 模型未配置或不可用，跳过资源 ${resource.id} 的自动 OCR`,
      );
      return null;
    }

    const totalPages = preview.pages.length;
    this.logger?.info(
      `[try_auto_ocr_pdf_pages] Starting auto-OCR for resource ${resource.id} (file=${file.id}, ${totalPages} pages)`,
    );
    emit({
      type: 'auto_ocr_started',
      resourceId: resource.id,
      fileId: file.id,
      totalPages,
      message: `开始自动 OCR (${totalPages} 页)...`,
    });

    const pageInputs = preview.pages.map((page) => ({
      pageIndex: page.pageIndex,
      blobHash: page.blobHash,
      mimeType: page.mimeType,
    }));
    const results: OcrPageResult[] = [];
    const failures: string[] = [];
    let completed = 0;
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < pageInputs.length) {
        const current = pageInputs[cursor];
        cursor += 1;
        if (current === undefined) return;
        let blocks: OcrPageResult['blocks'] | null = null;
        try {
          const blobPath = this.blobPath(current.blobHash);
          if (blobPath === null) {
            throw new Error(`Blob not found: ${current.blobHash}`);
          }
          const bytes = await this.readBytes(blobPath);
          const pageText = rustTrim(await this.recognize(current.mimeType, bytes));
          if (pageText !== '') {
            blocks = [{
              text: pageText,
              bbox: { x: 0, y: 0, width: 1, height: 1 },
            }];
          }
        } catch (error) {
          failures.push(messageOf(error));
          this.logger?.warn(
            `[try_auto_ocr_pdf_pages] OCR failed for page ${current.pageIndex} of resource ${resource.id}: ${messageOf(error)}`,
          );
        }
        if (blocks !== null) results.push({ page_index: current.pageIndex, blocks });
        completed += 1;
        emit({
          type: 'auto_ocr_page',
          resourceId: resource.id,
          fileId: file.id,
          currentPage: completed,
          totalPages,
          successCount: completed,
          percent: totalPages > 0 ? Math.floor((completed / totalPages) * 100) : 0,
          message: `自动 OCR 进度: ${completed}/${totalPages} 页`,
        });
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(AUTO_OCR_CONCURRENCY, totalPages) }, () => worker(),
    ));

    results.sort((left, right) => left.page_index < right.page_index ? -1 : left.page_index > right.page_index ? 1 : 0);
    const successCount = results.length;
    const failedCount = failures.length;

    if (successCount === 0) {
      emit({
        type: 'auto_ocr_completed',
        resourceId: resource.id,
        fileId: file.id,
        success: false,
        successCount: 0,
        failCount: failedCount,
        totalPages,
        message: `自动 OCR 失败: 所有 ${totalPages} 页均识别失败`,
      });
      return null;
    }

    const json = JSON as typeof JSON & { rawJSON(value: string): unknown };
    const ocrJson = JSON.stringify({
      total_pages: totalPages,
      pages: results,
      completed_at: new Date().toISOString(),
    }, (_key, value: unknown) => typeof value === 'bigint' ? json.rawJSON(value.toString()) : value);
    updateOcrPagesJsonRow(this.db, file.id, ocrJson);

    const combinedText = results
      .map((page) => page.blocks.map((block) => block.text).join('\n'))
      .filter((value) => rustTrim(value) !== '')
      .join('\n\n');
    if (combinedText !== '') {
      // `indexing.rs:3778`: combined PDF-page OCR updates `updated_at`.
      this.cacheResourceOcrText(resource.id, combinedText, 'withTimestamp');
    }
    this.markOcrReady(file.id);

    this.logger?.info(
      `[try_auto_ocr_pdf_pages] OCR completed for resource ${resource.id}: ${successCount} success, ${failedCount} failed out of ${totalPages} pages`,
    );
    emit({
      type: 'auto_ocr_completed',
      resourceId: resource.id,
      fileId: file.id,
      success: true,
      successCount,
      failCount: failedCount,
      totalPages,
      textLength: utf8ByteLength(combinedText),
      message: `自动 OCR 完成: ${successCount}/${totalPages} 页成功`,
    });
    return combinedText === '' ? null : combinedText;
  }

  // ---------------------------------------------------------------- helpers

  private findFile(resource: VfsResourceRecord): FileOcrRow | null {
    let fileId: string | null = null;
    const sourceId = resource.sourceId;
    if (sourceId !== null
      && (sourceId.startsWith('file_') || sourceId.startsWith('att_') || sourceId.startsWith('tb_'))) {
      if (fileExistsRow(this.db, sourceId)) fileId = sourceId;
    }
    if (fileId === null) fileId = getFileIdByResourceRow(this.db, resource.id);
    if (fileId === null) return null;
    return getFileOcrSourceRow(this.db, fileId);
  }

  private blobPath(blobHash: string): string | null {
    const repos = this.repositories();
    if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
    return repos.blobs.getBlobPath(this.db, this.blobsDir, blobHash);
  }

  private async recognize(mime: string | null, bytes: Uint8Array): Promise<string> {
    const mediaType = mime !== null && mime.startsWith('image/') ? mime : 'image/png';
    const dataUrl = `data:${mediaType};base64,${toBase64(bytes)}`;
    return this.provider.recognize(dataUrl, bytes, new AbortController().signal);
  }

  private cacheResourceOcrText(
    resourceId: string,
    textValue: string,
    mode: 'ifEmpty' | 'withTimestamp' | 'withoutTimestamp',
  ): void {
    const repos = this.repositories();
    if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
    try {
      if (mode === 'ifEmpty') {
        updateResourceOcrTextIfEmpty(this.db, resourceId, textValue, repos);
      } else if (mode === 'withoutTimestamp') {
        updateResourceOcrTextWithoutTimestamp(this.db, resourceId, textValue, repos);
      } else {
        // indexing.rs:3777-3786: SQLite datetime('now') and unwrapped SQL errors;
        // the warning below remains best-effort, before readiness/completion.
        updateResourceOcrTextRow(this.db, resourceId, textValue, repos);
      }
    } catch (error) {
      this.logger?.warn(`[VfsIndexing] Failed to cache ocr_text for resource ${resourceId}: ${messageOf(error)}`);
    }
  }

  /** indexing.rs:3789-3833: step 10 runs whether or not any page text was recognised. */
  private markOcrReady(fileId: string): void {
    const raw = getProcessingProgressJson(this.db, fileId);
    if (raw === null) return;
    // indexing.rs:3799 `if let Ok(..) = serde_json::from_str`: unparsable progress is left untouched.
    const progress = tryParseProcessingProgress(raw);
    if (progress === null) return;
    if (!progress.readyModes.includes('ocr')) {
      progress.readyModes = [...progress.readyModes, 'ocr'];
      try { setProcessingProgressJson(this.db, fileId, serializeProcessingProgress(progress)); }
      catch (error) {
        this.logger?.warn(`[VfsIndexing] Failed to update processing_progress for file ${fileId}: ${messageOf(error)}`);
      }
    }
    // Emitted even when `ocr` was already ready (indexing.rs:3814-3831).
    if (this.events === undefined) return;
    const event = { fileId, status: processingProgressSnapshot(progress), mediaType: 'pdf' };
    this.events.emit('media-processing-progress', event);
    this.events.emit('pdf-processing-progress', event);
    this.logger?.info(`[try_auto_ocr_pdf_pages] Emitted media-processing-progress after auto-OCR: file=${fileId}, ready_modes=[${
      progress.readyModes.map((mode) => JSON.stringify(mode)).join(', ')}]`);
  }
}

function hasValidOcrPages(pages: readonly (string | null)[]): boolean {
  return pages.some((page) => page !== null && Array.from(rustTrim(page)).length >= 1);
}
