// Rust chatanki_executor.rs:3812–4057 (enqueue_library_review / set_library_suspended /
// undo_library_last_review) and :12057–12094 `finish_library_agent_review_mutation`.
// Every write is the published L15 `*ForLibrary('agent', ...)`; this lane only
// projects payloads and emits the post-commit `fsrs://changed` event.
import type {
  ChatAnkiLibraryReviewService, ChatAnkiToolExecutor, FsrsAgentReviewMutationOutcome,
  FsrsAgentReviewStateSnapshot, ToolCall, ToolConcurrency, ToolExecutionContext,
  ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import type { FsrsLibraryEnqueueOutcome } from '../../review/api.ts';
import { STATUS_NOT_FOUND } from './card-access.ts';
import {
  parseChatAnkiEnqueueLibraryReviewArgs, parseChatAnkiSetLibrarySuspendedArgs,
  parseChatAnkiUndoLibraryLastReviewArgs,
} from './executor-args.ts';
import { chatankiSensitivityForCall } from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import {
  chatankiLibraryReviewMutationConflictPayload, chatankiReviewMutationBlockedPayload,
  chatankiReviewMutationOkPayload,
} from './library-output.ts';
import { emitAgentReviewChanged, emitEnqueueReviewChanged } from './review-executor.ts';
import {
  beginChatAnkiToolCall, finishChatAnkiAppFailure, finishChatAnkiFailure,
  finishChatAnkiSuccess, publishedAppError,
} from './result.ts';

const ANKI_DB_UNAVAILABLE = 'blocks.ankiCards.errors.databaseUnavailable';
/** `AnkiLibraryScope::agent()`. */
export const AGENT_LIBRARY_SCOPE = 'agent';

type LibraryReviewMethod = keyof ChatAnkiLibraryReviewService;

function libraryReviewService<const M extends LibraryReviewMethod>(
  ctx: ToolExecutionContext, tool: string, methods: readonly M[],
): { service: Required<Pick<ChatAnkiLibraryReviewService, M>> & ChatAnkiLibraryReviewService } | { error: string } {
  const service = ctx.libraryReviews ?? null;
  if (service === null) return { error: ANKI_DB_UNAVAILABLE };
  const missing = methods.filter((method) => typeof service[method] !== 'function');
  if (missing.length > 0) {
    return { error: `${tool} requires the L15 review service (${missing.join(', ')})` };
  }
  return { service: service as Required<Pick<ChatAnkiLibraryReviewService, M>> & ChatAnkiLibraryReviewService };
}

function finishLibraryAgentReviewMutation(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
  cardId: string, action: string, outcome: FsrsAgentReviewMutationOutcome,
): ToolResultInfo {
  emitAgentReviewChanged(ctx, action, outcome);
  switch (outcome.status) {
    case 'updated':
      return finishChatAnkiSuccess(call, ctx, startedAt,
        chatankiReviewMutationOkPayload(cardId, outcome.state, outcome.changed));
    case 'conflict':
      return finishChatAnkiSuccess(call, ctx, startedAt,
        chatankiLibraryReviewMutationConflictPayload(cardId, outcome.current));
    case 'blocked':
      return finishChatAnkiSuccess(call, ctx, startedAt,
        chatankiReviewMutationBlockedPayload(cardId, outcome.reason, outcome.current));
    case 'not_found':
      return finishChatAnkiFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
  }
}

function serviceFailure(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number, caught: unknown,
): ToolResultInfo {
  const appError = publishedAppError(caught);
  if (appError !== null) return finishChatAnkiAppFailure(call, ctx, startedAt, appError);
  return finishChatAnkiFailure(call, ctx, startedAt, errorText(caught));
}

/** chatanki_executor.rs:3812–3950. */
async function executeEnqueueLibraryReview(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
): Promise<ToolResultInfo> {
  let cards;
  try { cards = parseChatAnkiEnqueueLibraryReviewArgs(call.arguments); }
  catch (caught) {
    return finishChatAnkiFailure(call, ctx, startedAt,
      `Invalid chatanki_enqueue_library_review arguments: ${errorText(caught)}`);
  }
  const resolved = libraryReviewService(ctx, 'chatanki_enqueue_library_review',
    ['enqueueCardsForLibrary', 'getReviewStatesForLibrary']);
  if ('error' in resolved) return finishChatAnkiFailure(call, ctx, startedAt, resolved.error);
  const { service } = resolved;
  const cardIds = cards.map((card) => card.cardId);
  let outcome: FsrsLibraryEnqueueOutcome;
  try {
    outcome = service.enqueueCardsForLibrary(AGENT_LIBRARY_SCOPE, cards.map((card) => ({
      cardId: card.cardId, expectedContentVersion: card.expectedVersion,
    })));
  } catch (caught) {
    return serviceFailure(call, ctx, startedAt, caught);
  }
  switch (outcome.status) {
    case 'enqueued': {
      const result = outcome.result;
      emitEnqueueReviewChanged(ctx, service, result);
      let reviewStates = new Map<string, FsrsAgentReviewStateSnapshot>();
      let reviewStateUnavailable = false;
      try {
        const states = service.getReviewStatesForLibrary(AGENT_LIBRARY_SCOPE, cardIds);
        reviewStates = new Map(states.map((state) => [state.ankiCardId, state]));
      } catch (caught) {
        ctx.warn(`[ChatAnkiToolExecutor] Failed to refresh library review states after enqueue: ${errorText(caught)}`);
        reviewStateUnavailable = true;
      }
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: reviewStateUnavailable ? 'partial' : 'ok',
        enqueued: result.enqueued,
        skipped: result.skipped,
        cards: cardIds.map((cardId) => (reviewStateUnavailable
          ? { cardId, reviewStateUnavailable: true }
          : { cardId, reviewState: reviewStates.get(cardId) ?? null })),
        mutationApplied: result.enqueued > 0,
        retryable: false,
        reviewStateUnavailable,
      });
    }
    case 'conflict':
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: 'conflict',
        error: 'version_conflict',
        conflicts: outcome.conflicts.map((conflict) => ({
          cardId: conflict.cardId,
          expectedVersion: conflict.expectedVersion,
          currentVersion: conflict.currentVersion,
        })),
        mutationApplied: false,
        retryable: true,
        guidance: 'Call builtin-chatanki_list_library_cards to refresh content versions before retrying.',
      });
    case 'not_found':
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: 'not_found',
        error: 'card_not_found',
        cardIds: [...outcome.cardIds],
        mutationApplied: false,
        retryable: true,
        guidance: 'Call builtin-chatanki_list_library_cards to refresh the live card set before retrying.',
      });
    case 'blocked':
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: 'blocked',
        error: outcome.reason,
        cardIds: [...outcome.cardIds],
        mutationApplied: false,
        retryable: false,
      });
  }
}

/** chatanki_executor.rs:3952–4003. */
async function executeSetLibrarySuspended(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
): Promise<ToolResultInfo> {
  let args;
  try { args = parseChatAnkiSetLibrarySuspendedArgs(call.arguments); }
  catch (caught) {
    return finishChatAnkiFailure(call, ctx, startedAt,
      `Invalid chatanki_set_library_suspended arguments: ${errorText(caught)}`);
  }
  const resolved = libraryReviewService(ctx, 'chatanki_set_library_suspended', ['setSuspendedForLibrary']);
  if ('error' in resolved) return finishChatAnkiFailure(call, ctx, startedAt, resolved.error);
  let outcome: FsrsAgentReviewMutationOutcome;
  try {
    outcome = resolved.service.setSuspendedForLibrary(
      AGENT_LIBRARY_SCOPE, args.cardId, args.expectedReviewVersion, args.suspended,
    );
  } catch (caught) {
    return serviceFailure(call, ctx, startedAt, caught);
  }
  return finishLibraryAgentReviewMutation(call, ctx, startedAt, args.cardId, 'set_suspended', outcome);
}

/** chatanki_executor.rs:4005–4057. */
async function executeUndoLibraryLastReview(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
): Promise<ToolResultInfo> {
  let args;
  try { args = parseChatAnkiUndoLibraryLastReviewArgs(call.arguments); }
  catch (caught) {
    return finishChatAnkiFailure(call, ctx, startedAt,
      `Invalid chatanki_undo_library_last_review arguments: ${errorText(caught)}`);
  }
  const resolved = libraryReviewService(ctx, 'chatanki_undo_library_last_review', ['undoLastReviewForLibrary']);
  if ('error' in resolved) return finishChatAnkiFailure(call, ctx, startedAt, resolved.error);
  let outcome: FsrsAgentReviewMutationOutcome;
  try {
    outcome = resolved.service.undoLastReviewForLibrary(
      AGENT_LIBRARY_SCOPE, args.cardId, args.expectedReviewVersion, args.expectedLogId,
    );
  } catch (caught) {
    return serviceFailure(call, ctx, startedAt, caught);
  }
  return finishLibraryAgentReviewMutation(call, ctx, startedAt, args.cardId, 'undo_last_review', outcome);
}

export class ChatAnkiLibraryReviewExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    const name = stripToolNamespace(toolName);
    return name === 'chatanki_enqueue_library_review'
      || name === 'chatanki_set_library_suspended'
      || name === 'chatanki_undo_library_last_review';
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  /** Split handler label; registration uses the folded `ChatAnkiToolExecutor` (`executors.ts`). */
  name(): string { return 'ChatAnkiLibraryReviewExecutor'; }

  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const startedAt = performance.now();
    beginChatAnkiToolCall(call, ctx);
    switch (stripToolNamespace(call.name)) {
      case 'chatanki_enqueue_library_review': return executeEnqueueLibraryReview(call, ctx, startedAt);
      case 'chatanki_set_library_suspended': return executeSetLibrarySuspended(call, ctx, startedAt);
      case 'chatanki_undo_library_last_review': return executeUndoLibraryLastReview(call, ctx, startedAt);
      default:
        return finishChatAnkiFailure(call, ctx, startedAt,
          `Unsupported chatanki library review tool: ${call.name}`);
    }
  }
}
