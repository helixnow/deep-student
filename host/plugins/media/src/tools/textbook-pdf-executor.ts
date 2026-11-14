/**
 * `src/chat_v2/tools/textbook_pdf_executor.rs`: `textbook_bookmarks` and
 * `textbook_highlights` (agent-safe annotation reads/writes guarded by the
 * textbook `updated_at` revision) and `pdf_page_image` (one bounded page preview
 * as a data URL). Every error is the Rust `tool_error` JSON string.
 */
import { nanoid } from 'nanoid';
import type { ToolCall, ToolConcurrency, ToolResultInfo } from '../../../chat/api.ts';
import type { VfsDatabase } from '../../../vfs/api.ts';
import {
  VfsRepositoryError, type JsonValue, type VfsReposService, type VfsTextbook,
} from '../../../vfs-repos/api.ts';
import type { NativeImage, RgbaImage } from '../../../../platform/native/image/api.ts';
import { PDF_ANNOTATIONS_CHANGED_EVENT } from '../../api.ts';
import { stripToolNamespace } from '../document-processing.ts';
import {
  BOOKMARKS_TOOL, HIGHLIGHTS_TOOL, MAX_ANNOTATIONS, MAX_PAGE_SIZE, PDF_PAGE_IMAGE_TOOL,
  argumentsObject, bookmarkOutput, boundJsonStringsInPlace, ensureExpectedRevision,
  hasDynamicSensitivity, highlightOutput, invalidArgument, paginatedAnnotations, parseRect,
  sensitivityLevel, sensitivityLevelForCall, toolError,
  type Bookmark, type Highlight, type HighlightRect, type ToolSensitivity,
} from '../textbook-pdf.ts';
import { readPdfPageImageBytes, type PdfPageImageBytes } from '../../../vfs-handlers/api.ts';
import type { FilesService } from '../../../../platform/files/api.ts';
import { toBase64 } from '../../../../platform/crypto/encoding.ts';
import { errorText, runToolCall, type MediaToolContext, type ToolLogger } from './runtime.ts';

const NAME = 'TextbookPdfToolExecutor';

const MAX_PAGE_NUMBER = 100_000;
const MAX_RECTS = 64;
const MAX_BOOKMARK_TITLE_CHARS = 500;
const MAX_HIGHLIGHT_TEXT_CHARS = 20_000;
const MAX_ID_CHARS = 200;
const U32_MAX = 4_294_967_295;
export const MAX_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_OUTPUT_BYTES = 1_500_000;
export const MAX_IMAGE_OUTPUT_BASE64_CHARS = 2_000_000;
const MAX_IMAGE_SOURCE_DIMENSION = 16_384;
export const MAX_IMAGE_OUTPUT_DIMENSION = 2_048;
const JPEG_QUALITIES = [82, 70, 58, 46] as const;

const HIGHLIGHT_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca'];

export type TextbookPdfRepos = Pick<VfsReposService, 'textbooks' | 'resources' | 'blobs'>;

export interface TextbookPdfDeps {
  repos(): TextbookPdfRepos;
  /** `ctx.files`（读 blob 的 stat / 字节）。 */
  hostFiles(): Pick<FilesService, 'stat' | 'readBytes'>;
  image(): NativeImage | null;
  /** Rust `app_handle().emit(..)`: a global broadcast. */
  emit(event: string, payload: Record<string, unknown>): void;
  now(): number;
  log: ToolLogger;
}

type Args = Record<string, unknown>;

// ---- argument readers (textbook_pdf_executor.rs:600-690) ----

function requiredString(object: Args, field: string, maximumChars: number): string {
  const raw = object[field];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') throw invalidArgument(field, 'expected a non-empty string');
  if ([...value].length > maximumChars) {
    throw invalidArgument(field, `cannot exceed ${maximumChars} Unicode characters`);
  }
  return value;
}

function optionalString(object: Args, field: string, maximumChars: number): string | null {
  if (object[field] === undefined || object[field] === null) return null;
  return requiredString(object, field, maximumChars);
}

function requiredAction(args: unknown): string {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw invalidArgument('arguments', 'expected a JSON object');
  }
  return requiredString(args as Args, 'action', 16);
}

function requiredIdentifier(object: Args, field: string): string {
  const id = requiredString(object, field, MAX_ID_CHARS);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    throw invalidArgument(field, "may contain only ASCII letters, digits, '_' and '-'");
  }
  return id;
}

function requiredU32(object: Args, field: string, minimum: number, maximum: number): number {
  const value = object[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw invalidArgument(field, `expected an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalU32(object: Args, field: string, minimum: number, maximum: number): number | null {
  if (object[field] === undefined || object[field] === null) return null;
  return requiredU32(object, field, minimum, maximum);
}

function pagination(object: Args): [number, number] {
  const page = optionalU32(object, 'page', 1, U32_MAX) ?? 1;
  const pageSize = optionalU32(object, 'page_size', 1, MAX_PAGE_SIZE) ?? MAX_PAGE_SIZE;
  return [page, pageSize];
}

function requiredHighlightColor(object: Args): string {
  const color = requiredString(object, 'color', 7);
  if (!HIGHLIGHT_COLORS.includes(color)) {
    throw invalidArgument('color', 'expected one of #fef08a, #bbf7d0, #bfdbfe, #fecaca');
  }
  return color;
}

function optionalHighlightColor(object: Args): string | null {
  if (object.color === undefined || object.color === null) return null;
  return requiredHighlightColor(object);
}

function requiredRects(object: Args): HighlightRect[] {
  const values = object.rects;
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_RECTS) {
    throw invalidArgument('rects', `expected between 1 and ${MAX_RECTS} normalized rectangles`);
  }
  return values.map((value, index) => parseRect(value, index));
}

function optionalRects(object: Args): HighlightRect[] | null {
  if (object.rects === undefined || object.rects === null) return null;
  return requiredRects(object);
}

// ---- stored annotation boundary (serde Bookmark / Highlight) ----

function serdeActual(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'sequence';
  if (typeof value === 'object') return 'map';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (typeof value === 'number') return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  return `boolean \`${String(value)}\``;
}

type FieldKind = 'string' | 'u32' | 'i64' | 'f64';
const FIELD_EXPECTED: Record<FieldKind, string> = { string: 'a string', u32: 'u32', i64: 'i64', f64: 'f64' };

function fieldMatches(value: unknown, kind: FieldKind): boolean {
  if (kind === 'string') return typeof value === 'string';
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (kind === 'f64') return true;
  if (!Number.isInteger(value)) return false;
  return kind === 'u32' ? value >= 0 && value <= U32_MAX : Number.isSafeInteger(value);
}

/** serde struct read: present invalid fields fail before absent required ones; unknown keys are ignored. */
function readStruct(value: unknown, struct: string, fields: Record<string, FieldKind>, optional: readonly string[] = []): Args {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`invalid type: ${serdeActual(value)}, expected struct ${struct}`);
  }
  const object = value as Args;
  for (const [field, kind] of Object.entries(fields)) {
    const item = object[field];
    if (item === undefined || (item === null && optional.includes(field))) continue;
    if (!fieldMatches(item, kind)) throw new Error(`invalid type: ${serdeActual(item)}, expected ${FIELD_EXPECTED[kind]}`);
  }
  for (const field of Object.keys(fields)) {
    if (object[field] === undefined && !optional.includes(field)) throw new Error(`missing field \`${field}\``);
  }
  return object;
}

function parseStoredBookmark(value: unknown): Bookmark {
  const object = readStruct(value, 'Bookmark', { id: 'string', page: 'u32', title: 'string', createdAt: 'i64' });
  return {
    id: object.id as string, page: object.page as number,
    title: object.title as string, createdAt: object.createdAt as number,
  };
}

function parseStoredHighlight(value: unknown): Highlight {
  const object = readStruct(value, 'Highlight', {
    id: 'string', pageIndex: 'u32', text: 'string', color: 'string', createdAt: 'i64', coordVersion: 'u32',
  }, ['coordVersion']);
  const rawRects = object.rects;
  if (rawRects === undefined) throw new Error('missing field `rects`');
  if (!Array.isArray(rawRects)) throw new Error(`invalid type: ${serdeActual(rawRects)}, expected a sequence`);
  const rects = rawRects.map(rect => {
    const item = readStruct(rect, 'HighlightRect', { x: 'f64', y: 'f64', width: 'f64', height: 'f64' });
    return { x: item.x as number, y: item.y as number, width: item.width as number, height: item.height as number };
  });
  const coordVersion = object.coordVersion;
  return {
    id: object.id as string, pageIndex: object.pageIndex as number, text: object.text as string,
    color: object.color as string, rects, createdAt: object.createdAt as number,
    coordVersion: typeof coordVersion === 'number' ? coordVersion : null,
  };
}

function parseAll<T>(values: readonly JsonValue[], parse: (value: unknown) => T, kind: string): T[] {
  return values.map(value => {
    try { return parse(value); }
    catch (error) {
      throw toolError('CORRUPT_ANNOTATIONS', `Stored ${kind} data is invalid: ${errorText(error)}`,
        `Open the textbook reader and repair or remove the malformed ${kind}.`, false);
    }
  });
}

/** `serde_json::to_value(Bookmark)`: only the struct fields survive a write. */
function serializeBookmark(bookmark: Bookmark): JsonValue {
  return { id: bookmark.id, page: bookmark.page, title: bookmark.title, createdAt: bookmark.createdAt };
}

/** `coordVersion` is `skip_serializing_if = "Option::is_none"`. */
function serializeHighlight(highlight: Highlight): JsonValue {
  const value: Record<string, JsonValue> = {
    id: highlight.id,
    pageIndex: highlight.pageIndex,
    text: highlight.text,
    color: highlight.color,
    rects: highlight.rects.map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })),
    createdAt: highlight.createdAt,
  };
  if (highlight.coordVersion != null) value.coordVersion = highlight.coordVersion;
  return value;
}

// ---- textbook helpers ----

function validatePageNumber(page: number, textbook: VfsTextbook): void {
  const count = textbook.pageCount;
  if (count !== undefined && page > Math.max(count, 0)) {
    throw invalidArgument('page_number', `page ${page} exceeds the textbook page count ${count}`);
  }
}

function validatePageIndex(pageIndex: number, textbook: VfsTextbook): void {
  const count = textbook.pageCount;
  if (count !== undefined && pageIndex >= Math.max(count, 0)) {
    throw invalidArgument('page_index',
      `zero-based page index ${pageIndex} exceeds the textbook page count ${count}`);
  }
}

function annotationNotFound(kind: string, id: string): Error {
  return toolError('ANNOTATION_NOT_FOUND', `The ${kind} '${id}' was not found.`,
    'Re-read the current annotations and use an existing ID.', false);
}

function annotationLimit(kind: string): Error {
  return toolError('ANNOTATION_LIMIT_EXCEEDED',
    `A textbook cannot contain more than ${MAX_ANNOTATIONS} ${kind}s.`,
    `Remove an existing ${kind} before adding another.`, false);
}

function annotationWriteOutput(
  action: string, kind: string, annotation: Record<string, unknown>,
  previous: Record<string, unknown> | null, textbook: VfsTextbook, count: number,
): Record<string, unknown> {
  return {
    action,
    kind,
    textbook_id: textbook.id,
    annotation,
    previous,
    count,
    updated_at: textbook.updatedAt,
    event: PDF_ANNOTATIONS_CHANGED_EVENT,
    reversible: false,
    reversible_with_occ: true,
    message_key: 'chat.tools.textbook_pdf.annotation_write.success',
  };
}

// ---- image bounding (fit_image_for_tool / encode_bounded_jpeg) ----

interface BoundedImage { bytes: Uint8Array; mimeType: string; width: number; height: number; compressed: boolean }

async function encodeBoundedJpeg(image: NativeImage, decoded: RgbaImage): Promise<BoundedImage> {
  const bounds = image.resizeDimensions(decoded.width, decoded.height,
    MAX_IMAGE_OUTPUT_DIMENSION, MAX_IMAGE_OUTPUT_DIMENSION);
  let target = bounds.width === decoded.width && bounds.height === decoded.height
    ? decoded
    : image.resizeRgba(decoded, bounds.width, bounds.height, 'triangle');
  for (let round = 0; round < 5; round += 1) {
    for (const quality of JPEG_QUALITIES) {
      let bytes: Uint8Array;
      try { bytes = await image.encode(target, { format: 'jpeg', quality }); }
      catch (error) {
        throw toolError('PDF_PAGE_IMAGE_COMPRESSION_FAILED',
          `Failed to compress PDF page image: ${errorText(error)}`, 'Rebuild the PDF preview and retry.', true);
      }
      if (bytes.byteLength <= MAX_IMAGE_OUTPUT_BYTES) {
        // Rust: `width != source || height != source || quality < 100`; every ladder quality is < 100.
        return { bytes, mimeType: 'image/jpeg', width: target.width, height: target.height, compressed: true };
      }
    }
    const nextWidth = Math.max(Math.trunc(target.width * 3 / 4), 320);
    const nextHeight = Math.max(Math.trunc(target.height * 3 / 4), 320);
    if (nextWidth === target.width && nextHeight === target.height) break;
    const next = image.resizeDimensions(target.width, target.height, nextWidth, nextHeight);
    target = image.resizeRgba(target, next.width, next.height, 'lanczos3');
  }
  throw toolError('PDF_PAGE_IMAGE_TOO_LARGE',
    'PDF page preview could not be compressed below the safe output limit.',
    'Use OCR text for this page or rebuild its PDF preview.', false);
}

export async function fitImageForTool(image: NativeImage, bytes: Uint8Array, sourceMime: string): Promise<BoundedImage> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_SOURCE_BYTES) {
    throw toolError('PDF_PAGE_IMAGE_TOO_LARGE',
      `PDF preview source must contain 1..=${MAX_IMAGE_SOURCE_BYTES} bytes (got ${bytes.byteLength}).`,
      'Rebuild the PDF preview so a compressed page image is available.', false);
  }
  let decoded: RgbaImage;
  try { decoded = await image.decodeRgba(bytes); }
  catch (error) {
    throw toolError('PDF_PAGE_IMAGE_INVALID', `Failed to decode PDF page preview: ${errorText(error)}`,
      'Rebuild the PDF preview for this resource.', false);
  }
  const { width, height } = decoded;
  if (width === 0 || height === 0 || width > MAX_IMAGE_SOURCE_DIMENSION || height > MAX_IMAGE_SOURCE_DIMENSION) {
    throw toolError('PDF_PAGE_IMAGE_DIMENSIONS_INVALID',
      `PDF preview dimensions ${width}x${height} are outside the safe range.`,
      'Rebuild the PDF preview with standard page dimensions.', false);
  }
  const supportedMime = sourceMime === 'image/jpeg' || sourceMime === 'image/png' || sourceMime === 'image/webp';
  if (bytes.byteLength <= MAX_IMAGE_OUTPUT_BYTES && width <= MAX_IMAGE_OUTPUT_DIMENSION
    && height <= MAX_IMAGE_OUTPUT_DIMENSION && supportedMime) {
    return { bytes, mimeType: sourceMime, width, height, compressed: false };
  }
  return encodeBoundedJpeg(image, decoded);
}

// ---- executor ----

export class TextbookPdfToolExecutor {
  private readonly deps: TextbookPdfDeps;

  constructor(deps: TextbookPdfDeps) { this.deps = deps; }

  name(): string { return NAME; }

  canHandle(toolName: string): boolean {
    const name = stripToolNamespace(toolName);
    return name === BOOKMARKS_TOOL || name === HIGHLIGHTS_TOOL || name === PDF_PAGE_IMAGE_TOOL;
  }

  sensitivityLevel(toolName: string): ToolSensitivity { return sensitivityLevel(toolName); }

  sensitivityLevelForCall(toolName: string, args: unknown): ToolSensitivity {
    const object = typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Args : {};
    return sensitivityLevelForCall(toolName, object);
  }

  hasDynamicSensitivity(toolName: string): boolean { return hasDynamicSensitivity(toolName); }

  concurrencyClass(toolName: string): ToolConcurrency {
    return stripToolNamespace(toolName) === PDF_PAGE_IMAGE_TOOL ? 'read_only' : 'serial';
  }

  async execute(call: ToolCall, context: MediaToolContext): Promise<ToolResultInfo> {
    return runToolCall(NAME, call, context, this.deps.log, async () => {
      switch (stripToolNamespace(call.name)) {
        case BOOKMARKS_TOOL: return this.executeBookmarks(call.arguments, context);
        case HIGHLIGHTS_TOOL: return this.executeHighlights(call.arguments, context);
        case PDF_PAGE_IMAGE_TOOL: return this.executePdfPageImage(call.arguments, context);
        default:
          throw toolError('UNKNOWN_TOOL', `Unknown textbook/PDF tool '${call.name}'.`,
            'Use one of the registered textbook/PDF tools.', false);
      }
    });
  }

  private vfsDb(context: MediaToolContext): VfsDatabase {
    if (context.vfs_db === null || context.vfs_db === undefined) {
      throw toolError('DEPENDENCY_UNAVAILABLE', 'The VFS database is unavailable.',
        'Retry after the desktop app finishes starting.', true);
    }
    return context.vfs_db;
  }

  private loadTextbook(database: VfsDatabase, textbookId: string): VfsTextbook {
    let textbook: VfsTextbook | null;
    try { textbook = this.deps.repos().textbooks.getTextbook(database.getConnSafe(), textbookId); }
    catch (error) {
      throw toolError('TEXTBOOK_READ_FAILED', `Failed to read textbook annotations: ${errorText(error)}`,
        'Retry after checking local storage.', true);
    }
    if (textbook === null || textbook.status !== 'active') {
      throw toolError('TEXTBOOK_NOT_FOUND', `Active textbook '${textbookId}' was not found.`,
        'List or open the textbook again and use its current ID.', false);
    }
    return textbook;
  }

  private writeError(error: unknown, database: VfsDatabase, textbookId: string, kind: string): Error {
    if (error instanceof VfsRepositoryError && error.code === 'VFS_CONFLICT') {
      let current: VfsTextbook | null = null;
      try { current = this.deps.repos().textbooks.getTextbook(database.getConnSafe(), textbookId); }
      catch (readError) { this.deps.log.debug(`[${NAME}] conflict re-read failed: ${errorText(readError)}`); }
      const values: unknown = current === null ? [] : structuredClone(kind === 'bookmarks' ? current.bookmarks : current.highlights);
      const truncated = boundJsonStringsInPlace(values);
      return toolError('ANNOTATION_CONFLICT', error.message,
        'Re-read the annotations and do not retry with the stale revision.', false, {
          kind,
          current_updated_at: current === null ? null : current.updatedAt,
          current: values,
          current_truncated: truncated,
        });
    }
    return toolError('ANNOTATION_WRITE_FAILED', errorText(error),
      'Retry after checking local storage and the current textbook revision.', true);
  }

  private emitChanged(textbook: VfsTextbook, kind: string, action: string): void {
    try {
      this.deps.emit(PDF_ANNOTATIONS_CHANGED_EVENT, {
        textbook_id: textbook.id,
        resource_path: `/${textbook.id}`,
        kind,
        action,
        updated_at: textbook.updatedAt,
      });
    } catch (error) {
      this.deps.log.warn(`[${NAME}] Failed to emit ${PDF_ANNOTATIONS_CHANGED_EVENT}: ${errorText(error)}`);
    }
  }

  private executeBookmarks(args: unknown, context: MediaToolContext): Record<string, unknown> {
    const action = requiredAction(args);
    const allowed = {
      get: ['action', 'textbook_id', 'page', 'page_size'],
      add: ['action', 'textbook_id', 'page_number', 'title', 'expected_updated_at'],
      remove: ['action', 'textbook_id', 'bookmark_id', 'expected_updated_at'],
      update: ['action', 'textbook_id', 'bookmark_id', 'page_number', 'title', 'expected_updated_at'],
    }[action];
    if (allowed === undefined) throw invalidArgument('action', 'expected get, add, remove, or update');
    const object = argumentsObject(args, allowed);
    const textbookId = requiredIdentifier(object, 'textbook_id');
    const database = this.vfsDb(context);
    const textbook = this.loadTextbook(database, textbookId);
    const bookmarks = parseAll(textbook.bookmarks, parseStoredBookmark, 'bookmark');

    if (action === 'get') {
      const [page, pageSize] = pagination(object);
      return paginatedAnnotations('bookmarks', bookmarks.map(bookmarkOutput), page, pageSize, textbook);
    }

    const expected = requiredString(object, 'expected_updated_at', 128);
    ensureExpectedRevision(textbook.updatedAt, expected, 'bookmarks', bookmarks.map(serializeBookmark));
    let previous: Bookmark | null;
    let changed: Bookmark;
    if (action === 'add') {
      if (bookmarks.length >= MAX_ANNOTATIONS) throw annotationLimit('bookmark');
      const page = requiredU32(object, 'page_number', 1, MAX_PAGE_NUMBER);
      validatePageNumber(page, textbook);
      if (bookmarks.some(bookmark => bookmark.page === page)) {
        throw toolError('BOOKMARK_PAGE_EXISTS', `Page ${page} already has a bookmark.`,
          'Update the existing bookmark instead of adding a duplicate.', false);
      }
      const title = requiredString(object, 'title', MAX_BOOKMARK_TITLE_CHARS);
      changed = { id: `bm-agent-${nanoid(16)}`, page, title, createdAt: this.deps.now() };
      previous = null;
      bookmarks.push(changed);
    } else if (action === 'remove') {
      const id = requiredIdentifier(object, 'bookmark_id');
      const index = bookmarks.findIndex(bookmark => bookmark.id === id);
      if (index < 0) throw annotationNotFound('bookmark', id);
      changed = { ...bookmarks[index]! };
      previous = { ...changed };
      bookmarks.splice(index, 1);
    } else {
      const id = requiredIdentifier(object, 'bookmark_id');
      const index = bookmarks.findIndex(bookmark => bookmark.id === id);
      if (index < 0) throw annotationNotFound('bookmark', id);
      const current = bookmarks[index]!;
      previous = { ...current };
      const page = optionalU32(object, 'page_number', 1, MAX_PAGE_NUMBER);
      const title = optionalString(object, 'title', MAX_BOOKMARK_TITLE_CHARS);
      if (page === null && title === null) {
        throw invalidArgument('update', 'provide at least one of page_number or title');
      }
      if (page !== null) {
        validatePageNumber(page, textbook);
        if (bookmarks.some((bookmark, other) => other !== index && bookmark.page === page)) {
          throw toolError('BOOKMARK_PAGE_EXISTS', `Page ${page} already has a bookmark.`,
            'Choose a page without a bookmark or update that bookmark.', false);
        }
        current.page = page;
      }
      if (title !== null) current.title = title;
      changed = { ...current };
    }

    let updated: VfsTextbook;
    try {
      updated = this.deps.repos().textbooks.replaceBookmarksIfVersion(
        database.getConnSafe(), textbookId, bookmarks.map(serializeBookmark), expected);
    } catch (error) { throw this.writeError(error, database, textbookId, 'bookmarks'); }
    this.emitChanged(updated, 'bookmarks', action);
    return annotationWriteOutput(action, 'bookmark', bookmarkOutput(changed),
      previous === null ? null : bookmarkOutput(previous), updated, bookmarks.length);
  }

  private executeHighlights(args: unknown, context: MediaToolContext): Record<string, unknown> {
    const action = requiredAction(args);
    const allowed = {
      get: ['action', 'textbook_id', 'page', 'page_size', 'page_index'],
      add: ['action', 'textbook_id', 'page_index', 'text', 'color', 'rects', 'expected_updated_at'],
      remove: ['action', 'textbook_id', 'highlight_id', 'expected_updated_at'],
      update: ['action', 'textbook_id', 'highlight_id', 'page_index', 'text', 'color', 'rects', 'expected_updated_at'],
    }[action];
    if (allowed === undefined) throw invalidArgument('action', 'expected get, add, remove, or update');
    const object = argumentsObject(args, allowed);
    const textbookId = requiredIdentifier(object, 'textbook_id');
    const database = this.vfsDb(context);
    const textbook = this.loadTextbook(database, textbookId);
    const highlights = parseAll(textbook.highlights, parseStoredHighlight, 'highlight');

    if (action === 'get') {
      const [page, pageSize] = pagination(object);
      const filterPage = optionalU32(object, 'page_index', 0, MAX_PAGE_NUMBER);
      if (filterPage !== null) validatePageIndex(filterPage, textbook);
      const items = highlights
        .filter(highlight => filterPage === null || highlight.pageIndex === filterPage)
        .map(highlightOutput);
      return paginatedAnnotations('highlights', items, page, pageSize, textbook);
    }

    const expected = requiredString(object, 'expected_updated_at', 128);
    ensureExpectedRevision(textbook.updatedAt, expected, 'highlights', highlights.map(serializeHighlight));
    let previous: Highlight | null;
    let changed: Highlight;
    if (action === 'add') {
      if (highlights.length >= MAX_ANNOTATIONS) throw annotationLimit('highlight');
      const pageIndex = requiredU32(object, 'page_index', 0, MAX_PAGE_NUMBER);
      validatePageIndex(pageIndex, textbook);
      changed = {
        id: `hl-agent-${nanoid(16)}`,
        pageIndex,
        text: requiredString(object, 'text', MAX_HIGHLIGHT_TEXT_CHARS),
        color: requiredHighlightColor(object),
        rects: requiredRects(object),
        createdAt: this.deps.now(),
        coordVersion: 2,
      };
      previous = null;
      highlights.push(changed);
    } else if (action === 'remove') {
      const id = requiredIdentifier(object, 'highlight_id');
      const index = highlights.findIndex(highlight => highlight.id === id);
      if (index < 0) throw annotationNotFound('highlight', id);
      changed = { ...highlights[index]! };
      previous = { ...changed };
      highlights.splice(index, 1);
    } else {
      const id = requiredIdentifier(object, 'highlight_id');
      const index = highlights.findIndex(highlight => highlight.id === id);
      if (index < 0) throw annotationNotFound('highlight', id);
      const current = highlights[index]!;
      previous = { ...current };
      const pageIndex = optionalU32(object, 'page_index', 0, MAX_PAGE_NUMBER);
      const text = optionalString(object, 'text', MAX_HIGHLIGHT_TEXT_CHARS);
      const color = optionalHighlightColor(object);
      const rects = optionalRects(object);
      if (pageIndex === null && text === null && color === null && rects === null) {
        throw invalidArgument('update', 'provide at least one of page_index, text, color, or rects');
      }
      if (pageIndex !== null) {
        validatePageIndex(pageIndex, textbook);
        current.pageIndex = pageIndex;
      }
      if (text !== null) current.text = text;
      if (color !== null) current.color = color;
      if (rects !== null) current.rects = rects;
      current.coordVersion = 2;
      changed = { ...current };
    }

    let updated: VfsTextbook;
    try {
      updated = this.deps.repos().textbooks.replaceHighlightsIfVersion(
        database.getConnSafe(), textbookId, highlights.map(serializeHighlight), expected);
    } catch (error) { throw this.writeError(error, database, textbookId, 'highlights'); }
    this.emitChanged(updated, 'highlights', action);
    return annotationWriteOutput(action, 'highlight', highlightOutput(changed),
      previous === null ? null : highlightOutput(previous), updated, highlights.length);
  }

  private async executePdfPageImage(args: unknown, context: MediaToolContext): Promise<Record<string, unknown>> {
    const object = argumentsObject(args, ['resource_id', 'page_index']);
    const resourceId = requiredIdentifier(object, 'resource_id');
    if (!resourceId.startsWith('res_')) {
      throw invalidArgument('resource_id', "expected a VFS resource ID beginning with 'res_'");
    }
    const pageIndex = requiredU32(object, 'page_index', 0, MAX_PAGE_NUMBER);
    const database = this.vfsDb(context);
    let source: PdfPageImageBytes;
    try {
      const repos = this.deps.repos();
      source = await readPdfPageImageBytes({
        conn: () => database.getConnSafe(),
        resources: repos.resources,
        blobs: repos.blobs,
        blobsDir: () => database.blobsDir(),
        hostFiles: this.deps.hostFiles,
      }, resourceId, pageIndex, MAX_IMAGE_SOURCE_BYTES);
    } catch (error) {
      throw toolError('PDF_PAGE_IMAGE_NOT_AVAILABLE', errorText(error),
        'Check that the resource is a processed PDF and that page_index is zero-based.', false);
    }
    const image = this.deps.image();
    if (image === null) {
      throw toolError('DEPENDENCY_UNAVAILABLE', 'The native image service is unavailable.',
        'Retry after the desktop app finishes starting.', true);
    }
    const bounded = await fitImageForTool(image, source.bytes, source.mimeType);
    const base64 = toBase64(bounded.bytes);
    if (base64.length > MAX_IMAGE_OUTPUT_BASE64_CHARS) {
      throw toolError('PDF_PAGE_IMAGE_TOO_LARGE', 'The bounded page image still exceeds the tool output limit.',
        'Rebuild the PDF preview or use OCR text for this page.', false);
    }
    return {
      resource_id: resourceId,
      page_index: pageIndex,
      mime_type: bounded.mimeType,
      width: bounded.width,
      height: bounded.height,
      size_bytes: bounded.bytes.byteLength,
      original_size_bytes: source.bytes.byteLength,
      stored_size_bytes: source.storedSize,
      compressed: bounded.compressed,
      image_url: `data:${bounded.mimeType};base64,${base64}`,
      image_url_chars: base64.length + bounded.mimeType.length + 13,
      truncated: false,
      message_key: 'chat.tools.textbook_pdf.page_image.success',
    };
  }
}
