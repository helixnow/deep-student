/**
 * Pure context-injection helpers for `ref_handlers.rs`: OCR page parsing/joining
 * (`ocr_utils.rs`), XML escaping and inject-mode resolution (`types.rs`).
 */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';

const OCR_FAILED_MARKER = '__OCR_FAILED__';

function cleanPage(value: string | null): string | null {
  if (value === null) return null;
  if (rustTrim(value) === '' || value === OCR_FAILED_MARKER) return null;
  return value;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** ocr_utils.rs:44-140 `parse_ocr_pages_json`. */
export function parseOcrPagesJson(json: string, log: Pick<Context['logger'], 'warn'>): Array<string | null> {
  const trimmed = rustTrim(json);
  if (trimmed === '') return [];
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    log.warn('[OcrUtils] Failed to parse ocr_pages_json: %s', error);
    return [];
  }
  if (Array.isArray(value)) {
    if (!value.every(entry => entry === null || typeof entry === 'string')) {
      log.warn('[OcrUtils] ocr_pages_json has no pages array');
      return [];
    }
    return value.map(entry => cleanPage(entry as string | null));
  }
  if (value === null || typeof value !== 'object') {
    log.warn('[OcrUtils] ocr_pages_json has no pages array');
    return [];
  }
  const root = value as Record<string, unknown>;
  const pages = root['pages'];
  if (!Array.isArray(pages)) {
    log.warn('[OcrUtils] ocr_pages_json has no pages array');
    return [];
  }
  const unsigned = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
  const indices = pages.map(page => {
    const row = asRecord(page);
    const index = row?.['page_index'] ?? row?.['pageIndex'];
    return unsigned(index) ? index : null;
  });
  const present = indices.filter((index): index is number => index !== null);
  const total = unsigned(root['total_pages']) ? root['total_pages']
    : present.length ? Math.max(...present) + 1 : pages.length;
  const result: Array<string | null> = Array(Math.max(total, pages.length)).fill(null);
  pages.forEach((page, index) => {
    const row = asRecord(page);
    const blocks = asArray(row?.['blocks']).map(block => asRecord(block)?.['text'])
      .filter((text): text is string => typeof text === 'string').map(rustTrim).filter(Boolean).join('\n');
    const text = typeof row?.['text'] === 'string' ? rustTrim(row['text']) : '';
    const selected = utf8ByteLength(blocks) >= utf8ByteLength(text) ? blocks : text;
    const target = indices[index] ?? index;
    if (target >= result.length) result.push(...Array(target + 1 - result.length).fill(null));
    result[target] = cleanPage(selected);
  });
  return result;
}

/** ocr_utils.rs:204-234 `join_ocr_pages_text`. */
export function joinOcrPagesText(
  pages: readonly (string | null)[],
  prefix = '第',
  suffix = '页',
  startOffset = 0,
): string | null {
  const parts: string[] = [];
  pages.forEach((page, index) => {
    if (page === null) return;
    const text = rustTrim(page);
    if (text === '') return;
    parts.push(`--- ${prefix} ${startOffset + index + 1} ${suffix} ---\n${text}`);
  });
  return parts.length === 0 ? null : parts.join('\n\n');
}

/** ref_handlers.rs:412-427 */
export function escapeXmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** ref_handlers.rs:421-427 */
export function escapeXmlContent(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** types.rs:2481-2502 `resolve_image_inject_modes`. */
export function resolveImageInjectModes(
  modes: readonly string[] | null | undefined,
  isMultimodal: boolean,
): { includeImage: boolean; includeOcr: boolean; downgraded: boolean } {
  let includeImage = true;
  let includeOcr = false;
  if (modes !== null && modes !== undefined && modes.length > 0) {
    includeImage = modes.includes('image');
    includeOcr = modes.includes('ocr');
  }
  let downgraded = false;
  if (includeImage && !isMultimodal) {
    includeImage = false;
    includeOcr = true;
    downgraded = true;
  }
  return { includeImage, includeOcr, downgraded };
}

/** types.rs:2505-2525 `resolve_pdf_inject_modes`. */
export function resolvePdfInjectModes(
  modes: readonly string[] | null | undefined,
  isMultimodal: boolean,
): { includeText: boolean; includeOcr: boolean; includeImage: boolean; downgraded: boolean } {
  let includeText = true;
  let includeOcr = false;
  let includeImage = false;
  if (modes !== null && modes !== undefined) {
    includeText = modes.includes('text');
    includeOcr = modes.includes('ocr');
    includeImage = modes.includes('image');
  }
  let downgraded = false;
  if (includeImage && !isMultimodal) {
    includeImage = false;
    includeOcr = true;
    downgraded = true;
  }
  return { includeText, includeOcr, includeImage, downgraded };
}
