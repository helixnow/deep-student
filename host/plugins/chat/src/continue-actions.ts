/**
 * `chat_v2_continue_message` (Rust `chat_v2/handlers/send_message.rs:2010-2237`).
 * Resumes an interrupted turn from the persisted unfinished todo list. The todo
 * row read and the executor memory restore belong to L06 (todo_executor.rs:265-349)
 * and go through its published api; the L03 pipeline owns every write of the turn.
 */
import type { WindowRef } from '../../../kernel/api.ts';
import type { SendOptions } from '../../../../contracts/ipc/generated/_shared.ts';
import type { ChatMessage, ChatV2Database } from '../api.ts';
import {
  loadPersistedTodoListWithConn, restoreTodoListFromDbWithConn, todoCompletedCount, todoIsAllDone, todoTotalCount,
} from '../../agent-orchestration/portable.ts';
import type { PersistedTodoList } from '../../agent-orchestration/api.ts';
import { getMessageBlocks, type StoredBlock } from '../repository/blocks.ts';
import { getMessage } from '../repository/messages.ts';
import { databaseOperation } from '../repository/errors.ts';
import { ChatV2Error } from './error.ts';
import { ensureSessionWritable } from './handlers.ts';
import { errorText, type ChatLogger } from './logger.ts';
import { KILL_SWITCH_BLOCKED_MESSAGE, StreamGuard, type ChatV2State } from './state.ts';
import { isModelMultimodal, type BackendSendRequest, type SendModelLookup, type SendPipelinePort } from './send-message.ts';
import {
  filterPathMapForSendRefs, findPrecedingUserMessageWithAttachments, restoreContextRefsFromSnapshot,
  type ContextRefRestoreDeps,
} from './context-restore.ts';

export interface ContinueCommandDeps {
  database: ChatV2Database;
  state: ChatV2State;
  pipeline: SendPipelinePort;
  llm: SendModelLookup;
  contextRefs: ContextRefRestoreDeps;
  log: ChatLogger;
}

const debugOption = (value: string | null | undefined): string => value == null ? 'None' : `Some(${JSON.stringify(value)})`;

const RESUMABLE_VARIANT_STATUSES = new Set(['interrupted', 'cancelled', 'error', 'streaming']);
const LENGTH_FINISH_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);
const DANGLING_SUFFIX_RE = /(?:[：:，,、([（【+\-×÷=→⇒]|于是|因此|例如|包括|如下|建议写成|也就是说|换言之)$/;

function isResumableAssistantMessage(message: ChatMessage, variantId: string | null, blocks: readonly StoredBlock[]): boolean {
  if (message.role !== 'assistant' || blocks.length === 0) return false;
  if (message._meta?.stoppedByUser === true) return true;

  const targetVariantId = variantId ?? message.activeVariantId ?? null;
  if (targetVariantId !== null) {
    const variant = message.variants?.find(v => v.id === targetVariantId);
    if (variant !== undefined && RESUMABLE_VARIANT_STATUSES.has(variant.status)) return true;
  }

  if (blocks.some(block => block.status !== 'success' || block.error != null)) return true;

  const meta = message._meta as Record<string, unknown> | undefined;
  if (meta?.truncated === true) return true;
  const finishReason = typeof meta?.finishReason === 'string'
    ? meta.finishReason
    : typeof meta?.finish_reason === 'string'
      ? meta.finish_reason
      : null;
  if (finishReason !== null && LENGTH_FINISH_REASONS.has(finishReason.trim().toLowerCase())) return true;

  const content = blocks
    .filter(block => block.type === 'content')
    .map(block => block.content ?? '')
    .join('\n')
    .trim();
  if (content.length >= 200) {
    const fenceCount = content.match(/^[ \t]*```/gm)?.length ?? 0;
    if (fenceCount % 2 === 1) return true;
    const mathCount = content.match(/\$\$/g)?.length ?? 0;
    if (mathCount % 2 === 1) return true;
    if (DANGLING_SUFFIX_RE.test(content)) return true;
  }

  return false;
}

/** `chat_v2_continue_message`; returns the persisted assistant message id. */
export async function continueMessageAction(deps: ContinueCommandDeps, sessionId: string, messageId: string,
  variantId: string | null, options: SendOptions | null, window: WindowRef): Promise<string> {
  const { database, state, log } = deps;
  log.info(`[ChatV2::handlers] chat_v2_continue_message: session_id=${sessionId}, message_id=${messageId}, variant_id=${debugOption(variantId)}`);
  ensureSessionWritable(databaseOperation(() => database.getConnSafe()), sessionId);

  // load_persisted_todo_list(&db, ..): `db.get_conn()` and the row read share one error wrapper.
  const todoLog = { info: (message: string) => log.info(message) };
  let todoInfo: PersistedTodoList | null;
  try { todoInfo = loadPersistedTodoListWithConn(database.getConn(), sessionId, todoLog); }
  catch (error) { throw new ChatV2Error('Other', `Failed to load TodoList: ${errorText(error)}`); }

  let persistedMessageId: string;
  let persistedVariantId: string | null;
  if (todoInfo !== null) {
    const { list: todoList, messageId: todoMessageId, variantId: todoVariantId } = todoInfo;
    persistedMessageId = todoMessageId;
    persistedVariantId = todoVariantId;
    if (persistedMessageId !== messageId) {
      log.warn(`[ChatV2::handlers] Message ID mismatch: expected=${persistedMessageId}, got=${messageId}`);
    }
    if (todoIsAllDone(todoList)) {
      // boundary-allow todo-marker: Rust error text verbatim (send_message.rs:2063).
      throw new ChatV2Error('Validation', 'TODO list is already complete. No need to continue.');
    }
    log.info(`[ChatV2::handlers] Found incomplete TODO list: id=${todoList.id}, title=${todoList.title}, progress=${todoCompletedCount(todoList)}/${todoTotalCount(todoList)}`);
  } else {
    const conn = databaseOperation(() => database.getConnSafe());
    const candidate = getMessage(conn, messageId);
    const blocks = candidate !== null && candidate.sessionId === sessionId ? getMessageBlocks(conn, messageId) : [];
    if (candidate === null || candidate.sessionId !== sessionId || !isResumableAssistantMessage(candidate, variantId, blocks)) {
      // boundary-allow todo-marker: Rust error text verbatim (send_message.rs:2044).
      throw new ChatV2Error('Validation', 'No incomplete TODO list found. Cannot continue execution.');
    }
    persistedMessageId = messageId;
    persistedVariantId = null;
    log.info(`[ChatV2::handlers] Continuing interrupted/truncated assistant message in-place without TODO list: session_id=${sessionId}, message_id=${messageId}`);
  }

  // admit_or_block, then try_register_stream_owned before any memory restore (the 🔧 ordering fix).
  if (state.killSwitch.isTripped()) throw new ChatV2Error('Other', KILL_SWITCH_BLOCKED_MESSAGE);
  const registration = state.tryRegisterStreamOwned(sessionId);
  if (registration === null) {
    throw new ChatV2Error('Other', state.killSwitch.isTripped() ? KILL_SWITCH_BLOCKED_MESSAGE
      : 'Session has an active stream. Please wait for completion or cancel first.');
  }
  const guard = new StreamGuard(state, sessionId, registration);
  let spawned = false;
  try {
    if (todoInfo !== null) {
      try { restoreTodoListFromDbWithConn(database.getConn(), sessionId, todoLog); }
      catch (error) { throw new ChatV2Error('Other', `Failed to restore TodoList: ${errorText(error)}`); }
    }

    const original = getMessage(databaseOperation(() => database.getConnSafe()), persistedMessageId);
    if (original === null) throw new ChatV2Error('MessageNotFound', persistedMessageId);

    const targetVariantId = variantId ?? persistedVariantId ?? original.activeVariantId ?? null;
    if (targetVariantId !== null) {
      const variant = original.variants?.find(v => v.id === targetVariantId);
      if (variant !== undefined && variant.status !== 'interrupted') {
        log.warn(`[ChatV2::handlers] Variant status is '${variant.status}', not 'interrupted'. Allowing continue anyway.`);
      }
    }

    const user = findPrecedingUserMessageWithAttachments(databaseOperation(() => database.getConnSafe()), sessionId, original);
    const modelId = options?.modelId ?? null;
    const multimodal = await isModelMultimodal(deps.llm, modelId, log);
    log.info(`[ChatV2::handlers] Continue: model_id=${debugOption(modelId)}, is_multimodal=${multimodal}`);
    const restoredRefs = user.contextSnapshot === null ? null
      : await restoreContextRefsFromSnapshot(deps.contextRefs, user.contextSnapshot, multimodal, log);
    const restoredPathMap = filterPathMapForSendRefs(user.contextSnapshot?.pathMap, restoredRefs);

    const merged = { ...(options ?? {}), isContinue: true, continueVariantId: targetVariantId,
      streamGeneration: registration.generation };
    const request: BackendSendRequest = {
      sessionId, content: user.content, assistantMessageId: persistedMessageId, userContextRefs: restoredRefs,
      options: merged as BackendSendRequest['options'], userMessageId: null, pathMap: restoredPathMap, workspaceId: null,
    };

    const { pipeline } = deps;
    state.spawnTracked((async () => {
      try {
        let result: string;
        try { result = await pipeline.execute(window, request, registration.token.signal, state); }
        finally { log.debug(`[ChatV2::handlers] Continue stream cleanup completed for session: ${sessionId}`); }
        log.info(`[ChatV2::handlers] Continue execution completed: session_id=${sessionId}, message_id=${result}`);
      } catch (error) {
        if (error instanceof ChatV2Error && error.kind === 'Cancelled') {
          log.info(`[ChatV2::handlers] Continue execution cancelled: session_id=${sessionId}`);
        } else {
          log.error(`[ChatV2::handlers] Continue execution error: session_id=${sessionId}, error=${errorText(error)}`);
        }
      } finally { guard.dispose(); }
    })());
    spawned = true;
    return persistedMessageId;
  } finally { if (!spawned) guard.dispose(); }
}
