import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { sessionManager } from '../core/session/sessionManager';
import { SESSION_LIST_PAGE_SIZE } from '../core/constants';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import type { ChatSession } from '../types/session';
import type { SessionGroup } from '../types/group';

export type { ChatSession } from '../types/session';

const LAST_SESSION_KEY = 'chat-v2-last-session-id';

export type TimeGroup = 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older';

// 使用日历运算（而非固定 86400000ms 偏移）计算本地日界，避免夏令时切换日产生 1 小时偏差
export const getTimeGroup = (isoString: string): TimeGroup => {
  const date = new Date(isoString);
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const startOfToday = new Date(year, month, day);
  const startOfYesterday = new Date(year, month, day - 1);
  const startOf7DaysAgo = new Date(year, month, day - 7);
  const startOf30DaysAgo = new Date(year, month, day - 30);

  if (date >= startOfToday) return 'today';
  if (date >= startOfYesterday) return 'yesterday';
  if (date >= startOf7DaysAgo) return 'previous7Days';
  if (date >= startOf30DaysAgo) return 'previous30Days';
  return 'older';
};

export const groupSessionsByTime = (sessions: ChatSession[]): Map<TimeGroup, ChatSession[]> => {
  const groups = new Map<TimeGroup, ChatSession[]>();
  const order: TimeGroup[] = ['today', 'yesterday', 'previous7Days', 'previous30Days', 'older'];
  order.forEach(g => groups.set(g, []));
  
  sessions.forEach(session => {
    const group = getTimeGroup(session.updatedAt);
    groups.get(group)?.push(session);
  });
  
  return groups;
};

// ============================================================================
// 侧栏共享会话列表数据源（桌面 ModernSidebar 与 ChatV2 移动侧栏统一策略）
//
// 与 useSessionLifecycle.loadSessions 相同的查询策略：
// - 已分组会话全量（groupId='*'）
// - 未分组会话分页（SESSION_LIST_PAGE_SIZE）
// 并订阅 chat-v2:sessions-updated / chat-v2:groups-updated / window focus，
// 保证任意表面的增删改都会让消费方收敛到同一份数据。
// ============================================================================

export interface SidebarSessionData {
  sessions: ChatSession[];
  groups: SessionGroup[];
  /** 未分组会话是否还有更多分页 */
  hasMoreUngrouped: boolean;
  isLoadingMore: boolean;
  /** 首次加载是否已完成（无论成败） */
  isLoaded: boolean;
  loadMoreUngrouped: () => Promise<void>;
  refresh: () => Promise<void>;
  /** 供消费方做乐观更新（置顶/重命名/归档/删除后立即反映到 UI） */
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>;
  setGroups: React.Dispatch<React.SetStateAction<SessionGroup[]>>;
}

const SIDEBAR_REFRESH_DEBOUNCE_MS = 120;

export function useSidebarSessionData(): SidebarSessionData {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [groups, setGroups] = useState<SessionGroup[]>([]);
  const [hasMoreUngrouped, setHasMoreUngrouped] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // generation 防乱序：仅接受最后一次 refresh 的结果
  const refreshGenerationRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
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

    if (generation !== refreshGenerationRef.current) return;

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
      const merged = [...mergedById.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      setSessions(merged);
      setHasMoreUngrouped((ungrouped?.length ?? 0) >= SESSION_LIST_PAGE_SIZE);
    } else {
      console.warn('[useSidebarSessionData] Failed to load sessions:',
        groupedResult.status === 'rejected' ? getErrorMessage(groupedResult.reason) : 'invalid payload');
    }

    if (groupsResult.status === 'fulfilled' && Array.isArray(groupsResult.value)) {
      setGroups(groupsResult.value);
    } else {
      console.warn('[useSidebarSessionData] Failed to load groups:',
        groupsResult.status === 'rejected' ? getErrorMessage(groupsResult.reason) : 'invalid payload');
    }

    setIsLoaded(true);
  }, []);

  const loadMoreUngrouped = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      // 动态用当前未分组数量做 offset，避免删除/移动后跳过会话
      const offset = sessionsRef.current.filter((s) => !s.groupId).length;
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
        groupId: '',
        limit: SESSION_LIST_PAGE_SIZE,
        offset,
      });
      if (Array.isArray(result) && result.length > 0) {
        setSessions((prev) => {
          const known = new Set(prev.map((s) => s.id));
          return [...prev, ...result.filter((s) => !known.has(s.id))];
        });
      }
      setHasMoreUngrouped(Array.isArray(result) && result.length >= SESSION_LIST_PAGE_SIZE);
    } catch (error: unknown) {
      console.warn('[useSidebarSessionData] Failed to load more sessions:', getErrorMessage(error));
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void refresh();

    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, SIDEBAR_REFRESH_DEBOUNCE_MS);
    };

    window.addEventListener('chat-v2:sessions-updated', scheduleRefresh);
    window.addEventListener('chat-v2:groups-updated', scheduleRefresh);
    window.addEventListener('focus', scheduleRefresh);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('chat-v2:sessions-updated', scheduleRefresh);
      window.removeEventListener('chat-v2:groups-updated', scheduleRefresh);
      window.removeEventListener('focus', scheduleRefresh);
    };
  }, [refresh]);

  return {
    sessions,
    groups,
    hasMoreUngrouped,
    isLoadingMore,
    isLoaded,
    loadMoreUngrouped,
    refresh,
    setSessions,
    setGroups,
  };
}

/**
 * @deprecated 遗留双轨 hook：无页面消费（仅 hooks/index.ts 再导出）。
 * 会话列表请使用 `useSidebarSessionData`（侧栏共享数据源）或
 * `pages/useSessionLifecycle`（ChatV2 页面编排）。保留导出仅为兼容。
 */
export function useSessionManagement() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionIdState] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMoreSessions, setHasMoreSessions] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const setCurrentSessionId = useCallback((sessionIdOrUpdater: string | null | ((prev: string | null) => string | null)) => {
    setCurrentSessionIdState((prev) => {
      const newId = typeof sessionIdOrUpdater === 'function' ? sessionIdOrUpdater(prev) : sessionIdOrUpdater;
      sessionManager.setCurrentSessionId(newId);
      if (newId) {
        try {
          localStorage.setItem(LAST_SESSION_KEY, newId);
        } catch {
        }
      }
      return newId;
    });
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
        limit: SESSION_LIST_PAGE_SIZE,
        offset: 0,
      });
      setSessions(result);
      setHasMoreSessions(result.length >= SESSION_LIST_PAGE_SIZE);

      let sessionToSelect: string | null = null;
      try {
        const lastSessionId = localStorage.getItem(LAST_SESSION_KEY);
        if (lastSessionId && result.some(s => s.id === lastSessionId)) {
          sessionToSelect = lastSessionId;
        } else if (lastSessionId) {
          localStorage.removeItem(LAST_SESSION_KEY);
        }
      } catch {
      }

      if (!sessionToSelect && result.length > 0) {
        sessionToSelect = result[0].id;
      }

      setCurrentSessionId(sessionToSelect);
    } catch (error: unknown) {
      console.error('[useSessionManagement] Failed to load sessions:', getErrorMessage(error));
    }
  }, [setCurrentSessionId]);

  const loadMoreSessions = useCallback(async () => {
    if (isLoadingMore || !hasMoreSessions) return;

    setIsLoadingMore(true);
    try {
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'active',
        limit: SESSION_LIST_PAGE_SIZE,
        offset: sessions.length,
      });

      if (result.length > 0) {
        setSessions(prev => [...prev, ...result]);
      }
      setHasMoreSessions(result.length >= SESSION_LIST_PAGE_SIZE);
    } catch (error: unknown) {
      console.error('[useSessionManagement] Failed to load more sessions:', getErrorMessage(error));
    } finally {
      setIsLoadingMore(false);
    }
  }, [sessions.length, isLoadingMore, hasMoreSessions]);

  const createSession = useCallback(async () => {
    setIsLoading(true);
    try {
      const session = await createSessionWithDefaults({
        mode: 'chat',
        title: null,
        metadata: null,
      });

      setSessions((prev) => [session, ...prev]);
      setCurrentSessionId(session.id);
    } catch (error: unknown) {
      console.error('[useSessionManagement] Failed to create session:', getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  }, [setCurrentSessionId]);

  const deleteSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('chat_v2_delete_session', { sessionId });
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));

      try {
        const lastSessionId = localStorage.getItem(LAST_SESSION_KEY);
        if (lastSessionId === sessionId) {
          localStorage.removeItem(LAST_SESSION_KEY);
        }
      } catch {
      }

      setCurrentSessionId((prevId) => {
        if (prevId === sessionId) {
          const remaining = sessionsRef.current.filter((s) => s.id !== sessionId);
          return remaining.length > 0 ? remaining[0].id : null;
        }
        return prevId;
      });
    } catch (error: unknown) {
      console.error('[useSessionManagement] Failed to delete session:', getErrorMessage(error));
    }
  }, [setCurrentSessionId]);

  const renameSession = useCallback(async (sessionId: string, newTitle: string) => {
    try {
      await invoke('chat_v2_update_session_settings', {
        sessionId,
        settings: { title: newTitle },
      });
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, title: newTitle } : s))
      );
    } catch (error: unknown) {
      console.error('[useSessionManagement] Failed to rename session:', getErrorMessage(error));
      throw error;
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  return {
    sessions,
    setSessions,
    currentSessionId,
    setCurrentSessionId,
    isLoading,
    setIsLoading,
    hasMoreSessions,
    isLoadingMore,
    sessionsRef,
    loadSessions,
    loadMoreSessions,
    createSession,
    deleteSession,
    renameSession,
  };
}
