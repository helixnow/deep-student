// Rust: chatanki_executor.rs:2738–3334 (batch_update_cards / delete_cards / add_cards).
// Same per-card CAS semantics as update_card/delete_card; successful rows are
// synchronized to the anki_cards block with a single patch.
import type {
  AnkiCard, ChatAnkiToolExecutor, ToolCall, ToolConcurrency, ToolExecutionContext,
  ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import {
  applyCardPatch, cardContentIsValid, convertCardForTool, detectTruncatedSourceFields,
  normalizeAgentExtraFields, parseChatAnkiAddCardsArgs, parseChatAnkiBatchUpdateCardsArgs,
  parseChatAnkiDeleteCardsArgs,
} from './executor-args.ts';
import { chatankiSensitivityForCall, humanizeChatAnkiError } from './executor-helpers.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import { loadOwnedChatankiCard, verifyDocumentOwnership, STATUS_NOT_FOUND } from './card-access.ts';
import { cardEditObservations } from './preference-observations.ts';
import {
  mutationUiSyncNotRequiredReceipt, mutationUiSyncReceipt, persistAndEmitCardMutation,
  preflightCardMutation, runPreflightedCardMutation, type AnkiCardsMutationTarget,
} from './mutation-target.ts';
import {
  emitChunk, emitFsrsCardsChanged, generatedCardCountBestEffort, persistPreferenceDeletion,
  persistPreferenceEdits,
} from './mutation-executor.ts';
import { attachFieldLimitWarnings } from './get-cards-executor.ts';
import { emitEnqueueReviewChanged } from './review-executor.ts';
import { convertBackendCard } from './block-patch.ts';
import { fsrsCardsChangedPayload } from './review-payloads.ts';
import { validateAgentCardTemplateIds } from './template-selection.ts';
import {
  beginChatAnkiToolCall,
  finishChatAnkiFailure as finishFailure, finishChatAnkiSuccess as finishSuccess,
} from './result.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import { compareUtf8 } from '../../../platform/util/utf8.ts';

const ANKI_DB_UNAVAILABLE = 'blocks.ankiCards.errors.databaseUnavailable';
const TOOLS = ['chatanki_batch_update_cards', 'chatanki_delete_cards', 'chatanki_add_cards'];
const UI_SYNC_NOT_REQUIRED = { status: 'not_required', eventAttempted: false };

function mutationRepositories(ctx: ToolExecutionContext) {
  return { chatBlocks: ctx.chatBlocks ?? null, documents: ctx.documents ?? null, cards: ctx.cards ?? null };
}

function preflight(ctx: ToolExecutionContext, documentId: string): AnkiCardsMutationTarget {
  try { return preflightCardMutation(ctx.chatBlocks ?? null, ctx.sessionId, documentId); }
  catch (caught) { throw new Error(`Unable to prepare card UI synchronization: ${errorText(caught)}`); }
}

/** chatanki_executor.rs:13709–13726 `emit_fsrs_cards_changed_with_cards`. */
function emitFsrsCardsChangedWithCards(
  ctx: ToolExecutionContext, action: string, cards: readonly AnkiCard[],
): void {
  if (ctx.emitEvent === undefined || ctx.emitEvent === null) return;
  const payload = fsrsCardsChangedPayload(action, cards.map((card) => card.id), ctx.runId ?? '');
  if (cards.length > 0) payload.cards = cards.map(convertBackendCard);
  try { ctx.emitEvent('fsrs://changed', payload); }
  catch (caught) {
    ctx.warn(`[ChatAnkiToolExecutor] Failed to emit fsrs://changed after ${action}: ${errorText(caught)}`);
  }
}

export async function executeBatchUpdateCards(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args: ReturnType<typeof parseChatAnkiBatchUpdateCardsArgs>;
  try { args = parseChatAnkiBatchUpdateCardsArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_batch_update_cards arguments: ${errorText(caught)}`);
  }
  const repo = ctx.cards ?? null;
  if (repo === null) return finishFailure(call, ctx, startedAt, ANKI_DB_UNAVAILABLE);
  const documentId = args.documentId;
  try { verifyDocumentOwnership(repo, documentId, ctx.sessionId, ctx.warn); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }
  let target: AnkiCardsMutationTarget;
  try { target = preflight(ctx, documentId); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const total = args.updates.length;
  const results: Record<string, unknown>[] = [];
  const updatedCards: AnkiCard[] = [];
  const edits: ReturnType<typeof cardEditObservations> = [];
  let conflictCount = 0, blockedCount = 0, failedCount = 0;
  for (const item of args.updates) {
    const cardId = item.cardId;
    let owned: { card: AnkiCard; documentId: string };
    try { owned = loadOwnedChatankiCard(repo, cardId, ctx.sessionId, ctx.warn); }
    catch (caught) {
      failedCount += 1;
      results.push({ cardId, status: 'not_found', error: errorText(caught) });
      continue;
    }
    if (owned.documentId !== documentId) {
      failedCount += 1;
      results.push({ cardId, status: 'rejected', error: 'document_mismatch', documentId: owned.documentId });
      continue;
    }
    const card = structuredClone(owned.card);
    if (!args.allowTruncatedSource) {
      const suspected = detectTruncatedSourceFields(card, item.patch);
      if (suspected.length > 0) {
        blockedCount += 1;
        results.push({ cardId, status: 'blocked', error: 'truncated_source_overwrite', fields: suspected });
        continue;
      }
    }
    const original = structuredClone(card);
    applyCardPatch(card, item.patch);
    if (!cardContentIsValid(card)) {
      failedCount += 1;
      results.push({ cardId, status: 'invalid', error: 'card_content_required' });
      continue;
    }
    let outcome;
    try { outcome = repo.updateCardIfVersionForSession(card, item.expectedVersion, ctx.sessionId); }
    catch (caught) {
      failedCount += 1;
      results.push({ cardId, status: 'failed', error: `Failed to update card: ${errorText(caught)}` });
      continue;
    }
    if (outcome.kind === 'updated') {
      edits.push(...cardEditObservations(original, outcome.card));
      results.push({ cardId, status: 'ok', card: convertCardForTool(outcome.card, null) });
      updatedCards.push(outcome.card);
    } else if (outcome.kind === 'conflict') {
      conflictCount += 1;
      results.push({ cardId, status: 'conflict', error: 'version_conflict', current: convertCardForTool(outcome.current, null) });
    } else {
      failedCount += 1;
      results.push({ cardId, status: 'not_found', error: 'status_not_found' });
    }
  }

  const updatedCount = updatedCards.length;
  let uiStatus = 'ok';
  let uiSync: Record<string, unknown> = { ...UI_SYNC_NOT_REQUIRED };
  if (updatedCount > 0) {
    const receipt = mutationUiSyncReceipt(persistAndEmitCardMutation(
      mutationRepositories(ctx), target, documentId,
      { documentId, cardMutation: 'upsert', cards: updatedCards.map(convertBackendCard) },
      (blockId, patch) => emitChunk(ctx, blockId, patch),
    ));
    uiStatus = receipt.status;
    uiSync = receipt.receipt;
    emitFsrsCardsChangedWithCards(ctx, 'card_updated', updatedCards);
  }
  const status = updatedCount === total && uiStatus === 'ok' ? 'ok'
    : updatedCount > 0 ? 'partial'
      : conflictCount > 0 ? 'conflict'
        : blockedCount > 0 ? 'blocked' : 'failed';
  persistPreferenceEdits(ctx, edits, 'batch_update_cards');

  const toolCards = updatedCards.map((card) => convertCardForTool(card, null));
  const output: Record<string, unknown> = {
    status, documentId, total, updated: updatedCount, conflicts: conflictCount, blocked: blockedCount,
    failed: failedCount, results, mutationApplied: updatedCount > 0, retryable: conflictCount > 0, uiSync,
  };
  attachFieldLimitWarnings(output, ctx, toolCards);
  return finishSuccess(call, ctx, startedAt, output);
}

export async function executeDeleteCards(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let items: ReturnType<typeof parseChatAnkiDeleteCardsArgs>;
  try { items = parseChatAnkiDeleteCardsArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt, `Invalid chatanki_delete_cards arguments: ${errorText(caught)}`);
  }
  const repo = ctx.cards ?? null;
  if (repo === null) return finishFailure(call, ctx, startedAt, ANKI_DB_UNAVAILABLE);

  const resolved: { item: (typeof items)[number]; card: AnkiCard }[] = [];
  const results: Record<string, unknown>[] = [];
  const documentIds = new Set<string>();
  for (const item of items) {
    try {
      const owned = loadOwnedChatankiCard(repo, item.cardId, ctx.sessionId, ctx.warn);
      documentIds.add(owned.documentId);
      resolved.push({ item, card: owned.card });
    } catch (caught) {
      results.push({ cardId: item.cardId, status: 'not_found', error: errorText(caught) });
    }
  }
  if (documentIds.size > 1) {
    return finishSuccess(call, ctx, startedAt, {
      status: 'rejected', error: 'cross_document_selection', documentIds: [...documentIds].sort(compareUtf8),
      mutationApplied: false, retryable: false,
    });
  }
  const documentId = [...documentIds][0];
  if (documentId === undefined) return finishFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
  const generatedCount = generatedCardCountBestEffort(repo, documentId, ctx.sessionId, ctx.warn);
  let target: AnkiCardsMutationTarget;
  try { target = preflight(ctx, documentId); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const total = resolved.length + results.length;
  const deletedIds: string[] = [];
  const deletedCards: AnkiCard[] = [];
  let conflictCount = 0;
  let failedCount = results.length;
  for (const { item, card } of resolved) {
    const cardId = item.cardId;
    let outcome;
    try {
      outcome = repo.deleteCardForSession(cardId, item.expectedVersion, item.expectedReviewVersion, ctx.sessionId);
    } catch (caught) {
      failedCount += 1;
      results.push({ cardId, status: 'failed', error: `Failed to delete card: ${errorText(caught)}` });
      continue;
    }
    switch (outcome.kind) {
      case 'deleted':
        results.push({ cardId, status: 'ok', deleted: true });
        deletedIds.push(cardId);
        deletedCards.push(card);
        break;
      case 'conflict':
        conflictCount += 1;
        results.push({ cardId, status: 'conflict', error: 'version_conflict', current: convertCardForTool(outcome.current, null) });
        break;
      case 'reviewConflict':
        conflictCount += 1;
        results.push({ cardId, status: 'conflict', error: 'review_state_conflict',
          current: convertCardForTool(outcome.current, null),
          guidance: 'Call builtin-chatanki_get_cards to refresh reviewState before retrying.' });
        break;
      case 'notFound':
        failedCount += 1;
        results.push({ cardId, status: 'not_found', error: 'status_not_found' });
        break;
    }
  }

  const deletedCount = deletedIds.length;
  let uiStatus = 'ok';
  let uiSync: Record<string, unknown> = { ...UI_SYNC_NOT_REQUIRED };
  if (deletedCount > 0) {
    const receipt = mutationUiSyncReceipt(persistAndEmitCardMutation(
      mutationRepositories(ctx), target, documentId,
      { documentId, cardMutation: 'delete', deletedCardIds: [...deletedIds] },
      (blockId, patch) => emitChunk(ctx, blockId, patch),
    ));
    uiStatus = receipt.status;
    uiSync = receipt.receipt;
    emitFsrsCardsChanged(ctx, 'card_deleted', deletedIds);
  }
  const status = deletedCount === total && uiStatus === 'ok' ? 'ok'
    : deletedCount > 0 ? 'partial'
      : conflictCount > 0 ? 'conflict' : 'failed';
  persistPreferenceDeletion(ctx, deletedCards, generatedCount, 'delete_cards');

  return finishSuccess(call, ctx, startedAt, {
    status, documentId, total, deleted: deletedCount, conflicts: conflictCount, failed: failedCount,
    deletedCardIds: deletedIds, results, mutationApplied: deletedCount > 0, retryable: conflictCount > 0, uiSync,
  });
}

export async function executeAddCards(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args: ReturnType<typeof parseChatAnkiAddCardsArgs>;
  try { args = parseChatAnkiAddCardsArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt, `Invalid chatanki_add_cards arguments: ${errorText(caught)}`);
  }
  const documentId = rustTrim(args.documentId);
  if (documentId.length === 0 || args.cards.length === 0 || args.cards.length > 100) {
    return finishFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.addArgsRequired');
  }
  const repo = ctx.cards ?? null;
  if (repo === null) return finishFailure(call, ctx, startedAt, ANKI_DB_UNAVAILABLE);
  try { verifyDocumentOwnership(repo, documentId, ctx.sessionId, ctx.warn); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  const requestedCount = args.cards.length;
  const cards: AnkiCard[] = [];
  for (const input of args.cards) {
    const now = new Date().toISOString();
    const templateId = input.templateId === null ? null : rustTrim(input.templateId);
    const card: AnkiCard = {
      id: globalThis.crypto.randomUUID(), task_id: '', front: input.front, back: input.back, text: input.text,
      tags: input.tags, images: [], is_error_card: false, error_content: null,
      created_at: now, updated_at: now, extra_fields: normalizeAgentExtraFields(input.extraFields),
      template_id: templateId === null || templateId.length === 0 ? null : templateId,
    };
    if (!cardContentIsValid(card)) {
      return finishFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.cardContentRequired');
    }
    cards.push(card);
  }
  const templateDb = ctx.mainDb ?? ctx.ankiDb ?? ctx.templateLookup ?? null;
  if (cards.some((card) => card.template_id != null)) {
    if (templateDb === null) {
      return finishFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.templateDatabaseUnavailable');
    }
    try { validateAgentCardTemplateIds(templateDb, cards); }
    catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }
  }

  let target: AnkiCardsMutationTarget;
  let inserted: AnkiCard[];
  try {
    const preflighted = runPreflightedCardMutation(ctx.chatBlocks ?? null, ctx.sessionId, documentId, () => {
      try { return repo.insertCardsForDocument(documentId, ctx.sessionId, cards); }
      catch (caught) { throw new Error(`Failed to add cards: ${errorText(caught)}`); }
    });
    target = preflighted.target;
    inserted = preflighted.result;
  } catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  let status = 'ok';
  let uiSync: Record<string, unknown>;
  if (inserted.length === 0) uiSync = mutationUiSyncNotRequiredReceipt(target);
  else {
    const receipt = mutationUiSyncReceipt(persistAndEmitCardMutation(
      mutationRepositories(ctx), target, documentId,
      { documentId, cardMutation: 'upsert', cards: inserted.map(convertBackendCard) },
      (blockId, patch) => emitChunk(ctx, blockId, patch),
    ));
    status = receipt.status;
    uiSync = receipt.receipt;
    emitFsrsCardsChanged(ctx, 'cards_added', inserted.map((card) => card.id));
  }

  let enqueued = 0;
  if (inserted.length > 0) {
    const ids = inserted.filter((card) => !card.is_error_card).map((card) => card.id);
    const service = ctx.reviewStates ?? null;
    if (service === null || service.enqueueCardsForSession === undefined) {
      ctx.warn('[ChatAnkiToolExecutor] add_cards 自动加入复习失败: L15 review service (enqueueCardsForSession) is not available');
    } else {
      try {
        const result = service.enqueueCardsForSession(ids, ctx.sessionId, documentId);
        emitEnqueueReviewChanged(ctx, service, result);
        enqueued = result.enqueued;
      } catch (caught) {
        ctx.warn(`[ChatAnkiToolExecutor] add_cards 自动加入复习失败: ${errorText(caught)}`);
      }
    }
  }

  const outputCards = inserted.map((card) => convertCardForTool(card, null));
  const output: Record<string, unknown> = {
    status, documentId, requested: requestedCount, inserted: inserted.length,
    skipped: Math.max(requestedCount - inserted.length, 0), enqueuedForReview: enqueued,
    cards: [...outputCards], mutationApplied: inserted.length > 0, retryable: false, uiSync,
  };
  attachFieldLimitWarnings(output, ctx, outputCards);
  return finishSuccess(call, ctx, startedAt, output);
}

export class ChatAnkiCardBatchExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean { return TOOLS.includes(stripToolNamespace(toolName)); }
  sensitivityLevel(toolName: string): ToolSensitivity { return chatankiSensitivityForCall(toolName, {}); }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  name(): string { return 'ChatAnkiCardBatchExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    beginChatAnkiToolCall(call, ctx);
    switch (stripToolNamespace(call.name)) {
      case 'chatanki_batch_update_cards': return executeBatchUpdateCards(call, ctx);
      case 'chatanki_delete_cards': return executeDeleteCards(call, ctx);
      case 'chatanki_add_cards': return executeAddCards(call, ctx);
      default:
        return finishFailure(call, ctx, performance.now(),
          humanizeChatAnkiError(`Unsupported chatanki batch tool: ${call.name}`));
    }
  }
}
