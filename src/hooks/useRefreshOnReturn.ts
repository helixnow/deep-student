import { useEffect, useRef } from 'react';

/** Revalidate mounted views when the user returns or the network comes back. */
export function useRefreshOnReturn(refresh: () => unknown, enabled = true): void {
  const latest = useRef(refresh);
  useEffect(() => { latest.current = refresh; }, [refresh]);
  useEffect(() => {
    if (!enabled) return;
    const onReturn = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        await latest.current();
      } catch (error) {
        console.error(error);
      }
    };
    window.addEventListener('focus', onReturn);
    window.addEventListener('online', onReturn);
    return () => {
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('online', onReturn);
    };
  }, [enabled]);
}
