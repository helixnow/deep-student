import { create } from 'zustand';

import {
  registerPinnedArtifactHostLauncher,
  usePinnedArtifactStore,
} from '@/stores/pinnedArtifactStore';
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

export function findSandboxOwnerFromActiveElement(): SandboxOwnerKey | undefined {
  if (typeof document === 'undefined') return undefined;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof Element)) return undefined;
  const ownerHost = activeElement.closest(`[${SANDBOX_OWNER_ATTRIBUTE}]`);
  return ownerHost?.getAttribute(SANDBOX_OWNER_ATTRIBUTE)?.trim() || undefined;
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
  const resolvedMode: SandboxWorkbenchMode =
    input.initialMode ?? (input.artifactKind === 'html' ? 'sandbox-run' : 'safe-preview');
  return {
    ...input,
    id: `sandbox_${now}_${sessionSequence}`,
    mode: resolvedMode,
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

export function resolveTargetSandboxOwnerKey(
  state: Pick<SandboxWorkbenchStore, 'activeOwnerKey'>,
  ownerKey?: SandboxOwnerKey,
  sessionId?: string,
): SandboxOwnerKey {
  const explicit = normalizeOwnerKey(ownerKey);
  if (explicit) return explicit;
  if (state.activeOwnerKey !== LEGACY_SANDBOX_OWNER_KEY) {
    return state.activeOwnerKey;
  }
  const fromDom = findSandboxOwnerFromActiveElement();
  if (fromDom) return fromDom;
  const trimmedSession = sessionId?.trim();
  if (trimmedSession) {
    return createChatSandboxOwnerKey(trimmedSession);
  }
  return LEGACY_SANDBOX_OWNER_KEY;
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
export const useSandboxWorkbenchStore = create<SandboxWorkbenchStore>((set, get) => ({
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
    const currentState = get();
    const resolvedOwnerKey = resolveOwnerKey(currentState, ownerKey);
    const prevOwnerState = selectSandboxWorkbenchOwnerState(currentState, resolvedOwnerKey);
    set((state) => {
      const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
      if (current.isOpen) return state;
      const ownerState = { ...current, isOpen: true };
      return {
        ownerStates: { ...state.ownerStates, [resolvedOwnerKey]: ownerState },
        ...(state.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
      };
    });
    if (prevOwnerState.activeSession?.artifactId) {
      usePinnedArtifactStore
        .getState()
        .reactivateOwnerArtifact(
          resolvedOwnerKey,
          prevOwnerState.activeSession.artifactId,
          prevOwnerState.activeSession.sessionId,
        );
    }
  },

  closeWorkbench: (ownerKey) => {
    const currentState = get();
    const resolvedOwnerKey = resolveOwnerKey(currentState, ownerKey);
    const prevSession = selectSandboxWorkbenchOwnerState(currentState, resolvedOwnerKey).activeSession;
    set((state) => {
      const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
      if (!current.isOpen) return state;
      const ownerState = { ...current, isOpen: false };
      return {
        ownerStates: { ...state.ownerStates, [resolvedOwnerKey]: ownerState },
        ...(state.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
      };
    });
    usePinnedArtifactStore
      .getState()
      .deactivateOwnerArtifacts(resolvedOwnerKey, prevSession?.sessionId);
  },

  closeSession: (ownerKey) => {
    const currentState = get();
    const resolvedOwnerKey = resolveOwnerKey(currentState, ownerKey);
    const prevSession = selectSandboxWorkbenchOwnerState(currentState, resolvedOwnerKey).activeSession;
    set((state) => disposeOwnerState(state, resolvedOwnerKey));
    usePinnedArtifactStore
      .getState()
      .deactivateOwnerArtifacts(resolvedOwnerKey, prevSession?.sessionId);
  },

  disposeOwner: (ownerKey) => {
    const normalized = normalizeOwnerKey(ownerKey);
    if (!normalized) return;
    const prevSession = selectSandboxWorkbenchOwnerState(get(), normalized).activeSession;
    set((state) => disposeOwnerState(state, normalized));
    usePinnedArtifactStore
      .getState()
      .deactivateOwnerArtifacts(normalized, prevSession?.sessionId);
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

registerPinnedArtifactHostLauncher((input) => {
  const workbenchState = useSandboxWorkbenchStore.getState();
  const resolvedOwnerKey = resolveTargetSandboxOwnerKey(
    workbenchState,
    input.ownerKey,
    input.sessionId,
  );
  const record = usePinnedArtifactStore.getState().upsertPinnedArtifact({
    ...input,
    ownerKey: resolvedOwnerKey,
  });
  const activeRev =
    record.revisions.find((r) => r.version === record.activeVersion) ??
    record.revisions[record.revisions.length - 1];
  workbenchState.openSession(
    {
      sourceType: input.kind === 'generative-ui' ? 'chat-generative-ui' : 'chat-code-block',
      sourceMessageId: record.sourceMessageId,
      language: record.language,
      title: record.title,
      content: activeRev?.content ?? input.content,
      artifactKind: record.kind,
      widgetId: record.widgetId,
      sessionId: record.sessionId,
      groupId: record.groupId,
      artifactId: record.artifactId,
      initialMode: record.kind === 'html' ? 'sandbox-run' : 'safe-preview',
    },
    resolvedOwnerKey,
  );
  return record;
});
