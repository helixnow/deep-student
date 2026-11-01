import type { ChatSession } from '../types/session';

type SessionMetadata = Record<string, unknown>;

function isRecord(value: unknown): value is SessionMetadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 活跃的 Super-agent 会话（metadata.super_agent.active === true）。
 *
 * Super-agent 会话不参与普通置顶逻辑：侧栏在置顶区最上面单独渲染它，
 * 普通置顶/取消置顶不会改变它的 pinned 标记（不可取消置顶）。
 * 与 features/chat/superSession/isSuperSession.ts 判定口径一致。
 */
export function isSuperAgentSession(session: Pick<ChatSession, 'metadata'> | null | undefined): boolean {
  const superAgent = isRecord(session?.metadata) ? session.metadata.super_agent : undefined;
  return isRecord(superAgent) && superAgent.active === true;
}

export function isSessionPinned(session: Pick<ChatSession, 'metadata'> | null | undefined): boolean {
  return isRecord(session?.metadata) && session.metadata.pinned === true;
}

export function buildPinnedSessionMetadata(
  metadata: ChatSession['metadata'],
  pinned: boolean
): SessionMetadata | undefined {
  const base = isRecord(metadata) ? { ...metadata } : {};

  // Super-agent 会话始终置顶：忽略取消置顶请求
  if (pinned || isSuperAgentSession({ metadata: base })) {
    base.pinned = true;
    return base;
  }

  delete base.pinned;
  return Object.keys(base).length > 0 ? base : undefined;
}

export function compareSessionsForSidebar(left: ChatSession, right: ChatSession): number {
  // Super-agent 会话固定在最前，不与普通置顶会话按时间混排
  const superDelta = Number(isSuperAgentSession(right)) - Number(isSuperAgentSession(left));
  if (superDelta !== 0) return superDelta;
  const pinDelta = Number(isSessionPinned(right)) - Number(isSessionPinned(left));
  if (pinDelta !== 0) return pinDelta;
  return right.updatedAt.localeCompare(left.updatedAt);
}
