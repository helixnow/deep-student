import { create } from 'zustand';

import { stripSandboxRunRuntimeGuard } from '@/components/previews/chatHtmlPreviewDocument';
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
export const SANDBOX_DRAFT_STORAGE_KEY = 'ds.sandbox.workbench.draft.v1';

export interface SandboxSessionRevision {
  version: number;
  content: string;
  createdAt: number;
}

export interface SandboxSessionRevisionState {
  revisions: SandboxSessionRevision[];
  activeVersion: number;
  initialContent: string;
}

export interface SandboxPersistedDraft {
  sourceMessageId?: string;
  title?: string;
  language?: string;
  artifactKind: SandboxSession['artifactKind'];
  mode: SandboxWorkbenchMode;
  content: string;
  initialContent: string;
  revisions: SandboxSessionRevision[];
  activeVersion: number;
  updatedAt: number;
  dismissed?: boolean;
}

function isStandaloneDraftSession(
  inputOrSession: Pick<SandboxSessionInput, 'artifactKind' | 'sourceType' | 'artifactId' | 'sessionId'>,
): boolean {
  return (
    inputOrSession.artifactKind === 'html' &&
    !inputOrSession.artifactId &&
    !inputOrSession.sessionId &&
    inputOrSession.sourceType !== 'chat-code-block' &&
    inputOrSession.sourceType !== 'chat-generative-ui'
  );
}

export function readPersistedSandboxDraft(): SandboxPersistedDraft | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(SANDBOX_DRAFT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SandboxPersistedDraft> | null;
    if (!parsed || typeof parsed.content !== 'string' || !parsed.content.trim()) {
      return null;
    }
    const cleanContent = stripSandboxRunRuntimeGuard(parsed.content);
    const initialContent =
      typeof parsed.initialContent === 'string' && parsed.initialContent.trim()
        ? stripSandboxRunRuntimeGuard(parsed.initialContent)
        : cleanContent;
    const revisions = Array.isArray(parsed.revisions) && parsed.revisions.length > 0
      ? parsed.revisions
          .filter(
            (r): r is SandboxSessionRevision =>
              Boolean(r) &&
              typeof r.version === 'number' &&
              Number.isFinite(r.version) &&
              typeof r.content === 'string',
          )
          .map((r) => ({
            version: r.version,
            content: stripSandboxRunRuntimeGuard(r.content),
            createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
          }))
      : [{ version: 1, content: cleanContent, createdAt: Date.now() }];
    const activeVersion =
      typeof parsed.activeVersion === 'number' &&
      revisions.some((r) => r.version === parsed.activeVersion)
        ? parsed.activeVersion
        : revisions[revisions.length - 1].version;
    return {
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      language: typeof parsed.language === 'string' ? parsed.language : 'html',
      artifactKind: parsed.artifactKind ?? 'html',
      mode: parsed.mode === 'safe-preview' ? 'safe-preview' : 'sandbox-run',
      content: cleanContent,
      initialContent,
      revisions,
      activeVersion,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      dismissed: Boolean(parsed.dismissed),
    };
  } catch {
    return null;
  }
}

function writePersistedSandboxDraft(draft: SandboxPersistedDraft | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (!draft) {
      window.localStorage.removeItem(SANDBOX_DRAFT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SANDBOX_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Ignore storage quota / security errors.
  }
}

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
  sessionRevisionsByOwner: Record<SandboxOwnerKey, SandboxSessionRevisionState>;
  activeOwnerKey: SandboxOwnerKey;
  activateOwner: (ownerKey: SandboxOwnerKey) => void;
  openSession: (input: SandboxSessionInput, ownerKey?: SandboxOwnerKey) => void;
  openWorkbench: (ownerKey?: SandboxOwnerKey) => void;
  closeWorkbench: (ownerKey?: SandboxOwnerKey) => void;
  closeSession: (ownerKey?: SandboxOwnerKey) => void;
  disposeOwner: (ownerKey: SandboxOwnerKey) => void;
  refreshSession: (ownerKey?: SandboxOwnerKey) => void;
  commitSessionRevision: (
    content: string,
    ownerKey?: SandboxOwnerKey,
    options?: { bumpIfUnchanged?: boolean },
  ) => number;
  selectSessionRevision: (version: number, ownerKey?: SandboxOwnerKey) => void;
  resetSessionDraft: (ownerKey?: SandboxOwnerKey) => void;
  restorePersistedDraft: (ownerKey?: SandboxOwnerKey) => boolean;
  setViewportPreset: (preset: SandboxViewportPreset, ownerKey?: SandboxOwnerKey) => void;
  setInspectorOpen: (open: boolean, ownerKey?: SandboxOwnerKey) => void;
  setWorkbenchMode: (mode: SandboxWorkbenchMode, ownerKey?: SandboxOwnerKey) => void;
}

function createSandboxSession(input: SandboxSessionInput): SandboxSession {
  const now = Date.now();
  sessionSequence += 1;
  const resolvedMode: SandboxWorkbenchMode =
    input.initialMode ?? (input.artifactKind === 'html' ? 'sandbox-run' : 'safe-preview');
  const cleanContent =
    input.artifactKind === 'html' ? stripSandboxRunRuntimeGuard(input.content) : input.content;
  return {
    ...input,
    content: cleanContent,
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
  const sessionRevisionsByOwner = { ...state.sessionRevisionsByOwner };
  delete sessionRevisionsByOwner[ownerKey];
  if (state.activeOwnerKey !== ownerKey) {
    return { ownerStates, sessionRevisionsByOwner };
  }

  const fallbackOwnerState = ownerStates[LEGACY_SANDBOX_OWNER_KEY] ?? EMPTY_OWNER_STATE;
  return {
    ownerStates,
    sessionRevisionsByOwner,
    activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
    ...fallbackOwnerState,
  };
}

// ownerStates is authoritative. The top-level fields mirror activeOwnerKey so
// existing single-window selectors and no-argument actions keep their behavior.
export const useSandboxWorkbenchStore = create<SandboxWorkbenchStore>((set, get) => ({
  ...EMPTY_OWNER_STATE,
  ownerStates: {},
  sessionRevisionsByOwner: {},
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
    const session = createSandboxSession(input);
    const initialRevisionState: SandboxSessionRevisionState = {
      revisions: [
        {
          version: 1,
          content: session.content,
          createdAt: session.createdAt,
        },
      ],
      activeVersion: 1,
      initialContent: session.content,
    };
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      const ownerState: SandboxWorkbenchOwnerState = {
        activeSession: session,
        isOpen: true,
        viewportPreset: 'desktop',
        inspectorOpen: false,
      };
      return {
        ownerStates: {
          ...state.ownerStates,
          [resolvedOwnerKey]: ownerState,
        },
        sessionRevisionsByOwner: {
          ...state.sessionRevisionsByOwner,
          [resolvedOwnerKey]: initialRevisionState,
        },
        activeOwnerKey: resolvedOwnerKey,
        ...ownerState,
      };
    });
    if (isStandaloneDraftSession(input)) {
      writePersistedSandboxDraft({
        title: session.title,
        language: session.language,
        artifactKind: session.artifactKind,
        mode: session.mode,
        content: session.content,
        initialContent: initialRevisionState.initialContent,
        revisions: initialRevisionState.revisions,
        activeVersion: initialRevisionState.activeVersion,
        updatedAt: session.updatedAt,
        dismissed: false,
      });
    }
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
    if (prevSession && isStandaloneDraftSession(prevSession)) {
      const existingDraft = readPersistedSandboxDraft();
      if (existingDraft) {
        writePersistedSandboxDraft({ ...existingDraft, dismissed: true });
      }
    }
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

  commitSessionRevision: (content, ownerKey, options) => {
    const state = get();
    const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
    const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
    if (!current.activeSession) return 1;

    const cleanContent =
      current.activeSession.artifactKind === 'html'
        ? stripSandboxRunRuntimeGuard(content)
        : content;
    const existingRevState = state.sessionRevisionsByOwner[resolvedOwnerKey] ?? {
      revisions: [
        {
          version: 1,
          content: current.activeSession.content,
          createdAt: current.activeSession.createdAt,
        },
      ],
      activeVersion: 1,
      initialContent: current.activeSession.content,
    };
    const activeRev =
      existingRevState.revisions.find((r) => r.version === existingRevState.activeVersion) ??
      existingRevState.revisions[existingRevState.revisions.length - 1];
    const now = Date.now();
    const changed = !activeRev || activeRev.content !== cleanContent;
    const shouldBump = changed || Boolean(options?.bumpIfUnchanged);

    const nextVersion = shouldBump
      ? (existingRevState.revisions.reduce((max, r) => Math.max(max, r.version), 0) || 1) + 1
      : existingRevState.activeVersion;
    const nextRevisions = shouldBump
      ? [...existingRevState.revisions, { version: nextVersion, content: cleanContent, createdAt: now }]
      : existingRevState.revisions;
    const nextRevState: SandboxSessionRevisionState = {
      ...existingRevState,
      revisions: nextRevisions,
      activeVersion: nextVersion,
    };

    const nextSession: SandboxSession = {
      ...current.activeSession,
      content: cleanContent,
      updatedAt: now,
    };
    const ownerState: SandboxWorkbenchOwnerState = {
      ...current,
      activeSession: nextSession,
    };

    set((prev) => ({
      ownerStates: { ...prev.ownerStates, [resolvedOwnerKey]: ownerState },
      sessionRevisionsByOwner: {
        ...prev.sessionRevisionsByOwner,
        [resolvedOwnerKey]: nextRevState,
      },
      ...(prev.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
    }));

    if (isStandaloneDraftSession(nextSession)) {
      writePersistedSandboxDraft({
        title: nextSession.title,
        language: nextSession.language,
        artifactKind: nextSession.artifactKind,
        mode: nextSession.mode,
        content: nextSession.content,
        initialContent: nextRevState.initialContent,
        revisions: nextRevState.revisions,
        activeVersion: nextRevState.activeVersion,
        updatedAt: now,
        dismissed: false,
      });
    }

    return nextVersion;
  },

  selectSessionRevision: (version, ownerKey) => {
    const state = get();
    const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
    const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
    if (!current.activeSession) return;
    const existingRevState = state.sessionRevisionsByOwner[resolvedOwnerKey];
    const targetRev = existingRevState?.revisions.find((r) => r.version === version);
    if (!existingRevState || !targetRev) return;

    const now = Date.now();
    const nextRevState: SandboxSessionRevisionState = {
      ...existingRevState,
      activeVersion: targetRev.version,
    };
    const nextSession: SandboxSession = {
      ...current.activeSession,
      content: targetRev.content,
      updatedAt: now,
    };
    const ownerState: SandboxWorkbenchOwnerState = {
      ...current,
      activeSession: nextSession,
    };

    set((prev) => ({
      ownerStates: { ...prev.ownerStates, [resolvedOwnerKey]: ownerState },
      sessionRevisionsByOwner: {
        ...prev.sessionRevisionsByOwner,
        [resolvedOwnerKey]: nextRevState,
      },
      ...(prev.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
    }));

    if (isStandaloneDraftSession(nextSession)) {
      writePersistedSandboxDraft({
        title: nextSession.title,
        language: nextSession.language,
        artifactKind: nextSession.artifactKind,
        mode: nextSession.mode,
        content: nextSession.content,
        initialContent: nextRevState.initialContent,
        revisions: nextRevState.revisions,
        activeVersion: nextRevState.activeVersion,
        updatedAt: now,
        dismissed: false,
      });
    }
  },

  resetSessionDraft: (ownerKey) => {
    const state = get();
    const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
    const current = selectSandboxWorkbenchOwnerState(state, resolvedOwnerKey);
    if (!current.activeSession) return;

    const existingRevState = state.sessionRevisionsByOwner[resolvedOwnerKey];
    const initialContent = existingRevState?.initialContent ?? current.activeSession.content;
    const now = Date.now();
    const nextRevState: SandboxSessionRevisionState = {
      revisions: [{ version: 1, content: initialContent, createdAt: now }],
      activeVersion: 1,
      initialContent,
    };
    const nextSession: SandboxSession = {
      ...current.activeSession,
      content: initialContent,
      updatedAt: now,
    };
    const ownerState: SandboxWorkbenchOwnerState = {
      ...current,
      activeSession: nextSession,
    };

    set((prev) => ({
      ownerStates: { ...prev.ownerStates, [resolvedOwnerKey]: ownerState },
      sessionRevisionsByOwner: {
        ...prev.sessionRevisionsByOwner,
        [resolvedOwnerKey]: nextRevState,
      },
      ...(prev.activeOwnerKey === resolvedOwnerKey ? ownerState : {}),
    }));

    if (isStandaloneDraftSession(nextSession)) {
      writePersistedSandboxDraft({
        title: nextSession.title,
        language: nextSession.language,
        artifactKind: nextSession.artifactKind,
        mode: nextSession.mode,
        content: initialContent,
        initialContent,
        revisions: nextRevState.revisions,
        activeVersion: 1,
        updatedAt: now,
        dismissed: false,
      });
    }
  },

  restorePersistedDraft: (ownerKey) => {
    const draft = readPersistedSandboxDraft();
    if (!draft) return false;

    const session = createSandboxSession({
      sourceType: 'manual-snippet',
      sourceMessageId: draft.sourceMessageId ?? 'sandbox-draft-restore',
      language: draft.language ?? 'html',
      title: draft.title ?? 'HTML Canvas',
      content: draft.content,
      artifactKind: draft.artifactKind,
      initialMode: draft.mode,
    });
    const revState: SandboxSessionRevisionState = {
      revisions: draft.revisions,
      activeVersion: draft.activeVersion,
      initialContent: draft.initialContent,
    };
    set((state) => {
      const resolvedOwnerKey = resolveOwnerKey(state, ownerKey);
      const ownerState: SandboxWorkbenchOwnerState = {
        activeSession: session,
        isOpen: true,
        viewportPreset: 'desktop',
        inspectorOpen: false,
      };
      return {
        ownerStates: {
          ...state.ownerStates,
          [resolvedOwnerKey]: ownerState,
        },
        sessionRevisionsByOwner: {
          ...state.sessionRevisionsByOwner,
          [resolvedOwnerKey]: revState,
        },
        activeOwnerKey: resolvedOwnerKey,
        ...ownerState,
      };
    });
    writePersistedSandboxDraft({ ...draft, dismissed: false, updatedAt: Date.now() });
    return true;
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
