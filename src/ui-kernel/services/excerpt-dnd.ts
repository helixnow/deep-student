/**
 * Cross-Plugin Excerpt Drag-and-Drop & Auto-Excerpt Bus (`ctx.ui.dnd` / `kernel.dnd`).
 *
 * Uses the dedicated MIME `DS_EXCERPT_MIME` (`application/x-deepstudent-excerpt`),
 * never touching `WB_RESOURCE_MIME` (`application/x-deepstudent-resource`) or native
 * OS file drops (`Files`).
 */
import {
  DS_EXCERPT_MIME,
  formatAnchorShortLocator,
  sanitizeExcerptDragPayload,
  type ExcerptDragInput,
  type ExcerptDragPayload,
} from '../contracts/interop';
import type { UiDisposer } from '../plugin';

const ACTIVE_DRAG_TTL_MS = 15_000;

export interface ExcerptDropTargetOptions {
  canAccept?: (payload: ExcerptDragPayload | null, event: DragEvent) => boolean;
}

export interface UiExcerptDndHandle {
  startExcerptDrag(
    event: Pick<DragEvent, 'dataTransfer'>,
    input: ExcerptDragInput,
  ): ExcerptDragPayload | null;
  hasExcerptMime(event: Pick<DragEvent, 'dataTransfer'> | null | undefined): boolean;
  readExcerptDrag(
    event: Pick<DragEvent, 'dataTransfer'> | null | undefined,
  ): ExcerptDragPayload | null;
  registerExcerptDropTarget(
    element: HTMLElement,
    onDrop: (payload: ExcerptDragPayload, event: DragEvent) => void,
    options?: ExcerptDropTargetOptions,
  ): UiDisposer;
  emitAutoExcerpt(input: ExcerptDragInput): ExcerptDragPayload | null;
  subscribeAutoExcerpt(listener: (payload: ExcerptDragPayload) => void): UiDisposer;
}

interface ActiveDragSession {
  payload: ExcerptDragPayload;
  expiresAt: number;
}

let activeDragSession: ActiveDragSession | null = null;
let dragEndListenerInstalled = false;

function getActiveDragPayload(): ExcerptDragPayload | null {
  if (!activeDragSession) return null;
  if (Date.now() > activeDragSession.expiresAt) {
    activeDragSession = null;
    return null;
  }
  return activeDragSession.payload;
}

export function clearActiveExcerptDrag(): void {
  activeDragSession = null;
}

function ensureGlobalDragEndCleanup(): void {
  if (dragEndListenerInstalled || typeof window === 'undefined') return;
  dragEndListenerInstalled = true;
  window.addEventListener(
    'dragend',
    () => {
      activeDragSession = null;
    },
    true,
  );
}

function escapeMarkdownBracketLabel(text: string): string {
  return text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

/** Builds cited plain-text Markdown fallback for external/plain inputs. */
export function buildMarkdownExcerptCitation(payload: ExcerptDragPayload): string {
  const title = payload.sourceTitle || payload.anchor.label || '';
  const locator = formatAnchorShortLocator(payload.anchor);
  const rawLabel =
    title && locator && title !== locator
      ? `${title} \u00b7 ${locator}`
      : title || locator || payload.anchor.resourceId;
  const label = escapeMarkdownBracketLabel(rawLabel);

  const bodySource = (payload.text || rawLabel).trim();
  const quotedLines = bodySource
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');

  return `${quotedLines}\n> \u2014 [${label}](${payload.anchorUri})`;
}

/**
 * Populates `event.dataTransfer` with `DS_EXCERPT_MIME`, `text/uri-list`, and cited `text/plain`,
 * storing an in-memory fallback until `dragend` (or 15s TTL).
 */
export function startExcerptDrag(
  event: Pick<DragEvent, 'dataTransfer'>,
  input: ExcerptDragInput,
): ExcerptDragPayload | null {
  const payload = sanitizeExcerptDragPayload(input);
  if (!payload) return null;

  ensureGlobalDragEndCleanup();
  activeDragSession = {
    payload,
    expiresAt: Date.now() + ACTIVE_DRAG_TTL_MS,
  };

  const dt = event?.dataTransfer;
  if (dt) {
    dt.setData(DS_EXCERPT_MIME, JSON.stringify(payload));
    dt.setData('text/uri-list', payload.anchorUri);
    dt.setData('text/plain', buildMarkdownExcerptCitation(payload));
    try {
      dt.effectAllowed = 'copyLink';
    } catch {
      // Synthetic DragEvents in tests may expose effectAllowed as read-only.
    }
  }

  return payload;
}

/**
 * Checks whether `event` carries `DS_EXCERPT_MIME` (or matches an active in-memory
 * excerpt drag when `dataTransfer.types` is unavailable in synthetic test events).
 */
export function hasExcerptMime(
  event: Pick<DragEvent, 'dataTransfer'> | null | undefined,
): boolean {
  const dt = event?.dataTransfer;
  let types: string[] = [];
  if (dt?.types) {
    try {
      types = Array.from(dt.types);
    } catch {
      types = [];
    }
  }
  if (types.includes(DS_EXCERPT_MIME)) {
    return true;
  }
  // If explicit non-empty MIME types are present without DS_EXCERPT_MIME
  // (e.g. 'Files', WB_RESOURCE_MIME, plain text), never claim it as an excerpt drag.
  if (types.length > 0) {
    return false;
  }
  if (dt && typeof dt.getData === 'function') {
    try {
      if (dt.getData(DS_EXCERPT_MIME)) return true;
    } catch {
      // Ignore security errors on cross-origin drag sources.
    }
  }
  return getActiveDragPayload() !== null;
}

/**
 * Reads and sanitizes `ExcerptDragPayload` from `event.dataTransfer`, falling back
 * to the active in-memory session when browser `dragover` or jsdom omits `getData`.
 */
export function readExcerptDrag(
  event: Pick<DragEvent, 'dataTransfer'> | null | undefined,
): ExcerptDragPayload | null {
  if (!hasExcerptMime(event)) return null;

  let raw = '';
  const dt = event?.dataTransfer;
  if (dt && typeof dt.getData === 'function') {
    try {
      raw = dt.getData(DS_EXCERPT_MIME) ?? '';
    } catch {
      raw = '';
    }
  }

  if (raw) {
    try {
      return sanitizeExcerptDragPayload(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  return getActiveDragPayload();
}

export class ExcerptDndHub implements UiExcerptDndHandle {
  private readonly autoExcerptListeners = new Set<(payload: ExcerptDragPayload) => void>();
  private readonly activeDisposers = new Set<() => void>();
  private readonly onError?: (error: unknown) => void;

  constructor(options?: { onError?: (error: unknown) => void }) {
    this.onError = options?.onError;
  }

  startExcerptDrag(
    event: Pick<DragEvent, 'dataTransfer'>,
    input: ExcerptDragInput,
  ): ExcerptDragPayload | null {
    return startExcerptDrag(event, input);
  }

  hasExcerptMime(event: Pick<DragEvent, 'dataTransfer'> | null | undefined): boolean {
    return hasExcerptMime(event);
  }

  readExcerptDrag(
    event: Pick<DragEvent, 'dataTransfer'> | null | undefined,
  ): ExcerptDragPayload | null {
    return readExcerptDrag(event);
  }

  registerExcerptDropTarget(
    element: HTMLElement,
    onDrop: (payload: ExcerptDragPayload, event: DragEvent) => void,
    options?: ExcerptDropTargetOptions,
  ): UiDisposer {
    let enterDepth = 0;
    let disposed = false;

    element.dataset.dsExcerptDrop = 'idle';

    const resetState = () => {
      enterDepth = 0;
      element.dataset.dsExcerptDrop = 'idle';
    };

    const accepts = (event: DragEvent): boolean => {
      if (!hasExcerptMime(event)) return false;
      if (!options?.canAccept) return true;
      try {
        return Boolean(options.canAccept(readExcerptDrag(event), event));
      } catch (error) {
        this.onError?.(error);
        return false;
      }
    };

    const onDragEnter = (event: DragEvent) => {
      if (!hasExcerptMime(event)) return;
      enterDepth += 1;
      if (accepts(event)) {
        event.preventDefault();
        event.stopPropagation();
        element.dataset.dsExcerptDrop = 'over';
      } else {
        element.dataset.dsExcerptDrop = 'idle';
      }
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasExcerptMime(event)) return;
      if (accepts(event)) {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
          try {
            event.dataTransfer.dropEffect = 'copy';
          } catch {
            // Read-only in some synthetic DragEvents.
          }
        }
        element.dataset.dsExcerptDrop = 'over';
      } else {
        if (event.dataTransfer) {
          try {
            event.dataTransfer.dropEffect = 'none';
          } catch {
            // Read-only in some synthetic DragEvents.
          }
        }
        element.dataset.dsExcerptDrop = 'idle';
      }
    };

    const onDragLeave = (event: DragEvent) => {
      if (!hasExcerptMime(event)) return;
      event.stopPropagation();
      enterDepth = Math.max(0, enterDepth - 1);
      if (enterDepth === 0) {
        element.dataset.dsExcerptDrop = 'idle';
      }
    };

    const onDropHandler = (event: DragEvent) => {
      if (!hasExcerptMime(event)) return;
      const allowed = accepts(event);
      resetState();
      if (!allowed) return;
      event.preventDefault();
      event.stopPropagation();
      const payload = readExcerptDrag(event);
      clearActiveExcerptDrag();
      if (!payload) return;
      try {
        void Promise.resolve(onDrop(payload, event)).catch(error => this.onError?.(error));
      } catch (error) {
        this.onError?.(error);
      }
    };

    const onDragEndOrBlur = () => {
      resetState();
    };

    element.addEventListener('dragenter', onDragEnter);
    element.addEventListener('dragover', onDragOver);
    element.addEventListener('dragleave', onDragLeave);
    element.addEventListener('drop', onDropHandler);

    const win =
      element.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : undefined);
    win?.addEventListener('dragend', onDragEndOrBlur);
    win?.addEventListener('blur', onDragEndOrBlur);

    const dispose: UiDisposer = () => {
      if (disposed) return;
      disposed = true;
      this.activeDisposers.delete(dispose);
      resetState();
      element.removeEventListener('dragenter', onDragEnter);
      element.removeEventListener('dragover', onDragOver);
      element.removeEventListener('dragleave', onDragLeave);
      element.removeEventListener('drop', onDropHandler);
      win?.removeEventListener('dragend', onDragEndOrBlur);
      win?.removeEventListener('blur', onDragEndOrBlur);
    };

    this.activeDisposers.add(dispose);
    return dispose;
  }

  emitAutoExcerpt(input: ExcerptDragInput): ExcerptDragPayload | null {
    const payload = sanitizeExcerptDragPayload(input);
    if (!payload) return null;

    for (const listener of [...this.autoExcerptListeners]) {
      try {
        void Promise.resolve(listener(payload)).catch(error => this.onError?.(error));
      } catch (error) {
        this.onError?.(error);
      }
    }
    return payload;
  }

  subscribeAutoExcerpt(listener: (payload: ExcerptDragPayload) => void): UiDisposer {
    this.autoExcerptListeners.add(listener);
    return () => {
      this.autoExcerptListeners.delete(listener);
    };
  }

  dispose(): void {
    this.autoExcerptListeners.clear();
    for (const off of [...this.activeDisposers]) {
      off();
    }
    this.activeDisposers.clear();
  }
}
