import type { ChatSession } from '../types/session';
import { isSubagentSession } from '../core/subagentSession';
import {
  isHiddenDraftSession,
  isHiddenDraftSessionId,
  isHiddenDraftSessionMetadata,
} from './draftSession';

/**
 * Last active chat session persistence key.
 * Shared with desktop ModernSidebar initial highlight (`chat-v2-last-session-id`).
 */
export const LAST_ACTIVE_SESSION_KEY = 'chat-v2-last-session-id';

function getStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export interface ResumableSessionIdOptions {
  mode?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Checks whether a session ID represents a real persisted chat session
 * that should be persisted for auto-resume on reload.
 * Excludes hidden blank drafts, subagent/worker sessions, and demo drafts.
 */
export function isResumableSessionId(
  sessionId: string | null | undefined,
  options?: ResumableSessionIdOptions,
): sessionId is string {
  if (typeof sessionId !== 'string') return false;
  const trimmed = sessionId.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('demo-draft-')) return false;
  if (isHiddenDraftSessionId(trimmed)) return false;
  if (isHiddenDraftSessionMetadata(options?.metadata)) return false;
  if (isSubagentSession({ sessionId: trimmed, mode: options?.mode, metadata: options?.metadata })) {
    return false;
  }
  return true;
}

/**
 * Checks whether a loaded session record is eligible for startup auto-resume.
 * Must be active (not archived/deleted), not a hidden draft, and not a subagent.
 */
export function isResumableSession<
  T extends Pick<ChatSession, 'id' | 'mode' | 'persistStatus' | 'metadata'>,
>(session: T | null | undefined): session is T {
  if (!session) return false;
  if (session.persistStatus === 'archived' || session.persistStatus === 'deleted') {
    return false;
  }
  if (isHiddenDraftSession(session)) return false;
  return isResumableSessionId(session.id, {
    mode: session.mode,
    metadata: session.metadata,
  });
}

export function readLastActiveSessionId(
  storageKey: string = LAST_ACTIVE_SESSION_KEY,
): string | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    const trimmed = raw?.trim() ?? '';
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export function persistLastActiveSessionId(
  sessionId: string | null | undefined,
  storageKey: string = LAST_ACTIVE_SESSION_KEY,
  options?: ResumableSessionIdOptions,
): boolean {
  if (!isResumableSessionId(sessionId, options)) {
    return false;
  }
  const storage = getStorage();
  if (!storage) return false;
  try {
    storage.setItem(storageKey, sessionId);
    return true;
  } catch {
    return false;
  }
}

export function clearLastActiveSessionId(
  storageKey: string = LAST_ACTIVE_SESSION_KEY,
): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(storageKey);
  } catch {
    // ignore storage errors
  }
}

export function clearLastActiveSessionIdIfMatches(
  sessionId: string | null | undefined,
  storageKey: string = LAST_ACTIVE_SESSION_KEY,
): void {
  if (!sessionId) return;
  const current = readLastActiveSessionId(storageKey);
  if (current === sessionId) {
    clearLastActiveSessionId(storageKey);
  }
}

/**
 * Resolves the startup session to auto-resume from the loaded active session list.
 * If a stored session ID no longer exists in the active list (deleted/archived/stale draft),
 * cleans up the stale storage entry and returns null so startup falls back to a blank draft.
 */
export function resolveStartupResumableSessionId(
  allSessions: readonly ChatSession[],
  storageKey: string = LAST_ACTIVE_SESSION_KEY,
): string | null {
  const storedId = readLastActiveSessionId(storageKey);
  if (!storedId) return null;

  const matched = allSessions.find(
    (session) => session.id === storedId && isResumableSession(session),
  );
  if (matched) {
    return matched.id;
  }

  clearLastActiveSessionIdIfMatches(storedId, storageKey);
  return null;
}
