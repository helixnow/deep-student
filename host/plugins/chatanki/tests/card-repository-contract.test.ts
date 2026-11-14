import { expect, it } from 'vitest';
import type { AnkiCard } from '../api.ts';
import { loadOwnedChatankiCard } from '../src/card-access.ts';
import {
  chatankiDeleteReviewConflictPayload, chatankiVersionConflictPayload,
} from '../src/library-output.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

function makeCard(id: string, taskId: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

it('test_chatanki_get_cards_rejects_wrong_and_mixed_document_ownership', () => {
  const repo = new CardStoreDouble();
  repo.seedDocument('doc-get-owner', 'session-owner');
  expect(repo.getCardsForDocumentForSession('doc-get-owner', 'session-owner')).not.toBeNull();
  expect(repo.getCardsForDocumentForSession('doc-get-owner', 'session-other')).toBeNull();

  repo.addTask('doc-get-owner', 'task-doc-get-owner-mixed', 'session-other');
  expect(repo.getCardsForDocumentForSession('doc-get-owner', 'session-owner')).toBeNull();
  expect(repo.getCardsForDocumentForSession('doc-get-owner', 'session-other')).toBeNull();
});

it('test_chatanki_update_card_rejects_wrong_owner_atomically', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-update-owner', 'session-owner');
  const card = makeCard('card-update-owner', taskId, 'before', 'answer');
  expect(repo.insertCard(card)).toBe(true);
  const expectedVersion = card.updated_at;

  const outcome = repo.updateCardIfVersionForSession(
    { ...card, front: 'unauthorized' }, expectedVersion, 'session-other',
  );
  expect(outcome.kind).toBe('notFound');
  expect(repo.getCardWithDocument('card-update-owner')?.card.front).toBe('before');
});

it('test_chatanki_update_card_rejects_mixed_owner_document_atomically', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-update-mixed', 'session-owner');
  const card = makeCard('card-update-mixed', taskId, 'before', 'answer');
  expect(repo.insertCard(card)).toBe(true);
  repo.addTask('doc-update-mixed', 'task-update-mixed-foreign', 'session-foreign');

  expect(repo.getCardForSession('card-update-mixed', 'session-owner')).not.toBeNull();
  expect(repo.loadOwnedCard('card-update-mixed', 'session-owner')).toBeNull();
  expect(() => loadOwnedChatankiCard(repo, 'card-update-mixed', 'session-owner'))
    .toThrow('blocks.ankiCards.errors.statusNotFound');

  const expectedVersion = card.updated_at;
  const outcome = repo.updateCardIfVersionForSession(
    { ...card, front: 'must not be written' }, expectedVersion, 'session-owner',
  );
  expect(outcome.kind).toBe('notFound');
  const current = repo.getCardWithDocument('card-update-mixed')?.card;
  expect(current?.front).toBe('before');
  expect(current?.updated_at).toBe(expectedVersion);
});

it('test_chatanki_delete_card_rejects_wrong_owner_atomically', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-delete-owner', 'session-owner');
  const card = makeCard('card-delete-owner', taskId, 'front', 'answer');
  expect(repo.insertCard(card)).toBe(true);

  const outcome = repo.deleteCardForSession(
    'card-delete-owner', card.updated_at, null, 'session-other',
  );
  expect(outcome.kind).toBe('notFound');
  expect(repo.getCardWithDocument('card-delete-owner')).not.toBeNull();
});

it('test_chatanki_delete_card_rejects_mixed_owner_document_atomically', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-delete-mixed', 'session-owner');
  const card = makeCard('card-delete-mixed', taskId, 'front', 'answer');
  expect(repo.insertCard(card)).toBe(true);
  repo.addTask('doc-delete-mixed', 'task-delete-mixed-foreign', 'session-foreign');

  const outcome = repo.deleteCardForSession(
    'card-delete-mixed', card.updated_at, null, 'session-owner',
  );
  expect(outcome.kind).toBe('notFound');
  expect(repo.deletedAt('card-delete-mixed')).toBeNull();
});

it('test_chatanki_add_cards_rejects_wrong_and_mixed_document_ownership', () => {
  const repo = new CardStoreDouble();
  repo.seedDocument('doc-add-owner', 'session-owner');
  const unauthorized = makeCard('card-add-unauthorized', '', 'front', 'answer');
  expect(() => repo.insertCardsForDocument('doc-add-owner', 'session-other', [unauthorized]))
    .toThrow();
  expect(repo.getCardsForDocument('doc-add-owner')).toEqual([]);

  repo.addTask('doc-add-owner', 'task-doc-add-owner-mixed', 'session-other');
  const mixed = makeCard('card-add-mixed', '', 'front', 'answer');
  expect(() => repo.insertCardsForDocument('doc-add-owner', 'session-owner', [mixed])).toThrow();
  expect(repo.getCardsForDocument('doc-add-owner')).toEqual([]);
});

it('test_chatanki_update_card_atomic_version_success_and_conflict', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-update', 'session-update');
  const card = makeCard('card-update', taskId, 'before', 'answer');
  expect(repo.insertCard(card)).toBe(true);
  const staleVersion = card.updated_at;

  const updated = repo.updateCardIfVersionForSession(
    { ...card, front: 'after' }, staleVersion, 'session-update',
  );
  if (updated.kind !== 'updated') throw new Error(`unexpected ${updated.kind}`);
  expect(updated.card.front).toBe('after');
  expect(updated.card.updated_at).not.toBe(staleVersion);

  const conflict = repo.updateCardIfVersionForSession(
    { ...card, back: 'stale overwrite' }, staleVersion, 'session-update',
  );
  if (conflict.kind !== 'conflict') throw new Error(`expected conflict, got ${conflict.kind}`);
  expect(conflict.current.front).toBe('after');
  expect(conflict.current.back).toBe('answer');
  expect(conflict.current.updated_at).toBe(updated.card.updated_at);
  const payload = chatankiVersionConflictPayload('doc-update', conflict.current);
  expect(payload.status).toBe('conflict');
  expect(payload.error).toBe('version_conflict');
  expect(payload.documentId).toBe('doc-update');
  expect((payload.current as Record<string, unknown>).front).toBe('after');
  expect(payload.retryable).toBe(true);
});

it('test_chatanki_delete_card_normal_path', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-delete', 'session-delete');
  const card = makeCard('card-delete', taskId, 'front', 'back');
  expect(repo.insertCard(card)).toBe(true);
  expect(repo.loadOwnedCard('card-delete', 'session-delete')).not.toBeNull();

  const outcome = repo.deleteCardForSession('card-delete', card.updated_at, null, 'session-delete');
  expect(outcome.kind).toBe('deleted');
  expect(repo.getCardWithDocument('card-delete')).toBeNull();
  expect(repo.cardRowCount('card-delete')).toBe(0);
});

it('test_chatanki_delete_card_stale_version_returns_conflict_without_deletion', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-delete-stale', 'session-delete');
  const card = makeCard('card-delete-stale', taskId, 'before', 'answer');
  expect(repo.insertCard(card)).toBe(true);
  const staleVersion = card.updated_at;
  const updated = repo.updateCardIfVersionForSession(
    { ...card, front: 'current' }, staleVersion, 'session-delete',
  );
  if (updated.kind !== 'updated') throw new Error(`unexpected ${updated.kind}`);

  const conflict = repo.deleteCardForSession(
    'card-delete-stale', staleVersion, null, 'session-delete',
  );
  if (conflict.kind !== 'conflict') throw new Error(`expected delete conflict, got ${conflict.kind}`);
  expect(conflict.current.front).toBe('current');
  expect(conflict.current.updated_at).toBe(updated.card.updated_at);
  const payload = chatankiVersionConflictPayload('doc-delete-stale', conflict.current);
  expect(payload.status).toBe('conflict');
  expect(payload.error).toBe('version_conflict');
  expect((payload.current as Record<string, unknown>).id).toBe('card-delete-stale');
  expect((payload.current as Record<string, unknown>).version).toBe(updated.card.updated_at);
  expect(payload.retryable).toBe(true);
  expect(repo.getCardWithDocument('card-delete-stale')).not.toBeNull();
});

it('test_chatanki_delete_card_review_cas_blocks_null_and_post_rating_stale_tokens', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-delete-review-cas', 'session-delete-review-cas');
  const card = makeCard('card-delete-review-cas', taskId, 'front', 'answer');
  expect(repo.insertCard(card)).toBe(true);
  const preflight = repo.enqueueReview(card.id, 'session-delete-review-cas');
  expect(preflight?.reviewVersion).toBe(0n);

  const nullConflict = repo.deleteCardForSession(
    card.id, card.updated_at, null, 'session-delete-review-cas',
  );
  if (nullConflict.kind !== 'reviewConflict') {
    throw new Error(`expected enrollment conflict, got ${nullConflict.kind}`);
  }
  expect(nullConflict.current.id).toBe(card.id);
  expect(nullConflict.review?.reviewVersion).toBe(0n);

  repo.rateReview(card.id, 3, 1_724_000_000_080);
  const staleConflict = repo.deleteCardForSession(
    card.id, card.updated_at, preflight?.reviewVersion ?? -1,
    'session-delete-review-cas',
  );
  if (staleConflict.kind !== 'reviewConflict') {
    throw new Error(`expected post-rating conflict, got ${staleConflict.kind}`);
  }
  expect(staleConflict.review?.reviewVersion).toBe(1n);
  const currentReview = repo.getReviewStatesForSession(
    [card.id], 'session-delete-review-cas',
  )[0];
  expect(currentReview?.reviewVersion).toBe(1n);

  const payload = chatankiDeleteReviewConflictPayload(
    'doc-delete-review-cas', staleConflict.current, currentReview ?? null,
  );
  expect(payload.status).toBe('conflict');
  expect(payload.error).toBe('review_state_conflict');
  const current = payload.current as Record<string, unknown>;
  expect(current.id).toBe(card.id);
  expect((current.reviewState as Record<string, unknown>).reviewVersion).toBe(1n);
  expect(payload.mutationApplied).toBe(false);
  expect(payload.retryable).toBe(true);
  expect(repo.getCardWithDocument(card.id)).not.toBeNull();

  const deleted = repo.deleteCardForSession(
    card.id, card.updated_at, currentReview?.reviewVersion ?? -1,
    'session-delete-review-cas',
  );
  expect(deleted.kind).toBe('deleted');
  expect(repo.getCardWithDocument(card.id)).toBeNull();
  expect(repo.reviewRowCount(card.id)).toBe(0);
});
