import { createContext, useContext } from 'react';
import type { CurrentView } from '@/types/navigation';

interface DesktopShellHeaderPortalContextValue {
  target: HTMLElement | null;
  currentView: CurrentView;
}

const DesktopShellHeaderPortalContext = createContext<DesktopShellHeaderPortalContextValue | null>(null);

export const DesktopShellHeaderPortalProvider = DesktopShellHeaderPortalContext.Provider;

export function useDesktopShellHeaderPortal(view: CurrentView): HTMLElement | null {
  const context = useContext(DesktopShellHeaderPortalContext);
  if (!context || context.currentView !== view) {
    return null;
  }
  return context.target;
}
