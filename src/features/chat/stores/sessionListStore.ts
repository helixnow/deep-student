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
  setSessions: (updater: StateUpdater<ChatSession[]>) => void;
  setGroups: (updater: StateUpdater<SessionGroup[]>) => void;
}

const SIDEBAR_REFRESH_DEBOUNCE_MS = 120;
const SIDEBAR_VISIBILITY_REFRESH_MIN_INTERVAL_MS = 30_000;

let sessionsFingerprint = '';
let groupsFingerprint = '';
let refreshGeneration = 0;
let refreshInFlight: Promise<void> | null = null;
let refreshPending = false;
let loadingMore = false;
let lastRefreshStartedAt = 0;

let subscriberCount = 0;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let removeGlobalListeners: (() => void) | null = null;

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function hashValue(value: unknown): string {
  const serialized = stableSerialize(value);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${serialized.length}:${(hash >>> 0).toString(36)}`;
}

function fingerprintSessions(sessions: ChatSession[]): string {
  // 只覆盖侧栏实际消费的字段，避免对最多 10k 条会话的完整 metadata
  // 做深度排序/序列化；pinned 与 is_subagent 必须保留在指纹中。
  return hashValue(sessions.map((session) => [
    session.id,
    session.mode,
    session.title ?? '',
    session.createdAt,
    session.updatedAt,
    session.groupId ?? '',
    session.persistStatus ?? '',
    session.metadata?.pinned === true,
    session.metadata?.is_subagent === true,
  ]));
}

function fingerprintGroups(groups: SessionGroup[]): string {
  return hashValue(groups.map((group) => [
    group.id,
    group.name,
    group.icon ?? '',
    group.color ?? '',
    group.sortOrder,
    group.persistStatus,
    group.updatedAt,
  ]));
}

function resolveUpdater<T>(updater: StateUpdater<T>, previous: T): T {
  return typeof updater === 'function'
    ? (updater as (value: T) => T)(previous)
    : updater;
}

async function executeRefresh(): Promise<void> {
  const generation = ++refreshGeneration;
  lastRefreshStartedAt = Date.now();

  const [groupedResult, ungroupedResult, groupsResult] = await Promise.allSettled([
    invoke<ChatSession[]>('chat_v2_list_sessions', {
      status: 'active',
      groupId: '*',
      limit: 10000,
      offset: 0,
    }),
    invoke<ChatSession[]>('chat_v2_list_sessions', {
      status: 'active',
      groupId: '',
      limit: SESSION_LIST_PAGE_SIZE,
      offset: 0,
    }),
    invoke<SessionGroup[]>('chat_v2_list_groups', { status: 'active' }),
  ]);

  if (generation !== refreshGeneration) return;

  const grouped = groupedResult.status === 'fulfilled' && Array.isArray(groupedResult.value)
    ? groupedResult.value
    : null;
  const ungrouped = ungroupedResult.status === 'fulfilled' && Array.isArray(ungroupedResult.value)
    ? ungroupedResult.value
    : null;

  if (grouped || ungrouped) {
    const mergedById = new Map<string, ChatSession>();
    [...(grouped ?? []), ...(ungrouped ?? [])].forEach((session) => {
      mergedById.set(session.id, session);
    });
    const merged = [...mergedById.values()]
      .sort((left, right) => (right.updatedAt ?? '').localeCompare(left.updatedAt ?? ''));
    const nextFingerprint = fingerprintSessions(merged);
    const hasMoreUngrouped = (ungrouped?.length ?? 0) >= SESSION_LIST_PAGE_SIZE;

    useSessionListStore.setState((state) => {
      const nextState: Partial<SessionListStoreState> = {};
      let changed = false;
      if (nextFingerprint !== sessionsFingerprint) {
        sessionsFingerprint = nextFingerprint;
        nextState.sessions = merged;
        changed = true;
      }
      if (state.hasMoreUngrouped !== hasMoreUngrouped) {
        nextState.hasMoreUngrouped = hasMoreUngrouped;
        changed = true;
      }
      return changed ? nextState : state;
    });
  } else {
    console.warn(
      '[sessionListStore] Failed to load sessions:',
      groupedResult.status === 'rejected'
        ? getErrorMessage(groupedResult.reason)
        : 'invalid payload',
    );
  }

  if (groupsResult.status === 'fulfilled' && Array.isArray(groupsResult.value)) {
    const nextFingerprint = fingerprintGroups(groupsResult.value);
    if (nextFingerprint !== groupsFingerprint) {
      groupsFingerprint = nextFingerprint;
      useSessionListStore.setState({ groups: groupsResult.value });
    }
  } else {
    console.warn(
      '[sessionListStore] Failed to load groups:',
      groupsResult.status === 'rejected'
        ? getErrorMessage(groupsResult.reason)
        : 'invalid payload',
    );
  }

  if (!useSessionListStore.getState().isLoaded) {
    useSessionListStore.setState({ isLoaded: true });
  }
}

async function refreshSessionList(): Promise<void> {
  if (refreshInFlight) {
    refreshPending = true;
    await refreshInFlight;
    return;
  }

  refreshInFlight = (async () => {
    do {
      refreshPending = false;
      await executeRefresh();
    } while (refreshPending);
  })();

  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function scheduleEventRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshSessionList();
  }, SIDEBAR_REFRESH_DEBOUNCE_MS);
}

function installGlobalListeners(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastRefreshStartedAt < SIDEBAR_VISIBILITY_REFRESH_MIN_INTERVAL_MS) return;
    scheduleEventRefresh();
  };

  window.addEventListener('chat-v2:sessions-updated', scheduleEventRefresh);
  window.addEventListener('chat-v2:groups-updated', scheduleEventRefresh);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    window.removeEventListener('chat-v2:sessions-updated', scheduleEventRefresh);
    window.removeEventListener('chat-v2:groups-updated', scheduleEventRefresh);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

export const useSessionListStore = create<SessionListStoreState>()((set, get) => ({
  sessions: [],
  groups: [],
  hasMoreUngrouped: false,
  isLoadingMore: false,
  isLoaded: false,

  refresh: refreshSessionList,

  loadMoreUngrouped: async () => {
    if (loadingMore) return;
    loadingMore = true;
    set({ isLoadingMore: true });

    try {
      const offset = get().sessions.filter((session) => !session.groupId).length;
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
        groupId: '',
        limit: SESSION_LIST_PAGE_SIZE,
        offset,
      });

      if (Array.isArray(result) && result.length > 0) {
        get().setSessions((previous) => {
          const knownIds = new Set(previous.map((session) => session.id));
          const additions = result.filter((session) => !knownIds.has(session.id));
          return additions.length > 0 ? [...previous, ...additions] : previous;
        });
      }
      const hasMoreUngrouped = Array.isArray(result) && result.length >= SESSION_LIST_PAGE_SIZE;
      set((state) => state.hasMoreUngrouped === hasMoreUngrouped
        ? state
        : { hasMoreUngrouped });
    } catch (error: unknown) {
      console.warn('[sessionListStore] Failed to load more sessions:', getErrorMessage(error));
    } finally {
      loadingMore = false;
      set({ isLoadingMore: false });
    }
  },

  setSessions: (updater) => {
    set((state) => {
      const sessions = resolveUpdater(updater, state.sessions);
      if (sessions === state.sessions) return state;
      sessionsFingerprint = fingerprintSessions(sessions);
      return { sessions };
    });
  },

  setGroups: (updater) => {
    set((state) => {
      const groups = resolveUpdater(updater, state.groups);
      if (groups === state.groups) return state;
      groupsFingerprint = fingerprintGroups(groups);
      return { groups };
    });
  },
}));

/**
 * 引用计数式启动共享监听。多个侧栏实例只安装一套全局事件监听，
 * 最后一个消费方卸载时再清理；列表数据本身继续保留在模块级 store 中。
 */
export function retainSessionListStore(): () => void {
  subscriberCount += 1;
  if (subscriberCount === 1) {
    removeGlobalListeners = installGlobalListeners();
  }

  const state = useSessionListStore.getState();
  const needsInitialRefresh = !state.isLoaded && refreshInFlight === null;
  const needsStaleRefresh = state.isLoaded
    && Date.now() - lastRefreshStartedAt >= SIDEBAR_VISIBILITY_REFRESH_MIN_INTERVAL_MS;
  if (needsInitialRefresh || needsStaleRefresh) {
    void state.refresh();
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0) {
      removeGlobalListeners?.();
      removeGlobalListeners = null;
    }
  };
}
