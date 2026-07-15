import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AnkiLibraryCard, AnkiLibraryListResponse } from '@/types';

const mocks = vi.hoisted(() => ({
  deleteCard: vi.fn(),
  enqueueCard: vi.fn(),
  listCards: vi.fn(),
  requestDueRefresh: vi.fn(),
  startBatchSession: vi.fn(),
  suspendCard: vi.fn(),
  undoLastReview: vi.fn(),
  unsuspendCard: vi.fn(),
  updateLibraryCard: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => ({
      'library.title': '卡片库',
      'library.loading': '加载中…',
      'library.total': '卡片总数',
      'library.refresh': '刷新',
      'library.searchLabel': '搜索卡片',
      'library.searchPlaceholder': '搜索正面 / 背面 / 标签',
      'library.search': '搜索',
      'library.dismiss': '关闭',
      'library.retry': '重试',
      'library.empty': '库中暂无卡片',
      'library.state.notEnqueued': '未入队',
      'library.state.new': '新卡',
      'library.state.review': '复习中',
      'library.startReview': '复习',
      'library.enqueue': '入队',
      'library.resume': '恢复',
      'library.suspend': '暂停',
      'library.delete': '删除',
      'library.previous': '上一页',
      'library.next': '下一页',
      'library.confirmDelete': '确定删除这张卡片吗？',
      'common:cancel': '取消',
    }[key] ?? (typeof fallback === 'string' ? fallback : key)),
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

vi.mock('@/utils/chatApi', () => ({
  deleteAnkiCard: mocks.deleteCard,
  enqueueAnkiLibraryCard: mocks.enqueueCard,
  listAnkiLibraryCards: mocks.listCards,
  suspendFsrsCard: mocks.suspendCard,
  undoFsrsLastReview: mocks.undoLastReview,
  unsuspendFsrsCard: mocks.unsuspendCard,
  updateAnkiLibraryCard: mocks.updateLibraryCard,
}));

vi.mock('@/features/flashcards/store/fsrsReviewStore', () => ({
  useFsrsReviewStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    startBatchSession: mocks.startBatchSession,
  }),
}));

vi.mock('@/features/flashcards/events', () => ({
  FSRS_LIBRARY_REFRESH_EVENT: 'fsrs:library-refresh',
  requestFlashcardsDueRefresh: mocks.requestDueRefresh,
}));

import { LibraryScreen } from '@/features/flashcards/screens/LibraryScreen';
import { useFlashcardsLibraryStore } from '@/features/flashcards/store/libraryStore';

function card(
  id: string,
  scheduling: Partial<Pick<
    AnkiLibraryCard,
    'stateId' | 'state' | 'dueMs' | 'suspended' | 'enqueued' | 'isDue'
  >> = {},
): AnkiLibraryCard {
  return {
    id,
    task_id: `task-${id}`,
    front: `front ${id}`,
    back: `back ${id}`,
    tags: [],
    images: [],
    created_at: '2026-07-14T00:00:00Z',
    updated_at: '2026-07-14T00:00:00Z',
    suspended: false,
    enqueued: false,
    isDue: false,
    ...scheduling,
  };
}

function response(items: AnkiLibraryCard[], total = items.length, page = 1): AnkiLibraryListResponse {
  return { items, total, page, pageSize: 20 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe('LibraryScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFlashcardsLibraryStore.getState().reset();
    mocks.deleteCard.mockResolvedValue(true);
    mocks.enqueueCard.mockResolvedValue({ enqueued: 1 });
    mocks.startBatchSession.mockResolvedValue(true);
    mocks.suspendCard.mockResolvedValue({ state: {}, changed: true });
    mocks.unsuspendCard.mockResolvedValue({ state: {}, changed: true });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('paginates and resets to page one when a search is submitted', async () => {
    mocks.listCards.mockImplementation(async ({ page, search }: { page?: number; search?: string }) => {
      if (search === 'needle') return response([card('search-result')], 1, 1);
      if (page === 2) return response([card('page-two')], 21, 2);
      return response([card('page-one')], 21, 1);
    });

    render(<LibraryScreen />);
    expect(await screen.findByText('front page-one')).toBeInTheDocument();
    expect(mocks.listCards).toHaveBeenCalledWith({
      search: undefined,
      page: 1,
      page_size: 20,
    });

    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByText('front page-two')).toBeInTheDocument();
    expect(mocks.listCards).toHaveBeenLastCalledWith({
      search: undefined,
      page: 2,
      page_size: 20,
    });

    fireEvent.change(screen.getByPlaceholderText('搜索正面 / 背面 / 标签'), {
      target: { value: ' needle ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    expect(await screen.findByText('front search-result')).toBeInTheDocument();
    expect(mocks.listCards).toHaveBeenLastCalledWith({
      search: 'needle',
      page: 1,
      page_size: 20,
    });
  });

  it('ignores a stale page response that resolves after a newer search', async () => {
    const pageTwo = deferred<AnkiLibraryListResponse>();
    const searchResult = deferred<AnkiLibraryListResponse>();
    mocks.listCards.mockImplementation(({ page, search }: { page?: number; search?: string }) => {
      if (search === 'latest') return searchResult.promise;
      if (page === 2) return pageTwo.promise;
      return Promise.resolve(response([card('page-one')], 21, 1));
    });

    render(<LibraryScreen />);
    expect(await screen.findByText('front page-one')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    fireEvent.change(screen.getByPlaceholderText('搜索正面 / 背面 / 标签'), {
      target: { value: 'latest' },
    });
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    searchResult.resolve(response([card('latest')], 1, 1));
    expect(await screen.findByText('front latest')).toBeInTheDocument();

    pageTwo.resolve(response([card('stale-page-two')], 21, 2));
    await Promise.resolve();
    expect(screen.queryByText('front stale-page-two')).not.toBeInTheDocument();
    expect(screen.getByText('front latest')).toBeInTheDocument();
  });

  it('enqueues without opening a session, then starts review after refresh', async () => {
    const unqueued = card('queue-me');
    const enqueued = card('queue-me', {
      enqueued: true,
      stateId: 'state-queue-me',
      state: 0,
    });
    mocks.listCards
      .mockResolvedValueOnce(response([unqueued]))
      .mockResolvedValue(response([enqueued]));

    render(<LibraryScreen />);
    expect(await screen.findByTestId('schedule-state-queue-me')).toHaveTextContent('未入队');
    fireEvent.click(screen.getByRole('button', { name: '入队' }));

    await waitFor(() => expect(mocks.enqueueCard).toHaveBeenCalledWith('queue-me'));
    expect(mocks.requestDueRefresh).toHaveBeenCalledTimes(1);
    expect(mocks.startBatchSession).not.toHaveBeenCalled();
    expect(await screen.findByTestId('schedule-state-queue-me')).toHaveTextContent('新卡');

    fireEvent.click(screen.getByRole('button', { name: '复习' }));
    expect(mocks.startBatchSession).toHaveBeenCalledWith(
      ['queue-me'],
      [expect.objectContaining({ id: 'state-queue-me', ankiCardId: 'queue-me' })],
    );
  });

  it('pauses, resumes, and confirms deletion through row actions', async () => {
    const active = card('active', {
      enqueued: true,
      stateId: 'state-active',
      state: 2,
    });
    const paused = card('paused', {
      enqueued: true,
      stateId: 'state-paused',
      state: 2,
      suspended: true,
    });
    mocks.listCards.mockResolvedValue(response([active, paused]));

    render(<LibraryScreen />);
    expect(await screen.findByText('front active')).toBeInTheDocument();

    const activeRow = screen.getByText('front active').closest('li');
    const pausedRow = screen.getByText('front paused').closest('li');
    expect(activeRow).not.toBeNull();
    expect(pausedRow).not.toBeNull();

    fireEvent.click(within(activeRow as HTMLElement).getByRole('button', { name: '暂停' }));
    await waitFor(() => expect(mocks.suspendCard).toHaveBeenCalledWith('state-active'));

    const refreshedPausedRow = await waitFor(() => {
      const row = screen.getByText('front paused').closest('li');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByRole('button', { name: '恢复' })).toBeEnabled();
      return row as HTMLElement;
    });
    fireEvent.click(within(refreshedPausedRow).getByRole('button', { name: '恢复' }));
    await waitFor(() => expect(mocks.unsuspendCard).toHaveBeenCalledWith('state-paused'));

    const refreshedActiveRow = await waitFor(() => {
      const row = screen.getByText('front active').closest('li');
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByRole('button', { name: '删除' })).toBeEnabled();
      return row as HTMLElement;
    });
    fireEvent.click(within(refreshedActiveRow).getByRole('button', { name: '删除' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(mocks.deleteCard).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(mocks.deleteCard).toHaveBeenCalledWith('active'));
  });
});
