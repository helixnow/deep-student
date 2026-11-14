/**
 * Cross-Plugin Interop Protocol v1 contracts, canonical `ds-anchor://v1/...`
 * URI serialization/parsing, excerpt drag payload sanitization, and backlink
 * edge record derivation.
 *
 * Pure module: zero framework or feature dependencies so it runs identically
 * in Node and browser environments.
 */

export const DS_ANCHOR_SCHEME = 'ds-anchor:';
export const DS_ANCHOR_VERSION = 'v1';
export const DS_EXCERPT_MIME = 'application/x-deepstudent-excerpt';

const DS_ANCHOR_PREFIX = 'ds-anchor://v1/';
const MAX_ANCHOR_URI_LENGTH = 2048;
const MAX_RESOURCE_ID_LENGTH = 256;
const MAX_NAMESPACE_LENGTH = 128;
const MAX_SUB_ID_LENGTH = 128;
const MAX_LOCATOR_LENGTH = 512;
const MAX_PDF_PAGE = 100_000;
const MAX_MEDIA_MS = 86_400_000 * 7;
const MAX_QUOTE_CODE_POINTS = 240;
const MAX_LABEL_CODE_POINTS = 120;
const MAX_EXCERPT_TEXT_CODE_POINTS = 4000;
const MAX_IMAGE_DATA_URL_LENGTH = 10 * 1024 * 1024;
const RECT_EPSILON = 1e-6;

// eslint-disable-next-line no-control-regex
const ASCII_CONTROL_RE = /[\x00-\x1f\x7f]/;
// eslint-disable-next-line no-control-regex
const ASCII_CONTROL_GLOBAL_RE = /[\x00-\x1f\x7f]+/g;
// Preserve \t (\x09) and \n (\x0a) inside multi-line excerpt text bodies.
// eslint-disable-next-line no-control-regex
const EXCERPT_TEXT_CONTROL_GLOBAL_RE = /[\x00-\x08\x0b-\x1f\x7f]+/g;

const utf8Encoder = new TextEncoder();

/** Normalized 2D bounding box in [0, 1] page/frame coordinates (top-left origin). */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SemanticAnchorKind =
  | 'pdf'
  | 'media'
  | 'note'
  | 'mindmap'
  | 'qbank'
  | 'epub'
  | 'custom';

export interface SemanticAnchorBase {
  kind: SemanticAnchorKind;
  /** Primary resource identifier (VFS resourceId, noteId, mindmapId, cardId, etc.). */
  resourceId: string;
  /** Optional secondary VFS/DSTU alias ID for cross-store lookup. */
  aliasResourceId?: string;
  /** Optional human-readable title of the resource (never trusted as HTML). */
  label?: string;
}

export interface PdfSemanticAnchor extends SemanticAnchorBase {
  kind: 'pdf';
  /** 1-based page number (>= 1). */
  page: number;
  /** Optional normalized bounding box in [0, 1] (coordVersion 2). */
  rect?: NormalizedRect;
  /** Optional short text quote for fallback text-layer highlight (<= 240 chars). */
  quote?: string;
}

export interface MediaSemanticAnchor extends SemanticAnchorBase {
  kind: 'media';
  /** Start timestamp in integer milliseconds (>= 0). */
  startMs: number;
  /** Optional end timestamp in integer milliseconds (>= startMs). */
  endMs?: number;
  /** Optional transcript cue snippet (<= 240 chars). */
  quote?: string;
}

export interface NoteSemanticAnchor extends SemanticAnchorBase {
  kind: 'note';
  /** Stable ProseMirror block ID from blockIdentity (`blk_...`), if targeting a block. */
  blockId?: string;
  /** Optional heading slug fallback. */
  heading?: string;
}

export interface MindmapSemanticAnchor extends SemanticAnchorBase {
  kind: 'mindmap';
  nodeId?: string;
}

export interface QbankSemanticAnchor extends SemanticAnchorBase {
  kind: 'qbank';
  questionId?: string;
}

export interface EpubSemanticAnchor extends SemanticAnchorBase {
  kind: 'epub';
  cfi: string;
  quote?: string;
}

export interface CustomSemanticAnchor extends SemanticAnchorBase {
  kind: 'custom';
  namespace: string;
  locator: string;
  params?: Readonly<Record<string, string>>;
}

export type SemanticAnchor =
  | PdfSemanticAnchor
  | MediaSemanticAnchor
  | NoteSemanticAnchor
  | MindmapSemanticAnchor
  | QbankSemanticAnchor
  | EpubSemanticAnchor
  | CustomSemanticAnchor;

export type ExcerptContentKind = 'text' | 'region-image' | 'transcript-cue';

export interface ExcerptDragPayload {
  version: 1;
  excerptKind: ExcerptContentKind;
  /** Plain-text excerpt or OCR/caption text (<= 4000 chars). */
  text: string;
  /** Optional PNG/WebP data URL or vfs:// URI when dragging a captured PDF/video region. */
  imageDataUrl?: string;
  /** Canonical source anchor back to the exact PDF rect, media timestamp, or note block. */
  anchor: SemanticAnchor;
  /** Pre-serialized ds-anchor://v1/... URI (guaranteed consistent with `anchor`). */
  anchorUri: string;
  /** Human-readable source document/media title. */
  sourceTitle?: string;
  /** Unix ms when excerpt was created. */
  createdAt: number;
}

export type ExcerptDragInput = Omit<ExcerptDragPayload, 'version' | 'anchorUri' | 'createdAt'> & {
  createdAt?: number;
};

export type AnchorEdgeSourceKind = 'mindmap' | 'flashcard' | 'note' | 'qbank';

export interface AnchorEdgeUpsertInput {
  edgeId?: string;
  sourceKind: AnchorEdgeSourceKind;
  sourceResourceId: string;
  sourceSubId?: string;
  sourceAnchor: SemanticAnchor;
  sourceLabel?: string;
  targetAnchor: SemanticAnchor;
  studySpaceId?: string;
}

export interface AnchorEdgeRecord {
  edgeId: string;
  sourceKind: AnchorEdgeSourceKind;
  sourceResourceId: string;
  sourceSubId: string;
  sourceAnchorUri: string;
  sourceLabel: string;
  targetKind: SemanticAnchorKind;
  targetResourceId: string;
  targetLocatorKey: string;
  targetPage: number | null;
  targetStartMs: number | null;
  targetEndMs: number | null;
  targetRect: NormalizedRect | null;
  targetAnchorUri: string;
  studySpaceId: string | null;
  createdAt: number;
  updatedAt: number;
}

const FNV1A_64_OFFSET = 0xcbf29ce484222325n;
const FNV1A_64_PRIME = 0x100000001b3n;
const FNV1A_64_MASK = 0xffffffffffffffffn;

/** Deterministic 64-bit FNV-1a hash encoded as 16 lowercase hex digits. */
export function fnv1a64Hex(input: string): string {
  const bytes = utf8Encoder.encode(String(input));
  let hash = FNV1A_64_OFFSET;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= BigInt(bytes[i]);
    hash = (hash * FNV1A_64_PRIME) & FNV1A_64_MASK;
  }
  return hash.toString(16).padStart(16, '0');
}

function hasPathTraversalSegment(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment === '..' || segment === '.');
}

function sanitizeIdentifier(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  if (ASCII_CONTROL_RE.test(value)) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  if (hasPathTraversalSegment(trimmed)) return null;
  return trimmed;
}

function sanitizeToken(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(ASCII_CONTROL_GLOBAL_RE, '').trim();
  if (!cleaned) return undefined;
  const cps = Array.from(cleaned);
  return cps.length > maxLength ? cps.slice(0, maxLength).join('') : cleaned;
}

function truncateCleanCodePoints(value: unknown, maxCodePoints: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(ASCII_CONTROL_GLOBAL_RE, '').trim();
  if (!cleaned) return undefined;
  const cps = Array.from(cleaned);
  return cps.length > maxCodePoints ? cps.slice(0, maxCodePoints).join('') : cleaned;
}

function clamp01(n: number): number {
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/** Validates and clamps a NormalizedRect in [0, 1] with 1e-6 float drift tolerance. */
export function sanitizeNormalizedRect(rect: unknown): NormalizedRect | null {
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) return null;
  const candidate = rect as Record<string, unknown>;
  const { x, y, w, h } = candidate;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return null;
  }
  if (
    x < -RECT_EPSILON ||
    x > 1 + RECT_EPSILON ||
    y < -RECT_EPSILON ||
    y > 1 + RECT_EPSILON ||
    w <= 0 ||
    h <= 0 ||
    w > 1 + RECT_EPSILON ||
    h > 1 + RECT_EPSILON ||
    x + w > 1 + RECT_EPSILON ||
    y + h > 1 + RECT_EPSILON
  ) {
    return null;
  }
  const cx = clamp01(x);
  const cy = clamp01(y);
  const cw = Math.min(1 - cx, Math.max(0, w));
  const ch = Math.min(1 - cy, Math.max(0, h));
  if (cw <= 0 || ch <= 0) return null;
  return { x: cx, y: cy, w: cw, h: ch };
}

function formatNormalizedRectParam(rect: NormalizedRect): string | null {
  const sanitized = sanitizeNormalizedRect(rect);
  if (!sanitized) return null;
  const rx = Number(sanitized.x.toFixed(4));
  const ry = Number(sanitized.y.toFixed(4));
  let rw = Number(Math.min(1 - rx, sanitized.w).toFixed(4));
  let rh = Number(Math.min(1 - ry, sanitized.h).toFixed(4));
  if (rw <= 0 && rx <= 0.9999) rw = 0.0001;
  if (rh <= 0 && ry <= 0.9999) rh = 0.0001;
  if (rw <= 0 || rh <= 0 || rx + rw > 1 + RECT_EPSILON || ry + rh > 1 + RECT_EPSILON) {
    return null;
  }
  return `${rx.toFixed(4)},${ry.toFixed(4)},${rw.toFixed(4)},${rh.toFixed(4)}`;
}

function parseNormalizedRectParam(raw: string): NormalizedRect | null {
  const parts = raw.split(',');
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => {
    const trimmed = part.trim();
    if (!trimmed) return Number.NaN;
    return Number(trimmed);
  });
  return sanitizeNormalizedRect({
    x: nums[0],
    y: nums[1],
    w: nums[2],
    h: nums[3],
  });
}

function sanitizeCustomParams(
  params: unknown,
): Readonly<Record<string, string>> | undefined {
  if (params === undefined || params === null) return undefined;
  if (typeof params !== 'object' || Array.isArray(params)) return undefined;
  const entries = Object.entries(params as Record<string, unknown>);
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawVal] of entries) {
    if (count >= 16) break;
    if (typeof rawVal !== 'string') continue;
    const key = rawKey.replace(ASCII_CONTROL_GLOBAL_RE, '').trim();
    if (!key || key.length > 64) continue;
    const val = truncateCleanCodePoints(rawVal, 256) ?? '';
    out[key] = val;
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/** Validates and normalizes an in-memory SemanticAnchor object, returning null if invalid. */
export function sanitizeSemanticAnchor(input: unknown): SemanticAnchor | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  const kind = candidate.kind;
  const resourceId = sanitizeIdentifier(candidate.resourceId, MAX_RESOURCE_ID_LENGTH);
  if (!resourceId) return null;

  let aliasResourceId: string | undefined;
  if (candidate.aliasResourceId !== undefined && candidate.aliasResourceId !== '') {
    const cleanAlias = sanitizeIdentifier(candidate.aliasResourceId, MAX_RESOURCE_ID_LENGTH);
    if (!cleanAlias) return null;
    aliasResourceId = cleanAlias;
  }
  const label = truncateCleanCodePoints(candidate.label, MAX_LABEL_CODE_POINTS);
  const base = {
    resourceId,
    ...(aliasResourceId ? { aliasResourceId } : {}),
    ...(label ? { label } : {}),
  };

  switch (kind) {
    case 'pdf': {
      const page = candidate.page;
      if (
        typeof page !== 'number' ||
        !Number.isInteger(page) ||
        page < 1 ||
        page > MAX_PDF_PAGE
      ) {
        return null;
      }
      let rect: NormalizedRect | undefined;
      if (candidate.rect !== undefined && candidate.rect !== null) {
        const sanitizedRect = sanitizeNormalizedRect(candidate.rect);
        if (!sanitizedRect) return null;
        rect = sanitizedRect;
      }
      const quote = truncateCleanCodePoints(candidate.quote, MAX_QUOTE_CODE_POINTS);
      return {
        kind: 'pdf',
        ...base,
        page,
        ...(rect ? { rect } : {}),
        ...(quote ? { quote } : {}),
      };
    }
    case 'media': {
      const rawStart = candidate.startMs;
      if (
        typeof rawStart !== 'number' ||
        !Number.isFinite(rawStart) ||
        rawStart < 0 ||
        rawStart > MAX_MEDIA_MS
      ) {
        return null;
      }
      const startMs = Math.round(rawStart);
      let endMs: number | undefined;
      if (candidate.endMs !== undefined && candidate.endMs !== null) {
        if (
          typeof candidate.endMs !== 'number' ||
          !Number.isFinite(candidate.endMs) ||
          candidate.endMs > MAX_MEDIA_MS
        ) {
          return null;
        }
        endMs = Math.max(startMs, Math.round(candidate.endMs));
      }
      const quote = truncateCleanCodePoints(candidate.quote, MAX_QUOTE_CODE_POINTS);
      return {
        kind: 'media',
        ...base,
        startMs,
        ...(endMs !== undefined ? { endMs } : {}),
        ...(quote ? { quote } : {}),
      };
    }
    case 'note': {
      const blockId = sanitizeToken(candidate.blockId, MAX_SUB_ID_LENGTH);
      const heading = truncateCleanCodePoints(candidate.heading, MAX_QUOTE_CODE_POINTS);
      return {
        kind: 'note',
        ...base,
        ...(blockId ? { blockId } : {}),
        ...(heading ? { heading } : {}),
      };
    }
    case 'mindmap': {
      const nodeId = sanitizeToken(candidate.nodeId, MAX_SUB_ID_LENGTH);
      return {
        kind: 'mindmap',
        ...base,
        ...(nodeId ? { nodeId } : {}),
      };
    }
    case 'qbank': {
      const questionId = sanitizeToken(candidate.questionId, MAX_SUB_ID_LENGTH);
      return {
        kind: 'qbank',
        ...base,
        ...(questionId ? { questionId } : {}),
      };
    }
    case 'epub': {
      if (typeof candidate.cfi !== 'string' || ASCII_CONTROL_RE.test(candidate.cfi)) {
        return null;
      }
      const cfi = candidate.cfi.trim();
      if (!cfi || cfi.length > MAX_LOCATOR_LENGTH) return null;
      const quote = truncateCleanCodePoints(candidate.quote, MAX_QUOTE_CODE_POINTS);
      return {
        kind: 'epub',
        ...base,
        cfi,
        ...(quote ? { quote } : {}),
      };
    }
    case 'custom': {
      const namespace = sanitizeIdentifier(candidate.namespace, MAX_NAMESPACE_LENGTH);
      if (!namespace) return null;
      if (typeof candidate.locator !== 'string' || ASCII_CONTROL_RE.test(candidate.locator)) {
        return null;
      }
      const locator = candidate.locator.trim();
      if (!locator || locator.length > MAX_LOCATOR_LENGTH) return null;
      const params = sanitizeCustomParams(candidate.params);
      return {
        kind: 'custom',
        ...base,
        namespace,
        locator,
        ...(params ? { params } : {}),
      };
    }
    default:
      return null;
  }
}

function buildAnchorUriUnchecked(anchor: SemanticAnchor): string {
  const pairs: Array<[string, string, boolean?]> = [];
  const pushEncoded = (key: string, value: string | undefined) => {
    if (value !== undefined && value.length > 0) {
      pairs.push([key, encodeURIComponent(value), true]);
    }
  };
  const pushRaw = (key: string, value: string) => {
    pairs.push([key, value, true]);
  };

  let head: string;
  switch (anchor.kind) {
    case 'pdf': {
      head = `${DS_ANCHOR_PREFIX}pdf/${encodeURIComponent(anchor.resourceId)}`;
      pushRaw('page', String(anchor.page));
      if (anchor.rect) {
        const rectStr = formatNormalizedRectParam(anchor.rect);
        if (!rectStr) throw new RangeError('Invalid PdfSemanticAnchor rect');
        pushRaw('rect', rectStr);
      }
      pushEncoded('quote', anchor.quote);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    }
    case 'media': {
      head = `${DS_ANCHOR_PREFIX}media/${encodeURIComponent(anchor.resourceId)}`;
      pushRaw('t', String(anchor.startMs));
      if (anchor.endMs !== undefined) {
        pushRaw('end', String(anchor.endMs));
      }
      pushEncoded('quote', anchor.quote);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    }
    case 'note': {
      head = `${DS_ANCHOR_PREFIX}note/${encodeURIComponent(anchor.resourceId)}`;
      pushEncoded('block', anchor.blockId);
      pushEncoded('heading', anchor.heading);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    }
    case 'mindmap': {
      head = `${DS_ANCHOR_PREFIX}mindmap/${encodeURIComponent(anchor.resourceId)}`;
      pushEncoded('node', anchor.nodeId);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    }
    case 'qbank': {
      head = `${DS_ANCHOR_PREFIX}qbank/${encodeURIComponent(anchor.resourceId)}`;
      pushEncoded('q', anchor.questionId);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    }
    case 'epub': {
      head = `${DS_ANCHOR_PREFIX}epub/${encodeURIComponent(anchor.resourceId)}`;
      pushEncoded('cfi', anchor.cfi);
      pushEncoded('quote', anchor.quote);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      break;
    }
    case 'custom': {
      head = `${DS_ANCHOR_PREFIX}custom/${encodeURIComponent(anchor.namespace)}`;
      pushEncoded('id', anchor.resourceId);
      pushEncoded('loc', anchor.locator);
      pushEncoded('alias', anchor.aliasResourceId);
      pushEncoded('label', anchor.label);
      if (anchor.params) {
        for (const key of Object.keys(anchor.params).sort()) {
          pairs.push([`p.${encodeURIComponent(key)}`, encodeURIComponent(anchor.params[key]), true]);
        }
      }
      break;
    }
  }

  if (pairs.length === 0) return head;
  const query = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  return `${head}?${query}`;
}

function fitsUriBudget(uri: string): boolean {
  return (
    uri.length <= MAX_ANCHOR_URI_LENGTH &&
    utf8Encoder.encode(uri).byteLength <= MAX_ANCHOR_URI_LENGTH
  );
}

/**
 * Serializes a `SemanticAnchor` into a canonical `ds-anchor://v1/...` URI.
 * Throws a `RangeError` if the anchor fails structural validation.
 */
export function serializeSemanticAnchor(anchor: SemanticAnchor): string {
  const sanitized = sanitizeSemanticAnchor(anchor);
  if (!sanitized) {
    throw new RangeError('Invalid SemanticAnchor');
  }
  let uri = buildAnchorUriUnchecked(sanitized);
  if (fitsUriBudget(uri)) return uri;

  // Multi-byte UTF-8 quotes/labels expand under percent-encoding; trim cleanly to fit <= 2048 bytes.
  const mutable: SemanticAnchor = { ...sanitized };
  if ('quote' in mutable && mutable.quote) {
    const cps = Array.from(mutable.quote);
    let hi = cps.length;
    let lo = 0;
    let best: string | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidateQuote = mid > 0 ? cps.slice(0, mid).join('') : undefined;
      const trial = buildAnchorUriUnchecked({ ...mutable, quote: candidateQuote } as SemanticAnchor);
      if (fitsUriBudget(trial)) {
        best = candidateQuote;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) {
      (mutable as { quote?: string }).quote = best;
    } else {
      delete (mutable as { quote?: string }).quote;
    }
    uri = buildAnchorUriUnchecked(mutable);
    if (fitsUriBudget(uri)) return uri;
  }

  if (mutable.label) {
    const cps = Array.from(mutable.label);
    let hi = cps.length;
    let lo = 0;
    let best: string | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidateLabel = mid > 0 ? cps.slice(0, mid).join('') : undefined;
      const trial = buildAnchorUriUnchecked({ ...mutable, label: candidateLabel });
      if (fitsUriBudget(trial)) {
        best = candidateLabel;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best) {
      mutable.label = best;
    } else {
      delete mutable.label;
    }
    uri = buildAnchorUriUnchecked(mutable);
  }

  if (!fitsUriBudget(uri)) {
    throw new RangeError('Serialized SemanticAnchor exceeds 2048-byte URI limit');
  }
  return uri;
}

function decodeUriPart(encoded: string): string | null {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function parseQueryMap(rawQuery: string): Map<string, string> | null {
  const map = new Map<string, string>();
  if (!rawQuery) return map;
  const pairs = rawQuery.split('&');
  for (const pair of pairs) {
    if (!pair) continue;
    const eqIndex = pair.indexOf('=');
    const rawKey = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
    const rawVal = eqIndex === -1 ? '' : pair.slice(eqIndex + 1);
    const key = decodeUriPart(rawKey.replace(/\+/g, '%20'));
    const val = decodeUriPart(rawVal.replace(/\+/g, '%20'));
    if (key === null || val === null) return null;
    if (ASCII_CONTROL_RE.test(key) || ASCII_CONTROL_RE.test(val)) return null;
    if (!map.has(key)) {
      map.set(key, val);
    }
  }
  return map;
}

function parseStrictNonNegativeInt(raw: string | undefined, max: number): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < 0 || num > max) return null;
  return num;
}

/**
 * Strictly parses and sanitizes a `ds-anchor://v1/...` URI string.
 * Returns `null` on any malformed, out-of-bounds, or untrusted input.
 */
export function parseSemanticAnchor(input: string): SemanticAnchor | null {
  if (typeof input !== 'string' || !input) return null;
  if (!fitsUriBudget(input)) return null;
  if (ASCII_CONTROL_RE.test(input)) return null;
  if (!input.startsWith(DS_ANCHOR_PREFIX)) return null;

  const rest = input.slice(DS_ANCHOR_PREFIX.length);
  if (!rest || rest.includes('#')) return null;

  const qIndex = rest.indexOf('?');
  const rawPath = qIndex === -1 ? rest : rest.slice(0, qIndex);
  const rawQuery = qIndex === -1 ? '' : rest.slice(qIndex + 1);

  if (!rawPath || rawPath.startsWith('/') || rawPath.endsWith('/')) return null;
  const pathSegments = rawPath.split('/');
  if (pathSegments.length !== 2) return null;
  const [kindRaw, encodedPrimary] = pathSegments;
  if (
    !kindRaw ||
    !encodedPrimary ||
    kindRaw === '.' ||
    kindRaw === '..' ||
    encodedPrimary === '.' ||
    encodedPrimary === '..' ||
    rawPath.includes('..')
  ) {
    return null;
  }

  const decodedPrimary = decodeUriPart(encodedPrimary);
  if (decodedPrimary === null) return null;

  const query = parseQueryMap(rawQuery);
  if (!query) return null;

  const aliasRaw = query.get('alias');
  if (aliasRaw !== undefined && sanitizeIdentifier(aliasRaw, MAX_RESOURCE_ID_LENGTH) === null) {
    return null;
  }
  const labelRaw = query.get('label');

  switch (kindRaw) {
    case 'pdf': {
      const resourceId = sanitizeIdentifier(decodedPrimary, MAX_RESOURCE_ID_LENGTH);
      if (!resourceId) return null;
      const page = parseStrictNonNegativeInt(query.get('page'), MAX_PDF_PAGE);
      if (page === null || page < 1) return null;

      let rect: NormalizedRect | undefined;
      if (query.has('rect')) {
        const parsedRect = parseNormalizedRectParam(query.get('rect') ?? '');
        if (!parsedRect) return null;
        rect = parsedRect;
      }
      return sanitizeSemanticAnchor({
        kind: 'pdf',
        resourceId,
        page,
        rect,
        quote: query.get('quote'),
        aliasResourceId: aliasRaw,
        label: labelRaw,
      });
    }
    case 'media': {
      const resourceId = sanitizeIdentifier(decodedPrimary, MAX_RESOURCE_ID_LENGTH);
      if (!resourceId) return null;
      const startMs = parseStrictNonNegativeInt(query.get('t'), MAX_MEDIA_MS);
      if (startMs === null) return null;
      let endMs: number | undefined;
      if (query.has('end')) {
        const parsedEnd = parseStrictNonNegativeInt(query.get('end'), MAX_MEDIA_MS);
        if (parsedEnd === null) return null;
        endMs = Math.max(startMs, parsedEnd);
      }
      return sanitizeSemanticAnchor({
        kind: 'media',
        resourceId,
        startMs,
        endMs,
        quote: query.get('quote'),
        aliasResourceId: aliasRaw,
        label: labelRaw,
      });
    }
    case 'note': {
      const resourceId = sanitizeIdentifier(decodedPrimary, MAX_RESOURCE_ID_LENGTH);
      if (!resourceId) return null;
      return sanitizeSemanticAnchor({
        kind: 'note',
        resourceId,
        blockId: query.get('block'),
        heading: query.get('heading'),
        aliasResourceId: aliasRaw,
        label: labelRaw,
      });
    }
    case 'mindmap': {
      const resourceId = sanitizeIdentifier(decodedPrimary, MAX_RESOURCE_ID_LENGTH);
      if (!resourceId) return null;
      return sanitizeSemanticAnchor({
        kind: 'mindmap',
        resourceId,
        nodeId: query.get('node'),
        aliasResourceId: aliasRaw,
        label: labelRaw,
      });
    }
    case 'qbank': {
      const resourceId = sanitizeIdentifier(decodedPrimary, MAX_RESOURCE_ID_LENGTH);
      if (!resourceId) return null;
      return sanitizeSemanticAnchor({
        kind: 'qbank',
        resourceId,
        questionId: query.get('q'),
        aliasResourceId: aliasRaw,
        label: labelRaw,
      });
    }
    case 'epub': {
      const resourceId = sanitizeIdentifier(decodedPrimary, MAX_RESOURCE_ID_LENGTH);
      if (!resourceId) return null;
      const cfi = query.get('cfi');
      if (!cfi) return null;
      return sanitizeSemanticAnchor({
        kind: 'epub',
        resourceId,
        cfi,
        quote: query.get('quote'),
        aliasResourceId: aliasRaw,
        label: labelRaw,
      });
    }
    case 'custom': {
      const namespace = sanitizeIdentifier(decodedPrimary, MAX_NAMESPACE_LENGTH);
      const resourceId = sanitizeIdentifier(query.get('id'), MAX_RESOURCE_ID_LENGTH);
      const locator = query.get('loc');
      if (!namespace || !resourceId || !locator) return null;
      const params: Record<string, string> = {};
      for (const [k, v] of query.entries()) {
        if (k.startsWith('p.') && k.length > 2) {
          params[k.slice(2)] = v;
        }
      }
      return sanitizeSemanticAnchor({
        kind: 'custom',
        namespace,
        resourceId,
        locator,
        params: Object.keys(params).length > 0 ? params : undefined,
        aliasResourceId: aliasRaw,
        label: labelRaw,
      });
    }
    default:
      return null;
  }
}

/** Type guard returning true iff `input` is a valid `ds-anchor://v1/...` URI string. */
export function isSemanticAnchorUri(input: unknown): input is string {
  return typeof input === 'string' && parseSemanticAnchor(input) !== null;
}

/** Formats a compact coordinate badge label (`p.42`, `14:22`, `#blk_9f8a`) for UI pills. */
export function formatAnchorShortLocator(anchor: SemanticAnchor): string {
  switch (anchor.kind) {
    case 'pdf':
      return `p.${anchor.page}`;
    case 'media': {
      const totalSeconds = Math.max(0, Math.floor(anchor.startMs / 1000));
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const mm = String(minutes).padStart(2, '0');
      const ss = String(seconds).padStart(2, '0');
      if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
      }
      return `${mm}:${ss}`;
    }
    case 'note':
      return anchor.blockId ? `#${anchor.blockId.slice(0, 8)}` : '';
    default:
      return anchor.label ?? '';
  }
}

function isAllowedExcerptKind(value: unknown): value is ExcerptContentKind {
  return value === 'text' || value === 'region-image' || value === 'transcript-cue';
}

function sanitizeImageDataUrl(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') return null;
  if (value.length > MAX_IMAGE_DATA_URL_LENGTH || ASCII_CONTROL_RE.test(value)) return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.startsWith('data:image/') ||
    trimmed.startsWith('vfs://') ||
    trimmed.startsWith('blob:')
  ) {
    return trimmed;
  }
  return null;
}

function sanitizeExcerptText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/g, '\n').replace(EXCERPT_TEXT_CONTROL_GLOBAL_RE, '');
  const cps = Array.from(normalized);
  return cps.length > MAX_EXCERPT_TEXT_CODE_POINTS
    ? cps.slice(0, MAX_EXCERPT_TEXT_CODE_POINTS).join('')
    : normalized;
}

/**
 * Validates and normalizes an untrusted or partial `ExcerptDragPayload` / `ExcerptDragInput`.
 * Always returns a fresh plain object or `null` if invalid.
 */
export function sanitizeExcerptDragPayload(input: unknown): ExcerptDragPayload | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;

  if (candidate.version !== undefined && candidate.version !== 1) return null;
  if (!isAllowedExcerptKind(candidate.excerptKind)) return null;

  const text = sanitizeExcerptText(candidate.text);
  if (text === null) return null;

  const imageDataUrl = sanitizeImageDataUrl(candidate.imageDataUrl);
  if (imageDataUrl === null) return null;

  const anchor = sanitizeSemanticAnchor(candidate.anchor);
  if (!anchor) return null;

  if (candidate.anchorUri !== undefined) {
    if (typeof candidate.anchorUri !== 'string' || !isSemanticAnchorUri(candidate.anchorUri)) {
      return null;
    }
  }

  let anchorUri: string;
  try {
    anchorUri = serializeSemanticAnchor(anchor);
  } catch {
    return null;
  }

  const sourceTitle = truncateCleanCodePoints(candidate.sourceTitle, MAX_LABEL_CODE_POINTS);
  const rawCreatedAt = candidate.createdAt;
  const createdAt =
    typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt) && rawCreatedAt >= 0
      ? Math.floor(rawCreatedAt)
      : Date.now();

  return {
    version: 1,
    excerptKind: candidate.excerptKind,
    text,
    ...(imageDataUrl ? { imageDataUrl } : {}),
    anchor,
    anchorUri,
    ...(sourceTitle ? { sourceTitle } : {}),
    createdAt,
  };
}

const VALID_EDGE_SOURCE_KINDS = new Set<AnchorEdgeSourceKind>([
  'mindmap',
  'flashcard',
  'note',
  'qbank',
]);

export function deriveTargetLocatorKey(anchor: SemanticAnchor): string {
  switch (anchor.kind) {
    case 'pdf':
      return `p:${anchor.page}`;
    case 'media':
      return `ms:${anchor.startMs}`;
    case 'note':
      if (anchor.blockId) return `blk:${anchor.blockId}`;
      if (anchor.heading) return `hd:${anchor.heading}`;
      return '';
    case 'mindmap':
      return anchor.nodeId ? `node:${anchor.nodeId}` : '';
    case 'qbank':
      return anchor.questionId ? `q:${anchor.questionId}` : '';
    case 'epub':
      return `cfi:${anchor.cfi}`;
    case 'custom':
      return `${anchor.namespace}:${anchor.locator}`;
  }
}

/** Converts an `AnchorEdgeUpsertInput` into a validated `AnchorEdgeRecord`. */
export function buildAnchorEdgeRecord(
  input: AnchorEdgeUpsertInput,
  now: number = Date.now(),
  existingCreatedAt?: number,
): AnchorEdgeRecord | null {
  if (!input || typeof input !== 'object') return null;
  if (!VALID_EDGE_SOURCE_KINDS.has(input.sourceKind)) return null;
  const sourceResourceId = sanitizeIdentifier(input.sourceResourceId, MAX_RESOURCE_ID_LENGTH);
  if (!sourceResourceId) return null;

  const sourceAnchor = sanitizeSemanticAnchor(input.sourceAnchor);
  const targetAnchor = sanitizeSemanticAnchor(input.targetAnchor);
  if (!sourceAnchor || !targetAnchor) return null;

  let sourceAnchorUri: string;
  let targetAnchorUri: string;
  try {
    sourceAnchorUri = serializeSemanticAnchor(sourceAnchor);
    targetAnchorUri = serializeSemanticAnchor(targetAnchor);
  } catch {
    return null;
  }

  const sourceSubId = sanitizeToken(input.sourceSubId, MAX_SUB_ID_LENGTH) ?? '';
  const sourceLabel =
    truncateCleanCodePoints(input.sourceLabel ?? sourceAnchor.label ?? '', MAX_LABEL_CODE_POINTS) ??
    '';
  const explicitEdgeId = sanitizeToken(input.edgeId, MAX_SUB_ID_LENGTH);
  const edgeId =
    explicitEdgeId ??
    `edge_${fnv1a64Hex(`${input.sourceKind}:${sourceResourceId}:${sourceSubId}:${targetAnchorUri}`)}`;

  const studySpaceId = sanitizeToken(input.studySpaceId, MAX_SUB_ID_LENGTH) ?? null;
  const timestamp = Number.isFinite(now) && now >= 0 ? Math.floor(now) : Date.now();

  return {
    edgeId,
    sourceKind: input.sourceKind,
    sourceResourceId,
    sourceSubId,
    sourceAnchorUri,
    sourceLabel,
    targetKind: targetAnchor.kind,
    targetResourceId: targetAnchor.resourceId,
    targetLocatorKey: deriveTargetLocatorKey(targetAnchor),
    targetPage: targetAnchor.kind === 'pdf' ? targetAnchor.page : null,
    targetStartMs: targetAnchor.kind === 'media' ? targetAnchor.startMs : null,
    targetEndMs: targetAnchor.kind === 'media' ? (targetAnchor.endMs ?? null) : null,
    targetRect: targetAnchor.kind === 'pdf' ? (targetAnchor.rect ?? null) : null,
    targetAnchorUri,
    studySpaceId,
    createdAt: existingCreatedAt ?? timestamp,
    updatedAt: timestamp,
  };
}

/** Normalizes a row returned from SQLite / Tauri IPC (camelCase or snake_case) into `AnchorEdgeRecord`. */
export function normalizePersistedAnchorEdgeRecord(raw: unknown): AnchorEdgeRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;

  const edgeId = sanitizeToken(row.edgeId ?? row.edge_id, MAX_SUB_ID_LENGTH);
  const sourceKind = (row.sourceKind ?? row.source_kind) as AnchorEdgeSourceKind;
  const sourceResourceId = sanitizeIdentifier(
    row.sourceResourceId ?? row.source_resource_id,
    MAX_RESOURCE_ID_LENGTH,
  );
  const sourceAnchorUri = row.sourceAnchorUri ?? row.source_anchor_uri;
  const targetAnchorUri = row.targetAnchorUri ?? row.target_anchor_uri;

  if (
    !edgeId ||
    !VALID_EDGE_SOURCE_KINDS.has(sourceKind) ||
    !sourceResourceId ||
    typeof sourceAnchorUri !== 'string' ||
    typeof targetAnchorUri !== 'string' ||
    !isSemanticAnchorUri(sourceAnchorUri) ||
    !isSemanticAnchorUri(targetAnchorUri)
  ) {
    return null;
  }

  const parsedTarget = parseSemanticAnchor(targetAnchorUri);
  if (!parsedTarget) return null;

  let targetRect: NormalizedRect | null = null;
  const rawRect = row.targetRect ?? row.target_rect;
  const rawRectJson = row.targetRectJson ?? row.target_rect_json;
  if (rawRect && typeof rawRect === 'object') {
    targetRect = sanitizeNormalizedRect(rawRect);
  } else if (typeof rawRectJson === 'string' && rawRectJson.trim()) {
    try {
      targetRect = sanitizeNormalizedRect(JSON.parse(rawRectJson));
    } catch {
      targetRect = null;
    }
  } else if (parsedTarget.kind === 'pdf' && parsedTarget.rect) {
    targetRect = parsedTarget.rect;
  }

  const rawPage = row.targetPage ?? row.target_page;
  const targetPage =
    typeof rawPage === 'number' && Number.isInteger(rawPage) && rawPage >= 1
      ? rawPage
      : parsedTarget.kind === 'pdf'
        ? parsedTarget.page
        : null;

  const rawStartMs = row.targetStartMs ?? row.target_start_ms;
  const targetStartMs =
    typeof rawStartMs === 'number' && Number.isFinite(rawStartMs) && rawStartMs >= 0
      ? Math.round(rawStartMs)
      : parsedTarget.kind === 'media'
        ? parsedTarget.startMs
        : null;

  const rawEndMs = row.targetEndMs ?? row.target_end_ms;
  const targetEndMs =
    typeof rawEndMs === 'number' && Number.isFinite(rawEndMs) && rawEndMs >= 0
      ? Math.round(rawEndMs)
      : parsedTarget.kind === 'media'
        ? (parsedTarget.endMs ?? null)
        : null;

  const rawCreatedAt = row.createdAt ?? row.created_at;
  const rawUpdatedAt = row.updatedAt ?? row.updated_at;
  const createdAt =
    typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt) ? Math.floor(rawCreatedAt) : 0;
  const updatedAt =
    typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt)
      ? Math.floor(rawUpdatedAt)
      : createdAt;

  return {
    edgeId,
    sourceKind,
    sourceResourceId,
    sourceSubId: sanitizeToken(row.sourceSubId ?? row.source_sub_id, MAX_SUB_ID_LENGTH) ?? '',
    sourceAnchorUri,
    sourceLabel:
      truncateCleanCodePoints(row.sourceLabel ?? row.source_label, MAX_LABEL_CODE_POINTS) ?? '',
    targetKind: parsedTarget.kind,
    targetResourceId:
      sanitizeIdentifier(row.targetResourceId ?? row.target_resource_id, MAX_RESOURCE_ID_LENGTH) ??
      parsedTarget.resourceId,
    targetLocatorKey:
      sanitizeToken(row.targetLocatorKey ?? row.target_locator_key, MAX_LOCATOR_LENGTH) ??
      deriveTargetLocatorKey(parsedTarget),
    targetPage,
    targetStartMs,
    targetEndMs,
    targetRect,
    targetAnchorUri,
    studySpaceId: sanitizeToken(row.studySpaceId ?? row.study_space_id, MAX_SUB_ID_LENGTH) ?? null,
    createdAt,
    updatedAt,
  };
}
