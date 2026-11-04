/**
 * Stage C2 pure vector clipboard.
 *
 * Wire payload (exact keys):
 *   { format: 'deep-student.ink-clipboard', version: 1,
 *     origin: InkPoint, bounds: InkRect,
 *     objects: Array<{ index: number; content: InkObjectContent }> }
 *
 * The wire carries vector content and sequence indices only. Source ids,
 * author, created_at, document paths, receipts, and other authority metadata
 * are prohibited even though each entry is object-shaped.
 *
 * serialize: origin = bounds top-left; bounds come from control geometry only
 * (stroke samples, text/rect/ellipse/region rects, arrow endpoints) with no
 * stroke-width padding. Empty input throws RangeError.
 *
 * parse (untrusted text): 8 MiB UTF-8 cap (matching the existing page byte
 * budget) before parsing; duplicate JSON keys and unknown keys at every level
 * are rejected; format/version, finite signed coordinates up to ±10M, colors,
 * widths, pressures, UTF-8, monotonic elapsed_ms, and text/object/sample
 * capacity are enforced. Validation is all-or-none and returns rebuilt payload
 * objects only (no source metadata).
 *
 * paste: fresh unique ids, author 'user', fresh caller-time timestamp; source
 * content never grants authority. Default offset { x: 16, y: 16 }; center is
 * mutually exclusive with offset. Fixed pages translate the whole selection;
 * points are never clamped or scaled. If the full visible footprint (including
 * stroke width and arrow head) does not fit pageRef, throw RangeError before
 * producing anything. Inputs are never mutated. One undo/journal unit remains
 * the caller's responsibility.
 */
import { MIN_STROKE_WIDTH } from './geometryPrimitives';
import { INK_LIMITS } from './types';
import type {
  InkObject,
  InkObjectContent,
  InkPage,
  InkPageRef,
  InkPoint,
  InkRect,
  InkSample,
  InkStrokeStyle,
} from './types';

export const INK_CLIPBOARD_FORMAT = 'deep-student.ink-clipboard' as const;
export const INK_CLIPBOARD_VERSION = 1 as const;
export const INK_CLIPBOARD_MAX_BYTES = 8 * 1024 * 1024;
/** Signed logical coordinate bound shared with future board placement. */
export const INK_CLIPBOARD_COORD_MAX = 10_000_000;

const COORD_MAX = INK_CLIPBOARD_COORD_MAX;
const MAX_JSON_DEPTH = 64;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const FORMAT = INK_CLIPBOARD_FORMAT;
const VERSION = INK_CLIPBOARD_VERSION;

export interface InkClipboardObject {
  index: number;
  content: InkObjectContent;
}

export interface InkClipboardPayload {
  format: typeof INK_CLIPBOARD_FORMAT;
  version: typeof INK_CLIPBOARD_VERSION;
  origin: InkPoint;
  bounds: InkRect;
  objects: InkClipboardObject[];
}

export interface InkPastePlacement {
  page: InkPage;
  pageRef: InkPageRef;
  center?: InkPoint;
  offset?: InkPoint;
}

/** Geometry-only paste failure: the visible footprint cannot fit the fixed page. */
export class InkPasteGeometryError extends RangeError {
  readonly code = 'INK_PASTE_TOO_LARGE' as const;

  constructor(message = 'Paste content exceeds the target page') {
    super(message);
    this.name = 'InkPasteGeometryError';
  }
}

const PASTE_ID_ATTEMPTS = 16;

function randomPasteToken(): string {
  const cryptoApi = (globalThis as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: (values: Uint32Array) => Uint32Array;
    };
  }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Fall through to the nonce sources below.
    }
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    const values = new Uint32Array(2);
    cryptoApi.getRandomValues(values);
    return `${values[0].toString(36)}${values[1].toString(36)}`;
  }
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

function pageSampleTotal(objects: InkObject[]): number {
  let total = 0;
  for (const object of objects) {
    if (object.content.kind === 'stroke') total += object.content.samples.length;
  }
  return total;
}

function invalid(): never {
  throw new RangeError('Invalid clipboard');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value)) invalid();
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
  for (const key of required) {
    if (!hasOwn(value, key)) invalid();
  }
  return value;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function finiteIn(value: unknown, min: number, max: number): number {
  if (!finiteNumber(value) || value < min || value > max) invalid();
  return value;
}

function readCoord(value: unknown): number {
  return finiteIn(value, -COORD_MAX, COORD_MAX);
}

function readWidth(value: unknown): number {
  return finiteIn(value, Number.MIN_VALUE, INK_LIMITS.width_max);
}

function readColor(value: unknown): string {
  if (typeof value !== 'string' || !wellFormed(value) || !HEX_COLOR.test(value)) invalid();
  return value;
}

function readPoint(value: unknown): InkPoint {
  const record = exactKeys(value, ['x', 'y']);
  return { x: readCoord(record.x), y: readCoord(record.y) };
}

function readRect(value: unknown, allowZeroExtent: boolean): InkRect {
  const record = exactKeys(value, ['x', 'y', 'width', 'height']);
  const x = readCoord(record.x);
  const y = readCoord(record.y);
  if (!finiteNumber(record.width) || !finiteNumber(record.height)) invalid();
  const width = record.width;
  const height = record.height;
  if (allowZeroExtent ? width < 0 || height < 0 : width <= 0 || height <= 0) invalid();
  if (x + width > COORD_MAX || y + height > COORD_MAX) invalid();
  return { x, y, width, height };
}

function readText(value: unknown): string {
  if (typeof value !== 'string' || value.length > INK_LIMITS.text_max_chars || !wellFormed(value)) {
    invalid();
  }
  return value;
}

function wellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function readStrokeContent(value: Record<string, unknown>): InkObjectContent {
  const record = exactKeys(value, ['kind', 'samples', 'style']);
  if (!Array.isArray(record.samples) || record.samples.length === 0
    || record.samples.length > INK_LIMITS.page_samples_max) invalid();

  let previousElapsed = Number.NEGATIVE_INFINITY;
  const samples: InkSample[] = record.samples.map((raw) => {
    const sample = exactKeys(raw, ['x', 'y', 'pressure'], ['elapsed_ms']);
    const result: InkSample = {
      x: readCoord(sample.x),
      y: readCoord(sample.y),
      pressure: finiteIn(sample.pressure, 0, 1),
    };
    if (hasOwn(sample, 'elapsed_ms')) {
      const elapsed = finiteIn(sample.elapsed_ms, 0, Number.MAX_SAFE_INTEGER);
      if (elapsed < previousElapsed) invalid();
      previousElapsed = elapsed;
      result.elapsed_ms = elapsed;
    }
    return result;
  });

  const style = exactKeys(record.style, ['tool', 'color', 'width', 'pressure_enabled']);
  if (style.tool !== 'pen' && style.tool !== 'highlighter') invalid();
  if (typeof style.pressure_enabled !== 'boolean') invalid();
  const tool: InkStrokeStyle['tool'] = style.tool === 'pen' ? 'pen' : 'highlighter';
  return {
    kind: 'stroke',
    samples,
    style: {
      tool,
      color: readColor(style.color),
      width: readWidth(style.width),
      pressure_enabled: style.pressure_enabled,
    },
  };
}

function readContent(value: unknown): InkObjectContent {
  if (!isRecord(value)) invalid();
  switch (value.kind) {
    case 'stroke':
      return readStrokeContent(value);
    case 'text': {
      const record = exactKeys(value, ['kind', 'rect', 'text', 'font_size', 'color']);
      return {
        kind: 'text',
        rect: readRect(record.rect, false),
        text: readText(record.text),
        font_size: finiteIn(record.font_size, INK_LIMITS.font_size_min, INK_LIMITS.font_size_max),
        color: readColor(record.color),
      };
    }
    case 'rect':
    case 'ellipse':
    case 'region_highlight': {
      const record = exactKeys(value, ['kind', 'rect', 'color', 'width']);
      return {
        kind: value.kind,
        rect: readRect(record.rect, false),
        color: readColor(record.color),
        width: readWidth(record.width),
      };
    }
    case 'arrow': {
      const record = exactKeys(value, ['kind', 'from', 'to', 'color', 'width']);
      return {
        kind: 'arrow',
        from: readPoint(record.from),
        to: readPoint(record.to),
        color: readColor(record.color),
        width: readWidth(record.width),
      };
    }
    default:
      invalid();
  }
}

function boundsOfPoints(points: InkPoint[]): InkRect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function controlBounds(content: InkObjectContent): InkRect {
  switch (content.kind) {
    case 'stroke':
      return boundsOfPoints(content.samples);
    case 'text':
    case 'rect':
    case 'ellipse':
    case 'region_highlight':
      return { ...content.rect };
    case 'arrow':
      return boundsOfPoints([content.from, content.to]);
  }
}

function unionBounds(left: InkRect, right: InkRect): InkRect {
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  const maxX = Math.max(left.x + left.width, right.x + right.width);
  const maxY = Math.max(left.y + left.height, right.y + right.height);
  return { x, y, width: maxX - x, height: maxY - y };
}

function boundsOfContents(contents: InkObjectContent[]): InkRect {
  if (contents.length === 0) invalid();
  let bounds = controlBounds(contents[0]);
  for (let index = 1; index < contents.length; index += 1) {
    bounds = unionBounds(bounds, controlBounds(contents[index]));
  }
  return bounds;
}

function expandBounds(rect: InkRect, padding: number): InkRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function visibleContentBounds(content: InkObjectContent): InkRect {
  const bounds = controlBounds(content);
  switch (content.kind) {
    case 'stroke':
      // The renderer floors every painted sample at MIN_STROKE_WIDTH; padding
      // by the raw style width would clip the visible rim at the page edge.
      return expandBounds(bounds, Math.max(content.style.width, MIN_STROKE_WIDTH) / 2);
    case 'rect':
    case 'ellipse':
      return expandBounds(bounds, content.width / 2);
    case 'arrow': {
      const angle = Math.atan2(content.to.y - content.from.y, content.to.x - content.from.x);
      const headLength = Math.max(8, content.width * 4);
      const points: InkPoint[] = [content.from, content.to];
      for (const side of [-1, 1]) {
        points.push({
          x: content.to.x - headLength * Math.cos(angle + (side * Math.PI) / 6),
          y: content.to.y - headLength * Math.sin(angle + (side * Math.PI) / 6),
        });
      }
      return expandBounds(boundsOfPoints(points), content.width / 2);
    }
    case 'text':
    case 'region_highlight':
      return bounds;
  }
}

function visibleBoundsOfContents(contents: InkObjectContent[]): InkRect {
  if (contents.length === 0) invalid();
  let bounds = visibleContentBounds(contents[0]);
  for (let index = 1; index < contents.length; index += 1) {
    bounds = unionBounds(bounds, visibleContentBounds(contents[index]));
  }
  return bounds;
}

function sameRect(left: InkRect, right: InkRect): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height;
}

function sanitizePayload(value: unknown): InkClipboardPayload {
  const record = exactKeys(value, ['format', 'version', 'origin', 'bounds', 'objects']);
  if (record.format !== FORMAT || record.version !== VERSION) invalid();

  const bounds = readRect(record.bounds, true);
  const origin = readPoint(record.origin);
  if (origin.x !== bounds.x || origin.y !== bounds.y) invalid();

  if (!Array.isArray(record.objects) || record.objects.length === 0
    || record.objects.length > INK_LIMITS.page_objects_max) invalid();

  let sampleTotal = 0;
  const objects: InkClipboardObject[] = [];
  for (let index = 0; index < record.objects.length; index += 1) {
    const item = exactKeys(record.objects[index], ['index', 'content']);
    if (item.index !== index) invalid();
    const content = readContent(item.content);
    if (content.kind === 'stroke') sampleTotal += content.samples.length;
    objects.push({ index, content });
  }
  if (sampleTotal > INK_LIMITS.page_samples_max) invalid();

  const computed = boundsOfContents(objects.map((object) => object.content));
  if (!sameRect(computed, bounds)) invalid();

  return { format: FORMAT, version: VERSION, origin: { x: bounds.x, y: bounds.y }, bounds, objects };
}

function translateRect(rect: InkRect, dx: number, dy: number): InkRect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

function translateContent(content: InkObjectContent, dx: number, dy: number): InkObjectContent {
  switch (content.kind) {
    case 'stroke':
      return {
        ...content,
        samples: content.samples.map((sample) => ({ ...sample, x: sample.x + dx, y: sample.y + dy })),
        style: { ...content.style },
      };
    case 'text':
      return { ...content, rect: translateRect(content.rect, dx, dy) };
    case 'rect':
    case 'ellipse':
    case 'region_highlight':
      return { ...content, rect: translateRect(content.rect, dx, dy) };
    case 'arrow':
      return {
        ...content,
        from: { x: content.from.x + dx, y: content.from.y + dy },
        to: { x: content.to.x + dx, y: content.to.y + dy },
      };
  }
}

export function serializeInkClipboard(objects: InkObject[]): string {
  if (!Array.isArray(objects) || objects.length === 0
    || objects.length > INK_LIMITS.page_objects_max) invalid();

  let sampleTotal = 0;
  const contents: InkObjectContent[] = [];
  for (const object of objects) {
    if (!isRecord(object) || !hasOwn(object, 'content')) invalid();
    const content = readContent(object.content);
    if (content.kind === 'stroke') sampleTotal += content.samples.length;
    contents.push(content);
  }
  if (sampleTotal > INK_LIMITS.page_samples_max) invalid();

  const bounds = boundsOfContents(contents);
  const payload: InkClipboardPayload = {
    format: FORMAT,
    version: VERSION,
    origin: { x: bounds.x, y: bounds.y },
    bounds,
    objects: contents.map((content, index) => ({ index, content })),
  };

  const text = JSON.stringify(payload);
  if (utf8ByteLength(text) > INK_CLIPBOARD_MAX_BYTES) invalid();
  return text;
}

export function parseInkClipboard(text: string): InkClipboardPayload {
  if (typeof text !== 'string' || !wellFormed(text)) invalid();
  if (utf8ByteLength(text) > INK_CLIPBOARD_MAX_BYTES) invalid();
  assertNoDuplicateKeys(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    invalid();
  }
  return sanitizePayload(parsed);
}

export function pasteInkClipboard(payload: InkClipboardPayload, placement: InkPastePlacement): InkPage {
  const safe = sanitizePayload(payload);
  if (!placement || typeof placement !== 'object') invalid();

  const page = placement.page;
  const pageRef = placement.pageRef;
  if (!page || typeof page !== 'object' || !Array.isArray(page.objects)) invalid();
  if (!pageRef || !finiteNumber(pageRef.width) || !finiteNumber(pageRef.height)
    || pageRef.width <= 0 || pageRef.height <= 0) invalid();

  // The target page and the pasted batch share one object and sample budget.
  if (page.objects.length + safe.objects.length > INK_LIMITS.page_objects_max) invalid();
  let pastedSampleTotal = 0;
  for (const object of safe.objects) {
    if (object.content.kind === 'stroke') pastedSampleTotal += object.content.samples.length;
  }
  if (pageSampleTotal(page.objects) + pastedSampleTotal > INK_LIMITS.page_samples_max) invalid();

  const hasCenter = placement.center !== undefined;
  const hasOffset = placement.offset !== undefined;
  if (hasCenter && hasOffset) invalid();

  let dx: number;
  let dy: number;
  if (hasCenter) {
    const center = readPoint(placement.center);
    dx = center.x - (safe.bounds.x + safe.bounds.width / 2);
    dy = center.y - (safe.bounds.y + safe.bounds.height / 2);
  } else {
    const offset = hasOffset ? readPoint(placement.offset) : { x: 16, y: 16 };
    dx = offset.x;
    dy = offset.y;
  }

  const visible = visibleBoundsOfContents(safe.objects.map((object) => object.content));
  const pageWidth = pageRef.width;
  const pageHeight = pageRef.height;
  if (visible.width > pageWidth || visible.height > pageHeight) throw new InkPasteGeometryError();

  const left = visible.x + dx;
  const top = visible.y + dy;
  if (left < 0) dx -= left;
  else if (left + visible.width > pageWidth) dx -= left + visible.width - pageWidth;
  if (top < 0) dy -= top;
  else if (top + visible.height > pageHeight) dy -= top + visible.height - pageHeight;

  const timestamp = Date.now();
  const targetIds = new Set(page.objects.map((object) => object.id));
  const batchIds = new Set<string>();

  const pasted: InkObject[] = safe.objects.map((object, index) => {
    let id = '';
    // Bounded collision retry: random tokens are checked against existing target
    // ids and ids already issued in this batch, never looped forever.
    for (let attempt = 0; attempt < PASTE_ID_ATTEMPTS; attempt += 1) {
      const candidate = `ink-paste-${randomPasteToken()}-${index}`;
      if (!targetIds.has(candidate) && !batchIds.has(candidate)) {
        id = candidate;
        batchIds.add(candidate);
        break;
      }
    }
    if (id === '') invalid();
    return {
      id,
      author: 'user',
      created_at: timestamp,
      content: translateContent(object.content, dx, dy),
    };
  });

  const pageCandidate: InkPage = {
    schema_version: page.schema_version,
    page_id: page.page_id,
    objects: [...page.objects, ...pasted],
  };

  let serialized = '';
  try {
    serialized = JSON.stringify(pageCandidate);
  } catch {
    invalid();
  }
  if (utf8ByteLength(serialized) > INK_LIMITS.page_max_bytes) invalid();
  return pageCandidate;
}

/**
 * Minimal recursive JSON scanner. JSON.parse silently keeps the last duplicate
 * key, so duplicate detection must read the raw text before parsing.
 */
function assertNoDuplicateKeys(text: string): void {
  let index = 0;

  const fail = (): never => invalid();

  const skipWhitespace = (): void => {
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) index += 1;
      else break;
    }
  };

  const readString = (): string => {
    if (text[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index));
        } catch {
          fail();
        }
      }
      if (code === 0x5c) {
        index += 2;
        continue;
      }
      if (code < 0x20) fail();
      index += 1;
    }
    fail();
  };

  const readPrimitive = (): void => {
    const start = index;
    while (index < text.length) {
      const char = text[index];
      if (char === ',' || char === ']' || char === '}' || char === ' '
        || char === '\t' || char === '\n' || char === '\r') break;
      index += 1;
    }
    if (index === start) fail();
  };

  const parseValue = (depth: number): void => {
    if (depth > MAX_JSON_DEPTH) fail();
    skipWhitespace();
    const char = text[index];
    if (char === '{') parseObject(depth + 1);
    else if (char === '[') parseArray(depth + 1);
    else if (char === '"') readString();
    else readPrimitive();
  };

  const parseArray = (depth: number): void => {
    index += 1;
    skipWhitespace();
    if (text[index] === ']') {
      index += 1;
      return;
    }
    while (true) {
      parseValue(depth);
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === ']') {
        index += 1;
        return;
      }
      fail();
    }
  };

  const parseObject = (depth: number): void => {
    index += 1;
    skipWhitespace();
    if (text[index] === '}') {
      index += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      skipWhitespace();
      const key = readString();
      if (keys.has(key)) fail();
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ':') fail();
      index += 1;
      parseValue(depth);
      skipWhitespace();
      if (text[index] === ',') {
        index += 1;
        continue;
      }
      if (text[index] === '}') {
        index += 1;
        return;
      }
      fail();
    }
  };

  parseValue(0);
  skipWhitespace();
  if (index !== text.length) fail();
}
