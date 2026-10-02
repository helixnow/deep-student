import { invoke } from '@tauri-apps/api/core';
import { create } from 'zustand';
import { SESSION_LIST_PAGE_SIZE } from '../core/constants';
import type { SessionGroup } from '../types/group';
import type { ChatSession } from '../types/session';
import { getErrorMessage } from '@/utils/errorUtils';

type StateUpdater<T> = T | ((previous: T) => T);

export interface SessionListStoreState {
  sessions: ChatSession[];
  groups: SessionGroup[];
  hasMoreUngrouped: boolean;
  isLoadingMore: boolean;
  isLoaded: boolean;
  loadMoreUngrouped: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Share an in-flight request, or reuse a recently loaded list. */
  ensureLoaded: () => Promise<void>;
  /** Publish an authoritative snapshot, fencing off older requests. */
  setSnapshot: (sessions: ChatSession[], hasMoreUngrouped?: boolean) => void;
  setSessions: (updater: StateUpdater<ChatSession[]>) => void;
  setGroups: (updater: StateUpdater<SessionGroup[]>) => void;
}

const REFRESH_DEBOUNCE_MS = 120;
const VISIBILITY_REFRESH_MIN_INTERVAL_MS = 30_000;
let sessionsRevision = 0;
let groupsRevision = 0;
let refreshInFlight: Promise<void> | null = null;
let loadMoreInFlight: Promise<void> | null = null;
let refreshPending = false;
let lastRefreshStartedAt = 0;
let subscriberCount = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let removeGlobalListeners: (() => void) | null = null;

// IPC data is JSON. Compare the complete record, including metadata used by the
// page's draft, branch and workspace logic, rather than a sidebar-only hash.
function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key)
      && sameValue(leftRecord[key], rightRecord[key]));
}

function shareRows<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  if (previous === incoming) return previous;
  const byId = new Map(previous.map((row) => [row.id, row]));
  const next = incoming.map((row) => {
    const existing = byId.get(row.id);
    return existing && sameValue(existing, row) ? existing : row;
  });
  return previous.length === next.length && next.every((row, index) => row === previous[index])
    ? previous
    : next;
}

function resolveUpdater<T>(updater: StateUpdater<T>, previous: T): T {
  return typeof updater === 'function' ? (updater as (value: T) => T)(previous) : updater;
}

/**
 * Newest first, and rows sharing a timestamp keep the order the previous list had.
 * Without that tiebreak a failed partition — whose cached rows are re-inserted
 * before the successful ones — silently reshuffles rows the user is looking at.
 */
function orderRows(previous: ChatSession[], incoming: ChatSession[]): ChatSession[] {
  const previousOrder = new Map(previous.map((session, index) => [session.id, index]));
  const incomingOrder = new Map(incoming.map((session, index) => [session.id, previous.length + index]));
  const rank = (session: ChatSession) => previousOrder.get(session.id) ?? incomingOrder.get(session.id) ?? 0;
  return [...incoming].sort((left, right) => {
    const byUpdatedAt = (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '');
    return byUpdatedAt !== 0 ? byUpdatedAt : rank(left) - rank(right);
  });
}

function readList<T>(result: PromiseSettledResult<T[]>, label: string): T[] | null {
  if (result.status === 'fulfilled' && Array.isArray(result.value)) return result.value;
  console.warn(`[sessionListStore] Failed to load ${label}:`,
    result.status === 'rejected' ? getErrorMessage(result.reason) : 'invalid payload');
  return null;
}

async function executeRefresh(): Promise<void> {
  const sessionVersion = sessionsRevision;
  const groupVersion = groupsRevision;
  // Reload the complete visible window, not just page one. This both preserves
  // loaded pages and correctly removes archived/deleted rows from that window.
  const ungroupedLimit = Math.max(SESSION_LIST_PAGE_SIZE,
    useSessionListStore.getState().sessions.filter((session) => !session.groupId).length);
  lastRefreshStartedAt = Date.now();
  const [groupedResult, ungroupedResult, groupsResult] = await Promise.allSettled([
    invoke<ChatSession[]>('chat_v2_list_sessions', {
      status: 'active', groupId: '*', limit: 10000, offset: 0,
    }),
    invoke<ChatSession[]>('chat_v2_list_sessions', {
      status: 'active', groupId: '', limit: ungroupedLimit, offset: 0,
    }),
    invoke<SessionGroup[]>('chat_v2_list_groups', { status: 'active' }),
  ]);
  const grouped = readList(groupedResult, 'grouped sessions');
  const ungrouped = readList(ungroupedResult, 'ungrouped sessions');
  const groups = readList(groupsResult, 'groups');

  useSessionListStore.setState((state) => {
    const next: Partial<SessionListStoreState> = {};
    if (sessionVersion === sessionsRevision && (grouped !== null || ungrouped !== null)) {
      // A failed partition retains its cached rows. Successful partitions remain
      // authoritative, including a legitimately empty response.
      const rowsById = new Map<string, ChatSession>();
      const cached = state.sessions.filter((session) => session.groupId ? grouped === null : ungrouped === null);
      [...cached, ...(grouped ?? []), ...(ungrouped ?? [])].forEach((session) => rowsById.set(session.id, session));
      const rows = orderRows(state.sessions, [...rowsById.values()]);
      const sessions = shareRows(state.sessions, rows);
      if (sessions !== state.sessions) next.sessions = sessions;
      if (ungrouped !== null) {
        const hasMore = ungrouped.length >= ungroupedLimit;
        if (hasMore !== state.hasMoreUngrouped) next.hasMoreUngrouped = hasMore;
      }
    }
    if (groupVersion === groupsRevision && groups !== null) {
      const sharedGroups = shareRows(state.groups, groups);
      if (sharedGroups !== state.groups) next.groups = sharedGroups;
    }
    if (!state.isLoaded && sessionVersion === sessionsRevision
      && (grouped !== null || ungrouped !== null)) next.isLoaded = true;
    return Object.keys(next).length > 0 ? next : state;
  });
  if (grouped === null && ungrouped === null) {
    throw new Error('Failed to load the session list');
  }
}

function scheduleMutationRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSessionList().catch(() => {});
  }, REFRESH_DEBOUNCE_MS);
}

function refreshSessionList(): Promise<void> {
  // Ordinary consumers join the same promise; they never request a second pass.
  if (refreshInFlight) return refreshInFlight;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  const pendingPage = loadMoreInFlight;
  refreshInFlight = (async () => {
    // Serialize list replacement after pagination so a refresh cannot drop the
    // page that the user is currently loading.
    if (pendingPage) await pendingPage.catch(() => {});
    refreshPending = false;
    let firstError: unknown;
    try {
      await executeRefresh();
    } catch (error) {
      firstError = error;
    }
    if (refreshPending) {
      refreshPending = false;
      await executeRefresh();
    } else if (firstError) {
      throw firstError;
    }
  })().finally(() => {
    refreshInFlight = null;
    // Events during the follow-up are a new burst. Keep each flight bounded to
    // two passes while still eventually observing that later mutation.
    if (refreshPending) {
      refreshPending = false;
      scheduleMutationRefresh();
    }
  });
  return refreshInFlight;
}

function ensureSessionListLoaded(): Promise<void> {
  if (refreshInFlight) return refreshInFlight;
  if (!useSessionListStore.getState().isLoaded
    || Date.now() - lastRefreshStartedAt >= VISIBILITY_REFRESH_MIN_INTERVAL_MS) {
    return refreshSessionList();
  }
  return Promise.resolve();
}

function handleMutation(): void {
  // Do not briefly publish the pre-mutation response before the trailing fetch.
  sessionsRevision += 1;
  groupsRevision += 1;
  if (refreshInFlight) refreshPending = true;
  else scheduleMutationRefresh();
}

function installGlobalListeners(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') void ensureSessionListLoaded().catch(() => {});
  };
  window.addEventListener('chat-v2:sessions-updated', handleMutation);
  window.addEventListener('chat-v2:groups-updated', handleMutation);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  return () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    window.removeEventListener('chat-v2:sessions-updated', handleMutation);
    window.removeEventListener('chat-v2:groups-updated', handleMutation);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

function loadMoreUngrouped(): Promise<void> {
  if (loadMoreInFlight) return loadMoreInFlight;
  // Capture the current refresh before publishing this pagination promise. A
  // later refresh waits for this page, so looking it up afterwards could deadlock.
  const pendingRefresh = refreshInFlight;
  loadMoreInFlight = (async () => {
    if (pendingRefresh) await pendingRefresh;
    else if (!useSessionListStore.getState().isLoaded) await refreshSessionList();
    const state = useSessionListStore.getState();
    if (!state.hasMoreUngrouped) return;
    useSessionListStore.setState({ isLoadingMore: true });
    const version = sessionsRevision;
    const offset = state.sessions.filter((session) => !session.groupId).length;
    try {
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active', groupId: '', limit: SESSION_LIST_PAGE_SIZE, offset,
      });
      if (!Array.isArray(result)) throw new Error('Invalid session list payload');
      if (version !== sessionsRevision) return;
      useSessionListStore.setState((current) => {
        const rowsById = new Map(current.sessions.map((session) => [session.id, session]));
        result.forEach((session) => rowsById.set(session.id, session));
        return {
          sessions: shareRows(current.sessions, [...rowsById.values()]),
          hasMoreUngrouped: result.length >= SESSION_LIST_PAGE_SIZE,
        };
      });
    } catch (error: unknown) {
      console.warn('[sessionListStore] Failed to load more sessions:', getErrorMessage(error));
      throw error;
    }
  })().finally(() => {
    loadMoreInFlight = null;
    useSessionListStore.setState((state) => state.isLoadingMore ? { isLoadingMore: false } : state);
  });
  return loadMoreInFlight;
}

export const useSessionListStore = create<SessionListStoreState>()((set) => ({
  sessions: [],
  groups: [],
  hasMoreUngrouped: false,
  isLoadingMore: false,
  isLoaded: false,
  refresh: refreshSessionList,
  ensureLoaded: ensureSessionListLoaded,
  loadMoreUngrouped,
  setSnapshot: (incoming, hasMoreUngrouped) => {
    sessionsRevision += 1;
    lastRefreshStartedAt = Date.now();
    set((state) => {
      const sessions = shareRows(state.sessions, incoming);
      const hasMore = hasMoreUngrouped ?? state.hasMoreUngrouped;
      return sessions === state.sessions && hasMore === state.hasMoreUngrouped && state.isLoaded
        ? state
        : { sessions, hasMoreUngrouped: hasMore, isLoaded: true };
    });
  },
  setSessions: (updater) => {
    set((state) => {
      const sessions = shareRows(state.sessions, resolveUpdater(updater, state.sessions));
      if (sessions === state.sessions) return state;
      sessionsRevision += 1;
      return { sessions };
    });
  },
  setGroups: (updater) => {
    set((state) => {
      const groups = shareRows(state.groups, resolveUpdater(updater, state.groups));
      if (groups === state.groups) return state;
      groupsRevision += 1;
      return { groups };
    });
  },
}));

/** Share listeners across desktop/mobile sidebars and the ChatV2 page. */
export function retainSessionListStore(): () => void {
  subscriberCount += 1;
  if (subscriberCount === 1) removeGlobalListeners = installGlobalListeners();
  void ensureSessionListLoaded().catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount -= 1;
    if (subscriberCount === 0) {
      removeGlobalListeners?.();
      removeGlobalListeners = null;
    }
  };
}

/**
 * Drop the cached list, the revision fences and any global listener. The store is a
 * module singleton that outlives every component, so a test file rendering several
 * sidebars would otherwise reuse the first render's rows and throttle later loads
 * for 30s. Only for test setup.
 */
export function __resetSessionListStoreForTests(): void {
  sessionsRevision += 1;
  groupsRevision += 1;
  refreshInFlight = null;
  loadMoreInFlight = null;
  refreshPending = false;
  lastRefreshStartedAt = 0;
  subscriberCount = 0;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  removeGlobalListeners?.();
  removeGlobalListeners = null;
  useSessionListStore.setState(useSessionListStore.getInitialState(), true);
}
