/** 图片 / 文档 / PDF 解引用；文件内容读取归 vfsRepo，解析归 docs。 */
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import type { VfsReposService } from '../../../vfs-repos/api.ts';
import type { DocsService } from '../../../media/api.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import { fileExtractedTextRow, imageOcrTextRow, pdfFileRow } from '../../repository/vfs-resolver-repository.ts';
import { buildPdfMetaBlock, formatPdfPagesText, formatPdfTextWithPageMarkers,
  formatPdfPageText, parsePreviewJson, resolveMultimodalPages,
  MULTIMODAL_BUDGET_MAX_PAGES } from './pdf.ts';
import { debugLog, escapeXmlAttr, escapeXmlContent, imageBlock, inferMediaTypeFromName,
  parseOcrPagesJson, resolveImageInjectModes, resolvePdfInjectModes, textBlock,
  type ContentBlock, type VfsResolverLogger, type VfsResourceRef } from './model.ts';

export interface VfsResolverServices {
  vfsRepo: Pick<VfsReposService, 'files' | 'blobs'>;
  docs: Pick<DocsService, 'extractTextFromBase64'>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rust ignores metadata lookup errors when choosing image MIME, but logs content errors. */
function hasCompressedImage(db: SqlExecutor, blobsDir: string, sourceId: string,
  services: VfsResolverServices): boolean {
  try {
    const file = services.vfsRepo.files.getFile(db, sourceId);
    if (file?.compressedBlobHash == null || file.compressedBlobHash === file.blobHash) return false;
    return services.vfsRepo.blobs.getBlobPath(db, blobsDir, file.compressedBlobHash) !== null;
  } catch {
    return false;
  }
}

export function resolveImage(db: SqlExecutor, blobsDir: string, ref: VfsResourceRef,
  isMultimodal: boolean, logger: VfsResolverLogger, services: VfsResolverServices): ContentBlock[] {
  const [includeImage, includeOcr, downgraded] = resolveImageInjectModes(ref.injectModes?.image, isMultimodal);
  const blocks: ContentBlock[] = [];
  if (downgraded) {
    blocks.push(textBlock('<system_note>模型不支持图片输入，已自动降级为 OCR 文本注入。</system_note>'));
  }
  if (includeImage) {
    const compressed = hasCompressedImage(db, blobsDir, ref.sourceId, services);
    try {
      const content = services.vfsRepo.files.getContent(db, blobsDir, ref.sourceId);
      if (content !== null) {
        blocks.push(imageBlock(compressed ? 'image/jpeg' : inferMediaTypeFromName(ref.name), content));
      } else {
        logger.warn(`[VfsResolver] Image content not found: ${ref.sourceId}`);
      }
    } catch (error) {
      logger.warn(`[VfsResolver] Failed to get image ${ref.sourceId}: ${errorMessage(error)}`);
    }
  }
  if (includeOcr) {
    const ocr = imageOcrTextRow(db, ref.sourceId);
    if (ocr !== null && rustTrim(ocr) !== '') {
      blocks.push(textBlock(`<image_ocr name="${escapeXmlAttr(ref.name)}">${escapeXmlContent(ocr)}</image_ocr>`));
    }
  }
  if (blocks.length === 0) {
    logger.warn(`[VfsResolver] Image ${ref.sourceId} produced no content blocks (image=${includeImage}, ocr=${includeOcr})`);
    return [textBlock(`[图片加载失败: ${ref.name}]`)];
  }
  return blocks;
}

/** `resolve_file` / `resolve_pdf_fallback`: separate repository failures from parser failures. */
async function parseFileFallback(db: SqlExecutor, blobsDir: string, ref: VfsResourceRef,
  logger: VfsResolverLogger, services: VfsResolverServices, pdf: boolean): Promise<ContentBlock[]> {
  let content: string | null;
  const label = pdf ? 'PDF' : 'file';
  try {
    content = services.vfsRepo.files.getContent(db, blobsDir, ref.sourceId);
  } catch (error) {
    logger.warn(`[VfsResolver] Failed to get ${label} ${ref.sourceId}: ${errorMessage(error)}`);
    return [];
  }
  if (content === null) return [];
  try {
    const text = await services.docs.extractTextFromBase64(ref.name, content);
    return [textBlock(pdf
      ? `<pdf_text name="${escapeXmlAttr(ref.name)}">${formatPdfTextWithPageMarkers(ref, text)}</pdf_text>`
      : `<file name="${escapeXmlAttr(ref.name)}">${escapeXmlContent(text)}</file>`)];
  } catch (error) {
    logger.warn(`[VfsResolver] Failed to parse ${pdf ? 'PDF' : 'document'} ${ref.sourceId}: ${errorMessage(error)}`);
    return [textBlock(pdf ? formatPdfPageText(ref, 1, '[PDF 解析失败]') : `[文档解析失败: ${ref.name}]`)];
  }
}

export async function resolveFile(db: SqlExecutor, blobsDir: string, ref: VfsResourceRef,
  isMultimodal: boolean, logger: VfsResolverLogger, services: VfsResolverServices): Promise<ContentBlock[]> {
  if (ref.name.toLowerCase().endsWith('.pdf')) {
    return resolvePdf(db, blobsDir, ref, isMultimodal, logger, services);
  }
  const stored = fileExtractedTextRow(db, ref.sourceId);
  if (stored !== null && rustTrim(stored) !== '') {
    return [textBlock(`<file name="${escapeXmlAttr(ref.name)}">${escapeXmlContent(stored)}</file>`)];
  }
  return parseFileFallback(db, blobsDir, ref, logger, services, false);
}

export async function resolvePdf(db: SqlExecutor, blobsDir: string, ref: VfsResourceRef,
  isMultimodal: boolean, logger: VfsResolverLogger, services: VfsResolverServices): Promise<ContentBlock[]> {
  const [includeText, includeOcr, includeImage, downgraded] = resolvePdfInjectModes(ref.injectModes?.pdf, isMultimodal);
  const row = pdfFileRow(db, ref.sourceId);
  if (row === null) return parseFileFallback(db, blobsDir, ref, logger, services, true);
  const preview = parsePreviewJson(row.previewJson, logger, 'PDF');
  const totalPages = preview?.totalPages ?? (row.pageCount !== null && row.pageCount > 0 ? row.pageCount : null);
  const blocks: ContentBlock[] = [buildPdfMetaBlock(ref, totalPages)];
  if (downgraded) {
    blocks.push(textBlock('<system_note>模型不支持图片输入，已自动移除 PDF 页面图片，保留 OCR 与文本内容。</system_note>'));
  }
  let truncated = false;
  let contentAdded = false;
  if (includeImage && preview !== null) {
    const [images, wasTruncated] = resolveMultimodalPages(db, blobsDir, preview, ref, logger, 'PDF');
    if (images.length > 0) {
      blocks.push(...images);
      truncated = wasTruncated;
      contentAdded = true;
    }
  }
  if (includeOcr && row.ocrPagesJson !== null) {
    const text = formatPdfPagesText(ref, parseOcrPagesJson(row.ocrPagesJson));
    if (text !== null) {
      blocks.push(textBlock(`<pdf_ocr name="${escapeXmlAttr(ref.name)}">${text}</pdf_ocr>`));
      contentAdded = true;
    }
  }
  if (includeText) {
    const textBlocks = row.extractedText !== null && row.extractedText !== ''
      ? [textBlock(`<pdf_text name="${escapeXmlAttr(ref.name)}">${formatPdfTextWithPageMarkers(ref, row.extractedText)}</pdf_text>`)]
      : await parseFileFallback(db, blobsDir, ref, logger, services, true);
    blocks.push(...textBlocks);
    contentAdded ||= textBlocks.length > 0;
  }
  if (truncated) {
    blocks.push(textBlock(`<system_note>注意：PDF「${ref.name}」内容较大，已截断为前 ${MULTIMODAL_BUDGET_MAX_PAGES} 页以节省预算。如需完整内容，请使用文本检索模式。</system_note>`));
  }
  if (!contentAdded) logger.warn(`[VfsResolver] PDF ${ref.sourceId} selected modes produced no ready content`);
  debugLog(logger, `[VfsResolver] Resolved PDF ${ref.sourceId}: ${blocks.length} blocks`);
  return blocks;
}
