/**
 * PDF/教材文本格式化与多模态页面读取：移植 `chat_v2/vfs_resolver.rs`。
 */
import * as fs from 'node:fs';
import path from 'node:path';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import { blobRow, textbookFileRow } from '../../repository/vfs-resolver-repository.ts';
import { rustTrim } from '../../../../platform/util/index.ts';
import {
  escapeXmlAttr, escapeXmlContent, parseOcrPagesJson, resolvePdfInjectModes,
  silentVfsResolverLogger, textBlock,
  type ContentBlock, type VfsResolverLogger, type VfsResourceRef,
} from './model.ts';

// ------------------------------------------------------------------ PDF 文本格式

export function buildPdfRefTag(sourceId: string, pageNumber: number): string {
  return `[PDF@${sourceId}:${pageNumber}]`;
}

export function buildPdfPageLabel(vfsRef: VfsResourceRef, pageNumber: number): string {
  return `${buildPdfRefTag(vfsRef.sourceId, pageNumber)} ${escapeXmlContent(vfsRef.name)} 第${pageNumber}页`;
}

export function buildPdfPageLabelBlock(vfsRef: VfsResourceRef, pageNumber: number): ContentBlock {
  const label = buildPdfPageLabel(vfsRef, pageNumber);
  return textBlock(
    `<pdf_page name="${escapeXmlAttr(vfsRef.name)}" source_id="${escapeXmlAttr(vfsRef.sourceId)}" page="${pageNumber}">${label}</pdf_page>`,
  );
}

export function formatPdfPageText(vfsRef: VfsResourceRef, pageNumber: number, pageText: string): string {
  const label = buildPdfPageLabel(vfsRef, pageNumber);
  return `<pdf_page name="${escapeXmlAttr(vfsRef.name)}" source_id="${escapeXmlAttr(vfsRef.sourceId)}" page="${pageNumber}">${label}\n${escapeXmlContent(rustTrim(pageText))}</pdf_page>`;
}

export function formatPdfPagesText(vfsRef: VfsResourceRef, pages: readonly (string | null)[]): string | null {
  let result = '';
  pages.forEach((pageText, index) => {
    if (pageText === null) return;
    const trimmed = rustTrim(pageText);
    if (trimmed === '') return;
    if (result !== '') result += '\n\n';
    result += formatPdfPageText(vfsRef, index + 1, trimmed);
  });
  return result === '' ? null : result;
}

export function splitPdfTextByPage(text: string): string[] {
  const parts = text.split('\u000c').map(part => rustTrim(part)).filter(part => part !== '');
  return parts.length === 0 ? [rustTrim(text)] : parts;
}

export function formatPdfTextWithPageMarkers(vfsRef: VfsResourceRef, text: string): string {
  const pages = splitPdfTextByPage(text);
  let result = '';
  pages.forEach((pageText, index) => {
    if (rustTrim(pageText) === '') return;
    if (result !== '') result += '\n\n';
    result += formatPdfPageText(vfsRef, index + 1, pageText);
  });
  return result;
}

export function buildPdfMetaBlock(vfsRef: VfsResourceRef, totalPages: number | null): ContentBlock {
  const totalHint = totalPages === null ? '' : ` total_pages="${totalPages}"`;
  const exampleTag1 = buildPdfRefTag(vfsRef.sourceId, 1);
  const exampleTag2 = buildPdfRefTag(vfsRef.sourceId, 2);
  return textBlock(
    `<pdf_meta name="${escapeXmlAttr(vfsRef.name)}" source_id="${escapeXmlAttr(vfsRef.sourceId)}"${totalHint}>` +
    `引用该 PDF 请使用格式：${exampleTag1}（每页单独引用）。引用多页时逐页标注，如 ${exampleTag1}${exampleTag2}。` +
    '禁止合并为范围格式。输出时必须包含页码。</pdf_meta>',
  );
}

// ------------------------------------------------------------------ 多模态页面

export interface PdfPagePreview {
  pageIndex: number;
  blobHash: string;
  width: number;
  height: number;
  mimeType: string;
  compressedBlobHash?: string | null;
}

export interface PdfPreviewJson {
  pages: PdfPagePreview[];
  renderDpi?: number;
  totalPages: number;
  renderedAt?: string;
  isTruncated?: boolean;
  maxRenderedPages?: number;
}

export const MULTIMODAL_BUDGET_MAX_PAGES = 100;
export const MULTIMODAL_BUDGET_MAX_BYTES = 50 * 1024 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parsePreviewJson(
  raw: string | null,
  logger: VfsResolverLogger,
  label: string,
): PdfPreviewJson | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as PdfPreviewJson;
    // PdfPreviewJson / PdfPagePreview serde requires these fields; malformed legacy
    // previews fall back to text rather than producing undefined page references.
    const uint = (value: unknown, max = Number.MAX_VALUE): boolean =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
    if (!parsed || !Array.isArray(parsed.pages) || !uint(parsed.totalPages)
      || !uint(parsed.renderDpi, 0xffff_ffff) || typeof parsed.renderedAt !== 'string') return null;
    if (parsed.isTruncated !== undefined && typeof parsed.isTruncated !== 'boolean') return null;
    if (parsed.maxRenderedPages !== undefined && !uint(parsed.maxRenderedPages)) return null;
    if (!parsed.pages.every(page => page !== null && typeof page === 'object'
      && uint(page.pageIndex) && uint(page.width, 0xffff_ffff) && uint(page.height, 0xffff_ffff)
      && typeof page.blobHash === 'string' && typeof page.mimeType === 'string'
      && (page.compressedBlobHash == null || typeof page.compressedBlobHash === 'string'))) return null;
    return parsed;
  } catch (error) {
    logger.warn(`[VfsResolver] Failed to parse ${label} preview_json: ${errorMessage(error)}`);
    return null;
  }
}

function readBlobBytes(
  db: SqlExecutor,
  blobsDir: string,
  hash: string,
  logger: VfsResolverLogger,
  notFoundMessage: string,
  readLabel: string,
): Buffer | null {
  const blob = blobRow(db, hash);
  if (!blob) {
    logger.warn(`[VfsResolver] ${notFoundMessage}: ${hash}`);
    return null;
  }
  try {
    return fs.readFileSync(path.join(blobsDir, blob.relativePath));
  } catch (error) {
    logger.warn(`[VfsResolver] Failed to read ${readLabel}: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * `resolve_pdf_multimodal` / `resolve_textbook_multimodal` 的共同实现。
 * 优先压缩版本；页数/字节预算与 Rust 一致。
 */
export function resolveMultimodalPages(
  db: SqlExecutor,
  blobsDir: string,
  preview: PdfPreviewJson,
  vfsRef: VfsResourceRef,
  logger: VfsResolverLogger,
  label: 'PDF' | 'textbook',
): [ContentBlock[], boolean] {
  const blocks: ContentBlock[] = [];
  let totalBytes = 0;
  let truncated = false;
  for (const page of preview.pages.slice(0, MULTIMODAL_BUDGET_MAX_PAGES)) {
    if (totalBytes >= MULTIMODAL_BUDGET_MAX_BYTES) {
      truncated = true;
      logger.info(`[VfsResolver] ${label} ${vfsRef.sourceId} truncated: byte budget exceeded at page ${blocks.length}`);
      break;
    }
    let selected: { content: Buffer; compressed: boolean } | null = null;
    if (page.compressedBlobHash != null && page.compressedBlobHash !== page.blobHash) {
      const content = readBlobBytes(
        db, blobsDir, page.compressedBlobHash, logger,
        `${label} compressed blob not found`, `${label} compressed blob`,
      );
      if (content !== null) selected = { content, compressed: true };
    }
    if (selected === null) {
      const content = readBlobBytes(
        db, blobsDir, page.blobHash, logger,
        `${label} blob not found`, `${label} blob`,
      );
      if (content !== null) selected = { content, compressed: false };
    }
    if (selected !== null) {
      const base64Content = selected.content.toString('base64');
      if (totalBytes + base64Content.length > MULTIMODAL_BUDGET_MAX_BYTES) {
        truncated = true;
        if (blocks.length === 0) {
          logger.warn(`[VfsResolver] ${label} ${vfsRef.sourceId} first page exceeds budget, fallback to text`);
        } else if (label === 'PDF') {
          logger.info(`[VfsResolver] PDF ${vfsRef.sourceId} truncated at page ${page.pageIndex}: budget exceeded`);
        }
        break;
      }
      totalBytes += base64Content.length;
      blocks.push(buildPdfPageLabelBlock(vfsRef, page.pageIndex + 1));
      blocks.push({ type: 'image', mediaType: selected.compressed ? 'image/jpeg' : page.mimeType, base64: base64Content });
    }
  }
  if (preview.pages.length > MULTIMODAL_BUDGET_MAX_PAGES) truncated = true;
  return [blocks, truncated];
}

// ------------------------------------------------------------------ 教材

/** `get_textbook_text_blocks`：OCR 仅在显式选择时注入，native text 独立开关。 */
export function getTextbookTextBlocks(
  ocrPagesJson: string | null | undefined,
  extractedText: string | null | undefined,
  vfsRef: VfsResourceRef,
  includeOcr: boolean,
  includeExtractedText: boolean,
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (includeOcr && ocrPagesJson != null && rustTrim(ocrPagesJson) !== '') {
    const pages = parseOcrPagesJson(ocrPagesJson);
    const result = formatPdfPagesText(vfsRef, pages);
    if (result !== null) {
      blocks.push(textBlock(
        `<textbook_ocr title="${escapeXmlAttr(vfsRef.name)}">${result}</textbook_ocr>`,
      ));
    }
  }
  if (includeExtractedText && extractedText != null && rustTrim(extractedText) !== '') {
    const formatted = formatPdfTextWithPageMarkers(vfsRef, extractedText);
    blocks.push(textBlock(
      `<textbook title="${escapeXmlAttr(vfsRef.name)}">${formatted}</textbook>`,
    ));
  }
  return blocks;
}

/** `resolve_textbook`：优先多模态页面图，否则 native text / OCR / 文件名兜底。 */
export function resolveTextbook(
  db: SqlExecutor,
  blobsDir: string,
  vfsRef: VfsResourceRef,
  isMultimodal: boolean,
  logger: VfsResolverLogger = silentVfsResolverLogger,
): ContentBlock[] {
  const pdfModes = vfsRef.injectModes?.pdf ?? null;
  const [includeText, includeOcr, includeImage] = resolvePdfInjectModes(pdfModes, isMultimodal);
  const row = textbookFileRow(db, vfsRef.sourceId);
  if (row === null) return [textBlock(`[教材未找到: ${vfsRef.name}]`)];

  const fileName = row.fileName ?? vfsRef.name;
  const preview = parsePreviewJson(row.previewJson, logger, 'textbook');
  const metaBlock = buildPdfMetaBlock(vfsRef, preview === null ? null : preview.totalPages);

  if (includeImage && preview !== null) {
    const [blocks, truncated] = resolveMultimodalPages(db, blobsDir, preview, vfsRef, logger, 'textbook');
    if (blocks.length > 0) {
      const result: ContentBlock[] = [metaBlock, ...blocks];
      const textBlocks = getTextbookTextBlocks(
        row.ocrPagesJson, row.extractedText, vfsRef, includeOcr, includeText,
      );
      if (textBlocks.length > 0) result.push(...textBlocks);
      if (truncated) {
        result.push(textBlock(
          `<system_note>注意：教材「${vfsRef.name}」内容较大，已截断为前 ${MULTIMODAL_BUDGET_MAX_PAGES} 页以节省预算。如需完整内容，请使用文本检索模式。</system_note>`,
        ));
      }
      return result;
    }
  }

  const textBlocks = getTextbookTextBlocks(
    row.ocrPagesJson, row.extractedText, vfsRef, includeOcr, includeText,
  );
  if (textBlocks.length > 0) return [metaBlock, ...textBlocks];

  return [
    metaBlock,
    textBlock(
      `<textbook title="${escapeXmlAttr(vfsRef.name)}">[PDF: ${escapeXmlContent(fileName)}，暂无文本内容]</textbook>`,
    ),
  ];
}
