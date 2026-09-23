import { createContext, useContext, useLayoutEffect, useRef, type DependencyList } from 'react';
import type { MobileHeaderConfig } from '@/components/layout/MobileHeaderContext';

export type FlashcardsMobileChrome = Pick<MobileHeaderConfig, 'title' | 'subtitle' | 'rightActions'> & {
  /** Omitted for drawer destinations; present for composer/review/edit subpages. */
  onBack?: () => void;
};

// Only FlashcardsApp writes the global viewId. Screens publish their local actions
// to this host; a null provider preserves desktop/standalone screen rendering.
export const FlashcardsMobileChromeContext = createContext<
  ((chrome: FlashcardsMobileChrome | null) => void) | null
>(null);

export function useFlashcardsMobileChrome(chrome: FlashcardsMobileChrome, deps: DependencyList): boolean {
  const publish = useContext(FlashcardsMobileChromeContext);
  const chromeRef = useRef(chrome);
  chromeRef.current = chrome;

  useLayoutEffect(() => {
    publish?.(chromeRef.current);
    // Match useMobileHeader: callers declare the state used by title/actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publish, ...deps]);
  useLayoutEffect(() => () => publish?.(null), [publish]);
  return publish !== null;
}
