import { useState, useCallback, useRef, useEffect } from 'react';

export function useDeleteConfirmation() {
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const deleteConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearDeleteConfirmTimeout = useCallback(() => {
    if (!deleteConfirmTimeoutRef.current) return;
    clearTimeout(deleteConfirmTimeoutRef.current);
    deleteConfirmTimeoutRef.current = null;
  }, []);

  const resetDeleteConfirmation = useCallback(() => {
    setPendingDeleteSessionId(null);
    clearDeleteConfirmTimeout();
  }, [clearDeleteConfirmTimeout]);

  const requestDeleteConfirmation = useCallback((sessionId: string) => {
    if (pendingDeleteSessionId === sessionId) {
      return true;
    }
    setPendingDeleteSessionId(sessionId);
    clearDeleteConfirmTimeout();
    deleteConfirmTimeoutRef.current = setTimeout(() => {
      resetDeleteConfirmation();
    }, 2500);
    return false;
  }, [pendingDeleteSessionId, clearDeleteConfirmTimeout, resetDeleteConfirmation]);

  useEffect(() => clearDeleteConfirmTimeout, [clearDeleteConfirmTimeout]);

  return {
    pendingDeleteSessionId,
    resetDeleteConfirmation,
    requestDeleteConfirmation,
  };
}
