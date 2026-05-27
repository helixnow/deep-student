import { createContext, useContext } from 'react';
import type { CurrentView } from '@/types/navigation';

interface DesktopShellSidebarPortalContextValue {
  target: HTMLElement | null;
  currentView: CurrentView;
}

const DesktopShellSidebarPortalContext = createContext<DesktopShellSidebarPortalContextValue | null>(null);

export const DesktopShellSidebarPortalProvider = DesktopShellSidebarPortalContext.Provider;

export function useDesktopShellSidebarPortal(view: CurrentView): HTMLElement | null {
  const context = useContext(DesktopShellSidebarPortalContext);
  if (!context || context.currentView !== view) {
    return null;
  }
  return context.target;
}
