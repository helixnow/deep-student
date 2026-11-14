/** vfs/ocr_utils.rs: legacy/current OCR payloads and PDF text-layer decisions. */
import { charCount, rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import { parseSerdeJson } from '../repository/json.ts';
export const OCR_FAILED_MARKER = '__OCR_FAILED__';
export function hasValidText(text: string | null | undefined, threshold: number): boolean {
  return text != null && charCount(rustTrim(text)) >= threshold;
}
export function hasValidOcrPages(pages: readonly (string | null)[], threshold: number): boolean {
  return pages.some(text => hasValidText(text, threshold));
}
export function classifyPdfContent(text: string | null | undefined, threshold: number): 'text' | 'scanned' {
  return hasValidText(text, threshold) ? 'text' : 'scanned';
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function unsigned(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}
function pageIndex(row: Record<string, unknown>): number | undefined {
  return unsigned(Object.hasOwn(row, 'page_index') ? row.page_index : row.pageIndex);
}
export function parseOcrPages(json: string, log?: { warn(message: string, ...args: unknown[]): void }): Array<string | null> {
  const trimmed = rustTrim(json);
  if (trimmed === '') return [];
  let value: unknown;
  try { value = parseSerdeJson(trimmed); }
  catch (error) {
    log?.warn('[OcrUtils] Failed to parse ocr_pages_json: %s', error instanceof Error ? error.message : String(error));
    return [];
  }
  const normalize = (s: string | null) => s === null || s === OCR_FAILED_MARKER || rustTrim(s) === '' ? null : s;
  if (Array.isArray(value) && value.every(v => v === null || typeof v === 'string')) return value.map(normalize);
  const root = object(value);
  if (!Array.isArray(root.pages)) {
    log?.warn('[OcrUtils] ocr_pages_json has no pages array');
    return [];
  }
  const pages = root.pages.map(object);
  const indices = pages.map(pageIndex).filter((n): n is number => n !== undefined);
  const total = unsigned(root.total_pages) ?? (indices.length > 0 ? Math.max(...indices) + 1 : pages.length);
  const result: Array<string | null> = Array.from({ length: Math.max(total, pages.length) }, () => null);
  pages.forEach((page, index) => {
    const target = pageIndex(page) ?? index;
    const blocks = Array.isArray(page.blocks) ? page.blocks.map(object).flatMap(block =>
      typeof block.text === 'string' && rustTrim(block.text) !== '' ? [rustTrim(block.text)] : []) : [];
    const blockText = blocks.length === 0 ? null : blocks.join('\n');
    const text = typeof page.text === 'string' && rustTrim(page.text) !== '' ? rustTrim(page.text) : null;
    const chosen = blockText !== null && text !== null
      ? utf8ByteLength(blockText) >= utf8ByteLength(text) ? blockText : text : blockText ?? text;
    while (result.length <= target) result.push(null);
    result[target] = chosen;
  });
  return result.map(normalize);
}
