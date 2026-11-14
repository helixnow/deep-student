// Rust: chatanki_executor.rs:2448–2737 (update_card / delete_card).
// These two tools own the preference-learning side effects and the optimistic
// CAS write path; batch/retemplate live in their own executors.
import type {
  AnkiCard, ChatAnkiCardRepository, ChatAnkiPreferenceMemory, ChatAnkiSettingsStore,
  ChatAnkiToolExecutor, ToolCall, ToolConcurrency, ToolExecutionContext,
  ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import {
  applyCardPatch, cardContentIsValid, convertCardForTool, detectTruncatedSourceFields,
  parseChatAnkiDeleteCardArgs, parseChatAnkiUpdateCardArgs, patchIsEmpty,
} from './executor-args.ts';
import {
  chatankiSensitivityForCall, humanizeChatAnkiError,
} from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import { loadOwnedChatankiCard, STATUS_NOT_FOUND } from './card-access.ts';
import {
  cardEditObservations, deletionPreferenceObservation,
} from './preference-observations.ts';
import { persistPreferenceObservationBestEffort } from './preference-memory.ts';
import {
  mutationUiSyncReceipt, persistAndEmitCardMutation, runPreflightedCardMutation,
} from './mutation-target.ts';
import { fsrsCardsChangedPayload } from './review-payloads.ts';
import {
  beginChatAnkiToolCall,
  finishChatAnkiFailure as finishFailure, finishChatAnkiSuccess as finishSuccess,
} from './result.ts';
import { rustTrim } from '../../../platform/util/text.ts';

const ANKI_DB_UNAVAILABLE = 'blocks.ankiCards.errors.databaseUnavailable';

function cardRepository(ctx: ToolExecutionContext): ChatAnkiCardRepository | null {
  return ctx.cards ?? null;
}

function settingsStore(ctx: ToolExecutionContext): ChatAnkiSettingsStore | null {
  if (ctx.settings === undefined || ctx.settings === null) return null;
  const settings = ctx.settings;
  // F4 `SettingsService` exposes get/save; the chatanki boundary uses the Rust
  // `get_setting`/`save_setting` names.
  const candidate = settings as unknown as {
    getSetting?: (key: string) => string | null;
    get?: (key: string) => string | null;
    saveSetting?: (key: string, value: string) => void;
    save?: (key: string, value: string) => void;
  };
  return {
    getSetting: (key) => {
      if (candidate.getSetting !== undefined) return candidate.getSetting(key);
      if (candidate.get !== undefined) return candidate.get(key);
      throw new Error('settings store does not expose get/getSetting');
    },
    saveSetting: (key, value) => {
      if (candidate.saveSetting !== undefined) candidate.saveSetting(key, value);
      else if (candidate.save !== undefined) candidate.save(key, value);
      else throw new Error('settings store does not expose save/saveSetting');
    },
  };
}

function preferenceMemory(ctx: ToolExecutionContext): ChatAnkiPreferenceMemory | null {
  return ctx.preferenceMemory ?? null;
}

export function emitChunk(
  ctx: ToolExecutionContext, blockId: string, patch: Record<string, unknown>,
): void {
  ctx.emitChunk?.(blockId, patch);
}

export function emitFsrsCardsChanged(
  ctx: ToolExecutionContext, action: string, cardIds: readonly string[],
): void {
  if (ctx.emitEvent === undefined || ctx.emitEvent === null) return;
  ctx.emitEvent(
    'fsrs://changed',
    fsrsCardsChangedPayload(action, cardIds, ctx.runId ?? ''),
  );
}

/**
 * chatanki_executor.rs:11162–11180: deletion denominator is best-effort; both
 * "ownership changed" and repository failures log a warning and use 0.
 */
export function generatedCardCountBestEffort(
  repo: ChatAnkiCardRepository,
  documentId: string,
  sessionId: string,
  warn: (message: string) => void,
): number {
  try {
    const cards = repo.getCardsForDocumentForSession(documentId, sessionId);
    if (cards === null) {
      warn('[ChatAnkiToolExecutor] preference deletion denominator unavailable: document ownership changed');
      return 0;
    }
    return cards.filter((card) => !card.is_error_card).length;
  } catch (caught) {
    warn(`[ChatAnkiToolExecutor] preference deletion denominator unavailable: ${errorText(caught)}`);
    return 0;
  }
}

export function persistPreferenceEdits(
  ctx: ToolExecutionContext,
  edits: ReturnType<typeof cardEditObservations>,
  source: string,
): void {
  if (edits.length === 0) return;
  const db = settingsStore(ctx);
  const memory = preferenceMemory(ctx);
  if (db === null || memory === null) {
    ctx.warn('[ChatAnkiToolExecutor] preference observation skipped:'
      + ' F4 settings or L16 anki_preference_memory service is not available');
    return;
  }
  persistPreferenceObservationBestEffort(
    db, memory,
    {
      extraRequirements: null, edits, deletions: [], generatedCount: 0, templateUsed: null,
    },
    source, Date.now(), ctx.warn,
  );
}

export function persistPreferenceDeletion(
  ctx: ToolExecutionContext,
  deletedCards: readonly AnkiCard[],
  generatedCount: number,
  source: string,
): void {
  const observation = deletionPreferenceObservation(deletedCards, generatedCount);
  if (observation.deletions.length === 0) return;
  const db = settingsStore(ctx);
  const memory = preferenceMemory(ctx);
  if (db === null || memory === null) {
    ctx.warn('[ChatAnkiToolExecutor] preference observation skipped:'
      + ' F4 settings or L16 anki_preference_memory service is not available');
    return;
  }
  persistPreferenceObservationBestEffort(
    db, memory,
    {
      extraRequirements: null, edits: [], deletions: observation.deletions,
      generatedCount: observation.generatedCount, templateUsed: null,
    },
    source, Date.now(), ctx.warn,
  );
}

function truncatedSourcePayload(
  documentId: string, cardId: string, fields: readonly string[],
): Record<string, unknown> {
  return {
    status: 'blocked',
    error: 'truncated_source_overwrite',
    documentId,
    cardId,
    fields: [...fields],
    mutationApplied: false,
    retryable: false,
    guidance: 'Target field exceeds the get_cards truncation limit and the new value looks like it was built from truncated output; overwriting would destroy the hidden tail. Re-read the complete field content before editing, or pass allowTruncatedSource=true to overwrite explicitly.',
  };
}

function versionConflictPayload(
  documentId: string, current: AnkiCard,
): Record<string, unknown> {
  return {
    status: 'conflict',
    error: 'version_conflict',
    documentId,
    current: convertCardForTool(current, null),
    retryable: true,
  };
}

export async function executeUpdateCard(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args: ReturnType<typeof parseChatAnkiUpdateCardArgs>;
  try {
    args = parseChatAnkiUpdateCardArgs(call.arguments);
  } catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_update_card arguments: ${errorText(caught)}`);
  }
  const cardId = rustTrim(args.cardId);
  if (cardId.length === 0 || rustTrim(args.expectedVersion).length === 0 || patchIsEmpty(args.patch)) {
    return finishFailure(call, ctx, startedAt,
      'blocks.ankiCards.errors.updateArgsRequired');
  }
  const repo = cardRepository(ctx);
  if (repo === null) return finishFailure(call, ctx, startedAt, ANKI_DB_UNAVAILABLE);

  let owned: { card: AnkiCard; documentId: string };
  try { owned = loadOwnedChatankiCard(repo, cardId, ctx.sessionId); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const card = structuredClone(owned.card);
  const original = structuredClone(card);
  if (!args.allowTruncatedSource) {
    const suspected = detectTruncatedSourceFields(card, args.patch);
    if (suspected.length > 0) {
      return finishSuccess(call, ctx, startedAt,
        truncatedSourcePayload(owned.documentId, cardId, suspected));
    }
  }
  applyCardPatch(card, args.patch);
  if (!cardContentIsValid(card)) {
    return finishFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.cardContentRequired');
  }

  let target;
  let updateResult;
  try {
    const preflighted = runPreflightedCardMutation(
      ctx.chatBlocks ?? null, ctx.sessionId, owned.documentId,
      () => {
        try {
          return repo.updateCardIfVersionForSession(
            card, rustTrim(args.expectedVersion), ctx.sessionId,
          );
        } catch (caught) {
          throw new Error(`Failed to update card: ${errorText(caught)}`);
        }
      },
    );
    target = preflighted.target;
    updateResult = preflighted.result;
  } catch (caught) {
    return finishFailure(call, ctx, startedAt, errorText(caught));
  }

  if (updateResult.kind === 'notFound') {
    return finishFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
  }
  if (updateResult.kind === 'conflict') {
    return finishSuccess(call, ctx, startedAt,
      versionConflictPayload(owned.documentId, updateResult.current));
  }

  const updated = updateResult.card;
  const uiSync = mutationUiSyncReceipt(persistAndEmitCardMutation(
    { chatBlocks: ctx.chatBlocks ?? null, documents: ctx.documents ?? null, cards: repo },
    target,
    owned.documentId,
    {
      documentId: owned.documentId,
      cardMutation: 'upsert',
      cards: [{ ...updated, tags: [...updated.tags], images: [...updated.images], extra_fields: { ...updated.extra_fields } }],
    },
    (blockId, patch) => emitChunk(ctx, blockId, patch),
  ));
  emitFsrsCardsChanged(ctx, 'card_updated', [updated.id]);

  persistPreferenceEdits(ctx, cardEditObservations(original, updated), 'update_card');

  const toolCard = convertCardForTool(updated, null);
  return finishSuccess(call, ctx, startedAt, {
    status: uiSync.status,
    documentId: owned.documentId,
    card: toolCard,
    mutationApplied: true,
    retryable: false,
    uiSync: uiSync.receipt,
  });
}

export async function executeDeleteCard(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args: ReturnType<typeof parseChatAnkiDeleteCardArgs>;
  try {
    args = parseChatAnkiDeleteCardArgs(call.arguments);
  } catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_delete_card arguments: ${errorText(caught)}`);
  }
  const repo = cardRepository(ctx);
  if (repo === null) return finishFailure(call, ctx, startedAt, ANKI_DB_UNAVAILABLE);

  let owned: { card: AnkiCard; documentId: string };
  try { owned = loadOwnedChatankiCard(repo, args.cardId, ctx.sessionId); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const generatedCount = generatedCardCountBestEffort(
    repo, owned.documentId, ctx.sessionId, ctx.warn,
  );
  let target;
  let deleteResult;
  try {
    const preflighted = runPreflightedCardMutation(
      ctx.chatBlocks ?? null, ctx.sessionId, owned.documentId,
      () => {
        try {
          return repo.deleteCardForSession(
            args.cardId, args.expectedVersion, args.expectedReviewVersion, ctx.sessionId,
          );
        } catch (caught) {
          throw new Error(`Failed to delete card: ${errorText(caught)}`);
        }
      },
    );
    target = preflighted.target;
    deleteResult = preflighted.result;
  } catch (caught) {
    return finishFailure(call, ctx, startedAt, errorText(caught));
  }

  if (deleteResult.kind === 'notFound') {
    return finishFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
  }
  if (deleteResult.kind === 'conflict') {
    return finishSuccess(call, ctx, startedAt,
      versionConflictPayload(owned.documentId, deleteResult.current));
  }
  if (deleteResult.kind === 'reviewConflict') {
    let reviewState = null;
    if (ctx.reviewStates !== undefined && ctx.reviewStates !== null) {
      try {
        const states = ctx.reviewStates.getReviewStatesForSession(
          [args.cardId], ctx.sessionId,
        );
        reviewState = states[0] ?? null;
      } catch (caught) {
        return finishFailure(call, ctx, startedAt,
          `Failed to refresh card review state after delete conflict: ${errorText(caught)}`);
      }
    }
    return finishSuccess(call, ctx, startedAt, {
      status: 'conflict',
      error: 'review_state_conflict',
      documentId: owned.documentId,
      current: { ...convertCardForTool(deleteResult.current, null), reviewState },
      mutationApplied: false,
      retryable: true,
      guidance: 'Call builtin-chatanki_get_cards to refresh reviewState before retrying.',
    });
  }

  const uiSync = mutationUiSyncReceipt(persistAndEmitCardMutation(
    { chatBlocks: ctx.chatBlocks ?? null, documents: ctx.documents ?? null, cards: repo },
    target,
    owned.documentId,
    {
      documentId: owned.documentId,
      cardMutation: 'delete',
      deletedCardIds: [args.cardId],
    },
    (blockId, patch) => emitChunk(ctx, blockId, patch),
  ));
  emitFsrsCardsChanged(ctx, 'card_deleted', [args.cardId]);

  persistPreferenceDeletion(ctx, [owned.card], generatedCount, 'delete_card');

  return finishSuccess(call, ctx, startedAt, {
    status: uiSync.status,
    documentId: owned.documentId,
    cardId: args.cardId,
    deleted: true,
    mutationApplied: true,
    retryable: false,
    uiSync: uiSync.receipt,
  });
}

export class ChatAnkiMutationExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    const name = stripToolNamespace(toolName);
    return name === 'chatanki_update_card' || name === 'chatanki_delete_card';
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  name(): string { return 'ChatAnkiMutationExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    beginChatAnkiToolCall(call, ctx);
    switch (stripToolNamespace(call.name)) {
      case 'chatanki_update_card': return executeUpdateCard(call, ctx);
      case 'chatanki_delete_card': return executeDeleteCard(call, ctx);
      default:
        return finishFailure(call, ctx, performance.now(),
          humanizeChatAnkiError(`Unsupported chatanki mutation tool: ${call.name}`));
    }
  }
}
