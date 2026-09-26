import { useEffect, useState, type RefObject } from 'react';

/** Mounted history rows may be far outside the scroll viewport in direct mode. */
export function useMessageSearchVisibility(
  messageRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return;
    }
    const target = messageRef.current;
    if (!target || typeof IntersectionObserver === 'undefined') return;
    let active = true;
    const observer = new IntersectionObserver((entries) => {
      if (!active) return;
      for (const entry of entries) {
        if (entry.target === target) setVisible(entry.isIntersecting);
      }
    }, { root: target.closest('[data-overlayscrollbars-viewport]') });
    observer.observe(target);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [messageRef, enabled]);

  // Preserve search behavior in hosts without IntersectionObserver.
  return enabled && (typeof IntersectionObserver === 'undefined' || visible);
}
