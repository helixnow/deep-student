import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import { sessionManager } from '../core/session/sessionManager';
import { SESSION_LIST_PAGE_SIZE } from '../core/constants';
import { createSessionWithDefaults } from '../core/session/createSessionWithDefaults';
import type { ChatSession } from '../types/session';

export type { ChatSession } from '../types/session';

const LAST_SESSION_KEY = 'chat-v2-last-session-id';

export type TimeGroup = 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'older';

export const getTimeGroup = (isoString: string): TimeGroup => {
  const date = new Date(isoString);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
  const startOf7DaysAgo = new Date(startOfToday.getTime() - 7 * 86400000);
  const startOf30DaysAgo = new Date(startOfToday.getTime() - 30 * 86400000);

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
      await invoke('chat_v2_soft_delete_session', { sessionId });
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
