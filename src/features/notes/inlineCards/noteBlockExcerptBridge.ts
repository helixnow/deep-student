/**
 * Note Block `DS_EXCERPT_MIME` Outbound Excerpt & Inbound Reveal Bridge (`C7 §2.3`).
 *
 * Packages Milkdown/Note blocks (`noteId`, `blockId`, `headingPath`, `markdownText`)
 * into canonical `NoteSemanticAnchor` (`ds-anchor://v1/note/...`) + `ExcerptDragPayload`
 * (`DS_EXCERPT_MIME`) so learners can drag Note paragraphs/callouts into MindMap Compound
 * Cards and click provenance pills in MindMap to jump straight back & pulse the exact block.
 */
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  DS_EXCERPT_MIME,
  formatAnchorShortLocator,
  sanitizeExcerptDragPayload,
  serializeSemanticAnchor,
  type ExcerptContentKind,
  type ExcerptDragPayload,
  type NoteSemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import type { AnchorRevealHandler, UiAnchorsHandle } from '@/ui-kernel/services/anchors';
import type { UiExcerptDndHandle } from '@/ui-kernel/services/excerpt-dnd';

const BLOCK_ID_HTML_COMMENT_RE = /<!--\s*ds:block-id=[A-Za-z0-9_-]+\s*-->/g;

export interface BuildNoteBlockAnchorParams {
  noteId: string;
  blockId?: string | null;
  /** Heading breadcrumb path (e.g. `['第2章 细胞工程', '2.1 植物体细胞杂交']` or `'第2章 > 2.1'`). */
  headingPath?: readonly string[] | string | null;
  noteTitle?: string | null;
  aliasResourceId?: string | null;
}

export interface BuildNoteBlockExcerptParams extends BuildNoteBlockAnchorParams {
  markdownText: string;
  excerptKind?: ExcerptContentKind;
  imageDataUrl?: string;
  createdAt?: number;
}

export interface NoteBlockRevealHost {
  noteId: string;
  aliasResourceId?: string | null;
  isFocused?: () => boolean;
  materializeFullDocument?: () => Promise<unknown> | unknown;
  focusBlock?: (blockId: string) => boolean | Promise<boolean>;
  pulseBlock?: (blockId: string) => void;
  scrollToHeading?: (heading: string) => boolean | void;
  scrollToTop?: () => void;
}

/** Normalizes a heading breadcrumb array or string into `{ breadcrumb, leafHeading }`. */
export function normalizeNoteHeadingPath(
  headingPath: readonly string[] | string | null | undefined,
): { breadcrumb?: string; leafHeading?: string } {
  if (!headingPath) return {};
  const parts = (Array.isArray(headingPath) ? headingPath : String(headingPath).split(/\s*>\s*/))
    .map((segment) => segment.replace(/^#+\s*/, '').trim())
    .filter((segment) => segment.length > 0);
  if (parts.length === 0) return {};
  return {
    breadcrumb: parts.join(' > ').slice(0, 120),
    leafHeading: parts[parts.length - 1].slice(0, 120),
  };
}

/** Strips internal Milkdown `<!-- ds:block-id=... -->` persistence comments from outbound excerpts. */
export function stripNoteBlockMarkers(markdownText: string): string {
  return String(markdownText ?? '')
    .replace(BLOCK_ID_HTML_COMMENT_RE, '')
    .trim();
}

/**
 * Pure builder for a canonical `NoteSemanticAnchor` (`kind: 'note'`).
 * Returns `null` if `noteId` is empty or invalid.
 */
export function buildNoteBlockSemanticAnchor(
  params: BuildNoteBlockAnchorParams,
): NoteSemanticAnchor | null {
  const resourceId = params.noteId?.trim();
  if (!resourceId) return null;

  const blockId = params.blockId?.trim() || undefined;
  const aliasResourceId = params.aliasResourceId?.trim() || undefined;
  const noteTitle = params.noteTitle?.trim() || undefined;
  const { breadcrumb, leafHeading } = normalizeNoteHeadingPath(params.headingPath);

  const label =
    noteTitle && leafHeading && noteTitle !== leafHeading
      ? `${noteTitle} · ${leafHeading}`.slice(0, 120)
      : (noteTitle || leafHeading)?.slice(0, 120);

  const candidate: NoteSemanticAnchor = {
    kind: 'note',
    resourceId,
    ...(blockId ? { blockId } : {}),
    ...(breadcrumb ? { heading: breadcrumb } : {}),
    ...(aliasResourceId ? { aliasResourceId } : {}),
    ...(label ? { label } : {}),
  };

  try {
    // Validate via ui-kernel's strict URI serializer so invalid control/path tokens fail fast.
    serializeSemanticAnchor(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Pure builder packaging a Note block into a validated `ExcerptDragPayload` (`DS_EXCERPT_MIME`).
 */
export function buildNoteBlockExcerptPayload(
  params: BuildNoteBlockExcerptParams,
): ExcerptDragPayload | null {
  const anchor = buildNoteBlockSemanticAnchor(params);
  if (!anchor) return null;

  const cleanedText = stripNoteBlockMarkers(params.markdownText);
  const { breadcrumb } = normalizeNoteHeadingPath(params.headingPath);
  const fallbackText = breadcrumb || anchor.label || anchor.resourceId;
  const text = (cleanedText || fallbackText).slice(0, 4000);
  if (!text) return null;

  const sourceTitle = params.noteTitle?.trim() || anchor.label || undefined;

  return sanitizeExcerptDragPayload({
    version: 1,
    excerptKind: params.excerptKind ?? 'text',
    text,
    ...(params.imageDataUrl ? { imageDataUrl: params.imageDataUrl } : {}),
    anchor,
    ...(sourceTitle ? { sourceTitle } : {}),
    createdAt: params.createdAt ?? Date.now(),
  });
}

/**
 * Starts a native HTML5 drag carrying `DS_EXCERPT_MIME`, `text/uri-list`, and cited `text/plain`
 * without touching `WB_RESOURCE_MIME`.
 */
export function startNoteBlockExcerptDrag(
  event: Pick<DragEvent, 'dataTransfer'>,
  params: BuildNoteBlockExcerptParams,
  dndHub?: Pick<UiExcerptDndHandle, 'startExcerptDrag'> | null,
): ExcerptDragPayload | null {
  const payload = buildNoteBlockExcerptPayload(params);
  if (!payload) return null;

  const resolvedDnd = dndHub ?? getAppKernel()?.dnd ?? null;
  if (resolvedDnd) {
    return resolvedDnd.startExcerptDrag(event, {
      excerptKind: payload.excerptKind,
      text: payload.text,
      ...(payload.imageDataUrl ? { imageDataUrl: payload.imageDataUrl } : {}),
      anchor: payload.anchor,
      ...(payload.sourceTitle ? { sourceTitle: payload.sourceTitle } : {}),
      createdAt: payload.createdAt,
    });
  }

  const dt = event.dataTransfer;
  if (dt) {
    try {
      const locator = formatAnchorShortLocator(payload.anchor);
      const citeLabel = [payload.sourceTitle, locator].filter(Boolean).join(' · ') || payload.anchor.resourceId;
      const plainCitation = `${payload.text
        .split(/\r?\n/)
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n')}\n> — [${citeLabel}](${payload.anchorUri})`;
      dt.setData(DS_EXCERPT_MIME, JSON.stringify(payload));
      dt.setData('text/uri-list', payload.anchorUri);
      dt.setData('text/plain', plainCitation);
      dt.effectAllowed = 'copyLink';
    } catch {
      // Ignore synthetic DataTransfer restrictions in isolated unit tests.
    }
  }
  return payload;
}

/**
 * Emits a Note block excerpt over the Auto-Excerpt bus ("划选即摘录").
 */
export function emitNoteBlockAutoExcerpt(
  params: BuildNoteBlockExcerptParams,
  dndHub?: Pick<UiExcerptDndHandle, 'emitAutoExcerpt'> | null,
): ExcerptDragPayload | null {
  const payload = buildNoteBlockExcerptPayload(params);
  if (!payload) return null;
  const resolvedDnd = dndHub ?? getAppKernel()?.dnd ?? null;
  if (!resolvedDnd) return payload;
  return resolvedDnd.emitAutoExcerpt({
    excerptKind: payload.excerptKind,
    text: payload.text,
    ...(payload.imageDataUrl ? { imageDataUrl: payload.imageDataUrl } : {}),
    anchor: payload.anchor,
    ...(payload.sourceTitle ? { sourceTitle: payload.sourceTitle } : {}),
  });
}

/**
 * Builds a reusable `'note'` `AnchorRevealHandler` that scrolls/focuses the exact `blockId`
 * (or falls back to the leaf heading in `headingPath`) and triggers a pulse highlight.
 */
export function createNoteAnchorRevealHandler(
  host: NoteBlockRevealHost,
): AnchorRevealHandler<'note'> {
  return {
    canHandle: (anchor) => {
      const targetId = host.noteId?.trim();
      if (!targetId) return false;
      const alias = host.aliasResourceId?.trim();
      const matchesPrimary =
        anchor.resourceId === targetId || anchor.aliasResourceId === targetId;
      const matchesAlias = Boolean(
        alias && (anchor.resourceId === alias || anchor.aliasResourceId === alias),
      );
      if (!matchesPrimary && !matchesAlias) return false;
      return host.isFocused?.() ? 'exact-focused' : 'exact-mounted';
    },
    reveal: async (anchor, { pulse }) => {
      try {
        await host.materializeFullDocument?.();
      } catch {
        // Proceed with best-effort reveal on currently loaded slice.
      }

      if (anchor.blockId && host.focusBlock) {
        const focused = await host.focusBlock(anchor.blockId);
        if (focused) {
          if (pulse) {
            host.pulseBlock?.(anchor.blockId);
          }
          return true;
        }
      }

      if (anchor.heading && host.scrollToHeading) {
        const { leafHeading } = normalizeNoteHeadingPath(anchor.heading);
        const headingTarget = leafHeading || anchor.heading;
        host.scrollToHeading(headingTarget);
        return true;
      }

      host.scrollToTop?.();
      return true;
    },
  };
}

/**
 * Registers a `'note'` `AnchorRevealHandler` onto `UiAnchorsHandle` (or `getAppKernel().anchors`)
 * and returns an idempotent disposer.
 */
export function registerNoteBlockRevealHandler(
  host: NoteBlockRevealHost,
  anchorsHub?: Pick<UiAnchorsHandle, 'registerAnchorRevealHandler'> | null,
): () => void {
  const resolvedAnchors = anchorsHub ?? getAppKernel()?.anchors ?? null;
  if (!resolvedAnchors) return () => {};
  return resolvedAnchors.registerAnchorRevealHandler('note', createNoteAnchorRevealHandler(host));
}
