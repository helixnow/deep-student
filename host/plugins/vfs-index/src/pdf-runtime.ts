/**
 * Production PDF/image stage runtime.
 *
 * Ports `run_pdf_pipeline_internal`, `run_image_pipeline_internal`,
 * `stage_pdf_page_compression`, `stage_ocr_processing`, `stage_image_ocr`,
 * `stage_vector_indexing` and `backfill_missing_previews` from
 * `crates/dstu-vfs/src/vfs/pdf_processing_service.rs`. Native PDF rendering is
 * F7 `nativePdfium`/`nativeImage`; JPEG policy is F3 `imageQuality`; OCR is L02
 * `llmOcrModels` + `llmOcrHedge`; embedding/indexing is the L12 full indexer.
 * Every dependency is resolved lazily so providers that load after L12 apply
 * are picked up without caching `undefined`.
 */
import { createWebCrypto } from '../../../platform/crypto/web.ts';
import { toBase64, toHex } from '../../../platform/crypto/encoding.ts';
import * as path from '../../../platform/util/path.ts';
import type { ProcessingIssue, ProcessingProgress, ProcessingStage } from '../api.ts';
import type { BackfillScope, PdfProgressCallbacks, PdfStageRuntime } from './pdf-service.ts';
import { parseMediaType } from './pdf-service.ts';
import { hasValidText, joinOcrPagesText, parseOcrPagesJson } from './indexing-content.ts';
import { getResourceOcrValue, updateResourceOcrTextIfEmpty } from '../repository/index-content.ts';
import {
  getPdfRuntimeFileRow, listPdfIdsMissingPreview, updateCompressedBlobHashRow,
  updateOcrPagesJsonRow, updatePreviewJsonOnlyRow, updatePreviewJsonRow, updateResourceOcrTextForFileRow,
} from '../repository/pdf.ts';
import { getBool } from '../repository/index-state.ts';
import { getUnitsByResource } from '../repository/index-units.ts';
import { rustTrim, takeChars, utf8ByteLength } from '../../../platform/util/portable.ts';
import { compressImagePath, imageExtensionForMime, ProcessingSlots } from './pdf-processing.ts';
import { parsePreviewJson, serializePreviewJson, type PreviewJson, type PreviewPage } from './pdf-preview.ts';
import {
  compressImage, JPEG_MIME, messageOf, PNG_MIME,
  type PdfNativeRuntimeDeps, type PdfOcrProvider, type PdfRuntimeFile,
} from './pdf-runtime-deps.ts';
import { runMediaStage } from './media-stage.ts';
export { parsePreviewJson, type PreviewJson, type PreviewPage } from './pdf-preview.ts';
export {
  defaultPdfOcrConfig, type PdfIndexRunner, type PdfNativeRuntimeDeps, type PdfOcrConfig,
  type PdfOcrProvider, type PdfRuntimeFile,
} from './pdf-runtime-deps.ts';

/** `pdf_preview.rs` defaults used by attachment uploads. */
const PREVIEW_RENDER_DPI = 150;
const PREVIEW_MAX_PAGES = 50;
const PREVIEW_TARGET_WIDTH = 1200;
const PREVIEW_MAX_HEIGHT = 1600;
const BACKFILL_LIMIT = 5;
const OCR_CONCURRENCY = 4;
const OCR_INITIAL_BACKOFF_MS = 1_000;
const OCR_MAX_BACKOFF_MS = 20_000;
const OCR_MAX_ATTEMPTS = 3;

interface OcrBlock {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
}

interface OcrPageResult {
  pageIndex: number | bigint;
  blocks: OcrBlock[];
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${toBase64(bytes)}`;
}

/** 并发上限：Rust `available_parallelism` 的 Web 等价物（`navigator.hardwareConcurrency`），上限 4。 */
function availableParallelism(): number {
  const navigatorLike = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  const count = navigatorLike?.hardwareConcurrency ?? 1;
  return Number.isFinite(count) && count >= 1 ? Math.floor(count) : 1;
}

/** `has_valid_ocr_pages(pages, 1)`. */
function hasValidOcrPages(pages: Array<string | null>): boolean {
  return pages.some((page) => page !== null && Array.from(rustTrim(page)).length >= 1);
}

/** `detail.rs` stage order is owned by `pdf-processing.ts`; compare locally. */
const stageOrder: Record<ProcessingStage, number> = {
  pending: 0, queued: 0, decode: 1, vad: 2, asr: 5, indexing: 6,
  text_extraction: 1, page_rendering: 2, page_compression: 3, image_compression: 4,
  ocr_processing: 5, vector_indexing: 6, completed: 7, completed_with_issues: 8, error: 9,
};

function atOrBefore(stage: ProcessingStage, target: ProcessingStage): boolean {
  return stageOrder[stage] <= stageOrder[target];
}

export class NativePdfStageRuntime implements PdfStageRuntime {
  private readonly deps: PdfNativeRuntimeDeps;
  private readonly slots: ProcessingSlots;

  constructor(deps: PdfNativeRuntimeDeps) {
    this.deps = deps;
    this.slots = deps.slots ?? new ProcessingSlots(
      Math.max(1, Math.min(4, availableParallelism())),
    );
  }

  mediaTempDir(): string {
    return path.join(this.deps.appDataDir, 'tmp', 'media');
  }

  async run(
    fileId: string,
    startStage: ProcessingStage,
    signal: AbortSignal,
    callbacks: PdfProgressCallbacks,
  ): ReturnType<PdfStageRuntime['run']> {
    const file = getPdfRuntimeFileRow(this.deps.db, fileId);
    if (file === null) throw new Error(`File not found: ${fileId}`);
    const mediaType = parseMediaType(file.mimeType ?? '', file.fileName);
    if (mediaType === 'pdf') return this.runPdf(file, startStage, signal, callbacks);
    if (mediaType === 'image') return this.runImage(file, startStage, signal, callbacks);
    if (mediaType === 'audio' || mediaType === 'video') {
      return runMediaStage(this.deps, file, mediaType, this.mediaTempDir(), signal, callbacks);
    }
    throw new Error(
      `Media processing for ${mediaType ?? 'unknown'} files requires the L18 media transcription pipeline`,
    );
  }

    // ---------------------------------------------------------------- PDF

  private async runPdf(
    file: PdfRuntimeFile,
    startStage: ProcessingStage,
    signal: AbortSignal,
    callbacks: PdfProgressCallbacks,
  ): Promise<{ readyModes: string[]; failedStages?: ProcessingIssue[]; totalPages?: number | bigint }> {
    const issues: ProcessingIssue[] = [];
    const readyModes: string[] = [];
    const ocrConfig = this.deps.ocrConfig();
    const totalPages: number | bigint = file.pageCount ?? 0;
    const extractedLength = file.extractedText === null
      ? 0
      : Array.from(rustTrim(file.extractedText)).length;
    const contentKind = hasValidText(file.extractedText, ocrConfig.pdfTextThreshold)
      ? 'text' as const : 'scanned' as const;
    let hasValidOcr = hasValidOcrPages(parseOcrPagesJson(file.ocrPagesJson ?? ''));

    if (hasValidText(file.extractedText, 1)) readyModes.push('text');
    if (hasValidOcr) readyModes.push('ocr');

    // Text extraction and preview rendering already ran at upload (Rust has no Stage 1/1.5 here).
    const hasPreview = file.previewJson !== null;
    const preview = parsePreviewJson(file.previewJson);

    // Stage 2.5: page compression happens before OCR and gates `image`.
    if (hasPreview && preview !== null) {
      try {
        const needsCompression = this.pagesNeedCompression(preview);
        if (needsCompression && !signal.aborted) {
          callbacks.status('page_compression');
          const started: ProcessingProgress = {
            stage: 'page_compression', currentPage: 0, totalPages, percent: 5,
            readyModes: [...readyModes], mediaType: 'pdf',
          };
          callbacks.status('page_compression', started);
          this.emit(callbacks, 'page_compression', started);
          await this.compressPreviewPages(file, preview, signal, callbacks, readyModes);
          file.previewJson = serializePreviewJson(preview);
        }
        if (preview.pages.length > 0 && !readyModes.includes('image')) readyModes.push('image');
      } catch (error) {
        if (signal.aborted) return { readyModes };
        this.deps.logger?.warn(`[PdfProcessingService] Page compression failed for ${file.id}: ${messageOf(error)}`);
        if (preview.pages.length > 0 && !readyModes.includes('image')) readyModes.push('image');
      }
      if (preview.pages.length === 0) {
        this.deps.logger?.warn(`[PdfProcessingService] Preview has no pages for file: ${file.id}`);
      }
    }

    // Stage 3: OCR for scanned PDFs.
    const shouldRunPdfOcr = ocrConfig.enabled && ocrConfig.ocrScannedPdf
      && contentKind === 'scanned';
    if (atOrBefore(startStage, 'ocr_processing') && !hasValidOcr && hasPreview) {
      if (!shouldRunPdfOcr) {
        const ocrDisabled = !ocrConfig.enabled || !ocrConfig.ocrScannedPdf;
        if (extractedLength < ocrConfig.pdfTextThreshold && ocrDisabled) {
          issues.push({
            stage: 'ocr_processing',
            message: '该 PDF 缺少文本层且自动 OCR 未启用，内容无法被检索。请在 设置 → OCR 中启用扫描版 PDF OCR（并配置多模态/OCR 模型）后重试',
            retriable: true,
          });
        }
      } else if (!signal.aborted) {
        callbacks.status('ocr_processing');
        this.emit(callbacks, 'ocr_processing', {
          stage: 'ocr_processing', currentPage: 0, totalPages, percent: 20,
          readyModes: [...readyModes], mediaType: 'pdf',
        });
        if (preview !== null) {
          try {
            const text = await this.ocrPdfPages(file, preview, signal, callbacks, readyModes);
            hasValidOcr = text;
          } catch (error) {
            if (signal.aborted) return { readyModes };
            this.deps.logger?.warn(`[PdfProcessingService] OCR processing failed for file ${file.id}: ${messageOf(error)}`);
            issues.push({
              stage: 'ocr_processing',
              message: messageOf(error),
              retriable: true,
            });
          }
        } else {
          this.deps.logger?.warn(`[PdfProcessingService] No preview_json available for OCR, skipping file: ${file.id}`);
        }
      }
    } else if (!hasValidOcr && !hasPreview) {
      if (extractedLength < ocrConfig.pdfTextThreshold) {
        issues.push({
          stage: 'ocr_processing',
          message: 'PDF 页面渲染失败且缺少文本层，无法执行 OCR，内容不可检索。可尝试删除后重新导入，或检查 PDF 是否损坏/加密',
          retriable: true,
        });
      }
    }
    if (hasValidOcr && !readyModes.includes('ocr')) readyModes.push('ocr');

    // Stage 4: vector indexing. Failures are recorded, never fatal.
    if (atOrBefore(startStage, 'vector_indexing') && !signal.aborted) {
      callbacks.status('vector_indexing');
      await this.indexFile(file, callbacks, readyModes, issues, 'pdf');
    }

    return { readyModes, failedStages: issues.length > 0 ? issues : undefined, totalPages };
  }

  private async renderPreview(file: PdfRuntimeFile, signal: AbortSignal): Promise<PreviewJson | null> {
    const repos = this.deps.repositories();
    const pdfium = this.deps.pdfium();
    if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
    if (pdfium === undefined) {
      throw new Error('PDF 功能不可用：未找到 pdfium 库。PDF 页面渲染需要 F7 nativePdfium');
    }
    const bytes = await readBlob(this.deps, file.blobHash);
    if (bytes === null) {
      this.deps.logger?.warn(`[PdfProcessingService] Blob not found for PDF file ${file.id}: ${file.blobHash}`);
      return null;
    }
    if (signal.aborted) return null;
    const document = await pdfium.open(bytes, null);
    try {
      const totalPages = document.pageCount;
      const renderedCount = Math.min(totalPages, PREVIEW_MAX_PAGES);
      const pages: PreviewPage[] = [];
      for (let index = 0; index < renderedCount; index += 1) {
        if (signal.aborted) return null;
        const page = await document.page(index);
        const { width, height } = fitPage(page.width, page.height);
        const rendered = await page.render({ width, height, annotations: false });
        const image = this.deps.nativeImage();
        if (image === undefined) throw new Error('F7 nativeImage service is not available');
        const png = await image.encode(rendered, { format: 'png' });
        const blob = repos.blobs.storeBlob(this.deps.db, this.deps.blobsDir, png, PNG_MIME, 'png');
        pages.push({
          pageIndex: index,
          blobHash: blob.hash,
          width: rendered.width,
          height: rendered.height,
          mimeType: PNG_MIME,
        });
      }
      const preview: PreviewJson = {
        pages,
        renderDpi: PREVIEW_RENDER_DPI,
        totalPages,
        renderedAt: this.nowIso(),
        isTruncated: totalPages > renderedCount,
        maxRenderedPages: PREVIEW_MAX_PAGES,
      };
      updatePreviewJsonRow(this.deps.db, file.id, serializePreviewJson(preview), totalPages);
      file.pageCount = totalPages;
      file.previewJson = serializePreviewJson(preview);
      return preview;
    } finally {
      await document.close();
    }
  }

  private pagesNeedCompression(preview: PreviewJson): boolean {
    const repos = this.deps.repositories();
    if (preview.pages.length === 0) return false;
    for (const page of preview.pages) {
      const hash = page.compressedBlobHash;
      if (hash === undefined || rustTrim(hash) === '') return true;
      if (repos !== undefined
        && repos.blobs.getBlobPath(this.deps.db, this.deps.blobsDir, hash) === null) {
        return true;
      }
    }
    return false;
  }

  private async compressPreviewPages(
    file: PdfRuntimeFile,
    preview: PreviewJson,
    signal: AbortSignal,
    callbacks: PdfProgressCallbacks,
    readyModes: string[],
  ): Promise<void> {
    const repos = this.deps.repositories();
    if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
    const total = preview.pages.length;
    for (const [index, page] of preview.pages.entries()) {
      if (signal.aborted) return;
      const staleHash = page.compressedBlobHash;
      if (staleHash !== undefined && rustTrim(staleHash) !== ''
        && repos.blobs.getBlobPath(this.deps.db, this.deps.blobsDir, staleHash) !== null) {
        continue;
      }
      const sourcePath = repos.blobs.getBlobPath(this.deps.db, this.deps.blobsDir, page.blobHash);
      if (sourcePath === null) {
        this.deps.logger?.warn(
          `[PdfProcessingService] Blob not found for page ${index}: ${page.blobHash}`,
        );
        continue;
      }
      let compressed: Uint8Array | null;
      let originalSize = 0;
      try {
        const result = await compressImagePath({
          slots: this.slots,
          readFile: async (filePath) => this.deps.files().readBytes(filePath),
          compress: (bytes, quality) => compressImage(this.deps, bytes, quality),
        }, sourcePath, signal, 'low');
        compressed = result?.compressed ?? null;
        originalSize = result?.originalSize ?? 0;
      } catch (error) {
        this.deps.logger?.warn(
          `[PdfProcessingService] Failed to compress page ${index}: ${messageOf(error)}`,
        );
        continue;
      }
      if (compressed === null) return;
      if (compressed.byteLength >= originalSize * 9 / 10 || compressed.byteLength === 0) {
        page.compressedBlobHash = page.blobHash;
      } else {
        const hash = toHex(await createWebCrypto().digest('SHA-256', compressed));
        repos.blobs.storeBlob(this.deps.db, this.deps.blobsDir, compressed, JPEG_MIME, 'jpg');
        page.compressedBlobHash = hash;
      }
      if (staleHash !== undefined && rustTrim(staleHash) !== ''
        && staleHash !== file.blobHash && staleHash !== page.compressedBlobHash) {
        try { repos.blobs.decrementRef(this.deps.db, staleHash); }
        catch (error) {
          this.deps.logger?.warn(
            `[PdfProcessingService] Failed to decrement stale compressed blob ${staleHash}: ${messageOf(error)}`,
          );
        }
      }
      const percent = total === 0 ? 5 : 5 + (index / total) * 15;
      this.emit(callbacks, 'page_compression', {
        stage: 'page_compression', currentPage: index + 1, totalPages: total,
        percent, readyModes: [...readyModes], mediaType: 'pdf',
      });
    }
    updatePreviewJsonOnlyRow(this.deps.db, file.id, serializePreviewJson(preview));
  }

  private async ocrPdfPages(
    file: PdfRuntimeFile,
    preview: PreviewJson,
    signal: AbortSignal,
    callbacks: PdfProgressCallbacks,
    readyModes: string[],
  ): Promise<boolean> {
    const provider = this.deps.ocr();
    if (provider === undefined || !(await provider.available())) {
      throw new Error('OCR 模型未配置或不可用');
    }
    const total = preview.pages.length;
    const results: OcrPageResult[] = [];
    const failures: Array<[number | bigint, string]> = [];
    let completed = 0;
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < preview.pages.length) {
        if (signal.aborted) return;
        const index = cursor;
        cursor += 1;
        const page = preview.pages[index]!;
        const repos = this.deps.repositories();
        if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
        const blobPath = repos.blobs.getBlobPath(this.deps.db, this.deps.blobsDir, page.blobHash);
        if (blobPath === null) {
          failures.push([page.pageIndex, `Blob not found: ${page.blobHash}`]);
          continue;
        }
        const bytes = await this.deps.files().readBytes(blobPath);
        const mime = page.mimeType === JPEG_MIME ? JPEG_MIME : PNG_MIME;
        try {
          const pageText = await this.ocrWithRetry(provider, dataUrl(bytes, mime), bytes, page.pageIndex, signal);
          if (rustTrim(pageText) !== '') {
            results.push({
              pageIndex: page.pageIndex,
              blocks: [{
                text: pageText,
                bbox: { x: 0, y: 0, width: 1, height: 1 },
              }],
            });
          }
        } catch (error) {
          failures.push([page.pageIndex, messageOf(error)]);
        }
        completed += 1;
        const percent = 20 + (completed / total) * 55;
        this.emit(callbacks, 'ocr_processing', {
          stage: 'ocr_processing', currentPage: completed, totalPages: total, percent,
          readyModes: [...readyModes], mediaType: 'pdf',
        });
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(OCR_CONCURRENCY, total) }, () => worker(),
    ));
    if (signal.aborted) return false;

    results.sort((left, right) => left.pageIndex < right.pageIndex ? -1 : left.pageIndex > right.pageIndex ? 1 : 0);
    const successRate = total === 0 ? 0 : results.length / total;
    const usable = hasValidOcrPages(results.map((page) => (
      page.blocks.map((block) => rustTrim(block.text)).filter((part) => part !== '').join('\n')
    ))) && successRate >= 0.5;
    const payload = {
      totalPages: total,
      pages: results,
      completedAt: this.nowIso(),
    };
    const json = JSON as typeof JSON & { rawJSON(value: string): unknown };
    updateOcrPagesJsonRow(this.deps.db, file.id, JSON.stringify(payload,
      (_key, value: unknown) => typeof value === 'bigint' ? json.rawJSON(value.toString()) : value));

    const joined = joinOcrPagesText(
      results.map((page) => page.blocks.map((block) => block.text).join('\n')),
      '第', '页',
    );
    if (joined !== null && file.resourceId !== null) {
      updateResourceOcrTextIfEmpty(
        this.deps.db, file.resourceId, joined, this.deps.repositories?.(),
      );
    }
    if (usable) {
      if (!readyModes.includes('ocr')) readyModes.push('ocr');
      if (failures.length > 0) {
        this.deps.logger?.info(
          `[PdfProcessingService] OCR partially succeeded for file ${file.id}: ${results.length}/${total} pages OK`,
        );
      }
    } else {
      this.deps.logger?.warn(
        `[PdfProcessingService] OCR mostly failed for file ${file.id}: ${failures.length}/${total} pages failed`,
      );
    }
    return usable;
  }

  // ---------------------------------------------------------------- image

  private async runImage(
    file: PdfRuntimeFile,
    startStage: ProcessingStage,
    signal: AbortSignal,
    callbacks: PdfProgressCallbacks,
  ): Promise<{ readyModes: string[]; failedStages?: ProcessingIssue[]; currentPage?: number; totalPages?: number }> {
    const issues: ProcessingIssue[] = [];
    const readyModes: string[] = ['image'];
    const ocrConfig = this.deps.ocrConfig();
    let hasOcr = this.resourceOcrText(file.resourceId) !== null;

    if (hasOcr) readyModes.push('ocr');

    if (atOrBefore(startStage, 'image_compression') && !signal.aborted) {
      this.emit(callbacks, 'image_compression', {
        stage: 'image_compression', currentPage: 1, totalPages: 1, percent: 10,
        readyModes: [...readyModes], mediaType: 'image',
      });
      try {
        await compressImageFile(this.deps, this.slots, file, signal);
      } catch (error) {
        if (signal.aborted) return { readyModes };
        // Compression is an optimization: Rust keeps the original image.
        this.deps.logger?.warn(
          `[MediaProcessingService] Image compression failed for file ${file.id}: ${messageOf(error)}; using original`,
        );
      }
      this.emit(callbacks, 'image_compression', {
        stage: 'image_compression', currentPage: 1, totalPages: 1, percent: 25,
        readyModes: [...readyModes], mediaType: 'image',
      });
    }

    const multimodal = await this.deps.chatModelIsMultimodal();
    const shouldRunImageOcr = ocrConfig.enabled && ocrConfig.ocrImages && !multimodal;
    if (atOrBefore(startStage, 'ocr_processing') && !hasOcr && shouldRunImageOcr
      && !signal.aborted) {
      this.emit(callbacks, 'ocr_processing', {
        stage: 'ocr_processing', currentPage: 1, totalPages: 1, percent: 40,
        readyModes: [...readyModes], mediaType: 'image',
      });
      try {
        const text = await ocrImageFile(this.deps, file, signal);
        if (text !== null && rustTrim(text) !== '') {
          hasOcr = true;
          if (!readyModes.includes('ocr')) readyModes.push('ocr');
        }
      } catch (error) {
        if (signal.aborted) return { readyModes };
        this.deps.logger?.warn(`[MediaProcessingService] Image OCR failed for file ${file.id}: ${messageOf(error)}`);
        issues.push({
          stage: 'ocr_processing',
          message: messageOf(error),
          retriable: true,
        });
      }
    }

    if (atOrBefore(startStage, 'vector_indexing') && file.resourceId !== null && !signal.aborted) {
      callbacks.status('vector_indexing');
      await this.indexFile(file, callbacks, readyModes, issues, 'image');
    }
    return {
      readyModes, failedStages: issues.length > 0 ? issues : undefined, currentPage: 1, totalPages: 1,
    };
  }

  private resourceOcrText(resourceId: string | null): string | null {
    if (resourceId === null) return null;
    return getResourceOcrValue(this.deps.db, resourceId);
  }

  // ---------------------------------------------------------------- vector

  /** `stage_vector_indexing` (3309-3595); the caller already wrote `VectorIndexing`. */
  private async indexFile(
    file: PdfRuntimeFile,
    callbacks: PdfProgressCallbacks,
    readyModes: readonly string[],
    issues: ProcessingIssue[],
    mediaType: 'pdf' | 'image',
  ): Promise<void> {
    if (!getBool(this.deps.db, 'indexing.enabled', true)) {
      this.deps.logger?.info(`[PdfProcessingService] Automatic vector indexing disabled for file: ${file.id}`);
      return;
    }
    if (file.resourceId !== null && getUnitsByResource(this.deps.db, file.resourceId)
      .some((unit) => unit.textState === 'indexing' || unit.mmState === 'indexing')) {
      this.deps.logger?.warn(`[PdfProcessingService] Resource ${file.id} is already being indexed, skipping`);
      return;
    }
    const runner = this.deps.indexing();
    if (runner === undefined) {
      issues.push({ stage: 'vector_indexing', message: '嵌入索引服务不可用', retriable: true });
      return;
    }
    if (file.resourceId === null) {
      issues.push({
        stage: 'vector_indexing',
        message: `INVALID_OPERATION: vector_indexing - File ${file.id} has no associated resource`,
        retriable: true,
      });
      return;
    }
    const progress = (percent: number): ProcessingProgress => ({
      stage: 'vector_indexing',
      ...(file.pageCount === null ? {} : { totalPages: file.pageCount }),
      percent, readyModes: [...readyModes], mediaType,
    });
    this.emit(callbacks, 'vector_indexing', progress(75));
    // Rust syncs units here (vfs_index_units only); the full indexer re-syncs inside indexResource.
    this.emit(callbacks, 'vector_indexing', progress(85));
    try {
      await runner.indexResource(file.resourceId);
    } catch (error) {
      // Rust :3568-3574: index failures only warn; the file stays usable.
      this.deps.logger?.warn(`[PdfProcessingService] Vector indexing failed for file ${file.id}: ${messageOf(error)}`);
    }
    this.emit(callbacks, 'vector_indexing', progress(95));
  }

  // ---------------------------------------------------------------- backfill

  backfillMissingPreviews(limit: number, scope?: BackfillScope): number {
    const count = Math.max(0, Math.min(limit, BACKFILL_LIMIT));
    if (count === 0) return 0;
    const fileIds = listPdfIdsMissingPreview(this.deps.db, count);
    if (fileIds.length === 0) {
      this.deps.logger?.info('[PdfProcessingService] Backfill: no historical PDFs missing preview_json');
      return 0;
    }
    this.deps.logger?.info(
      `[PdfProcessingService] Backfill: found ${fileIds.length} historical PDFs missing preview_json, processing in background`,
    );
    const signal = scope?.signal ?? new AbortController().signal;
    const task = this.runBackfill(fileIds, signal).catch((error: unknown) => {
      this.deps.logger?.warn(`[PdfProcessingService] Backfill failed: ${messageOf(error)}`);
    });
    scope?.track(task);
    return fileIds.length;
  }

  private async runBackfill(fileIds: readonly string[], signal: AbortSignal): Promise<void> {
    for (const fileId of fileIds) {
      if (signal.aborted) return;
      const file = getPdfRuntimeFileRow(this.deps.db, fileId);
      if (file === null || file.previewJson !== null) continue;
      try {
        await this.renderPreview(file, signal);
      } catch (error) {
        if (signal.aborted) return;
        this.deps.logger?.warn(
          `[PdfProcessingService] Backfill failed for file ${fileId}: ${messageOf(error)}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------- helpers

  private async ocrWithRetry(
    provider: PdfOcrProvider,
    url: string,
    bytes: Uint8Array,
    pageIndex: number | bigint,
    signal: AbortSignal,
  ): Promise<string> {
    let attempt = 0;
    let backoff = OCR_INITIAL_BACKOFF_MS;
    for (;;) {
      if (signal.aborted) throw new Error('Cancelled');
      try {
        return await provider.recognize(url, bytes, signal);
      } catch (error) {
        if (signal.aborted) throw new Error('Cancelled');
        if (!isRateLimitError(error) || attempt >= OCR_MAX_ATTEMPTS) throw error;
        attempt += 1;
        this.deps.logger?.warn(
          `[PdfProcessingService] OCR rate limited for page ${pageIndex}, retrying (${attempt}/${OCR_MAX_ATTEMPTS}), backoff=${backoff}ms`,
        );
        await delay(backoff, signal);
        backoff = Math.min(backoff * 2, OCR_MAX_BACKOFF_MS);
      }
    }
  }

  private emit(
    callbacks: PdfProgressCallbacks,
    stage: ProcessingStage,
    progress: ProcessingProgress,
  ): void {
    callbacks.progress(stage, progress);
  }

  private nowIso(): string {
    return this.deps.nowIso?.() ?? new Date().toISOString();
  }
}

// ---------------------------------------------------------------- image file stages

/**
 * `pdf_processing_service.rs` image-file stages: `stage_image_compression` (low-quality JPEG
 * replacement kept only when it saves ≥10%) and `stage_image_ocr_with_base64` (free-text OCR
 * through a private temp file, persisted to `resources.ocr_text`).
 */
async function compressImageFile(
  deps: PdfNativeRuntimeDeps, slots: ProcessingSlots, file: PdfRuntimeFile, signal: AbortSignal,
): Promise<void> {
  const repos = deps.repositories();
  if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
  if (file.blobHash === null) {
    deps.logger?.warn(`[MediaProcessingService] Image compression skipped: no content for file ${file.id}`);
    return;
  }
  const existing = file.compressedBlobHash;
  if (existing !== null && rustTrim(existing) !== ''
    && repos.blobs.getBlobPath(deps.db, deps.blobsDir, existing) !== null) {
    return;
  }
  const blobPath = repos.blobs.getBlobPath(deps.db, deps.blobsDir, file.blobHash);
  if (blobPath === null) throw new Error(`Blob not found: ${file.blobHash}`);
  const result = await compressImagePath({
    slots,
    readFile: async (filePath) => deps.files().readBytes(filePath),
    compress: (bytes, quality) => compressImage(deps, bytes, quality),
  }, blobPath, signal, 'low');
  if (result === null) return;
  let finalHash = file.blobHash;
  if (result.compressed.byteLength < result.originalSize * 9 / 10
    && result.compressed.byteLength > 0) {
    const compressedHash = toHex(await createWebCrypto().digest('SHA-256', result.compressed));
    repos.blobs.storeBlob(deps.db, deps.blobsDir, result.compressed, JPEG_MIME, 'jpg');
    finalHash = compressedHash;
  }
  updateCompressedBlobHashRow(deps.db, file.id, finalHash);
  if (existing !== null && rustTrim(existing) !== '' && existing !== file.blobHash
    && existing !== finalHash) {
    try { repos.blobs.decrementRef(deps.db, existing); }
    catch (error) {
      deps.logger?.warn(
        `[MediaProcessingService] Failed to decrement stale compressed blob ${existing}: ${messageOf(error)}`,
      );
    }
  }
}

async function ocrImageFile(deps: PdfNativeRuntimeDeps, file: PdfRuntimeFile, signal: AbortSignal): Promise<string | null> {
  const repos = deps.repositories();
  const provider = deps.ocr();
  if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
  if (provider === undefined || !(await provider.available())) {
    throw new Error('OCR 模型未配置或不可用');
  }
  const bytes = await readBlob(deps, file.blobHash);
  if (bytes === null) throw new Error(`Blob not found: ${file.blobHash}`);
  const mime = file.mimeType ?? PNG_MIME;
  if (signal.aborted) return '';
  deps.logger?.info(`[OCR_DIAG] stage_image_ocr_with_base64 START: file_id=${file.id}, mime_type=${mime}, base64_len=${4 * Math.ceil(bytes.length / 3)}`);
  deps.logger?.info(`[OCR_DIAG] file->resource mapping: file_id=${file.id} -> resource_id=${file.resourceId === null ? 'None' : `Some(${JSON.stringify(file.resourceId)})`}`);
  const files = deps.files();
  let directory: string | undefined;
  let ocrText: string;
  try {
    let imagePath: string;
    try {
      // `tempfile::tempdir`：唯一目录名 + 独占创建 0600 文件，目录与文件都经 `ctx.files`。
      directory = path.join(deps.appDataDir, 'tmp', 'media', `ds-attachment-ocr-${globalThis.crypto.randomUUID()}`);
      await files.mkdir(directory, { recursive: true });
      imagePath = path.join(directory, `${path.basename(directory)}${imageExtensionForMime(mime)}`);
      await files.writeBytes(imagePath, bytes, { exclusive: true, unixMode: 0o600 });
    } catch (error) {
      throw new Error(`Create OCR temp image failed: ${messageOf(error)}`);
    }
    deps.logger?.info(`[OCR_DIAG] calling OCR engines with fallback for file_id=${file.id}`);
    try {
      if (provider.recognizeFile === undefined) throw new Error('L02 llmOcrPages service is not available');
      // Rust's free-text file entry has no cancellation token or outer retry.
      ocrText = await provider.recognizeFile(imagePath);
    } catch (error) {
      deps.logger?.warn(`[OCR_DIAG] OCR (all engines) FAILED for file_id=${file.id}: ${messageOf(error)}`);
      throw new Error(`OCR API call failed: ${messageOf(error)}`);
    }
  } finally {
    // NamedTempFile Drop ignores close/unlink errors and never masks the OCR result.
    if (directory !== undefined) await files.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  if (signal.aborted) return '';
  deps.logger?.info(`[OCR_DIAG] OCR API returned for file_id=${file.id}: text_len=${utf8ByteLength(ocrText)}, preview="${takeChars(ocrText, 100)}"`);
  if (rustTrim(ocrText) === '') {
    deps.logger?.warn(
      `[OCR_DIAG] OCR API returned EMPTY text for file_id=${file.id}, NOT writing to DB (keeping ocr_text as NULL so retry is possible). Possible causes: (1) OCR model does not support vision, (2) API returned empty response, (3) image has no recognizable text`,
    );
    return ocrText;
  }
  const updated = updateResourceOcrTextForFileRow(deps.db, file.id, ocrText, repos);
  if (updated === 0) {
    deps.logger?.warn(`[OCR_DIAG] OCR text NOT persisted: file_id=${file.id}, rows_affected=0. resource_id lookup failed (files.resource_id may be NULL). Returning error to prevent ready_modes from falsely including 'ocr'.`);
    throw new Error(`OCR text produced but DB save failed (rows_affected=0) for file_id=${file.id}`);
  }
  deps.logger?.info(`[OCR_DIAG] OCR text saved to resources table: file_id=${file.id}, rows_affected=${updated}`);
  return ocrText;
}

async function readBlob(deps: PdfNativeRuntimeDeps, blobHash: string | null): Promise<Uint8Array | null> {
  if (blobHash === null) return null;
  const repos = deps.repositories();
  if (repos === undefined) throw new Error('L11 vfsRepo service is not available');
  const filePath = repos.blobs.getBlobPath(deps.db, deps.blobsDir, blobHash);
  if (filePath === null) return null;
  return deps.files().readBytes(filePath);
}

function fitPage(pageWidth: number, pageHeight: number): { width: number; height: number } {
  if (pageWidth <= 0 || pageHeight <= 0) {
    return { width: PREVIEW_TARGET_WIDTH, height: PREVIEW_MAX_HEIGHT };
  }
  let width = PREVIEW_TARGET_WIDTH;
  let height = Math.round((pageHeight / pageWidth) * width);
  if (height > PREVIEW_MAX_HEIGHT) {
    height = PREVIEW_MAX_HEIGHT;
    width = Math.round((pageWidth / pageHeight) * height);
  }
  return { width, height };
}

function isRateLimitError(error: unknown): boolean {
  const message = messageOf(error).toLowerCase();
  return message.includes('429')
    || message.includes('rate limit')
    || message.includes('too many requests');
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Cancelled')); return; }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
