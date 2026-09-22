import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import type { RetainedNoteDraft } from './fullDocument';

type DraftRow = { note_id: string; type: 'draft'; key: string; revision: number; deleted: boolean; value: unknown };
export type DurableNoteDraft = RetainedNoteDraft & { persistenceId: string; persistenceRevision?: number; windowId: string };
const queues = new Map<string, Promise<unknown>>();
const revisions = new Map<string, number>();
const keyFor = (noteId: string, key: string) => `${noteId}/${key}`;
function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const pending = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, pending);
  void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); }).catch(() => {});
  return pending;
}
export function newDurableDraft(markdown: string, error: string, previousMarkdown: string | undefined, windowId: string,
  previous?: RetainedNoteDraft): DurableNoteDraft {
  const old = previous as Partial<DurableNoteDraft> | undefined;
  return { markdown, error, previousMarkdown, windowId,
    persistenceId: old?.persistenceId ?? `draft_${crypto.randomUUID()}`,
    persistenceRevision: old?.persistenceRevision };
}
export function persistNoteDraft(noteId: string, draft: DurableNoteDraft): Promise<void> {
  const key = keyFor(noteId, draft.persistenceId);
  return serialized(key, async () => {
    const row = await invoke<DraftRow>('notes_state_put', { request: {
      note_id: noteId, type: 'draft', key: draft.persistenceId,
      expected_revision: revisions.get(key) ?? draft.persistenceRevision ?? null,
      value: { markdown: draft.markdown, error: draft.error, previous_markdown: draft.previousMarkdown ?? null, window_id: draft.windowId },
    } });
    if (!row || row.type !== 'draft' || row.key !== draft.persistenceId) throw new Error(i18n.t('notes:draftPersistence.save_unconfirmed', { defaultValue: '草稿持久化未确认。' }));
    revisions.set(key, row.revision);
    draft.persistenceRevision = row.revision;
  });
}
export async function loadNoteDrafts(noteId: string): Promise<DurableNoteDraft[]> {
  const rows = await invoke<DraftRow[]>('notes_state_list', { request: { note_id: noteId, type: 'draft', include_deleted: false } });
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    const value = row.value as Record<string, unknown> | null;
    if (row.deleted || row.note_id !== noteId || row.type !== 'draft' || typeof value?.markdown !== 'string') return [];
    return [{ markdown: value.markdown, error: typeof value.error === 'string' ? value.error : i18n.t('notes:draftPersistence.recovered', { defaultValue: '已恢复未保存草稿。' }),
      previousMarkdown: typeof value.previous_markdown === 'string' ? value.previous_markdown : undefined,
      windowId: typeof value.window_id === 'string' ? value.window_id : '', persistenceId: row.key, persistenceRevision: row.revision }];
  });
}
export function deleteNoteDraft(noteId: string, draft: DurableNoteDraft): Promise<void> {
  const key = keyFor(noteId, draft.persistenceId);
  return serialized(key, async () => {
    const expected = revisions.get(key) ?? draft.persistenceRevision;
    if (expected === undefined) throw new Error(i18n.t('notes:draftPersistence.save_before_discard', { defaultValue: '草稿尚未持久化，请先重试保存再丢弃。' }));
    const row = await invoke<DraftRow>('notes_state_delete', { request: {
      note_id: noteId, type: 'draft', key: draft.persistenceId, expected_revision: expected,
    } });
    if (!row?.deleted) throw new Error(i18n.t('notes:draftPersistence.delete_unconfirmed', { defaultValue: '草稿删除未确认。' }));
    revisions.set(key, row.revision);
  });
}
