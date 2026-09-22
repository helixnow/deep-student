import { invoke } from '@tauri-apps/api/core';

/** Exact V20260922 IPC shapes: top-level args camelCase, request/response snake_case. */
export type NoteRelationType = 'source' | 'card' | 'mistake';
export type NoteRelationLocator = { type: 'whole' } | { type: 'page'; value: number }
  | { type: 'block' | 'card' | 'question'; value: string };
export interface NoteReferenceStatus { resource_exists: boolean; locator_exists: boolean }
export interface NoteRelation {
  id: string;
  note_id: string;
  block_id: string | null;
  type: NoteRelationType;
  resource_id: string;
  locator: NoteRelationLocator;
  revision: number;
  invalidated_at: string | null;
  created_at: string;
  updated_at: string;
  reference: NoteReferenceStatus;
}
export interface PutNoteRelationRequest {
  id: string;
  note_id: string;
  block_id: string | null;
  type: NoteRelationType;
  resource_id: string;
  locator: NoteRelationLocator;
  expected_revision: number | null;
}
export const NOTE_RELATIONS_CHANGED = 'notes:relations-changed';
export interface NoteRelationsService {
  list(noteId: string): Promise<NoteRelation[]>;
  put(request: PutNoteRelationRequest): Promise<NoteRelation>;
  delete(id: string, expectedRevision: number): Promise<boolean>;
  referenceStatus(resourceId: string, locator: NoteRelationLocator): Promise<NoteReferenceStatus>;
}
export const noteRelationsService: NoteRelationsService = {
  list: (noteId) => invoke<NoteRelation[]>('notes_relation_list', { noteId }),
  async put(request) {
    const relation = await invoke<NoteRelation>('notes_relation_put', { request });
    window.dispatchEvent(new CustomEvent(NOTE_RELATIONS_CHANGED, { detail: { noteId: request.note_id } }));
    return relation;
  },
  async delete(id, expectedRevision) {
    const deleted = await invoke<boolean>('notes_relation_delete', { id, expectedRevision });
    if (deleted) window.dispatchEvent(new Event(NOTE_RELATIONS_CHANGED));
    return deleted;
  },
  referenceStatus: (resourceId, locator) => invoke<NoteReferenceStatus>('notes_reference_status', { resourceId, locator }),
};
export function isNoteRelationUsable(relation: NoteRelation): boolean {
  return !relation.invalidated_at && relation.reference.resource_exists && relation.reference.locator_exists;
}
