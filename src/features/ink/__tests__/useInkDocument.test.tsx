import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inkDraftJournal, type InkDraftRecord } from '../drafts';
import { useInkDocument } from '../useInkDocument';
import type { InkManifest, InkPage } from '../types';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listener: undefined as undefined | ((event: { payload: unknown }) => unknown),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, listener: (event: { payload: unknown }) => unknown) => {
    mocks.listener = listener;
    return () => { if (mocks.listener === listener) mocks.listener = undefined; };
  }),
}));

const documentId = 'paged-deferred-save';
const emptyPage = (page_id: string): InkPage => ({ schema_version: 1, page_id, objects: [] });
const editedPage = (page_id: string, ...ids: string[]): InkPage => ({
  ...emptyPage(page_id),
  objects: ids.map((id) => ({
    id, author: 'user', created_at: 1,
    content: { kind: 'stroke', samples: [{ x: 10, y: 20, pressure: 0.5 }], style: { tool: 'pen', color: '#000000', width: 2, pressure_enabled: true } },
  })),
});

function makeManifest(id = documentId): InkManifest {
  return {
    schema_version: 1, document_id: id, revision: 'rev-1', title: 'Paged', source: { kind: 'blank' },
    pages: ['page-1', 'page-2'].map((page_id) => ({
      page_id, width: 200, height: 160, background: { kind: 'blank', ruling: 'blank' }, page_blob_hash: `hash-${page_id}`,
    })),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

type SaveRequest = { document_id: string; expected_revision: string; operation_id: string; page: InkPage };
let manifest: InkManifest;
let pages: Map<string, InkPage>;
let drafts: Map<string, InkDraftRecord>;
let saves: SaveRequest[];
let saveGate: ReturnType<typeof deferred> | undefined;
let saveError: unknown;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.listener = undefined;
  manifest = makeManifest();
  pages = new Map(manifest.pages.map(({ page_id }) => [page_id, emptyPage(page_id)]));
  drafts = new Map();
  saves = [];
  saveGate = undefined;
  saveError = undefined;
  vi.spyOn(inkDraftJournal, 'read').mockImplementation(async ({ page_id }) => structuredClone(drafts.get(page_id)));
  vi.spyOn(inkDraftJournal, 'persist').mockImplementation(async (record) => { drafts.set(record.page_id, structuredClone(record)); });
  vi.spyOn(inkDraftJournal, 'discard').mockImplementation(async ({ page_id }, sequence) => {
    if ((drafts.get(page_id)?.sequence ?? Infinity) <= sequence) drafts.delete(page_id);
  });
  mocks.invoke.mockImplementation(async (command: string, { request }: { request: Record<string, any> }) => {
    if (command === 'vfs_ink_get') return structuredClone({ ...manifest, document_id: request.document_id });
    if (command === 'vfs_ink_get_page') return structuredClone(pages.get(request.page_id));
    if (command === 'vfs_ink_save_page') {
      saves.push(structuredClone(request) as SaveRequest);
      if (saveGate) await saveGate.promise;
      if (saveError) throw saveError;
      if (request.expected_revision !== manifest.revision) throw { code: 'REVISION_CONFLICT', message: 'Changed remotely', retryable: false };
      pages.set(request.page.page_id, structuredClone(request.page));
      manifest = { ...manifest, revision: `saved-${saves.length}`, pages: manifest.pages.map((entry) => entry.page_id === request.page.page_id ? { ...entry, page_blob_hash: `saved-${saves.length}` } : entry) };
      return structuredClone(manifest);
    }
    if (command === 'vfs_ink_rename') {
      manifest = { ...manifest, revision: 'renamed', title: request.title };
      return structuredClone(manifest);
    }
    if (command === 'vfs_ink_append_page') {
      const page_id = 'page-3';
      const pageRef = { ...manifest.pages[0], page_id, page_blob_hash: 'empty-page-3' };
      manifest = { ...manifest, revision: 'appended', pages: [...manifest.pages, pageRef] };
      pages.set(page_id, emptyPage(page_id));
      return structuredClone(manifest);
    }
    throw new Error(`Unexpected command: ${command}`);
  });
});

afterEach(() => vi.restoreAllMocks());

async function ready() {
  const hook = renderHook(() => useInkDocument(documentId));
  await waitFor(() => expect(hook.result.current.status).toBe('ready'));
  return hook;
}

describe('useInkDocument deferred page saving', () => {
  it('keeps successive strokes in memory without CAS or IndexedDB writes until flush', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'first'));
      await result.current.savePage(editedPage('page-1', 'first', 'second'));
    });
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
    expect(result.current.saveStatus).toBe('pending');
    await act(async () => { await result.current.flush(); });
    expect(saves).toHaveLength(1);
    expect(saves[0].page.objects.map(({ id }) => id)).toEqual(['first', 'second']);
    expect(result.current.saveStatus).toBe('saved');
    expect(drafts.size).toBe(0);
  });
});


describe('useInkDocument multi-page sessions', () => {
  it('keeps each latest page in memory when navigating and saves pages serially on one flush', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'one'));
      await result.current.selectPage('page-2');
      await result.current.savePage(editedPage('page-2', 'two'));
      await result.current.selectPage('page-1');
      await result.current.savePage(editedPage('page-1', 'one', 'latest'));
      await result.current.selectPage('page-2');
    });
    expect(result.current.page).toEqual(editedPage('page-2', 'two'));
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_get_page')).toHaveLength(2);
    await act(async () => { await result.current.flush(); });
    expect(saves.map(({ page, expected_revision }) => [page.page_id, page.objects.map(({ id }) => id), expected_revision])).toEqual([
      ['page-1', ['one', 'latest'], 'rev-1'],
      ['page-2', ['two'], 'saved-1'],
    ]);
    expect(result.current.page?.page_id).toBe('page-2');
    expect(result.current.pageRef?.page_id).toBe('page-2');
    expect(result.current.saveStatus).toBe('saved');
    expect(drafts.size).toBe(0);
  });

  it('rebases dirty pages after rename and append without saving their strokes', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'one'));
      await result.current.rename('Renamed');
      await result.current.appendPage(200, 160, 'blank');
      await result.current.savePage(editedPage('page-3', 'three'));
      await result.current.selectPage('page-1');
    });
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
    expect(result.current.page).toEqual(editedPage('page-1', 'one'));
    expect(result.current.manifest?.title).toBe('Renamed');
    await act(async () => { await result.current.flush(); });
    expect(saves.map(({ page, expected_revision }) => [page.page_id, expected_revision])).toEqual([
      ['page-1', 'appended'], ['page-3', 'saved-1'],
    ]);
  });

  it('deduplicates background recovery writes and restores dirty pages that are not selected', async () => {
    const first = await ready();
    await act(async () => {
      await first.result.current.savePage(editedPage('page-1', 'one'));
      await first.result.current.selectPage('page-2');
      await first.result.current.savePage(editedPage('page-2', 'two'));
      await Promise.all([first.result.current.persistDraft(), first.result.current.persistDraft()]);
    });
    expect(inkDraftJournal.persist).toHaveBeenCalledTimes(2);
    expect(saves).toHaveLength(0);
    expect(first.result.current.saveStatus).toBe('pending');
    first.unmount();
    await act(async () => undefined);
    const second = await ready();
    expect(second.result.current.page).toEqual(editedPage('page-1', 'one'));
    expect(second.result.current.saveStatus).toBe('pending');
    await act(async () => { await second.result.current.flush(); });
    expect(saves.map(({ page }) => page.page_id)).toEqual(['page-1', 'page-2']);
    expect(pages.get('page-2')).toEqual(editedPage('page-2', 'two'));
    expect(drafts.size).toBe(0);
  });

  it('does not apply a delayed page selection over a newer navigation', async () => {
    const { result } = await ready();
    const implementation = mocks.invoke.getMockImplementation()!;
    const gate = deferred();
    let waiting = false;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (command === 'vfs_ink_get_page' && payload.request.page_id === 'page-2') {
        waiting = true;
        await gate.promise;
      }
      return implementation(command, payload);
    });
    let older!: Promise<void>;
    act(() => { older = result.current.selectPage('page-2'); });
    await waitFor(() => expect(waiting).toBe(true));
    await act(async () => {
      await result.current.selectPage('page-1');
      gate.resolve();
      await older;
    });
    expect(result.current.page?.page_id).toBe('page-1');
    expect(saves).toHaveLength(0);
  });
});

describe('useInkDocument flush races and recovery', () => {
  it('keeps new input and page selection while an older page CAS finishes', async () => {
    const { result } = await ready();
    await act(async () => { await result.current.savePage(editedPage('page-1', 'first')); });
    saveGate = deferred();
    let pending!: Promise<void>;
    act(() => { pending = result.current.flush(); });
    await waitFor(() => expect(saves).toHaveLength(1));
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'first', 'new'));
      await result.current.selectPage('page-2');
      await result.current.savePage(editedPage('page-2', 'second-page'));
    });
    expect(result.current.page?.page_id).toBe('page-2');
    await act(async () => { saveGate?.resolve(); await pending; });
    expect(saves.map(({ page, expected_revision }) => [page.page_id, page.objects.map(({ id }) => id), expected_revision])).toEqual([
      ['page-1', ['first'], 'rev-1'],
      ['page-1', ['first', 'new'], 'saved-1'],
      ['page-2', ['second-page'], 'saved-2'],
    ]);
    expect(result.current.page).toEqual(editedPage('page-2', 'second-page'));
    expect(result.current.pageRef?.page_id).toBe('page-2');
    expect(result.current.saveStatus).toBe('saved');
  });

  it('journals the latest input before CAS when input changes during the journal write', async () => {
    const { result } = await ready();
    await act(async () => { await result.current.savePage(editedPage('page-1', 'before')); });
    const gate = deferred();
    vi.mocked(inkDraftJournal.persist).mockImplementationOnce(async (record) => {
      await gate.promise;
      drafts.set(record.page_id, structuredClone(record));
    });
    let pending!: Promise<void>;
    act(() => { pending = result.current.flush(); });
    await waitFor(() => expect(inkDraftJournal.persist).toHaveBeenCalledOnce());
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'before', 'during-journal'));
      gate.resolve();
      await pending;
    });
    expect(saves).toHaveLength(1);
    expect(saves[0].page).toEqual(editedPage('page-1', 'before', 'during-journal'));
    expect(result.current.saveStatus).toBe('saved');
  });

  it('stops a multi-page flush on conflict and preserves every unsaved page for recovery', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'local-one'));
      await result.current.selectPage('page-2');
      await result.current.savePage(editedPage('page-2', 'local-two'));
    });
    saveError = { code: 'REVISION_CONFLICT', message: 'Changed remotely', retryable: false };
    await act(async () => { await expect(result.current.flush()).rejects.toThrow(); });
    expect(saves).toHaveLength(1);
    expect(result.current.saveStatus).toBe('conflict');
    expect(result.current.page).toEqual(editedPage('page-2', 'local-two'));
    expect([...drafts.values()].map(({ save_state }) => save_state)).toEqual(['conflict', 'conflict']);
    await act(async () => { await result.current.retrySave(); });
    expect(saves).toHaveLength(1);
    await act(async () => { await result.current.reloadRemote(); });
    expect(result.current.saveStatus).toBe('saved');
    expect(result.current.page?.objects).toEqual([]);
    expect(result.current.remoteReloadSequence).toBe(1);
    expect(drafts.size).toBe(0);
  });

  it('retries a failed CAS with its operation id and flushes remaining pages', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'one'));
      await result.current.selectPage('page-2');
      await result.current.savePage(editedPage('page-2', 'two'));
    });
    saveError = new Error('Native unavailable');
    await act(async () => { await expect(result.current.flush()).rejects.toThrow(); });
    expect(result.current.saveStatus).toBe('offline');
    expect(drafts.size).toBe(2);
    const failedOperation = saves[0].operation_id;
    saveError = undefined;
    await act(async () => { await result.current.retrySave(); });
    expect(saves[1].operation_id).toBe(failedOperation);
    expect(saves[1].expected_revision).toBe('rev-1');
    expect(saves[2].expected_revision).toBe('saved-2');
    expect(result.current.saveStatus).toBe('saved');
    expect(drafts.size).toBe(0);
  });

  it('blocks CAS after draft storage fails and recovers the latest memory snapshot on retry', async () => {
    const { result } = await ready();
    await act(async () => { await result.current.savePage(editedPage('page-1', 'one')); });
    vi.mocked(inkDraftJournal.persist).mockRejectedValueOnce(new Error('Quota exceeded'));
    await act(async () => { await expect(result.current.persistDraft()).rejects.toThrow('Quota exceeded'); });
    expect(result.current.saveStatus).toBe('storage-error');
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'one', 'latest'));
      await expect(result.current.flush()).rejects.toThrow();
    });
    expect(saves).toHaveLength(0);
    await act(async () => { await result.current.retryDraftStorage(); });
    expect(saves).toHaveLength(1);
    expect(saves[0].page.objects.map(({ id }) => id)).toEqual(['one', 'latest']);
    expect(result.current.saveStatus).toBe('saved');
  });

  it('marks an unselected dirty page conflicting after a remote change without replacing the selected page', async () => {
    const { result } = await ready();
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'local'));
      await result.current.selectPage('page-2');
    });
    manifest = { ...manifest, revision: 'remote-2' };
    await act(async () => { await mocks.listener?.({ payload: { document_id: documentId, revision: 'remote-2', operation_id: 'external' } }); });
    expect(result.current.page?.page_id).toBe('page-2');
    expect(result.current.saveStatus).toBe('conflict');
    expect(result.current.manifest?.revision).toBe('rev-1');
    expect(drafts.get('page-1')?.page).toEqual(editedPage('page-1', 'local'));
    expect(drafts.get('page-1')?.save_state).toBe('conflict');
    expect(saves).toHaveLength(0);
  });

  it('does not overwrite input made while a clean remote refetch is pending', async () => {
    const { result } = await ready();
    const implementation = mocks.invoke.getMockImplementation()!;
    const gate = deferred();
    let waiting = false;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (command === 'vfs_ink_get') { waiting = true; await gate.promise; }
      return implementation(command, payload);
    });
    manifest = { ...manifest, revision: 'remote-2' };
    let pending: unknown;
    act(() => { pending = mocks.listener?.({ payload: { document_id: documentId, revision: 'remote-2', operation_id: 'external' } }); });
    await waitFor(() => expect(waiting).toBe(true));
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'new-input'));
      gate.resolve();
      await pending;
    });
    expect(result.current.page).toEqual(editedPage('page-1', 'new-input'));
    expect(result.current.saveStatus).toBe('conflict');
    expect(result.current.remoteReloadSequence).toBe(0);
  });

  it('does not let a previous document save update a replacement document', async () => {
    const { result, rerender } = renderHook(({ id }) => useInkDocument(id), { initialProps: { id: documentId } });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await act(async () => { await result.current.savePage(editedPage('page-1', 'old-document')); });
    saveGate = deferred();
    let pending!: Promise<void>;
    act(() => { pending = result.current.flush(); });
    await waitFor(() => expect(saves).toHaveLength(1));
    rerender({ id: 'replacement-document' });
    await waitFor(() => expect(result.current.manifest?.document_id).toBe('replacement-document'));
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'replacement-input'));
      saveGate?.resolve();
      await pending;
    });
    expect(result.current.manifest?.document_id).toBe('replacement-document');
    expect(result.current.page).toEqual(editedPage('page-1', 'replacement-input'));
    expect(result.current.saveStatus).toBe('pending');
    expect(saves.every(({ document_id }) => document_id === documentId)).toBe(true);
  });
});


describe('useInkDocument recovery edge cases', () => {
  it('keeps an older-revision unselected draft conflicting instead of silently rebasing it', async () => {
    drafts.set('page-2', {
      document_id: documentId, page_id: 'page-2', base_revision: 'old-revision', sequence: 100,
      page: editedPage('page-2', 'recovered'), updated_at: 1,
    });
    const { result } = await ready();
    expect(result.current.page?.page_id).toBe('page-1');
    expect(result.current.saveStatus).toBe('conflict');
    await act(async () => { await expect(result.current.flush()).rejects.toThrow(); });
    expect(saves).toHaveLength(0);
    expect(drafts.get('page-2')?.base_revision).toBe('old-revision');
    await act(async () => { await result.current.selectPage('page-2'); });
    expect(result.current.page).toEqual(editedPage('page-2', 'recovered'));
    await act(async () => { await result.current.savePage(editedPage('page-2', 'recovered', 'new')); });
    await act(async () => { await result.current.persistDraft(); });
    expect(drafts.get('page-2')?.sequence).toBeGreaterThan(100);
  });

  it('recovery-writes remaining pages with the returned revision after a partially successful flush', async () => {
    const { result, unmount } = await ready();
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'one'));
      await result.current.selectPage('page-2');
      await result.current.savePage(editedPage('page-2', 'two'));
    });
    const implementation = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (command === 'vfs_ink_save_page' && payload.request.page.page_id === 'page-2') throw new Error('Second page unavailable');
      return implementation(command, payload);
    });
    await act(async () => { await expect(result.current.flush()).rejects.toThrow(); });
    expect(drafts.has('page-1')).toBe(false);
    expect(drafts.get('page-2')?.base_revision).toBe('saved-1');
    expect(drafts.get('page-2')?.save_state).toBe('offline');
    unmount();
    await act(async () => undefined);
    const recovered = await ready();
    expect(recovered.result.current.saveStatus).toBe('offline');
    mocks.invoke.mockImplementation(implementation);
    await act(async () => { await recovered.result.current.retrySave(); });
    expect(saves[1].page.page_id).toBe('page-2');
    expect(saves[1].expected_revision).toBe('saved-1');
    expect(recovered.result.current.saveStatus).toBe('saved');
  });

  it('preserves a newer draft while a saved sequence is being discarded', async () => {
    const { result } = await ready();
    await act(async () => { await result.current.savePage(editedPage('page-1', 'first')); });
    const gate = deferred();
    let entered = false;
    vi.mocked(inkDraftJournal.discard).mockImplementationOnce(async ({ page_id }, sequence) => {
      entered = true;
      await gate.promise;
      if ((drafts.get(page_id)?.sequence ?? Infinity) <= sequence) drafts.delete(page_id);
    });
    let pending!: Promise<void>;
    act(() => { pending = result.current.flush(); });
    await waitFor(() => expect(entered).toBe(true));
    let recovery!: Promise<InkDraftRecord | undefined>;
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'first', 'newer'));
      recovery = result.current.persistDraft();
      gate.resolve();
      await recovery;
      await pending;
    });
    expect(saves).toHaveLength(2);
    expect(saves[1].page).toEqual(editedPage('page-1', 'first', 'newer'));
    expect(result.current.saveStatus).toBe('saved');
    expect(drafts.size).toBe(0);
  });

  it('ignores its own in-flight save event and keeps the document epoch unchanged', async () => {
    const { result } = await ready();
    await act(async () => { await result.current.savePage(editedPage('page-1', 'one')); });
    const implementation = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (command === 'vfs_ink_save_page') await mocks.listener?.({ payload: { document_id: documentId, revision: 'saved-1', operation_id: payload.request.operation_id } });
      return implementation(command, payload);
    });
    const reads = mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_get').length;
    await act(async () => { await result.current.flush(); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'vfs_ink_get')).toHaveLength(reads);
    expect(result.current.remoteReloadSequence).toBe(0);
    expect(result.current.saveStatus).toBe('saved');
  });
});


describe('useInkDocument navigation and revision guards', () => {
  it('does not replace page data when a clean remote refresh overtakes navigation', async () => {
    const { result } = await ready();
    await act(async () => { await result.current.selectPage('page-2'); });
    const implementation = mocks.invoke.getMockImplementation()!;
    const gate = deferred();
    let waiting = false;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (command === 'vfs_ink_get_page' && payload.request.page_id === 'page-2') { waiting = true; await gate.promise; }
      return implementation(command, payload);
    });
    manifest = { ...manifest, revision: 'remote-2' };
    pages.set('page-1', editedPage('page-1', 'remote-one'));
    pages.set('page-2', editedPage('page-2', 'remote-two'));
    let pending: unknown;
    act(() => { pending = mocks.listener?.({ payload: { document_id: documentId, revision: 'remote-2', operation_id: 'external' } }); });
    await waitFor(() => expect(waiting).toBe(true));
    await act(async () => {
      await result.current.selectPage('page-1');
      gate.resolve();
      await pending;
    });
    expect(result.current.page).toEqual(editedPage('page-1', 'remote-one'));
    expect(result.current.pageRef?.page_id).toBe('page-1');
    expect(result.current.manifest?.revision).toBe('remote-2');
    expect(result.current.remoteReloadSequence).toBe(1);
    expect(result.current.saveStatus).toBe('saved');
  });

  it('refuses a stale guarded paste without changing memory or writing a draft', async () => {
    const { result } = await ready();
    await act(async () => { await result.current.rename('New revision'); });
    const before = result.current.page;
    await act(async () => { await expect(result.current.savePage(editedPage('page-1', 'stale-paste'), 'rev-1')).rejects.toThrow(/revision changed/); });
    expect(result.current.page).toBe(before);
    expect(result.current.saveStatus).toBe('saved');
    expect(saves).toHaveLength(0);
    expect(inkDraftJournal.persist).not.toHaveBeenCalled();
  });

  it('honors a requested initial page but keeps the newly selected page on reload', async () => {
    const { result } = renderHook(() => useInkDocument(documentId, 'page-2'));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.page?.page_id).toBe('page-2');
    await act(async () => {
      await result.current.selectPage('page-1');
      await result.current.reloadRemote();
    });
    expect(result.current.page?.page_id).toBe('page-1');
  });

  it('keeps an unfinished new gesture dirty if it starts during CAS', async () => {
    const { result } = await ready();
    await act(async () => { await result.current.savePage(editedPage('page-1', 'one')); });
    saveGate = deferred();
    let pending!: Promise<void>;
    act(() => { pending = result.current.flush(); });
    await waitFor(() => expect(saves).toHaveLength(1));
    await act(async () => {
      result.current.setActiveStroke(true);
      saveGate?.resolve();
      await expect(pending).rejects.toThrow(/unfinished gesture/);
    });
    expect(saves).toHaveLength(1);
    await act(async () => {
      result.current.setActiveStroke(false);
      await result.current.savePage(editedPage('page-1', 'one', 'two'));
      await result.current.flush();
    });
    expect(saves[1].expected_revision).toBe('saved-1');
    expect(saves[1].page).toEqual(editedPage('page-1', 'one', 'two'));
  });
});


describe('useInkDocument advisory event races', () => {
  it('does not roll back a newly saved revision with a stale manifest read from an earlier event', async () => {
    const { result } = await ready();
    await act(async () => { await result.current.savePage(editedPage('page-1', 'latest')); });
    const implementation = mocks.invoke.getMockImplementation()!;
    const gate = deferred();
    const oldManifest = structuredClone(manifest);
    let waiting = false;
    mocks.invoke.mockImplementation(async (command, payload) => {
      if (command === 'vfs_ink_get') { waiting = true; await gate.promise; return oldManifest; }
      return implementation(command, payload);
    });
    let event: unknown;
    act(() => { event = mocks.listener?.({ payload: { document_id: documentId, revision: 'advisory', operation_id: 'other' } }); });
    await waitFor(() => expect(waiting).toBe(true));
    await act(async () => { await result.current.flush(); });
    await act(async () => { gate.resolve(); await event; });
    expect(result.current.manifest?.revision).toBe('saved-1');
    expect(result.current.page).toEqual(editedPage('page-1', 'latest'));
    expect(result.current.saveStatus).toBe('saved');
    expect(result.current.remoteReloadSequence).toBe(0);
  });
});


describe('useInkDocument explicit reload races', () => {
  it.each(['get', 'getPage', 'discard'])('keeps a stroke committed while reload awaits %s instead of marking the remote page saved', async (stage) => {
    const { result } = await ready();
    await act(async () => { await result.current.savePage(editedPage('page-1', 'before-reload')); });
    saveError = { code: 'REVISION_CONFLICT', message: 'Changed remotely', retryable: false };
    await act(async () => { await expect(result.current.flush()).rejects.toThrow(); });
    expect(result.current.saveStatus).toBe('conflict');
    manifest = { ...manifest, revision: 'remote-2' };
    pages.set('page-1', editedPage('page-1', 'remote'));
    const implementation = mocks.invoke.getMockImplementation()!;
    const gate = deferred();
    let waiting = false;
    mocks.invoke.mockImplementation(async (command, payload) => {
      const remote = await implementation(command, payload);
      if ((stage === 'get' && command === 'vfs_ink_get') || (stage === 'getPage' && command === 'vfs_ink_get_page')) {
        waiting = true;
        await gate.promise;
      }
      return remote;
    });
    if (stage === 'discard') {
      vi.mocked(inkDraftJournal.discard).mockImplementationOnce(async ({ page_id }, sequence) => {
        waiting = true;
        await gate.promise;
        if ((drafts.get(page_id)?.sequence ?? Infinity) <= sequence) drafts.delete(page_id);
      });
    }
    let reload!: Promise<void>;
    act(() => { reload = result.current.reloadRemote(); });
    await waitFor(() => expect(waiting).toBe(true));
    await act(async () => {
      await result.current.savePage(editedPage('page-1', 'before-reload', 'during-reload'));
      gate.resolve();
      await expect(reload).rejects.toThrow(/changed.*reload/i);
    });
    expect(result.current.page).toEqual(editedPage('page-1', 'before-reload', 'during-reload'));
    expect(result.current.saveStatus).toBe('conflict');
    expect(result.current.remoteReloadSequence).toBe(0);
    expect(drafts.get('page-1')?.page).toEqual(result.current.page);
    expect(drafts.get('page-1')?.save_state).toBe('conflict');
    mocks.invoke.mockImplementation(implementation);
    await act(async () => { await result.current.reloadRemote(); });
    expect(result.current.page).toEqual(editedPage('page-1', 'remote'));
    expect(result.current.saveStatus).toBe('saved');
    expect(result.current.remoteReloadSequence).toBe(1);
    expect(drafts.size).toBe(0);
  });
});
