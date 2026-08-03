import { create } from 'zustand';

import type {
  SandboxOwnerKey,
  SandboxSession,
  SandboxSessionInput,
  SandboxViewportPreset,
  SandboxWorkbenchOwnerState,
  SandboxWorkbenchMode,
} from '../types';

export const LEGACY_SANDBOX_OWNER_KEY = 'sandbox:legacy';
export const SANDBOX_OWNER_ATTRIBUTE = 'data-sandbox-owner-key';

const EMPTY_OWNER_STATE: SandboxWorkbenchOwnerState = Object.freeze({
  activeSession: null,
  isOpen: false,
  viewportPreset: 'desktop',
  inspectorOpen: false,
});

let ownerSequence = 0;
let sessionSequence = 0;

export function createSandboxOwnerKey(scope = 'host'): SandboxOwnerKey {
  ownerSequence += 1;
  return `sandbox:${scope}:${ownerSequence}`;
}

export function createChatSandboxOwnerKey(sessionId: string): SandboxOwnerKey {
  return `sandbox:chat:${sessionId}`;
}

export interface SandboxWorkbenchStore extends SandboxWorkbenchOwnerState {
  ownerStates: Record<SandboxOwnerKey, SandboxWorkbenchOwnerState>;
  activeOwnerKey: SandboxOwnerKey;
  activateOwner: (ownerKey: SandboxOwnerKey) => void;
  openSession: (input: SandboxSessionInput, ownerKey?: SandboxOwnerKey) => void;
  openWorkbench: (ownerKey?: SandboxOwnerKey) => void;
  closeWorkbench: (ownerKey?: SandboxOwnerKey) => void;
  closeSession: (ownerKey?: SandboxOwnerKey) => void;
  disposeOwner: (ownerKey: SandboxOwnerKey) => void;
  refreshSession: (ownerKey?: SandboxOwnerKey) => void;
  setViewportPreset: (preset: SandboxViewportPreset, ownerKey?: SandboxOwnerKey) => void;
  setInspectorOpen: (open: boolean, ownerKey?: SandboxOwnerKey) => void;
  setWorkbenchMode: (mode: SandboxWorkbenchMode, ownerKey?: SandboxOwnerKey) => void;
}

function createSandboxSession(input: SandboxSessionInput): SandboxSession {
  const now = Date.now();
  sessionSequence += 1;
  return {
    ...input,
    id: `sandbox_${now}_${sessionSequence}`,
    mode: 'safe-preview',
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeOwnerKey(ownerKey: SandboxOwnerKey | undefined): SandboxOwnerKey | undefined {
  const normalized = ownerKey?.trim();
  return normalized || undefined;
}

function resolveOwnerKey(
  state: SandboxWorkbenchStore,
  ownerKey: SandboxOwnerKey | undefined,
): SandboxOwnerKey {
  return normalizeOwnerKey(ownerKey) ?? state.activeOwnerKey;
}

export function selectSandboxWorkbenchOwnerState(
  state: SandboxWorkbenchStore,
  ownerKey: SandboxOwnerKey,
): SandboxWorkbenchOwnerState {
  return state.ownerStates[ownerKey] ?? EMPTY_OWNER_STATE;
}

function disposeOwnerState(
  state: SandboxWorkbenchStore,
  ownerKey: SandboxOwnerKey,
): Partial<SandboxWorkbenchStore> | SandboxWorkbenchStore {
  const ownsState = Object.prototype.hasOwnProperty.call(state.ownerStates, ownerKey);
  if (!ownsState && state.activeOwnerKey !== ownerKey) return state;

  const ownerStates = { ...state.ownerStates };
  delete ownerStates[ownerKey];
  if (state.activeOwnerKey !== ownerKey) {
    return { ownerStates };
  }

  const fallbackOwnerState = ownerStates[LEGACY_SANDBOX_OWNER_KEY] ?? EMPTY_OWNER_STATE;
  return {
    ownerStates,
    activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
    ...fallbackOwnerState,
  };
}

// ownerStates is authoritative. The top-level fields mirror activeOwnerKey so
// existing single-window selectors and no-argument actions keep their behavior.
export const useSandboxWorkbenchStore = create<SandboxWorkbenchStore>((set) => ({
  ...EMPTY_OWNER_STATE,
  ownerStates: {},
  activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,

  activateOwner: (ownerKey) => {
    const normalized = normalizeOwnerKey(ownerKey);
    if (!normalized) return;

    set((state) => {
      if (state.activeOwnerKey === normalized) return state;
      const ownerState = selectSandboxWorkbenchOwnerState(state, normalized);
      return {
        activeOwnerKey: normalized,
        ...ownerState,
      };
    });
  },

  openSession: (input, ownerKey) => {
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      const ownerState: SandboxWorkbenchOwnerState = {
        activeSession: createSandboxSession(input),
        isOpen: true,
        viewportPreset: 'desktop',
        inspectorOpen: false,
      };
      return {
        ownerStates: {
          ...state.ownerStates,
          [resolvedOwnerKey]: ownerState,
        },
        activeOwnerKey: resolvedOwnerKey,
        ...ownerState,
      };
    });
  },

  openWorkbench: (ownerKey) => {
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
      if (current.isOpen) return state;
      const ownerState = { ...current, isOpen: true };
      return {
        ownerStates: { ...state.ownerStates, [resolvedOwnerKey]: ownerState },
        ...(state.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
      };
    });
  },

  closeWorkbench: (ownerKey) => {
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
      if (!current.isOpen) return state;
      const ownerState = { ...current, isOpen: false };
      return {
        ownerStates: { ...state.ownerStates, [resolvedOwnerKey]: ownerState },
        ...(state.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
      };
    });
  },

  closeSession: (ownerKey) => {
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      return disposeOwnerState(state, resolvedOwnerKey);
    });
  },

  disposeOwner: (ownerKey) => {
    const normalized = normalizeOwnerKey(ownerKey);
    if (!normalized) return;
    set((state) => disposeOwnerState(state, normalized));
  },

  refreshSession: (ownerKey) => {
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
      if (!current.activeSession) {
        return state;
      }

      const ownerState = {
        ...current,
        activeSession: {
          ...current.activeSession,
          updatedAt: Date.now(),
        },
      };
      return {
        ownerStates: { ...state.ownerStates, [resolvedOwnerKey]: ownerState },
        ...(state.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
      };
    });
  },

  setViewportPreset: (preset, ownerKey) => {
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
      if (current.viewportPreset === preset) return state;
      const ownerState = { ...current, viewportPreset: preset };
      return {
        ownerStates: { ...state.ownerStates, [resolvedOwnerKey]: ownerState },
        ...(state.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
      };
    });
  },

  setInspectorOpen: (open, ownerKey) => {
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
      if (current.inspectorOpen === open) return state;
      const ownerState = { ...current, inspectorOpen: open };
      return {
        ownerStates: { ...state.ownerStates, [resolvedOwnerKey]: ownerState },
        ...(state.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
      };
    });
  },

  setWorkbenchMode: (mode, ownerKey) => {
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
      if (!current.activeSession) {
        return state;
      }

      const ownerState = {
        ...current,
        activeSession: {
          ...current.activeSession,
          mode,
          updatedAt: Date.now(),
        },
      };
      return {
        ownerStates: { ...state.ownerStates, [resolvedOwnerKey]: ownerState },
        ...(state.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
      };
    });
  },
}));
