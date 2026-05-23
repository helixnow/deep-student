import { create } from 'zustand';

import type {
  SandboxSession,
  SandboxSessionInput,
  SandboxViewportPreset,
  SandboxWorkbenchMode,
} from '../types';

interface SandboxWorkbenchStore {
  activeSession: SandboxSession | null;
  isOpen: boolean;
  viewportPreset: SandboxViewportPreset;
  inspectorOpen: boolean;
  openSession: (input: SandboxSessionInput) => void;
  openWorkbench: () => void;
  closeWorkbench: () => void;
  closeSession: () => void;
  refreshSession: () => void;
  setViewportPreset: (preset: SandboxViewportPreset) => void;
  setInspectorOpen: (open: boolean) => void;
  setWorkbenchMode: (mode: SandboxWorkbenchMode) => void;
}

function createSandboxSession(input: SandboxSessionInput): SandboxSession {
  const now = Date.now();
  return {
    ...input,
    id: `sandbox_${now}`,
    mode: 'safe-preview',
    createdAt: now,
    updatedAt: now,
  };
}

export const useSandboxWorkbenchStore = create<SandboxWorkbenchStore>((set) => ({
  activeSession: null,
  isOpen: false,
  viewportPreset: 'desktop',
  inspectorOpen: false,

  openSession: (input) => {
    set({
      activeSession: createSandboxSession(input),
      isOpen: true,
      viewportPreset: 'desktop',
      inspectorOpen: false,
    });
  },

  openWorkbench: () => {
    set({ isOpen: true });
  },

  closeWorkbench: () => {
    set({ isOpen: false });
  },

  closeSession: () => {
    set({ activeSession: null, isOpen: false });
  },

  refreshSession: () => {
    set((state) => {
      if (!state.activeSession) {
        return state;
      }

      return {
        activeSession: {
          ...state.activeSession,
          updatedAt: Date.now(),
        },
      };
    });
  },

  setViewportPreset: (preset) => {
    set({ viewportPreset: preset });
  },

  setInspectorOpen: (open) => {
    set({ inspectorOpen: open });
  },

  setWorkbenchMode: (mode) => {
    set((state) => {
      if (!state.activeSession) {
        return state;
      }

      return {
        activeSession: {
          ...state.activeSession,
          mode,
          updatedAt: Date.now(),
        },
      };
    });
  },
}));
