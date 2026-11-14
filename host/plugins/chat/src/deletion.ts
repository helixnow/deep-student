/**
 * Message/session deletion. Rust sources:
 * `chat_v2/handlers/block_actions.rs:176-376` and
 * `chat_v2/handlers/manage_session.rs:893-1078`.
 */
import type { ChatV2State } from '../api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { ChatV2Error } from './error.ts';
import { ensureSessionWritable } from './handlers.ts';
import { validateSessionId } from './handlers.ts';
import { getSession, deleteSessionHard, listDeletedSessionIds,
  sessionHasSuperMarker } from '../repository/sessions.ts';
import { sessionHasLiveAnkiBlocks, type StaleAnkiBlockReaperSlot } from './stale-anki-reaper.ts';
import { deleteMessage, getMessage } from '../repository/messages.ts';
import { invalidateCompactionForMessage } from '../repository/compactions.ts';
import { rebuildSessionSkillStateFromHistory } from './session-metadata.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { clearSessionSequenceCounter } from './events.ts';
import { softDeleteSessionAction } from './session-actions.ts';
import { adjustVfsRefsWithRetry, decrementMessageRefs, decrementSessionRefs, trashResourceIds,
  type VfsReferenceAccess } from './reference-counts.ts';
import { databaseOperation } from '../repository/errors.ts';

/** `delete_message_from_db` (block_actions.rs:300-376). */
export function deleteMessageAction(
  db: DatabaseHandle, state: ChatV2State, sessionId: string, messageId: string, log: ChatLogger, refs: VfsReferenceAccess,
): void {
  log.info(`[ChatV2::handlers] chat_v2_delete_message: session_id=${sessionId}, message_id=${messageId}`);
  ensureSessionWritable(db, sessionId);
  if (state.hasActiveStream(sessionId)) {
    throw new ChatV2Error('Other',
      'Cannot delete message while streaming. Please wait for completion or cancel first.');
  }
  if (!messageId.startsWith('msg_')) {
    throw new ChatV2Error('Validation', `Invalid message ID format: ${messageId}`);
  }
  const session = getSession(db, sessionId);
  if (!session) throw new ChatV2Error('SessionNotFound', sessionId);
  const message = getMessage(db, messageId);
  if (!message) throw new ChatV2Error('MessageNotFound', messageId);
  if (message.sessionId !== sessionId) {
    throw new ChatV2Error('Validation',
      `Message ${messageId} does not belong to session ${sessionId}`);
  }
  decrementMessageRefs(refs, message, log);
  databaseOperation(() => db.transaction((tx) => {
    invalidateCompactionForMessage(tx, sessionId, messageId, log);
    deleteMessage(tx, messageId);
  }));
  rebuildSkillsAfterDeletion(db, sessionId, log);
  log.info(`[ChatV2::handlers] Deleted message: session_id=${sessionId}, message_id=${messageId}`);
}

/** block_actions.rs:373 explicitly ignores the rebuild result without a handler warning. */
function rebuildSkillsAfterDeletion(db: DatabaseHandle, sessionId: string, log: ChatLogger): void {
  try {
    rebuildSessionSkillStateFromHistory(db, sessionId, log);
  } catch { return; }
}

/** L06 `agentSubagent.onSessionRemoved` subset used by the deletion hooks. */
export interface SuperSessionHook {
  onSessionRemoved(sessionId: string, hard: boolean): void;
}

function superHook(wasSuper: boolean, hooks: SuperSessionHook | undefined): SuperSessionHook | undefined {
  if (wasSuper && hooks === undefined) {
    throw new ChatV2Error('Other', 'agentSubagent.onSessionRemoved is unavailable');
  }
  return wasSuper ? hooks : undefined;
}

/** manage_session.rs:779-831: storage and sequence cleanup precede the Super hook. */
export function softDeleteSessionCommand(
  db: DatabaseHandle, state: ChatV2State, sessionId: string, hooks: SuperSessionHook | undefined, log: ChatLogger,
  reapers: StaleAnkiBlockReaperSlot,
): void {
  log.info(`[ChatV2::handlers] chat_v2_soft_delete_session: session_id=${sessionId}`);
  validateSessionId(sessionId);
  if (state.hasActiveStream(sessionId)) {
    throw new ChatV2Error('Other', 'Cannot delete session while streaming. Please wait for completion or cancel first.');
  }
  if (sessionHasLiveAnkiBlocks(db, sessionId, reapers, log)) {
    throw new ChatV2Error('Other',
      'Cannot delete session while ChatAnki generation is still running. Please wait for completion or cancel first. Stale generations left over from a crash are cleared automatically; if nothing is actually running, retry in about two minutes.');
  }
  const hook = superHook(sessionHasSuperMarker(db, sessionId), hooks);
  softDeleteSessionAction(db, sessionId);
  clearSessionSequenceCounter(sessionId);
  log.info(`[ChatV2::handlers] Soft deleted session: id=${sessionId}`);
  hook?.onSessionRemoved(sessionId, false);
}

function cleanupRoots(cleanup: (sessionId: string) => void, sessionId: string): void {
  try { cleanup(sessionId); }
  catch (error) { throw new ChatV2Error('IoError', errorText(error)); }
}

/** `chat_v2_delete_session` (manage_session.rs:893-978). */
export function deleteSessionAction(
  db: DatabaseHandle, state: ChatV2State, sessionId: string,
  hooks: SuperSessionHook | undefined, log: ChatLogger, refs: VfsReferenceAccess,
  cleanup: (sessionId: string) => void, reapers: StaleAnkiBlockReaperSlot,
): void {
  log?.info(`[ChatV2::handlers] chat_v2_delete_session: session_id=${sessionId}`);
  if (state.hasActiveStream(sessionId)) {
    throw new ChatV2Error('Other',
      'Cannot delete session while streaming. Please wait for completion or cancel first.');
  }
  if (sessionHasLiveAnkiBlocks(db, sessionId, reapers, log)) {
    throw new ChatV2Error('Other',
      'Cannot delete session while ChatAnki generation is still running. Please wait for completion or cancel first. Stale generations left over from a crash are cleared automatically; if nothing is actually running, retry in about two minutes.');
  }
  validateSessionId(sessionId);
  cleanupRoots(cleanup, sessionId);
  decrementSessionRefs(db, refs, sessionId, log);
  const hook = superHook(sessionHasSuperMarker(db, sessionId), hooks);
  databaseOperation(() => db.transaction(tx => deleteSessionHard(tx, sessionId, log), { behavior: 'immediate' }));
  clearSessionSequenceCounter(sessionId);
  log?.info(`[ChatV2::handlers] Deleted session with cascade: id=${sessionId}`);
  hook?.onSessionRemoved(sessionId, true);
}

/** `chat_v2_empty_deleted_sessions` (manage_session.rs:980-1078). */
export function emptyDeletedSessionsAction(db: DatabaseHandle, hooks: SuperSessionHook | undefined, log: ChatLogger,
  refs: VfsReferenceAccess, cleanup: (sessionId: string) => void): string[] {
  log?.info('[ChatV2::handlers] chat_v2_empty_deleted_sessions');
  const ids = listDeletedSessionIds(db);
  if (!hooks) superHook(ids.some(id => sessionHasSuperMarker(db, id)), hooks);
  for (const id of ids) cleanupRoots(cleanup, id);
  if (ids.length > 0) adjustVfsRefsWithRetry(refs, trashResourceIds(db, ids, log), 'decrement', `empty_deleted_sessions(${ids.length} sessions)`, log);
  const purged: string[] = [];
  const purgedSuperIds: string[] = [];
  for (const sessionId of ids) {
    const session = getSession(db, sessionId);
    if (session && session.persistStatus === 'deleted') {
      const wasSuper = sessionHasSuperMarker(db, sessionId);
      databaseOperation(() => db.transaction(tx => deleteSessionHard(tx, sessionId, log), { behavior: 'immediate' }));
      clearSessionSequenceCounter(sessionId);
      purged.push(sessionId);
      if (wasSuper) purgedSuperIds.push(sessionId);
    } else if (session) {
      log?.info(`[ChatV2::handlers] Skipping trash purge for ${sessionId}: restored concurrently`);
    }
  }
  for (const sessionId of purgedSuperIds) hooks?.onSessionRemoved(sessionId, true);
  log?.info(`[ChatV2::handlers] Emptied trash: ${purged.length} sessions permanently deleted`);
  return purged;
}
