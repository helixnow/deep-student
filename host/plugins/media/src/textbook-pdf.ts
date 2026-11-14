/**
 * `src/chat_v2/tools/textbook_pdf_executor.rs`: argument validation, annotation
 * paging/truncation and the optimistic-concurrency conflict payload for the
 * textbook PDF tools. The executor itself is `tools/textbook-pdf-executor.ts`.
 */
import { stripToolNamespace } from './document-processing.ts';

export const MAX_ANNOTATIONS = 500;
export const MAX_TOOL_STRING_CHARS = 2_000;
export const MAX_PAGE_SIZE = 20;

export const BOOKMARKS_TOOL = 'textbook_bookmarks';
export const HIGHLIGHTS_TOOL = 'textbook_highlights';
export const PDF_PAGE_IMAGE_TOOL = 'pdf_page_image';

export interface HighlightRect { x: number; y: number; width: number; height: number }
export interface Highlight {
  id: string;
  pageIndex: number;
  text: string;
  color: string;
  rects: HighlightRect[];
  createdAt: number;
  coordVersion?: number | null;
}

export type ToolSensitivity = 'low' | 'medium';

export function sensitivityLevel(toolName: string): ToolSensitivity {
  const name = stripToolNamespace(toolName);
  if (name === BOOKMARKS_TOOL || name === HIGHLIGHTS_TOOL) return 'medium';
  if (name === PDF_PAGE_IMAGE_TOOL) return 'low';
  return 'medium';
}

export function sensitivityLevelForCall(
  toolName: string,
  args: Record<string, unknown>,
): ToolSensitivity {
  const name = stripToolNamespace(toolName);
  if (name === PDF_PAGE_IMAGE_TOOL) return 'low';
  if (name === BOOKMARKS_TOOL || name === HIGHLIGHTS_TOOL) {
    return args.action === 'get' ? 'low' : 'medium';
  }
  return 'medium';
}

export function hasDynamicSensitivity(toolName: string): boolean {
  const name = stripToolNamespace(toolName);
  return name === BOOKMARKS_TOOL || name === HIGHLIGHTS_TOOL;
}

/** `chars().take(n)` — code points, not UTF-16 units. */
export function boundedString(value: string): [string, boolean] {
  const chars = [...value];
  const truncated = chars.length > MAX_TOOL_STRING_CHARS;
  return [chars.slice(0, MAX_TOOL_STRING_CHARS).join(''), truncated];
}

function boundJsonValue(value: unknown): [unknown, boolean] {
  if (typeof value === 'string') {
    const [bounded, truncated] = boundedString(value);
    return [truncated ? bounded : value, truncated];
  }
  if (Array.isArray(value)) {
    let any = false;
    for (let i = 0; i < value.length; i += 1) {
      const [next, truncated] = boundJsonValue(value[i]);
      if (truncated) { value[i] = next; any = true; }
    }
    return [value, any];
  }
  if (typeof value === 'object' && value !== null) {
    let any = false;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const [next, truncated] = boundJsonValue(record[key]);
      if (truncated) { record[key] = next; any = true; }
    }
    return [value, any];
  }
  return [value, false];
}

/** 递归截断 JSON 中的字符串；返回是否发生截断。就地修改。 */
export function boundJsonStringsInPlace(value: unknown): boolean {
  return boundJsonValue(value)[1];
}

/** `tool_error_with_fields`: the JSON error string every textbook/PDF tool returns. */
export function toolError(
  code: string,
  message: string,
  hint: string,
  retryable: boolean,
  fields: Record<string, unknown> = {},
): Error {
  const [bounded] = boundedString(message);
  return new Error(JSON.stringify({
    code,
    message: bounded,
    message_truncated: boundedString(message)[1],
    message_key: `chat.tools.textbook_pdf.errors.${code.toLowerCase()}`,
    hint,
    retryable,
    ...fields,
  }));
}

export function invalidArgument(field: string, reason: string): Error {
  return toolError('INVALID_ARGUMENT', `Invalid '${field}': ${reason}.`,
    'Correct the arguments to match the tool schema.', false);
}

export function argumentsObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidArgument('arguments', 'expected a JSON object');
  }
  const object = value as Record<string, unknown>;
  const unknown = Object.keys(object).find(key => !allowed.includes(key));
  if (unknown !== undefined) {
    throw invalidArgument(unknown, 'unknown field; use only fields declared by the tool schema');
  }
  return object;
}

export function parseRect(value: unknown, index: number): HighlightRect {
  const object = argumentsObject(value, ['x', 'y', 'width', 'height']);
  for (const field of ['x', 'y', 'width', 'height']) {
    if (!Object.prototype.hasOwnProperty.call(object, field)) {
      throw invalidArgument('rects', `rects[${index}].${field} is required`);
    }
  }
  const number = (field: string): number => {
    const raw = object[field];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw invalidArgument('rects', `rects[${index}].${field} must be a finite number`);
    }
    return raw;
  };
  const rect: HighlightRect = {
    x: number('x'), y: number('y'), width: number('width'), height: number('height'),
  };
  if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0
    || rect.x + rect.width > 1.000_001 || rect.y + rect.height > 1.000_001) {
    throw invalidArgument('rects', `rects[${index}] must fit within normalized page coordinates 0..1`);
  }
  return rect;
}

export interface Bookmark { id: string; page: number; title: string; createdAt: number }

export function bookmarkOutput(bookmark: Bookmark): Record<string, unknown> {
  const [title, titleTruncated] = boundedString(bookmark.title);
  return {
    id: bookmark.id,
    page: bookmark.page,
    title,
    title_truncated: titleTruncated,
    createdAt: bookmark.createdAt,
  };
}

export function highlightOutput(highlight: Highlight): Record<string, unknown> {
  const [text, textTruncated] = boundedString(highlight.text);
  return {
    id: highlight.id,
    pageIndex: highlight.pageIndex,
    text,
    text_truncated: textTruncated,
    color: highlight.color,
    rects: highlight.rects,
    createdAt: highlight.createdAt,
    coordVersion: highlight.coordVersion ?? null,
  };
}

function annotationHasTruncation(value: Record<string, unknown>): boolean {
  return Object.entries(value).some(([key, item]) => key.endsWith('_truncated') && item === true);
}

export function paginatedAnnotations(
  kind: string,
  items: Record<string, unknown>[],
  page: number,
  pageSize: number,
  textbook: { id: string; updatedAt: string },
): Record<string, unknown> {
  const total = items.length;
  const start = Math.min(Math.max(page - 1, 0) * pageSize, total);
  const end = Math.min(start + pageSize, total);
  const pageItems = items.slice(start, end);
  return {
    textbook_id: textbook.id,
    kind,
    items: pageItems,
    total,
    page,
    page_size: pageSize,
    has_more: end < total,
    updated_at: textbook.updatedAt,
    truncated: pageItems.some(annotationHasTruncation),
    message_key: 'chat.tools.textbook_pdf.annotations_get.success',
  };
}

/** 版本不一致时抛出 `ANNOTATION_CONFLICT` 错误 JSON。 */
export function ensureExpectedRevision(
  textbookUpdatedAt: string,
  expected: string,
  kind: string,
  current: readonly unknown[],
): void {
  if (textbookUpdatedAt === expected) return;
  const value = JSON.parse(JSON.stringify(current)) as unknown;
  const truncated = boundJsonStringsInPlace(value);
  throw toolError('ANNOTATION_CONFLICT',
    `Textbook annotations changed (expected ${expected}, current ${textbookUpdatedAt}).`,
    'Re-read the annotations, review the current value, and ask before replacing conflicting edits.',
    false,
    {
      kind,
      current_updated_at: textbookUpdatedAt,
      current: value,
      current_truncated: truncated,
    });
}
