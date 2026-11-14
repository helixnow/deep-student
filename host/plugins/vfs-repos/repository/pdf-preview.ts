/** Port of dstu-vfs pdf_preview.rs configuration and async rendering pipeline. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import type { PdfPagePreview, PdfPreviewJson } from '../api.ts';
import { logDebug, logInfo, logWarn } from './logger.ts';
import { utcNow } from './timestamps.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

export interface PdfPreviewConfig {
  renderDpi: number;
  maxPages: number;
  targetWidth: number;
  maxHeight: number;
  jpegQuality: number;
  compressionEnabled: boolean;
}

export interface PdfPreviewResult {
  previewJson: PdfPreviewJson | null;
  extractedText: string | null;
  pageCount: number;
}

export const DEFAULT_PDF_PREVIEW_CONFIG: PdfPreviewConfig = {
  renderDpi: 150,
  maxPages: 50,
  targetWidth: 1200,
  maxHeight: 1600,
  jpegQuality: 75,
  compressionEnabled: true,
};

/**
 * F7 `NativeImage.encode` (`Res::encode`, image 0.24). The formal main
 * `NativeImage` currently publishes only `dimensions`/`decodeRgba`; the F7
 * branch (`f00fd62c1`+) publishes this method, so callers inject it.
 */
export interface PdfImageEncoder {
  encode(input: { width: number; height: number; rgba: Uint8Array },
    options: { format: 'png' | 'jpeg'; quality?: number }): Promise<Uint8Array>;
}

export interface PdfPreviewStoreBlob {
  (conn: SqlExecutor, blobsDir: string, bytes: Uint8Array, mimeType: string, extension: string): { hash: string };
}

/** Lazily resolved F7/L18 capabilities used by the async PDF preview pipeline. */
export interface PdfPreviewDependencies {
  /** F7 `nativePdfium`; absence reproduces Rust's warn-and-text-only path. */
  pdfium(): NativePdfium | null;
  /** F7 `nativeImage.encode`; absence makes page rendering fail per page. */
  image(): PdfImageEncoder | null;
  storeBlob: PdfPreviewStoreBlob;
  /** L18 `DocumentParser::check_pdf_encryption_bytes`; Rust pdf_preview checks here too. */
  checkEncryption?(bytes: Uint8Array, name: string): void;
}

/**
 * Async port of `pdf_preview.rs::render_pdf_preview`. Rust is synchronous
 * because pdfium-render is native; Host resolves F7 `nativePdfium`/`nativeImage`.
 * Rendering failures stay non-fatal: text-only result with `page_count=0`,
 * exactly like Rust's `match render_pdf_pages { Err => (None, 0) }`.
 */
export interface PdfPreviewRenderer {
  render(conn: SqlExecutor, blobsDir: string, pdfBytes: Uint8Array,
    config: PdfPreviewConfig): Promise<PdfPreviewResult>;
}

function pdfMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 5
    && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

/**
 * Rust `.trim_matches(|c| c != PDF_PAGE_SEPARATOR && c.is_whitespace())`.
 * `char::is_whitespace` is Unicode White_Space: unlike JS `\s` it includes U+0085
 * and excludes U+FEFF. All White_Space code points are BMP, so UTF-16 indexing is safe.
 */
function trimPreservingFormFeed(text: string): string {
  const isTrimmable = (char: string): boolean => char !== '\f' && /\p{White_Space}/u.test(char);
  let start = 0;
  let end = text.length;
  while (start < end && isTrimmable(text[start]!)) start += 1;
  while (end > start && isTrimmable(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

async function extractPdfText(bytes: Uint8Array, deps: PdfPreviewDependencies): Promise<string | null> {
  const pdfium = deps.pdfium();
  if (pdfium === null) {
    logWarn('[PDF-Preview] Failed to load pdfium for text extraction: nativePdfium is not available');
    return null;
  }
  try {
    const text = trimPreservingFormFeed(await pdfium.extractText(bytes));
    if (text === '') {
      logDebug('[PDF-Preview] Extracted empty text from PDF');
      return null;
    }
    // Rust `String::len()` counts UTF-8 bytes despite the "chars" wording.
    logDebug(`[PDF-Preview] Extracted ${utf8ByteLength(text)} chars from PDF`);
    return text;
  } catch (error) {
    logWarn('[PDF-Preview] Failed to extract text:', error);
    return null;
  }
}

/** `PdfRenderConfig::set_target_width(1200).set_maximum_height(1600)`. */
function fitPage(pageWidth: number, pageHeight: number, config: PdfPreviewConfig): { width: number; height: number } {
  if (pageWidth <= 0 || pageHeight <= 0) {
    return { width: config.targetWidth, height: config.maxHeight };
  }
  let width = config.targetWidth;
  let height = Math.round((pageHeight / pageWidth) * width);
  if (height > config.maxHeight) {
    height = config.maxHeight;
    width = Math.round((pageWidth / pageHeight) * height);
  }
  return { width, height };
}

async function renderSinglePage(
  conn: SqlExecutor,
  blobsDir: string,
  document: Awaited<ReturnType<NativePdfium['open']>>,
  pageIndex: number,
  config: PdfPreviewConfig,
  deps: PdfPreviewDependencies,
): Promise<PdfPagePreview> {
  const page = await document.page(pageIndex);
  const { width, height } = fitPage(page.width, page.height, config);
  const rendered = await page.render({ width, height, annotations: false });
  const encoder = deps.image();
  if (encoder === null) {
    throw new Error('image encoder (F7 NativeImage.encode) is not available');
  }
  const imageBytes = await encoder.encode(
    { width: rendered.width, height: rendered.height, rgba: rendered.rgba },
    config.compressionEnabled
      ? { format: 'jpeg', quality: config.jpegQuality }
      : { format: 'png' },
  );
  const mimeType = config.compressionEnabled ? 'image/jpeg' : 'image/png';
  const extension = config.compressionEnabled ? 'jpg' : 'png';
  const blob = deps.storeBlob(conn, blobsDir, imageBytes, mimeType, extension);
  logDebug(`[PDF-Preview] Page ${pageIndex} rendered: ${rendered.width}x${rendered.height}, `
    + `size=${imageBytes.length} bytes, format=${mimeType}, hash=${blob.hash.slice(0, 16)}`);
  return {
    pageIndex,
    blobHash: blob.hash,
    width: rendered.width,
    height: rendered.height,
    mimeType,
  };
}

async function renderPdfPages(
  conn: SqlExecutor,
  blobsDir: string,
  pdfBytes: Uint8Array,
  config: PdfPreviewConfig,
  deps: PdfPreviewDependencies,
  progress?: (currentPage: number, totalPages: number) => void,
): Promise<{ preview: PdfPreviewJson; totalPages: number }> {
  const pdfium = deps.pdfium();
  if (pdfium === null) throw new Error('PDF 功能不可用：未找到 pdfium 库');
  const document = await pdfium.open(pdfBytes, null);
  try {
    const totalPages = document.pageCount;
    // Rust clamps to `config.max_pages` and `u16::MAX` (audit M5).
    const renderPages = Math.min(totalPages, config.maxPages, 0xffff);
    logInfo(`[PDF-Preview] Rendering PDF: ${totalPages} pages (max: ${config.maxPages})`);

    const pages: PdfPagePreview[] = [];
    for (let pageIndex = 0; pageIndex < renderPages; pageIndex += 1) {
      progress?.(pageIndex + 1, renderPages);
      try {
        pages.push(await renderSinglePage(conn, blobsDir, document, pageIndex, config, deps));
      } catch (error) {
        logWarn(`[PDF-Preview] Failed to render page ${pageIndex}:`, error);
      }
    }
    if (pages.length === 0 && renderPages > 0) {
      throw new Error(`PDF 预渲染失败：${renderPages} 页全部渲染失败`);
    }

    const isTruncated = totalPages > config.maxPages;
    if (isTruncated) {
      logWarn(`[PDF-Preview] PDF truncated: total ${totalPages} pages, only rendered first ${config.maxPages} pages`);
    }
    const preview: PdfPreviewJson = {
      pages,
      renderDpi: config.renderDpi,
      totalPages,
      renderedAt: utcNow(),
      isTruncated,
      maxRenderedPages: config.maxPages,
    };
    logInfo(`[PDF-Preview] Rendered ${pages.length} pages successfully (truncated: ${isTruncated})`);
    return { preview, totalPages };
  } finally {
    await document.close();
  }
}

/**
 * Rust `render_pdf_preview_with_progress`: header check, encrypted check,
 * text extraction, then page rendering; render errors degrade to text-only.
 */
export async function renderPdfPreview(
  conn: SqlExecutor,
  blobsDir: string,
  pdfBytes: Uint8Array,
  config: PdfPreviewConfig,
  deps: PdfPreviewDependencies,
  progress?: (currentPage: number, totalPages: number) => void,
): Promise<PdfPreviewResult> {
  if (!pdfMagic(pdfBytes)) {
    throw new Error('不是有效的 PDF 文档（缺少 PDF 文件头）');
  }
  if (deps.checkEncryption !== undefined) {
    try { deps.checkEncryption(pdfBytes, 'document.pdf'); }
    catch (error) {
      logWarn('[PDF-Preview] Encrypted PDF, skipping render:', error);
      return { previewJson: null, extractedText: null, pageCount: 0 };
    }
  }

  const extractedText = await extractPdfText(pdfBytes, deps);
  let previewJson: PdfPreviewJson | null = null;
  let pageCount = 0;
  try {
    const rendered = await renderPdfPages(conn, blobsDir, pdfBytes, config, deps, progress);
    previewJson = rendered.preview;
    pageCount = rendered.totalPages;
  } catch (error) {
    logWarn('[PDF-Preview] Pdfium render failed, text-only mode:', error);
  }
  return { previewJson, extractedText, pageCount };
}
