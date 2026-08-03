/**
 * Backend-powered backlink queries for the Notes workspace.
 *
 * The VFS keeps a persistent `note_links` graph (see src-tauri/src/cmd/notes.rs
 * `notes_get_backlinks` / `notes_get_outgoing_links`). Reading it is O(index)
 * instead of the client-side "search + download up to 256 note bodies" scan,
 * and it sees the whole library instead of a bounded candidate set.
 *
 * The panel still parses the ACTIVE note's body locally for outgoing /
 * unresolved links (a single cheap fetch that is always fresh even while the
 * note is being edited), and falls back to the legacy client scan when these
 * commands are unavailable (e.g. VFS not configured).
 */

import type { WikiLinkRelationship } from '@/features/notes/wikilinks';

/** Mirror of Rust `NoteBacklink` (serde camelCase). */
export interface NoteBacklinkDto {
  sourceId: string;
  sourceTitle: string;
  heading: string | null;
  alias: string | null;
  /** UTF-8 byte offset of the link inside the source markdown. */
  position: number;
  sourceUpdatedAt: string;
}

/** Mirror of Rust `NoteOutgoingLink` (serde camelCase). */
export interface NoteOutgoingLinkDto {
  targetId: string | null;
  targetTitle: string;
  heading: string | null;
  alias: string | null;
  position: number;
  linkType: 'wikilink' | 'noteref' | string;
  resolved: boolean;
}

// The invoke wrapper is imported lazily so this module's pure helpers stay
// importable in non-Tauri environments (unit tests, storybook-like hosts).
async function invokeBackend<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const { invokeWithDebug } = await import('@/utils/shared');
  return invokeWithDebug<T>(command, args);
}

export async function fetchBacklinksFromBackend(noteId: string): Promise<NoteBacklinkDto[]> {
  const rows = await invokeBackend<NoteBacklinkDto[]>('notes_get_backlinks', { noteId });
  return Array.isArray(rows) ? rows : [];
}

export async function fetchOutgoingLinksFromBackend(
  noteId: string,
): Promise<NoteOutgoingLinkDto[]> {
  const rows = await invokeBackend<NoteOutgoingLinkDto[]>('notes_get_outgoing_links', { noteId });
  return Array.isArray(rows) ? rows : [];
}

/**
 * Convert a UTF-8 byte offset (Rust string indexing) into a UTF-16 char
 * offset (JS string indexing). Clamps to the content bounds and tolerates
 * offsets that land inside a multi-byte sequence.
 */
export function utf8ByteToCharIndex(content: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let index = 0;
  while (index < content.length) {
    const code = content.codePointAt(index)!;
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + size > byteOffset) return index;
    bytes += size;
    index += code > 0xffff ? 2 : 1;
    if (bytes === byteOffset) return index;
  }
  return content.length;
}

/**
 * Find the exclusive char end of a link that starts at `start`.
 * Wiki links close with `]]`; `note://` references close with `)`.
 */
export function linkEndFromContent(
  content: string,
  start: number,
  linkType: string,
): number {
  const closer = linkType === 'noteref' ? ')' : ']]';
  const closeAt = content.indexOf(closer, start);
  if (closeAt >= 0) return Math.min(closeAt + closer.length, content.length);
  // Stale graph rows may point past an edited body; keep the row usable.
  return Math.min(start + 2, content.length);
}

/**
 * Adapt backend backlink rows to the `WikiLinkRelationship` shape rendered by
 * the panel. When the source markdown is available the link range is mapped to
 * char offsets so the context snippet works; otherwise a zero-width range is
 * used and the row renders without a snippet.
 */
export function backlinkRowToRelationship(
  row: NoteBacklinkDto,
  activeNoteId: string,
  activeNoteTitle: string,
  sourceContent: string | undefined,
): WikiLinkRelationship {
  let start = 0;
  let end = 0;
  let raw = '';
  if (sourceContent) {
    start = utf8ByteToCharIndex(sourceContent, row.position);
    const looksLikeNoteRef = sourceContent.startsWith('[', start)
      && !sourceContent.startsWith('[[', start);
    end = linkEndFromContent(sourceContent, start, looksLikeNoteRef ? 'noteref' : 'wikilink');
    raw = sourceContent.slice(start, end);
  }
  return {
    sourceId: row.sourceId,
    targetId: activeNoteId,
    link: {
      raw,
      target: activeNoteTitle,
      heading: row.heading ?? undefined,
      label: row.alias ?? undefined,
      start,
      end,
    },
    resolution: {
      target: activeNoteTitle,
      noteId: activeNoteId,
      matchedBy: 'id',
      ambiguous: false,
      candidateIds: [activeNoteId],
    },
  };
}
