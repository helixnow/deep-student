/** Rust manage_session.rs:152-238/1147-1184 and block_actions.rs:328-364. */
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { ResourceRepository } from '../../vfs-repos/api.ts';
import type { ChatMessage } from '../api.ts';
import { getSessionMessages } from '../repository/messages.ts';
import { contextSnapshotAllResourceIds } from './context-snapshot.ts';
import { errorText, type ChatLogger } from './logger.ts';

export interface VfsReferenceAccess {
  getConnection(): SqlExecutor;
  increment: ResourceRepository['incrementRef'];
  decrement: ResourceRepository['decrementRef'];
  decrementMany: ResourceRepository['decrementRefs'];
}
export function messageResourceIds(message: ChatMessage): string[] {
  const snapshot = message._meta?.contextSnapshot;
  return snapshot == null ? [] : contextSnapshotAllResourceIds(snapshot);
}
export function adjustVfsRefsWithRetry(access: VfsReferenceAccess, ids: string[],
  op: 'increment' | 'decrement', context: string, log: ChatLogger): string[] {
  if (ids.length === 0) return [];
  let conn: SqlExecutor;
  try { conn = access.getConnection(); }
  catch (first) {
    log.warn(`[ChatV2::handlers] Failed to get vfs.db conn for ref ${op} during ${context} (retrying once): ${errorText(first)}`);
    try { conn = access.getConnection(); }
    catch (second) {
      log.error(`[ChatV2::handlers] VFS ref ${op} SKIPPED for all ${ids.length} resource(s) during ${context} (conn failed after retry): ${errorText(second)} — resource_ids=[${ids.join(', ')}]`);
      return [...ids];
    }
  }
  const failed: string[] = [];
  for (const id of ids) {
    try { access[op](conn, id); }
    catch (first) {
      log.warn(`[ChatV2::handlers] VFS ref ${op} failed for ${id} during ${context} (retrying once): ${errorText(first)}`);
      try { access[op](conn, id); }
      catch (second) {
        log.error(`[ChatV2::handlers] VFS ref ${op} FAILED after retry for ${id} during ${context}: ${errorText(second)}`);
        failed.push(id);
      }
    }
  }
  if (failed.length > 0) log.error(`[ChatV2::handlers] VFS ref ${op} failure summary during ${context}: ${failed.length}/${ids.length} resource(s) failed after retry — resource_ids=[${failed.join(', ')}]`);
  else log.debug(`[ChatV2::handlers] VFS ref ${op} completed for ${ids.length} resource reference(s) during ${context}`);
  return failed;
}
export function decrementSessionRefs(db: SqlExecutor, access: VfsReferenceAccess, sessionId: string, log: ChatLogger): void {
  let messages: ChatMessage[];
  try { messages = getSessionMessages(db, sessionId, log); }
  catch (error) {
    log.warn(`[ChatV2::handlers] Failed to load messages for VFS ref decrement (session ${sessionId}): ${errorText(error)}`);
    return;
  }
  adjustVfsRefsWithRetry(access, messages.flatMap(messageResourceIds), 'decrement', `delete_session(${sessionId})`, log);
}
export function decrementMessageRefs(access: VfsReferenceAccess, message: ChatMessage, log: ChatLogger): void {
  const ids = messageResourceIds(message);
  if (ids.length === 0) return;
  let conn: SqlExecutor;
  try { conn = access.getConnection(); }
  catch (error) {
    log.warn('[ChatV2::handlers] Failed to get vfs.db connection for decrement refs: ' + errorText(error)); return;
  }
  try { access.decrementMany(conn, ids); }
  catch (error) {
    log.warn(`[ChatV2::handlers] Failed to decrement refs for message ${message.id}: ${errorText(error)}`); return;
  }
  log.debug(`[ChatV2::handlers] Decremented refs for ${ids.length} resources in vfs.db before deleting message ${message.id}`);
}

/** Trash loading failures are intentionally silent (manage_session.rs:1006). */
export function trashResourceIds(db: SqlExecutor, ids: string[], log: ChatLogger): string[] {
  const resources: string[] = [];
  for (const id of ids) {
    let messages: ChatMessage[];
    try { messages = getSessionMessages(db, id, log); }
    catch { continue; }
    resources.push(...messages.flatMap(messageResourceIds));
  }
  return resources;
}
