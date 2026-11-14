/**
 * `chat_v2_retry_message` / `chat_v2_edit_and_resend`
 * (Rust `chat_v2/handlers/send_message.rs:919-1698`).
 * The L03 pipeline owns all writes of the regenerated turn; this module owns
 * admission, the stream registration, the destructive rewind and VFS refs.
 */
import type { WindowRef } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SendContextRef, SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import type { ChatMessage, ChatV2Database, EditAndResendResult, RetryMessageResult } from '../api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/index.ts';
import { getMessage, getSessionMessages, deleteMessage, updateMessage } from '../repository/messages.ts';
import { clearBlockLlmContent, getMessageBlocks, updateBlock } from '../repository/blocks.ts';
import { invalidateCompactionForMessage } from '../repository/compactions.ts';
import { databaseOperation } from '../repository/errors.ts';
import { ChatV2Error } from './error.ts';
import { ensureSessionWritable } from './handlers.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { generateMessageId } from './message-values.ts';
import { KILL_SWITCH_BLOCKED_MESSAGE, StreamGuard, type ChatV2State, type StreamRegistration } from './state.ts';
import { isModelMultimodal, type BackendSendRequest, type SendModelLookup, type SendPipelinePort } from './send-message.ts';
import type { VfsReferenceAccess } from './reference-counts.ts';
import { contextSnapshotAllResourceIds, newContextSnapshot, sendRefToContextRef } from './context-snapshot.ts';
import { createUserRefsSnapshot } from './user-message-builder.ts';
import {
  applyOriginalSkillSnapshotOverrides, applyReplayModeOverrides, filterPathMapForSendRefs,
  findPrecedingUserMessageWithAttachments, restoreContextRefsFromSnapshot, type ContextRefRestoreDeps,
} from './context-restore.ts';

/** L06 `agentSubagent.cancelWorkersDispatchedIn`; absent provider is the Rust no-op path. */
export interface DispatchedWorkerCanceller { cancelWorkersDispatchedIn(sessionId: string, messageIds: string[]): void }

export interface RetryCommandDeps {
  database: ChatV2Database;
  state: ChatV2State;
  pipeline: SendPipelinePort;
  llm: SendModelLookup;
  contextRefs: ContextRefRestoreDeps;
  vfsRefs: VfsReferenceAccess;
  superSession(): DispatchedWorkerCanceller | undefined;
  log: ChatLogger;
}

function debugOption(value: string | null | undefined): string {
  return value == null ? 'None' : `Some(${JSON.stringify(value)})`;
}

/** `admit_or_block` + `try_register_stream_owned` error mapping shared by both handlers. */
function admitAndRegister(state: ChatV2State, sessionId: string): StreamRegistration {
  if (state.killSwitch.isTripped()) throw new ChatV2Error('Other', KILL_SWITCH_BLOCKED_MESSAGE);
  const registration = state.tryRegisterStreamOwned(sessionId);
  if (registration === null) {
    throw new ChatV2Error('Other', state.killSwitch.isTripped() ? KILL_SWITCH_BLOCKED_MESSAGE
      : 'Session has an active stream. Please wait for completion or cancel first.');
  }
  return registration;
}

interface DeleteLogText { begin: string; deleted: string; failed: string; commit: string; summary: string; refs: string }
const RETRY_TEXT: DeleteLogText = {
  begin: 'Failed to begin transaction for retry', deleted: 'Deleted message for retry',
  failed: 'for retry', commit: 'Failed to commit transaction for retry',
  summary: 'messages after user message for retry (transaction committed)', refs: 'retry',
};
const EDIT_TEXT: DeleteLogText = {
  begin: 'Failed to begin transaction', deleted: 'Deleted subsequent message',
  failed: '', commit: 'Failed to commit transaction',
  summary: 'subsequent messages after editing (transaction committed)', refs: 'edit',
};

/** `let _ = conn.execute("ROLLBACK", [])`: the rollback outcome is deliberately discarded. */
function rollbackIgnoringError(conn: SqlExecutor): boolean {
  try { conn.exec('ROLLBACK'); return true; } catch { return false; }
}

/** The shared BEGIN IMMEDIATE delete loop + post-commit VFS decrement (send_message.rs:1069-1157 / 1531-1616). */
function deleteMessagesWithRefs(deps: RetryCommandDeps, ids: readonly string[], text: DeleteLogText): void {
  const { log } = deps;
  if (ids.length === 0) return;
  const conn = databaseOperation(() => deps.database.getConnSafe());
  const resourceIds: string[] = [];
  for (const id of ids) {
    let message: ChatMessage | null = null;
    try { message = getMessage(conn, id); } catch { message = null; }
    const snapshot = message?._meta?.contextSnapshot;
    if (snapshot != null) resourceIds.push(...contextSnapshotAllResourceIds(snapshot));
  }
  try { conn.exec('BEGIN IMMEDIATE'); }
  catch (error) {
    log.error(`[ChatV2::handlers] ${text.begin}: ${errorText(error)}`);
    throw new ChatV2Error('Database', errorText(error));
  }
  let deleted = 0;
  let deleteError: string | null = null;
  for (const id of ids) {
    try {
      deleteMessage(conn, id);
      deleted += 1;
      log.debug(`[ChatV2::handlers] ${text.deleted}: msg_id=${id}`);
    } catch (error) {
      log.error(`[ChatV2::handlers] Failed to delete message ${id}${text.failed ? ` ${text.failed}` : ''}: ${errorText(error)}`);
      deleteError = `Failed to delete message ${id}: ${errorText(error)}`;
      break;
    }
  }
  if (deleteError !== null) {
    rollbackIgnoringError(conn);
    throw new ChatV2Error('Database', deleteError);
  }
  try { conn.exec('COMMIT'); }
  catch (error) {
    log.error(`[ChatV2::handlers] ${text.commit}: ${errorText(error)}`);
    throw new ChatV2Error('Database', errorText(error));
  }
  log.info(`[ChatV2::handlers] Deleted ${deleted} ${text.summary}`);
  if (resourceIds.length === 0) return;
  let vfsConn: SqlExecutor;
  try { vfsConn = deps.vfsRefs.getConnection(); }
  catch {
    log.warn(`[ChatV2::handlers] Failed to get vfs_db connection for decrement refs (${text.refs})`);
    return;
  }
  try {
    deps.vfsRefs.decrementMany(vfsConn, resourceIds);
    log.debug(`[ChatV2::handlers] Decremented ${resourceIds.length} VFS refs after ${text.refs} delete`);
  } catch (error) {
    log.warn(`[ChatV2::handlers] Failed to decrement ${resourceIds.length} VFS refs after ${text.refs} delete (non-fatal): ${errorText(error)}`);
  }
}

/** Spawned body shared by retry and edit: the guard is owned by the task (`let _stream_guard = stream_guard`). */
function spawnPipeline(deps: RetryCommandDeps, window: WindowRef, request: BackendSendRequest,
  registration: StreamRegistration, guard: StreamGuard, label: string): void {
  const { state, pipeline, log } = deps;
  const sessionId = request.sessionId;
  state.spawnTracked((async () => {
    try {
      const result = await pipeline.execute(window, request, registration.token.signal, state);
      log.info(`[ChatV2::handlers] ${label} pipeline completed: session_id=${sessionId}, assistant_message_id=${result}`);
    } catch (error) {
      if (error instanceof ChatV2Error && error.kind === 'Cancelled') {
        log.info(`[ChatV2::handlers] ${label} pipeline cancelled: session_id=${sessionId}`);
      } else {
        log.error(`[ChatV2::handlers] ${label} pipeline error: session_id=${sessionId}, error=${errorText(error)}`);
      }
    } finally { guard.dispose(); }
  })());
}

function cancelDispatchedWorkers(deps: RetryCommandDeps, sessionId: string, ids: string[]): void {
  deps.superSession()?.cancelWorkersDispatchedIn(sessionId, ids);
}

/** `chat_v2_retry_message` (send_message.rs:919-1240). */
export async function retryMessageAction(deps: RetryCommandDeps, sessionId: string, messageId: string,
  options: SendOptions | null, window: WindowRef): Promise<RetryMessageResult> {
  const { database, state, log } = deps;
  log.info(`[ChatV2::handlers] chat_v2_retry_message: session_id=${sessionId}, message_id=${messageId}`);
  ensureSessionWritable(databaseOperation(() => database.getConnSafe()), sessionId);
  const original = getMessage(databaseOperation(() => database.getConnSafe()), messageId);
  if (original === null) throw new ChatV2Error('MessageNotFound', messageId);
  if (original.role === 'user') {
    throw new ChatV2Error('Validation', 'Retry is only for assistant messages. Use edit_and_resend for user messages.');
  }
  const registration = admitAndRegister(state, sessionId);
  const guard = new StreamGuard(state, sessionId, registration);
  let spawned = false;
  try {
    const user = findPrecedingUserMessageWithAttachments(databaseOperation(() => database.getConnSafe()), sessionId, original);
    const modelId = options?.modelId ?? null;
    const multimodal = await isModelMultimodal(deps.llm, modelId, log);
    if (registration.token.signal.aborted) throw new ChatV2Error('Cancelled');
    log.info(`[ChatV2::handlers] Retry: model_id=${debugOption(modelId)}, is_multimodal=${multimodal}`);
    const restoredRefs = user.contextSnapshot === null ? null
      : await restoreContextRefsFromSnapshot(deps.contextRefs, user.contextSnapshot, multimodal, log);
    // Stop may release admission to another tab while restoration is awaiting IO.
    // Never let that cancelled turn rewind the newer turn's persisted messages.
    if (registration.token.signal.aborted) throw new ChatV2Error('Cancelled');
    const restoredPathMap = filterPathMapForSendRefs(user.contextSnapshot?.pathMap, restoredRefs);
    if (restoredRefs !== null && restoredRefs.length > 0) {
      log.info(`[ChatV2::handlers] Retry with restored context refs: count=${restoredRefs.length}`);
    }
    const toDelete = rewindIds(deps, sessionId, messageId, 0, all =>
      log.info(`[ChatV2::handlers] Retry: found ${all} total messages in session`),
      (index, total, count) => log.info(`[ChatV2::handlers] Retry: target_index=${index}, total_messages=${total}, to_delete=${count}`));
    cancelDispatchedWorkers(deps, sessionId, toDelete);
    deleteMessagesWithRefs(deps, toDelete, RETRY_TEXT);
    let merged = applyOriginalSkillSnapshotOverrides(applyReplayModeOverrides({ ...(options ?? {}) }),
      original._meta, user.messageMeta);
    merged = { ...merged, skipUserMessageSave: true, streamGeneration: registration.generation };
    const request: BackendSendRequest = {
      sessionId, content: user.content, options: merged as BackendSendRequest['options'], userMessageId: null,
      assistantMessageId: messageId, userContextRefs: restoredRefs, pathMap: restoredPathMap, workspaceId: null,
    };
    spawnPipeline(deps, window, request, registration, guard, 'Retry');
    spawned = true;
    return { message_id: messageId, ...(toDelete.length === 0 ? {} : { deleted_message_ids: toDelete }) };
  } finally { if (!spawned) guard.dispose(); }
}

/** Index-based rewind used by both handlers (send_message.rs:1033-1063 / 1495-1523). */
function rewindIds(deps: RetryCommandDeps, sessionId: string, messageId: string, offset: 0 | 1,
  found: ((total: number) => void) | null, report: (index: number, total: number, count: number) => void): string[] {
  const conn = databaseOperation(() => deps.database.getConnSafe());
  const all = getSessionMessages(conn, sessionId);
  found?.(all.length);
  const index = all.findIndex(message => message.id === messageId);
  if (index < 0) throw new ChatV2Error('MessageNotFound', messageId);
  const ids = all.slice(index + offset).map(message => message.id);
  report(index, all.length, ids.length);
  return ids;
}

/** `chat_v2_edit_and_resend` (send_message.rs:1268-1698). */
export async function editAndResendAction(deps: RetryCommandDeps, sessionId: string, messageId: string,
  newContent: string, newContextRefs: SendContextRef[] | null, newPathMap: Record<string, string> | null,
  options: SendOptions | null, window: WindowRef): Promise<EditAndResendResult> {
  const { database, state, log } = deps;
  log.info(`[ChatV2::handlers] chat_v2_edit_and_resend: session_id=${sessionId}, message_id=${messageId}, new_content_len=${utf8ByteLength(newContent)}`);
  ensureSessionWritable(databaseOperation(() => database.getConnSafe()), sessionId);
  if (rustTrim(newContent) === '') throw new ChatV2Error('Validation', 'New content cannot be empty');
  const original = getMessage(databaseOperation(() => database.getConnSafe()), messageId);
  if (original === null) throw new ChatV2Error('MessageNotFound', messageId);
  if (original.role !== 'user') throw new ChatV2Error('Validation', 'Can only edit user messages');
  if (original.sessionId !== sessionId) {
    throw new ChatV2Error('Validation', `Message ${messageId} does not belong to session ${sessionId}`);
  }
  const registration = admitAndRegister(state, sessionId);
  const guard = new StreamGuard(state, sessionId, registration);
  let spawned = false;
  try {
    const originalSnapshot = original._meta?.contextSnapshot ?? null;
    let finalRefs: SendContextRef[] | null;
    if (newContextRefs !== null) {
      if (newContextRefs.length === 0) log.info('[ChatV2::handlers] Edit and resend with EXPLICIT empty context refs');
      else log.info(`[ChatV2::handlers] Edit and resend with NEW context refs: count=${newContextRefs.length}`);
      finalRefs = structuredClone(newContextRefs);
    } else {
      const modelId = options?.modelId ?? null;
      const multimodal = await isModelMultimodal(deps.llm, modelId, log);
      if (registration.token.signal.aborted) throw new ChatV2Error('Cancelled');
      log.info(`[ChatV2::handlers] Edit and resend: model_id=${debugOption(modelId)}, is_multimodal=${multimodal}`);
      finalRefs = originalSnapshot === null ? null
        : await restoreContextRefsFromSnapshot(deps.contextRefs, originalSnapshot, multimodal, log);
      if (registration.token.signal.aborted) throw new ChatV2Error('Cancelled');
      if (finalRefs !== null && finalRefs.length > 0) {
        log.info(`[ChatV2::handlers] Edit and resend with restored context refs: count=${finalRefs.length}`);
      }
    }
    const finalPathMap = newContextRefs !== null
      ? newContextRefs.length === 0 ? null
        : filterPathMapForSendRefs(newPathMap ?? originalSnapshot?.pathMap, newContextRefs)
      : filterPathMapForSendRefs(originalSnapshot?.pathMap, finalRefs);

    const conn = databaseOperation(() => database.getConnSafe());
    databaseOperation(() => conn.transaction(tx => {
      invalidateCompactionForMessage(tx, sessionId, messageId, log);
      for (const block of getMessageBlocks(tx, messageId)) {
        if (block.type !== 'content') continue;
        updateBlock(tx, { ...block, content: newContent });
        clearBlockLlmContent(tx, block.id);
        log.debug(`[ChatV2::handlers] Updated content block (stale llm_content cleared): block_id=${block.id}`);
        break;
      }
      if (finalRefs !== null) {
        const userRefs = finalRefs.map(sendRefToContextRef);
        const meta = { ...(original._meta ?? {}) };
        if (userRefs.length === 0) delete meta.contextSnapshot;
        else {
          const snapshot = createUserRefsSnapshot(userRefs) ?? newContextSnapshot();
          if (finalPathMap !== null) snapshot.pathMap = { ...finalPathMap };
          meta.contextSnapshot = snapshot;
        }
        updateMessage(tx, { ...original, _meta: meta });
        log.info(`[ChatV2::handlers] Updated context_snapshot for edited user message: user_refs=${userRefs.length}`);
      }
    }));

    const toDelete = rewindIds(deps, sessionId, messageId, 1, null, (index, total, count) =>
      log.info(`[ChatV2::handlers] edit_and_resend: target_index=${index}, original_id=${messageId}, total_messages=${total}, to_delete=${count}`));
    cancelDispatchedWorkers(deps, sessionId, toDelete);
    deleteMessagesWithRefs(deps, toDelete, EDIT_TEXT);

    const assistantMessageId = generateMessageId();
    let merged = applyOriginalSkillSnapshotOverrides(applyReplayModeOverrides({ ...(options ?? {}) }), original._meta, null);
    merged = { ...merged, skipUserMessageSave: true, streamGeneration: registration.generation };
    const request: BackendSendRequest = {
      sessionId, content: newContent, options: merged as BackendSendRequest['options'], userMessageId: messageId,
      assistantMessageId, userContextRefs: finalRefs, pathMap: finalPathMap, workspaceId: null,
    };
    spawnPipeline(deps, window, request, registration, guard, 'Edit and resend');
    spawned = true;
    return { new_message_id: assistantMessageId, ...(toDelete.length === 0 ? {} : { deleted_message_ids: toDelete }) };
  } finally { if (!spawned) guard.dispose(); }
}
