// Rust: chatanki_executor.rs:2172–2325 `chatanki_status` handler.
// Reads the document task/card snapshot, projects the workflow, and refreshes a
// terminal `anki_cards` block from authoritative DB rows (`block-reap.ts`).
import type {
  AnkiCard, ChatAnkiToolExecutor, DocumentTask, ToolCall, ToolConcurrency,
  ToolExecutionContext, ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import { resolveChatankiReadSession } from './card-access.ts';
import { syncTerminalAnkiBlockWithDb, type ChatAnkiTerminalSyncEmitter } from './block-reap.ts';
import { deepMergeValue } from './mutation-target.ts';
import {
  chatankiSensitivityForCall, computeTaskCounts, deriveStatusSnapshot,
  projectChatankiWorkflow, tasksLimitReached,
} from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import {
  beginChatAnkiToolCall,
  finishChatAnkiFailure as finishFailure, finishChatAnkiSuccess as finishSuccess,
} from './result.ts';
import { deserializeSerdeStruct, serdeString, type SerdeStructField } from './serde-struct.ts';
import { rustTrim } from '../../../platform/util/text.ts';

const STATUS_FIELDS: readonly SerdeStructField[] = [{ name: 'documentId', read: serdeString }];

/**
 * `ChatAnkiStatusArgs` (chatanki_executor.rs:729–734): `rename_all = "camelCase"` and the
 * `documentId` alias equals the renamed name, so `document_id` is an unknown, ignored key.
 */
export function parseChatAnkiStatusArgs(raw: unknown): string {
  const [documentId] = deserializeSerdeStruct(raw, 'ChatAnkiStatusArgs', STATUS_FIELDS, false);
  return documentId as string;
}

export function statusEmitter(ctx: ToolExecutionContext): ChatAnkiTerminalSyncEmitter | null {
  const emitChunk = ctx.emitChunk;
  if (emitChunk === undefined || emitChunk === null) return null;
  return {
    emitChunk: (blockId, update) => emitChunk(blockId, update),
    emitError: (blockId, error) => {
      // chatanki_executor.rs:14303–14308: hosted contexts emit the chat-v2
      // `anki_cards` error event; only headless test/direct contexts lack it.
      if (ctx.emitBlockError !== undefined && ctx.emitBlockError !== null) {
        ctx.emitBlockError(blockId, error);
        return;
      }
      ctx.warn(
        `[ChatAnkiToolExecutor] anki_cards block ${blockId} terminal error: ${error}`,
      );
    },
  };
}

/** chatanki_executor.rs:2172–2325. */
export async function executeChatAnkiStatus(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let rawDocumentId: string;
  try { rawDocumentId = parseChatAnkiStatusArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_status arguments: ${errorText(caught)}`);
  }
  const documentId = rustTrim(rawDocumentId);
  if (documentId.length === 0) {
    return finishFailure(call, ctx, startedAt, 'documentId is required');
  }

  const repo = ctx.cards ?? null;
  const documents = ctx.documents ?? null;
  if (repo === null || documents === null) {
    return finishFailure(call, ctx, startedAt, 'Anki database not available');
  }

  let tasks: DocumentTask[];
  let cards: AnkiCard[];
  try {
    resolveChatankiReadSession(repo, documentId, ctx.sessionId, ctx.warn, ctx.info);
    tasks = documents.getTasksForDocument(documentId);
    cards = repo.getCardsForDocument(documentId);
  } catch (caught) {
    return finishFailure(call, ctx, startedAt, errorText(caught));
  }

  // `"counts": compute_task_counts(&tasks)`: the whole `{ counts, completedRatio }` value.
  const counts = computeTaskCounts(tasks);
  const snapshot = deriveStatusSnapshot(tasks, cards);
  const projection = tasks.length > 0
    ? projectChatankiWorkflow(tasks, cards, null, 0)
    : null;

  const store = ctx.chatBlocks ?? null;
  if (store !== null) {
    try {
      syncTerminalAnkiBlockWithDb(
        store, ctx.sessionId, documentId, tasks, cards, statusEmitter(ctx),
      );
    } catch (caught) {
      ctx.warn(`[ChatAnkiToolExecutor] status block refresh failed for ${documentId}:`
        + ` ${errorText(caught)}`);
    }
  }

  let output: Record<string, unknown> = {
    status: snapshot.status,
    documentId,
    counts,
    cardsCount: cards.length,
    usableCards: cards.filter((card) => !card.is_error_card).length,
    limitReached: tasksLimitReached(tasks),
    error: snapshot.error,
    shouldRetry: snapshot.shouldRetry,
  };
  if (projection !== null) {
    output = deepMergeValue(output, projection.outputPatch) as Record<string, unknown>;
  }

  const durationMs = Math.floor(performance.now() - startedAt);
  if (snapshot.status === 'not_found') {
    const error = snapshot.error ?? 'not_found';
    ctx.emitToolCallError(error);
    const result: ToolResultInfo = {
      toolCallId: call.id,
      blockId: ctx.blockId,
      toolName: call.name,
      input: call.arguments,
      output,
      success: false,
      error,
      durationMs,
    };
    try { ctx.saveToolBlock(result); }
    catch (caught) {
      ctx.warn(`[ChatAnkiToolExecutor] Failed to persist tool block: ${errorText(caught)}`);
    }
    return result;
  }

  return finishSuccess(call, ctx, startedAt, output);
}

export class ChatAnkiStatusExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === 'chatanki_status';
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  name(): string { return 'ChatAnkiStatusExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    beginChatAnkiToolCall(call, ctx);
    return executeChatAnkiStatus(call, ctx);
  }
}
