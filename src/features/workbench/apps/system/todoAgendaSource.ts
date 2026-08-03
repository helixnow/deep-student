/**
 * Desktop agenda data source.
 *
 * Keeps calendar queries separate from Todo's active view state so the desktop
 * widget never changes the list/filter currently open in the Todo window.
 */
import * as todoApi from '@/features/todo/api';
import { useTodoStore } from '@/features/todo/stores/useTodoStore';
import type { TodoItem, TodoList } from '@/features/todo/types';
import { registerDomainListener } from '../../agent/domainEvents';

const POLL_INTERVAL_MS = 60_000;
const STORE_REFRESH_DEBOUNCE_MS = 120;

export interface TodoAgendaSnapshot {
  items: readonly TodoItem[];
  lists: readonly TodoList[];
  isLoading: boolean;
  error: string | null;
  updatedAt: number;
}

const INITIAL_SNAPSHOT: TodoAgendaSnapshot = Object.freeze({
  items: Object.freeze([]),
  lists: Object.freeze([]),
  isLoading: false,
  error: null,
  updatedAt: 0,
});

let snapshot = INITIAL_SNAPSHOT;
let refreshPromise: Promise<void> | null = null;
let refreshAgain = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let storeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityHandler: (() => void) | null = null;
let stopDomainListener: (() => void) | null = null;
let stopTodoStoreListener: (() => void) | null = null;
const listeners = new Set<() => void>();
const togglingIds = new Set<string>();

function publish(next: TodoAgendaSnapshot): void {
  snapshot = next;
  for (const listener of Array.from(listeners)) listener();
}

function normalizePendingItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is TodoItem => Boolean(
      item && typeof item === 'object' &&
      typeof (item as TodoItem).id === 'string' &&
      (item as TodoItem).status === 'pending',
    ))
    .sort((a, b) => {
      if (a.dueDate !== b.dueDate) {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      }
      if (a.dueTime !== b.dueTime) {
        if (!a.dueTime) return 1;
        if (!b.dueTime) return -1;
        return a.dueTime.localeCompare(b.dueTime);
      }
      return a.sortOrder - b.sortOrder;
    });
}

function schedulePoll(): void {
  if (listeners.size === 0) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      schedulePoll();
      return;
    }
    void refreshTodoAgenda().finally(schedulePoll);
  }, POLL_INTERVAL_MS);
}

function scheduleStoreRefresh(): void {
  if (storeRefreshTimer) clearTimeout(storeRefreshTimer);
  storeRefreshTimer = setTimeout(() => {
    storeRefreshTimer = null;
    void refreshTodoAgenda();
  }, STORE_REFRESH_DEBOUNCE_MS);
}

function startWatcher(): void {
  if (stopDomainListener) return;
  stopDomainListener = registerDomainListener('todo://changed', () => {
    void refreshTodoAgenda();
  });
  stopTodoStoreListener = useTodoStore.subscribe((state, previous) => {
    if (
      state.items !== previous.items ||
      state.lists !== previous.lists ||
      state.trashItems !== previous.trashItems ||
      state.trashLists !== previous.trashLists
    ) {
      scheduleStoreRefresh();
    }
  });
  if (typeof document !== 'undefined') {
    visibilityHandler = () => {
      if (document.visibilityState === 'visible') void refreshTodoAgenda();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
  }
  void refreshTodoAgenda();
  schedulePoll();
}

function stopWatcher(): void {
  stopDomainListener?.();
  stopDomainListener = null;
  stopTodoStoreListener?.();
  stopTodoStoreListener = null;
  if (pollTimer) clearTimeout(pollTimer);
  if (storeRefreshTimer) clearTimeout(storeRefreshTimer);
  pollTimer = null;
  storeRefreshTimer = null;
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler);
  }
  visibilityHandler = null;
}

export function getTodoAgendaSnapshot(): TodoAgendaSnapshot {
  return snapshot;
}

export function subscribeTodoAgenda(listener: () => void): () => void {
  listeners.add(listener);
  startWatcher();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stopWatcher();
  };
}

/** Coalesced backend refresh. Failed refreshes keep the last useful data. */
export function refreshTodoAgenda(): Promise<void> {
  if (refreshPromise) {
    refreshAgain = true;
    return refreshPromise;
  }
  publish({ ...snapshot, isLoading: snapshot.updatedAt === 0, error: null });
  refreshPromise = (async () => {
    do {
      refreshAgain = false;
      try {
        const [lists, items] = await Promise.all([
          todoApi.listTodoLists(),
          todoApi.listAllPendingItems(),
        ]);
        publish({
          lists: Array.isArray(lists) ? lists : [],
          items: normalizePendingItems(items),
          isLoading: false,
          error: null,
          updatedAt: Date.now(),
        });
      } catch (error) {
        publish({
          ...snapshot,
          isLoading: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } while (refreshAgain);
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

/** Optimistic completion used by the desktop widget. */
export async function completeTodoAgendaItem(itemId: string): Promise<void> {
  if (togglingIds.has(itemId)) return;
  const item = snapshot.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  togglingIds.add(itemId);
  const previous = snapshot;
  publish({
    ...snapshot,
    items: snapshot.items.filter((candidate) => candidate.id !== itemId),
  });
  try {
    await todoApi.toggleTodoItem(itemId);
    void useTodoStore.getState().reloadCurrentView();
    await refreshTodoAgenda();
  } catch (error) {
    publish(previous);
    throw error;
  } finally {
    togglingIds.delete(itemId);
  }
}

/** Test-only reset; intentionally not re-exported from the Workbench public API. */
export function resetTodoAgendaSourceForTests(): void {
  listeners.clear();
  stopWatcher();
  refreshPromise = null;
  refreshAgain = false;
  togglingIds.clear();
  snapshot = INITIAL_SNAPSHOT;
}
