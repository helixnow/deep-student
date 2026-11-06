import { StrictMode } from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { inkBoardApi } from '../api';
import {
  DraftWriteRejectedError,
  InkBoardDraftJournalStore,
  type InkBoardDraftClaim,
  type InkBoardDraftJournal,
  type InkBoardDraftRecord,
  type InkBoardDraftStorage,
} from '../boardDrafts';
import { flushInkEditor, hasDirtyInkEditor } from '../editorSession';
import { useInkBoardDocument } from '../useInkBoardDocument';
import {
  INK_BOARD_LIMITS,
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

const DOCUMENT_ID = 'ink_board1';
const PAGE_ID = 'board_page1';
const MIB = 1024 * 1024;

const refA: InkBoardChunkRef = {
  chunk_id: 'chunk-a',
  blob_hash: 'hash-chunk-a',
  byte_length: 1024,
  object_count: 1,
  sample_count: 2,
  bounds: { x: 0, y: 0, width: 100, height: 100 },
};

const chunkRef = (
  chunk_id: string,
  bounds: InkBoardBounds,
  byte_length = 1024,
): InkBoardChunkRef => ({
  chunk_id,
  blob_hash: `hash-${chunk_id}`,
  byte_length,
  object_count: 1,
  sample_count: 2,
  bounds,
});

const strokeObject: InkBoardObject = {
  id: 'obj-stroke',
  author: 'user',
  created_at: 1,
  z_index: 0,
  content: {
    kind: 'stroke',
    samples: [
      { x: -5, y: 10, pressure: 0.5, elapsed_ms: 0 },
      { x: -1, y: 12, pressure: 0.6, elapsed_ms: 4 },
    ],
    style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: true },
  },
};

const chunkA: InkBoardChunk = {
  schema_version: 2,
  chunk_id: 'chunk-a',
  objects: [strokeObject],
};

const textObject = (id: string, index: number): InkBoardObject => ({
  id,
  author: 'user',
  created_at: 1,
  z_index: index,
  content: {
    kind: 'text',
    rect: { x: index, y: 0, width: 10, height: 10 },
    text: 'x',
    font_size: 12,
    color: '#000000',
  },
});

let fixtureZIndex = 1000;

const chunkWithObject = (chunkId: string): InkBoardChunk => ({
  schema_version: 2,
  chunk_id: chunkId,
  objects: [{ ...strokeObject, id: `obj-${chunkId}`, z_index: fixtureZIndex++ }],
});

function makeManifest(overrides: Partial<InkBoardManifest> = {}): InkBoardManifest {
  return {
    schema_version: 2,
    document_id: DOCUMENT_ID,
    revision: 'rev-1',
    title: 'Board',
    source: { kind: 'blank' },
    pages: [],
    surface: {
      kind: 'board',
      page_id: PAGE_ID,
      ruling: 'grid',
      bounds: { x: -1000, y: -1000, width: 2000, height: 2000 },
    },
    chunks: [refA],
    ...overrides,
  };
}

function createHarness(initial: {
  manifest: InkBoardManifest;
  chunks: Record<string, InkBoardChunk>;
  order?: string[];
  saveChunks?: (request: Record<string, unknown>) => InkBoardManifest;
}) {
  const state = {
    manifest: initial.manifest,
    chunks: { ...initial.chunks },
  };
  const order = initial.order ?? [];

  mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
    if (command === 'vfs_ink_get') return state.manifest;
    if (command === 'vfs_ink_get_chunks') {
      return payload.request.chunk_ids
        .map((chunkId: string) => state.chunks[chunkId])
        .filter((chunk: InkBoardChunk | undefined): chunk is InkBoardChunk => Boolean(chunk))
        .map((chunk: InkBoardChunk) => structuredClone(chunk));
    }
    if (command === 'vfs_ink_save_chunks') {
      order.push('cas');
      const saved = initial.saveChunks?.(payload.request as Record<string, unknown>) ?? {
        ...state.manifest,
        revision: 'rev-2',
      };
      state.manifest = saved;
      return structuredClone(saved);
    }
    throw new Error(`Unexpected command: ${command}`);
  });

  return { state, order };
}

function createMemoryJournal(order: string[] = []) {
  const records = new Map<string, InkBoardDraftRecord>();
  const owners = new Map<string, string>();
  const floors = new Map<string, number>();

  const currentSequence = (documentId: string): number =>
    records.get(documentId)?.sequence ?? floors.get(documentId) ?? 0;

  // Every decision below is synchronous within one async call, matching the
  // single-transaction semantics of the real storage adapter (not real IDB
  // atomicity; that remains a separate CT gate).
  const storage: InkBoardDraftStorage = {
    async read(key) {
      return records.get(key.document_id);
    },
    async readSequenceFloor(key) {
      return currentSequence(key.document_id);
    },
    async claim(key, owner) {
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
      order.push('draft');
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function emitChanged(payload: Record<string, unknown>) {
  await act(async () => {
    await mocks.listener?.({ payload });
  });
}

function claimedDraft(
  sequence: number,
  owner: string,
  revision = 'rev-1',
): InkBoardDraftRecord {
  return {
    document_id: DOCUMENT_ID,
    page_id: PAGE_ID,
    owner,
    base_revision: revision,
    sequence,
    changed: [chunkA],
    deleted: [],
    updated_at: 1,
  };
}

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listener = undefined;
  fixtureZIndex = 1000;
});

describe('inkBoardApi native contract', () => {
  it('sends the agreed request envelopes for create, get_chunks, and save_chunks', async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'vfs_ink_create_board') return makeManifest();
      if (command === 'vfs_ink_get_chunks') return [chunkA];
      if (command === 'vfs_ink_save_chunks') return makeManifest({ revision: 'rev-2' });
      throw new Error(`Unexpected command: ${command}`);
    });

    await inkBoardApi.create({
      title: 'Board',
      ruling: 'grid',
      operation_id: 'op-create',
      folder_id: 'folder-1',
    });
    await inkBoardApi.getChunks({
      document_id: DOCUMENT_ID,
      expected_revision: 'rev-1',
      chunk_ids: ['chunk-a'],
    });
    await inkBoardApi.saveChunks({
      document_id: DOCUMENT_ID,
      expected_revision: 'rev-1',
      operation_id: 'op-save',
      changed: [chunkA],
      deleted: ['chunk-old'],
    });

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'vfs_ink_create_board', {
      request: {
        title: 'Board',
        ruling: 'grid',
        operation_id: 'op-create',
        folder_id: 'folder-1',
      },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, 'vfs_ink_get_chunks', {
      request: {
        document_id: DOCUMENT_ID,
        expected_revision: 'rev-1',
        chunk_ids: ['chunk-a'],
      },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, 'vfs_ink_save_chunks', {
      request: {
        document_id: DOCUMENT_ID,
        expected_revision: 'rev-1',
        operation_id: 'op-save',
        changed: [chunkA],
        deleted: ['chunk-old'],
      },
    });
  });
});

describe('InkBoardDraftClaim memory contract', () => {
  const key = { document_id: DOCUMENT_ID };

  it('promotes a new owner atomically while preserving draft and floor', async () => {
    const { journal } = createMemoryJournal();

    const first: InkBoardDraftClaim = await journal.claim(key, 'owner-a');
    expect(first.owner).toBe('owner-a');
    expect(first.sequence_floor).toBe(0);
    expect(first.draft).toBeUndefined();

    await journal.persist(claimedDraft(1, 'owner-a'));

    const second = await journal.claim(key, 'owner-b');
    expect(second.owner).toBe('owner-b');
    expect(second.sequence_floor).toBe(1);
    expect(second.draft?.sequence).toBe(1);
    expect(second.draft?.owner).toBe('owner-b');

    await expect(journal.persist(claimedDraft(2, 'owner-a')))
      .rejects.toBeInstanceOf(DraftWriteRejectedError);
    await journal.persist(claimedDraft(2, 'owner-b'));

    const third = await journal.claim(key, 'owner-c');
    expect(third.draft?.sequence).toBe(2);
  });

  it('advances the floor tombstone and rejects sequences restarting from zero', async () => {
    const { journal } = createMemoryJournal();
    await journal.claim(key, 'owner-a');
    await journal.persist(claimedDraft(3, 'owner-a'));

    await journal.discard(key, 3, 'owner-a');
    const claim = await journal.claim(key, 'owner-b');
    expect(claim.sequence_floor).toBe(3);
    expect(claim.draft).toBeUndefined();

    await expect(journal.persist(claimedDraft(1, 'owner-b')))
      .rejects.toBeInstanceOf(DraftWriteRejectedError);
    await expect(journal.persist(claimedDraft(3, 'owner-b')))
      .rejects.toBeInstanceOf(DraftWriteRejectedError);
    await journal.persist(claimedDraft(4, 'owner-b'));

    const after = await journal.claim(key, 'owner-c');
    expect(after.sequence_floor).toBe(4);
    expect(after.draft?.sequence).toBe(4);
  });

  it('rejects a fenced old session discard and only the current owner removes the draft', async () => {
    const { journal } = createMemoryJournal();
    await journal.claim(key, 'owner-a');
    await journal.persist(claimedDraft(2, 'owner-a'));

    await journal.claim(key, 'owner-b');
    await expect(journal.discard(key, 2, 'owner-a'))
      .rejects.toBeInstanceOf(DraftWriteRejectedError);
    expect((await journal.read(key))?.sequence).toBe(2);

    await journal.discard(key, 2, 'owner-b');
    expect(await journal.read(key)).toBeUndefined();

    const claim = await journal.claim(key, 'owner-c');
    expect(claim.sequence_floor).toBe(2);
    expect(claim.draft).toBeUndefined();
  });
});

describe('useInkBoardDocument', () => {
  it('loads only visible chunks and batches each request under the 16 MiB budget', async () => {
    const visibleA = chunkRef('chunk-a', { x: 0, y: 0, width: 100, height: 100 }, 1024);
    const offscreen = chunkRef('chunk-b', { x: 5000, y: 5000, width: 100, height: 100 });
    const mediumC = chunkRef('chunk-c', { x: 150, y: 0, width: 100, height: 100 }, 6 * MIB);
    const mediumD = chunkRef('chunk-d', { x: 260, y: 0, width: 100, height: 100 }, 6 * MIB);
    const mediumE = chunkRef('chunk-e', { x: 370, y: 0, width: 100, height: 100 }, 6 * MIB);
    const manifest = makeManifest({ chunks: [visibleA, offscreen, mediumC, mediumD, mediumE] });
    const chunks = {
      'chunk-a': { ...chunkA, chunk_id: 'chunk-a' },
      'chunk-b': { ...chunkA, chunk_id: 'chunk-b' },
      'chunk-c': { ...chunkA, chunk_id: 'chunk-c' },
      'chunk-d': { ...chunkA, chunk_id: 'chunk-d' },
      'chunk-e': { ...chunkA, chunk_id: 'chunk-e' },
    };
    createHarness({ manifest, chunks });
    const { journal } = createMemoryJournal();

    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 400, height: 100 });
    });

    const requests = mocks.invoke.mock.calls
      .filter(([command]) => command === 'vfs_ink_get_chunks')
      .map(([, payload]) => payload.request as { chunk_ids: string[]; expected_revision?: string });
    expect(requests.length).toBeGreaterThan(0);
    const requested = requests.flatMap((request) => request.chunk_ids);
    expect(requested).not.toContain('chunk-b');
    expect(new Set(requested)).toEqual(new Set(['chunk-a', 'chunk-c', 'chunk-d', 'chunk-e']));
    expect(result.current.chunks.map((chunk) => chunk.chunk_id).sort()).toEqual([
      'chunk-a',
      'chunk-c',
      'chunk-d',
      'chunk-e',
    ]);

    const byteLength = new Map(manifest.chunks.map((ref) => [ref.chunk_id, ref.byte_length]));
    for (const request of requests) {
      const total = request.chunk_ids.reduce((sum, chunkId) => sum + (byteLength.get(chunkId) ?? 0), 0);
      expect(total).toBeLessThanOrEqual(16 * MIB);
      expect(request.expected_revision).toBe('rev-1');
    }
  });

  it('fails a visible load without partially applying when a chunk is missing', async () => {
    const manifest = makeManifest({
      chunks: [
        chunkRef('chunk-a', { x: 0, y: 0, width: 100, height: 100 }),
        chunkRef('chunk-c', { x: 150, y: 0, width: 100, height: 100 }),
      ],
    });
    createHarness({ manifest, chunks: { 'chunk-a': chunkA } });
    const { journal } = createMemoryJournal();

    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let captured: unknown;
    await act(async () => {
      try {
        await result.current.loadVisible({ x: 0, y: 0, width: 400, height: 100 });
      } catch (error) {
        captured = error;
      }
    });

    expect(captured).toBeInstanceOf(Error);
    expect(String(captured)).toMatch(/missing/i);
    expect(result.current.error).toBeTruthy();
    expect(result.current.chunks).toEqual([]);
  });

  it('keeps an edited stroke as one intact object chunk and journals the draft before the CAS', async () => {
    const order: string[] = [];
    const { journal, records } = createMemoryJournal(order);
    let journalAtCas: InkBoardDraftRecord | undefined;
    createHarness({
      manifest: makeManifest(),
      chunks: { 'chunk-a': chunkA },
      order,
      saveChunks: () => {
        journalAtCas = records.get(DOCUMENT_ID);
        return makeManifest({ revision: 'rev-2' });
      },
    });
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });

    const grown: InkBoardObject = {
      ...strokeObject,
      content: {
        kind: 'stroke',
        samples: [
          ...(strokeObject.content.kind === 'stroke' ? strokeObject.content.samples : []),
          { x: 4, y: 18, pressure: 0.7, elapsed_ms: 8 },
          { x: 9, y: 24, pressure: 0.8, elapsed_ms: 12 },
        ],
        style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: true },
      },
    };
    await act(async () => {
      await result.current.upsertObjects([grown]);
    });

    expect(result.current.dirtyChunks).toContainEqual({
      chunk_id: 'chunk-a',
      base_blob_hash: 'hash-chunk-a',
    });

    await act(async () => {
      await result.current.save();
    });

    const saveCall = mocks.invoke.mock.calls.find(([command]) => command === 'vfs_ink_save_chunks');
    expect(saveCall).toBeTruthy();
    const request = saveCall?.[1].request as {
      changed: InkBoardChunk[];
      deleted: string[];
      expected_revision: string;
      operation_id: string;
    };
    expect(request.deleted).toEqual([]);
    expect(request.expected_revision).toBe('rev-1');
    expect(request.changed).toHaveLength(1);
    expect(request.changed[0].chunk_id).toBe('chunk-a');
    expect(request.changed[0].objects).toHaveLength(1);
    const savedStroke = request.changed[0].objects[0].content;
    expect(savedStroke.kind).toBe('stroke');
    expect(savedStroke.kind === 'stroke' ? savedStroke.samples : []).toHaveLength(4);
    expect(order.indexOf('draft')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('draft')).toBeLessThan(order.indexOf('cas'));
    expect(journalAtCas?.changed[0].chunk_id).toBe('chunk-a');
    expect(records.has(DOCUMENT_ID)).toBe(false);
  });

  it('ignores its own save echo and does not reload or bump the revision epoch', async () => {
    createHarness({ manifest: makeManifest(), chunks: { 'chunk-a': chunkA } });
    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(mocks.listener).toBeTruthy();
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });

    await act(async () => {
      await result.current.upsertObjects([strokeObject]);
    });
    await act(async () => {
      await result.current.save();
    });
    const savedOperationId = (mocks.invoke.mock.calls.find(([command]) => command === 'vfs_ink_save_chunks')?.[1]
      .request as { operation_id: string }).operation_id;
    const getCountBefore = mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_get').length;
    const epochBefore = result.current.revisionEpoch;

    await emitChanged({
      document_id: DOCUMENT_ID,
      revision: 'rev-2',
      operation_id: savedOperationId,
      affected_page_ids: [PAGE_ID],
    });

    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_get')).toHaveLength(getCountBefore);
    expect(result.current.saveStatus).toBe('saved');
    expect(result.current.revisionEpoch).toBe(epochBefore);
  });

  it('applies a clean external revision with a new epoch and clears cached history', async () => {
    const harness = createHarness({ manifest: makeManifest(), chunks: { 'chunk-a': chunkA } });
    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([strokeObject]);
      await result.current.save();
    });
    expect(result.current.undoDepth).toBeGreaterThan(0);

    harness.state.manifest = makeManifest({ revision: 'rev-remote' });
    await emitChanged({
      document_id: DOCUMENT_ID,
      revision: 'rev-remote',
      operation_id: 'other-client',
      affected_page_ids: [PAGE_ID],
    });
    await waitFor(() => expect(result.current.manifest?.revision).toBe('rev-remote'));

    expect(result.current.revisionEpoch).toBe(1);
    expect(result.current.undoDepth).toBe(0);
    expect(result.current.saveStatus).toBe('saved');
  });

  it('keeps the local draft and notifies the caller when a remote revision conflicts', async () => {
    createHarness({ manifest: makeManifest(), chunks: { 'chunk-a': chunkA } });
    const { journal, records } = createMemoryJournal();
    const onConflict = vi.fn();
    const { result } = renderHook(() =>
      useInkBoardDocument(DOCUMENT_ID, { journal, onConflict }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    const local: InkBoardObject = { ...strokeObject, z_index: 9 };
    await act(async () => {
      await result.current.upsertObjects([local]);
    });

    await emitChanged({
      document_id: DOCUMENT_ID,
      revision: 'rev-remote',
      operation_id: 'other-client',
      affected_page_ids: [PAGE_ID],
    });
    await waitFor(() => expect(result.current.saveStatus).toBe('conflict'));

    expect(onConflict).toHaveBeenCalledWith(expect.objectContaining({
      document_id: DOCUMENT_ID,
      remote_revision: 'rev-remote',
    }));
    const draft = records.get(DOCUMENT_ID);
    expect(draft?.save_state).toBe('conflict');
    expect(draft?.changed[0].objects[0].z_index).toBe(9);
    expect(result.current.manifest?.revision).toBe('rev-1');
    expect(result.current.chunks[0].objects[0].z_index).toBe(9);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'vfs_ink_save_chunks')).toBe(false);
  });

  it('persists the board draft on pagehide with the surface page id and registers the session', async () => {
    createHarness({ manifest: makeManifest(), chunks: { 'chunk-a': chunkA } });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([strokeObject]);
    });

    expect(hasDirtyInkEditor(DOCUMENT_ID)).toBe(true);

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(records.has(DOCUMENT_ID)).toBe(true));

    const draft = records.get(DOCUMENT_ID);
    expect(draft?.page_id).toBe(PAGE_ID);
    expect(draft?.changed[0].chunk_id).toBe('chunk-a');
    expect(draft?.deleted).toEqual([]);

    expect(await act(async () => flushInkEditor(DOCUMENT_ID))).toEqual({ ok: true });
    await waitFor(() => expect(records.has(DOCUMENT_ID)).toBe(false));
  });

  it('resumes draft persistence after a transient journal failure on a later gesture', async () => {
    createHarness({ manifest: makeManifest(), chunks: { 'chunk-a': chunkA } });
    const memory = createMemoryJournal();
    let failNext = true;
    const journal: InkBoardDraftJournal = {
      read: (key) => memory.journal.read(key),
      claim: (key, owner) => memory.journal.claim(key, owner),
      persist: async (record) => {
        if (failNext) {
          failNext = false;
          throw new Error('Journal temporarily unavailable.');
        }
        await memory.journal.persist(record);
      },
      discard: (key, throughSequence, owner) => (
        memory.journal.discard(key, throughSequence, owner)
      ),
      readSequenceFloor: (key) => memory.journal.readSequenceFloor(key),
    };
    const first = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await act(async () => {
      await first.result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });

    await act(async () => {
      await first.result.current.upsertObjects([{ ...strokeObject, z_index: 2 }]);
    });
    expect(first.result.current.saveStatus).toBe('storage-error');
    expect(memory.records.has(DOCUMENT_ID)).toBe(false);

    await act(async () => {
      await first.result.current.upsertObjects([{ ...strokeObject, z_index: 3 }]);
    });
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() =>
      expect(memory.records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(3));
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'vfs_ink_save_chunks'))
      .toBe(false);

    first.unmount();
    await act(async () => undefined);
    const second = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    expect(second.result.current.saveStatus).toBe('offline');
    expect(second.result.current.chunks[0].objects[0].z_index).toBe(3);
  });

  it('flushes a dirty board through CAS and reports a failed CAS flush', async () => {
    createHarness({ manifest: makeManifest(), chunks: { 'chunk-a': chunkA } });
    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([strokeObject]);
    });

    expect(hasDirtyInkEditor(DOCUMENT_ID)).toBe(true);
    const firstFlush = await act(async () => flushInkEditor(DOCUMENT_ID));
    expect(firstFlush).toEqual({ ok: true });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_save_chunks')).toHaveLength(1);
    expect(result.current.saveStatus).toBe('saved');

    const baseImplementation = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_save_chunks') throw new Error('CAS unavailable');
      if (!baseImplementation) throw new Error('Missing harness implementation.');
      return baseImplementation(command, payload);
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 3 }]);
    });

    const failedFlush = await act(async () => flushInkEditor(DOCUMENT_ID));
    expect(failedFlush).toEqual({ ok: false, code: 'EDITOR_BUSY' });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_save_chunks')).toHaveLength(2);
  });

  it('awaits host input before the registered session journals and flushes its final gesture', async () => {
    const order: string[] = [];
    createHarness({ manifest: makeManifest({ chunks: [] }), chunks: {}, order });
    const { journal } = createMemoryJournal(order);
    const gate = createDeferred<void>();
    const beforeFlush = vi.fn(async () => {
      order.push('finish-input');
      await gate.promise;
      await result.current.insertObjects([strokeObject]);
      order.push('input-queued');
    });
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal, beforeFlush }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let pending!: ReturnType<typeof flushInkEditor>;
    act(() => { pending = flushInkEditor(DOCUMENT_ID); });
    await act(async () => undefined);
    expect(beforeFlush).toHaveBeenCalledOnce();
    expect(beforeFlush).toHaveBeenCalledWith({ documentId: DOCUMENT_ID, pageId: PAGE_ID, revisionEpoch: 0 });
    expect(order).toEqual(['finish-input']);

    await act(async () => {
      gate.resolve();
      expect(await pending).toEqual({ ok: true });
    });
    expect(order.indexOf('input-queued')).toBeLessThan(order.indexOf('cas'));
    expect(order.indexOf('draft')).toBeLessThan(order.indexOf('cas'));
    expect(result.current.saveStatus).toBe('saved');
    const saves = mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_save_chunks');
    expect(saves).toHaveLength(1);
    expect(saves[0][1].request.changed[0].objects).toEqual([strokeObject]);
  });

  it('uses the latest host callback without registering a second dirty session', async () => {
    createHarness({ manifest: makeManifest({ chunks: [] }), chunks: {} });
    const { journal } = createMemoryJournal();
    const first = vi.fn(async () => undefined);
    const latest = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ beforeFlush }) => useInkBoardDocument(DOCUMENT_ID, { journal, beforeFlush }),
      { initialProps: { beforeFlush: first } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.insertObjects([strokeObject]); });
    rerender({ beforeFlush: latest });

    expect(hasDirtyInkEditor(DOCUMENT_ID)).toBe(true);
    expect(await act(async () => flushInkEditor(DOCUMENT_ID))).toEqual({ ok: true });
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_save_chunks')).toHaveLength(1);
  });

  it('does not canonical-flush when finishing host input fails', async () => {
    createHarness({ manifest: makeManifest({ chunks: [] }), chunks: {} });
    const { journal } = createMemoryJournal();
    const beforeFlush = vi.fn(async () => { throw new Error('Input commit failed.'); });
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal, beforeFlush }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.insertObjects([strokeObject]); });

    expect(await act(async () => flushInkEditor(DOCUMENT_ID))).toEqual({ ok: false, code: 'EDITOR_BUSY' });
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'vfs_ink_save_chunks')).toBe(false);
  });

  it('rejects a host flush if a clean remote epoch changes while input is finishing', async () => {
    const { state } = createHarness({ manifest: makeManifest({ chunks: [] }), chunks: {} });
    const { journal } = createMemoryJournal();
    const gate = createDeferred<void>();
    const beforeFlush = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal, beforeFlush }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let pending!: ReturnType<typeof flushInkEditor>;
    act(() => { pending = flushInkEditor(DOCUMENT_ID); });
    expect(beforeFlush).toHaveBeenCalledOnce();

    state.manifest = makeManifest({ revision: 'rev-remote', chunks: [] });
    await emitChanged({ document_id: DOCUMENT_ID, revision: 'rev-remote' });
    expect(result.current.revisionEpoch).toBe(1);
    await act(async () => {
      gate.resolve();
      expect(await pending).toEqual({ ok: false, code: 'EDITOR_BUSY' });
    });
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'vfs_ink_save_chunks')).toBe(false);
  });

  it('does not save a later remote epoch after waiting for an older session CAS queue', async () => {
    const { state } = createHarness({ manifest: makeManifest({ chunks: [] }), chunks: {} });
    const implementation = mocks.invoke.getMockImplementation()!;
    const gate = createDeferred<void>();
    const requests: Record<string, any>[] = [];
    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_save_chunks') {
        requests.push(payload.request);
        if (requests.length === 1) await gate.promise;
        return makeManifest({ revision: `saved-${requests.length}`, chunks: [] });
      }
      return implementation(command, payload);
    });
    const { journal } = createMemoryJournal();
    const first = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await act(async () => { await first.result.current.insertObjects([strokeObject]); });
    let olderSave!: Promise<void>;
    act(() => { olderSave = first.result.current.save(); });
    await waitFor(() => expect(requests).toHaveLength(1));
    first.unmount();
    await act(async () => undefined);

    const beforeFlush = vi.fn(async () => undefined);
    const second = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal, beforeFlush }));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    let pending!: ReturnType<typeof flushInkEditor>;
    act(() => { pending = flushInkEditor(DOCUMENT_ID); });
    await act(async () => undefined);
    expect(beforeFlush).toHaveBeenCalledOnce();
    state.manifest = makeManifest({ revision: 'remote-2', chunks: [] });
    await act(async () => { await second.result.current.reloadRemote(); });
    expect(second.result.current.revisionEpoch).toBe(1);
    await act(async () => {
      await second.result.current.insertObjects([{ ...strokeObject, id: 'later-epoch', z_index: 9 }]);
    });
    await act(async () => {
      gate.resolve();
      await olderSave;
      expect(await pending).toEqual({ ok: false, code: 'EDITOR_BUSY' });
    });
    expect(requests).toHaveLength(1);
    expect(hasDirtyInkEditor(DOCUMENT_ID)).toBe(true);
  });

  it('never retargets a waiting host flush to the next document session', async () => {
    createHarness({ manifest: makeManifest({ chunks: [] }), chunks: {} });
    const implementation = mocks.invoke.getMockImplementation()!;
    const nextDocumentId = 'ink_board2';
    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get' && payload.request.document_id === nextDocumentId) {
        return makeManifest({ document_id: nextDocumentId, chunks: [] });
      }
      return implementation(command, payload);
    });
    const { journal } = createMemoryJournal();
    const gate = createDeferred<void>();
    const first = vi.fn(() => gate.promise);
    const next = vi.fn(async () => undefined);
    const { result, rerender } = renderHook(
      ({ documentId, beforeFlush }) => useInkBoardDocument(documentId, { journal, beforeFlush }),
      { initialProps: { documentId: DOCUMENT_ID, beforeFlush: first } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    let pending!: ReturnType<typeof flushInkEditor>;
    act(() => { pending = flushInkEditor(DOCUMENT_ID); });
    expect(first).toHaveBeenCalledOnce();
    rerender({ documentId: nextDocumentId, beforeFlush: next });
    await waitFor(() => expect(result.current.manifest?.document_id).toBe(nextDocumentId));
    await act(async () => { await result.current.insertObjects([strokeObject]); });

    await act(async () => {
      gate.resolve();
      expect(await pending).toEqual({ ok: false, code: 'EDITOR_BUSY' });
    });
    expect(next).not.toHaveBeenCalled();
    expect(hasDirtyInkEditor(nextDocumentId)).toBe(true);
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'vfs_ink_save_chunks')).toBe(false);
  });

  it('packs a new-object batch into chunks and rejects an over-capacity gesture atomically', async () => {
    createHarness({ manifest: makeManifest({ chunks: [] }), chunks: {} });
    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const textBatch = Array.from({ length: 300 }, (_, index) => textObject(`obj-text-${index}`, index));
    await act(async () => {
      await result.current.upsertObjects(textBatch);
    });

    expect(result.current.chunks).toHaveLength(1);
    expect(result.current.chunks[0].objects).toHaveLength(300);
    expect(result.current.chunks.length).toBeLessThanOrEqual(INK_BOARD_LIMITS.chunks_max);

    const chunkIdsBefore = result.current.chunks.map((chunk) => chunk.chunk_id).sort();
    const dirtyBefore = result.current.dirtyChunks.map((chunk) => chunk.chunk_id).sort();
    const undoBefore = result.current.undoDepth;
    const sample = { x: 0, y: 0, pressure: 0.5 };
    const oversizedStroke: InkBoardObject = {
      id: 'obj-too-many-samples',
      author: 'user',
      created_at: 1,
      z_index: 400,
      content: {
        kind: 'stroke',
        samples: new Array(INK_BOARD_LIMITS.chunk_samples_max + 1).fill(sample),
        style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: true },
      },
    };

    let capacityError: unknown;
    await act(async () => {
      try {
        await result.current.upsertObjects([oversizedStroke]);
      } catch (error) {
        capacityError = error;
      }
    });

    expect(capacityError).toBeInstanceOf(Error);
    expect(String(capacityError)).toMatch(/capacity|limit|sample|chunk|budget/i);
    expect(result.current.chunks.map((chunk) => chunk.chunk_id).sort()).toEqual(chunkIdsBefore);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id).sort()).toEqual(dirtyBefore);
    expect(result.current.undoDepth).toBe(undoBefore);
  });

  it('keeps 18 MiB visible while evicting clean offscreen cache and retaining dirty chunks', async () => {
    const v1Refs = [
      chunkRef('v1-a', { x: 0, y: 0, width: 100, height: 100 }, 6 * MIB),
      chunkRef('v1-b', { x: 150, y: 0, width: 100, height: 100 }, 6 * MIB),
      chunkRef('v1-c', { x: 300, y: 0, width: 100, height: 100 }, 6 * MIB),
    ];
    const v2Refs = [
      chunkRef('v2-a', { x: 0, y: 1000, width: 100, height: 100 }, 6 * MIB),
      chunkRef('v2-b', { x: 150, y: 1000, width: 100, height: 100 }, 6 * MIB),
      chunkRef('v2-c', { x: 300, y: 1000, width: 100, height: 100 }, 6 * MIB),
    ];
    const v3Refs = [
      chunkRef('v3-a', { x: 0, y: 2000, width: 100, height: 100 }, 6 * MIB),
      chunkRef('v3-b', { x: 150, y: 2000, width: 100, height: 100 }, 6 * MIB),
      chunkRef('v3-c', { x: 300, y: 2000, width: 100, height: 100 }, 6 * MIB),
    ];
    const allRefs = [...v1Refs, ...v2Refs, ...v3Refs];
    const manifest = makeManifest({ chunks: allRefs });
    const chunks = Object.fromEntries(allRefs.map((ref) => [ref.chunk_id, chunkWithObject(ref.chunk_id)]));
    createHarness({ manifest, chunks });
    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const bytesFor = (chunkId: string): number =>
      manifest.chunks.find((ref) => ref.chunk_id === chunkId)?.byte_length ?? 0;
    const totalBytes = (loaded: InkBoardChunk[]): number =>
      loaded.reduce((sum, chunk) => sum + bytesFor(chunk.chunk_id), 0);

    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 450, height: 100 });
    });
    expect(result.current.error).toBeUndefined();
    expect(result.current.chunks).toHaveLength(3);
    expect(totalBytes(result.current.chunks)).toBe(18 * MIB);

    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, id: 'obj-v1-a', z_index: 2 }]);
    });
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('v1-a');

    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 1000, width: 450, height: 100 });
    });

    const cachedIds = result.current.chunks.map((chunk) => chunk.chunk_id);
    expect(cachedIds).toContain('v1-a');
    expect(cachedIds).not.toContain('v1-b');
    expect(cachedIds).not.toContain('v1-c');
    expect(cachedIds).toEqual(expect.arrayContaining(['v2-a', 'v2-b', 'v2-c']));
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('v1-a');
    expect(totalBytes(result.current.chunks)).toBeLessThanOrEqual(32 * MIB);
    expect(result.current.error).toBeUndefined();

    await act(async () => {
      await result.current.upsertObjects([
        { ...strokeObject, id: 'obj-v2-a', z_index: 3 },
        { ...strokeObject, id: 'obj-v2-b', z_index: 4 },
      ]);
    });

    await act(async () => {
      try {
        await result.current.loadVisible({ x: 0, y: 2000, width: 450, height: 100 });
      } catch {
        // Rejecting the over-budget viewport is acceptable; the public error
        // below is the required signal either way.
      }
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id).sort()).toEqual(
      expect.arrayContaining(['v1-a', 'v2-a', 'v2-b']),
    );
    expect(totalBytes(result.current.chunks)).toBeLessThanOrEqual(32 * MIB);
  });

  it('rejects an unloaded existing object instead of hydrating every chunk or duplicating its id', async () => {
    const refs = Array.from({ length: 6 }, (_, index) => chunkRef(
      `v1-${index}`,
      { x: index * 150, y: 0, width: 100, height: 100 },
      6 * MIB,
    ));
    const manifest = makeManifest({ chunks: refs });
    const chunks = Object.fromEntries(refs.map((ref) => [ref.chunk_id, chunkWithObject(ref.chunk_id)]));
    createHarness({ manifest, chunks });
    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const getChunksBefore = mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_get_chunks').length;

    let unloadedError: unknown;
    await act(async () => {
      try {
        await result.current.upsertObjects([{ ...strokeObject, id: 'obj-v1-0', z_index: 4 }]);
      } catch (error) {
        unloadedError = error;
      }
    });

    expect(unloadedError).toBeInstanceOf(Error);
    expect(String(unloadedError)).toMatch(/unloaded|unknown|locate|resolve|ownership/i);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_get_chunks')).toHaveLength(getChunksBefore);
    expect(result.current.chunks).toEqual([]);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(result.current.undoDepth).toBe(0);
  });

  it('keeps camera state local without saving or advancing the canonical revision', async () => {
    createHarness({ manifest: makeManifest(), chunks: { 'chunk-a': chunkA } });
    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const invokeCount = mocks.invoke.mock.calls.length;
    const revision = result.current.manifest?.revision;

    act(() => {
      result.current.setCamera({ x: 42, y: -7, scale: 2 });
    });

    expect(result.current.camera).toEqual({ x: 42, y: -7, scale: 2 });
    expect(result.current.manifest?.revision).toBe(revision);
    expect(result.current.saveStatus).toBe('saved');
    expect(result.current.revisionEpoch).toBe(0);
    expect(mocks.invoke.mock.calls).toHaveLength(invokeCount);
    expect(records.size).toBe(0);
  });

  it('does not save a new document chunk under a queued save from the previous document', async () => {
    const documentA = 'ink_board_a';
    const documentB = 'ink_board_b';
    const manifestA = makeManifest({ document_id: documentA });
    const manifestB = makeManifest({
      document_id: documentB,
      chunks: [chunkRef('chunk-b', { x: 0, y: 0, width: 100, height: 100 })],
    });
    const manifests = new Map<string, InkBoardManifest>([
      [documentA, manifestA],
      [documentB, manifestB],
    ]);
    const chunksByDocument = new Map<string, Record<string, InkBoardChunk>>([
      [documentA, { 'chunk-a': chunkA }],
      [documentB, { 'chunk-b': chunkWithObject('chunk-b') }],
    ]);
    const saveRequests: Array<{
      document_id: string;
      expected_revision: string;
      changed: InkBoardChunk[];
      deleted: string[];
    }> = [];
    const firstSaveGate = createDeferred<void>();
    let saveCount = 0;

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') {
        const manifest = manifests.get(payload.request.document_id);
        if (!manifest) throw new Error(`Unknown document: ${payload.request.document_id}`);
        return structuredClone(manifest);
      }
      if (command === 'vfs_ink_get_chunks') {
        const chunks = chunksByDocument.get(payload.request.document_id) ?? {};
        return payload.request.chunk_ids
          .map((chunkId: string) => chunks[chunkId])
          .filter((chunk: InkBoardChunk | undefined): chunk is InkBoardChunk => Boolean(chunk))
          .map((chunk: InkBoardChunk) => structuredClone(chunk));
      }
      if (command === 'vfs_ink_save_chunks') {
        const request = payload.request as {
          document_id: string;
          expected_revision: string;
          changed: InkBoardChunk[];
          deleted: string[];
        };
        saveRequests.push(structuredClone(request));
        saveCount += 1;
        if (saveCount === 1) await firstSaveGate.promise;
        const saved = makeManifest({
          document_id: request.document_id,
          revision: `rev-saved-${saveCount}`,
        });
        manifests.set(request.document_id, saved);
        return structuredClone(saved);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal } = createMemoryJournal();
    const { result, rerender } = renderHook(
      ({ documentId }: { documentId: string }) => useInkBoardDocument(documentId, { journal }),
      { initialProps: { documentId: documentA } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 2 }]);
    });

    let firstSave!: Promise<void>;
    act(() => {
      firstSave = result.current.save();
    });
    await waitFor(() => expect(saveRequests).toHaveLength(1));
    expect(saveRequests[0].document_id).toBe(documentA);
    expect(saveRequests[0].changed.map((chunk) => chunk.chunk_id)).toEqual(['chunk-a']);

    let queuedSaveFromA!: Promise<void>;
    act(() => {
      queuedSaveFromA = result.current.save();
    });

    rerender({ documentId: documentB });
    await waitFor(() => expect(result.current.manifest?.document_id).toBe(documentB));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    const objectB = chunkWithObject('chunk-b').objects[0];
    await act(async () => {
      await result.current.upsertObjects([{ ...objectB, z_index: 7 }]);
    });
    const undoDepthInB = result.current.undoDepth;

    await act(async () => {
      firstSaveGate.resolve();
      await firstSave;
      await queuedSaveFromA;
    });

    for (const request of saveRequests.filter((entry) => entry.document_id === documentA)) {
      for (const chunk of request.changed) expect(chunk.chunk_id).toBe('chunk-a');
    }
    expect(saveRequests.some((request) =>
      request.changed.some((chunk) => chunk.chunk_id === 'chunk-b'))).toBe(false);

    expect(result.current.manifest?.document_id).toBe(documentB);
    expect(result.current.manifest?.revision).toBe('rev-1');
    expect(result.current.chunks.map((chunk) => chunk.chunk_id)).toContain('chunk-b');
    expect(result.current.chunks.find((chunk) => chunk.chunk_id === 'chunk-b')?.objects[0].z_index).toBe(7);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-b');
    expect(result.current.saveStatus).toBe('offline');
    expect(result.current.undoDepth).toBe(undoDepthInB);
  });

  it('clears the committed draft after a successful CAS even when no own echo arrives', async () => {
    const baseManifest = makeManifest();
    const committedManifest = makeManifest({ revision: 'rev-2' });
    const commitGate = createDeferred<void>();
    let saveCalls = 0;

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'vfs_ink_get') return structuredClone(baseManifest);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        saveCalls += 1;
        await commitGate.promise;
        return structuredClone(committedManifest);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 3 }]);
    });

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = result.current.save();
    });
    await waitFor(() => expect(saveCalls).toBe(1));
    expect(records.has(DOCUMENT_ID)).toBe(true);

    await act(async () => {
      commitGate.resolve();
      await savePromise;
    });

    expect(result.current.saveStatus).toBe('saved');
    await waitFor(() => expect(records.has(DOCUMENT_ID)).toBe(false));
  });

  it('does not leave a same-content draft written during a pending CAS', async () => {
    const baseManifest = makeManifest();
    const committedManifest = makeManifest({ revision: 'rev-2' });
    const commitGate = createDeferred<void>();
    let saveCalls = 0;
    const saveRequests: Array<{ operation_id: string }> = [];

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') return structuredClone(baseManifest);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        saveCalls += 1;
        saveRequests.push(payload.request as { operation_id: string });
        await commitGate.promise;
        return structuredClone(committedManifest);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 3 }]);
    });

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = result.current.save();
    });
    await waitFor(() => expect(saveCalls).toBe(1));
    const committedSequence = records.get(DOCUMENT_ID)?.sequence ?? -1;
    expect(committedSequence).toBeGreaterThan(0);

    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(records.get(DOCUMENT_ID)?.sequence ?? -1).toBeGreaterThan(committedSequence));
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(3);

    await act(async () => {
      commitGate.resolve();
      await savePromise;
    });
    expect(result.current.saveStatus).toBe('saved');

    await emitChanged({
      document_id: DOCUMENT_ID,
      revision: 'rev-2',
      operation_id: saveRequests[0].operation_id,
      affected_page_ids: [PAGE_ID],
    });

    await waitFor(() => expect(records.has(DOCUMENT_ID)).toBe(false));
  });

  it('keeps edits made during a pending CAS and continues from the returned base revision', async () => {
    let manifest = makeManifest();
    const commitGate = createDeferred<void>();
    let saveCalls = 0;
    const saveRequests: Array<{
      expected_revision: string;
      operation_id: string;
      changed: InkBoardChunk[];
    }> = [];
    const onConflict = vi.fn();

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') return structuredClone(manifest);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        saveCalls += 1;
        saveRequests.push(structuredClone(payload.request));
        if (saveCalls === 1) await commitGate.promise;
        manifest = makeManifest({ revision: `rev-${saveCalls + 1}` });
        return structuredClone(manifest);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal, onConflict }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 2 }]);
    });

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = result.current.save();
    });
    await waitFor(() => expect(saveCalls).toBe(1));
    const committedSequence = records.get(DOCUMENT_ID)?.sequence ?? -1;

    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 3 }]);
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(records.get(DOCUMENT_ID)?.sequence ?? -1).toBeGreaterThan(committedSequence));
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(3);

    await act(async () => {
      commitGate.resolve();
      await savePromise;
    });

    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-a');
    expect(result.current.manifest?.revision).toBe('rev-2');
    expect(records.get(DOCUMENT_ID)?.base_revision).toBe('rev-2');
    expect(result.current.saveStatus).toBe('offline');
    expect(onConflict).not.toHaveBeenCalled();

    await emitChanged({
      document_id: DOCUMENT_ID,
      revision: 'rev-2',
      operation_id: saveRequests[0].operation_id,
      affected_page_ids: [PAGE_ID],
    });
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-a');
    expect(records.get(DOCUMENT_ID)?.base_revision).toBe('rev-2');
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(3);

    let secondSave!: Promise<void>;
    act(() => {
      secondSave = result.current.save();
    });
    await act(async () => {
      await secondSave;
    });

    expect(saveCalls).toBe(2);
    expect(saveRequests[1].expected_revision).toBe('rev-2');
    expect(saveRequests[1].changed[0].objects[0].z_index).toBe(3);
    expect(saveRequests[1].operation_id).not.toBe(saveRequests[0].operation_id);
    expect(onConflict).not.toHaveBeenCalled();
    expect(result.current.saveStatus).toBe('saved');
  });

  it('keeps a non-retryable validation draft and does not replay the same CAS on flush', async () => {
    const baseManifest = makeManifest();
    let saveCalls = 0;

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'vfs_ink_get') return structuredClone(baseManifest);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        saveCalls += 1;
        throw Object.assign(new Error('Ink request is invalid.'), {
          code: 'INVALID_ARGUMENT',
          retryable: false,
        });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 4 }]);
    });

    await act(async () => {
      await result.current.save();
    });

    expect(saveCalls).toBe(1);
    expect(result.current.saveStatus).not.toBe('saved');
    expect(result.current.error).toBeTruthy();
    expect(records.get(DOCUMENT_ID)?.changed[0].chunk_id).toBe('chunk-a');
    expect(records.get(DOCUMENT_ID)?.base_revision).toBe('rev-1');

    let flushError: unknown;
    await act(async () => {
      try {
        await result.current.flush();
      } catch (error) {
        flushError = error;
      }
    });

    expect(flushError).toBeInstanceOf(Error);
    expect(saveCalls).toBe(1);
    expect(records.has(DOCUMENT_ID)).toBe(true);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-a');
  });

  it('persists the previous document draft before switching to a clean new document', async () => {
    const documentA = 'ink_board_a';
    const documentB = 'ink_board_b';
    const manifestA = makeManifest({ document_id: documentA });
    const manifestB = makeManifest({
      document_id: documentB,
      chunks: [chunkRef('chunk-b', { x: 0, y: 0, width: 100, height: 100 })],
    });
    const manifests = new Map<string, InkBoardManifest>([
      [documentA, manifestA],
      [documentB, manifestB],
    ]);
    const chunksByDocument = new Map<string, Record<string, InkBoardChunk>>([
      [documentA, { 'chunk-a': chunkA }],
      [documentB, { 'chunk-b': chunkWithObject('chunk-b') }],
    ]);

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') {
        const manifest = manifests.get(payload.request.document_id);
        if (!manifest) throw new Error(`Unknown document: ${payload.request.document_id}`);
        return structuredClone(manifest);
      }
      if (command === 'vfs_ink_get_chunks') {
        const chunks = chunksByDocument.get(payload.request.document_id) ?? {};
        return payload.request.chunk_ids
          .map((chunkId: string) => chunks[chunkId])
          .filter((chunk: InkBoardChunk | undefined): chunk is InkBoardChunk => Boolean(chunk))
          .map((chunk: InkBoardChunk) => structuredClone(chunk));
      }
      if (command === 'vfs_ink_save_chunks') throw new Error('Unexpected save while switching documents.');
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const { result, rerender } = renderHook(
      ({ documentId }: { documentId: string }) => useInkBoardDocument(documentId, { journal }),
      { initialProps: { documentId: documentA } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 6 }]);
    });
    expect(records.get(documentA)?.changed[0].objects[0].z_index).toBe(6);
    expect(hasDirtyInkEditor(documentA)).toBe(true);

    rerender({ documentId: documentB });
    await waitFor(() => expect(result.current.manifest?.document_id).toBe(documentB));

    await waitFor(() => expect(records.get(documentA)?.changed[0].objects[0].z_index).toBe(6));
    expect(records.get(documentA)?.document_id).toBe(documentA);
    expect(records.has(documentB)).toBe(false);
    expect(result.current.manifest?.document_id).toBe(documentB);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(result.current.saveStatus).toBe('saved');
  });

  it('does not delete a newer draft written while a committed draft removal is in flight', async () => {
    const baseManifest = makeManifest();
    const stored = new Map<string, InkBoardDraftRecord>();
    const owners = new Map<string, string>();
    const floors = new Map<string, number>();
    const removeGate = createDeferred<void>();
    let removeStarted = false;
    const currentSequence = (documentId: string): number =>
      stored.get(documentId)?.sequence ?? floors.get(documentId) ?? 0;
    const storage: InkBoardDraftStorage = {
      async read(key) {
        return stored.get(key.document_id);
      },
      async readSequenceFloor(key) {
        return currentSequence(key.document_id);
      },
      async claim(key, owner) {
        owners.set(key.document_id, owner);
        const draft = stored.get(key.document_id);
        if (draft) {
          const owned = { ...structuredClone(draft), owner };
          stored.set(key.document_id, owned);
          return {
            owner,
            sequence_floor: owned.sequence,
            draft: structuredClone(owned),
          };
        }
        return { owner, sequence_floor: floors.get(key.document_id) ?? 0 };
      },
      async write(record) {
        if (owners.get(record.document_id) !== record.owner) {
          throw new DraftWriteRejectedError('ownership');
        }
        if (record.sequence <= currentSequence(record.document_id)) {
          throw new DraftWriteRejectedError('stale');
        }
        stored.set(record.document_id, structuredClone(record));
      },
      async remove(key) {
        stored.delete(key.document_id);
      },
      async removeIfSequenceAtMost(key, sequence, owner) {
        removeStarted = true;
        await removeGate.promise;
        if (owners.get(key.document_id) !== owner) {
          throw new DraftWriteRejectedError('ownership');
        }
        const current = currentSequence(key.document_id);
        if (current > sequence) return;
        floors.set(key.document_id, Math.max(sequence, current));
        stored.delete(key.document_id);
      },
    };
    const journal = new InkBoardDraftJournalStore(storage);
    const saveRequests: Array<{ changed: InkBoardChunk[] }> = [];
    let saveCalls = 0;

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') return structuredClone(baseManifest);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        saveCalls += 1;
        saveRequests.push(structuredClone(payload.request));
        return makeManifest({ revision: `rev-${saveCalls + 1}` });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 3 }]);
    });

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = result.current.save();
    });
    await waitFor(() => expect(removeStarted).toBe(true));

    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 9 }]);
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(stored.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(9));

    await act(async () => {
      removeGate.resolve();
      await savePromise;
    });

    expect(stored.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(9);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-a');
    expect(result.current.saveStatus).not.toBe('saved');

    let flushError: unknown;
    await act(async () => {
      try {
        await result.current.flush();
      } catch (error) {
        flushError = error;
      }
    });
    if (!flushError) {
      expect(saveRequests.some((request) =>
        request.changed[0]?.objects[0]?.content.kind === 'stroke'
        && (request.changed[0]?.objects[0]?.z_index === 9))).toBe(true);
    }
  });

  it('does not apply a previous document chunk load to the new document with the same revision', async () => {
    const documentA = 'ink_board_a';
    const documentB = 'ink_board_b';
    const manifestA = makeManifest({ document_id: documentA });
    const manifestB = makeManifest({
      document_id: documentB,
      chunks: [chunkRef('chunk-b', { x: 0, y: 0, width: 100, height: 100 })],
    });
    const manifests = new Map<string, InkBoardManifest>([
      [documentA, manifestA],
      [documentB, manifestB],
    ]);
    const chunksByDocument = new Map<string, Record<string, InkBoardChunk>>([
      [documentA, { 'chunk-a': chunkA }],
      [documentB, { 'chunk-b': chunkWithObject('chunk-b') }],
    ]);
    const aChunkGate = createDeferred<void>();
    let aChunkRequested = false;

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') {
        const manifest = manifests.get(payload.request.document_id);
        if (!manifest) throw new Error(`Unknown document: ${payload.request.document_id}`);
        return structuredClone(manifest);
      }
      if (command === 'vfs_ink_get_chunks') {
        if (payload.request.document_id === documentA) {
          aChunkRequested = true;
          await aChunkGate.promise;
        }
        const chunks = chunksByDocument.get(payload.request.document_id) ?? {};
        return payload.request.chunk_ids
          .map((chunkId: string) => chunks[chunkId])
          .filter((chunk: InkBoardChunk | undefined): chunk is InkBoardChunk => Boolean(chunk))
          .map((chunk: InkBoardChunk) => structuredClone(chunk));
      }
      if (command === 'vfs_ink_save_chunks') throw new Error('Unexpected save during stale chunk load.');
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal } = createMemoryJournal();
    const { result, rerender } = renderHook(
      ({ documentId }: { documentId: string }) => useInkBoardDocument(documentId, { journal }),
      { initialProps: { documentId: documentA } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    let pendingLoad!: Promise<void>;
    act(() => {
      pendingLoad = result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await waitFor(() => expect(aChunkRequested).toBe(true));

    rerender({ documentId: documentB });
    await waitFor(() => expect(result.current.manifest?.document_id).toBe(documentB));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    expect(result.current.chunks.map((chunk) => chunk.chunk_id)).toEqual(['chunk-b']);

    await act(async () => {
      aChunkGate.resolve();
      try {
        await pendingLoad;
      } catch {
        // A stale load may reject; it must not apply either way.
      }
    });

    expect(result.current.chunks.map((chunk) => chunk.chunk_id)).toEqual(['chunk-b']);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(result.current.manifest?.document_id).toBe(documentB);
    expect(result.current.saveStatus).toBe('saved');
  });

  it('keeps a draft written while a clean remote refetch is in flight', async () => {
    const baseManifest = makeManifest();
    const remoteManifest = makeManifest({ revision: 'rev-remote' });
    const getGate = createDeferred<void>();
    let getCalls = 0;

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'vfs_ink_get') {
        getCalls += 1;
        if (getCalls === 1) return structuredClone(baseManifest);
        await getGate.promise;
        return structuredClone(remoteManifest);
      }
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') throw new Error('Unexpected save during remote refetch.');
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const onConflict = vi.fn();
    const { result } = renderHook(() =>
      useInkBoardDocument(DOCUMENT_ID, { journal, onConflict }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    const listener = mocks.listener;
    if (!listener) throw new Error('Missing ink:changed listener.');

    const eventPromise = listener({
      payload: {
        document_id: DOCUMENT_ID,
        revision: 'rev-remote',
        operation_id: 'other-client',
        affected_page_ids: [PAGE_ID],
      },
    });
    await waitFor(() => expect(getCalls).toBe(2));

    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 9 }]);
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(9));

    await act(async () => {
      getGate.resolve();
      await eventPromise;
    });

    expect(result.current.saveStatus).toBe('conflict');
    expect(result.current.manifest?.revision).toBe('rev-1');
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-a');
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(9);
    expect(onConflict).toHaveBeenCalledWith(expect.objectContaining({
      document_id: DOCUMENT_ID,
      remote_revision: 'rev-remote',
    }));
  });

  it('does not let an unmounted previous session delete the recovered session draft', async () => {
    const manifestState = { current: makeManifest() };
    const casGate = createDeferred<void>();
    let saveCalls = 0;

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'vfs_ink_get') return structuredClone(manifestState.current);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        saveCalls += 1;
        if (saveCalls === 1) await casGate.promise;
        manifestState.current = makeManifest({ revision: `rev-${saveCalls + 1}` });
        return structuredClone(manifestState.current);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const first = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await act(async () => {
      await first.result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await first.result.current.upsertObjects([{ ...strokeObject, z_index: 2 }]);
    });

    let firstSave!: Promise<void>;
    act(() => {
      firstSave = first.result.current.save();
    });
    await waitFor(() => expect(saveCalls).toBe(1));
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(2);

    first.unmount();

    const second = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    expect(second.result.current.manifest?.revision).toBe('rev-1');
    expect(second.result.current.saveStatus).toBe('offline');
    expect(second.result.current.chunks[0].objects[0].z_index).toBe(2);

    await act(async () => {
      await second.result.current.upsertObjects([{ ...strokeObject, z_index: 5 }]);
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(5));

    await act(async () => {
      casGate.resolve();
      await firstSave;
    });

    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(5);
    expect(second.result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-a');
    expect(second.result.current.chunks[0].objects[0].z_index).toBe(5);
    expect(second.result.current.saveStatus).not.toBe('saved');
  });

  it('does not treat a journal claim failure as a clean document', async () => {
    const baseManifest = makeManifest();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'vfs_ink_get') return structuredClone(baseManifest);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      throw new Error(`Unexpected command: ${command}`);
    });

    const journal = new InkBoardDraftJournalStore({
      async read() {
        throw new Error('Journal claim failed.');
      },
      async claim() {
        throw new Error('Journal claim failed.');
      },
      async write() {
        // Unused before the claim failure is surfaced.
      },
      async remove() {
        // Unused before the claim failure is surfaced.
      },
    });
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));

    await waitFor(() => expect(result.current.status).not.toBe('loading'));
    expect(result.current.error).toBeTruthy();
    expect(result.current.saveStatus).toBe('storage-error');
  });

  it('starts from the claimed sequence floor after a tombstone remount', async () => {
    const baseManifest = makeManifest();
    const { journal, records, floors } = createMemoryJournal();
    const seedOwner = 'seed-owner';
    await journal.claim({ document_id: DOCUMENT_ID }, seedOwner);
    await journal.persist(claimedDraft(5, seedOwner));
    await journal.discard({ document_id: DOCUMENT_ID }, 5, seedOwner);

    let sequenceAtCas = -1;
    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') return structuredClone(baseManifest);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        sequenceAtCas = records.get(DOCUMENT_ID)?.sequence ?? -1;
        return makeManifest({ revision: 'rev-2' });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.saveStatus).toBe('saved');
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 4 }]);
    });
    await act(async () => {
      await result.current.save();
    });

    expect(sequenceAtCas).toBeGreaterThan(5);
    expect(result.current.manifest?.revision).toBe('rev-2');
    expect(result.current.saveStatus).toBe('saved');
    expect(records.has(DOCUMENT_ID)).toBe(false);
    expect(floors.get(DOCUMENT_ID) ?? 0).toBeGreaterThanOrEqual(sequenceAtCas);
  });

  it('keeps the previous document draft across a StrictMode remount and switch', async () => {
    const documentA = 'ink_board_a';
    const documentB = 'ink_board_b';
    const manifestA = makeManifest({ document_id: documentA });
    const manifestB = makeManifest({
      document_id: documentB,
      chunks: [chunkRef('chunk-b', { x: 0, y: 0, width: 100, height: 100 })],
    });
    const manifests = new Map<string, InkBoardManifest>([
      [documentA, manifestA],
      [documentB, manifestB],
    ]);
    const chunksByDocument = new Map<string, Record<string, InkBoardChunk>>([
      [documentA, { 'chunk-a': chunkA }],
      [documentB, { 'chunk-b': chunkWithObject('chunk-b') }],
    ]);

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') {
        const manifest = manifests.get(payload.request.document_id);
        if (!manifest) throw new Error(`Unknown document: ${payload.request.document_id}`);
        return structuredClone(manifest);
      }
      if (command === 'vfs_ink_get_chunks') {
        const chunks = chunksByDocument.get(payload.request.document_id) ?? {};
        return payload.request.chunk_ids
          .map((chunkId: string) => chunks[chunkId])
          .filter((chunk: InkBoardChunk | undefined): chunk is InkBoardChunk => Boolean(chunk))
          .map((chunk: InkBoardChunk) => structuredClone(chunk));
      }
      if (command === 'vfs_ink_save_chunks') throw new Error('Unexpected save while switching documents.');
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const { result, rerender } = renderHook(
      ({ documentId }: { documentId: string }) => useInkBoardDocument(documentId, { journal }),
      { initialProps: { documentId: documentA }, wrapper: StrictMode },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 8 }]);
    });
    expect(hasDirtyInkEditor(documentA)).toBe(true);

    rerender({ documentId: documentB });
    await waitFor(() => expect(result.current.manifest?.document_id).toBe(documentB));
    await waitFor(() => expect(records.get(documentA)?.changed[0].objects[0].z_index).toBe(8));
    expect(records.has(documentB)).toBe(false);
    expect(result.current.dirtyChunks).toEqual([]);
    expect(result.current.saveStatus).toBe('saved');
  });

  it('rejects the old CAS journal cleanup after a new owner claims the same document', async () => {
    const manifestState = { current: makeManifest() };
    const casGate = createDeferred<void>();
    let saveCalls = 0;

    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'vfs_ink_get') return structuredClone(manifestState.current);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        saveCalls += 1;
        if (saveCalls === 1) await casGate.promise;
        manifestState.current = makeManifest({ revision: `rev-${saveCalls + 1}` });
        return structuredClone(manifestState.current);
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const first = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    await act(async () => {
      await first.result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await first.result.current.upsertObjects([{ ...strokeObject, z_index: 2 }]);
    });

    let firstSave!: Promise<void>;
    act(() => {
      firstSave = first.result.current.save();
    });
    await waitFor(() => expect(saveCalls).toBe(1));
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(2);

    const second = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(second.result.current.status).toBe('ready'));
    expect(second.result.current.saveStatus).toBe('offline');
    expect(second.result.current.chunks[0].objects[0].z_index).toBe(2);

    await act(async () => {
      await second.result.current.upsertObjects([{ ...strokeObject, z_index: 5 }]);
    });
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(5));

    await act(async () => {
      casGate.resolve();
      await firstSave;
    });

    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(5);
    expect(first.result.current.saveStatus).toBe('conflict');
    expect(first.result.current.error).toBeTruthy();
    expect(second.result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-a');
    expect(second.result.current.chunks[0].objects[0].z_index).toBe(5);
    expect(second.result.current.saveStatus).not.toBe('saved');
  });

  it('journals an upsert gesture before it resolves and recovers it after a new claim', async () => {
    const baseManifest = makeManifest();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'vfs_ink_get') return structuredClone(baseManifest);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        throw new Error('Unexpected CAS for an unrequested gesture save.');
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records, owners } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });

    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 7 }]);
    });

    const sessionOwner = owners.get(DOCUMENT_ID);
    expect(sessionOwner).toBeTruthy();
    expect(records.get(DOCUMENT_ID)?.owner).toBe(sessionOwner);
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(7);
    expect(records.get(DOCUMENT_ID)?.sequence ?? 0).toBeGreaterThan(0);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-a');
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'vfs_ink_save_chunks')).toBe(false);

    const newWindow = await journal.claim({ document_id: DOCUMENT_ID }, 'new-window-owner');
    expect(newWindow.sequence_floor).toBeGreaterThan(0);
    expect(newWindow.draft?.changed[0].objects[0].z_index).toBe(7);
  });

  it('keeps an edit made while the save journal write is pending', async () => {
    const baseManifest = makeManifest();
    const memory = createMemoryJournal();
    const savePersistGate = createDeferred<void>();
    let persistCalls = 0;
    let savePersistEntered = false;
    let journalChain: Promise<void> = Promise.resolve();
    const enqueue = (operation: () => Promise<void>): Promise<void> => {
      const next = journalChain.then(operation);
      journalChain = next.catch(() => undefined);
      return next;
    };
    const journal: InkBoardDraftJournal = {
      read: (key) => memory.journal.read(key),
      readSequenceFloor: (key) => memory.journal.readSequenceFloor(key),
      claim: (key, owner) => memory.journal.claim(key, owner),
      persist: (record) => {
        persistCalls += 1;
        const call = persistCalls;
        return enqueue(async () => {
          if (call === 2) {
            // Gate only the save's journal write, never the gesture write.
            savePersistEntered = true;
            await savePersistGate.promise;
          }
          await memory.journal.persist(record);
        });
      },
      discard: (key, throughSequence, owner) => (
        enqueue(() => memory.journal.discard(key, throughSequence, owner))
      ),
    };
    const saveRequests: Array<{ changed: InkBoardChunk[] }> = [];

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') return structuredClone(baseManifest);
      if (command === 'vfs_ink_get_chunks') return [structuredClone(chunkA)];
      if (command === 'vfs_ink_save_chunks') {
        saveRequests.push(structuredClone(payload.request));
        return makeManifest({ revision: 'rev-2' });
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await result.current.upsertObjects([{ ...strokeObject, z_index: 2 }]);
    });

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = result.current.save();
    });
    await waitFor(() => expect(savePersistEntered).toBe(true));

    let newGesture!: Promise<void>;
    act(() => {
      newGesture = result.current.upsertObjects([{ ...strokeObject, z_index: 9 }]);
    });
    await waitFor(() => expect(persistCalls).toBe(3));

    await act(async () => {
      savePersistGate.resolve();
      await savePromise;
      await newGesture;
    });

    expect(saveRequests[0].changed[0].objects[0].z_index).toBe(2);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('chunk-a');
    expect(result.current.manifest?.revision).toBe('rev-2');
    expect(memory.records.get(DOCUMENT_ID)?.base_revision).toBe('rev-2');
    expect(memory.records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(9);
    expect(result.current.saveStatus).not.toBe('saved');
  });

  it('ignores an older gated load after a newer viewport completed', async () => {
    const dirtyRef = chunkRef('dirty-1', { x: 0, y: 0, width: 100, height: 100 });
    const aRefs = [
      chunkRef('a-1', { x: 200, y: 0, width: 100, height: 100 }),
      chunkRef('a-2', { x: 300, y: 0, width: 100, height: 100 }),
    ];
    const bRefs = [
      chunkRef('b-1', { x: 1000, y: 0, width: 100, height: 100 }),
      chunkRef('b-2', { x: 1100, y: 0, width: 100, height: 100 }),
    ];
    const manifest = makeManifest({ chunks: [dirtyRef, ...aRefs, ...bRefs] });
    const chunks: Record<string, InkBoardChunk> = {
      'dirty-1': chunkWithObject('dirty-1'),
      'a-1': chunkWithObject('a-1'),
      'a-2': chunkWithObject('a-2'),
      'b-1': chunkWithObject('b-1'),
      'b-2': chunkWithObject('b-2'),
    };
    const aGate = createDeferred<void>();
    let aRequested = false;

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') return structuredClone(manifest);
      if (command === 'vfs_ink_get_chunks') {
        if (payload.request.chunk_ids.includes('a-1')) {
          aRequested = true;
          await aGate.promise;
        }
        return payload.request.chunk_ids
          .map((chunkId: string) => chunks[chunkId])
          .filter((chunk: InkBoardChunk | undefined): chunk is InkBoardChunk => Boolean(chunk))
          .map((chunk: InkBoardChunk) => structuredClone(chunk));
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    const dirtyObject = chunks['dirty-1'].objects[0];
    await act(async () => {
      await result.current.upsertObjects([{ ...dirtyObject, z_index: 2 }]);
    });

    let olderLoad!: Promise<void>;
    act(() => {
      olderLoad = result.current.loadVisible({ x: 200, y: 0, width: 200, height: 100 });
    });
    await waitFor(() => expect(aRequested).toBe(true));

    let newerLoad!: Promise<void>;
    act(() => {
      // While A is gated this is only the latest pending viewport: it must not
      // start a second fetch yet.
      newerLoad = result.current.loadVisible({ x: 1000, y: 0, width: 200, height: 100 });
    });

    await act(async () => {
      aGate.resolve();
      try {
        await olderLoad;
      } catch {
        // A stale load may reject; it must not prune the newer view either way.
      }
      await newerLoad;
    });

    expect(result.current.chunks.map((chunk) => chunk.chunk_id).sort()).toEqual([
      'b-1',
      'b-2',
      'dirty-1',
    ]);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('dirty-1');
  });

  it('bounds viewport fetches to one active request and one latest pending', async () => {
    const dirtyRef = chunkRef('dirty-1', { x: 0, y: 0, width: 100, height: 100 });
    const aRef = chunkRef('a-1', { x: 200, y: 0, width: 100, height: 100 });
    const bRef = chunkRef('b-1', { x: 1000, y: 0, width: 100, height: 100 });
    const cRef = chunkRef('c-1', { x: 2000, y: 0, width: 100, height: 100 });
    const manifest = makeManifest({ chunks: [dirtyRef, aRef, bRef, cRef] });
    const chunks: Record<string, InkBoardChunk> = {
      'dirty-1': chunkWithObject('dirty-1'),
      'a-1': chunkWithObject('a-1'),
      'b-1': chunkWithObject('b-1'),
      'c-1': chunkWithObject('c-1'),
    };
    const aGate = createDeferred<void>();
    let requestCount = 0;
    let aRequested = false;
    const requestBatches: string[][] = [];

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') return structuredClone(manifest);
      if (command === 'vfs_ink_get_chunks') {
        requestCount += 1;
        requestBatches.push([...payload.request.chunk_ids]);
        if (payload.request.chunk_ids.includes('a-1')) {
          aRequested = true;
          await aGate.promise;
        }
        return payload.request.chunk_ids
          .map((chunkId: string) => chunks[chunkId])
          .filter((chunk: InkBoardChunk | undefined): chunk is InkBoardChunk => Boolean(chunk))
          .map((chunk: InkBoardChunk) => structuredClone(chunk));
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    const requestCountBefore = requestCount;
    const dirtyObject = chunks['dirty-1'].objects[0];
    await act(async () => {
      await result.current.upsertObjects([{ ...dirtyObject, z_index: 2 }]);
    });

    let aLoad!: Promise<void>;
    act(() => {
      aLoad = result.current.loadVisible({ x: 200, y: 0, width: 100, height: 100 });
    });
    await waitFor(() => expect(aRequested).toBe(true));

    let bLoad!: Promise<void>;
    let cLoad!: Promise<void>;
    act(() => {
      bLoad = result.current.loadVisible({ x: 1000, y: 0, width: 100, height: 100 });
      cLoad = result.current.loadVisible({ x: 2000, y: 0, width: 100, height: 100 });
    });
    await act(async () => {
      await bLoad;
    });
    expect(requestCount - requestCountBefore).toBe(1);
    expect(requestBatches.slice(requestCountBefore).flat()).toEqual(['a-1']);
    expect(result.current.chunks.map((chunk) => chunk.chunk_id)).toEqual(['dirty-1']);

    await act(async () => {
      aGate.resolve();
      try {
        await aLoad;
      } catch {
        // The superseded active load settles without applying.
      }
      await cLoad;
    });

    expect(requestCount - requestCountBefore).toBe(2);
    const viewportRequests = requestBatches.slice(requestCountBefore).flat();
    expect(viewportRequests).toEqual(['a-1', 'c-1']);
    expect(viewportRequests).not.toContain('b-1');
    expect(result.current.chunks.map((chunk) => chunk.chunk_id).sort()).toEqual([
      'c-1',
      'dirty-1',
    ]);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('dirty-1');
  });

  it('rejects a viewport load when an edit lands during its fetch and keeps the dirty draft', async () => {
    const dirtyRef = chunkRef('dirty-1', { x: 0, y: 0, width: 100, height: 100 });
    const newRef = chunkRef('n-1', { x: 1000, y: 0, width: 100, height: 100 });
    const manifest = makeManifest({ chunks: [dirtyRef, newRef] });
    const chunks: Record<string, InkBoardChunk> = {
      'dirty-1': chunkWithObject('dirty-1'),
      'n-1': chunkWithObject('n-1'),
    };
    const newFetchGate = createDeferred<void>();
    let newFetchEntered = false;
    let newFetchCount = 0;

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') return structuredClone(manifest);
      if (command === 'vfs_ink_get_chunks') {
        if (payload.request.chunk_ids.includes('n-1')) {
          newFetchCount += 1;
          if (newFetchCount === 1) {
            newFetchEntered = true;
            await newFetchGate.promise;
          }
        }
        return payload.request.chunk_ids
          .map((chunkId: string) => chunks[chunkId])
          .filter((chunk: InkBoardChunk | undefined): chunk is InkBoardChunk => Boolean(chunk))
          .map((chunk: InkBoardChunk) => structuredClone(chunk));
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal, records } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    const dirtyObject = chunks['dirty-1'].objects[0];
    await act(async () => {
      await result.current.upsertObjects([{ ...dirtyObject, z_index: 2 }]);
    });

    const newViewport = { x: 1000, y: 0, width: 100, height: 100 };
    let newLoad!: Promise<void>;
    act(() => {
      newLoad = result.current.loadVisible(newViewport);
    });
    await waitFor(() => expect(newFetchEntered).toBe(true));

    await act(async () => {
      await result.current.upsertObjects([{ ...dirtyObject, z_index: 3 }]);
    });

    let loadError: unknown;
    await act(async () => {
      newFetchGate.resolve();
      try {
        await newLoad;
      } catch (error) {
        loadError = error;
      }
    });

    expect(loadError).toBeInstanceOf(Error);
    expect(result.current.error).toBeTruthy();
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('dirty-1');
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(3);
    expect(result.current.manifest?.revision).toBe('rev-1');
    expect(result.current.chunks.map((chunk) => chunk.chunk_id)).not.toContain('n-1');

    await act(async () => {
      await result.current.loadVisible(newViewport);
    });
    expect(result.current.chunks.map((chunk) => chunk.chunk_id).sort()).toEqual([
      'dirty-1',
      'n-1',
    ]);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('dirty-1');
    expect(records.get(DOCUMENT_ID)?.changed[0].objects[0].z_index).toBe(3);
  });

  it('does not keep the old clean viewport resident while fetching a disjoint one', async () => {
    const dirtyRef = chunkRef('dirty-1', { x: 0, y: 0, width: 100, height: 100 }, 6 * MIB);
    const oldRefs = [
      chunkRef('o-1', { x: 200, y: 0, width: 100, height: 100 }, 6 * MIB),
      chunkRef('o-2', { x: 500, y: 0, width: 100, height: 100 }, 6 * MIB),
      chunkRef('o-3', { x: 800, y: 0, width: 100, height: 100 }, 6 * MIB),
    ];
    const newRefs = [
      chunkRef('n-1', { x: 0, y: 1000, width: 100, height: 100 }, 6 * MIB),
      chunkRef('n-2', { x: 150, y: 1000, width: 100, height: 100 }, 6 * MIB),
      chunkRef('n-3', { x: 300, y: 1000, width: 100, height: 100 }, 6 * MIB),
    ];
    const failedRef = chunkRef('f-1', { x: 0, y: 2000, width: 100, height: 100 }, 6 * MIB);
    const manifest = makeManifest({ chunks: [dirtyRef, ...oldRefs, ...newRefs, failedRef] });
    const chunks: Record<string, InkBoardChunk> = {
      'dirty-1': chunkWithObject('dirty-1'),
      'o-1': chunkWithObject('o-1'),
      'o-2': chunkWithObject('o-2'),
      'o-3': chunkWithObject('o-3'),
      'n-1': chunkWithObject('n-1'),
      'n-2': chunkWithObject('n-2'),
      'n-3': chunkWithObject('n-3'),
      'f-1': chunkWithObject('f-1'),
    };
    let newFetchEntered = false;
    const newFetchGate = createDeferred<void>();

    mocks.invoke.mockImplementation(async (command: string, payload: Record<string, any>) => {
      if (command === 'vfs_ink_get') return structuredClone(manifest);
      if (command === 'vfs_ink_get_chunks') {
        const chunkIds = payload.request.chunk_ids as string[];
        if (chunkIds.includes('f-1')) throw new Error('Ink board chunk fetch failed.');
        if (chunkIds.includes('n-1')) {
          newFetchEntered = true;
          await newFetchGate.promise;
        }
        return chunkIds
          .map((chunkId) => chunks[chunkId])
          .filter((chunk: InkBoardChunk | undefined): chunk is InkBoardChunk => Boolean(chunk))
          .map((chunk: InkBoardChunk) => structuredClone(chunk));
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const { journal } = createMemoryJournal();
    const { result } = renderHook(() => useInkBoardDocument(DOCUMENT_ID, { journal }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => {
      await result.current.loadVisible({ x: 0, y: 0, width: 100, height: 100 });
    });
    const dirtyObject = chunks['dirty-1'].objects[0];
    await act(async () => {
      await result.current.upsertObjects([{ ...dirtyObject, z_index: 2 }]);
    });

    await act(async () => {
      await result.current.loadVisible({ x: 200, y: 0, width: 700, height: 100 });
    });
    expect(result.current.chunks.map((chunk) => chunk.chunk_id).sort()).toEqual([
      'dirty-1',
      'o-1',
      'o-2',
      'o-3',
    ]);

    let newLoad!: Promise<void>;
    act(() => {
      newLoad = result.current.loadVisible({ x: 0, y: 1000, width: 400, height: 100 });
    });
    await waitFor(() => expect(newFetchEntered).toBe(true));

    // The fetch is still gated: the old clean viewport must already be gone
    // before the new chunks are fetched. Only the dirty chunk survives.
    const chunksWhileFetching = result.current.chunks.map((chunk) => chunk.chunk_id);
    expect(chunksWhileFetching).toContain('dirty-1');
    expect(chunksWhileFetching).not.toContain('o-1');
    expect(chunksWhileFetching).not.toContain('o-2');
    expect(chunksWhileFetching).not.toContain('o-3');

    await act(async () => {
      newFetchGate.resolve();
      await newLoad;
    });

    const byteLength = new Map(manifest.chunks.map((ref) => [ref.chunk_id, ref.byte_length]));
    const totalBytes = result.current.chunks.reduce(
      (sum, chunk) => sum + (byteLength.get(chunk.chunk_id) ?? 0),
      0,
    );
    expect(result.current.chunks.map((chunk) => chunk.chunk_id).sort()).toEqual([
      'dirty-1',
      'n-1',
      'n-2',
      'n-3',
    ]);
    expect(totalBytes).toBeLessThanOrEqual(32 * MIB);
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('dirty-1');

    let failedLoad: unknown;
    await act(async () => {
      try {
        await result.current.loadVisible({ x: 0, y: 2000, width: 100, height: 100 });
      } catch (error) {
        failedLoad = error;
      }
    });
    expect(failedLoad).toBeTruthy();
    expect(result.current.error).toBeTruthy();
    expect(result.current.dirtyChunks.map((chunk) => chunk.chunk_id)).toContain('dirty-1');
    expect(result.current.chunks.map((chunk) => chunk.chunk_id)).toContain('dirty-1');
    expect(result.current.manifest?.document_id).toBe(DOCUMENT_ID);
    expect(result.current.manifest?.revision).toBe('rev-1');
  });
});
