import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DESKTOP_SHELL } from '@/app/shell/desktopShell';

interface UIState {
  leftPanelCollapsed: boolean;
  leftPanelWidth: number;
  toggleLeftPanel: () => void;
  setLeftPanelCollapsed: (collapsed: boolean) => void;
  setLeftPanelWidth: (width: number) => void;
}

interface PersistedUIState {
  leftPanelCollapsed: boolean;
  leftPanelWidth: number;
}

const LEGACY_DEFAULT_SIDEBAR_WIDTH = 272;

export function migratePersistedUIState(
  persistedState: unknown,
  version: number
): PersistedUIState {
  const state = persistedState && typeof persistedState === 'object'
    ? persistedState as Partial<PersistedUIState>
    : {};
  const persistedWidth = typeof state.leftPanelWidth === 'number'
    ? state.leftPanelWidth
    : DESKTOP_SHELL.navigationWidth;

  return {
    leftPanelCollapsed: typeof state.leftPanelCollapsed === 'boolean'
      ? state.leftPanelCollapsed
      : false,
    leftPanelWidth: version < 1 && persistedWidth === LEGACY_DEFAULT_SIDEBAR_WIDTH
      ? DESKTOP_SHELL.navigationWidth
      : persistedWidth,
  };
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      leftPanelCollapsed: false,
      leftPanelWidth: DESKTOP_SHELL.navigationWidth,
      toggleLeftPanel: () => set((state) => ({ leftPanelCollapsed: !state.leftPanelCollapsed })),
      setLeftPanelCollapsed: (collapsed) => set({ leftPanelCollapsed: collapsed }),
      setLeftPanelWidth: (width) => set({ leftPanelWidth: width }),
    }),
    {
      name: 'dstu-ui-store',
      version: 1,
      migrate: migratePersistedUIState,
      partialize: (state) => ({
        leftPanelCollapsed: state.leftPanelCollapsed,
        leftPanelWidth: state.leftPanelWidth,
      }),
    }
  )
);
