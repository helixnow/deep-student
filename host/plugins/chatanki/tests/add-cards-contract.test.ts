import { expect, it } from 'vitest';
import type { AnkiCard } from '../api.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

function makeCard(id: string, taskId: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

it('test_chatanki_added_cards_enqueue_for_owning_session_and_document', () => {
  const repo = new CardStoreDouble();
  repo.seedDocument('doc-add-review', 'session-add-review');
  const inserted = repo.insertCardsForDocument(
    'doc-add-review', 'session-add-review',
    [makeCard('card-add-review', '', 'front', 'back')],
  );
  const ids = inserted.map((card) => card.id);
  const result = repo.enqueueCardsForSession(ids, 'session-add-review', 'doc-add-review');
  expect(result.enqueued).toBe(1);

  const states = repo.getReviewStatesForSession(ids, 'session-add-review');
  expect(states.map((state) => state.ankiCardId)).toEqual(['card-add-review']);
  expect(states[0]?.reviewVersion).toBe(0n);

  // The document selector re-resolves the live set, so a second call is a no-op.
  const repeated = repo.enqueueCardsForSession([], 'session-add-review', 'doc-add-review');
  expect(repeated.enqueued).toBe(0);
  expect(repeated.skipped).toBe(1);
  expect(repeated.enqueuedStateIds).toEqual([]);
});

it('test_chatanki_add_cards_continues_order_and_skips_duplicates', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-add', 'session-add');
  const existing = makeCard('card-existing', taskId, 'existing', 'answer');
  expect(repo.insertCard(existing)).toBe(true);

  const duplicate = makeCard('card-duplicate', '', 'existing', 'answer');
  const added = makeCard('card-added', '', 'new front', 'new back');
  const inserted = repo.insertCardsForDocument('doc-add', 'session-add', [duplicate, added]);
  expect(inserted.length).toBe(1);
  expect(inserted[0]?.id).toBe('card-added');
  expect(inserted[0]?.task_id).toBe(taskId);
  expect(repo.cardOrder('card-added')).toBe(1);
  expect(repo.getCardsForDocument('doc-add').map((card) => card.id))
    .toEqual(['card-existing', 'card-added']);
});
