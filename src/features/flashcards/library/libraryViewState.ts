/**
 * Session-scoped view state & deep-jump focus memory for the Flashcards Library.
 *
 * Preserves the learner's active pagination (`page`, `pageSize`), search query,
 * deck/status/sort filters, expanded card row, and scroll offset across:
 * - inline card edit save/cancel & library refreshes
 * - entering a review session from the library and returning
 * - switching Flashcards tabs (Today / Library / Statistics) or window remounts
 *
 * Also coordinates Cmd+K global search deep jumps directly to a specific card,
 * deck, and search query in the Library screen.
 */
import {
  FLASHCARDS_LIBRARY_PAGE_SIZE,
  FLASHCARDS_LIBRARY_PAGE_SIZE_OPTIONS,
  useFlashcardsLibraryStore,
  type LibraryPageSize,
  type LibrarySortDir,
  type LibrarySortKey,
  type LibraryStatusFilter,
} from '../store/libraryStore';

const STORAGE_KEY = 'deepstudent.flashcards.libraryViewState.v1';

export type FlashcardsReturnOrigin = 'today' | 'library';

export interface FlashcardsLibraryViewSnapshot {
  page: number;
  pageSize: number;
  query: string;
  searchInput: string;
  statusFilter: LibraryStatusFilter;
  deckFilter: string | null;
  sortKey: LibrarySortKey;
  sortDir: LibrarySortDir;
  expandedId: string | null;
  filtersOpen: boolean;
  scrollTop: number;
}

export interface PendingLibraryCardFocus {
  cardId: string;
  query: string;
  deckFilter: string | null;
}

const VALID_STATUS_FILTERS = new Set<LibraryStatusFilter>([
  'all',
  'due',
  'new',
  'learning',
  'review',
  'suspended',
  'notEnqueued',
]);

const VALID_SORT_KEYS = new Set<LibrarySortKey>(['default', 'due', 'created', 'front']);

let memorySnapshot: FlashcardsLibraryViewSnapshot | null = null;
let returnOrigin: FlashcardsReturnOrigin = 'today';
let pendingCardFocus: PendingLibraryCardFocus | null = null;
const focusListeners = new Set<(focus: PendingLibraryCardFocus | null) => void>();

function sanitizeSnapshot(raw: unknown): FlashcardsLibraryViewSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const page = typeof obj.page === 'number' && Number.isFinite(obj.page) && obj.page >= 1
    ? Math.trunc(obj.page)
    : 1;
  const rawPageSize = typeof obj.pageSize === 'number' && Number.isFinite(obj.pageSize)
    ? Math.trunc(obj.pageSize)
    : FLASHCARDS_LIBRARY_PAGE_SIZE;
  const pageSize = FLASHCARDS_LIBRARY_PAGE_SIZE_OPTIONS.includes(rawPageSize as LibraryPageSize)
    ? rawPageSize
    : FLASHCARDS_LIBRARY_PAGE_SIZE;
  const query = typeof obj.query === 'string' ? obj.query.trim() : '';
  const searchInput = typeof obj.searchInput === 'string' ? obj.searchInput : query;
  const statusFilter = typeof obj.statusFilter === 'string'
    && VALID_STATUS_FILTERS.has(obj.statusFilter as LibraryStatusFilter)
    ? (obj.statusFilter as LibraryStatusFilter)
    : 'all';
  const deckFilter = typeof obj.deckFilter === 'string' ? obj.deckFilter : null;
  const sortKey = typeof obj.sortKey === 'string'
    && VALID_SORT_KEYS.has(obj.sortKey as LibrarySortKey)
    ? (obj.sortKey as LibrarySortKey)
    : 'default';
  const sortDir: LibrarySortDir = obj.sortDir === 'desc' ? 'desc' : 'asc';
  const expandedId = typeof obj.expandedId === 'string' && obj.expandedId.trim()
    ? obj.expandedId
    : null;
  const filtersOpen = obj.filtersOpen === true;
  const scrollTop = typeof obj.scrollTop === 'number' && Number.isFinite(obj.scrollTop) && obj.scrollTop >= 0
    ? obj.scrollTop
    : 0;

  return {
    page,
    pageSize,
    query,
    searchInput,
    statusFilter,
    deckFilter,
    sortKey,
    sortDir,
    expandedId,
    filtersOpen,
    scrollTop,
  };
}

function readFromSessionStorage(): FlashcardsLibraryViewSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitizeSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeToSessionStorage(snapshot: FlashcardsLibraryViewSnapshot | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (!snapshot) {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } else {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    }
  } catch {
    // Ignore storage quota or sandbox restrictions; in-memory snapshot still holds state.
  }
}

function isStoreAtInitialDefaults(state: ReturnType<typeof useFlashcardsLibraryStore.getState>): boolean {
  return (
    !state.loaded &&
    state.items.length === 0 &&
    state.page === 1 &&
    state.pageSize === FLASHCARDS_LIBRARY_PAGE_SIZE &&
    state.query === '' &&
    state.searchInput === '' &&
    state.statusFilter === 'all' &&
    state.deckFilter === null &&
    state.sortKey === 'default' &&
    state.sortDir === 'asc'
  );
}

// Keep persisted view state aligned with explicit store.reset() calls (e.g. account
// switch or test beforeEach cleanup) so stale state never leaks across sessions/tests.
useFlashcardsLibraryStore.subscribe((state, prev) => {
  if (isStoreAtInitialDefaults(state) && (prev.loaded || !isStoreAtInitialDefaults(prev))) {
    memorySnapshot = null;
    pendingCardFocus = null;
    returnOrigin = 'today';
    writeToSessionStorage(null);
  }
});

export function readLibraryViewState(): FlashcardsLibraryViewSnapshot | null {
  if (memorySnapshot) return memorySnapshot;
  const restored = readFromSessionStorage();
  if (restored) {
    memorySnapshot = restored;
  }
  return memorySnapshot;
}

export function saveLibraryViewState(
  partial: Partial<FlashcardsLibraryViewSnapshot>,
): FlashcardsLibraryViewSnapshot {
  const store = useFlashcardsLibraryStore.getState();
  const base = readLibraryViewState() ?? {
    page: store.page,
    pageSize: store.pageSize,
    query: store.query,
    searchInput: store.searchInput || store.query,
    statusFilter: store.statusFilter,
    deckFilter: store.deckFilter,
    sortKey: store.sortKey,
    sortDir: store.sortDir,
    expandedId: null,
    filtersOpen: false,
    scrollTop: 0,
  };
  const next = sanitizeSnapshot({ ...base, ...partial }) ?? base;
  memorySnapshot = next;
  writeToSessionStorage(next);
  return next;
}

/**
 * Hydrates `useFlashcardsLibraryStore` from the persisted session snapshot when the
 * store has not been loaded yet (e.g. after a view reload) and no explicit non-default
 * state was already seeded on the store.
 */
export function hydrateLibraryStoreFromViewState(): FlashcardsLibraryViewSnapshot | null {
  if (pendingCardFocus) {
    const focused = saveLibraryViewState({
      page: 1,
      query: pendingCardFocus.query,
      searchInput: pendingCardFocus.query,
      statusFilter: 'all',
      deckFilter: pendingCardFocus.deckFilter,
      sortKey: 'default',
      sortDir: 'asc',
      expandedId: pendingCardFocus.cardId,
      scrollTop: 0,
    });
    return focused;
  }

  const saved = readLibraryViewState();
  if (!saved) return null;

  const store = useFlashcardsLibraryStore.getState();
  if (isStoreAtInitialDefaults(store)) {
    useFlashcardsLibraryStore.setState({
      page: saved.page,
      pageSize: saved.pageSize,
      query: saved.query,
      searchInput: saved.searchInput,
      statusFilter: saved.statusFilter,
      deckFilter: saved.deckFilter,
      sortKey: saved.sortKey,
      sortDir: saved.sortDir,
    });
  }
  return saved;
}

export function setLibraryReturnOrigin(origin: FlashcardsReturnOrigin): void {
  returnOrigin = origin;
}

export function peekLibraryReturnOrigin(): FlashcardsReturnOrigin {
  return returnOrigin;
}

export function consumeLibraryReturnOrigin(): FlashcardsReturnOrigin {
  const current = returnOrigin;
  returnOrigin = 'today';
  return current;
}

export function requestLibraryCardFocus(target: PendingLibraryCardFocus): void {
  const normalized: PendingLibraryCardFocus = {
    cardId: target.cardId.trim(),
    query: target.query.trim(),
    deckFilter: target.deckFilter && target.deckFilter.trim().length > 0
      ? target.deckFilter.trim()
      : null,
  };
  pendingCardFocus = normalized;
  saveLibraryViewState({
    page: 1,
    query: normalized.query,
    searchInput: normalized.query,
    statusFilter: 'all',
    deckFilter: normalized.deckFilter,
    sortKey: 'default',
    sortDir: 'asc',
    expandedId: normalized.cardId || null,
    scrollTop: 0,
  });
  for (const listener of focusListeners) {
    listener(normalized);
  }
}

export function peekPendingLibraryCardFocus(): PendingLibraryCardFocus | null {
  return pendingCardFocus;
}

export function clearPendingLibraryCardFocus(): void {
  pendingCardFocus = null;
}

export function subscribePendingLibraryCardFocus(
  listener: (focus: PendingLibraryCardFocus | null) => void,
): () => void {
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

export function resetLibraryViewState(): void {
  memorySnapshot = null;
  returnOrigin = 'today';
  pendingCardFocus = null;
  writeToSessionStorage(null);
}
