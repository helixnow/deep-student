import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
  leftPanelCollapsed: boolean;
  toggleLeftPanel: () => void;
  setLeftPanelCollapsed: (collapsed: boolean) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      leftPanelCollapsed: false,
      toggleLeftPanel: () => set((state) => ({ leftPanelCollapsed: !state.leftPanelCollapsed })),
      setLeftPanelCollapsed: (collapsed) => set({ leftPanelCollapsed: collapsed }),
    }),
    {
      name: 'dstu-ui-store',
      partialize: (state) => ({ leftPanelCollapsed: state.leftPanelCollapsed }),
    }
  )
);
