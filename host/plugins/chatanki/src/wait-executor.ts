// Rust chatanki_executor.rs:5039–5547 `execute_wait`.
// Polls document_tasks (authoritative when a documentId is known) and the
// `anki_cards` block, then refreshes a terminal block from the DB rows.
import type {
  AnkiCard, ChatAnkiCardRepository, ChatAnkiDocumentTaskRepository, ChatAnkiToolExecutor,
  DocumentTask, ToolCall, ToolConcurrency, ToolExecutionContext, ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import { syncTerminalAnkiBlockWithDb } from './block-reap.ts';
import { decideWaitTimeoutStatus } from './block-timing.ts';
import { STATUS_NOT_FOUND, verifyDocumentOwnership } from './card-access.ts';
import { parseChatAnkiWaitArgs, type ChatAnkiWaitArgs } from './executor-args.ts';
import {
  BLOCK_STATUS, chatankiSensitivityForCall, classifyGenerationTerminal, computeTaskCounts,
  generationTerminalStage, projectChatankiWorkflow, tasksLimitReached,
} from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import { deepMergeValue } from './mutation-target.ts';
import { beginChatAnkiToolCall, finishChatAnkiSuccess } from './result.ts';
import { statusEmitter } from './status-executor.ts';
import { rustTrim } from '../../../platform/util/text.ts';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const BLOCK_DISCOVERY_GRACE_MS = 8_000;
const POLL_INTERVAL_MS = 900;
const WAIT_INVALID_ARGS = 'blocks.ankiCards.errors.waitInvalidArgs';
const WAIT_NOT_FOUND = 'blocks.ankiCards.errors.waitNotFound';
const WAIT_TIMEOUT = 'blocks.ankiCards.errors.waitTimeout';
const DOCUMENT_MISMATCH = 'chatanki_wait_document_mismatch';

interface AnkiDb {
  cards: ChatAnkiCardRepository;
  documents: ChatAnkiDocumentTaskRepository;
}

interface DocumentObservation {
  tasks: DocumentTask[];
  cards: AnkiCard[];
  progress: Record<string, unknown>;
  paused: boolean;
  inProgress: boolean;
}

function nonBlank(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = rustTrim(value);
  return trimmed.length === 0 ? null : trimmed;
}

/** `timeout_ms.filter(> 0).unwrap_or(DEFAULT).min(MAX)`. */
function effectiveTimeoutMs(raw: number | bigint | null): number {
  if (raw === null) return DEFAULT_TIMEOUT_MS;
  if (typeof raw === 'bigint') return raw > 0n ? MAX_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  return raw > 0 ? Math.min(raw, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function documentOwned(db: AnkiDb, documentId: string, ctx: ToolExecutionContext): boolean {
  try {
    verifyDocumentOwnership(db.cards, documentId, ctx.sessionId, ctx.warn);
    return true;
  } catch {
    return false;
  }
}

function observeDocument(db: AnkiDb, documentId: string): DocumentObservation {
  const tasks = db.documents.getTasksForDocument(documentId);
  const cards = db.cards.getCardsForDocument(documentId);
  const { counts, completedRatio } = computeTaskCounts(tasks);
  return {
    tasks,
    cards,
    progress: { counts, completedRatio },
    paused: tasks.some((task) => task.status === 'Paused'),
    inProgress: tasks.some((task) =>
      task.status === 'Pending' || task.status === 'Processing' || task.status === 'Streaming'),
  };
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Failure that still carries the structured wait output (Rust builds `ToolResultInfo` inline). */
function finishWaitFailure(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
  output: Record<string, unknown> | null, error: string,
): ToolResultInfo {
  const durationMs = Math.floor(performance.now() - startedAt);
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

export async function executeChatAnkiWait(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
): Promise<ToolResultInfo> {
  let args: ChatAnkiWaitArgs;
  try { args = parseChatAnkiWaitArgs(call.arguments); }
  catch (caught) {
    return finishWaitFailure(call, ctx, startedAt, null,
      `Invalid chatanki_wait arguments: ${errorText(caught)}`);
  }

  const chatDb = ctx.chatBlocks ?? null;
  const ankiDb: AnkiDb | null = ctx.cards != null && ctx.documents != null
    ? { cards: ctx.cards, documents: ctx.documents }
    : null;
  const timeoutMs = effectiveTimeoutMs(args.timeoutMs);
  const deadline = performance.now() + timeoutMs;

  let finalStatus = 'timeout';
  let finalError: string | null = null;
  let finalAnkiBlockId: string | null = null;
  let finalDocumentId: string | null = null;
  let finalCardsCount: number | null = null;
  // `undefined` is Rust `None`; a present-but-null block field is `Some(Value::Null)`.
  let finalProgress: unknown = undefined;
  let finalAnkiConnect: unknown = undefined;
  let finalLimitReached = false;
  let blockEverFound = false;

  const requestedBlockId = nonBlank(args.ankiBlockId);
  const requestedDocumentId = nonBlank(args.documentId);

  if (requestedBlockId === null && requestedDocumentId === null) {
    return finishWaitFailure(call, ctx, startedAt, {
      status: 'invalid_args',
      ankiBlockId: '',
      documentId: null,
      cardsCount: 0,
      progress: null,
      ankiConnect: null,
      error: WAIT_INVALID_ARGS,
      shouldRetry: false,
    }, WAIT_INVALID_ARGS);
  }

  if (requestedDocumentId !== null && ankiDb !== null
    && !documentOwned(ankiDb, requestedDocumentId, ctx)) {
    return finishWaitFailure(call, ctx, startedAt, {
      status: 'not_found',
      ankiBlockId: args.ankiBlockId ?? '',
      documentId: args.documentId,
      cardsCount: 0,
      progress: null,
      ankiConnect: null,
      error: STATUS_NOT_FOUND,
      shouldRetry: true,
    }, STATUS_NOT_FOUND);
  }

  for (;;) {
    if (ctx.isCancelled?.() === true) {
      finalStatus = 'cancelled';
      break;
    }

    if (requestedDocumentId !== null && ankiDb !== null) {
      const observed = observeDocument(ankiDb, requestedDocumentId);
      if (tasksLimitReached(observed.tasks)) finalLimitReached = true;
      finalDocumentId = requestedDocumentId;
      finalCardsCount = observed.cards.length;
      finalProgress = observed.progress;
      if (observed.tasks.length > 0) {
        if (observed.paused) {
          finalStatus = 'paused';
          break;
        }
        if (!observed.inProgress) {
          finalStatus = generationTerminalStage(classifyGenerationTerminal(observed.tasks, observed.cards));
          break;
        }
      }
    }

    if (requestedBlockId !== null) {
      finalAnkiBlockId = requestedBlockId;
      if (chatDb !== null) {
        const block = chatDb.getBlock(requestedBlockId);
        if (block !== null) {
          if (block.sessionId !== ctx.sessionId) {
            finalStatus = 'not_found';
            finalError = STATUS_NOT_FOUND;
            break;
          }
          blockEverFound = true;
          finalAnkiBlockId = block.id;

          const out = plainObject(block.toolOutput);
          if (out !== null) {
            const blockDocumentId = typeof out.documentId === 'string' ? nonBlank(out.documentId) : null;
            if (requestedDocumentId !== null && blockDocumentId !== null
              && requestedDocumentId !== blockDocumentId) {
              finalStatus = 'invalid_args';
              finalError = DOCUMENT_MISMATCH;
              break;
            }
            finalDocumentId = blockDocumentId ?? finalDocumentId;
            if (Object.hasOwn(out, 'progress')) finalProgress = out.progress;
            if (Object.hasOwn(out, 'ankiConnect')) finalAnkiConnect = out.ankiConnect;
            if (finalCardsCount === null && Array.isArray(out.cards)) finalCardsCount = out.cards.length;
          }

          // With a stable documentId, task rows are authoritative over any block status.
          const documentAuthoritative = requestedDocumentId !== null && ankiDb !== null;
          if (!documentAuthoritative && block.status === BLOCK_STATUS.SUCCESS) {
            finalStatus = 'completed';
            if (ankiDb !== null && finalDocumentId !== null) {
              const tasks = ankiDb.documents.getTasksForDocument(finalDocumentId);
              if (tasks.length > 0) {
                if (tasksLimitReached(tasks)) finalLimitReached = true;
                const cards = ankiDb.cards.getCardsForDocument(finalDocumentId);
                finalStatus = generationTerminalStage(classifyGenerationTerminal(tasks, cards));
              }
            }
            break;
          }
          if (!documentAuthoritative && block.status === BLOCK_STATUS.ERROR) {
            finalStatus = 'error';
            finalError = block.error ?? finalError;
            break;
          }
        }
      }
    }

    if (requestedDocumentId === null && ankiDb !== null && finalDocumentId !== null) {
      if (!documentOwned(ankiDb, finalDocumentId, ctx)) {
        finalStatus = 'not_found';
        finalError = STATUS_NOT_FOUND;
        break;
      }
      const observed = observeDocument(ankiDb, finalDocumentId);
      if (tasksLimitReached(observed.tasks)) finalLimitReached = true;
      finalCardsCount = observed.cards.length;
      finalProgress = observed.progress;
      if (observed.tasks.length > 0) {
        if (observed.paused) {
          finalStatus = 'paused';
          break;
        }
        if (!observed.inProgress) {
          finalStatus = generationTerminalStage(classifyGenerationTerminal(observed.tasks, observed.cards));
          break;
        }
      }
    }

    // A wait keyed only on ankiBlockId gives up early rather than blocking the whole turn.
    if (requestedDocumentId === null && requestedBlockId !== null && !blockEverFound
      && performance.now() - startedAt >= BLOCK_DISCOVERY_GRACE_MS) {
      finalStatus = 'not_found';
      finalError = WAIT_NOT_FOUND;
      break;
    }

    if (performance.now() >= deadline) {
      const documentWaitAvailable = (requestedDocumentId !== null || nonBlank(finalDocumentId) !== null)
        && ankiDb !== null;
      const decided = decideWaitTimeoutStatus(blockEverFound, documentWaitAvailable, timeoutMs);
      finalStatus = decided.status;
      finalError = decided.error;
      break;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (finalStatus === 'timeout' && finalError === null) finalError = WAIT_TIMEOUT;
  const shouldRetry = finalStatus === 'timeout' || finalStatus === 'not_found';

  let output: Record<string, unknown> = {
    status: finalStatus,
    ankiBlockId: finalAnkiBlockId ?? args.ankiBlockId ?? '',
    documentId: finalDocumentId,
    cardsCount: finalCardsCount ?? 0,
    usableCards: null,
    progress: finalProgress ?? null,
    ankiConnect: finalAnkiConnect ?? null,
    limitReached: finalLimitReached,
    error: finalError,
    shouldRetry,
  };
  if (finalStatus !== 'timeout' && finalStatus !== 'not_found' && finalStatus !== 'invalid_args'
    && ankiDb !== null && finalDocumentId !== null) {
    const tasks = ankiDb.documents.getTasksForDocument(finalDocumentId);
    const cards = ankiDb.cards.getCardsForDocument(finalDocumentId);
    output.usableCards = cards.filter((card) => !card.is_error_card).length;
    if (tasks.length > 0) {
      output = deepMergeValue(output, projectChatankiWorkflow(tasks, cards, null, 0).outputPatch) as Record<string, unknown>;
    }
    if (chatDb !== null) {
      try {
        syncTerminalAnkiBlockWithDb(chatDb, ctx.sessionId, finalDocumentId, tasks, cards, statusEmitter(ctx));
      } catch (caught) {
        ctx.warn(`[ChatAnkiToolExecutor] wait block refresh failed for ${finalDocumentId}: ${errorText(caught)}`);
      }
    }
  }

  if (finalStatus === 'invalid_args' || finalStatus === 'not_found') {
    return finishWaitFailure(call, ctx, startedAt, output, finalError ?? finalStatus);
  }
  return finishChatAnkiSuccess(call, ctx, startedAt, output);
}

export class ChatAnkiWaitExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === 'chatanki_wait';
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  /** Split handler label; registration uses the folded `ChatAnkiToolExecutor` (`executors.ts`). */
  name(): string { return 'ChatAnkiWaitExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const startedAt = performance.now();
    beginChatAnkiToolCall(call, ctx);
    return executeChatAnkiWait(call, ctx, startedAt);
  }
}
