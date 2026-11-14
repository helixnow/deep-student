// Rust chatanki_executor.rs:3656–3810 (update_library_card) and :4059–4205
// (delete_library_card), with the review-state load :12303–12368 and the library
// UI sync :13395–13410. Content CAS writes are the published L16
// `*ForLibrary` methods; the same-row read is L16 `getAnkiAgentLibraryCard`.
import type {
  AnkiCard, ChatAnkiLibraryCardRecord, ChatAnkiLibraryCardStore, ChatAnkiToolExecutor,
  FsrsAgentReviewStateSnapshot, ToolCall, ToolConcurrency, ToolExecutionContext,
  ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import type { AnkiLibraryCardDeleteOutcome, AnkiLibraryCardVersionUpdate } from '../../anki/api.ts';
import { convertBackendCard } from './block-patch.ts';
import { STATUS_NOT_FOUND } from './card-access.ts';
import {
  applyCardPatch, cardContentIsValid, parseChatAnkiDeleteLibraryCardArgs,
  parseChatAnkiUpdateLibraryCardArgs,
} from './executor-args.ts';
import { chatankiSensitivityForCall } from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import { convertLibraryRecordForTool } from './library-output.ts';
import { AGENT_LIBRARY_SCOPE } from './library-review-executor.ts';
import {
  type AnkiCardsMutationTarget, mutationUiSyncNotRequiredReceipt, mutationUiSyncReceipt,
  persistAndEmitCardMutation, preflightLibraryCardMutation,
} from './mutation-target.ts';
import { fsrsCardsChangedPayload } from './review-payloads.ts';
import { beginChatAnkiToolCall, finishChatAnkiFailure, finishChatAnkiSuccess } from './result.ts';
import { now } from '../../../platform/time/index.ts';

const ANKI_DB_UNAVAILABLE = 'blocks.ankiCards.errors.databaseUnavailable';
/** dstu-anki `anki_gold_set::CONTENT_PROVENANCE_FIELD`. */
const CONTENT_PROVENANCE_FIELD = '_content_provenance';

type LibraryCardMethod = keyof ChatAnkiLibraryCardStore;

function libraryCardStore<const M extends LibraryCardMethod>(
  ctx: ToolExecutionContext, tool: string, methods: readonly M[],
): { store: Required<Pick<ChatAnkiLibraryCardStore, M>> } | { error: string } {
  const store = ctx.libraryCardStore ?? null;
  if (store === null) return { error: ANKI_DB_UNAVAILABLE };
  const missing = methods.filter((method) => typeof store[method] !== 'function');
  if (missing.length > 0) {
    return { error: `${tool} requires the L16 library card owner (${missing.join(', ')})` };
  }
  return { store: store as Required<Pick<ChatAnkiLibraryCardStore, M>> };
}

type LibraryReviewStateLoad =
  | { available: true; state: FsrsAgentReviewStateSnapshot | null }
  | { available: false };

/** chatanki_executor.rs:12309–12329 `load_library_review_state`. */
function loadLibraryReviewState(
  ctx: ToolExecutionContext, cardId: string, operation: string,
): LibraryReviewStateLoad {
  const warn = (error: string): LibraryReviewStateLoad => {
    ctx.warn(`[ChatAnkiToolExecutor] Failed to refresh library review state after ${operation} for ${cardId}: ${error}`);
    return { available: false };
  };
  const service = ctx.libraryReviewStates ?? null;
  if (service === null) return warn('L15 review service does not publish getReviewStatesForLibrary');
  try {
    const states = service.getReviewStatesForLibrary(AGENT_LIBRARY_SCOPE, [cardId]);
    return { available: true, state: states.at(-1) ?? null };
  } catch (caught) {
    return warn(errorText(caught));
  }
}

/** chatanki_executor.rs:12331–12349 `convert_library_record_with_review_load`. */
function convertLibraryRecordWithReviewLoad(
  record: ChatAnkiLibraryCardRecord, load: LibraryReviewStateLoad,
): { card: Record<string, unknown>; reviewStateUnavailable: boolean } {
  if (load.available) {
    return { card: convertLibraryRecordForTool(record, load.state), reviewStateUnavailable: false };
  }
  const card = convertLibraryRecordForTool(record, null);
  delete card.reviewState;
  card.reviewStateUnavailable = true;
  return { card, reviewStateUnavailable: true };
}

/** chatanki_executor.rs:12351–12368. */
function libraryVersionConflictPayloadWithReviewLoad(
  current: ChatAnkiLibraryCardRecord, load: LibraryReviewStateLoad, error: string,
): Record<string, unknown> {
  const { card, reviewStateUnavailable } = convertLibraryRecordWithReviewLoad(current, load);
  return {
    status: 'conflict',
    error,
    cardId: current.libraryCard.id,
    current: card,
    mutationApplied: false,
    retryable: true,
    reviewStateUnavailable,
    guidance: 'Call builtin-chatanki_list_library_cards to refresh content and review versions before retrying.',
  };
}

/** chatanki_executor.rs:13395–13410 `persist_library_card_mutation`. */
function persistLibraryCardMutation(
  ctx: ToolExecutionContext, target: AnkiCardsMutationTarget, documentId: string,
  eventPatch: Record<string, unknown>,
): { status: 'ok' | 'partial'; receipt: Record<string, unknown> } {
  if (target.sessionId === '') {
    return { status: 'ok', receipt: mutationUiSyncNotRequiredReceipt(target) };
  }
  return mutationUiSyncReceipt(persistAndEmitCardMutation(
    { chatBlocks: ctx.chatBlocks ?? null, documents: ctx.documents ?? null, cards: ctx.cards ?? null },
    target, documentId, eventPatch,
    (blockId, patch) => { ctx.emitChunk?.(blockId, patch); },
  ));
}

/** chatanki_executor.rs:13705–13726 `emit_fsrs_cards_changed(_with_cards)`. */
function emitFsrsCardsChanged(
  ctx: ToolExecutionContext, action: string, cardId: string, cards: Array<Record<string, unknown>>,
): void {
  if (ctx.emitEvent === undefined || ctx.emitEvent === null) return;
  const payload = fsrsCardsChangedPayload(action, [cardId], ctx.runId ?? '');
  if (cards.length > 0) payload.cards = cards;
  try { ctx.emitEvent('fsrs://changed', payload); }
  catch (caught) {
    ctx.warn(`[ChatAnkiToolExecutor] Failed to emit fsrs://changed after ${action}: ${errorText(caught)}`);
  }
}

/** The `AnkiCard` columns of a flat L16 library card (Rust `library_card.card`). */
function libraryCardContent(card: AnkiCard): AnkiCard {
  return {
    id: card.id, task_id: card.task_id, front: card.front, back: card.back, text: card.text,
    tags: [...card.tags], images: [...card.images], is_error_card: card.is_error_card,
    error_content: card.error_content, created_at: card.created_at, updated_at: card.updated_at,
    extra_fields: { ...card.extra_fields }, template_id: card.template_id,
  };
}

/** dstu-anki `insert_content_provenance(.., ContentProvenance::user(code))`. */
function stampUserContentProvenance(card: AnkiCard, code: string): void {
  card.extra_fields[CONTENT_PROVENANCE_FIELD] = JSON.stringify({ actor: 'user', code, at: now().rfc3339 });
}

/** Rust `Updated(record)` / `Conflict(record)`: the outcome's re-read card at the immutable document. */
function outcomeRecord(
  card: ChatAnkiLibraryCardRecord['libraryCard'], previous: ChatAnkiLibraryCardRecord,
): ChatAnkiLibraryCardRecord {
  return {
    libraryCard: card,
    locator: { documentId: previous.locator.documentId, sourceSessionId: card.sourceSessionId },
  };
}

type LoadedLibraryCard =
  | { record: ChatAnkiLibraryCardRecord; target: AnkiCardsMutationTarget }
  | { error: string };

function loadLibraryCardForMutation(
  ctx: ToolExecutionContext,
  store: Required<Pick<ChatAnkiLibraryCardStore, 'getAnkiAgentLibraryCard'>>,
  cardId: string,
): LoadedLibraryCard {
  let record: ChatAnkiLibraryCardRecord | null;
  try { record = store.getAnkiAgentLibraryCard(cardId); }
  catch (caught) { return { error: `Failed to load library card: ${errorText(caught)}` }; }
  if (record === null) return { error: STATUS_NOT_FOUND };
  try { return { record, target: preflightLibraryCardMutation(ctx.chatBlocks ?? null, record.locator) }; }
  catch (caught) { return { error: errorText(caught) }; }
}

/** chatanki_executor.rs:3656–3810. */
async function executeUpdateLibraryCard(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
): Promise<ToolResultInfo> {
  let args;
  try { args = parseChatAnkiUpdateLibraryCardArgs(call.arguments); }
  catch (caught) {
    return finishChatAnkiFailure(call, ctx, startedAt,
      `Invalid chatanki_update_library_card arguments: ${errorText(caught)}`);
  }
  const resolved = libraryCardStore(ctx, 'chatanki_update_library_card',
    ['getAnkiAgentLibraryCard', 'updateAnkiCardIfVersionForLibrary']);
  if ('error' in resolved) return finishChatAnkiFailure(call, ctx, startedAt, resolved.error);
  const { store } = resolved;
  const loaded = loadLibraryCardForMutation(ctx, store, args.cardId);
  if ('error' in loaded) return finishChatAnkiFailure(call, ctx, startedAt, loaded.error);
  const { record: current, target } = loaded;

  const card = libraryCardContent(current.libraryCard);
  applyCardPatch(card, args.patch);
  if (!cardContentIsValid(card)) {
    return finishChatAnkiFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.cardContentRequired');
  }
  stampUserContentProvenance(card, 'chatanki_update_library_card');

  let outcome: AnkiLibraryCardVersionUpdate;
  try { outcome = store.updateAnkiCardIfVersionForLibrary(card, args.expectedVersion); }
  catch (caught) {
    return finishChatAnkiFailure(call, ctx, startedAt, `Failed to update library card: ${errorText(caught)}`);
  }
  switch (outcome.type) {
    case 'updated': {
      const updated = outcomeRecord(outcome.current, current);
      const documentId = updated.locator.documentId;
      const uiSync = persistLibraryCardMutation(ctx, target, documentId, {
        documentId,
        cardMutation: 'upsert',
        cards: [convertBackendCard(outcome.current)],
      });
      emitFsrsCardsChanged(ctx, 'card_updated', args.cardId, [convertBackendCard(outcome.current)]);
      const review = loadLibraryReviewState(ctx, args.cardId, 'update_library_card');
      const projected = convertLibraryRecordWithReviewLoad(updated, review);
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: projected.reviewStateUnavailable ? 'partial' : uiSync.status,
        documentId,
        card: projected.card,
        mutationApplied: true,
        retryable: false,
        reviewStateUnavailable: projected.reviewStateUnavailable,
        uiSync: uiSync.receipt,
      });
    }
    case 'conflict': {
      const review = loadLibraryReviewState(ctx, args.cardId, 'update_library_card_conflict');
      return finishChatAnkiSuccess(call, ctx, startedAt, libraryVersionConflictPayloadWithReviewLoad(
        outcomeRecord(outcome.current, current), review, 'version_conflict'));
    }
    case 'notFound':
      return finishChatAnkiFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
  }
}

/** chatanki_executor.rs:4059–4205. */
async function executeDeleteLibraryCard(
  call: ToolCall, ctx: ToolExecutionContext, startedAt: number,
): Promise<ToolResultInfo> {
  let args;
  try { args = parseChatAnkiDeleteLibraryCardArgs(call.arguments); }
  catch (caught) {
    return finishChatAnkiFailure(call, ctx, startedAt,
      `Invalid chatanki_delete_library_card arguments: ${errorText(caught)}`);
  }
  const resolved = libraryCardStore(ctx, 'chatanki_delete_library_card',
    ['getAnkiAgentLibraryCard', 'deleteAnkiCardForLibrary']);
  if ('error' in resolved) return finishChatAnkiFailure(call, ctx, startedAt, resolved.error);
  const { store } = resolved;
  const loaded = loadLibraryCardForMutation(ctx, store, args.cardId);
  if ('error' in loaded) return finishChatAnkiFailure(call, ctx, startedAt, loaded.error);
  const { record: current, target } = loaded;

  let outcome: AnkiLibraryCardDeleteOutcome;
  try {
    outcome = store.deleteAnkiCardForLibrary(
      args.cardId, args.expectedVersion, args.expectedReviewVersion.value);
  } catch (caught) {
    return finishChatAnkiFailure(call, ctx, startedAt, `Failed to delete library card: ${errorText(caught)}`);
  }
  switch (outcome.type) {
    case 'deleted': {
      const documentId = outcome.locator.documentId;
      const uiSync = persistLibraryCardMutation(ctx, target, documentId, {
        documentId,
        cardMutation: 'delete',
        deletedCardIds: [args.cardId],
      });
      emitFsrsCardsChanged(ctx, 'card_deleted', args.cardId, []);
      return finishChatAnkiSuccess(call, ctx, startedAt, {
        status: uiSync.status,
        documentId,
        cardId: args.cardId,
        deleted: true,
        mutationApplied: true,
        retryable: false,
        uiSync: uiSync.receipt,
      });
    }
    case 'contentConflict': {
      const review = loadLibraryReviewState(ctx, args.cardId, 'delete_library_card_content_conflict');
      return finishChatAnkiSuccess(call, ctx, startedAt, libraryVersionConflictPayloadWithReviewLoad(
        outcomeRecord(outcome.current, current), review, 'version_conflict'));
    }
    case 'reviewConflict': {
      const review = loadLibraryReviewState(ctx, args.cardId, 'delete_library_card_review_conflict');
      return finishChatAnkiSuccess(call, ctx, startedAt, libraryVersionConflictPayloadWithReviewLoad(
        outcomeRecord(outcome.current, current), review, 'review_state_conflict'));
    }
    case 'notFound':
      return finishChatAnkiFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
  }
}

export class ChatAnkiLibraryMutationExecutor implements ChatAnkiToolExecutor {
  private readonly libraryCardRead: () => boolean;
  /**
   * Both tools are claimed only while `libraryCardRead()` reports the L16 same-row read; otherwise
   * nothing can execute them and RF-W02-executable-only-tool-face keeps them off the model's tool face.
   */
  constructor(libraryCardRead: () => boolean) { this.libraryCardRead = libraryCardRead; }
  canHandle(toolName: string): boolean {
    const name = stripToolNamespace(toolName);
    return (name === 'chatanki_update_library_card' || name === 'chatanki_delete_library_card')
      && this.libraryCardRead();
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  /** Split handler label; registration uses the folded `ChatAnkiToolExecutor` (`executors.ts`). */
  name(): string { return 'ChatAnkiLibraryMutationExecutor'; }

  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const startedAt = performance.now();
    beginChatAnkiToolCall(call, ctx);
    switch (stripToolNamespace(call.name)) {
      case 'chatanki_update_library_card': return executeUpdateLibraryCard(call, ctx, startedAt);
      case 'chatanki_delete_library_card': return executeDeleteLibraryCard(call, ctx, startedAt);
      default:
        return finishChatAnkiFailure(call, ctx, startedAt,
          `Unsupported chatanki library mutation tool: ${call.name}`);
    }
  }
}
