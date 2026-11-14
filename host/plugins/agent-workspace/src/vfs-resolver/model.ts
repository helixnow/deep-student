/**
 * VFS 解引用公共类型与纯函数：移植 `chat_v2/vfs_resolver.rs` 的模型层。
 */
import { rustTrim } from '../../../../platform/util/portable.ts';

export type ImageInjectMode = 'image' | 'ocr';
export type PdfInjectMode = 'text' | 'ocr' | 'image';

/** `ResourceInjectModes`（camelCase，Option 缺省）。 */
export interface ResourceInjectModes {
  image?: ImageInjectMode[] | null;
  pdf?: PdfInjectMode[] | null;
}

/** Rust `log::warn!`/`log::debug!` 的出口；生产注入插件 logger。 */
export interface VfsResolverLogger {
  warn(message: string): void;
  info(message: string): void;
  debug?(message: string): void;
}

export const silentVfsResolverLogger: VfsResolverLogger = {
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

export function debugLog(logger: VfsResolverLogger, message: string): void {
  if (logger.debug) logger.debug(message);
}

export type VfsResourceType =
  | 'note' | 'textbook' | 'exam' | 'translation' | 'essay' | 'image'
  | 'file' | 'retrieval' | 'mindmap' | 'insightcard';

/** `VfsResourceRef`（camelCase；`type` 对应 Rust 的 `resource_type`）。 */
export interface VfsResourceRef {
  sourceId: string;
  resourceHash: string;
  type: VfsResourceType;
  name: string;
  resourceId?: string | null;
  snippet?: string | null;
  injectModes?: ResourceInjectModes | null;
}

export interface VfsContextRefData {
  refs: VfsResourceRef[];
  truncated?: boolean;
  totalCount?: number;
}

/** `ContentBlock`（serde tag = type，rename_all = lowercase）。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; base64: string };

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

export function imageBlock(mediaType: string, base64: string): ContentBlock {
  return { type: 'image', mediaType, base64 };
}

/** `ResolvedContent`：历史消息加载场景的文本/图片分离结构。 */
export class ResolvedContent {
  textContents: string[] = [];
  imageBase64List: string[] = [];

  static new(): ResolvedContent {
    return new ResolvedContent();
  }

  get text_contents(): string[] {
    return this.textContents;
  }

  get image_base64_list(): string[] {
    return this.imageBase64List;
  }

  isEmpty(): boolean {
    return this.textContents.length === 0 && this.imageBase64List.length === 0;
  }

  addText(text: string): void {
    if (text.length > 0) this.textContents.push(text);
  }

  addImage(base64: string): void {
    if (base64.length > 0) this.imageBase64List.push(base64);
  }

  merge(other: ResolvedContent): void {
    this.textContents.push(...other.textContents);
    this.imageBase64List.push(...other.imageBase64List);
  }

  toFormattedText(originalContent: string): string {
    if (this.textContents.length === 0) return originalContent;
    return `${this.textContents.join('\n\n')}\n\n---\n\n${originalContent}`;
  }
}

/** `blocks_to_content`：文本包装为 `<injected_context>`，图片只保留 base64。 */
export function blocksToContent(blocks: readonly ContentBlock[], name: string): ResolvedContent {
  const result = new ResolvedContent();
  for (const block of blocks) {
    if (block.type === 'text') {
      result.addText(`<injected_context>\n[${name}]\n${block.text}\n</injected_context>`);
    } else {
      result.addImage(block.base64);
    }
  }
  return result;
}

/** `escape_xml_attr`：& " ' < >。 */
export function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** `escape_xml_content`（dstu-core `text_escape`）：& < >。 */
export function escapeXmlContent(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** `infer_media_type_from_name`。 */
export function inferMediaTypeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}

/** `resolve_image_inject_modes` → [includeImage, includeOcr, downgraded]。 */
export function resolveImageInjectModes(
  imageModes: readonly ImageInjectMode[] | null | undefined,
  isMultimodal: boolean,
): [boolean, boolean, boolean] {
  let includeImage: boolean;
  let includeOcr: boolean;
  if (imageModes != null && imageModes.length > 0) {
    includeImage = imageModes.includes('image');
    includeOcr = imageModes.includes('ocr');
  } else {
    includeImage = true;
    includeOcr = false;
  }
  let downgraded = false;
  if (includeImage && !isMultimodal) {
    includeImage = false;
    includeOcr = true;
    downgraded = true;
  }
  return [includeImage, includeOcr, downgraded];
}

/** `resolve_pdf_inject_modes` → [includeText, includeOcr, includeImage, downgraded]。 */
export function resolvePdfInjectModes(
  pdfModes: readonly PdfInjectMode[] | null | undefined,
  isMultimodal: boolean,
): [boolean, boolean, boolean, boolean] {
  let includeText: boolean;
  let includeOcr: boolean;
  let includeImage: boolean;
  if (pdfModes != null) {
    includeText = pdfModes.includes('text');
    includeOcr = pdfModes.includes('ocr');
    includeImage = pdfModes.includes('image');
  } else {
    includeText = true;
    includeOcr = false;
    includeImage = false;
  }
  let downgraded = false;
  if (includeImage && !isMultimodal) {
    includeImage = false;
    includeOcr = true;
    downgraded = true;
  }
  return [includeText, includeOcr, includeImage, downgraded];
}

export const OCR_FAILED_MARKER = '__OCR_FAILED__';

/** `parse_ocr_pages_json`：兼容三种 OCR JSON 形态。 */
export function parseOcrPagesJson(jsonText: string): (string | null)[] {
  const trimmed = rustTrim(jsonText);
  if (trimmed === '') return [];
  const clean = (value: string | null | undefined): string | null => {
    if (value == null) return null;
    if (value === OCR_FAILED_MARKER || rustTrim(value) === '') return null;
    return value;
  };

  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch (error) { return []; }

  if (Array.isArray(parsed)) {
    if (parsed.every(item => item === null || typeof item === 'string')) {
      return parsed.map(item => clean(item as string | null));
    }
    if (parsed.every(item => typeof item === 'string')) {
      return parsed.map(item => {
        const value = item as string;
        return rustTrim(value) === '' || value === OCR_FAILED_MARKER ? null : value;
      });
    }
  }

  if (typeof parsed !== 'object' || parsed === null) return [];
  const value = parsed as Record<string, unknown>;
  const pagesValue = value.pages;
  if (!Array.isArray(pagesValue)) return [];
  const pages = pagesValue as Record<string, unknown>[];

  const numeric = (input: unknown): number | null =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? Math.trunc(input) : null;

  let totalPages = numeric(value.total_pages) ?? numeric(value.totalPages);
  if (totalPages === null) {
    let maxIndex: number | null = null;
    for (const page of pages) {
      const index = numeric(page.page_index) ?? numeric(page.pageIndex);
      if (index !== null) maxIndex = maxIndex === null ? index : Math.max(maxIndex, index);
    }
    totalPages = maxIndex === null ? pages.length : maxIndex + 1;
  }
  const size = Math.max(totalPages, pages.length);
  const result: (string | null)[] = new Array(size).fill(null);

  pages.forEach((page, index) => {
    const pageIndex = numeric(page.page_index) ?? numeric(page.pageIndex) ?? index;
    let blockText: string | null = null;
    const rawBlocks = page.blocks;
    if (Array.isArray(rawBlocks)) {
      const parts: string[] = [];
      for (const block of rawBlocks as Record<string, unknown>[]) {
        if (typeof block.text === 'string') {
          const text = rustTrim(block.text);
          if (text !== '') parts.push(text);
        }
      }
      blockText = parts.length === 0 ? null : parts.join('\n');
    }
    const rawText = typeof page.text === 'string' ? rustTrim(page.text) : '';
    const textField = rawText === '' ? null : rawText;
    let pageText: string | null;
    if (blockText !== null && textField !== null) {
      pageText = blockText.length >= textField.length ? blockText : textField;
    } else {
      pageText = blockText ?? textField;
    }
    while (pageIndex >= result.length) result.push(null);
    result[pageIndex] = pageText;
  });

  return result.map(clean);
}
