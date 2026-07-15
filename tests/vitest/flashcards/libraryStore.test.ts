import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnkiLibraryCard } from '@/types';

const mocks = vi.hoisted(() => ({
  deleteCard: vi.fn(),
  enqueueCard: vi.fn(),
  listCards: vi.fn(),
  requestRefresh: vi.fn(),
  suspendCard: vi.fn(),
  undoLastReview: vi.fn(),
  unsuspendCard: vi.fn(),
  updateCard: vi.fn(),
}));

vi.mock('@/utils/chatApi', () => ({
  deleteAnkiCard: mocks.deleteCard,
  enqueueAnkiLibraryCard: mocks.enqueueCard,
  listAnkiLibraryCards: mocks.listCards,
  suspendFsrsCard: mocks.suspendCard,
  undoFsrsLastReview: mocks.undoLastReview,
  unsuspendFsrsCard: mocks.unsuspendCard,
  updateAnkiLibraryCard: mocks.updateCard,
}));

vi.mock('@/features/flashcards/events', () => ({
  requestFlashcardsDueRefresh: mocks.requestRefresh,
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
});
