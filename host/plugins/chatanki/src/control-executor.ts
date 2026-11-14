// Rust chatanki_executor.rs:6483–6759 `execute_control`.
// Run control goes through L16's published `anki.pipeline`, the same
// EnhancedAnkiService wiring the pause/resume/cancel IPC commands use.
import type {
  AnkiCard, ChatAnkiDocumentPipeline, ChatAnkiToolExecutor, DocumentTask, ToolCall, ToolConcurrency,
  ToolExecutionContext, ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import { syncTerminalAnkiBlockWithDb } from './block-reap.ts';
import { verifyDocumentOwnership } from './card-access.ts';
import { parseChatAnkiControlArgs, type ChatAnkiControlArgs } from './executor-args.ts';
import { chatankiSensitivityForCall, computeTaskCounts } from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import {
  beginChatAnkiToolCall, chatAnkiHandlerError, finishChatAnkiInlineFailure as finishFailure,
  finishChatAnkiSuccess as finishSuccess,
} from './result.ts';
import { statusEmitter } from './status-executor.ts';
import { rustTrim } from '../../../platform/util/text.ts';

type PipelineEvents = Parameters<ChatAnkiDocumentPipeline['pauseDocumentProcessing']>[1];

/** `ctx.window_ref()`: the hosted backend bus unless the caller supplies its own event effect. */
function windowRef(ctx: ToolExecutionContext): PipelineEvents {
  const emit = ctx.emitEvent;
  return emit === undefined || emit === null ? undefined : { emit: (event, payload) => emit(event, payload) };
}

export async function executeChatAnkiControl(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
): Promise<ToolResultInfo> {
  let args: ChatAnkiControlArgs;
  try { args = parseChatAnkiControlArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt, `Invalid chatanki_control arguments: ${errorText(caught)}`);
  }

  const documentId = rustTrim(args.documentId);
  if (documentId.length === 0) return finishFailure(call, ctx, startedAt, 'documentId is required');

  const cards = ctx.cards ?? null;
  const documents = ctx.documents ?? null;
  const pipeline = ctx.pipeline ?? null;
  if (cards === null || documents === null || pipeline === null) {
    return finishFailure(call, ctx, startedAt, 'Anki database not available');
  }
  if (ctx.llmManagerPresent !== true) return finishFailure(call, ctx, startedAt, 'LLM manager not available');

  const action = rustTrim(args.action).toLowerCase();
  try { verifyDocumentOwnership(cards, documentId, ctx.sessionId, ctx.warn); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const events = windowRef(ctx);
  switch (action) {
    case 'pause':
      try { await pipeline.pauseDocumentProcessing(documentId, events); }
      catch (caught) {
        return finishFailure(call, ctx, startedAt, `Pause failed: ${errorText(caught)}`);
      }
      break;
    case 'resume':
      try { await pipeline.resumeDocumentProcessing(documentId, events); }
      catch (caught) {
        return finishFailure(call, ctx, startedAt, `Resume failed: ${errorText(caught)}`);
      }
      break;
    case 'retry': {
      const taskId = args.taskId === null ? '' : rustTrim(args.taskId);
      try {
        if (taskId.length > 0) {
          const task = pipeline.getTask(taskId);
          if (task.document_id !== documentId) {
            const bare = ctx.emitBareToolCallError ?? null;
            const emitting = bare === null ? ctx : { ...ctx, emitToolCallError: bare };
            return finishFailure(call, emitting, startedAt, 'blocks.ankiCards.errors.statusNotFound');
          }
          pipeline.updateTaskStatus(taskId, 'Pending', null);
        } else {
          pipeline.buildRetryTaskForDocument(documentId);
        }
        await pipeline.resumeDocumentProcessing(documentId, events);
      } catch (caught) {
        throw chatAnkiHandlerError(errorText(caught));
      }
      break;
    }
    case 'cancel':
      // Non-destructive: stops the scheduler, cancels unfinished tasks, keeps generated cards.
      try { await pipeline.cancelDocumentProcessing(documentId, events); }
      catch (caught) {
        return finishFailure(call, ctx, startedAt, `Cancel failed: ${errorText(caught)}`);
      }
      break;
    default:
      return finishFailure(call, ctx, startedAt, `Unsupported action: ${args.action}`);
  }

  let tasks: DocumentTask[];
  try { tasks = documents.getTasksForDocument(documentId); }
  catch (caught) { throw chatAnkiHandlerError(errorText(caught)); }
  const counts = computeTaskCounts(tasks);

  // A cancelled document is terminal: converge the block snapshot to the DB rows (cancelled + kept cards).
  const chatBlocks = ctx.chatBlocks ?? null;
  if (action === 'cancel' && chatBlocks !== null) {
    let documentCards: AnkiCard[] | null = null;
    try { documentCards = cards.getCardsForDocument(documentId); }
    catch (caught) {
      ctx.warn(`[ChatAnkiToolExecutor] cancel card reload failed for ${documentId}: ${errorText(caught)}`);
    }
    if (documentCards !== null) {
      try {
        syncTerminalAnkiBlockWithDb(chatBlocks, ctx.sessionId, documentId, tasks, documentCards, statusEmitter(ctx));
      } catch (caught) {
        ctx.warn(`[ChatAnkiToolExecutor] cancel block refresh failed for ${documentId}: ${errorText(caught)}`);
      }
    }
  }

  return finishSuccess(call, ctx, startedAt, { status: 'ok', action, documentId, counts });
}

export class ChatAnkiControlExecutor implements ChatAnkiToolExecutor {
  private readonly pipelinePublished: () => boolean;
  constructor(pipelinePublished: () => boolean) { this.pipelinePublished = pipelinePublished; }
  /** Claimed only while L16 publishes `anki.pipeline`; otherwise no executor can run it. */
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === 'chatanki_control' && this.pipelinePublished();
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  /** Split handler label; registration uses the folded `ChatAnkiToolExecutor` (`executors.ts`). */
  name(): string { return 'ChatAnkiControlExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const startedAt = performance.now();
    beginChatAnkiToolCall(call, ctx);
    return executeChatAnkiControl(call, ctx, startedAt);
  }
}
