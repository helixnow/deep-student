import type { ChatSession } from '../types/session';

export const DRAFT_SESSION_METADATA_KEY = 'chatV2Draft';
export const DRAFT_SESSION_METADATA_VERSION = 1;
export const DRAFT_SESSION_STORAGE_PREFIX = 'chat-v2-draft-session-id';

export interface HiddenDraftSessionMetadata {
  hidden: true;
  scope: string;
  version: number;
}

type SessionMetadata = Record<string, unknown> | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function getDraftSessionScope(mode: string, groupId?: string | null): string {
  const normalizedMode = mode.trim() || 'chat';
  const normalizedGroupId = groupId?.trim();
  return normalizedGroupId ? `${normalizedMode}:group:${normalizedGroupId}` : `${normalizedMode}:ungrouped`;
}

export function getDraftSessionStorageKey(scope: string): string {
  return `${DRAFT_SESSION_STORAGE_PREFIX}:${scope}`;
}

export function buildHiddenDraftSessionMetadata(
  metadata: SessionMetadata,
  scope: string
): Record<string, unknown> {
  const base = isRecord(metadata) ? { ...metadata } : {};
  base[DRAFT_SESSION_METADATA_KEY] = {
    hidden: true,
    scope,
    version: DRAFT_SESSION_METADATA_VERSION,
  } satisfies HiddenDraftSessionMetadata;
  return base;
}

export function getHiddenDraftSessionScope(metadata: SessionMetadata): string | null {
  if (!isRecord(metadata)) return null;
  const draft = metadata[DRAFT_SESSION_METADATA_KEY];
  if (!isRecord(draft)) return null;
  if (draft.hidden !== true) return null;
  return typeof draft.scope === 'string' ? draft.scope : null;
}

export function isHiddenDraftSessionMetadata(metadata: SessionMetadata): boolean {
  return getHiddenDraftSessionScope(metadata) !== null;
}

export function isHiddenDraftSession(session: Pick<ChatSession, 'metadata'> | null | undefined): boolean {
  return isHiddenDraftSessionMetadata(session?.metadata);
}

export function clearHiddenDraftSessionMetadata(metadata: SessionMetadata): Record<string, unknown> | null {
  if (!isRecord(metadata)) return null;
  const next = { ...metadata };
  delete next[DRAFT_SESSION_METADATA_KEY];
  return Object.keys(next).length > 0 ? next : null;
}

const knownHiddenDraftIds = new Set<string>();

export function trackHiddenDraftSessionId(sessionId: string | null | undefined): void {
  if (sessionId) {
    knownHiddenDraftIds.add(sessionId);
  }
}

export function untrackHiddenDraftSessionId(sessionId: string | null | undefined): void {
  if (sessionId) {
    knownHiddenDraftIds.delete(sessionId);
  }
}

export function isHiddenDraftSessionId(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  if (knownHiddenDraftIds.has(sessionId)) return true;

  const storage = getStorage();
  if (!storage) return false;

  const prefix = `${DRAFT_SESSION_STORAGE_PREFIX}:`;
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && key.startsWith(prefix) && storage.getItem(key) === sessionId) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function getStoredDraftSessionId(scope: string): string | null {
  return getStorage()?.getItem(getDraftSessionStorageKey(scope)) ?? null;
}

export function persistHiddenDraftSessionId(scope: string, sessionId: string): void {
  knownHiddenDraftIds.add(sessionId);
  getStorage()?.setItem(getDraftSessionStorageKey(scope), sessionId);
}

export function clearHiddenDraftSessionId(scope: string, sessionId?: string | null): void {
  const storage = getStorage();
  const storageKey = getDraftSessionStorageKey(scope);
  const storedId = storage?.getItem(storageKey) ?? null;
  if (storedId) {
    knownHiddenDraftIds.delete(storedId);
  }
  if (sessionId) {
    knownHiddenDraftIds.delete(sessionId);
  }
  storage?.removeItem(storageKey);
}

export function __resetHiddenDraftSessionTrackingForTests(): void {
  knownHiddenDraftIds.clear();
}
