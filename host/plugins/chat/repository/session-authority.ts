/** chat_v2/repo.rs:2851-2860,2898-2940. Only the chat owner writes session metadata. */
import type { ChatSession } from '../api.ts';
import type { DatabaseHandle, SqlExecutor } from '../../../platform/storage/api.ts';
import { nowEpochNanos, toRfc3339Opts, type ParsedDateTime } from '../../../platform/time/index.ts';
import { ChatV2Error } from '../src/error.ts';
import { applySessionAuthorityMetadata, isPlanActiveForBinding, sessionAuthorityFromMetadata,
  type PlanAuthorityState, type SessionAuthorityState } from '../src/session-authority.ts';
import { getSession, updateSession } from './sessions.ts';
import { databaseOperation } from './errors.ts';
import type { ChatLogger } from '../src/logger.ts';

function requireSession(conn: SqlExecutor, sessionId: string): ChatSession {
  const session = getSession(conn, sessionId);
  if (session === null) throw new ChatV2Error('SessionNotFound', sessionId);
  return session;
}
export function getSessionAuthorityState(conn: SqlExecutor, sessionId: string): SessionAuthorityState {
  return sessionAuthorityFromMetadata(requireSession(conn, sessionId).metadata);
}
function persistAuthority(conn: SqlExecutor, session: ChatSession, authority: SessionAuthorityState, log?: ChatLogger): ChatSession {
  session.metadata = applySessionAuthorityMetadata(session.metadata, authority);
  session.updatedAt = toRfc3339Opts(nowEpochNanos(), 'AutoSi', true);
  updateSession(conn, session, log);
  return session;
}
export function setSessionPlanState(conn: SqlExecutor, sessionId: string, plan: PlanAuthorityState | null, log?: ChatLogger): ChatSession {
  const session = requireSession(conn, sessionId);
  const authority = sessionAuthorityFromMetadata(session.metadata);
  if (plan === null) delete authority.plan;
  else authority.plan = plan;
  return persistAuthority(conn, session, authority, log);
}
export function consumeSessionPlanBinding(db: DatabaseHandle, sessionId: string, bindingKey: string, now: ParsedDateTime, log?: ChatLogger): boolean {
  return databaseOperation(() => db.transaction(tx => {
    const session = requireSession(tx, sessionId);
    const authority = sessionAuthorityFromMetadata(session.metadata);
    if (authority.authorityMode !== 'plan' || authority.plan === undefined
      || !isPlanActiveForBinding(authority.plan, bindingKey, now)) return false;
    delete authority.plan;
    persistAuthority(tx, session, authority, log);
    return true;
  }, { behavior: 'immediate' }));
}
