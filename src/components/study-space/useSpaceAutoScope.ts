import { useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getKbScopeRevision, setKbScope } from './kbScope';
import type { SessionGroup } from '@/features/chat/types/group';
import type { ChatSession } from '@/features/chat/types/session';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  INBOX_SPACE_ID,
  INBOX_FOLDER_ID,
  INBOX_SPACE_FILTER_KEY,
} from '@/shared/study-space/types';
import { useStudySpaceStore } from '@/stores/studySpaceStore';
export { buildStudySpaceMemoryPromptBlock, sanitizeSpaceMemoryFolderSegment } from '@/shared/study-space/memoryPrompt';

export type SessionKbScopeDescriptor =
  | { mode: 'none'; folderIds: [] }
  | { mode: 'all'; folderIds: [] }
  | { mode: 'folders'; folderIds: string[] };

const AUTO_SCOPED_SESSIONS_KEY = 'ds.studySpace.autoScopedSessions.v1';
const autoScopedSessionSet = new Set<string>();
let hydratedAutoScopedSet = false;

function ensureHydratedAutoScopedSet(): void {
  if (hydratedAutoScopedSet || typeof window === 'undefined') return;
  hydratedAutoScopedSet = true;
  try {
    const raw = window.localStorage.getItem(AUTO_SCOPED_SESSIONS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (typeof id === 'string' && id.length > 0) {
          autoScopedSessionSet.add(id);
        }
      }
    }
  } catch {
    // Ignore storage read errors.
  }
}

export function markSessionAutoScoped(sessionId: string): void {
  if (!sessionId) return;
  ensureHydratedAutoScopedSet();
  autoScopedSessionSet.add(sessionId);
  if (typeof window === 'undefined') return;
  try {
    const compact = Array.from(autoScopedSessionSet).slice(-300);
    window.localStorage.setItem(AUTO_SCOPED_SESSIONS_KEY, JSON.stringify(compact));
  } catch {
    // Ignore storage write errors.
  }
}

export function hasSessionBeenAutoScoped(sessionId: string): boolean {
  ensureHydratedAutoScopedSet();
  return autoScopedSessionSet.has(sessionId);
}

export function resetAutoScopedSessionsForTests(): void {
  autoScopedSessionSet.clear();
  hydratedAutoScopedSet = true;
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(AUTO_SCOPED_SESSIONS_KEY);
    } catch {
      // Ignore storage errors.
    }
  }
}

export async function getSessionKbScope(
  sessionId: string,
): Promise<SessionKbScopeDescriptor | null> {
  if (!sessionId.trim()) return null;
  try {
    const raw = await invoke<unknown>('chat_v2_get_rag_scope', { sessionId });
    if (raw === null || raw === undefined) {
      return null;
    }
    if (Array.isArray(raw)) {
      const folderIds = raw.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0,
      );
      if (folderIds.length > 0) {
        return { mode: 'folders', folderIds };
      }
      // [] is an explicit user choice, even on sessions created before W03.
      return { mode: 'all', folderIds: [] };
    }
    if (typeof raw === 'object') {
      const obj = raw as { mode?: unknown; folderIds?: unknown };
      if (obj.mode === 'none') return { mode: 'none', folderIds: [] };
      if (obj.mode === 'all') {
        return { mode: 'all', folderIds: [] };
      }
      if (obj.mode === 'folders' && Array.isArray(obj.folderIds)) {
        const folderIds = obj.folderIds.filter(
          (id): id is string => typeof id === 'string' && id.trim().length > 0,
        );
        return { mode: 'folders', folderIds };
      }
    }
    return { mode: 'all', folderIds: [] };
  } catch {
    // A failed read is not proof that the user has never selected a scope.
    return { mode: 'all', folderIds: [] };
  }
}

export async function setSessionKbScope(
  sessionId: string,
  scope: { mode: 'all' } | { mode: 'folders'; folderIds: string[] },
): Promise<boolean> {
  if (!sessionId.trim()) return false;
  const folderIds =
    scope.mode === 'folders'
      ? scope.folderIds.map((id) => id.trim()).filter(Boolean)
      : [];
  try {
    await setKbScope(sessionId, folderIds);
    markSessionAutoScoped(sessionId);
    return true;
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    if (!msg.includes('尚未保存') && !msg.includes('FOREIGN KEY')) {
      console.warn('[useSpaceAutoScope] Failed to persist session KB scope:', msg);
    }
    return false;
  }
}

export async function autoScopeSessionOnSwitch(
  sessionId: string,
  spaceId: string | null | undefined,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!sessionId || !spaceId || spaceId === INBOX_FOLDER_ID || spaceId === INBOX_SPACE_FILTER_KEY) return false;
  const space = useStudySpaceStore.getState().getStudySpace(spaceId);
  const rootFolderId = space?.rootFolderId?.trim();
  if (!rootFolderId) return false;

  const revision = getKbScopeRevision(sessionId);
  const existing = await getSessionKbScope(sessionId);
  if (existing !== null || !isCurrent() || revision !== getKbScopeRevision(sessionId) ||
    useStudySpaceStore.getState().getStudySpace(spaceId)?.rootFolderId?.trim() !== rootFolderId) {
    return false;
  }

  return setSessionKbScope(sessionId, {
    mode: 'folders',
    folderIds: [rootFolderId],
  });
}

export interface UseSpaceAutoScopeOptions<TSessionResult = void | { id: string } | ChatSession> {
  currentSessionId: string | null;
  currentSession?: Pick<ChatSession, 'id' | 'groupId'> | null;
  groups?: SessionGroup[];
  sessions?: Pick<ChatSession, 'id'>[];
  createSession: (groupId?: string) => Promise<TSessionResult>;
}

export function useSpaceAutoScope<TSessionResult = void | { id: string } | ChatSession>({
  currentSessionId,
  currentSession,
  groups,
  sessions,
  createSession,
}: UseSpaceAutoScopeOptions<TSessionResult>) {
  const hydratedKeysRef = useRef<string | null>(null);
  const pendingCreationRef = useRef<{ groupId: string; knownIds: Set<string> } | null>(null);
  const currentRootFolderId = useStudySpaceStore((state) =>
    currentSession?.groupId ? state.getStudySpace(currentSession.groupId)?.rootFolderId : undefined,
  );

  useEffect(() => {
    if (!groups) return;
    const signature = groups
      .map((g) => `${g.id}:${g.updatedAt}:${g.persistStatus}:${g.rootFolderId ?? ''}:${g.pinnedResourceIds.join(',')}`)
      .join('|');
    if (signature === hydratedKeysRef.current) return;
    hydratedKeysRef.current = signature;
    void useStudySpaceStore.getState().hydrateFromGroups(groups);
  }, [groups]);

  useEffect(() => {
    if (!currentSessionId || currentSession?.id !== currentSessionId) return;
    const groupId = currentSession?.groupId ?? null;
    if (!groupId) return;
    const pending = pendingCreationRef.current;
    if (pending?.groupId === groupId && !pending.knownIds.has(currentSessionId) && currentRootFolderId) {
      pendingCreationRef.current = null;
      if (getKbScopeRevision(currentSessionId) === 0) {
        void setSessionKbScope(currentSessionId, { mode: 'folders', folderIds: [currentRootFolderId] });
      }
      return;
    }
    let cancelled = false;
    void autoScopeSessionOnSwitch(currentSessionId, groupId, () => !cancelled);
    return () => { cancelled = true; };
  }, [currentRootFolderId, currentSession?.groupId, currentSession?.id, currentSessionId]);

  const createScopedSession = useCallback(
    async (explicitGroupId?: string | null): Promise<TSessionResult> => {
      const store = useStudySpaceStore.getState();
      const targetGroupId: string | undefined =
        explicitGroupId !== undefined
          ? explicitGroupId && explicitGroupId !== 'ungrouped' && explicitGroupId !== INBOX_FOLDER_ID && explicitGroupId !== INBOX_SPACE_FILTER_KEY
            ? explicitGroupId
            : undefined
          : store.activeSpaceId !== INBOX_SPACE_ID
            ? store.activeSpaceId
            : undefined;

      // The sidebar's real lifecycle returns void; identify its newly published
      // session against the pre-create list, not by interpreting every [] as unset.
      const pending = targetGroupId ? {
        groupId: targetGroupId,
        knownIds: new Set([...(sessions ?? []).map((session) => session.id), ...(currentSessionId ? [currentSessionId] : [])]),
      } : null;
      pendingCreationRef.current = pending;
      let created: TSessionResult;
      try {
        created = await createSession(targetGroupId);
      } catch (error) {
        if (pendingCreationRef.current === pending) pendingCreationRef.current = null;
        throw error;
      }
      if (targetGroupId) {
        const space = useStudySpaceStore.getState().getStudySpace(targetGroupId);
        const rootFolderId = space?.rootFolderId?.trim();
        const newSessionId =
          created && typeof created === 'object' && 'id' in created && typeof created.id === 'string'
            ? created.id
            : null;
        // Only creation can distinguish an untouched [] from a user's explicit
        // global scope. Existing sessions with [] must never be re-initialized.
        if (newSessionId && rootFolderId && getKbScopeRevision(newSessionId) === 0) {
          if (pendingCreationRef.current === pending) pendingCreationRef.current = null;
          await setSessionKbScope(newSessionId, { mode: 'folders', folderIds: [rootFolderId] });
        }
      }
      return created;
    },
    [createSession, currentSessionId, sessions],
  );

  return {
    createScopedSession,
  };
}
