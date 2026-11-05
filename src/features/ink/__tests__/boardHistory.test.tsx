import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DraftWriteRejectedError,
  InkBoardDraftJournalStore,
  type InkBoardDraftClaim,
  type InkBoardDraftJournal,
  type InkBoardDraftRecord,
  type InkBoardDraftStorage,
} from '../boardDrafts';
import { InkApiError } from '../api';
import { useInkBoardDocument } from '../useInkBoardDocument';
import {
  INK_BOARD_SCHEMA_VERSION,
  type InkBoardBounds,
  type InkBoardChunk,
  type InkBoardChunkRef,
  type InkBoardManifest,
  type InkBoardObject,
} from '../types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: undefined as undefined | ((event: { payload: unknown }) => unknown),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, listener: (event: { payload: unknown }) => unknown) => {
    mocks.listener = listener;
    return () => {
      mocks.listener = undefined;
    };
  }),
}));

const DOCUMENT_ID = 'ink_board_history1';
const PAGE_ID = 'board_page_history1';

const textObject = (id: string, zIndex: number): InkBoardObject => ({
  id,
  author: 'user',
  created_at: 1,
  z_index: zIndex,
  content: {
    kind: 'text',
    rect: { x: zIndex * 20, y: 0, width: 10, height: 10 },
    text: id,
    font_size: 12,
    color: '#000000',
  },
});

const chunkRef = (
  chunkId: string,
  bounds: InkBoardBounds,
  objectCount: number,
): InkBoardChunkRef => ({
  chunk_id: chunkId,
  blob_hash: `hash-${chunkId}`,
  byte_length: 256,
  object_count: objectCount,
  sample_count: 0,
  bounds,
});

const chunk = (chunkId: string, objects: InkBoardObject[]): InkBoardChunk => ({
  schema_version: INK_BOARD_SCHEMA_VERSION,
  chunk_id: chunkId,
  objects,
});

function makeManifest(overrides: Partial<InkBoardManifest> = {}): InkBoardManifest {
  return {
    schema_version: INK_BOARD_SCHEMA_VERSION,
    document_id: DOCUMENT_ID,
    revision: 'rev-1',
    title: 'History board',
    source: { kind: 'blank' },
    pages: [],
    surface: {
      kind: 'board',
      page_id: PAGE_ID,
      ruling: 'grid',
      bounds: { x: -500, y: -500, width: 1000, height: 1000 },
    },
    chunks: [],
    ...overrides,
  };
}

interface CasRequest {
  document_id: string;
  expected_revision: string;
  operation_id: string;
  changed: InkBoardChunk[];
  deleted: string[];
}

function createHarness(initial: {
  manifest: InkBoardManifest;
  chunks: Record<string, InkBoardChunk>;
  saveChunks?: (request: CasRequest) => InkBoardManifest | Promise<InkBoardManifest>;
}) {
  const state = {
    manifest: initial.manifest,
    chunks: { ...initial.chunks },
  };
  const casRequests: CasRequest[] = [];

  mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
    if (command === 'vfs_ink_get') return structuredClone(state.manifest);
    if (command === 'vfs_ink_get_chunks') {
      return payload.request.chunk_ids
        .map((chunkId: string) => state.chunks[chunkId])
        .filter((value: InkBoardChunk | undefined): value is InkBoardChunk => Boolean(value))
        .map((value: InkBoardChunk) => structuredClone(value));
    }
    if (command === 'vfs_ink_save_chunks') {
      const request = structuredClone(payload.request) as CasRequest;
      casRequests.push(request);
      const saved = await (initial.saveChunks?.(request) ?? {
        ...state.manifest,
        revision: `rev-saved-${casRequests.length}`,
      });
      state.manifest = saved;
      return structuredClone(saved);
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  return { state, casRequests };
}

function createMemoryJournal() {
  const records = new Map<string, InkBoardDraftRecord>();
  const owners = new Map<string, string>();
  const floors = new Map<string, number>();

  const currentSequence = (documentId: string): number =>
    records.get(documentId)?.sequence ?? floors.get(documentId) ?? 0;

  const storage: InkBoardDraftStorage = {
    async read(key) {
      return records.get(key.document_id);
    },
    async readSequenceFloor(key) {
      return currentSequence(key.document_id);
    },
    async claim(key, owner): Promise<InkBoardDraftClaim> {
      const id = key.document_id;
      const draft = records.get(id);
      if (draft) {
        const owned = { ...structuredClone(draft), owner };
        records.set(id, owned);
        owners.set(id, owner);
        return {
          owner,
          sequence_floor: owned.sequence,
          draft: structuredClone(owned),
        };
      }
      owners.set(id, owner);
      return { owner, sequence_floor: floors.get(id) ?? 0 };
    },
    async write(record) {
      const id = record.document_id;
      const existingOwner = owners.get(id);
      if (existingOwner !== undefined) {
        if (existingOwner !== record.owner) throw new DraftWriteRejectedError('ownership');
      } else if (record.owner !== undefined) {
        throw new DraftWriteRejectedError(
          'ownership',
          'A new owner must be established through claim().',
        );
      }
      const sequence = currentSequence(id);
      if (record.sequence < sequence) throw new DraftWriteRejectedError('stale');
      if (record.sequence === sequence) {
        const current = records.get(id);
        if (current && JSON.stringify(current) === JSON.stringify(record)) return;
        throw new DraftWriteRejectedError('stale');
      }
      records.set(id, structuredClone(record));
    },
    async remove(key) {
      const id = key.document_id;
      if (owners.get(id) !== undefined) {
        throw new DraftWriteRejectedError(
          'ownership',
          'An owned board draft must be discarded by its owner.',
        );
      }
      const current = records.get(id);
      if (!current) return;
      floors.set(id, Math.max(floors.get(id) ?? 0, current.sequence));
      records.delete(id);
    },
    async removeIfSequenceAtMost(key, sequence, owner) {
      const id = key.document_id;
      const existingOwner = owners.get(id);
      if (existingOwner !== undefined && existingOwner !== owner) {
        throw new DraftWriteRejectedError('ownership');
      }
      const current = currentSequence(id);
      if (current > sequence) return;
      floors.set(id, Math.max(sequence, current));
      records.delete(id);
    },
  };

  return {
    records,
    owners,
    floors,
    journal: new InkBoardDraftJournalStore(storage),
  };
}

function delegateJournal(
  journal: InkBoardDraftJournal,
  persist: (record: InkBoardDraftRecord) => Promise<void>,
): InkBoardDraftJournal {
  return {
    read: (key) => journal.read(key),
    claim: (key, owner) => journal.claim(key, owner),
    persist,
    discard: (key, throughSequence, owner) => journal.discard(key, throughSequence, owner),
    readSequenceFloor: (key) => journal.readSequenceFloor(key),
  };
}

async function emitChanged(payload: Record<string, unknown>) {
  await act(async () => {
    await mocks.listener?.({ payload });
  });
}

const visibleBounds: InkBoardBounds = { x: 0, y: 0, width: 100, height: 100 };

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listener = undefined;
});

describe('useInkBoardDocument board history', () => {
  it('keeps removal in memory until draft protection and preserves the remaining object order', async () => {
    const objects = [
      textObject('obj-a', 0),
      textObject('obj-b', 1),
      textObject('obj-c', 2),
    ];
    const boardChunk = chunk('chunk-a', objects);
    createHarness({
      manifest: makeManifest({
        chunks: [chunkRef('chunk-a', visibleBounds, objects.length)],
      }),
      chunks: { 'chunk-a': boardChunk },
    });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible(visibleBounds);
    });

    await act(async () => {
      await result.current.removeObjects(['obj-b']);
    });
    expect(records.size).toBe(0);
    expect(result.current.saveStatus).toBe('pending');
    await act(async () => { await result.current.persistDraft(); });

    const record = records.get(DOCUMENT_ID);
    expect(record?.sequence).toBe(1);
    expect(record?.changed).toHaveLength(1);
    expect(record?.changed[0].chunk_id).toBe('chunk-a');
    expect(record?.changed[0].objects.map((object) => object.id)).toEqual(['obj-a', 'obj-c']);
    expect(record?.deleted).toEqual([]);
    expect(result.current.chunks.map((entry) => entry.chunk_id)).toEqual(['chunk-a']);
    expect(result.current.chunks[0].objects.map((object) => object.id)).toEqual(['obj-a', 'obj-c']);
    expect(result.current.dirtyChunks).toContainEqual({
      chunk_id: 'chunk-a',
      base_blob_hash: 'hash-chunk-a',
    });
    expect(result.current.undoDepth).toBe(1);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'vfs_ink_save_chunks')).toBe(false);
  });

  it('deletes the canonical chunk with its last removed object in the same CAS without writing an empty chunk', async () => {
    const objects = [textObject('obj-only', 0)];
    const boardChunk = chunk('chunk-a', objects);
    const harness = createHarness({
      manifest: makeManifest({
        chunks: [chunkRef('chunk-a', visibleBounds, objects.length)],
      }),
      chunks: { 'chunk-a': boardChunk },
      saveChunks: () => makeManifest({ revision: 'rev-2' }),
    });
    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible(visibleBounds);
    });

    await act(async () => {
      await result.current.removeObjects(['obj-only']);
    });

    expect(result.current.chunks).toEqual([]);

    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.chunks.map((entry) => entry.chunk_id)).toEqual(['chunk-a']);
    expect(result.current.chunks[0].objects.map((object) => object.id)).toEqual(['obj-only']);

    await act(async () => {
      await result.current.redo();
    });
    expect(result.current.chunks).toEqual([]);

    await act(async () => {
      await result.current.save();
    });

    expect(harness.casRequests).toHaveLength(1);
    const request = harness.casRequests[0];
    expect(request.changed).toEqual([]);
    expect(request.deleted).toEqual(['chunk-a']);
    expect(request.changed.some((entry) => entry.objects.length === 0)).toBe(false);
    expect(result.current.manifest?.chunks).toEqual([]);
  });

  it('rejects an unknown or unloaded object id with zero changes, no hydration, and no journal write', async () => {
    const loadedObjects = [textObject('obj-a', 0)];
    const loadedChunk = chunk('chunk-a', loadedObjects);
    const unloadedObjects = [textObject('obj-hidden', 1)];
    createHarness({
      manifest: makeManifest({
        chunks: [
          chunkRef('chunk-a', visibleBounds, loadedObjects.length),
          chunkRef('chunk-b', { x: 200, y: 0, width: 100, height: 100 }, unloadedObjects.length),
        ],
      }),
      chunks: {
        'chunk-a': loadedChunk,
        'chunk-b': chunk('chunk-b', unloadedObjects),
      },
    });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible(visibleBounds);
    });
    const getChunksBefore = mocks.invoke.mock.calls
      .filter(([command]) => command === 'vfs_ink_get_chunks').length;

    let unloadedError: unknown;
    await act(async () => {
      try {
        await result.current.removeObjects(['obj-hidden']);
      } catch (error) {
        unloadedError = error;
      }
    });

    expect(unloadedError).toBeInstanceOf(Error);
    expect(String(unloadedError)).toMatch(/loaded|unknown|ownership|missing/i);
    expect(result.current.chunks.map((entry) => entry.chunk_id)).toEqual(['chunk-a']);
    expect(result.current.chunks[0].objects.map((object) => object.id)).toEqual(['obj-a']);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(result.current.undoDepth).toBe(0);
    expect(records.size).toBe(0);

    let mixedError: unknown;
    await act(async () => {
      try {
        await result.current.removeObjects(['obj-a', 'obj-missing']);
      } catch (error) {
        mixedError = error;
      }
    });

    expect(mixedError).toBeInstanceOf(Error);
    expect(String(mixedError)).toMatch(/loaded|unknown|ownership|missing/i);
    expect(result.current.chunks.map((entry) => entry.chunk_id)).toEqual(['chunk-a']);
    expect(result.current.chunks[0].objects.map((object) => object.id)).toEqual(['obj-a']);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(result.current.undoDepth).toBe(0);
    expect(records.size).toBe(0);
    expect(mocks.invoke.mock.calls
      .filter(([command]) => command === 'vfs_ink_get_chunks')).toHaveLength(getChunksBefore);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'vfs_ink_save_chunks')).toBe(false);
  });

  it('clears both undo and redo on a clean remote revision epoch', async () => {
    const objects = [
      textObject('obj-a', 0),
      textObject('obj-b', 1),
      textObject('obj-c', 2),
    ];
    const boardChunk = chunk('chunk-a', objects);
    let saveRevision = 2;
    const harness = createHarness({
      manifest: makeManifest({
        chunks: [chunkRef('chunk-a', visibleBounds, objects.length)],
      }),
      chunks: { 'chunk-a': boardChunk },
      saveChunks: () => makeManifest({
        revision: `rev-${saveRevision++}`,
        chunks: [chunkRef('chunk-a', visibleBounds, objects.length)],
      }),
    });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible(visibleBounds);
    });

    await act(async () => {
      await result.current.removeObjects(['obj-b']);
      await result.current.removeObjects(['obj-c']);
    });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.undoDepth).toBe(2);

    await act(async () => {
      await result.current.undo();
    });
    await act(async () => {
      await result.current.save();
    });
    expect(result.current.undoDepth).toBe(1);
    expect(result.current.redoDepth).toBe(1);
    expect(result.current.saveStatus).toBe('saved');

    harness.state.manifest = makeManifest({
      revision: 'rev-remote',
      chunks: [chunkRef('chunk-a', visibleBounds, objects.length)],
    });
    await emitChanged({
      document_id: DOCUMENT_ID,
      revision: 'rev-remote',
      operation_id: 'other-client',
      affected_page_ids: [PAGE_ID],
    });
    await waitFor(() => expect(result.current.manifest?.revision).toBe('rev-remote'));

    expect(result.current.revisionEpoch).toBe(1);
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.redoDepth).toBe(0);
    expect(result.current.saveStatus).toBe('saved');

    const casBefore = harness.casRequests.length;
    await act(async () => {
      await result.current.undo();
      await result.current.redo();
    });

    expect(result.current.undoDepth).toBe(0);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(harness.casRequests).toHaveLength(casBefore);
    expect(records.size).toBe(0);
  });

  it('keeps removal responsive but blocks CAS when draft protection fails', async () => {
    const objects = [
      textObject('obj-a', 0),
      textObject('obj-b', 1),
    ];
    const boardChunk = chunk('chunk-a', objects);
    const harness = createHarness({
      manifest: makeManifest({
        chunks: [chunkRef('chunk-a', visibleBounds, objects.length)],
      }),
      chunks: { 'chunk-a': boardChunk },
    });
    const memory = createMemoryJournal();
    let failWrites = false;
    const journal = delegateJournal(memory.journal, async (record) => {
      if (failWrites) throw new Error('journal unavailable');
      await memory.journal.persist(record);
    });
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible(visibleBounds);
    });

    failWrites = true;
    await act(async () => {
      await result.current.removeObjects(['obj-b']);
    });
    expect(result.current.saveStatus).toBe('pending');
    await act(async () => {
      await expect(result.current.persistDraft()).rejects.toThrow('journal unavailable');
    });

    expect(result.current.saveStatus).toBe('storage-error');
    expect(result.current.chunks[0].objects.map((object) => object.id)).toEqual(['obj-a']);
    expect(result.current.dirtyChunks.map((entry) => entry.chunk_id)).toEqual(['chunk-a']);
    expect(memory.records.size).toBe(0);
    expect(harness.casRequests).toHaveLength(0);

    await act(async () => {
      try {
        await result.current.save();
      } catch {
        // A failed journal write must not be converted into a CAS attempt.
      }
    });

    expect(harness.casRequests).toHaveLength(0);
    expect(memory.records.size).toBe(0);
  });

  it('removes the last object of an unpublished chunk without sending a deleted name and restores it on undo', async () => {
    const harness = createHarness({
      manifest: makeManifest({ chunks: [] }),
      chunks: {},
    });
    const { journal, records } = createMemoryJournal();
    const { result, unmount } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.insertObjects([textObject('obj-new', 0)]);
    });
    expect(result.current.chunks).toHaveLength(1);
    const newChunkId = result.current.chunks[0].chunk_id;
    expect(result.current.dirtyChunks.map((entry) => entry.chunk_id)).toEqual([newChunkId]);

    await act(async () => {
      await result.current.removeObjects(['obj-new']);
    });
    expect(result.current.chunks).toEqual([]);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(result.current.undoDepth).toBe(2);
    expect(records.has(DOCUMENT_ID)).toBe(false);
    expect(result.current.saveStatus).toBe('saved');
    await act(async () => {
      await expect(result.current.flush()).resolves.toBeUndefined();
    });

    await act(async () => {
      await result.current.save();
    });
    expect(harness.casRequests).toHaveLength(0);

    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.chunks.map((entry) => entry.chunk_id)).toEqual([newChunkId]);
    expect(result.current.chunks[0].objects.map((object) => object.id)).toEqual(['obj-new']);
    expect(result.current.chunks[0].objects[0].z_index).toBe(0);

    await act(async () => {
      await result.current.redo();
    });
    expect(result.current.chunks).toEqual([]);

    await act(async () => {
      await result.current.save();
    });
    expect(harness.casRequests).toHaveLength(0);
    expect(records.has(DOCUMENT_ID)).toBe(false);
    expect(result.current.saveStatus).toBe('saved');
    await act(async () => {
      await expect(result.current.flush()).resolves.toBeUndefined();
    });

    await act(async () => {
      unmount();
    });
    const reopened = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(reopened.result.current.status).toBe('ready'));
    expect(reopened.result.current.chunks).toEqual([]);
    expect(reopened.result.current.dirtyChunks).toEqual([]);
  });

  it('defers stale draft cleanup after a clean undo until flush without blocking further history edits', async () => {
    const harness = createHarness({ manifest: makeManifest(), chunks: {} });
    const { journal, records } = createMemoryJournal();
    const first = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await act(async () => { await first.result.current.insertObjects([textObject('obj-new', 0)]); });
    await act(async () => { await first.result.current.persistDraft(); });
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].id).toBe('obj-new');
    const discardDraft = journal.discard.bind(journal);
    const discard = vi.spyOn(journal, 'discard');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    discard.mockImplementationOnce(async (key, sequence, owner) => {
      await gate;
      await discardDraft(key, sequence, owner);
    });

    await act(async () => { await first.result.current.undo(); });
    expect(first.result.current.chunks).toEqual([]);
    expect(first.result.current.saveStatus).toBe('pending');
    expect(discard).not.toHaveBeenCalled();

    let pending!: Promise<void>;
    act(() => { pending = first.result.current.flush(); });
    await waitFor(() => expect(discard).toHaveBeenCalledOnce());
    try {
      await act(async () => { await first.result.current.redo(); });
      expect(first.result.current.chunks[0].objects[0].id).toBe('obj-new');
      await act(async () => { await first.result.current.undo(); });
      expect(first.result.current.chunks).toEqual([]);
      expect(first.result.current.saveStatus).toBe('pending');
    } finally {
      await act(async () => { release(); await pending; });
    }
    expect(first.result.current.saveStatus).toBe('saved');
    expect(records.size).toBe(0);
    expect(harness.casRequests).toHaveLength(0);
    first.unmount();
    await act(async () => undefined);
    const reopened = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(reopened.result.current.status).toBe('ready'));
    expect(reopened.result.current.chunks).toEqual([]);
  });

  it('clears a conflict and its obsolete draft after undo removes every local delta', async () => {
    const harness = createHarness({ manifest: makeManifest(), chunks: {} });
    const { journal, records } = createMemoryJournal();
    const first = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await act(async () => { await first.result.current.insertObjects([textObject('obj-new', 0)]); });
    await emitChanged({ document_id: DOCUMENT_ID, revision: 'remote-2' });
    expect(first.result.current.saveStatus).toBe('conflict');
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].id).toBe('obj-new');
    await act(async () => { await first.result.current.undo(); });
    expect(first.result.current.chunks).toEqual([]);
    expect(first.result.current.dirtyChunks).toEqual([]);
    await act(async () => { await expect(first.result.current.flush()).resolves.toBeUndefined(); });
    expect(first.result.current.saveStatus).toBe('saved');
    expect(records.has(DOCUMENT_ID)).toBe(false);
    expect(harness.casRequests).toHaveLength(0);
    first.unmount();
    await act(async () => undefined);
    const reopened = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(reopened.result.current.status).toBe('ready'));
    expect(reopened.result.current.chunks).toEqual([]);
    expect(reopened.result.current.saveStatus).toBe('saved');
  });

  it('does not clear an empty conflict while a CAS can still publish an undone chunk', async () => {
    let resolveSave!: (manifest: InkBoardManifest) => void;
    const gate = new Promise<InkBoardManifest>((resolve) => { resolveSave = resolve; });
    const harness = createHarness({ manifest: makeManifest(), chunks: {}, saveChunks: () => gate });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.insertObjects([textObject('obj-new', 0)]); });
    const chunkId = result.current.chunks[0].chunk_id;
    let pending!: Promise<void>;
    act(() => { pending = result.current.save(); });
    await waitFor(() => expect(harness.casRequests).toHaveLength(1));
    await emitChanged({ document_id: DOCUMENT_ID, revision: 'remote-2' });
    await act(async () => { await result.current.undo(); });
    expect(result.current.chunks).toEqual([]);
    try {
      await act(async () => { await result.current.persistDraft(); });
      expect(result.current.saveStatus).toBe('conflict');
      expect(records.has(DOCUMENT_ID)).toBe(true);
    } finally {
      await act(async () => {
        resolveSave(makeManifest({ revision: 'rev-2', chunks: [chunkRef(chunkId, visibleBounds, 1)] }));
        await pending;
      });
    }
    expect(records.get(DOCUMENT_ID)?.deleted).toEqual([chunkId]);
    expect(result.current.saveStatus).not.toBe('saved');
  });

  it('does not report an empty conflict saved when writer fencing rejects its draft cleanup', async () => {
    createHarness({ manifest: makeManifest(), chunks: {} });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.insertObjects([textObject('obj-new', 0)]); });
    await emitChanged({ document_id: DOCUMENT_ID, revision: 'remote-2' });
    await act(async () => { await result.current.undo(); });
    await journal.claim({ document_id: DOCUMENT_ID }, 'new-owner');
    await act(async () => { await expect(result.current.flush()).rejects.toBeInstanceOf(DraftWriteRejectedError); });
    expect(result.current.saveStatus).toBe('conflict');
    expect(records.get(DOCUMENT_ID)?.owner).toBe('new-owner');
  });

  it('keeps a later deletion of the same chunk after a pending delete save completes', async () => {
    const objects = [
      textObject('obj-a', 0),
      textObject('obj-b', 1),
    ];
    const boardChunk = chunk('chunk-a', objects);
    let resolveSave!: (manifest: InkBoardManifest) => void;
    const saveGate = new Promise<InkBoardManifest>((resolve) => {
      resolveSave = resolve;
    });
    const harness = createHarness({
      manifest: makeManifest({
        chunks: [chunkRef('chunk-a', visibleBounds, objects.length)],
      }),
      chunks: { 'chunk-a': boardChunk },
      saveChunks: () => saveGate,
    });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible(visibleBounds);
    });

    await act(async () => {
      await result.current.removeObjects(['obj-a', 'obj-b']);
    });
    expect(result.current.chunks).toEqual([]);

    let pendingSave!: Promise<void>;
    await act(async () => {
      pendingSave = result.current.save();
    });
    await waitFor(() => expect(harness.casRequests).toHaveLength(1));
    expect(result.current.saveStatus).toBe('saving');

    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.chunks.map((entry) => entry.chunk_id)).toEqual(['chunk-a']);

    await act(async () => {
      await result.current.redo();
    });
    expect(result.current.chunks).toEqual([]);

    resolveSave(makeManifest({ revision: 'rev-2' }));
    await act(async () => {
      await pendingSave;
    });

    expect(harness.casRequests).toHaveLength(1);
    expect(result.current.saveStatus).toBe('pending');
    const draft = records.get(DOCUMENT_ID);
    expect(draft?.base_revision).toBe('rev-2');
    expect(draft?.deleted).toEqual(['chunk-a']);
  });

  it('keeps a pending deletion of a new chunk when the first CAS returns that chunk in the manifest', async () => {
    let resolveFirstSave!: (manifest: InkBoardManifest) => void;
    const firstSaveGate = new Promise<InkBoardManifest>((resolve) => {
      resolveFirstSave = resolve;
    });
    let saveCalls = 0;
    const harness = createHarness({
      manifest: makeManifest({ chunks: [] }),
      chunks: {},
      saveChunks: () => {
        saveCalls += 1;
        if (saveCalls === 1) return firstSaveGate;
        return makeManifest({ revision: 'rev-3' });
      },
    });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.insertObjects([textObject('obj-new', 0)]);
    });
    const newChunkId = result.current.chunks[0].chunk_id;

    let firstSave!: Promise<void>;
    await act(async () => {
      firstSave = result.current.save();
    });
    await waitFor(() => expect(harness.casRequests).toHaveLength(1));
    expect(result.current.saveStatus).toBe('saving');
    expect(harness.casRequests[0].changed.map((entry) => entry.chunk_id)).toEqual([newChunkId]);

    await act(async () => {
      await result.current.removeObjects(['obj-new']);
    });
    expect(result.current.chunks).toEqual([]);

    resolveFirstSave(makeManifest({
      revision: 'rev-2',
      chunks: [chunkRef(newChunkId, visibleBounds, 1)],
    }));
    await act(async () => {
      await firstSave;
    });

    expect(result.current.manifest?.chunks.map((ref) => ref.chunk_id)).toEqual([newChunkId]);
    const pendingDraft = records.get(DOCUMENT_ID);
    expect(pendingDraft?.deleted).toEqual([newChunkId]);
    expect(pendingDraft?.changed).toEqual([]);

    await act(async () => {
      await result.current.save();
    });

    expect(harness.casRequests).toHaveLength(2);
    expect(harness.casRequests[1].changed).toEqual([]);
    expect(harness.casRequests[1].deleted).toEqual([newChunkId]);
  });

  it('does not refetch or apply a chunk pending deletion when its region becomes visible', async () => {
    const objects = [textObject('obj-only', 0)];
    const boardChunk = chunk('chunk-a', objects);
    createHarness({
      manifest: makeManifest({
        chunks: [chunkRef('chunk-a', visibleBounds, objects.length)],
      }),
      chunks: { 'chunk-a': boardChunk },
    });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible(visibleBounds);
    });

    await act(async () => {
      await result.current.removeObjects(['obj-only']);
    });
    expect(result.current.chunks).toEqual([]);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(result.current.saveStatus).toBe('pending');
    expect(records.size).toBe(0);
    await act(async () => { await result.current.persistDraft(); });
    const draftBefore = records.get(DOCUMENT_ID);
    expect(draftBefore?.deleted).toEqual(['chunk-a']);

    const getChunksBefore = mocks.invoke.mock.calls
      .filter(([command]) => command === 'vfs_ink_get_chunks').length;
    await act(async () => {
      await result.current.loadVisible(visibleBounds);
    });

    expect(mocks.invoke.mock.calls
      .filter(([command]) => command === 'vfs_ink_get_chunks')).toHaveLength(getChunksBefore);
    expect(result.current.chunks).toEqual([]);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(records.get(DOCUMENT_ID)).toEqual(draftBefore);
  });

  it('keeps an unpublished chunk absent after a retryable CAS failure instead of restoring it from the draft', async () => {
    let rejectFirstSave!: (error: unknown) => void;
    const firstSaveGate = new Promise<InkBoardManifest>((_resolve, reject) => {
      rejectFirstSave = reject;
    });
    let saveCalls = 0;
    createHarness({
      manifest: makeManifest({ chunks: [] }),
      chunks: {},
      saveChunks: () => {
        saveCalls += 1;
        if (saveCalls === 1) return firstSaveGate;
        return makeManifest({ revision: 'rev-2' });
      },
    });
    const { journal, records } = createMemoryJournal();
    const { result, unmount } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.insertObjects([textObject('obj-new', 0)]);
    });
    const newChunkId = result.current.chunks[0].chunk_id;

    let pendingSave!: Promise<void>;
    await act(async () => {
      pendingSave = result.current.save();
    });
    await waitFor(() => expect(mocks.invoke.mock.calls
      .filter(([command]) => command === 'vfs_ink_save_chunks')).toHaveLength(1));

    await act(async () => {
      await result.current.removeObjects(['obj-new']);
    });
    expect(result.current.chunks).toEqual([]);

    rejectFirstSave(new InkApiError({
      code: 'TRANSIENT',
      message: 'response was lost',
      retryable: true,
    }));
    await act(async () => {
      await pendingSave;
    });

    expect(result.current.chunks).toEqual([]);
    const draft = records.get(DOCUMENT_ID);
    const hasDeleteIntent = draft?.deleted?.includes(newChunkId) ?? false;
    const explicitConflict = result.current.saveStatus === 'conflict'
      || draft?.save_state === 'conflict';
    expect(hasDeleteIntent || explicitConflict).toBe(true);

    await act(async () => {
      unmount();
    });
    const reopened = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(reopened.result.current.status).toBe('ready'));
    expect(reopened.result.current.chunks).toEqual([]);
  });
});
