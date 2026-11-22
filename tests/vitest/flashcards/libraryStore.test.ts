import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnkiLibraryCard } from '@/types';

const mocks = vi.hoisted(() => ({
  deleteCard: vi.fn(),
  enqueueCard: vi.fn(),
  listCards: vi.fn(),
  requestRefresh: vi.fn(),
  resetProgress: vi.fn(),
  suspendCard: vi.fn(),
  undoLastReview: vi.fn(),
  unsuspendCard: vi.fn(),
  updateCard: vi.fn(),
  pickSingleFile: vi.fn(),
  readTextFile: vi.fn(),
  saveAnkiCards: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('@/utils/chatApi', () => ({
  deleteAnkiCard: mocks.deleteCard,
  enqueueAnkiLibraryCard: mocks.enqueueCard,
  listAnkiLibraryCards: mocks.listCards,
  resetFsrsCardProgress: mocks.resetProgress,
  suspendFsrsCard: mocks.suspendCard,
  undoFsrsLastReview: mocks.undoLastReview,
  unsuspendFsrsCard: mocks.unsuspendCard,
  updateAnkiLibraryCard: mocks.updateCard,
}));

vi.mock('@/features/flashcards/events', () => ({
  requestFlashcardsDueRefresh: mocks.requestRefresh,
}));

vi.mock('@/utils/fileManager', () => ({
  isVirtualUri: () => false,
  extractFileName: (path: string) => path.split('/').pop() ?? '',
  fileManager: {
    pickSingleFile: mocks.pickSingleFile,
    readTextFile: mocks.readTextFile,
  },
}));

vi.mock('@/services/ankiApiAdapter', () => ({
  ankiApiAdapter: {
    saveAnkiCards: mocks.saveAnkiCards,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: mocks.invoke,
}));

import { useFlashcardsLibraryStore } from '@/features/flashcards/store/libraryStore';

function card(overrides: Partial<AnkiLibraryCard> = {}): AnkiLibraryCard {
  return {
    id: 'card-1',
    task_id: 'task-1',
    front: 'Front',
    back: 'Back',
    tags: [],
    images: [],
    created_at: '2026-07-14T00:00:00Z',
    updated_at: 'version-1',
    version: 'version-1',
    stateId: 'state-1',
    reviewVersion: 4,
    enqueued: true,
    suspended: false,
    isDue: true,
    latestReview: { logId: 'log-1', undoable: true },
    ...overrides,
  };
}

describe('flashcards library store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFlashcardsLibraryStore.getState().reset();
    mocks.listCards.mockResolvedValue({ items: [card()], total: 1, page: 1, pageSize: 20 });
    mocks.updateCard.mockResolvedValue(undefined);
    mocks.undoLastReview.mockResolvedValue({ changed: true });
  });

  it('keeps query/page/items in one observable state and ignores stale loads', async () => {
    let resolveOld!: (value: unknown) => void;
    const oldResponse = new Promise((resolve) => { resolveOld = resolve; });
    mocks.listCards
      .mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce({ items: [card({ id: 'latest' })], total: 1, page: 1, pageSize: 20 });

    const oldLoad = useFlashcardsLibraryStore.getState().load('', 1);
    const latestLoad = useFlashcardsLibraryStore.getState().submitSearch(' latest ');
    await latestLoad;
    resolveOld({ items: [card({ id: 'stale' })], total: 1, page: 1, pageSize: 20 });
    await oldLoad;

    expect(useFlashcardsLibraryStore.getState()).toMatchObject({
      query: 'latest',
      page: 1,
      items: [expect.objectContaining({ id: 'latest' })],
      loading: false,
    });
  });

  it('edits and undoes from the same observed card before refreshing', async () => {
    useFlashcardsLibraryStore.setState({ items: [card()], total: 1, loaded: true });

    expect(await useFlashcardsLibraryStore.getState().updateCard('card-1', { front: 'Changed' })).toBe(true);
    expect(mocks.updateCard).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'card-1', version: 'version-1' }),
      { front: 'Changed' },
    );

    expect(await useFlashcardsLibraryStore.getState().undoLastReview('card-1')).toBe(true);
    expect(mocks.undoLastReview).toHaveBeenCalledWith('state-1', 'log-1');
    expect(mocks.requestRefresh).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a card is no longer present on the observed page', async () => {
    expect(await useFlashcardsLibraryStore.getState().deleteCard('missing')).toBe(false);
    expect(mocks.deleteCard).not.toHaveBeenCalled();
    expect(useFlashcardsLibraryStore.getState().actionError).toBeTruthy();
  });

  it('状态筛选 / 排序交给服务端：切换后回到第 1 页带参数重拉，计数取服务端全集', async () => {
    const statusCounts = { all: 471, due: 29, new: 436, learning: 6, review: 3, suspended: 2, notEnqueued: 0 };
    mocks.listCards.mockResolvedValue({ items: [card()], total: 2, page: 1, pageSize: 20, statusCounts });
    await useFlashcardsLibraryStore.getState().load('', 3);
    mocks.listCards.mockClear();

    useFlashcardsLibraryStore.getState().setStatusFilter('suspended');
    await vi.waitFor(() => expect(mocks.listCards).toHaveBeenCalledTimes(1));
    expect(mocks.listCards).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      status: 'suspended',
      sort: undefined,
    }));

    useFlashcardsLibraryStore.getState().toggleSort('due');
    await vi.waitFor(() => expect(mocks.listCards).toHaveBeenCalledTimes(2));
    expect(mocks.listCards).toHaveBeenLastCalledWith(expect.objectContaining({
      page: 1,
      status: 'suspended',
      sort: 'due',
      sort_desc: false,
    }));
    await vi.waitFor(() => expect(useFlashcardsLibraryStore.getState().loading).toBe(false));
    expect(useFlashcardsLibraryStore.getState().statusCounts).toEqual(statusCounts);

    // 同一筛选重复点击不重拉
    useFlashcardsLibraryStore.getState().setStatusFilter('suspended');
    expect(mocks.listCards).toHaveBeenCalledTimes(2);
  });

  it('牌组筛选交给服务端并随列表取回牌组计数；清除筛选回到全部牌组', async () => {
    const decks = [{ name: '数学::极限', all: 3, due: 1, new: 1, notEnqueued: 1 }];
    mocks.listCards.mockResolvedValue({ items: [card()], total: 1, page: 1, pageSize: 20, decks });
    await useFlashcardsLibraryStore.getState().load('', 2);
    expect(mocks.listCards).toHaveBeenLastCalledWith(expect.objectContaining({
      deck: undefined,
      include_decks: true,
    }));
    expect(useFlashcardsLibraryStore.getState().decks).toEqual(decks);

    useFlashcardsLibraryStore.getState().setDeckFilter('');
    await vi.waitFor(() => expect(mocks.listCards).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, deck: '' }),
    ));

    await useFlashcardsLibraryStore.getState().clearFilters();
    expect(useFlashcardsLibraryStore.getState().deckFilter).toBeNull();
    expect(mocks.listCards).toHaveBeenLastCalledWith(expect.objectContaining({ deck: undefined }));
  });

  it('imports CSV/TSV cards grouped by deck/type, enqueues FSRS states, and refreshes due queue', async () => {
    mocks.pickSingleFile.mockResolvedValue('/tmp/cards.csv');
    mocks.readTextFile.mockResolvedValue([
      '\uFEFFFront,Back,Tags,Deck,Type',
      '"Q1, line 1\nline 2","Answer 1",bio exam,Bio::Cell,Basic',
      '"{{c1::ATP}} is energy currency",Metabolism,bio,Bio::Cell,Cloze',
      '"InvalidEmptyBasic",,,,Basic',
    ].join('\r\n'));
    mocks.saveAnkiCards
      .mockResolvedValueOnce({ savedIds: ['saved-basic'], taskId: 't-basic' })
      .mockResolvedValueOnce({ savedIds: ['saved-cloze'], taskId: 't-cloze' });
    mocks.invoke.mockResolvedValue({ states: [{ id: 's-1' }, { id: 's-2' }] });

    const outcome = await useFlashcardsLibraryStore.getState().importCsv();

    expect(outcome).toEqual({
      status: 'imported',
      importedCards: 2,
      reviewEnqueued: 2,
      skippedRows: 1,
    });
    expect(mocks.saveAnkiCards).toHaveBeenCalledTimes(2);
    expect(mocks.saveAnkiCards).toHaveBeenNthCalledWith(1, {
      cards: [{
        front: 'Q1, line 1\nline 2',
        back: 'Answer 1',
        tags: ['bio', 'exam'],
        images: [],
      }],
      options: {
        deck_name: 'Bio::Cell',
        note_type: 'Basic',
        enable_images: false,
        max_cards_per_source: 1,
        max_cards_per_mistake: 1,
      },
    });
    expect(mocks.saveAnkiCards).toHaveBeenNthCalledWith(2, {
      cards: [{
        front: '{{c1::ATP}} is energy currency',
        back: 'Metabolism',
        text: '{{c1::ATP}} is energy currency',
        extra_fields: {
          Text: '{{c1::ATP}} is energy currency',
          Extra: 'Metabolism',
        },
        tags: ['bio'],
        images: [],
      }],
      options: {
        deck_name: 'Bio::Cell',
        note_type: 'Cloze',
        enable_images: false,
        max_cards_per_source: 1,
        max_cards_per_mistake: 1,
      },
    });
    expect(mocks.invoke).toHaveBeenCalledWith('fsrs_enqueue_cards', {
      ankiCardIds: ['saved-basic', 'saved-cloze'],
    });
    expect(mocks.requestRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.listCards).toHaveBeenCalledTimes(1);

    mocks.pickSingleFile.mockResolvedValueOnce(null);
    expect(await useFlashcardsLibraryStore.getState().importCsv()).toEqual({ status: 'canceled' });
  });
});
