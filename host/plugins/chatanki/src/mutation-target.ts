// Rust: chatanki_executor.rs:13279–13410 (UI synchronization preflight).
import type {
  ChatAnkiCardRepository, ChatAnkiChatBlockStore, ChatAnkiDocumentTaskRepository,
} from '../api.ts';
import { errorText } from './execution.ts';
import { STATUS_NOT_FOUND } from './card-access.ts';
import { projectChatankiWorkflow } from './executor-helpers.ts';
import { rustTrim } from '../../../platform/util/text.ts';
import { compareUtf8 } from '../../../platform/util/utf8.ts';

/** dstu-anki AnkiCardsMutationTarget. */
export interface AnkiCardsMutationTarget {
  blockId: string | null;
  sessionId: string;
  documentId: string;
}

export interface AnkiLibraryCardLocator {
  documentId: string;
  sourceSessionId: string | null;
}

function toolOutputDocumentId(block: { toolOutput: unknown }): string | null {
  const output = block.toolOutput;
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return null;
  const documentId = (output as Record<string, unknown>).documentId;
  return typeof documentId === 'string' ? documentId : null;
}

/** SQL equivalent: latest session-owned `anki_cards` block for the document. */
export function findOwnedAnkiCardsBlockId(
  store: ChatAnkiChatBlockStore, sessionId: string, documentId: string,
): string | null {
  let blocks;
  try { blocks = store.listSessionBlocks(sessionId); }
  catch (caught) { throw new Error(errorText(caught)); }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block === undefined) continue;
    if (block.type !== 'anki_cards') continue;
    if (toolOutputDocumentId(block) === documentId) return block.id;
  }
  return null;
}

/** chatanki_executor.rs:13341–13373. */
export function preflightCardMutation(
  store: ChatAnkiChatBlockStore | null,
  sessionId: string,
  documentId: string,
): AnkiCardsMutationTarget {
  if (store === null) throw new Error('chatanki_ui_preflight_no_database');
  const blockId = findOwnedAnkiCardsBlockId(store, sessionId, documentId);
  if (blockId === null) {
    return { blockId: null, sessionId, documentId };
  }
  let block;
  try { block = store.getBlock(blockId); }
  catch (caught) {
    throw new Error(`chatanki_ui_preflight_load_failed: ${errorText(caught)}`);
  }
  if (block === null) throw new Error('chatanki_ui_preflight_block_not_found');
  if (block.type !== 'anki_cards' || toolOutputDocumentId(block) !== documentId) {
    throw new Error('chatanki_ui_preflight_block_mismatch');
  }
  if (block.sessionId !== sessionId) throw new Error(STATUS_NOT_FOUND);
  return { blockId, sessionId, documentId };
}

/** chatanki_executor.rs:13375–13393. */
export function preflightLibraryCardMutation(
  store: ChatAnkiChatBlockStore | null,
  locator: AnkiLibraryCardLocator,
): AnkiCardsMutationTarget {
  const sourceSessionId = (locator.sourceSessionId == null ? undefined : rustTrim(locator.sourceSessionId)) ?? '';
  if (sourceSessionId.length === 0) {
    return { blockId: null, sessionId: '', documentId: locator.documentId };
  }
  try { return preflightCardMutation(store, sourceSessionId, locator.documentId); }
  catch (caught) {
    throw new Error(`Unable to prepare library card UI synchronization: ${errorText(caught)}`);
  }
}

/** chatanki_executor.rs:13679–13688. */
export function mutationUiSyncNotRequiredReceipt(
  target: AnkiCardsMutationTarget,
): Record<string, unknown> {
  const receipt: Record<string, unknown> = {
    status: 'not_required',
    eventAttempted: false,
  };
  if (target.blockId !== null) receipt.blockId = target.blockId;
  return receipt;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** chatanki_executor.rs:14437–14453: objects merge recursively, everything else replaces. */
export function deepMergeValue(into: unknown, patch: unknown): unknown {
  if (!isPlainObject(into) || !isPlainObject(patch)) return patch;
  const merged: Record<string, unknown> = { ...into };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = Object.hasOwn(merged, key) ? deepMergeValue(merged[key], value) : value;
  }
  return merged;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cardIdOf(card: unknown): string | null {
  if (!isPlainObject(card)) return null;
  return typeof card.id === 'string' ? card.id : null;
}

/**
 * chatanki_executor.rs:13427–13553: applies a card upsert/delete patch to the
 * owning `anki_cards` block snapshot, deep-merges metadata, then persists the
 * block. Validation failures keep the database untouched.
 */
export function persistCardMutation(
  store: ChatAnkiChatBlockStore,
  target: AnkiCardsMutationTarget,
  documentId: string,
  eventPatch: Record<string, unknown>,
): void {
  if (target.documentId !== documentId || eventPatch.documentId !== documentId) {
    throw new Error('chatanki_mutation_document_mismatch');
  }
  const blockId = target.blockId;
  if (blockId === null) throw new Error('chatanki_mutation_block_not_required');
  let block;
  try { block = store.getBlock(blockId); }
  catch (caught) {
    throw new Error(`chatanki_mutation_block_load_failed: ${errorText(caught)}`);
  }
  if (block === null) throw new Error('chatanki_mutation_block_disappeared');
  if (block.type !== 'anki_cards' || toolOutputDocumentId(block) !== documentId) {
    throw new Error('chatanki_mutation_block_mismatch');
  }
  if (block.sessionId !== target.sessionId) {
    throw new Error('chatanki_mutation_block_ownership_mismatch');
  }
  if (block.toolOutput === null || block.toolOutput === undefined) {
    throw new Error('chatanki_mutation_block_output_missing');
  }
  if (!isPlainObject(block.toolOutput)) {
    throw new Error('chatanki_mutation_block_output_invalid');
  }
  let output = block.toolOutput;
  const persistedCards = [...asArray(output.cards)];
  const deletedIds = new Set<string>();
  for (const id of asArray(output.deletedCardIds)) {
    if (typeof id === 'string') deletedIds.add(id);
  }

  const mutationKind = eventPatch.cardMutation;
  if (mutationKind === 'upsert') {
    for (const incoming of asArray(eventPatch.cards)) {
      const incomingId = cardIdOf(incoming);
      if (incomingId !== null) deletedIds.delete(incomingId);
      const index = incomingId === null ? -1
        : persistedCards.findIndex((existing) => cardIdOf(existing) === incomingId);
      if (index >= 0) persistedCards[index] = structuredClone(incoming);
      else persistedCards.push(structuredClone(incoming));
    }
  } else if (mutationKind === 'delete') {
    for (const id of asArray(eventPatch.deletedCardIds)) {
      if (typeof id === 'string') deletedIds.add(id);
    }
    for (let index = persistedCards.length - 1; index >= 0; index -= 1) {
      const cardId = cardIdOf(persistedCards[index]);
      if (cardId !== null && deletedIds.has(cardId)) persistedCards.splice(index, 1);
    }
  } else {
    throw new Error('chatanki_mutation_kind_invalid');
  }

  output = { ...output, cards: persistedCards, deletedCardIds: [...deletedIds].sort(compareUtf8) };
  output.documentId = documentId;
  const metadataPatch: Record<string, unknown> = { ...eventPatch };
  for (const key of ['cardMutation', 'cards', 'deletedCardIds', '_blockStatus', '_blockError']) {
    delete metadataPatch[key];
  }
  output = deepMergeValue(output, metadataPatch) as Record<string, unknown>;

  const updated = { ...block };
  if (typeof eventPatch._blockStatus === 'string') updated.status = eventPatch._blockStatus;
  if (Object.hasOwn(eventPatch, '_blockError')) {
    updated.error = typeof eventPatch._blockError === 'string' ? eventPatch._blockError : null;
  }
  updated.toolOutput = output;
  try { store.updateBlock(updated); }
  catch (caught) {
    throw new Error(`chatanki_mutation_block_persist_failed: ${errorText(caught)}`);
  }
}

export interface MutationUiSyncFailure {
  blockId: string | null;
  eventAttempted: boolean;
  error: string;
}

export type MutationUiSyncResult =
  | { kind: 'ok'; receipt: Record<string, unknown> }
  | { kind: 'failed'; failure: MutationUiSyncFailure };

/**
 * chatanki_executor.rs:13412–13425: preflight first so a UI-sync failure never
 * reaches the card database write.
 */
export function runPreflightedCardMutation<T>(
  store: ChatAnkiChatBlockStore | null,
  sessionId: string,
  documentId: string,
  mutation: () => T,
): { target: AnkiCardsMutationTarget; result: T } {
  let target: AnkiCardsMutationTarget;
  try { target = preflightCardMutation(store, sessionId, documentId); }
  catch (caught) {
    throw new Error(`Unable to prepare card UI synchronization: ${errorText(caught)}`);
  }
  return { target, result: mutation() };
}

export interface CardMutationRepositories {
  chatBlocks: ChatAnkiChatBlockStore | null;
  documents: ChatAnkiDocumentTaskRepository | null;
  cards: ChatAnkiCardRepository | null;
}

/**
 * chatanki_executor.rs:13547–13616: projects the document workflow into the
 * event patch (failed-task recovery), then persists the block and emits once.
 * Repository read failures become `uiSync` failures, never tool failures.
 */
export function persistAndEmitCardMutation(
  repositories: CardMutationRepositories,
  target: AnkiCardsMutationTarget,
  documentId: string,
  eventPatch: Record<string, unknown>,
  emit: (blockId: string, eventPatch: Record<string, unknown>) => void,
): MutationUiSyncResult {
  let patch = eventPatch;
  if (repositories.documents !== null && repositories.cards !== null) {
    let tasks;
    try { tasks = repositories.documents.getTasksForDocument(documentId); }
    catch (caught) {
      return {
        kind: 'failed',
        failure: {
          blockId: target.blockId,
          eventAttempted: false,
          error: `chatanki_mutation_tasks_load_failed: ${errorText(caught)}`,
        },
      };
    }
    let cards;
    try { cards = repositories.cards.getCardsForDocument(documentId); }
    catch (caught) {
      return {
        kind: 'failed',
        failure: {
          blockId: target.blockId,
          eventAttempted: false,
          error: `chatanki_mutation_cards_load_failed: ${errorText(caught)}`,
        },
      };
    }
    const hasFailures = tasks.some(
      (task) => task.status === 'Failed' || task.status === 'Truncated',
    );
    const recoveredDelta = hasFailures && patch.cardMutation === 'upsert'
      ? asArray(patch.cards).length
      : 0;
    const projection = projectChatankiWorkflow(
      tasks, cards, recoveredDelta > 0 ? 'manual' : null, recoveredDelta,
    );
    patch = deepMergeValue(patch, projection.outputPatch) as Record<string, unknown>;
    patch._blockStatus = projection.blockStatus;
    patch._blockError = projection.blockError;
  }
  return persistAndEmitCardMutationWith(
    repositories.chatBlocks, target, documentId, patch, emit,
  );
}

/**
 * chatanki_executor.rs:13555–13676: re-queries a late preview block, persists the
 * card patch and emits exactly once; final persist failures still emit.
 */
export function persistAndEmitCardMutationWith(
  store: ChatAnkiChatBlockStore | null,
  target: AnkiCardsMutationTarget,
  documentId: string,
  eventPatch: Record<string, unknown>,
  emit: (blockId: string, eventPatch: Record<string, unknown>) => void,
): MutationUiSyncResult {
  if (store === null) {
    return {
      kind: 'failed',
      failure: {
        blockId: target.blockId,
        eventAttempted: false,
        error: 'chatanki_mutation_database_disappeared',
      },
    };
  }
  let effective = target;
  if (effective.blockId === null) {
    let lateBlockId: string | null;
    try {
      lateBlockId = findOwnedAnkiCardsBlockId(store, target.sessionId, target.documentId);
    } catch (caught) {
      return {
        kind: 'failed',
        failure: {
          blockId: null,
          eventAttempted: false,
          error: `chatanki_mutation_block_requery_failed: ${errorText(caught)}`,
        },
      };
    }
    if (lateBlockId === null) {
      return { kind: 'ok', receipt: mutationUiSyncNotRequiredReceipt(target) };
    }
    effective = { ...target, blockId: lateBlockId };
  }
  const blockId = effective.blockId;
  if (blockId === null) throw new Error('effective mutation target always has a block id');
  try {
    persistCardMutation(store, effective, documentId, eventPatch);
  } catch (caught) {
    const error = errorText(caught);
    if (error.startsWith('chatanki_mutation_block_persist_failed:')) {
      emit(blockId, eventPatch);
      return {
        kind: 'failed',
        failure: { blockId, eventAttempted: true, error },
      };
    }
    return {
      kind: 'failed',
      failure: { blockId, eventAttempted: false, error },
    };
  }
  emit(blockId, eventPatch);
  return {
    kind: 'ok',
    receipt: { status: 'ok', blockId, eventAttempted: true },
  };
}

/** chatanki_executor.rs:13690–13703. */
export function mutationUiSyncReceipt(
  result: MutationUiSyncResult,
): { status: 'ok' | 'partial'; receipt: Record<string, unknown> } {
  if (result.kind === 'ok') return { status: 'ok', receipt: result.receipt };
  return {
    status: 'partial',
    receipt: {
      status: 'failed',
      blockId: result.failure.blockId,
      eventAttempted: result.failure.eventAttempted,
      error: result.failure.error,
    },
  };
}
