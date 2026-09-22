import { describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { deleteNoteDraft, loadNoteDrafts, newDurableDraft, persistNoteDraft } from './noteDraftPersistence';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
describe('durable failed drafts', () => {
  it('serializes updates and deletes using backend-confirmed CAS revisions', async () => {
    const requests: any[] = [];
    vi.mocked(invoke).mockImplementation(async (_command, args: any) => {
      requests.push(args.request);
      return { ...args.request, revision: requests.length, deleted: _command === 'notes_state_delete' };
    });
    const first = newDurableDraft('first', 'offline', 'before', 'window');
    const second = newDurableDraft('second', 'offline', 'before', 'window', first);
    await Promise.all([persistNoteDraft('draft-note', first), persistNoteDraft('draft-note', second)]);
    await deleteNoteDraft('draft-note', second);
    expect(requests.map(request => request.expected_revision)).toEqual([null, 1, 2]);
    expect(requests[1].value.markdown).toBe('second');
  });
  it('does not overwrite a newer revision when a slow hydration returns old rows', async () => {
    let resolveLoad!: (rows: unknown) => void;
    const draft = newDurableDraft('new', 'offline', undefined, 'window');
    vi.mocked(invoke).mockImplementation(async (command, args: any) => {
      if (command === 'notes_state_list') return new Promise(resolve => { resolveLoad = resolve; });
      return { ...args.request, revision: 5, deleted: false };
    });
    const loading = loadNoteDrafts('slow-note');
    await persistNoteDraft('slow-note', draft);
    resolveLoad([{ note_id: 'slow-note', type: 'draft', key: draft.persistenceId, revision: 1, deleted: false, value: { markdown: 'old' } }]);
    await loading;
    await persistNoteDraft('slow-note', newDurableDraft('newer', 'offline', undefined, 'window', draft));
    expect(invoke).toHaveBeenLastCalledWith('notes_state_put', expect.objectContaining({ request: expect.objectContaining({ expected_revision: 5 }) }));
  });
  it('preserves the draft and surfaces a CAS conflict instead of retrying with a fresh token', async () => {
    const draft = newDurableDraft('mine', 'offline', undefined, 'window');
    vi.mocked(invoke).mockRejectedValue(new Error('notes.state_conflict'));
    const calls = vi.mocked(invoke).mock.calls.length;
    await expect(persistNoteDraft('conflict-note', draft)).rejects.toThrow('notes.state_conflict');
    expect(vi.mocked(invoke).mock.calls).toHaveLength(calls + 1);
    expect(draft.markdown).toBe('mine');
    expect(draft.persistenceRevision).toBeUndefined();
  });
});
