import { expect, it } from 'vitest';
import type { AnkiCard } from '../api.ts';
import { ChatAnkiReviewStateError } from '../api.ts';
import {
  STATUS_NOT_FOUND, loadOwnedChatankiCard, resolveReviewSelection,
  verifyAgentReviewCardOwnership, verifyDocumentOwnership,
} from '../src/card-access.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

function makeCard(id: string, taskId: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: taskId,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

it('test_chatanki_card_ownership_rejects_cross_session', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-owner', 'session-owner');
  const card = makeCard('card-owner', taskId, 'front', 'back');
  expect(repo.insertCard(card)).toBe(true);

  const owned = loadOwnedChatankiCard(repo, 'card-owner', 'session-owner');
  expect(owned.documentId).toBe('doc-owner');
  expect(() => loadOwnedChatankiCard(repo, 'card-owner', 'session-other'))
    .toThrow(STATUS_NOT_FOUND);
  expect(() => verifyDocumentOwnership(repo, 'doc-owner', 'session-other'))
    .toThrow(STATUS_NOT_FOUND);
});

it('test_chatanki_review_selection_pre_resolves_owner_and_document_scope', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-review', 'session-owner');
  const card = makeCard('card-review', taskId, 'front', 'back');
  expect(repo.insertCard(card)).toBe(true);

  const document = resolveReviewSelection(
    repo, 'session-owner', { kind: 'document', documentId: 'doc-review' },
  );
  expect(document.cardIds).toEqual([]);
  expect(document.expectedDocumentId).toBe('doc-review');

  const cards = resolveReviewSelection(
    repo, 'session-owner', { kind: 'cards', cardIds: ['card-review'] },
  );
  expect(cards.cardIds).toEqual(['card-review']);
  expect(cards.expectedDocumentId).toBeNull();

  expect(() => resolveReviewSelection(
    repo, 'session-foreign', { kind: 'cards', cardIds: ['card-review'] },
  )).toThrow(STATUS_NOT_FOUND);

  repo.addTask('doc-review', 'task-review-foreign', 'session-foreign');
  expect(() => resolveReviewSelection(
    repo, 'session-owner', { kind: 'document', documentId: 'doc-review' },
  )).toThrow(STATUS_NOT_FOUND);
  expect(() => resolveReviewSelection(
    repo, 'session-owner', { kind: 'cards', cardIds: ['card-review'] },
  )).toThrow(STATUS_NOT_FOUND);
});

it('test_chatanki_agent_review_state_read_and_ownership_contract', () => {
  const repo = new CardStoreDouble();
  const taskId = repo.seedDocument('doc-agent-review', 'session-owner');
  const enqueued = makeCard('card-agent-enqueued', taskId, 'front', 'back');
  const notEnqueued = makeCard('card-agent-not-enqueued', taskId, 'front 2', 'back 2');
  expect(repo.insertCard(enqueued)).toBe(true);
  expect(repo.insertCard(notEnqueued)).toBe(true);

  const enqueueResult = repo.enqueueCardsForSession(
    [enqueued.id], 'session-owner', null,
  );
  expect(enqueueResult.enqueued).toBe(1);
  const snapshots = repo.getReviewStatesForSession(
    [enqueued.id, notEnqueued.id], 'session-owner',
  );
  expect(snapshots.length).toBe(1);
  expect(snapshots[0]?.ankiCardId).toBe(enqueued.id);
  expect(snapshots[0]?.reviewVersion).toBe(0n);

  let crossSession: unknown = null;
  try { repo.getReviewStatesForSession([enqueued.id], 'session-other'); }
  catch (error) { crossSession = error; }
  expect(crossSession).toBeInstanceOf(ChatAnkiReviewStateError);
  expect((crossSession as ChatAnkiReviewStateError).type).toBe('NotFound');
  expect((crossSession as Error).message).toBe(`anki card not found: ${enqueued.id}`);
  expect(() => verifyAgentReviewCardOwnership(repo, enqueued.id, 'session-other'))
    .toThrow(STATUS_NOT_FOUND);

  repo.addTask('doc-agent-review', 'task-agent-review-mixed', 'session-other');
  let mixedOwner: unknown = null;
  try { repo.getReviewStatesForSession([enqueued.id], 'session-owner'); }
  catch (error) { mixedOwner = error; }
  expect(mixedOwner).toBeInstanceOf(ChatAnkiReviewStateError);
  expect((mixedOwner as ChatAnkiReviewStateError).type).toBe('NotFound');
  expect(() => verifyAgentReviewCardOwnership(repo, enqueued.id, 'session-owner'))
    .toThrow(STATUS_NOT_FOUND);
});
