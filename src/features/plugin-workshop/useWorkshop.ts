import { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '@/utils/errorUtils';
import { workshopActions, type WorkshopAction, type WorkshopAdapter, type WorkshopItem } from './types';

/** Host remains authoritative; a failed RPC must not optimistically claim rollback or cancellation. */
export function useWorkshop(adapter: WorkshopAdapter) {
  const [items, setItems] = useState<WorkshopItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [exportPath, setExportPath] = useState<string>();
  const busy = useRef(false);
  const refreshSequence = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const next = await adapter.list();
      if (mounted.current && sequence === refreshSequence.current) {
        setItems(next);
        setError(undefined);
      }
    } catch (cause) {
      if (mounted.current && sequence === refreshSequence.current) setError(getErrorMessage(cause));
    } finally {
      if (mounted.current && sequence === refreshSequence.current) setLoading(false);
    }
  }, [adapter]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = adapter.subscribe(() => { void refresh(); });
    void refresh();
    return () => { mounted.current = false; ++refreshSequence.current; unsubscribe(); };
  }, [adapter, refresh]);

  const act = useCallback(async (action: WorkshopAction, item: WorkshopItem) => {
    if (busy.current || !workshopActions(item.phase).includes(action)) return;
    busy.current = true;
    setBusyId(item.id);
    setError(undefined);
    setExportPath(undefined);
    ++refreshSequence.current;
    try {
      const result = await adapter.act(action, item);
      if (mounted.current) {
        ++refreshSequence.current;
        setItems(current => current.map(entry => entry.id === item.id ? result.item : entry));
        setExportPath(result.exportPath);
      }
    } catch (cause) {
      // Unknown result: refresh before allowing another user action.
      await refresh();
      if (mounted.current) setError(getErrorMessage(cause));
    } finally {
      busy.current = false;
      if (mounted.current) setBusyId(undefined);
    }
  }, [adapter, refresh]);
  return { items, loading, error, busyId, exportPath, refresh, act };
}
