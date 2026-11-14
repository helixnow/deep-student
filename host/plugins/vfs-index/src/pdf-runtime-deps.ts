/** Dependencies, OCR/indexing seams and the image-compression helper shared by the PDF, image and media stage runtimes. */
import type { ImageQualityService, SqlExecutor } from '../../../platform/storage/api.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { MediaTranscriberService } from '../api.ts';
import type { LaneLogger } from './logger.ts';
import { PDF_TEXT_THRESHOLD } from './indexing-content.ts';
import type { ImageQuality, ProcessingSlots } from './pdf-processing.ts';

export const JPEG_MIME = 'image/jpeg';
export const PNG_MIME = 'image/png';

export interface PdfOcrConfig {
  enabled: boolean;
  pdfTextThreshold: number | bigint;
  ocrImages: boolean;
  ocrScannedPdf: boolean;
}

export function defaultPdfOcrConfig(): PdfOcrConfig {
  return {
    enabled: true,
    pdfTextThreshold: PDF_TEXT_THRESHOLD,
    ocrImages: true,
    ocrScannedPdf: true,
  };
}

/** L02 free-text OCR chain (multi-engine hedge), resolved per call. */
export interface PdfOcrProvider {
  available(): Promise<boolean>;
  recognize(dataUrl: string, imageBytes: Uint8Array, signal: AbortSignal): Promise<string>;
  recognizeFile?(imagePath: string): Promise<string>;
}

/** The subset of the full indexer needed by the vector stage. */
export interface PdfIndexRunner {
  indexResource(resourceId: string, folderId?: string | null): Promise<[number, number]>;
}

export interface PdfRuntimeFile {
  id: string;
  resourceId: string | null;
  blobHash: string | null;
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  pageCount: number | null;
  extractedText: string | null;
  previewJson: string | null;
  ocrPagesJson: string | null;
  compressedBlobHash: string | null;
}

export interface PdfNativeRuntimeDeps {
  readonly db: SqlExecutor;
  readonly blobsDir: string;
  readonly appDataDir: string;
  /** `ctx.files`：页面 PNG/JPEG 字节读取与 OCR 临时图片（移动端同一套异步接口）。 */
  files(): FilesService;
  readonly logger?: LaneLogger;
  pdfium(): NativePdfium | undefined;
  nativeImage(): NativeImage | undefined;
  imageQuality(): ImageQualityService | undefined;
  repositories(): VfsReposService | undefined;
  ocr(): PdfOcrProvider | undefined;
  indexing(): PdfIndexRunner | undefined;
  /** L18's registered `mediaTranscriber`, resolved at task execution. */
  transcriber?(): MediaTranscriberService | undefined;
  ocrConfig(): PdfOcrConfig;
  chatModelIsMultimodal(): Promise<boolean>;
  readonly slots?: ProcessingSlots;
  nowIso?(): string;
}

export function messageOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);
}

export async function compressImage(
  deps: PdfNativeRuntimeDeps, bytes: Uint8Array, quality: ImageQuality,
): Promise<Uint8Array> {
  const image = deps.nativeImage();
  const policy = deps.imageQuality();
  if (image === undefined) throw new Error('F7 nativeImage service is not available');
  if (policy === undefined) throw new Error('F3 imageQuality service is not available');
  return policy.adjustImageQualityBytes(bytes, quality, image);
}
