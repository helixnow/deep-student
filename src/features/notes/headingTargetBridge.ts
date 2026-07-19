export interface NotesHeadingTarget {
  noteId: string;
  heading: string;
}

export const NOTES_HEADING_TARGET_EVENT = 'notes:heading-target';

const pendingByNoteId = new Map<string, string>();

/** Retain heading navigation across opening a note whose editor is not mounted yet. */
export function publishNotesHeadingTarget(request: NotesHeadingTarget): void {
  const heading = request.heading.trim();
  if (!request.noteId || !heading) return;
  pendingByNoteId.set(request.noteId, heading);
  window.dispatchEvent(new CustomEvent<NotesHeadingTarget>(NOTES_HEADING_TARGET_EVENT, {
    detail: { noteId: request.noteId, heading },
  }));
}

export function consumeNotesHeadingTarget(noteId: string | null | undefined): string | null {
  if (!noteId) return null;
  const heading = pendingByNoteId.get(noteId) ?? null;
  if (heading !== null) pendingByNoteId.delete(noteId);
  return heading;
}

export function clearPendingNotesHeadingTargetsForTests(): void {
  pendingByNoteId.clear();
}
