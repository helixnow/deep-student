// Rust: chatanki_executor.rs:3339–3567 (enqueue_review / undo_last_review / set_suspended).
// Review-state writes stay inside the published L15 `review` service; this lane
// only resolves ownership, projects payloads and emits the post-commit event.
import type {
  ChatAnkiReviewStateService, ChatAnkiToolExecutor, FsrsAgentReviewMutationOutcome,
  FsrsEnqueueResult, ToolCall, ToolConcurrency, ToolExecutionContext, ToolResultInfo,
  ToolSensitivity,
} from '../api.ts';
import {
  resolveReviewSelection, STATUS_NOT_FOUND, verifyAgentReviewCardOwnership,
} from './card-access.ts';
import {
  parseChatAnkiEnqueueReviewArgs, parseChatAnkiSetSuspendedArgs,
  parseChatAnkiUndoLastReviewArgs,
} from './executor-args.ts';
import { chatankiSensitivityForCall } from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import {
  agentReviewChangedState, buildAgentReviewChangedPayload,
  chatankiReviewMutationBlockedPayload, chatankiReviewMutationConflictPayload,
  chatankiReviewMutationOkPayload,
} from './library-output.ts';
import { buildEnqueueReviewChangedPayload } from './review-payloads.ts';
import {
  beginChatAnkiToolCall,
  finishChatAnkiAppFailure,
  finishChatAnkiFailure as finishFailure, finishChatAnkiSuccess as finishSuccess,
  publishedAppError,
} from './result.ts';

const ANKI_DB_UNAVAILABLE = 'blocks.ankiCards.errors.databaseUnavailable';

/**
 * Rust parses the serde shape first and then runs `into_selector`; only the
 * latter errors are returned without the `Invalid ... arguments:` prefix.
 */
function isSelectorError(message: string): boolean {
  return message === 'documentId must not be empty'
    || message === 'cardIds must contain 1 to 100 entries'
    || message === 'cardIds must not contain empty IDs'
    || message === 'blocks.ankiCards.errors.reviewSelectorRequired';
}

export function emitEnqueueReviewChanged(
  ctx: ToolExecutionContext,
  service: Pick<ChatAnkiReviewStateService, 'getEnqueuedCards'>,
  result: FsrsEnqueueResult,
): void {
  const load = service.getEnqueuedCards;
  if (load === undefined) {
    ctx.warn('[ChatAnkiToolExecutor] Failed to load newly enqueued cards for fsrs://changed:'
      + ' L15 review service has no getEnqueuedCards()');
    return;
  }
  let loaded;
  try { loaded = load.call(service, result); }
  catch (caught) {
    ctx.warn('[ChatAnkiToolExecutor] Failed to load newly enqueued cards'
      + ` for fsrs://changed: ${errorText(caught)}`);
    return;
  }
  const payload = buildEnqueueReviewChangedPayload(result, loaded, ctx.runId ?? '');
  if (payload === null) return;
  try { ctx.emitEvent?.('fsrs://changed', payload); }
  catch (caught) {
    ctx.warn(`[ChatAnkiToolExecutor] Failed to emit fsrs://changed after enqueue: ${errorText(caught)}`);
  }
}

/** chatanki_executor.rs:12461–12474; only `Updated { changed: true }` emits. */
export function emitAgentReviewChanged(
  ctx: ToolExecutionContext, action: string, outcome: FsrsAgentReviewMutationOutcome,
): void {
  const state = agentReviewChangedState(outcome);
  if (state === null) return;
  try {
    ctx.emitEvent?.(
      'fsrs://changed',
      buildAgentReviewChangedPayload(action, state, ctx.runId ?? ''),
    );
  } catch (caught) {
    ctx.warn(`[ChatAnkiToolExecutor] Failed to emit fsrs://changed after ${action}: ${errorText(caught)}`);
  }
}

function finishAgentReviewMutation(
  call: ToolCall,
  ctx: ToolExecutionContext,
  startedAt: number,
  cardId: string,
  action: string,
  outcome: FsrsAgentReviewMutationOutcome,
): ToolResultInfo {
  emitAgentReviewChanged(ctx, action, outcome);
  switch (outcome.status) {
    case 'updated':
      return finishSuccess(call, ctx, startedAt,
        chatankiReviewMutationOkPayload(cardId, outcome.state, outcome.changed));
    case 'conflict':
      return finishSuccess(call, ctx, startedAt,
        chatankiReviewMutationConflictPayload(cardId, outcome.current));
    case 'blocked':
      return finishSuccess(call, ctx, startedAt,
        chatankiReviewMutationBlockedPayload(cardId, outcome.reason, outcome.current));
    case 'not_found':
      return finishFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
  }
}

/** chatanki_executor.rs:3339–3400 `execute_enqueue_review`. */
export async function executeChatAnkiEnqueueReview(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let selector;
  try { selector = parseChatAnkiEnqueueReviewArgs(call.arguments); }
  catch (caught) {
    const message = errorText(caught);
    return finishFailure(call, ctx, startedAt, isSelectorError(message)
      ? message
      : `Invalid chatanki_enqueue_review arguments: ${message}`);
  }
  const repo = ctx.cards ?? null;
  if (repo === null) return finishFailure(call, ctx, startedAt, ANKI_DB_UNAVAILABLE);

  let selection;
  try { selection = resolveReviewSelection(repo, ctx.sessionId, selector); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const reviewStates = ctx.reviewStates ?? null;
  if (reviewStates === null || reviewStates.enqueueCardsForSession === undefined) {
    return finishFailure(call, ctx, startedAt,
      'chatanki_enqueue_review requires the L15 review service (enqueueCardsForSession)');
  }

  let result: FsrsEnqueueResult;
  try {
    result = reviewStates.enqueueCardsForSession(
      selection.cardIds, ctx.sessionId, selection.expectedDocumentId,
    );
  } catch (caught) {
    const appError = publishedAppError(caught);
    if (appError !== null) return finishChatAnkiAppFailure(call, ctx, startedAt, appError);
    return finishFailure(call, ctx, startedAt, errorText(caught));
  }
  emitEnqueueReviewChanged(ctx, reviewStates, result);

  return finishSuccess(call, ctx, startedAt,
    { status: 'ok', enqueued: result.enqueued, skipped: result.skipped });
}

/** chatanki_executor.rs:3449–3504 `execute_undo_last_review`. */
export async function executeChatAnkiUndoLastReview(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args: ReturnType<typeof parseChatAnkiUndoLastReviewArgs>;
  try { args = parseChatAnkiUndoLastReviewArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_undo_last_review arguments: ${errorText(caught)}`);
  }
  const repo = ctx.cards ?? null;
  if (repo === null) return finishFailure(call, ctx, startedAt, ANKI_DB_UNAVAILABLE);
  try { verifyAgentReviewCardOwnership(repo, args.cardId, ctx.sessionId, ctx.warn); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const reviewStates = ctx.reviewStates ?? null;
  if (reviewStates === null || reviewStates.undoLastReviewForSession === undefined) {
    return finishFailure(call, ctx, startedAt,
      'chatanki_undo_last_review requires the L15 review service (undoLastReviewForSession)');
  }

  let outcome: FsrsAgentReviewMutationOutcome;
  try {
    outcome = reviewStates.undoLastReviewForSession(
      args.cardId, ctx.sessionId, args.expectedReviewVersion, args.expectedLogId,
    );
  } catch (caught) {
    const appError = publishedAppError(caught);
    if (appError !== null) return finishChatAnkiAppFailure(call, ctx, startedAt, appError);
    return finishFailure(call, ctx, startedAt, errorText(caught));
  }
  return finishAgentReviewMutation(
    call, ctx, startedAt, args.cardId, 'undo_last_review', outcome,
  );
}

/** chatanki_executor.rs:3506–3567 `execute_set_suspended`. */
export async function executeChatAnkiSetSuspended(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args: ReturnType<typeof parseChatAnkiSetSuspendedArgs>;
  try { args = parseChatAnkiSetSuspendedArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_set_suspended arguments: ${errorText(caught)}`);
  }
  const repo = ctx.cards ?? null;
  if (repo === null) return finishFailure(call, ctx, startedAt, ANKI_DB_UNAVAILABLE);
  try { verifyAgentReviewCardOwnership(repo, args.cardId, ctx.sessionId, ctx.warn); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const reviewStates = ctx.reviewStates ?? null;
  if (reviewStates === null || reviewStates.setSuspendedForSession === undefined) {
    return finishFailure(call, ctx, startedAt,
      'chatanki_set_suspended requires the L15 review service (setSuspendedForSession)');
  }

  let outcome: FsrsAgentReviewMutationOutcome;
  try {
    outcome = reviewStates.setSuspendedForSession(
      args.cardId, ctx.sessionId, args.expectedReviewVersion, args.suspended,
    );
  } catch (caught) {
    const appError = publishedAppError(caught);
    if (appError !== null) return finishChatAnkiAppFailure(call, ctx, startedAt, appError);
    return finishFailure(call, ctx, startedAt, errorText(caught));
  }
  return finishAgentReviewMutation(
    call, ctx, startedAt, args.cardId, 'set_suspended', outcome,
  );
}

export class ChatAnkiReviewExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    const name = stripToolNamespace(toolName);
    return name === 'chatanki_enqueue_review'
      || name === 'chatanki_undo_last_review'
      || name === 'chatanki_set_suspended';
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  name(): string { return 'ChatAnkiReviewExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    beginChatAnkiToolCall(call, ctx);
    switch (stripToolNamespace(call.name)) {
      case 'chatanki_enqueue_review': return executeChatAnkiEnqueueReview(call, ctx);
      case 'chatanki_undo_last_review': return executeChatAnkiUndoLastReview(call, ctx);
      case 'chatanki_set_suspended': return executeChatAnkiSetSuspended(call, ctx);
      default:
        return finishFailure(call, ctx, performance.now(),
          `Unsupported chatanki review tool: ${call.name}`);
    }
  }
}
