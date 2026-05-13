import type { ChatSession } from '../types/session';

type SessionMetadata = Record<string, unknown>;

function isRecord(value: unknown): value is SessionMetadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSessionPinned(session: Pick<ChatSession, 'metadata'> | null | undefined): boolean {
  return isRecord(session?.metadata) && session.metadata.pinned === true;
}

export function buildPinnedSessionMetadata(
  metadata: ChatSession['metadata'],
  pinned: boolean
): SessionMetadata | undefined {
  const base = isRecord(metadata) ? { ...metadata } : {};

  if (pinned) {
    base.pinned = true;
    return base;
  }

  delete base.pinned;
  return Object.keys(base).length > 0 ? base : undefined;
}

export function compareSessionsForSidebar(left: ChatSession, right: ChatSession): number {
  const pinDelta = Number(isSessionPinned(right)) - Number(isSessionPinned(left));
  if (pinDelta !== 0) return pinDelta;
  return right.updatedAt.localeCompare(left.updatedAt);
}
