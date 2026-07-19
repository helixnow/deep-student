export const NOTES_OWNED_OPEN_NOTE_SOURCES = [
  'notes-editor',
  'wikilink',
  'mention',
] as const;

export type NotesOwnedOpenNoteSource = typeof NOTES_OWNED_OPEN_NOTE_SOURCES[number];

export interface DstuOpenNoteDetail {
  noteId: string;
  source?: string;
  target?: string;
  heading?: string;
}

/** True only for events whose navigation is owned by the Notes workspace. */
export function isNotesOwnedOpenNoteSource(source: unknown): source is NotesOwnedOpenNoteSource {
  return typeof source === 'string'
    && (NOTES_OWNED_OPEN_NOTE_SOURCES as readonly string[]).includes(source);
}

/** Explicit non-Notes sources are owned by Chat. */
export function shouldChatHandleOpenNote(detail: DstuOpenNoteDetail | null | undefined): boolean {
  return Boolean(detail?.noteId)
    && typeof detail?.source === 'string'
    && !isNotesOwnedOpenNoteSource(detail.source);
}

/** Source-less legacy events and Notes editor events are owned by Workbench. */
export function shouldWorkbenchHandleOpenNote(
  detail: DstuOpenNoteDetail | null | undefined,
): boolean {
  return Boolean(detail?.noteId)
    && (detail?.source == null || isNotesOwnedOpenNoteSource(detail.source));
}
