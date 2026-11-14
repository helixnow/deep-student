/**
 * `vfs/unit_builder/{trait_def,builders,registry}.rs`: pure resource-to-unit builders.
 *
 * The table writes stay with the unit repository; this module only reproduces
 * the Rust builder branch order, defaults and text/image provenance.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import type { CreateUnitInput } from '../../vfs-repos/api.ts';
import { parseOcrPagesJson } from './indexing-content.ts';
import type { UnitBuildInput } from '../api.ts';

export type { UnitBuildInput };

export interface UnitBuildOutput { units: CreateUnitInput[] }
export interface UnitBuilder {
  readonly resourceType: string;
  build(input: UnitBuildInput): UnitBuildOutput;
}

const PDF_PAGE_SEPARATOR = '\f';
const MAX_MINDMAP_EXTRACT_DEPTH = 100;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parsed(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function firstField(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(row, key)) return row[key];
  }
  return undefined;
}

/** `builders.rs::parse_preview_pages`: compressed page image first, camelCase or snake_case. */
export function parsePreviewPages(
  json: string | null | undefined,
  count: number,
): Array<[string, string] | null> {
  const raw = object(parsed(json))['pages'];
  const pages: Array<[string, string] | null> = Array.isArray(raw)
    ? raw.map((value) => {
      const row = object(value);
      const hash = firstField(row, [
        'compressedBlobHash', 'compressed_blob_hash', 'blobHash', 'blob_hash', 'hash', 'image_hash',
      ]);
      const mime = firstField(row, ['mimeType', 'mime_type']);
      return typeof hash === 'string' && hash !== ''
        ? [
          hash,
          typeof mime === 'string' && mime.startsWith('image/') ? mime : 'image/png',
        ] as [string, string]
        : null;
    })
    : [];
  while (pages.length < count) pages.push(null);
  return pages;
}

function unit(
  input: UnitBuildInput,
  text: string | null,
  source: string | null,
  index = 0,
  image: [string, string] | null = null,
): CreateUnitInput {
  return {
    resourceId: input.resourceId,
    unitIndex: index,
    textContent: text,
    textSource: source,
    imageBlobHash: image?.[0] ?? null,
    imageMimeType: image?.[1] ?? null,
  };
}

function ocrPages(input: UnitBuildInput): Array<string | null> {
  return input.ocrPagesJson === null || input.ocrPagesJson === undefined
    ? []
    : parseOcrPagesJson(input.ocrPagesJson);
}

/** `builders.rs::native_pdf_pages`: None when the separator count cannot be aligned. */
function nativePdfPages(input: UnitBuildInput, pageCount: number): string[] | undefined {
  const text = input.extractedText;
  if (text === null || text === undefined) return undefined;
  if (pageCount > 1 && !text.includes(PDF_PAGE_SEPARATOR)) return undefined;
  const parts = text.split(PDF_PAGE_SEPARATOR).map((part) => rustTrim(part));
  return parts.length === pageCount ? parts : undefined;
}

/** `builders.rs::build_pdf_page_units`: one unit per page with native text, OCR or page image. */
function pdfPageUnits(input: UnitBuildInput): CreateUnitInput[] | undefined {
  const pageCount = input.pageCount;
  if (pageCount === null || pageCount === undefined || pageCount <= 0) return undefined;
  const count = pageCount;
  const preview = parsePreviewPages(input.previewJson, count);
  const hasPreview = preview.some((page) => page !== null);
  const native = nativePdfPages(input, count);
  const ocr = ocrPages(input);
  while (ocr.length < count) ocr.push(null);
  const hasOcr = ocr.some((page) => page !== null);
  const hasWholeText = input.extractedText !== null && input.extractedText !== undefined
    && rustTrim(input.extractedText) !== '';
  if (native === undefined && hasWholeText && !hasOcr) return undefined;
  if (native === undefined && !hasOcr && !hasPreview) return undefined;
  if (count === 1 && !hasPreview) return undefined;
  return Array.from({ length: count }, (_, index) => {
    const nativeText = native?.[index];
    const text = nativeText !== undefined && nativeText !== '' ? nativeText : (ocr[index] ?? null);
    const source = nativeText !== undefined && nativeText !== ''
      ? 'native'
      : text !== null ? 'ocr' : null;
    return unit(input, text, source, index, preview[index] ?? null);
  });
}

/** `builders.rs::ocr_duplicates_native`: whitespace-normalised equality. */
function ocrDuplicatesNative(input: UnitBuildInput): boolean {
  const native = input.extractedText;
  const ocr = input.ocrText;
  if (native === null || native === undefined || ocr === null || ocr === undefined) return false;
  const compact = (text: string): string => text.replace(/\p{White_Space}/gu, '');
  return compact(native) === compact(ocr);
}

/** Shared single-page `FileBuilder`/`AttachmentBuilder` branch. */
function fileUnits(input: UnitBuildInput): CreateUnitInput[] {
  const hasExtracted = input.extractedText !== null && input.extractedText !== undefined
    && rustTrim(input.extractedText) !== '';
  const hasOcr = input.ocrText !== null && input.ocrText !== undefined
    && rustTrim(input.ocrText) !== '' && !ocrDuplicatesNative(input);
  const units: CreateUnitInput[] = [];
  if (hasExtracted) {
    units.push(unit(input, input.extractedText!, 'native', units.length));
  }
  if (hasOcr) {
    units.push(unit(input, input.ocrText!, 'ocr', units.length));
  }
  if (units.length === 0) units.push(unit(input, null, null));
  return units;
}

/** Shared per-page OCR-only branch (exam/textbook/attachment multi-page). */
function legacyPageUnits(
  input: UnitBuildInput,
  count: number,
  ocr: readonly (string | null)[],
): CreateUnitInput[] {
  const preview = parsePreviewPages(input.previewJson, count);
  return Array.from({ length: count }, (_, index) => {
    const text = ocr[index] ?? null;
    return unit(input, text, text !== null ? 'ocr' : null, index, preview[index] ?? null);
  });
}

/** `builders.rs::extract_mindmap_text`: root dive, node text and note lines. */
function mindmapText(json: string | null | undefined): string | null {
  const value = parsed(json);
  if (value === undefined) return null;
  const lines: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_MINDMAP_EXTRACT_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth);
      return;
    }
    const row = object(node);
    const indent = '  '.repeat(depth);
    for (const key of ['text', 'label', 'title', 'content', 'name']) {
      const text = row[key];
      if (typeof text === 'string' && text !== '') lines.push(`${indent}${text}`);
    }
    const note = row['note'];
    if (typeof note === 'string' && rustTrim(note) !== '') {
      for (const noteLine of rustTrim(note).split(/\r?\n/u)) lines.push(`${indent}  ${noteLine}`);
    }
    for (const key of ['children', 'nodes']) {
      const children = row[key];
      if (Array.isArray(children)) {
        for (const child of children) visit(child, depth + 1);
      }
    }
  };
  const row = object(value);
  visit(Object.hasOwn(row, 'root') ? row['root'] : value, 0);
  return lines.join('\n') || null;
}

function translationText(data: string | null | undefined): string | null {
  const value = parsed(data);
  if (value === undefined) return null;
  const row = object(value);
  const source = typeof row['source'] === 'string' ? row['source'] : '';
  const translated = typeof row['translated'] === 'string' ? row['translated'] : '';
  return `${source}\n\n---\n\n${translated}`;
}

function buildType(type: string, input: UnitBuildInput): UnitBuildOutput {
  switch (type) {
    case 'note':
    case 'essay':
      return { units: [unit(input, input.data ?? null, 'native')] };
    case 'translation':
      return { units: [unit(input, translationText(input.data), 'native')] };
    case 'mindmap':
      return { units: [unit(input, mindmapText(input.data), 'native')] };
    case 'image': {
      const text = input.ocrText ?? null;
      return {
        units: [{
          ...unit(input, text, text === null ? null : 'ocr'),
          imageBlobHash: input.blobHash ?? null,
          imageMimeType: 'image/png',
        }],
      };
    }
    case 'exam': {
      const ocr = ocrPages(input);
      const count = ocr.length === 0 ? (input.pageCount ?? 1) : ocr.length;
      return { units: legacyPageUnits(input, count, ocr) };
    }
    case 'textbook': {
      const paged = pdfPageUnits(input);
      if (paged !== undefined) return { units: paged };
      const count = input.pageCount ?? 1;
      const ocr = ocrPages(input);
      const hasOcrContent = ocr.some((page) => page !== null && rustTrim(page) !== '');
      const extracted = input.extractedText;
      if (!hasOcrContent && extracted !== null && extracted !== undefined
        && rustTrim(extracted) !== '') {
        return { units: [unit(input, extracted, 'native')] };
      }
      return { units: legacyPageUnits(input, count, ocr) };
    }
    case 'attachment': {
      const paged = pdfPageUnits(input);
      if (paged !== undefined) return { units: paged };
      const count = input.pageCount ?? 1;
      if (count <= 1) return { units: fileUnits(input) };
      return { units: legacyPageUnits(input, count, ocrPages(input)) };
    }
    case 'file': {
      const paged = pdfPageUnits(input);
      return { units: paged ?? fileUnits(input) };
    }
    default:
      throw new Error(`Unsupported resource type: ${type}`);
  }
}

export class UnitBuilderRegistry {
  private readonly builders = new Map<string, UnitBuilder>();

  constructor() {
    for (const resourceType of [
      'note', 'textbook', 'image', 'exam', 'translation', 'essay', 'mindmap', 'file', 'attachment',
    ]) {
      this.register({ resourceType, build: (input): UnitBuildOutput => buildType(resourceType, input) });
    }
  }

  register(builder: UnitBuilder): void {
    this.builders.set(builder.resourceType, builder);
  }

  get(resourceType: string): UnitBuilder | undefined {
    return this.builders.get(resourceType);
  }

  build(input: UnitBuildInput): UnitBuildOutput | undefined {
    return this.get(input.resourceType)?.build(input);
  }

  supportedTypes(): string[] {
    return [...this.builders.keys()];
  }
}
