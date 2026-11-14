/** Port of dstu-vfs ocr_utils::parse_ocr_pages_json. */
import { logWarn } from './logger.ts';
import { utf8ByteLength } from '../../../platform/util/portable.ts';

export const OCR_FAILED_MARKER = '__OCR_FAILED__';

function cleanPage(text: string | null): string | null {
  if (text === null) return null;
  if (text === OCR_FAILED_MARKER || text.trim() === '') return null;
  return text;
}

function pageIndexValue(page: Record<string, unknown>): number | null {
  const raw = page.page_index ?? page.pageIndex;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/** Rust `parse_ocr_pages_json`: accepts string/null arrays, object pages, or returns []. */
export function parseOcrPagesJson(jsonStr: string): (string | null)[] {
  const trimmed = jsonStr.trim();
  if (trimmed === '') return [];

  let value: unknown;
  try { value = JSON.parse(trimmed); }
  catch (error) {
    logWarn('[OcrUtils] Failed to parse ocr_pages_json:', error);
    return [];
  }

  if (Array.isArray(value) && value.every(entry => entry === null || typeof entry === 'string')) {
    return (value as (string | null)[]).map(cleanPage);
  }

  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) {
    return (value as string[]).map(cleanPage);
  }

  if (value === null || typeof value !== 'object') {
    logWarn('[OcrUtils] ocr_pages_json has no pages array');
    return [];
  }
  const root = value as Record<string, unknown>;
  const pages = root.pages;
  if (!Array.isArray(pages)) {
    logWarn('[OcrUtils] ocr_pages_json has no pages array');
    return [];
  }

  const declaredTotal = typeof root.total_pages === 'number' && Number.isInteger(root.total_pages) && root.total_pages >= 0
    ? root.total_pages : null;
  let totalPages = declaredTotal;
  if (totalPages === null) {
    let maxIndex = -1;
    for (const entry of pages) {
      if (entry === null || typeof entry !== 'object') continue;
      const index = pageIndexValue(entry as Record<string, unknown>);
      if (index !== null && index > maxIndex) maxIndex = index;
    }
    totalPages = maxIndex >= 0 ? maxIndex + 1 : pages.length;
  }

  const result: (string | null)[] = Array.from({ length: Math.max(totalPages, pages.length) }, () => null);

  pages.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') return;
    const page = entry as Record<string, unknown>;
    const pageIndex = pageIndexValue(page) ?? index;

    let blockText: string | null = null;
    if (Array.isArray(page.blocks)) {
      const parts: string[] = [];
      for (const block of page.blocks) {
        if (block === null || typeof block !== 'object') continue;
        const text = (block as Record<string, unknown>).text;
        if (typeof text !== 'string') continue;
        const part = text.trim();
        if (part !== '') parts.push(part);
      }
      if (parts.length > 0) blockText = parts.join('\n');
    }

    const textField = typeof page.text === 'string' && page.text.trim() !== ''
      ? page.text.trim() : null;

    let pageText: string | null;
    if (blockText !== null && textField !== null) {
      pageText = utf8ByteLength(blockText) >= utf8ByteLength(textField)
        ? blockText : textField;
    } else {
      pageText = blockText ?? textField;
    }

    while (result.length <= pageIndex) result.push(null);
    result[pageIndex] = pageText;
  });

  return result.map(cleanPage);
}

/** Rust `Vec<Option<String>>` serialization used by save_page_ocr. */
export function serializeOcrPages(pages: readonly (string | null)[]): string {
  return JSON.stringify(pages);
}
