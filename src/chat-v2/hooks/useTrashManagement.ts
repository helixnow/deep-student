import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from '@/utils/errorUtils';
import type { ChatSession } from './useSessionManagement';

export function useTrashManagement(
  setSessions: React.Dispatch<React.SetStateAction<ChatSession[]>>,
  setCurrentSessionId: (id: string | null | ((prev: string | null) => string | null)) => void
) {
  const [showTrash, setShowTrash] = useState(false);
  const [deletedSessions, setDeletedSessions] = useState<ChatSession[]>([]);
  const [isLoadingTrash, setIsLoadingTrash] = useState(false);
  const [showEmptyTrashConfirm, setShowEmptyTrashConfirm] = useState(false);

  const loadDeletedSessions = useCallback(async () => {
    setIsLoadingTrash(true);
    try {
      const result = await invoke<ChatSession[]>('chat_v2_list_sessions', {
        status: 'deleted',
        limit: 100,
        offset: 0,
      });
      setDeletedSessions(result);
    } catch (error: unknown) {
      console.error('[useTrashManagement] Failed to load deleted sessions:', getErrorMessage(error));
    } finally {
      setIsLoadingTrash(false);
    }
  }, []);

  const restoreSession = useCallback(async (sessionId: string) => {
    try {
      const restoredSession = await invoke<ChatSession>('chat_v2_restore_session', { sessionId });
      setDeletedSessions((prev) => prev.filter((s) => s.id !== sessionId));
      setSessions((prev) => [restoredSession, ...prev]);
      setCurrentSessionId(restoredSession.id);
      setShowTrash(false);
    } catch (error: unknown) {
      console.error('[useTrashManagement] Failed to restore session:', getErrorMessage(error));
    }
  }, [setSessions, setCurrentSessionId]);

  const permanentlyDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await invoke('chat_v2_delete_session', { sessionId });
      setDeletedSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch (error: unknown) {
      console.error('[useTrashManagement] Failed to permanently delete session:', getErrorMessage(error));
    }
  }, []);

  const emptyTrash = useCallback(async () => {
    if (deletedSessions.length === 0) return;
    try {
      for (const session of deletedSessions) {
        await invoke('chat_v2_delete_session', { sessionId: session.id });
      }
      setDeletedSessions([]);
    } catch (error: unknown) {
      console.error('[useTrashManagement] Failed to empty trash:', getErrorMessage(error));
    }
  }, [deletedSessions]);

  const toggleTrash = useCallback(() => {
    setShowTrash((prev) => {
      const newValue = !prev;
      if (newValue) {
        loadDeletedSessions();
      }
      return newValue;
    });
  }, [loadDeletedSessions]);

  return {
    showTrash,
    setShowTrash,
    deletedSessions,
    isLoadingTrash,
    showEmptyTrashConfirm,
    setShowEmptyTrashConfirm,
    loadDeletedSessions,
    restoreSession,
    permanentlyDeleteSession,
    emptyTrash,
    toggleTrash,
  };
}
