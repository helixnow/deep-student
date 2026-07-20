import { create } from 'zustand';
import i18n from '@/i18n';
import type {
  AnkiLibraryCard,
  AnkiLibraryCardPatch,
  AnkiLibraryListResponse,
} from '@/types';
import {
  deleteAnkiCard,
  enqueueAnkiLibraryCard,
  listAnkiLibraryCards,
  suspendFsrsCard,
  undoFsrsLastReview,
  unsuspendFsrsCard,
  updateAnkiLibraryCard,
} from '@/utils/chatApi';
import { getErrorMessage } from '@/utils/errorUtils';
import { requestFlashcardsDueRefresh } from '../events';

export const FLASHCARDS_LIBRARY_PAGE_SIZE = 20;

/** 客户端状态筛选（后端 list 命令暂不支持按调度状态过滤，作用于当前页）。 */
export type LibraryStatusFilter =
  | 'all'
  | 'due'
  | 'new'
  | 'learning'
  | 'review'
  | 'suspended'
  | 'notEnqueued';

/** 客户端排序（'default' 保持服务端返回顺序）。 */
export type LibrarySortKey = 'default' | 'due' | 'created' | 'front';
export type LibrarySortDir = 'asc' | 'desc';

const DEFAULT_SORT_DIR: Record<Exclude<LibrarySortKey, 'default'>, LibrarySortDir> = {
  due: 'asc',
  created: 'desc',
  front: 'asc',
};

interface FlashcardsLibraryState {
  items: AnkiLibraryCard[];
  total: number;
  page: number;
  pageSize: number;
  searchInput: string;
  query: string;
  loading: boolean;
  loadError: string | null;
  actionError: string | null;
  busyCardId: string | null;
  /** 批量操作进行中（与单卡 busyCardId 互斥使用）。 */
  bulkBusy: boolean;
  loaded: boolean;
  statusFilter: LibraryStatusFilter;
  sortKey: LibrarySortKey;
  sortDir: LibrarySortDir;

  setSearchInput: (value: string) => void;
  setStatusFilter: (filter: LibraryStatusFilter) => void;
  /** 再次点击当前排序键时翻转方向。 */
  toggleSort: (key: Exclude<LibrarySortKey, 'default'>) => void;
  clearSort: () => void;
  clearActionError: () => void;
  load: (query?: string, page?: number) => Promise<boolean>;
  refresh: () => Promise<boolean>;
  submitSearch: (query?: string) => Promise<boolean>;
  goToPage: (page: number) => Promise<boolean>;
  enqueueCard: (cardId: string) => Promise<boolean>;
  setCardSuspended: (cardId: string, suspended: boolean) => Promise<boolean>;
  updateCard: (cardId: string, patch: AnkiLibraryCardPatch) => Promise<boolean>;
  undoLastReview: (cardId: string) => Promise<boolean>;
  deleteCard: (cardId: string) => Promise<boolean>;
  bulkEnqueue: (cardIds: string[]) => Promise<boolean>;
  bulkSetSuspended: (cardIds: string[], suspended: boolean) => Promise<boolean>;
  bulkDelete: (cardIds: string[]) => Promise<boolean>;
  reset: () => void;
}

const initialState = {
  items: [] as AnkiLibraryCard[],
  total: 0,
  page: 1,
  pageSize: FLASHCARDS_LIBRARY_PAGE_SIZE,
  searchInput: '',
  query: '',
  loading: false,
  loadError: null as string | null,
  actionError: null as string | null,
  busyCardId: null as string | null,
  bulkBusy: false,
  loaded: false,
  statusFilter: 'all' as LibraryStatusFilter,
  sortKey: 'default' as LibrarySortKey,
  sortDir: 'asc' as LibrarySortDir,
};

export const useFlashcardsLibraryStore = create<FlashcardsLibraryState>((set, get) => {
  let requestId = 0;

  const runMutation = async (
    cardId: string,
    mutation: (card: AnkiLibraryCard) => Promise<unknown>,
  ): Promise<boolean> => {
    const card = get().items.find((item) => item.id === cardId);
    if (!card) {
      set({ actionError: i18n.t('flashcards:library.cardNotFound') });
      return false;
    }
    set({ busyCardId: cardId, actionError: null });
    try {
      await mutation(card);
      requestFlashcardsDueRefresh();
      await get().refresh();
      return true;
    } catch (error) {
      set({
        actionError: getErrorMessage(error) || i18n.t('flashcards:library.actionFailed'),
      });
      return false;
    } finally {
      if (get().busyCardId === cardId) set({ busyCardId: null });
    }
  };

  /**
   * 批量操作：逐卡执行、聚合失败，只在结束后刷新一次列表。
   * 目标卡不在当前页时按失败处理（与 runMutation 的 fail-closed 语义一致）。
   */
  const runBulkMutation = async (
    cardIds: string[],
    mutation: (card: AnkiLibraryCard) => Promise<unknown>,
  ): Promise<boolean> => {
    const ids = Array.from(new Set(cardIds));
    if (ids.length === 0) return true;
    const byId = new Map(get().items.map((item) => [item.id, item]));
    const cards = ids
      .map((id) => byId.get(id))
      .filter((item): item is AnkiLibraryCard => Boolean(item));
    if (cards.length === 0) {
      set({ actionError: i18n.t('flashcards:library.cardNotFound') });
      return false;
    }
    set({ bulkBusy: true, actionError: null });
    let failed = ids.length - cards.length;
    let lastError: string | null = null;
    try {
      for (const card of cards) {
        try {
          await mutation(card);
        } catch (error) {
          failed += 1;
          lastError = getErrorMessage(error) || null;
        }
      }
      requestFlashcardsDueRefresh();
      await get().refresh();
      if (failed > 0) {
        set({
          actionError: i18n.t('flashcards:library.bulkPartialFailure', {
            failed,
            total: ids.length,
            message: lastError ?? i18n.t('flashcards:library.actionFailed'),
          }),
        });
        return false;
      }
      return true;
    } finally {
      set({ bulkBusy: false });
    }
  };

  return {
    ...initialState,

    setSearchInput: (value) => set({ searchInput: value }),
    setStatusFilter: (filter) => set({ statusFilter: filter }),
    toggleSort: (key) => {
      const { sortKey, sortDir } = get();
      if (sortKey === key) {
        set({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' });
        return;
      }
      set({ sortKey: key, sortDir: DEFAULT_SORT_DIR[key] });
    },
    clearSort: () => set({ sortKey: 'default', sortDir: 'asc' }),
    clearActionError: () => set({ actionError: null }),

    load: async (query = get().query, page = get().page) => {
      const normalizedQuery = query.trim();
      const requestedPage = Math.max(1, Math.trunc(page));
      const currentRequest = ++requestId;
      set({ loading: true, loadError: null });
      try {
        const response: AnkiLibraryListResponse = await listAnkiLibraryCards({
          search: normalizedQuery || undefined,
          page: requestedPage,
          page_size: FLASHCARDS_LIBRARY_PAGE_SIZE,
        });
        if (currentRequest !== requestId) return false;

        const total = Math.max(0, response.total ?? 0);
        const lastPage = Math.max(1, Math.ceil(total / FLASHCARDS_LIBRARY_PAGE_SIZE));
        if (requestedPage > lastPage) {
          set({ page: lastPage, query: normalizedQuery, loading: false });
          return get().load(normalizedQuery, lastPage);
        }

        set({
          items: Array.isArray(response.items) ? response.items : [],
          total,
          page: requestedPage,
          query: normalizedQuery,
          loading: false,
          loaded: true,
        });
        return true;
      } catch (error) {
        if (currentRequest !== requestId) return false;
        set({
          items: [],
          total: 0,
          loading: false,
          loaded: true,
          loadError: getErrorMessage(error) || i18n.t('flashcards:library.loadFailed'),
        });
        return false;
      }
    },

    refresh: () => get().load(get().query, get().page),

    submitSearch: (query = get().searchInput) => {
      const normalizedQuery = query.trim();
      set({ searchInput: query, query: normalizedQuery, page: 1, actionError: null });
      return get().load(normalizedQuery, 1);
    },

    goToPage: (page) => {
      const lastPage = Math.max(1, Math.ceil(get().total / FLASHCARDS_LIBRARY_PAGE_SIZE));
      const boundedPage = Math.min(lastPage, Math.max(1, Math.trunc(page)));
      if (boundedPage === get().page) return Promise.resolve(false);
      set({ page: boundedPage });
      return get().load(get().query, boundedPage);
    },

    enqueueCard: (cardId) => runMutation(cardId, (card) => enqueueAnkiLibraryCard(card.id)),

    setCardSuspended: (cardId, suspended) => runMutation(cardId, async (card) => {
      if (!card.stateId) throw new Error(i18n.t('flashcards:library.missingState'));
      return suspended
        ? suspendFsrsCard(card.stateId)
        : unsuspendFsrsCard(card.stateId);
    }),

    updateCard: (cardId, patch) => runMutation(
      cardId,
      (card) => updateAnkiLibraryCard(card, patch),
    ),

    undoLastReview: (cardId) => runMutation(cardId, async (card) => {
      const logId = card.latestReview?.undoable ? card.latestReview.logId : null;
      if (!card.stateId || !logId) {
        throw new Error(i18n.t('flashcards:library.undoUnavailable'));
      }
      return undoFsrsLastReview(card.stateId, logId);
    }),

    deleteCard: (cardId) => runMutation(cardId, (card) => deleteAnkiCard(card.id)),

    bulkEnqueue: (cardIds) => runBulkMutation(cardIds, async (card) => {
      if (card.enqueued) return;
      await enqueueAnkiLibraryCard(card.id);
    }),

    bulkSetSuspended: (cardIds, suspended) => runBulkMutation(cardIds, async (card) => {
      if (!card.enqueued || card.suspended === suspended) return;
      if (!card.stateId) throw new Error(i18n.t('flashcards:library.missingState'));
      await (suspended ? suspendFsrsCard(card.stateId) : unsuspendFsrsCard(card.stateId));
    }),

    bulkDelete: (cardIds) => runBulkMutation(cardIds, (card) => deleteAnkiCard(card.id)),

    reset: () => {
      requestId += 1;
      set({ ...initialState });
    },
  };
});
