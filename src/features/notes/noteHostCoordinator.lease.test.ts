import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NoteHostCoordinator, type NoteHostParticipant, type NoteLeaseStatus } from './noteHostCoordinator';
import type { FullDocumentSearchApi } from './fullDocument';

const ipc = vi.hoisted(() => ({ call: vi.fn(), handlers: new Map<string, Set<(event: { payload: any }) => void>>() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.call }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async (name, handler) => {
  const handlers = ipc.handlers.get(name) ?? new Set(); handlers.add(handler); ipc.handlers.set(name, handlers);
  return () => handlers.delete(handler);
}) }));
const cleanups: Array<() => void> = [];
function emit(name: string, payload: unknown) {
  for (const handler of ipc.handlers.get(name) ?? []) handler({ payload: structuredClone(payload) });
}
let lease: NoteLeaseStatus | null;
let participants: Map<string, string>;
let drafts: Map<string, { markdown: string; expected_updated_at: string }>;
let disk: Map<string, { markdown: string; token: string }>;
beforeEach(() => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  lease = null; participants = new Map(); drafts = new Map();
  disk = new Map([['source', { markdown: 'saved', token: 'v1' }], ['target', { markdown: 'target', token: 'v1' }]]);
  ipc.handlers.clear(); ipc.call.mockReset();
  ipc.call.mockImplementation(async (command: string, args: any) => {
    if (command === 'notes_editor_register') {
      const id = `p${participants.size}`; participants.set(id, args.noteId);
      if (lease) {
        lease.waiting_for.push(id);
        if (lease.phase === 'ready') lease.phase = 'pending';
        emit('notes:lease-changed', lease);
      }
      return { participant_id: id, active_lease: lease, expires_at: Date.now() / 1000 + 45 };
    }
    if (command === 'notes_editor_unregister') { participants.delete(args.participantId); return []; }
    if (command === 'notes_editor_begin') {
      lease = { token: 'lease', operation_id: args.operationId, owner_id: args.participantId, phase: 'pending',
        expires_at: Date.now() / 1000 + 30, notes: args.noteIds.map((id: string) => ({ note_id: id, updated_at: disk.get(id)!.token })),
        waiting_for: [...participants.keys()] };
      emit('notes:lease-changed', lease); return structuredClone(lease);
    }
    if (command === 'notes_editor_freeze_ack') {
      const id = args.lease.participant_id, noteId = participants.get(id)!;
      if (args.draft.expected_updated_at !== disk.get(noteId)!.token) throw new Error('stale draft');
      drafts.set(id, args.draft);
      lease!.waiting_for = lease!.waiting_for.filter(p => p !== id);
      if (!lease!.waiting_for.length) lease!.phase = 'ready';
      emit('notes:lease-changed', lease); return structuredClone(lease);
    }
    if (command === 'notes_editor_flush') {
      expect(lease!.phase).toBe('ready');
      const draft = [...drafts].find(([id]) => participants.get(id) === args.noteId)?.[1];
      if (draft) disk.set(args.noteId, { markdown: draft.markdown, token: 'v2' });
      return { note_id: args.noteId, updated_at: disk.get(args.noteId)!.token };
    }
    if (command === 'write') {
      expect(args.lease.token).toBe('lease');
      disk.set('source', { markdown: 'committed', token: 'v3' }); return 'receipt';
    }
    if (command === 'notes_editor_finish') {
      lease!.phase = 'refreshing'; lease!.waiting_for = [...participants.keys()];
      lease!.notes.forEach(note => { note.updated_at = disk.get(note.note_id)!.token; });
      emit('notes:lease-changed', lease); return structuredClone(lease);
    }
    if (command === 'notes_editor_refresh_ack') {
      expect(args.updatedAt).toBe(disk.get(participants.get(args.lease.participant_id)!)!.token);
      lease!.waiting_for = lease!.waiting_for.filter(id => id !== args.lease.participant_id);
      emit('notes:lease-changed', lease); return structuredClone(lease);
    }
    if (command === 'notes_editor_lease_status') return structuredClone(lease);
    if (command === 'notes_editor_release') {
      if (!args.cancel) expect(lease!.waiting_for).toEqual([]);
      const ended = { token: 'lease', note_ids: lease!.notes.map(note => note.note_id), reason: args.cancel ? 'cancelled' : 'released' };
      lease = null; emit('notes:lease-ended', ended); return ended;
    }
    throw new Error(`Unexpected ${command}`);
  });
});
afterEach(async () => {
  cleanups.splice(0).forEach(cleanup => cleanup());
  await Promise.resolve();
  delete (window as any).__TAURI_INTERNALS__;
});
function mount(host: NoteHostCoordinator, id: string, noteId: string, markdown: string, token = 'v1') {
  let baseline = token;
  const release = vi.fn();
  const entry: NoteHostParticipant = {
    id, noteId, api: { getFullDocument: () => ({ noteId, revision: 1, markdown }), getStorageUpdatedAt: () => baseline } as FullDocumentSearchApi,
    dirty: () => markdown !== disk.get(noteId)!.markdown, lock: vi.fn(() => release), settle: vi.fn(async () => {}),
    flush: vi.fn(async () => { throw new Error('ordinary save under lease'); }), invalidate: vi.fn(),
    refresh: vi.fn(async () => { markdown = disk.get(noteId)!.markdown; baseline = disk.get(noteId)!.token; }),
  };
  cleanups.push(host.register(entry));
  return { entry, release };
}

it('registers once, flushes a remote-only target draft, and awaits both WebViews refresh ACKs', async () => {
  const owner = new NoteHostCoordinator(), peer = new NoteHostCoordinator();
  const a = mount(owner, 'a', 'source', 'saved'), b = mount(peer, 'b', 'target', 'unsaved remote');
  const result = await owner.withLockedNotes(['source', 'target'], async () => {
    await owner.flushPendingSaves(['source', 'target']);
    expect(disk.get('target')!.markdown).toBe('unsaved remote');
    return owner.invoke('write');
  });
  expect(result).toBe('receipt');
  expect(ipc.call.mock.calls.filter(([cmd]) => cmd === 'notes_editor_register')).toHaveLength(2);
  expect(a.release).toHaveBeenCalledOnce(); expect(b.release).toHaveBeenCalledOnce();
  expect(b.entry.refresh).toHaveBeenCalledOnce();
  expect(lease).toBeNull();
});

it('rejects a stale editor token rather than relabelling its draft with the latest disk token', async () => {
  const host = new NoteHostCoordinator();
  const { release } = mount(host, 'a', 'source', 'old draft', 'old-token');
  const task = vi.fn();
  await expect(host.withLockedNotes(['source'], task)).rejects.toThrow('stale draft');
  expect(task).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  expect(disk.get('source')!.markdown).toBe('saved');
});

it('unregisters a participant whose mount disappears while registration is in flight', async () => {
  const host = new NoteHostCoordinator();
  mount(host, 'a', 'source', 'saved');
  cleanups.pop()!();
  await vi.waitFor(() => expect(ipc.call).toHaveBeenCalledWith('notes_editor_unregister', expect.anything()));
  expect(participants.size).toBe(0);
});

it('cancels on refresh failure and leaves failed editors invalidated after releasing interaction locks', async () => {
  const host = new NoteHostCoordinator();
  const { entry, release } = mount(host, 'a', 'source', 'saved');
  entry.refresh = vi.fn(async () => { throw new Error('refresh failed'); });
  await expect(host.withLockedNotes(['source'], () => host.invoke('write'))).rejects.toThrow('refresh failed');
  expect(entry.invalidate).toHaveBeenCalled(); expect(release).toHaveBeenCalledOnce();
  expect(ipc.call).toHaveBeenCalledWith('notes_editor_release', { lease: { token: 'lease', participant_id: 'p0' }, cancel: true });
  expect(disk.get('source')!.markdown).toBe('committed');
});

it('a late participant joins the owner barrier without being locked twice', async () => {
  const host = new NoteHostCoordinator();
  mount(host, 'a', 'source', 'saved');
  let late!: ReturnType<typeof mount>;
  await host.withLockedNotes(['source'], async () => {
    late = mount(host, 'b', 'source', 'saved');
    await vi.waitFor(() => expect(lease!.phase).toBe('ready'));
    await vi.waitFor(() => expect(drafts.size).toBe(2));
    return host.invoke('write');
  });
  expect(late.entry.lock).toHaveBeenCalledOnce(); expect(late.release).toHaveBeenCalledOnce();
  expect(late.entry.refresh).toHaveBeenCalledOnce();
});
