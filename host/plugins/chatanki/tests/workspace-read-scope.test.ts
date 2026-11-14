import { expect, it } from 'vitest';
import type { AnkiCard } from '../api.ts';
import { installWorkspaceCardReadScope } from '../../agent-workspace/api.ts';
import {
  STATUS_NOT_FOUND, loadOwnedChatankiCard,
  resolveChatankiReadSession, verifyDocumentOwnership,
} from '../src/card-access.ts';
import { CardStoreDouble } from './chatanki-card-double.ts';

function makeCard(id: string, front: string, back: string): AnkiCard {
  return {
    id, front, back, text: null, tags: [], images: [], task_id: `task-${id}`,
    is_error_card: false, error_content: null, created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T01:00:00Z', extra_fields: {}, template_id: null,
  };
}

it('test_workspace_card_read_scope_allows_same_workspace_coordinator_documents', () => {
  const repo = new CardStoreDouble();
  repo.seedDocument('doc-scope-owner', 'session-scope-coordinator');
  repo.insertCard(makeCard('card-scope-owner', 'front', 'back'), 'doc-scope-owner');

  expect(() => resolveChatankiReadSession(repo, 'doc-scope-owner', 'session-scope-worker'))
    .toThrow(STATUS_NOT_FOUND);

  const guard = installWorkspaceCardReadScope(
    'session-scope-worker', 'ws-scope', 'session-scope-coordinator',
  );
  try {
    expect(resolveChatankiReadSession(repo, 'doc-scope-owner', 'session-scope-worker'))
      .toBe('session-scope-coordinator');
    expect(repo.getCardsForDocumentForSession('doc-scope-owner', 'session-scope-coordinator'))
      .not.toBeNull();
    expect(resolveChatankiReadSession(repo, 'doc-scope-owner', 'session-scope-coordinator'))
      .toBe('session-scope-coordinator');
  } finally { guard.release(); }
});

it('test_workspace_card_read_scope_rejects_cross_workspace_documents', () => {
  const repo = new CardStoreDouble();
  repo.seedDocument('doc-scope-a', 'session-coordinator-a');
  repo.seedDocument('doc-scope-b', 'session-coordinator-b');

  const guardA = installWorkspaceCardReadScope(
    'session-worker-a', 'ws-a', 'session-coordinator-a',
  );
  const guardB = installWorkspaceCardReadScope(
    'session-worker-b', 'ws-b', 'session-coordinator-b',
  );
  try {
    expect(resolveChatankiReadSession(repo, 'doc-scope-a', 'session-worker-a'))
      .toBe('session-coordinator-a');
    expect(resolveChatankiReadSession(repo, 'doc-scope-b', 'session-worker-b'))
      .toBe('session-coordinator-b');
    expect(() => resolveChatankiReadSession(repo, 'doc-scope-b', 'session-worker-a'))
      .toThrow(STATUS_NOT_FOUND);
    expect(() => resolveChatankiReadSession(repo, 'doc-scope-a', 'session-worker-b'))
      .toThrow(STATUS_NOT_FOUND);
  } finally { guardA.release(); guardB.release(); }
});

it('test_workspace_card_read_scope_mixed_owner_document_stays_hidden', () => {
  const repo = new CardStoreDouble();
  repo.seedDocument('doc-scope-mixed', 'session-mixed-coordinator');
  repo.addTask('doc-scope-mixed', 'task-scope-mixed-foreign', 'session-mixed-foreign');

  const guard = installWorkspaceCardReadScope(
    'session-mixed-worker', 'ws-mixed', 'session-mixed-coordinator',
  );
  try {
    expect(() => resolveChatankiReadSession(repo, 'doc-scope-mixed', 'session-mixed-worker'))
      .toThrow(STATUS_NOT_FOUND);
  } finally { guard.release(); }
});

it('test_workspace_card_read_scope_never_relaxes_write_paths', () => {
  const repo = new CardStoreDouble();
  repo.seedDocument('doc-scope-write', 'session-write-coordinator');
  const card = makeCard('card-scope-write', 'before', 'answer');
  repo.insertCard(card, 'doc-scope-write');

  const guard = installWorkspaceCardReadScope(
    'session-write-worker', 'ws-write', 'session-write-coordinator',
  );
  try {
    expect(resolveChatankiReadSession(repo, 'doc-scope-write', 'session-write-worker')).toBe(
      'session-write-coordinator',
    );
    expect(() => verifyDocumentOwnership(repo, 'doc-scope-write', 'session-write-worker'))
      .toThrow(STATUS_NOT_FOUND);
    expect(() => loadOwnedChatankiCard(repo, 'card-scope-write', 'session-write-worker'))
      .toThrow(STATUS_NOT_FOUND);

    const expectedVersion = card.updated_at;
    const outcome = repo.updateCardIfVersionForSession(
      { ...card, front: 'must not be written' }, expectedVersion, 'session-write-worker',
    );
    expect(outcome.kind).toBe('notFound');
    const current = repo.getCardWithDocument('card-scope-write');
    expect(current?.card.front).toBe('before');
  } finally { guard.release(); }
});

it('test_workspace_card_read_scope_install_fail_closed_and_guard_drop', () => {
  const repo = new CardStoreDouble();
  repo.seedDocument('doc-scope-guard', 'session-guard-coordinator');

  expect(() => installWorkspaceCardReadScope('', 'ws-g', 'session-guard-coordinator')).toThrow();
  expect(() => installWorkspaceCardReadScope('session-guard-worker', '', 'coord')).toThrow();
  expect(() => installWorkspaceCardReadScope('session-guard-worker', 'ws-g', '')).toThrow();
  expect(() => installWorkspaceCardReadScope(
    'session-guard-worker', 'ws-g', 'session-guard-worker',
  )).toThrow();

  const guard = installWorkspaceCardReadScope(
    'session-guard-worker', 'ws-g', 'session-guard-coordinator',
  );
  expect(resolveChatankiReadSession(repo, 'doc-scope-guard', 'session-guard-worker')).toBe(
    'session-guard-coordinator',
  );
  guard.release();
  expect(() => resolveChatankiReadSession(repo, 'doc-scope-guard', 'session-guard-worker'))
    .toThrow(STATUS_NOT_FOUND);
});
