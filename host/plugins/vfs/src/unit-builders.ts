/** vfs/unit_builder/{trait_def,builders,registry}.rs. Pure per-resource unit construction. */
import { rustTrim } from '../../../platform/util/portable.ts';
import type { CreateUnitInput } from '../../vfs-repos/api.ts';
import { parseOcrPagesJson } from '../repository/resources.ts';
import { parseSerdeJson } from '../repository/json.ts';

export interface UnitBuildInput {
  resourceId: string;
  resourceType: string;
  data?: string | null;
  ocrText?: string | null;
  ocrPagesJson?: string | null;
  blobHash?: string | null;
  pageCount?: number | null;
  extractedText?: string | null;
  previewJson?: string | null;
}
export interface UnitBuildOutput { units: CreateUnitInput[] }
export interface UnitBuilder { resourceType: string; build(input: UnitBuildInput): UnitBuildOutput }

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function parsed(value: string | null | undefined): unknown {
  if (value == null) return undefined;
  try { return parseSerdeJson(value); }
  catch { return undefined; }
}
function firstField(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (Object.hasOwn(row, key)) return row[key];
  return undefined;
}
export function parsePreviewPages(json: string | null | undefined, count: number): Array<[string, string] | null> {
  const raw = object(parsed(json)).pages;
  const result: Array<[string, string] | null> = Array.isArray(raw) ? raw.map(value => {
    const row = object(value);
    const hash = firstField(row, ['compressedBlobHash', 'compressed_blob_hash', 'blobHash', 'blob_hash', 'hash', 'image_hash']);
    const mime = firstField(row, ['mimeType', 'mime_type']);
    return typeof hash === 'string' && hash !== ''
      ? [hash, typeof mime === 'string' && mime.startsWith('image/') ? mime : 'image/png'] : null;
  }) : [];
  while (result.length < count) result.push(null);
  return result;
}
function unit(input: UnitBuildInput, text: string | null, source: string | null, index = 0,
  image: [string, string] | null = null): CreateUnitInput {
  return { resourceId: input.resourceId, unitIndex: index, textContent: text, textSource: source,
    imageBlobHash: image?.[0] ?? null, imageMimeType: image?.[1] ?? null };
}
function ocrPages(input: UnitBuildInput): Array<string | null> {
  return input.ocrPagesJson == null ? [] : parseOcrPagesJson(input.ocrPagesJson);
}
function pageUnits(input: UnitBuildInput): CreateUnitInput[] | undefined {
  const count = input.pageCount;
  if (count == null || count <= 0) return undefined;
  const preview = parsePreviewPages(input.previewJson, count);
  const hasPreview = preview.some(p => p !== null);
  const parts = input.extractedText?.split('\f').map(rustTrim);
  const native = parts?.length === count && (count === 1 || input.extractedText!.includes('\f')) ? parts : undefined;
  const ocr = ocrPages(input).slice(0, count);
  const hasOcr = ocr.some(p => p !== null);
  const hasWhole = input.extractedText != null && rustTrim(input.extractedText) !== '';
  if (native === undefined && ((hasWhole && !hasOcr) || (!hasOcr && !hasPreview))) return undefined;
  if (count === 1 && !hasPreview) return undefined;
  return Array.from({ length: count }, (_, index) => {
    const nativeText = native?.[index];
    const text = nativeText ? nativeText : ocr[index] ?? null;
    return unit(input, text, nativeText ? 'native' : text !== null ? 'ocr' : null, index, preview[index] ?? null);
  });
}
function fileUnits(input: UnitBuildInput): CreateUnitInput[] {
  const native = input.extractedText != null && rustTrim(input.extractedText) !== '';
  const compact = (s: string) => s.replace(/\p{White_Space}/gu, '');
  const duplicate = input.extractedText != null && input.ocrText != null
    && compact(input.extractedText) === compact(input.ocrText);
  const ocr = input.ocrText != null && rustTrim(input.ocrText) !== '' && !duplicate;
  const units: CreateUnitInput[] = [];
  if (native) units.push(unit(input, input.extractedText!, 'native'));
  if (ocr) units.push(unit(input, input.ocrText!, 'ocr', units.length));
  return units.length === 0 ? [unit(input, null, null)] : units;
}
function legacyPages(input: UnitBuildInput, count: number, ocr: Array<string | null>): CreateUnitInput[] {
  const preview = parsePreviewPages(input.previewJson, count);
  return Array.from({ length: count }, (_, index) => {
    const text = ocr[index] ?? null;
    return unit(input, text, text !== null ? 'ocr' : null, index, preview[index] ?? null);
  });
}
function mindmapText(json: string | null | undefined): string | null {
  const value = parsed(json);
  if (value === undefined) return null;
  const lines: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 100) return;
    if (Array.isArray(value)) { for (const item of value) visit(item, depth); return; }
    const row = object(value);
    const indent = '  '.repeat(depth);
    for (const key of ['text', 'label', 'title', 'content', 'name']) {
      if (typeof row[key] === 'string' && row[key] !== '') lines.push(`${indent}${row[key]}`);
    }
    if (typeof row.note === 'string' && rustTrim(row.note) !== '') {
      for (const line of rustTrim(row.note).split(/\r?\n/u)) lines.push(`${indent}  ${line}`);
    }
    for (const key of ['children', 'nodes']) if (Array.isArray(row[key])) {
      for (const child of row[key]) visit(child, depth + 1);
    }
  };
  const row = object(value);
  visit(Object.hasOwn(row, 'root') ? row.root : value, 0);
  return lines.join('\n') || null;
}
function buildType(type: string, input: UnitBuildInput): UnitBuildOutput {
  let units: CreateUnitInput[];
  switch (type) {
    case 'note': case 'essay': units = [unit(input, input.data ?? null, 'native')]; break;
    case 'translation': {
      const value = parsed(input.data);
      const row = object(value);
      const content = value === undefined ? null : `${typeof row.source === 'string' ? row.source : ''}\n\n---\n\n${typeof row.translated === 'string' ? row.translated : ''}`;
      units = [unit(input, content, 'native')]; break;
    }
    case 'mindmap': units = [unit(input, mindmapText(input.data), 'native')]; break;
    case 'image': units = [{ ...unit(input, input.ocrText ?? null, input.ocrText == null ? null : 'ocr'),
      imageBlobHash: input.blobHash ?? null, imageMimeType: 'image/png' }]; break;
    case 'exam': {
      const ocr = ocrPages(input);
      units = legacyPages(input, ocr.length || (input.pageCount ?? 1), ocr); break;
    }
    case 'textbook': {
      const paged = pageUnits(input);
      if (paged !== undefined) { units = paged; break; }
      const ocr = ocrPages(input);
      units = !ocr.some(text => text !== null && rustTrim(text) !== '') && input.extractedText != null && rustTrim(input.extractedText) !== ''
        ? [unit(input, input.extractedText, 'native')] : legacyPages(input, input.pageCount ?? 1, ocr);
      break;
    }
    case 'attachment':
      units = pageUnits(input) ?? ((input.pageCount ?? 1) <= 1 ? fileUnits(input) : legacyPages(input, input.pageCount!, ocrPages(input))); break;
    default: units = pageUnits(input) ?? fileUnits(input);
  }
  return { units };
}

export class UnitBuilderRegistry {
  private readonly builders = new Map<string, UnitBuilder>();
  constructor() {
    for (const resourceType of ['note', 'textbook', 'image', 'exam', 'translation', 'essay', 'mindmap', 'file', 'attachment']) {
      this.register({ resourceType, build: input => buildType(resourceType, input) });
    }
  }
  register(builder: UnitBuilder): void { this.builders.set(builder.resourceType, builder); }
  get(type: string): UnitBuilder | undefined { return this.builders.get(type); }
  build(input: UnitBuildInput): UnitBuildOutput | undefined { return this.get(input.resourceType)?.build(input); }
  supportedTypes(): string[] { return [...this.builders.keys()]; }
}
