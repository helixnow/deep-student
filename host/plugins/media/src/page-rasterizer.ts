/**
 * `dstu-vision/src/page_rasterizer.rs` — Stage 1 of the question-import pipeline:
 * PDF pages are rendered at 300 DPI (target width 8.5in, max height 14in), JPEG
 * encoded and stored as VFS blobs page by page; images are stored as-is after a
 * header-only dimension probe.
 *
 * Native work goes through F7 (`nativePdfium.open/render/text`, `nativeImage.encode`,
 * `nativeImage.dimensions`); blobs go through the L11 `BlobRepository.storeBlob`.
 * Errors are `CommandError(AppError)` with the Rust messages.
 */
import { CommandError } from '../../../kernel/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { rustTrim, rustTrimStart, utf8ByteLength } from '../../../platform/util/portable.ts';
import { JsonReader } from '../../../platform/util/json-exact.ts';
import type { NativeImage } from '../../../platform/native/image/api.ts';
import type { NativePdfium, PdfiumDocument } from '../../../platform/native/pdfium/api.ts';
import type { PageSlice, RasterizerResult } from '../api.ts';
import { Base64DecodeError, decodeBase64Standard } from './base64.ts';
import { DocumentParser } from './document-parser.ts';

export const RENDER_DPI = 300;
export const PAGE_WIDTH_INCHES = 8.5;
export const PAGE_HEIGHT_INCHES = 14;
export const MAX_DOCUMENT_SIZE = 200 * 1024 * 1024;
/** `image::codecs::jpeg::JpegEncoder::new` default quality (ImageFormat::Jpeg). */
export const DEFAULT_JPEG_QUALITY = 75;
const MAX_IMAGE_PIXELS = 120_000_000;

export interface PageRasterizerDeps {
  pdfium(): NativePdfium;
  image(): NativeImage;
  /** `VfsBlobRepo::store_blob(vfs_db, bytes, mime, ext)` → blob hash. */
  storeBlob(bytes: Uint8Array, mime: string, extension: string): string;
  log: { info(message: string): void; debug(message: string): void };
}

const fail = (error: ReturnType<typeof AppError.validation>): never => { throw new CommandError(error); };
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function checkFileSize(size: number): void {
  if (size > MAX_DOCUMENT_SIZE) {
    fail(AppError.validation(
      `文件大小 ${Math.trunc(size / (1024 * 1024))}MB 超过限制 ${Math.trunc(MAX_DOCUMENT_SIZE / (1024 * 1024))}MB`));
  }
}

/** `decode_base64`: Data URL → `split(',').nth(1)`, then STANDARD decode. */
export function decodeRasterizerBase64(content: string): Uint8Array {
  let raw = content;
  if (content.startsWith('data:')) {
    const second = content.split(',')[1];
    if (second === undefined) return fail(AppError.validation('Data URL 格式错误：缺少 base64 内容'));
    raw = second;
  }
  try { return decodeBase64Standard(raw); }
  catch (error) {
    if (error instanceof Base64DecodeError) return fail(AppError.validation(`Base64 解码失败: ${error.message}`));
    throw error;
  }
}

const latin1 = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

/** `detect_image_format`. */
export function detectImageFormat(data: Uint8Array): [string, string] {
  const startsWith = (sig: number[]): boolean => sig.every((byte, i) => data[i] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return ['image/png', 'png'];
  if (startsWith([0xff, 0xd8, 0xff])) return ['image/jpeg', 'jpg'];
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && data.length > 12
    && latin1(data.subarray(8, 12)) === 'WEBP') return ['image/webp', 'webp'];
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return ['image/gif', 'gif'];
  if (startsWith([0x42, 0x4d])) return ['image/bmp', 'bmp'];
  if (data.length >= 12 && latin1(data.subarray(4, 8)) === 'ftyp') return ['image/heic', 'heic'];
  return ['image/png', 'png'];
}

/**
 * pdfium-render 0.9.4 `PdfRenderConfig::apply_to_page` with
 * `set_target_width(2550).set_maximum_height(4200)`: f32 scales, aspect kept,
 * output sizes rounded.
 */
export function renderSize(pageWidth: number, pageHeight: number): { width: number; height: number } {
  const f = Math.fround;
  const targetWidth = f(RENDER_DPI * PAGE_WIDTH_INCHES);
  const maximumHeight = f(RENDER_DPI * PAGE_HEIGHT_INCHES);
  const pw = f(pageWidth);
  const ph = f(pageHeight);
  let scale = f(Math.trunc(targetWidth) / pw);
  if (f(ph * scale) > Math.trunc(maximumHeight)) scale = f(Math.trunc(maximumHeight) / ph);
  return { width: Math.round(f(pw * scale)), height: Math.round(f(ph * scale)) };
}

function safePageIndex(index: number): number {
  if (index > 0xffff) fail(AppError.validation(`页面索引 ${index} 超出 pdfium 支持的最大值 65535`));
  return index;
}

/** `render_and_store_pdf_pages`. */
async function renderAndStorePdfPages(
  pdfBytes: Uint8Array,
  sourceFormat: string,
  deps: PageRasterizerDeps,
  signal: AbortSignal | null,
): Promise<RasterizerResult> {
  let pdfium: NativePdfium;
  try { pdfium = deps.pdfium(); }
  catch (error) { return fail(AppError.internal(`加载 pdfium 失败: ${messageOf(error)}`)); }
  let document: PdfiumDocument;
  try { document = await pdfium.open(pdfBytes); }
  catch (error) { return fail(AppError.validation(`PDF 加载失败: ${messageOf(error)}`)); }
  try {
    const totalPages = document.pageCount;
    if (totalPages === 0) fail(AppError.validation('PDF 中没有页面'));
    deps.log.info(`[PageRasterizer] PDF 共 ${totalPages} 页，开始 ${RENDER_DPI}DPI 渲染（边渲染边入库）`);
    const pages: PageSlice[] = [];
    for (let pageIdx = 0; pageIdx < totalPages; pageIdx += 1) {
      if (signal?.aborted === true) fail(AppError.validation('题目来源渲染已取消'));
      let page;
      try { page = await document.page(safePageIndex(pageIdx)); }
      catch (error) {
        if (error instanceof CommandError) throw error;
        return fail(AppError.internal(`获取页面 ${pageIdx + 1} 失败: ${messageOf(error)}`));
      }
      let textHint: string | null = null;
      try {
        const text = rustTrim(await page.text());
        textHint = text === '' ? null : text;
      } catch { textHint = null; }

      const size = renderSize(page.width, page.height);
      let bitmap: { width: number; height: number; rgba: Uint8Array };
      try { bitmap = await page.render({ width: size.width, height: size.height, annotations: true }); }
      catch (error) { return fail(AppError.internal(`渲染页面 ${pageIdx + 1} 失败: ${messageOf(error)}`)); }
      const { width, height } = bitmap;

      let jpegBytes: Uint8Array;
      try {
        jpegBytes = await deps.image().encode(bitmap, { format: 'jpeg', quality: DEFAULT_JPEG_QUALITY });
      } catch (error) { return fail(AppError.internal(`编码页面 ${pageIdx + 1} JPEG 失败: ${messageOf(error)}`)); }

      let blobHash: string;
      try { blobHash = deps.storeBlob(jpegBytes, 'image/jpeg', 'jpg'); }
      catch (error) { return fail(AppError.database(`页面 ${pageIdx + 1} Blob 存储失败: ${messageOf(error)}`)); }

      deps.log.debug(`[PageRasterizer] 页面 ${pageIdx + 1}/${totalPages}: ${width}x${height}, `
        + `text_hint=${textHint === null ? 0 : utf8ByteLength(textHint)} chars, `
        + `blob=${blobHash.slice(0, Math.min(blobHash.length, 12))}`);
      pages.push({ page_index: pageIdx, blob_hash: blobHash, text_hint: textHint, width, height });
    }
    deps.log.info(`[PageRasterizer] 渲染完成: ${pages.length} 页, `
      + `${pages.filter(p => p.text_hint !== null).length} 页有 text_hint`);
    return { pages, source_format: sourceFormat };
  } finally {
    await document.close().catch(() => undefined);
  }
}

/** `rasterize_pdf_cancellable`. */
export async function rasterizePdfCancellable(
  base64Content: string,
  deps: PageRasterizerDeps,
  signal: AbortSignal | null = null,
): Promise<RasterizerResult> {
  const bytes = decodeRasterizerBase64(base64Content);
  checkFileSize(bytes.length);
  try { new DocumentParser().checkPdfEncryption(bytes, 'document.pdf'); }
  catch (error) { return fail(AppError.validation(messageOf(error))); }
  return renderAndStorePdfPages(bytes, 'pdf', deps, signal);
}

/** `serde_json::from_str::<Vec<String>>`, errors carrying serde's Display. */
function decodeStringList(content: string): string[] {
  const reader = new JsonReader(content);
  reader.beginArray();
  const items: string[] = [];
  while (reader.nextItem()) items.push(reader.readString());
  reader.end();
  return items;
}

/** `rasterize_images`: single Base64 / Data URL, or a JSON array of them. */
export async function rasterizeImages(content: string, deps: PageRasterizerDeps): Promise<RasterizerResult> {
  let base64Images: string[];
  if (rustTrimStart(content).startsWith('[')) {
    try { base64Images = decodeStringList(content); }
    catch (error) { return fail(AppError.validation(`解析图片列表失败: ${messageOf(error)}`)); }
  } else {
    base64Images = [content];
  }
  if (base64Images.length === 0) fail(AppError.validation('图片列表为空'));
  deps.log.info(`[PageRasterizer] 处理 ${base64Images.length} 张图片`);

  const pages: PageSlice[] = [];
  for (const [idx, b64] of base64Images.entries()) {
    const comma = b64.indexOf(',');
    const raw = comma >= 0 ? b64.slice(comma + 1) : b64;
    let bytes: Uint8Array;
    try { bytes = decodeBase64Standard(raw); }
    catch (error) {
      if (error instanceof Base64DecodeError) {
        return fail(AppError.validation(`图片 ${idx + 1} base64 解码失败: ${error.message}`));
      }
      throw error;
    }
    checkFileSize(bytes.length);

    let width = 0;
    let height = 0;
    try { ({ width, height } = await deps.image().dimensions(bytes)); }
    catch { width = 0; height = 0; }
    if (width === 0 || height === 0) {
      fail(AppError.validation(`来源图片 ${idx + 1} 无法读取尺寸，请先转换为 PNG/JPEG/WebP`));
    }
    if (width * height > MAX_IMAGE_PIXELS) {
      fail(AppError.validation(`来源图片 ${idx + 1} 超过图像解码安全限制，请缩小图片后重新导入`));
    }
    const [mime, ext] = detectImageFormat(bytes);
    let blobHash: string;
    try { blobHash = deps.storeBlob(bytes, mime, ext); }
    catch (error) { return fail(AppError.database(`图片 ${idx + 1} Blob 存储失败: ${messageOf(error)}`)); }
    pages.push({ page_index: idx, blob_hash: blobHash, text_hint: null, width, height });
  }
  deps.log.info(`[PageRasterizer] 图片处理完成: ${pages.length} 页`);
  return { pages, source_format: 'image' };
}
