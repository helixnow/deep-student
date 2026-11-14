import { expect, it } from 'vitest';
import {
  buildFsrsChangedPayloadAfterWrite,
  buildFsrsEnqueueChangedPayload,
} from '../src/fsrs-events.ts';
import type { FsrsEnqueuedCard, FsrsEnqueueResult } from '../src/fsrs-types.ts';

function enqueuedCard(
  id: string,
  ankiCardId: string,
  front: string,
  back: string,
  tags: string[],
): FsrsEnqueuedCard {
  return {
    id, ankiCardId, front, back, tags,
    extraFields: {}, images: [], isErrorCard: false,
  };
}

it('changed_payload_keeps_anki_and_state_ids_distinct', () => {
  const payload = buildFsrsChangedPayloadAfterWrite(
    true, 'user', 'enqueue', [['state-123', 'anki-456']],
  );
  expect(payload).not.toBeNull();
  expect(payload!.entityIds).toEqual(['anki-456']);
  expect(payload!.cardStateIds).toEqual(['state-123']);
  expect(payload!.cards).toEqual([{ id: 'state-123', ankiCardId: 'anki-456' }]);
});

it('changed_payload_falls_back_to_requested_anki_ids_without_states', () => {
  const payload = buildFsrsChangedPayloadAfterWrite(
    true, 'user', 'enqueue', [], ['anki-missing-state'],
  );
  expect(payload).not.toBeNull();
  expect(payload!.entityIds).toEqual(['anki-missing-state']);
  expect(payload!.cardStateIds).toEqual([]);
  expect(payload!.cards).toEqual([]);
});

it('changed_payload_is_suppressed_without_a_write', () => {
  expect(buildFsrsChangedPayloadAfterWrite(
    false, 'user', 'enqueue', [], ['anki-skipped'],
  )).toBeNull();
});

it('changed_payload_carries_log_id_for_rating', () => {
  const payload = buildFsrsChangedPayloadAfterWrite(
    true, 'user', 'rate',
    [['state-rate', 'anki-rate']],
    [],
    ['log-1'],
  );
  expect(payload!.cards).toEqual([
    { id: 'state-rate', ankiCardId: 'anki-rate', logId: 'log-1' },
  ]);
});

it('enqueue_changed_payload_contains_only_new_state_with_card_content', () => {
  const result: FsrsEnqueueResult = {
    enqueued: 1,
    skipped: 1,
    enqueuedStateIds: ['state-new'],
    states: [],
    reviewCards: [],
  };
  const loadedCards = [
    enqueuedCard('state-skipped', 'anki-skipped', 'old front', 'old back', ['old']),
    enqueuedCard('state-new', 'anki-new', 'new front', 'new back', ['new']),
  ];

  const payload = buildFsrsEnqueueChangedPayload(result, loadedCards, 'user');
  expect(payload).not.toBeNull();
  expect(payload!.entityIds).toEqual(['anki-new']);
  expect(payload!.cardStateIds).toEqual(['state-new']);
  expect(payload!.cards).toEqual([{
    id: 'state-new',
    ankiCardId: 'anki-new',
    front: 'new front',
    back: 'new back',
    tags: ['new'],
    extraFields: {},
    images: [],
    isErrorCard: false,
  }]);

  const skippedOnly: FsrsEnqueueResult = {
    enqueued: 0,
    skipped: 1,
    enqueuedStateIds: [],
    states: [],
    reviewCards: loadedCards,
  };
  expect(buildFsrsEnqueueChangedPayload(skippedOnly, loadedCards, 'user')).toBeNull();
});
