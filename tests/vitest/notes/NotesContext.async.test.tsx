import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotesProvider, useNotes } from '@/features/notes/NotesContext';
import type { DstuNode } from '@/dstu/types';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  getContent: vi.fn(),
  update: vi.fn(),
  setMetadata: vi.fn(),
  deleteMany: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  t: (key: string) => key,
  folders: {
    folders: {}, rootChildren: [], references: {},
    loadFolders: vi.fn(async () => undefined),
    addToStructure: vi.fn(), removeFromStructure: vi.fn(),
  },
  validation: { validationCache: new Map(), validatingIds: new Set() },
}));

vi.mock('@/dstu', () => ({ dstu: mocks, pathUtils: {} }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, convertFileSrc: (path: string) => path }));
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: vi.fn() }));
vi.mock('@/stores/systemStatusStore', () => ({
  useSystemStatusStore: { getState: () => ({ maintenanceMode: false }) },
}));
vi.mock('@/features/notes/hooks/useFolderStorage', () => ({ useFolderStorage: () => mocks.folders }));
vi.mock('@/features/notes/hooks/useReferenceValidation', () => ({ useReferenceValidation: () => mocks.validation }));
vi.mock('@/features/chat/core/session/sessionManager', () => ({ sessionManager: {} }));
vi.mock('@/features/chat/pages/ensureActiveChatSession', () => ({ ensureActiveChatSession: vi.fn() }));
vi.mock('@/features/chat/context/definitions/note', () => ({ NOTE_TYPE_ID: 'note' }));
vi.mock('@/features/chat/context/definitions/textbook', () => ({ TEXTBOOK_TYPE_ID: 'textbook' }));
vi.mock('@/features/chat/context/definitions/exam', () => ({ EXAM_TYPE_ID: 'exam' }));
vi.mock('@/services/resourceSyncService', () => ({ createResource: vi.fn() }));
vi.mock('@/debug-panel/debugMasterSwitch', () => ({
  debugLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/dstu/adapters/notesDstuAdapter', () => ({
  dstuNodeToNoteItem: (node: DstuNode) => ({
    id: node.id, title: node.name, content_md: '', tags: [],
    is_favorite: false, created_at: '', updated_at: String(node.updatedAt),
  }),
}));

const ok = <T,>(value: T) => ({ ok: true as const, value });
const node = (id: string): DstuNode => ({
  id, sourceId: id, path: `/${id}`, name: id, type: 'note',
  createdAt: 0, updatedAt: 1, previewType: 'markdown',
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function mountNotes() {
  const hook = renderHook(() => useNotes(), {
    wrapper: ({ children }) => <NotesProvider>{children}</NotesProvider>,
  });
  await waitFor(() => expect(hook.result.current.notes).toHaveLength(2));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() => hook.result.current.openTab('a'));
  await waitFor(() => expect(hook.result.current.loadedContentIds.has('a')).toBe(true));
  return hook;
}

describe('NotesContext asynchronous ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockResolvedValue(ok([node('a'), node('b')]));
    mocks.get.mockImplementation(async (path: string) => ok(node(path.slice(1))));
    mocks.getContent.mockResolvedValue(ok('original'));
    mocks.update.mockImplementation(async (path: string) => ok(node(path.slice(1))));
    mocks.setMetadata.mockResolvedValue(ok(node('a')));
    mocks.deleteMany.mockResolvedValue(ok({}));
    mocks.invoke.mockImplementation(async (command: string) => command === 'notes_list_assets' ? [] : null);
    mocks.listen.mockResolvedValue(() => undefined);
  });

  it('does not reactivate a note when its refresh completes after switching tabs', async () => {
    const { result } = await mountNotes();
    const response = deferred<ReturnType<typeof ok<string>>>();
    mocks.getContent.mockImplementation(async (path: string) => path === '/a' ? response.promise : ok('B content'));
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.forceRefreshNoteContent('a'); });
    act(() => result.current.openTab('b'));
    await waitFor(() => expect(result.current.active?.content_md).toBe('B content'));
    await act(async () => { response.resolve(ok('A refreshed')); await refresh; });
    expect(result.current.active?.id).toBe('b');
    expect(result.current.notes.find(note => note.id === 'a')?.content_md).toBe('A refreshed');
  });

  it('keeps the newest forced refresh when responses arrive in reverse order', async () => {
    const { result } = await mountNotes();
    const first = deferred<ReturnType<typeof ok<string>>>();
    const second = deferred<ReturnType<typeof ok<string>>>();
    mocks.getContent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let firstRefresh!: Promise<void>;
    let secondRefresh!: Promise<void>;
    act(() => {
      firstRefresh = result.current.forceRefreshNoteContent('a');
      secondRefresh = result.current.forceRefreshNoteContent('a');
    });
    await act(async () => { second.resolve(ok('newest')); await secondRefresh; });
    await act(async () => { first.resolve(ok('outdated')); await firstRefresh; });
    expect(result.current.active?.content_md).toBe('newest');
  });

  it('serializes saves for the same note, including asynchronous asset normalization', async () => {
    const { result } = await mountNotes();
    const first = deferred<ReturnType<typeof ok<DstuNode>>>();
    mocks.update.mockReturnValueOnce(first.promise).mockResolvedValueOnce(ok(node('a')));
    let saves!: Promise<void[]>;
    act(() => {
      saves = Promise.all([
        result.current.saveNoteContent('a', 'first'),
        result.current.saveNoteContent('a', 'latest'),
      ]);
    });
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1));
    expect(mocks.update).toHaveBeenNthCalledWith(1, '/a', 'first', 'note');
    await act(async () => { first.resolve(ok(node('a'))); await saves; });
    expect(mocks.update).toHaveBeenNthCalledWith(2, '/a', 'latest', 'note');
    expect(result.current.active?.content_md).toBe('latest');
  });

  it('does not let a read started before a save overwrite the saved content', async () => {
    const { result } = await mountNotes();
    const response = deferred<ReturnType<typeof ok<string>>>();
    mocks.getContent.mockReturnValueOnce(response.promise);
    let refresh!: Promise<void>;
    act(() => { refresh = result.current.forceRefreshNoteContent('a'); });
    await act(async () => { await result.current.saveNoteContent('a', 'saved'); });
    await act(async () => { response.resolve(ok('stale')); await refresh; });
    expect(result.current.active?.content_md).toBe('saved');
  });

  it('preserves loaded bodies and current tabs when refreshing the metadata list', async () => {
    const { result } = await mountNotes();
    await act(async () => { await result.current.refreshNotes(); });
    expect(result.current.notes.find(note => note.id === 'a')?.content_md).toBe('original');
    expect(result.current.openTabs).toContain('a');
    expect(result.current.active?.id).toBe('a');
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'notes_get_pref')).toHaveLength(1);
  });

  it('disposes event registration that completes after unmount', async () => {
    const registration = deferred<() => void>();
    const dispose = vi.fn();
    mocks.listen.mockReturnValueOnce(registration.promise);
    const hook = renderHook(() => useNotes(), {
      wrapper: ({ children }) => <NotesProvider>{children}</NotesProvider>,
    });
    hook.unmount();
    await act(async () => { registration.resolve(dispose); });
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
