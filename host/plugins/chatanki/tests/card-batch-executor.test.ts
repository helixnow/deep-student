// chatanki_executor.rs:2738–3334 batch_update_cards / delete_cards / add_cards.
import { expect, it } from 'vitest';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import { ChatAnkiCardBatchExecutor } from '../src/card-batch-executor.ts';
import { createChatAnkiExecutors } from '../src/executors.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';
import { ChatBlockStoreDouble } from './chat-block-double.ts';
import { PreferenceMemoryDouble } from './preference-memory-double.ts';

const SESSION = 'session-batch';

function makeCard(id: string, taskId: string, front: string): AnkiCard {
  return {
    id, front, back: `${front} back`, text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

function setup() {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-a', SESSION);
  const otherTask = repo.seedDocument('doc-b', SESSION);
  for (const id of ['a1', 'a2', 'a3']) expect(repo.insertCard(makeCard(id, taskId, `front ${id}`))).toBe(true);
  expect(repo.insertCard(makeCard('b1', otherTask, 'front b1'))).toBe(true);
  const blocks = new ChatBlockStoreDouble();
  blocks.seedAnkiCardsBlock('block-a', SESSION, 'doc-a');
  const events: { name: string; payload: unknown }[] = [];
  const chunks: { blockId: string; patch: Record<string, unknown> }[] = [];
  const ctx: ToolExecutionContext = {
    sessionId: SESSION, messageId: 'msg-batch', blockId: 'block-tool', runId: 'run-1',
    cards: repo, documents: repo, chatBlocks: blocks, settings: repo, reviewStates: repo,
    preferenceMemory: new PreferenceMemoryDouble(),
    emitEvent: (name, payload) => { events.push({ name, payload }); },
    emitChunk: (blockId, patch) => { chunks.push({ blockId, patch }); },
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
  };
  return { repo, ctx, events, chunks };
}

async function run(name: string, args: unknown, ctx: ToolExecutionContext) {
  return new ChatAnkiCardBatchExecutor().execute({ id: `call-${name}`, name: `builtin-${name}`, arguments: args }, ctx);
}
const out = (result: { output: unknown }) => result.output as Record<string, unknown>;

it('production roster now handles the three batch tools with Rust sensitivity', () => {
  const executors = createChatAnkiExecutors();
  for (const tool of ['chatanki_batch_update_cards', 'chatanki_delete_cards', 'chatanki_add_cards']) {
    const handlers = executors.filter((executor) => executor.canHandle(`builtin-${tool}`));
    expect(handlers.map((executor) => executor.name())).toEqual(['ChatAnkiCardBatchExecutor']);
    expect(handlers[0]!.sensitivityLevel(`builtin-${tool}`)).toBe(tool === 'chatanki_add_cards' ? 'low' : 'medium');
  }
});

it('batch_update_cards applies per-card CAS, reports conflicts/mismatches and syncs the block once', async () => {
  const { repo, ctx, events, chunks } = setup();
  const version = repo.getCardWithDocument('a1')!.card.updated_at;
  const result = await run('chatanki_batch_update_cards', { documentId: ' doc-a ', updates: [
    { cardId: 'a1', expectedVersion: version, patch: { front: 'new a1' } },
    { cardId: 'a2', expectedVersion: 'stale', patch: { front: 'never' } },
    { cardId: 'b1', expectedVersion: version, patch: { front: 'wrong doc' } },
    { cardId: 'missing', expectedVersion: version, patch: { front: 'x' } },
  ] }, ctx);
  expect(result.success).toBe(true);
  expect(out(result)).toMatchObject({ status: 'partial', documentId: 'doc-a', total: 4, updated: 1, conflicts: 1,
    blocked: 0, failed: 2, mutationApplied: true, retryable: true });
  const results = out(result).results as Record<string, unknown>[];
  expect(results.map((entry) => [entry.cardId, entry.status, entry.error])).toEqual([
    ['a1', 'ok', undefined], ['a2', 'conflict', 'version_conflict'],
    ['b1', 'rejected', 'document_mismatch'], ['missing', 'not_found', 'blocks.ankiCards.errors.statusNotFound'],
  ]);
  expect(repo.getCardWithDocument('a1')!.card.front).toBe('new a1');
  expect(repo.getCardWithDocument('a2')!.card.front).toBe('front a2');
  expect(chunks.map((chunk) => [chunk.blockId, chunk.patch.cardMutation])).toEqual([['block-a', 'upsert']]);
  const changed = events.find((event) => event.name === 'fsrs://changed')!.payload as Record<string, unknown>;
  expect(changed).toMatchObject({ action: 'card_updated', entityIds: ['a1'], runId: 'run-1' });
  expect((changed.cards as unknown[]).length).toBe(1);
});

it('batch_update_cards normalize rejects duplicates, empty patches and over-limit batches', async () => {
  const { ctx } = setup();
  const dup = await run('chatanki_batch_update_cards', { documentId: 'doc-a', updates: [
    { cardId: 'a1', expectedVersion: 'v', patch: { front: 'x' } }, { cardId: ' a1 ', expectedVersion: 'v', patch: { front: 'y' } },
  ] }, ctx);
  expect(dup.success).toBe(false);
  expect(dup.error).toContain('Invalid chatanki_batch_update_cards arguments: duplicate cardId in updates: a1');
  const empty = await run('chatanki_batch_update_cards', { documentId: 'doc-a', updates: [
    { cardId: 'a1', expectedVersion: 'v', patch: {} }] }, ctx);
  expect(empty.error).toContain('update for card a1 has an empty patch');
  const many = await run('chatanki_batch_update_cards', { documentId: 'doc-a',
    updates: Array.from({ length: 101 }, (_, i) => ({ cardId: `c${i}`, expectedVersion: 'v', patch: { front: 'x' } })) }, ctx);
  expect(many.error).toContain('updates must contain 1..=100 items');
  const foreign = await run('chatanki_batch_update_cards', { documentId: 'doc-a', updates: [
    { cardId: 'a1', expectedVersion: 'v', patch: { front: 'x' } }] }, { ...ctx, sessionId: 'someone-else' });
  expect(foreign.success).toBe(false);
});

it('delete_cards deletes per-card with double CAS and rejects cross-document selections', async () => {
  const { repo, ctx, events, chunks } = setup();
  const version = repo.getCardWithDocument('a1')!.card.updated_at;
  const cross = await run('chatanki_delete_cards', { cards: [
    { cardId: 'a1', expectedVersion: version, expectedReviewVersion: null },
    { cardId: 'b1', expectedVersion: version, expectedReviewVersion: null },
  ] }, ctx);
  expect(out(cross)).toEqual({ status: 'rejected', error: 'cross_document_selection', documentIds: ['doc-a', 'doc-b'],
    mutationApplied: false, retryable: false });
  expect(repo.getCardWithDocument('a1')).not.toBeNull();

  const result = await run('chatanki_delete_cards', { cards: [
    { cardId: 'a1', expectedVersion: version, expectedReviewVersion: null },
    { cardId: 'a2', expectedVersion: 'stale', expectedReviewVersion: null },
    { cardId: 'ghost', expectedVersion: version, expectedReviewVersion: null },
  ] }, ctx);
  expect(out(result)).toMatchObject({ status: 'partial', documentId: 'doc-a', total: 3, deleted: 1, conflicts: 1,
    failed: 1, deletedCardIds: ['a1'], mutationApplied: true, retryable: true });
  expect((out(result).results as Record<string, unknown>[]).map((entry) => [entry.cardId, entry.status])).toEqual([
    ['ghost', 'not_found'], ['a1', 'ok'], ['a2', 'conflict']]);
  expect(repo.getCardWithDocument('a1')).toBeNull();
  expect(chunks.map((chunk) => chunk.patch.cardMutation)).toEqual(['delete']);
  expect(events.find((event) => event.name === 'fsrs://changed')!.payload).toMatchObject({ action: 'card_deleted', entityIds: ['a1'] });

  const missingReview = await run('chatanki_delete_cards', { cards: [{ cardId: 'a2', expectedVersion: version }] }, ctx);
  expect(missingReview.error).toContain('expectedReviewVersion is required for card a2; use null to assert the card is not enqueued');
  const none = await run('chatanki_delete_cards', { cards: [{ cardId: 'ghost', expectedVersion: 'v', expectedReviewVersion: null }] }, ctx);
  expect(none.success).toBe(false);
});

it('add_cards inserts atomically, validates template ids, enqueues new cards and syncs the block', async () => {
  const { repo, ctx, events, chunks } = setup();
  const bad = await run('chatanki_add_cards', { documentId: 'doc-a', cards: [{ front: 'q', back: 'a', templateId: 'nope' }] },
    { ...ctx, templateLookup: { getCustomTemplateById: () => null } });
  expect(bad.success).toBe(false);
  expect(bad.error).toContain('unknown templateId: nope; no cards were added');
  const empty = await run('chatanki_add_cards', { documentId: 'doc-a', cards: [{ front: 'q', back: 'a' }, { front: ' ', back: '' }] }, ctx);
  expect(empty.success).toBe(false);
  expect(repo.getCardsForDocument('doc-a')).toHaveLength(3);

  const result = await run('chatanki_add_cards', { documentId: 'doc-a', cards: [
    { front: 'q1', back: 'a1', tags: ['t'], extraFields: { ' Hint ': 'h' } }, { front: 'q2', back: 'a2' },
  ] }, ctx);
  expect(result.success).toBe(true);
  // enqueue_cards_for_session(ids, session, Some(document_id)) re-resolves the document's live set,
  // so the three seeded, not-yet-enqueued cards are scheduled together with the two new ones.
  expect(out(result)).toMatchObject({ status: 'ok', documentId: 'doc-a', requested: 2, inserted: 2, skipped: 0,
    enqueuedForReview: 5, mutationApplied: true, retryable: false });
  const cards = out(result).cards as Record<string, unknown>[];
  expect(cards.map((card) => card.front)).toEqual(['q1', 'q2']);
  expect(repo.getCardsForDocument('doc-a')).toHaveLength(5);
  expect(chunks.map((chunk) => chunk.patch.cardMutation)).toEqual(['upsert']);
  expect(events.some((event) => event.name === 'fsrs://changed'
    && (event.payload as Record<string, unknown>).action === 'cards_added')).toBe(true);
  const tooMany = await run('chatanki_add_cards', { documentId: 'doc-a',
    cards: Array.from({ length: 101 }, () => ({ front: 'q', back: 'a' })) }, ctx);
  expect(tooMany.error).toContain('blocks.ankiCards.errors.addArgsRequired');
});
