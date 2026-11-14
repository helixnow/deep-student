import { expect, it } from 'vitest';
import type { AnkiCard } from '../api.ts';
import {
  persistAnkiCardsRunningPatch, persistAnkiCardsTerminalBlock,
} from '../src/block-patch.ts';
import {
  mutationUiSyncReceipt, persistAndEmitCardMutationWith, persistCardMutation,
  preflightCardMutation, runPreflightedCardMutation,
} from '../src/mutation-target.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';

function makeCard(id: string, taskId: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: ['tag'], images: [], task_id: taskId,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: 'design-swiss',
  };
}

it('test_chatanki_persistence_preserves_existing_block_timing_and_order', () => {
  const store = new ChatBlockStoreDouble();
  const seeded = store.seedAnkiCardsBlock(
    'block-block-metadata', 'session-block-metadata', 'doc-block-metadata',
  );
  const blockId = 'block-block-metadata';
  store.updateBlock({
    ...seeded, messageId: 'msg-original', blockIndex: 7, startedAt: 101,
    firstChunkAt: 202, endedAt: null,
  });

  persistAnkiCardsRunningPatch(
    store, 'wrong-fallback-message', blockId, 'chatanki_start',
    { progress: { stage: 'generating' } },
  );
  const running = store.getBlock(blockId);
  expect(running?.messageId).toBe('msg-original');
  expect(running?.startedAt).toBe(101);
  expect(running?.firstChunkAt).toBe(202);
  expect(running?.endedAt).toBeNull();
  expect(running?.blockIndex).toBe(7);

  persistAnkiCardsTerminalBlock(
    store, 'wrong-fallback-message', blockId, 'chatanki_start', 'success',
    { documentId: 'doc-block-metadata', cards: [] }, null,
  );
  const terminal = store.getBlock(blockId);
  expect(terminal?.messageId).toBe('msg-original');
  expect(terminal?.startedAt).toBe(101);
  expect(terminal?.firstChunkAt).toBe(202);
  expect(terminal?.endedAt).not.toBeNull();
  expect(terminal?.blockIndex).toBe(7);
});

it('test_chatanki_mutation_preflight_failure_prevents_database_write', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-preflight', 'session-preflight');
  const card = makeCard('card-preflight', taskId, 'front', 'answer');
  expect(repo.insertCard(card)).toBe(true);
  let mutationInvoked = false;

  expect(() => runPreflightedCardMutation(
    null, 'session-preflight', 'doc-preflight',
    () => {
      mutationInvoked = true;
      repo.deleteCardForSession(
        'card-preflight', card.updated_at, null, 'session-preflight',
      );
    },
  )).toThrow('Unable to prepare card UI synchronization: chatanki_ui_preflight_no_database');

  expect(mutationInvoked).toBe(false);
  expect(repo.getCardWithDocument('card-preflight')).not.toBeNull();
});

it('test_chatanki_mutation_without_current_session_block_executes_without_ui_event', () => {
  const repo = new CardStoreDouble();
  const store = new ChatBlockStoreDouble();
  const taskId = repo.seedDocument('doc-no-preview', 'session-no-preview');
  const card = makeCard('card-no-preview', taskId, 'front', 'answer');
  expect(repo.insertCard(card)).toBe(true);
  let mutationInvoked = false;

  const { target } = runPreflightedCardMutation(
    store, 'session-no-preview', 'doc-no-preview',
    () => {
      mutationInvoked = true;
      return repo.deleteCardForSession(
        'card-no-preview', card.updated_at, null, 'session-no-preview',
      );
    },
  );
  expect(mutationInvoked).toBe(true);
  expect(target.blockId).toBeNull();

  let eventAttempted = false;
  const result = persistAndEmitCardMutationWith(
    store, target, 'doc-no-preview',
    {
      documentId: 'doc-no-preview', cardMutation: 'delete',
      deletedCardIds: ['card-no-preview'],
    },
    () => { eventAttempted = true; },
  );
  expect(result).toEqual({
    kind: 'ok',
    receipt: { status: 'not_required', eventAttempted: false },
  });
  expect(eventAttempted).toBe(false);
});

it('test_chatanki_mutation_requeries_block_created_after_preflight', () => {
  const store = new ChatBlockStoreDouble();
  const target = preflightCardMutation(
    store, 'session-late-preview', 'doc-late-preview',
  );
  expect(target.blockId).toBeNull();

  store.seedAnkiCardsBlock(
    'block-late-preview', 'session-late-preview', 'doc-late-preview',
    {}, [{ id: 'card-existing', front: 'existing' }],
  );
  const emitted: Array<[string, Record<string, unknown>]> = [];
  const result = persistAndEmitCardMutationWith(
    store, target, 'doc-late-preview',
    {
      documentId: 'doc-late-preview', cardMutation: 'upsert',
      cards: [{ id: 'card-late', front: 'created after preflight' }],
    },
    (blockId, eventPatch) => { emitted.push([blockId, eventPatch]); },
  );

  expect(result).toEqual({
    kind: 'ok',
    receipt: {
      status: 'ok', blockId: 'block-late-preview', eventAttempted: true,
    },
  });
  expect(emitted.length).toBe(1);
  expect(emitted[0]?.[0]).toBe('block-late-preview');
  expect(emitted[0]?.[1].documentId).toBe('doc-late-preview');
  const block = store.getBlock('block-late-preview');
  expect((block?.toolOutput as Record<string, unknown>).cards).toEqual([
    { id: 'card-existing', front: 'existing' },
    { id: 'card-late', front: 'created after preflight' },
  ]);
});

it('test_chatanki_mutation_persists_recovered_workflow_and_clears_block_error', () => {
  const store = new ChatBlockStoreDouble();
  store.seedAnkiCardsBlock(
    'block-recovered-preview', 'session-recovered-preview', 'doc-recovered-preview',
  );
  const target = preflightCardMutation(
    store, 'session-recovered-preview', 'doc-recovered-preview',
  );
  const blockId = 'block-recovered-preview';
  store.updateBlock({
    ...(store.getBlock(blockId) as NonNullable<ReturnType<typeof store.getBlock>>),
    status: 'error',
    error: 'blocks.ankiCards.errors.generationFailed',
  });

  const result = persistAndEmitCardMutationWith(
    store, target, 'doc-recovered-preview',
    {
      documentId: 'doc-recovered-preview', cardMutation: 'upsert',
      cards: [{ id: 'card-recovered', front: 'question', back: 'answer' }],
      _blockStatus: 'success', _blockError: null,
      schemaVersion: 2, workflowStatus: 'completed_with_warnings',
      deliveryStatus: 'ready', recoveryStatus: 'manual',
      finalStatus: 'completed_with_errors', finalError: null,
    },
    () => undefined,
  );
  expect(result.kind).toBe('ok');

  const recovered = store.getBlock(blockId);
  expect(recovered?.status).toBe('success');
  expect(recovered?.error).toBeNull();
  const output = recovered?.toolOutput as Record<string, unknown>;
  expect(output.schemaVersion).toBe(2);
  expect(output.workflowStatus).toBe('completed_with_warnings');
  expect(output.deliveryStatus).toBe('ready');
  expect(output.recoveryStatus).toBe('manual');
  expect((output.cards as unknown[]).length).toBe(1);
  expect(output._blockStatus).toBeUndefined();
  expect(output._blockError).toBeUndefined();
});

it('test_chatanki_postwrite_lookup_failures_are_partial_without_emit', () => {
  const target = {
    blockId: null, sessionId: 'session-postwrite-failure',
    documentId: 'doc-postwrite-failure',
  };
  let eventAttempted = false;
  const missingDb = mutationUiSyncReceipt(persistAndEmitCardMutationWith(
    null, target, 'doc-postwrite-failure',
    {
      documentId: 'doc-postwrite-failure', cardMutation: 'delete',
      deletedCardIds: ['card-1'],
    },
    () => { eventAttempted = true; },
  ));
  expect(missingDb.status).toBe('partial');
  expect(missingDb.receipt).toEqual({
    status: 'failed', blockId: null, eventAttempted: false,
    error: 'chatanki_mutation_database_disappeared',
  });
  expect(eventAttempted).toBe(false);

  const store = new ChatBlockStoreDouble();
  store.failNextList('block table is gone');
  const lookupFailure = mutationUiSyncReceipt(persistAndEmitCardMutationWith(
    store, target, 'doc-postwrite-failure',
    {
      documentId: 'doc-postwrite-failure', cardMutation: 'delete',
      deletedCardIds: ['card-1'],
    },
    () => { eventAttempted = true; },
  ));
  expect(lookupFailure.status).toBe('partial');
  expect(lookupFailure.receipt.blockId).toBeNull();
  expect(lookupFailure.receipt.eventAttempted).toBe(false);
  expect(lookupFailure.receipt.error)
    .toBe('chatanki_mutation_block_requery_failed: block table is gone');
  expect(eventAttempted).toBe(false);
});

it('test_chatanki_late_block_validation_failure_does_not_emit', () => {
  const store = new ChatBlockStoreDouble();
  const target = preflightCardMutation(
    store, 'session-late-partial', 'doc-late-partial',
  );
  expect(target.blockId).toBeNull();
  store.seedAnkiCardsBlock(
    'block-late-partial', 'session-late-partial', 'doc-late-partial',
    {}, [{ id: 'card-existing', front: 'unchanged' }],
  );
  const emitted: string[] = [];

  const result = mutationUiSyncReceipt(persistAndEmitCardMutationWith(
    store, target, 'doc-late-partial',
    {
      documentId: 'doc-mismatch', cardMutation: 'delete',
      deletedCardIds: ['card-existing'],
    },
    (blockId) => { emitted.push(blockId); },
  ));
  expect(result.status).toBe('partial');
  expect(result.receipt).toEqual({
    status: 'failed', blockId: 'block-late-partial', eventAttempted: false,
    error: 'chatanki_mutation_document_mismatch',
  });
  expect(emitted).toEqual([]);
  const block = store.getBlock('block-late-partial');
  expect((block?.toolOutput as Record<string, unknown>).cards)
    .toEqual([{ id: 'card-existing', front: 'unchanged' }]);
});

it('test_chatanki_late_block_final_persist_failure_still_emits', () => {
  const store = new ChatBlockStoreDouble();
  const target = preflightCardMutation(
    store, 'session-late-persist-failure', 'doc-late-persist-failure',
  );
  expect(target.blockId).toBeNull();
  store.seedAnkiCardsBlock(
    'block-late-persist-failure', 'session-late-persist-failure',
    'doc-late-persist-failure', {}, [{ id: 'card-existing', front: 'unchanged' }],
  );
  store.failNextUpdate('forced persist failure');
  const emitted: Array<[string, Record<string, unknown>]> = [];

  const result = mutationUiSyncReceipt(persistAndEmitCardMutationWith(
    store, target, 'doc-late-persist-failure',
    {
      documentId: 'doc-late-persist-failure', cardMutation: 'delete',
      deletedCardIds: ['card-existing'],
    },
    (blockId, eventPatch) => { emitted.push([blockId, eventPatch]); },
  ));
  expect(result.status).toBe('partial');
  expect(result.receipt.status).toBe('failed');
  expect(result.receipt.blockId).toBe('block-late-persist-failure');
  expect(result.receipt.eventAttempted).toBe(true);
  expect(result.receipt.error)
    .toBe('chatanki_mutation_block_persist_failed: forced persist failure');
  expect(emitted.length).toBe(1);
  expect(emitted[0]?.[0]).toBe('block-late-persist-failure');
  expect(emitted[0]?.[1].documentId).toBe('doc-late-persist-failure');
  const block = store.getBlock('block-late-persist-failure');
  expect((block?.toolOutput as Record<string, unknown>).cards)
    .toEqual([{ id: 'card-existing', front: 'unchanged' }]);
});

it('test_chatanki_mutation_other_session_block_is_not_a_ui_target', () => {
  const store = new ChatBlockStoreDouble();
  store.seedAnkiCardsBlock(
    'block-block-owner', 'session-block-owner', 'doc-block-owner',
  );
  const target = preflightCardMutation(
    store, 'session-block-other', 'doc-block-owner',
  );
  expect(target.blockId).toBeNull();
  expect(target.sessionId).toBe('session-block-other');
  expect(target.documentId).toBe('doc-block-owner');
});

it('test_chatanki_mutation_existing_block_keeps_strict_document_validation', () => {
  const store = new ChatBlockStoreDouble();
  const target = preflightCardMutation(
    store, 'session-strict-block', 'doc-strict-block',
  );
  store.seedAnkiCardsBlock(
    'block-strict-block', 'session-strict-block', 'doc-strict-block',
    {}, [{ id: 'card-strict', front: 'unchanged' }],
  );
  const strictTarget = preflightCardMutation(
    store, 'session-strict-block', 'doc-strict-block',
  );
  expect(strictTarget.blockId).toBe('block-strict-block');

  expect(() => persistCardMutation(
    store, strictTarget, 'doc-strict-block',
    {
      documentId: 'doc-other', cardMutation: 'delete',
      deletedCardIds: ['card-strict'],
    },
  )).toThrow('chatanki_mutation_document_mismatch');
  const block = store.getBlock('block-strict-block');
  expect((block?.toolOutput as Record<string, unknown>).cards)
    .toEqual([{ id: 'card-strict', front: 'unchanged' }]);
  expect(target.blockId).toBeNull();
});

it('test_chatanki_mutation_persistence_unions_and_clears_delete_tombstones', () => {
  const store = new ChatBlockStoreDouble();
  const target = preflightCardMutation(
    store, 'session-persist', 'doc-persist',
  );
  store.seedAnkiCardsBlock(
    'block-persist', 'session-persist', 'doc-persist', {},
    [
      { id: 'card-1', front: 'one' },
      { id: 'card-2', front: 'two' },
    ],
    ['card-old'],
  );
  const strictTarget = preflightCardMutation(store, 'session-persist', 'doc-persist');
  expect(target.blockId).toBeNull();

  persistCardMutation(store, strictTarget, 'doc-persist', {
    documentId: 'doc-persist', cardMutation: 'delete',
    deletedCardIds: ['card-2', 'card-new'],
  });
  const deletedOutput = store.getBlock('block-persist')
    ?.toolOutput as Record<string, unknown>;
  expect(deletedOutput.cards).toEqual([{ id: 'card-1', front: 'one' }]);
  expect(deletedOutput.deletedCardIds).toEqual(['card-2', 'card-new', 'card-old']);

  persistCardMutation(store, strictTarget, 'doc-persist', {
    documentId: 'doc-persist', cardMutation: 'upsert',
    cards: [
      { id: 'card-2', front: 'two restored' },
      { id: 'card-3', front: 'three' },
    ],
  });
  const upsertedOutput = store.getBlock('block-persist')
    ?.toolOutput as Record<string, unknown>;
  expect(upsertedOutput.cards).toEqual([
    { id: 'card-1', front: 'one' },
    { id: 'card-2', front: 'two restored' },
    { id: 'card-3', front: 'three' },
  ]);
  expect(upsertedOutput.deletedCardIds).toEqual(['card-new', 'card-old']);
});

it('test_chatanki_ui_sync_failure_is_structured_partial_receipt', () => {
  const store = new ChatBlockStoreDouble();
  const target = preflightCardMutation(store, 'session-partial', 'doc-partial');
  store.seedAnkiCardsBlock('block-partial', 'session-partial', 'doc-partial');
  const strictTarget = preflightCardMutation(store, 'session-partial', 'doc-partial');
  expect(strictTarget.blockId).toBe('block-partial');
  store.deleteBlock('block-partial');
  let emitted = false;

  const persistence = mutationUiSyncReceipt(persistAndEmitCardMutationWith(
    store, strictTarget, 'doc-partial',
    {
      documentId: 'doc-partial', cardMutation: 'delete',
      deletedCardIds: ['card-partial'],
    },
    () => { emitted = true; },
  ));
  expect(persistence.status).toBe('partial');
  expect(persistence.receipt).toEqual({
    status: 'failed', blockId: 'block-partial', eventAttempted: false,
    error: 'chatanki_mutation_block_disappeared',
  });
  expect(emitted).toBe(false);
  expect(target.blockId).toBeNull();
});
