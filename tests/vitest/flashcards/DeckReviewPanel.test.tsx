import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listCards: vi.fn(),
  setScreen: vi.fn(),
  startBatchSession: vi.fn(async () => true),
  notify: vi.fn(),
  setDeckFilter: vi.fn(),
}));

vi.mock('@/utils/chatApi', () => ({ listAnkiLibraryCards: mocks.listCards }));
vi.mock('@/components/UnifiedNotification', () => ({ showGlobalNotification: mocks.notify }));
vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: { count?: number; name?: string }) => ({
      'today.decks.title': '按牌组复习',
      'today.decks.ungrouped': '未分组',
      'today.decks.due': `到期 ${options?.count}`,
      'today.decks.new': `新卡 ${options?.count}`,
      'today.decks.nothingDue': '今天没有到期',
      'today.decks.review': `复习 ${options?.count}`,
      'today.decks.reviewAria': `复习「${options?.name}」的 ${options?.count} 张到期卡`,
      'today.decks.learnNew': `学 ${options?.count} 张新卡`,
      'today.decks.learnNewAria': `学「${options?.name}」的 ${options?.count} 张新卡`,
      'today.decks.openLibrary': `在卡片库查看「${options?.name}」`,
      'today.decks.expand': `展开「${options?.name}」的子牌组`,
      'today.decks.collapse': `收起「${options?.name}」的子牌组`,
      'today.decks.empty': '这个牌组暂时没有可复习的卡',
    }[key] ?? key),
  }),
}));
vi.mock('@/features/flashcards/store/fsrsReviewStore', () => ({
  useFsrsReviewStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    startBatchSession: mocks.startBatchSession,
    setScreen: mocks.setScreen,
  }),
}));
vi.mock('@/features/flashcards/store/libraryStore', () => ({
  useFlashcardsLibraryStore: { getState: () => ({ setDeckFilter: mocks.setDeckFilter }) },
}));

import { DeckReviewPanel } from '@/features/flashcards/components/DeckReviewPanel';

const decks = [
  { name: '数学::极限', all: 5, due: 3, new: 1, notEnqueued: 0 },
  { name: '数学::导数', all: 2, due: 0, new: 2, notEnqueued: 0 },
  { name: '英语', all: 4, due: 0, new: 0, notEnqueued: 4 },
];

describe('DeckReviewPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reviews only the due cards of the chosen deck, subdecks included', async () => {
    mocks.listCards.mockResolvedValue({
      items: [
        { id: 'anki_1', stateId: 'st_1', front: 'F1', back: 'B1', tags: [] },
        { id: 'anki_2', front: 'F2', back: 'B2', tags: [] },
      ],
      page: 1, pageSize: 200, total: 2,
    });
    render(<DeckReviewPanel decks={decks} />);

    expect(screen.getByText('到期 3 · 新卡 3')).toBeInTheDocument();
    expect(screen.getByText('今天没有到期')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '复习「数学」的 3 张到期卡' }));

    await waitFor(() => expect(mocks.startBatchSession).toHaveBeenCalled());
    expect(mocks.listCards).toHaveBeenCalledWith({
      deck: '数学', status: 'due', sort: 'due', page: 1, page_size: 200,
    });
    expect(mocks.startBatchSession).toHaveBeenCalledWith(
      ['anki_1', 'anki_2'],
      [
        expect.objectContaining({ id: 'st_1', ankiCardId: 'anki_1', front: 'F1' }),
        expect.objectContaining({ id: 'anki_2', ankiCardId: 'anki_2', front: 'F2' }),
      ],
    );
  });

  it('expands subdecks, offers new cards when nothing is due and opens the deck in the library', async () => {
    mocks.listCards.mockResolvedValue({ items: [], page: 1, pageSize: 10, total: 0 });
    render(<DeckReviewPanel decks={decks} />);

    expect(screen.queryByText('导数')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开「数学」的子牌组' }));
    expect(screen.getByText('导数')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '学「导数」的 2 张新卡' }));
    await waitFor(() => expect(mocks.notify).toHaveBeenCalledWith('info', '这个牌组暂时没有可复习的卡'));
    expect(mocks.listCards).toHaveBeenCalledWith({
      deck: '数学::导数', status: 'new', sort: 'created', page: 1, page_size: 10,
    });
    expect(mocks.startBatchSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '在卡片库查看「英语」' }));
    await waitFor(() => expect(mocks.setScreen).toHaveBeenCalledWith('library'));
    expect(mocks.setDeckFilter).toHaveBeenCalledWith('英语');
  });

  it('stays out of the way with a single deck or nothing to do', () => {
    const { container, rerender } = render(<DeckReviewPanel decks={[decks[0]]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DeckReviewPanel decks={[decks[2], { ...decks[2], name: '' }]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DeckReviewPanel decks={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
