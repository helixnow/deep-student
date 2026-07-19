export interface NotesFindQuery {
  noteId: string;
  query: string;
}

export const NOTES_FIND_QUERY_EVENT = 'notes:find-query';

const pendingByNoteId = new Map<string, string>();

/**
 * Publish-and-retain delivery for cold editor mounts. The DOM event handles an
 * already-mounted editor; the map handles an editor whose effect subscribes
 * after the workspace has opened its tab.
 */
export function publishNotesFindQuery(request: NotesFindQuery): void {
  const query = request.query.trim();
  if (!request.noteId || !query) return;
  pendingByNoteId.set(request.noteId, query);
  window.dispatchEvent(new CustomEvent<NotesFindQuery>(NOTES_FIND_QUERY_EVENT, {
    detail: { noteId: request.noteId, query },
  }));
}

export function consumeNotesFindQuery(noteId: string | null | undefined): string | null {
  if (!noteId) return null;
  const query = pendingByNoteId.get(noteId) ?? null;
  if (query !== null) pendingByNoteId.delete(noteId);
  return query;
}

export function clearPendingNotesFindQueriesForTests(): void {
  pendingByNoteId.clear();
}
