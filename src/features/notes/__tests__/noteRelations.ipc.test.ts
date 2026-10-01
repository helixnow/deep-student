import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', async () => import('../../../../node_modules/@tauri-apps/api/core.js'));
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { noteRelationsService, type NoteRelation, type PutNoteRelationRequest } from '../noteRelations';

// Exercise the real @tauri invoke boundary (not a mocked service). Field names match
// NoteRelationPut's deny_unknown_fields and the V20260922 registered commands.
afterEach(clearMocks);
describe('V20260922 relationship IPC serialization', () => {
  it('round trips source/page, card/card, mistake/question and exact delete arguments', async () => {
    const rows = new Map<string, NoteRelation>();
    mockIPC((command, args) => {
      const payload = args as Record<string, any>;
      if (command === 'notes_relation_put') {
        expect(Object.keys(payload)).toEqual(['request']);
        const request = payload.request as PutNoteRelationRequest;
        expect(Object.keys(request).sort()).toEqual(['block_id', 'expected_revision', 'id', 'locator', 'note_id', 'resource_id', 'type']);
        expect(request.note_id).toBe('note_owner');
        expect(request.expected_revision).toBeNull();
        const relation: NoteRelation = { ...request, revision: 1, created_at: 'now', updated_at: 'now', invalidated_at: null,
          reference: { resource_exists: true, locator_exists: true } };
        rows.set(request.id, relation); return relation;
      }
      if (command === 'notes_relation_list') { expect(payload).toEqual({ noteId: 'note_owner' }); return [...rows.values()]; }
      if (command === 'notes_relation_delete') { expect(payload).toEqual({ id: 'rel_source', expectedRevision: 1 }); return rows.delete(payload.id); }
      if (command === 'notes_reference_status') { expect(payload).toEqual({ resourceId: 'res_pdf', locator: { type: 'page', value: 12 } }); return { resource_exists: true, locator_exists: true }; }
      throw new Error(`Unregistered command: ${command}`);
    });
    await noteRelationsService.put({ id: 'rel_source', note_id: 'note_owner', block_id: null, type: 'source', resource_id: 'res_pdf', locator: { type: 'page', value: 12 }, expected_revision: null });
    await noteRelationsService.put({ id: 'rel_card', note_id: 'note_owner', block_id: null, type: 'card', resource_id: 'doc_anki', locator: { type: 'card', value: 'card_a' }, expected_revision: null });
    await noteRelationsService.put({ id: 'rel_question', note_id: 'note_owner', block_id: 'blk_a', type: 'mistake', resource_id: 'res_exam', locator: { type: 'question', value: 'q_a' }, expected_revision: null });
    expect(await noteRelationsService.list('note_owner')).toHaveLength(3);
    expect(await noteRelationsService.referenceStatus('res_pdf', { type: 'page', value: 12 })).toEqual({ resource_exists: true, locator_exists: true });
    expect(await noteRelationsService.delete('rel_source', 1)).toBe(true);
  });
  it('propagates native CAS/write failures without success events', async () => {
    mockIPC(() => Promise.reject({ type: 'Conflict', message: 'notes.relation_conflict' }));
    await expect(noteRelationsService.delete('rel', 7)).rejects.toMatchObject({ type: 'Conflict', message: 'notes.relation_conflict' });
    await expect(noteRelationsService.put({ id: 'rel', note_id: 'note_a', block_id: null, type: 'source', resource_id: 'res_a', locator: { type: 'page', value: 1 }, expected_revision: 7 })).rejects.toMatchObject({ type: 'Conflict' });
  });
});
