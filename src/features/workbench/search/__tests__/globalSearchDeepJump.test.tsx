import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { DstuNode } from '@/dstu/types';
import type { DependencyResolver } from '@/command-palette/registry/types';

const {
  invokeMock,
  dstuSearchMock,
  noteFocusSpy,
  noteEditorReadyCallbacks,
  requestChatSessionNavSpy,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dstuSearchMock: vi.fn(),
  noteFocusSpy: vi.fn(),
  noteEditorReadyCallbacks: new Map<string, Array<(api: { focus: () => void }) => void>>(),
  requestChatSessionNavSpy: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@/dstu/api', () => ({
  search: (...args: unknown[]) => dstuSearchMock(...args),
}));

vi.mock('../../agent/drivers/noteDriver', () => ({
  getNoteEditor: vi.fn(() => undefined),
  subscribeNoteEditorReady: vi.fn(
    (noteId: string, cb: (api: { focus: () => void }) => void) => {
      const list = noteEditorReadyCallbacks.get(noteId) ?? [];
      list.push(cb);
      noteEditorReadyCallbacks.set(noteId, list);
      return () => {
        const cur = noteEditorReadyCallbacks.get(noteId) ?? [];
        noteEditorReadyCallbacks.set(noteId, cur.filter((item) => item !== cb));
      };
    },
  ),
}));

vi.mock('@/features/chat/navigation/pendingChatNavigation', () => ({
  requestChatSessionNavigation: (...args: unknown[]) => requestChatSessionNavSpy(...args),
}));

vi.mock('../../apps/chat/newSession', () => ({
  openChatSession: vi.fn((sessionId: string, reason?: string) => {
    workbenchBus.launch({
      typeId: 'chat',
      instanceKey: sessionId,
      reason: reason ?? 'command',
    });
    return 'win-chat-deep-1';
  }),
  CHAT_APP_TYPE_ID: 'chat',
}));

import { workbenchBus } from '../../core/workbenchBus';
import {
  closeAppsPanel,
  isAppsPanelOpen,
  openAppsPanel,
} from '../../components/appsPanelStore';
import {
  GLOBAL_SEARCH_DEBOUNCE_MS,
  createChatProvider,
  createDstuProvider,
  fetchFlashcardSearchResults,
  formatDstuSearchSubtitle,
  openDstuInWorkbench,
  openFlashcardInWorkbench,
  type WorkbenchSearchHost,
} from '../globalSearchProviders';
import {
  openFileFromPalette,
  openFlashcardFromPalette,
  openSessionFromPalette,
  useResourceSearch,
} from '@/command-palette/hooks/useResourceSearch';
import { useFsrsReviewStore } from '@/features/flashcards/store/fsrsReviewStore';
import { useFlashcardsLibraryStore } from '@/features/flashcards/store/libraryStore';
import {
  peekPendingLibraryCardFocus,
  resetLibraryViewState,
} from '@/features/flashcards/library/libraryViewState';

function makeHost(overrides?: Partial<WorkbenchSearchHost>): WorkbenchSearchHost {
  return {
    listLaunchableApps: () => [],
    appName: (app) => app.typeId,
    searchCommands: () => [],
    openApp: vi.fn(),
    openCommand: vi.fn(),
    openDstu: vi.fn(),
    openChat: vi.fn(),
    ...overrides,
  };
}

function makeDeps(currentView: 'workbench' | 'chat-v2' = 'workbench'): DependencyResolver {
  return {
    navigate: vi.fn(),
    getCurrentView: () => currentView,
    showNotification: vi.fn(),
    t: (_key: string, fallback?: string) => fallback ?? _key,
  } as unknown as DependencyResolver;
}

describe('U06 Global Search (Cmd+K) deep-content jump precision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
    noteEditorReadyCallbacks.clear();
    closeAppsPanel();
    resetLibraryViewState();
    useFlashcardsLibraryStore.getState().reset();
    useFsrsReviewStore.setState({ screen: 'today' });

    dstuSearchMock.mockResolvedValue({
      ok: true,
      value: [
        {
          id: 'note-crispr-9',
          name: 'Molecular Biology Notes',
          type: 'note',
          path: '/Biology/Molecular Biology Notes.md',
          metadata: {
            snippet: '…<b>CRISPR-Cas9</b> introduces targeted double-strand breaks…',
            heading: 'CRISPR-Cas9 Mechanism',
          },
        } satisfies DstuNode,
      ],
    });

    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'list_anki_library_cards') {
        return {
          items: [
            {
              id: 'card-crispr-42',
              front: 'What enzyme guides {{c1::CRISPR-Cas9}} cleavage?',
              back: '<b>Cas9</b> endonuclease guided by sgRNA targeting PAM sequence',
              tags: ['biology', 'crispr'],
              created_at: '2026-01-01T00:00:00Z',
              enqueued: true,
              suspended: false,
              isDue: true,
              state: 2,
              reps: 2,
              lapses: 0,
              deckName: 'Biology::Genetics',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 5,
        };
      }
      if (cmd === 'chat_v2_search_content') {
        return [
          {
            sessionId: 'sess-crispr-7',
            sessionTitle: 'CRISPR Lab Review',
            messageId: 'msg-88',
            blockId: 'blk-1',
            role: 'assistant',
            snippet: 'Compare <mark>CRISPR</mark> off-target rates with prime editing',
            updatedAt: '2026-11-25T10:00:00Z',
          },
        ];
      }
      if (cmd === 'chat_v2_search_sessions') return [];
      return [];
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    closeAppsPanel();
    resetLibraryViewState();
  });

  it('returns deep flashcard hits, note body snippets, and chat content matches for scientific terms like CRISPR', async () => {
    const controller = new AbortController();
    const cards = await fetchFlashcardSearchResults('CRISPR', controller.signal);
    expect(cards).toEqual([
      {
        cardId: 'card-crispr-42',
        front: 'What enzyme guides CRISPR-Cas9 cleavage?',
        back: 'Cas9 endonuclease guided by sgRNA targeting PAM sequence',
        deck: 'Biology::Genetics',
        tags: ['biology', 'crispr'],
        snippet: 'Cas9 endonuclease guided by sgRNA targeting PAM sequence',
      },
    ]);

    const host = makeHost();
    const dstuProvider = createDstuProvider(host);
    const items = await dstuProvider.search('CRISPR', controller.signal);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      id: 'dstu:note-crispr-9',
      kind: 'dstu',
      title: 'Molecular Biology Notes',
      subtitle: '…CRISPR-Cas9 introduces targeted double-strand breaks… · /Biology/Molecular Biology Notes.md',
    });
    expect(items[1]).toMatchObject({
      id: 'dstu:flashcard:card-crispr-42',
      kind: 'dstu',
      title: 'What enzyme guides CRISPR-Cas9 cleavage?',
      subtitle: 'Biology::Genetics · Cas9 endonuclease guided by sgRNA targeting PAM sequence',
    });

    vi.useFakeTimers();
    const { result } = renderHook(() => useResourceSearch('CRISPR', true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GLOBAL_SEARCH_DEBOUNCE_MS);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.fileResults.map((n) => n.id)).toEqual(['note-crispr-9']);
    expect(result.current.flashcardResults.map((c) => c.cardId)).toEqual(['card-crispr-42']);
    expect(result.current.sessionResults[0]).toMatchObject({
      sessionId: 'sess-crispr-7',
      title: 'CRISPR Lab Review',
      snippet: 'Compare CRISPR off-target rates with prime editing',
      messageId: 'msg-88',
    });
  });

  it('opens a Flashcard search hit directly to Library screen focused on that card/deck/query (not blank Today landing)', async () => {
    const launchSpy = vi.spyOn(workbenchBus, 'launch').mockReturnValue('win-fc-1');
    const loadSpy = vi.spyOn(useFlashcardsLibraryStore.getState(), 'load').mockResolvedValue(undefined);

    openAppsPanel();
    expect(isAppsPanelOpen()).toBe(true);

    const provider = createDstuProvider(makeHost());
    const items = await provider.search('CRISPR', new AbortController().signal);
    const flashcardItem = items.find((item) => item.id === 'dstu:flashcard:card-crispr-42');
    expect(flashcardItem).toBeDefined();

    await flashcardItem!.open();

    expect(isAppsPanelOpen()).toBe(false);
    expect(useFsrsReviewStore.getState().screen).toBe('library');
    expect(useFlashcardsLibraryStore.getState().query).toBe('CRISPR');
    expect(useFlashcardsLibraryStore.getState().deckFilter).toBe('Biology::Genetics');
    expect(peekPendingLibraryCardFocus()).toEqual({
      cardId: 'card-crispr-42',
      query: 'CRISPR',
      deckFilter: 'Biology::Genetics',
    });
    expect(launchSpy).toHaveBeenCalledWith({
      typeId: 'flashcards',
      payload: {
        screen: 'library',
        cardId: 'card-crispr-42',
        query: 'CRISPR',
        deck: 'Biology::Genetics',
      },
      reason: 'command',
    });
    expect(loadSpy).toHaveBeenCalledWith('CRISPR', 1);

    // Classic palette mode navigates to flashcards with library card focus params
    useFsrsReviewStore.setState({ screen: 'today' });
    const classicDeps = makeDeps('chat-v2');
    await openFlashcardFromPalette(
      classicDeps,
      { cardId: 'card-crispr-42', front: 'What enzyme guides CRISPR-Cas9 cleavage?', deck: 'Biology::Genetics' },
      'CRISPR',
    );
    expect(useFsrsReviewStore.getState().screen).toBe('library');
    expect(classicDeps.navigate).toHaveBeenCalledWith('flashcards', {
      screen: 'library',
      cardId: 'card-crispr-42',
      query: 'CRISPR',
      deck: 'Biology::Genetics',
    });

    // Direct openFlashcardInWorkbench fallback when searchQuery is empty uses card front
    await openFlashcardInWorkbench({
      cardId: 'card-crispr-42',
      front: 'CRISPR Cas9',
      deck: 'Biology::Genetics',
    });
    expect(useFlashcardsLibraryStore.getState().query).toBe('CRISPR Cas9');
  });

  it('opens a Note result directly with heading anchor and lazy editor focus, and formats snippet subtitles cleanly', async () => {
    const launchSpy = vi.spyOn(workbenchBus, 'launch').mockReturnValue('win-note-9');
    const anchorSpy = vi.spyOn(workbenchBus, 'openNoteAnchor').mockResolvedValue(null);

    const noteNode: DstuNode = {
      id: 'note-crispr-9',
      name: 'Molecular Biology Notes',
      type: 'note',
      path: '/Biology/Molecular Biology Notes.md',
      metadata: {
        snippet: '…<b>CRISPR-Cas9</b> introduces targeted breaks…',
        heading: 'CRISPR-Cas9 Mechanism',
      },
    };

    expect(formatDstuSearchSubtitle(noteNode)).toBe(
      '…CRISPR-Cas9 introduces targeted breaks… · /Biology/Molecular Biology Notes.md',
    );
    expect(formatDstuSearchSubtitle({ ...noteNode, metadata: undefined })).toBe(
      '/Biology/Molecular Biology Notes.md',
    );

    const wbDeps = makeDeps('workbench');
    await openFileFromPalette(wbDeps, noteNode);

    expect(launchSpy).toHaveBeenCalledWith({
      typeId: 'note',
      instanceKey: 'note-crispr-9',
      reason: 'command',
    });
    expect(anchorSpy).toHaveBeenCalledWith({
      noteId: 'note-crispr-9',
      heading: 'CRISPR-Cas9 Mechanism',
      fallbackLaunch: false,
    });

    // Wait for lazy noteDriver import to register readiness callback, then simulate editor ready
    await waitFor(() => {
      expect(noteEditorReadyCallbacks.get('note-crispr-9')?.length ?? 0).toBeGreaterThan(0);
    });
    for (const cb of noteEditorReadyCallbacks.get('note-crispr-9') ?? []) {
      cb({ focus: noteFocusSpy });
    }
    expect(noteFocusSpy).toHaveBeenCalledTimes(1);

    // Also verifies direct openDstuInWorkbench preserves exact targetId when id falls back to sourceId
    openDstuInWorkbench({
      id: '',
      sourceId: 'note-fallback-source',
      name: 'Fallback Note',
      type: 'note',
      path: '/Fallback.md',
    } as DstuNode);
    expect(launchSpy).toHaveBeenCalledWith({
      typeId: 'note',
      instanceKey: 'note-fallback-source',
      reason: 'command',
    });
  });

  it('opens a Chat session result directly to that exact session in both Workbench and Classic modes', async () => {
    const launchSpy = vi.spyOn(workbenchBus, 'launch').mockReturnValue('win-chat-deep-1');
    const host = makeHost({
      openChat: (sessionId) => {
        openSessionFromPalette(makeDeps('workbench'), sessionId);
      },
    });
    const chatProvider = createChatProvider(host);
    const items = await chatProvider.search('CRISPR', new AbortController().signal);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('chat:sess-crispr-7');

    await items[0].open();
    expect(launchSpy).toHaveBeenCalledWith({
      typeId: 'chat',
      instanceKey: 'sess-crispr-7',
      reason: 'command',
    });

    const classicDeps = makeDeps('chat-v2');
    openSessionFromPalette(classicDeps, 'sess-crispr-7');
    expect(classicDeps.navigate).toHaveBeenCalledWith('chat-v2');
    await waitFor(() => {
      expect(requestChatSessionNavSpy).toHaveBeenCalledWith('sess-crispr-7');
    });
  });
});
