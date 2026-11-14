import { useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
  fetchExamHorizonConfig,
  fetchExamReadiness,
  saveExamHorizonConfig,
} from './sprintBridge';
import type {
  ExamHorizonConfig,
  ExamHorizonConfigPatch,
  ExamReadinessSnapshot,
  OpenDailySprintOptions,
  SprintLauncherSnapshot,
} from './sprintContracts';

const ACTIVE_STUDY_SPACE_STORAGE_KEY = 'ds.studySpace.activeId.v1';
const STUDY_SPACE_CHANGED_EVENT = 'study-space:changed';
const FSRS_CHANGED_EVENT = 'fsrs://changed';

interface StudySpaceChangedPayload {
  spaceId?: string | null;
  rootFolderId?: string | null;
  defaultDeckId?: string | null;
}

function normalizeSpaceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '__inbox__' || trimmed === '__all__' || trimmed === 'null') {
    return null;
  }
  return trimmed;
}

export function readStoredActiveStudySpaceId(): string | null {
  if (typeof globalThis.localStorage === 'undefined') return null;
  try {
    const raw = globalThis.localStorage.getItem(ACTIVE_STUDY_SPACE_STORAGE_KEY);
    if (raw == null) return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'null') return null;
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === 'string' || parsed === null) {
          return normalizeSpaceId(parsed);
        }
        if (parsed && typeof parsed === 'object' && 'spaceId' in parsed) {
          return normalizeSpaceId((parsed as { spaceId?: unknown }).spaceId);
        }
      } catch {
        // Fall back to direct string normalization.
      }
    }
    return normalizeSpaceId(trimmed);
  } catch {
    return null;
  }
}

let state: SprintLauncherSnapshot = {
  isOpen: false,
  launchSeq: 0,
  launchOptions: null,
  spaceId: readStoredActiveStudySpaceId(),
  rootFolderId: null,
  defaultDeckId: null,
  config: null,
  readiness: null,
  loadingReadiness: false,
};

const listeners = new Set<() => void>();
let requestCounter = 0;
let runtimeCleanup: (() => void) | null = null;
let initialFetchTriggered = false;

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(patch: Partial<SprintLauncherSnapshot>): void {
  state = { ...state, ...patch };
  emitChange();
}

export async function refreshSprintReadiness(override?: {
  spaceId?: string | null;
  rootFolderId?: string | null;
  defaultDeckId?: string | null;
}): Promise<ExamReadinessSnapshot | null> {
  const reqId = ++requestCounter;
  const targetSpaceId =
    override && 'spaceId' in override ? normalizeSpaceId(override.spaceId) : state.spaceId;
  const targetRootFolderId =
    override && 'rootFolderId' in override ? (override.rootFolderId ?? null) : state.rootFolderId;
  const targetDeckId =
    override && 'defaultDeckId' in override ? (override.defaultDeckId ?? null) : state.defaultDeckId;

  setState({
    spaceId: targetSpaceId,
    rootFolderId: targetRootFolderId,
    defaultDeckId: targetDeckId,
    loadingReadiness: true,
    ...(targetSpaceId !== state.spaceId || targetRootFolderId !== state.rootFolderId
      ? { readiness: null, config: null } : {}),
  });

  try {
    const [readiness, config] = await Promise.all([
      fetchExamReadiness({
        spaceId: targetSpaceId,
        rootFolderId: targetRootFolderId,
        defaultDeckIdOverride: targetDeckId,
      }),
      fetchExamHorizonConfig(targetSpaceId),
    ]);
    if (reqId !== requestCounter) return readiness;
    setState({
      readiness,
      config,
      loadingReadiness: false,
    });
    return readiness;
  } catch {
    if (reqId === requestCounter) {
      setState({ loadingReadiness: false });
    }
    return null;
  }
}

export async function updateSprintHorizonSettings(
  patch: ExamHorizonConfigPatch,
): Promise<ExamHorizonConfig> {
  const effectivePatch: ExamHorizonConfigPatch = {
    spaceId: patch.spaceId !== undefined ? patch.spaceId : state.spaceId,
    rootFolderId: patch.rootFolderId !== undefined ? patch.rootFolderId : state.rootFolderId,
    ...patch,
  };
  const updated = await saveExamHorizonConfig(effectivePatch);
  // Saving settings for a space must not switch back to it after the user navigates away.
  if (normalizeSpaceId(effectivePatch.spaceId) !== state.spaceId
    || (effectivePatch.rootFolderId ?? null) !== state.rootFolderId) return updated;
  setState({ config: updated });
  await refreshSprintReadiness({
    spaceId: updated.spaceId,
    rootFolderId: updated.rootFolderId,
    defaultDeckId: updated.defaultDeckId,
  });
  return updated;
}

export function openDailySprint(options: OpenDailySprintOptions = {}): void {
  const spaceId =
    options.spaceId !== undefined ? normalizeSpaceId(options.spaceId) : state.spaceId;
  setState({
    isOpen: true,
    launchSeq: state.launchSeq + 1,
    launchOptions: {
      source: options.source ?? 'programmatic',
      spaceId,
      rootFolderId: options.rootFolderId ?? state.rootFolderId,
      examDateOverride: options.examDateOverride ?? null,
      sprintBudgetMinutesOverride: options.sprintBudgetMinutesOverride ?? null,
      defaultDeckIdOverride: options.defaultDeckIdOverride ?? state.defaultDeckId,
      preloadedPlan: options.preloadedPlan ?? null,
    },
  });
}

export function closeDailySprint(options?: { skipRefresh?: boolean }): void {
  if (!state.isOpen) return;
  setState({
    isOpen: false,
    launchOptions: null,
  });
  if (!options?.skipRefresh) {
    void refreshSprintReadiness();
  }
}

function attachRuntimeSubscriptions(): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleSpaceChanged = (event: Event) => {
    const detail = (event as CustomEvent<StudySpaceChangedPayload | undefined>).detail;
    const nextSpaceId =
      detail && 'spaceId' in detail
        ? normalizeSpaceId(detail.spaceId)
        : readStoredActiveStudySpaceId();
    const nextRootFolderId =
      detail && typeof detail.rootFolderId === 'string' && detail.rootFolderId.trim().length > 0
        ? detail.rootFolderId.trim()
        : null;
    const nextDeckId =
      detail && typeof detail.defaultDeckId === 'string' && detail.defaultDeckId.trim().length > 0
        ? detail.defaultDeckId.trim()
        : null;
    void refreshSprintReadiness({
      spaceId: nextSpaceId,
      rootFolderId: nextRootFolderId,
      defaultDeckId: nextDeckId,
    });
  };

  let debounceTimer: number | null = null;
  const scheduleRevalidate = () => {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void refreshSprintReadiness();
    }, 180);
  };

  const handleVisibility = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      scheduleRevalidate();
    }
  };

  window.addEventListener(STUDY_SPACE_CHANGED_EVENT, handleSpaceChanged);
  window.addEventListener('focus', scheduleRevalidate);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibility);
  }

  let unlistenFsrs: (() => void) | null = null;
  let disposed = false;
  try {
    void listen(FSRS_CHANGED_EVENT, () => {
      if (!disposed) scheduleRevalidate();
    })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenFsrs = unlisten;
        }
      })
      .catch(() => {
        // Non-Tauri / JSDOM environment without event bridge.
      });
  } catch {
    // Non-Tauri / JSDOM environment.
  }

  return () => {
    disposed = true;
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    window.removeEventListener(STUDY_SPACE_CHANGED_EVENT, handleSpaceChanged);
    window.removeEventListener('focus', scheduleRevalidate);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleVisibility);
    }
    unlistenFsrs?.();
  };
}

export function getSprintLauncherSnapshot(): SprintLauncherSnapshot {
  return state;
}

export function subscribeSprintLauncher(listener: () => void): () => void {
  listeners.add(listener);
  if (runtimeCleanup === null) {
    runtimeCleanup = attachRuntimeSubscriptions();
  }
  if (!initialFetchTriggered && state.readiness === null && !state.loadingReadiness) {
    initialFetchTriggered = true;
    void refreshSprintReadiness({ spaceId: readStoredActiveStudySpaceId() });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && runtimeCleanup !== null) {
      runtimeCleanup();
      runtimeCleanup = null;
      requestCounter += 1;
      initialFetchTriggered = false;
      state = { ...state, loadingReadiness: false };
    }
  };
}

export function useSprintLauncherSnapshot(): SprintLauncherSnapshot {
  return useSyncExternalStore(
    subscribeSprintLauncher,
    getSprintLauncherSnapshot,
    getSprintLauncherSnapshot,
  );
}

export function setSprintReadinessForTest(
  readiness: ExamReadinessSnapshot | null,
  config: ExamHorizonConfig | null = null,
): void {
  initialFetchTriggered = true;
  requestCounter += 1;
  setState({
    readiness,
    config,
    spaceId: readiness?.spaceId ?? config?.spaceId ?? state.spaceId,
    loadingReadiness: false,
  });
}

export function resetSprintLauncherStoreForTest(): void {
  requestCounter += 1;
  initialFetchTriggered = false;
  state = {
    isOpen: false,
    launchSeq: 0,
    launchOptions: null,
    spaceId: readStoredActiveStudySpaceId(),
    rootFolderId: null,
    defaultDeckId: null,
    config: null,
    readiness: null,
    loadingReadiness: false,
  };
  emitChange();
}
