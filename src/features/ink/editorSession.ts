import type { InkDraftKey, InkDraftRecord } from './drafts';

export interface InkEditorSession {
  key: InkDraftKey;
  isDirty(): boolean;
  flush(): Promise<void>;
  persistDraft(): Promise<InkDraftRecord | undefined>;
}

export type InkEditorSessionResult =
  | { ok: true }
  | { ok: false; code: 'EDITOR_BUSY' };

const sessions = new Map<string, Set<InkEditorSession>>();

function registerSession(session: InkEditorSession): () => void {
  const existing = sessions.get(session.key.document_id) ?? new Set<InkEditorSession>();
  existing.add(session);
  sessions.set(session.key.document_id, existing);
  return () => {
    existing.delete(session);
    if (!existing.size) sessions.delete(session.key.document_id);
  };
}

export function hasDirtyInkEditor(documentId: string): boolean {
  return [...(sessions.get(documentId) ?? [])].some((session) => session.isDirty());
}

export async function flushInkEditor(documentId: string): Promise<InkEditorSessionResult> {
  const registered = sessions.get(documentId);
  if (!registered?.size) return { ok: true };
  const dirty = [...registered].filter((session) => session.isDirty());
  if (dirty.length > 1) return { ok: false, code: 'EDITOR_BUSY' };
  try {
    await Promise.all([...registered].map((session) => session.flush()));
    return { ok: true };
  } catch {
    return { ok: false, code: 'EDITOR_BUSY' };
  }
}

export async function persistInkEditorDrafts(documentId: string): Promise<void> {
  const registered = sessions.get(documentId);
  if (!registered?.size) return;
  await Promise.all([...registered].map((session) => session.persistDraft()));
}

export function registerInkEditorSession(session: InkEditorSession): () => void {
  return registerSession(session);
}
