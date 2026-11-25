/**
 * Notes ↔ PDF citation & backlink precision navigation + per-note scroll memory.
 *
 * Ensures clicking any PDF page/highlight citation from Notes:
 * 1. Preserves exact `sourceId`, 1-based `pageNumber`, `highlightId`/`annotationId`, and `quote`
 *    (supporting both `?page=N&highlight=H` query params and `#page=N&highlight=H` hash params).
 * 2. Retries `pdf-ref:focus` with acknowledgement cancellation so cold-started PDF viewers
 *    never drop page/highlight params and silently stay on Page 1.
 * 3. Remembers and restores the owning note's scroll position when focus returns to Notes.
 */

export interface ParsedPdfCitationTarget {
  sourceId: string;
  pageNumber?: number;
  highlightId?: string;
  quote?: string;
  locator?: string;
}

export interface PdfCitationNavigationOptions {
  sourceWindowId?: string;
  /** Also dispatch legacy `NAVIGATE_TO_VIEW` for classic non-Workbench shell fallback. */
  includeLegacyViewEvent?: boolean;
  /** Retry delays (ms) for ack-cancelled `pdf-ref:focus` delivery. */
  retryDelaysMs?: readonly number[];
}

const PDF_REF_PROTOCOL = 'pdfref://';
const DS_PDF_ANCHOR_PREFIX = 'ds-anchor://v1/pdf/';
const DEFAULT_FOCUS_RETRY_DELAYS_MS = [0, 250, 800, 1600, 3000, 5000] as const;

const MAX_SCROLL_MEMORY_ENTRIES = 120;
const noteScrollTopCache = new Map<string, number>();
const activeRetryCleanupsBySource = new Map<string, () => void>();

function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function parsePositiveInt(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function cleanParam(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function parseHashParams(hashRaw: string): URLSearchParams {
  const normalized = hashRaw.replace(/^#/, '').trim();
  if (!normalized) return new URLSearchParams();
  if (normalized.includes('=')) return new URLSearchParams(normalized);
  return new URLSearchParams();
}

/**
 * Parse page and highlight/annotation identifiers from a freeform resource locator
 * (e.g. `page:12`, `page=12&highlight=hl_9`, `page:12#highlight:hl_9`, `annotation:ann_3`).
 */
export function parsePdfLocatorParams(locator: string | undefined): {
  pageNumber?: number;
  highlightId?: string;
} {
  if (!locator) return {};
  const trimmed = locator.trim();
  if (!trimmed) return {};

  let pageNumber: number | undefined;
  let highlightId: string | undefined;

  const pageMatch = /(?:^|[?&#;\s,])(?:page|p)\s*[:=.]\s*(\d+)/i.exec(trimmed);
  if (pageMatch) {
    pageNumber = parsePositiveInt(pageMatch[1]);
  }

  const hlMatch = /(?:^|[?&#;\s,])(?:highlightId|highlight|annotationId|annotation|hl)\s*[:=]\s*([^&#;\s,]+)/i.exec(trimmed);
  if (hlMatch) {
    highlightId = cleanParam(safeDecode(hlMatch[1]));
  }

  return { pageNumber, highlightId };
}

/** Returns true if an href points to a PDF citation (`pdfref://` or `ds-anchor://v1/pdf/`). */
export function isPdfCitationHref(href: string | null | undefined): boolean {
  if (!href) return false;
  const trimmed = href.trim().toLowerCase();
  return trimmed.startsWith(PDF_REF_PROTOCOL) || trimmed.startsWith(DS_PDF_ANCHOR_PREFIX);
}

/**
 * Parse a `pdfref://` citation href while preserving `pageNumber`, `highlightId`, and `quote`.
 * Supports query params (`?page=7&highlight=hl_1&quote=...`), aliases (`p`, `highlightId`,
 * `annotationId`, `annotation`), and hash params (`#page=7&highlight=hl_1` or `#hl_1`).
 */
export function parsePdfCitationHref(href: string | null | undefined): ParsedPdfCitationTarget | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed.toLowerCase().startsWith(PDF_REF_PROTOCOL)) return null;

  const rest = trimmed.slice(PDF_REF_PROTOCOL.length);
  const hashIdx = rest.indexOf('#');
  const beforeHash = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const hashRaw = hashIdx >= 0 ? rest.slice(hashIdx + 1) : '';

  const queryIdx = beforeHash.indexOf('?');
  const rawSource = (queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash).replace(/^\/+|\/+$/g, '');
  const queryRaw = queryIdx >= 0 ? beforeHash.slice(queryIdx + 1) : '';

  const sourceId = cleanParam(safeDecode(rawSource));
  if (!sourceId) return null;

  const queryParams = new URLSearchParams(queryRaw);
  const hashParams = parseHashParams(hashRaw);

  const pageNumber = parsePositiveInt(
    queryParams.get('page')
      ?? queryParams.get('pageNumber')
      ?? queryParams.get('p')
      ?? hashParams.get('page')
      ?? hashParams.get('pageNumber')
      ?? hashParams.get('p'),
  );

  let highlightId = cleanParam(
    queryParams.get('highlightId')
      ?? queryParams.get('highlight')
      ?? queryParams.get('annotationId')
      ?? queryParams.get('annotation')
      ?? queryParams.get('hl')
      ?? hashParams.get('highlightId')
      ?? hashParams.get('highlight')
      ?? hashParams.get('annotationId')
      ?? hashParams.get('annotation')
      ?? hashParams.get('hl'),
  );

  // Support bare `#hl_42` or `#highlight:hl_42` fragment forms when not `key=value`
  if (!highlightId && hashRaw.trim() && !hashRaw.includes('=')) {
    const decodedHash = safeDecode(hashRaw.trim());
    const fromLocator = parsePdfLocatorParams(decodedHash);
    if (fromLocator.highlightId) {
      highlightId = fromLocator.highlightId;
    } else if (!/^p(?:age)?\s*[:.]?\s*\d+$/i.test(decodedHash)) {
      highlightId = cleanParam(decodedHash);
    }
  }

  const hashPageFallback = !pageNumber && hashRaw.trim() && !hashRaw.includes('=')
    ? parsePdfLocatorParams(safeDecode(hashRaw.trim())).pageNumber
    : undefined;

  const quote = cleanParam(
    queryParams.get('quote') ?? hashParams.get('quote'),
  )?.slice(0, 200);

  const locator = cleanParam(
    queryParams.get('locator') ?? hashParams.get('locator'),
  );
  const locatorParams = parsePdfLocatorParams(locator);

  return {
    sourceId,
    pageNumber: pageNumber ?? hashPageFallback ?? locatorParams.pageNumber,
    highlightId: highlightId ?? locatorParams.highlightId,
    quote,
    locator,
  };
}

/** Resolve the closest Workbench window id from a DOM element, if present. */
export function resolveClosestWorkbenchWindowId(element: Element | null | undefined): string | undefined {
  if (!element || typeof element.closest !== 'function') return undefined;
  const host = element.closest<HTMLElement>('[data-wb-window-id]');
  const id = host?.dataset.wbWindowId?.trim();
  return id || undefined;
}

/**
 * Dispatch a PDF citation open + ack-cancelled focus sequence, preserving exact
 * `pageNumber`, `highlightId`/`annotationId`, `quote`, and `sourceWindowId`.
 * Returns a cleanup function that cancels any pending retries.
 */
export function dispatchPdfCitationNavigation(
  target: ParsedPdfCitationTarget,
  options: PdfCitationNavigationOptions = {},
): () => void {
  const sourceId = target.sourceId.trim();
  if (!sourceId) return () => {};

  const locatorParams = parsePdfLocatorParams(target.locator);
  const pageNumber = (typeof target.pageNumber === 'number' && Number.isInteger(target.pageNumber) && target.pageNumber >= 1)
    ? target.pageNumber
    : locatorParams.pageNumber;
  const highlightId = cleanParam(target.highlightId) ?? locatorParams.highlightId;
  const quote = cleanParam(target.quote)?.slice(0, 200);
  const sourceWindowId = cleanParam(options.sourceWindowId);
  const dstuPath = sourceId.startsWith('/') ? sourceId : `/${sourceId}`;

  // Cancel any earlier retry sequence targeting the same PDF so rapid clicks don't fight each other.
  activeRetryCleanupsBySource.get(sourceId)?.();

  const openDetail: Record<string, unknown> = {
    sourceId,
    path: dstuPath,
    ...(pageNumber !== undefined ? { pageNumber } : {}),
    ...(highlightId ? { highlightId, annotationId: highlightId } : {}),
    ...(quote ? { quote } : {}),
    ...(sourceWindowId ? { sourceWindowId } : {}),
  };

  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('pdf-ref:open', { detail: openDetail }));
  }

  if (options.includeLegacyViewEvent && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', {
      detail: { view: 'learning-hub', openResource: dstuPath },
    }));
  }

  // Only schedule ack-retried focus when we have an explicit page, highlight, or quote target.
  if (pageNumber === undefined && !highlightId && !quote) {
    return () => {};
  }

  const delays = options.retryDelaysMs ?? DEFAULT_FOCUS_RETRY_DELAYS_MS;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    while (timers.length > 0) {
      const id = timers.pop();
      if (id !== undefined) clearTimeout(id);
    }
    if (activeRetryCleanupsBySource.get(sourceId) === stop) {
      activeRetryCleanupsBySource.delete(sourceId);
    }
  };

  activeRetryCleanupsBySource.set(sourceId, stop);

  const sendFocus = () => {
    if (stopped || typeof document === 'undefined') return;
    let acked = false;
    const focusDetail: Record<string, unknown> = {
      sourceId,
      path: dstuPath,
      ...(pageNumber !== undefined ? { pageNumber } : {}),
      ...(highlightId ? { highlightId, annotationId: highlightId } : {}),
      ...(quote ? { quote } : {}),
      ...(sourceWindowId ? { sourceWindowId } : {}),
      acknowledge: (result: boolean | { handled?: boolean }) => {
        if (result === true || (typeof result === 'object' && result !== null && result.handled === true)) {
          acked = true;
          stop();
        }
      },
      isStale: () => stopped,
    };
    document.dispatchEvent(new CustomEvent('pdf-ref:focus', { detail: focusDetail }));
    if (acked) stop();
  };

  for (const delay of delays) {
    if (delay <= 0) {
      sendFocus();
      if (stopped) break;
    } else {
      const timer = setTimeout(sendFocus, delay);
      timers.push(timer);
    }
  }

  return stop;
}

/** Remember a note's scrollTop (LRU-bounded) so returning from a PDF citation restores position. */
export function rememberNoteScrollPosition(noteId: string | undefined, scrollTop: number): void {
  if (!noteId || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  if (noteScrollTopCache.has(noteId)) {
    noteScrollTopCache.delete(noteId);
  }
  noteScrollTopCache.set(noteId, Math.round(scrollTop));
  while (noteScrollTopCache.size > MAX_SCROLL_MEMORY_ENTRIES) {
    const oldest = noteScrollTopCache.keys().next().value;
    if (oldest === undefined) break;
    noteScrollTopCache.delete(oldest);
  }
}

/** Read the last remembered scrollTop for a note, if any. */
export function getRememberedNoteScrollPosition(noteId: string | undefined): number | undefined {
  if (!noteId) return undefined;
  return noteScrollTopCache.get(noteId);
}

/** Clear remembered scroll position(s) (mainly for tests or deleted notes). */
export function clearRememberedNoteScrollPosition(noteId?: string): void {
  if (noteId) {
    noteScrollTopCache.delete(noteId);
  } else {
    noteScrollTopCache.clear();
  }
}
