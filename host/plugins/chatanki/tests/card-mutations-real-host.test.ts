// C2/C7: original Rust repository assertions plus production tool calls over
// published L16/L15/L04 providers. The old CardStoreDouble tests remain intact.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import { loadOwnedChatankiCard } from '../src/card-access.ts';
import { chatankiDeleteReviewConflictPayload, chatankiVersionConflictPayload } from '../src/library-output.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
const events: unknown[] = [];
const warnings: string[] = [];
const OWNER = 'session-mutation-owner';
const OTHER = 'session-mutation-other';
const TIMESTAMP = '2026-08-24T00:00:00Z';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-card-mutations-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      vfs: {}, llm: {}, // neither service performs an operation in these paths
    },
  });
  host.ctx.backendEvents.listen('fsrs://changed', (payload) => events.push(payload));
}, 60_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

function addTask(documentId: string, taskId: string, sessionId: string, segmentIndex: number): void {
  host.ctx.anki.documents.insertDocumentTask({
    id: taskId, document_id: documentId, original_document_name: 'test.md',
    segment_index: segmentIndex, content_segment: 'material', status: 'Completed',
    created_at: TIMESTAMP, updated_at: TIMESTAMP, error_message: null, anki_generation_options_json: '{}',
  });
  // Like Rust's seed_additional_chatanki_task: this only fills NULL owners,
  // so an appended task can have another owner without changing the first.
  host.ctx.anki.documents.setDocumentSessionSource(documentId, sessionId);
}

function seed(label: string): { card: AnkiCard; documentId: string } {
  const documentId = `doc-${label}`;
  const taskId = `task-${label}`;
  addTask(documentId, taskId, OWNER, 0);
  const card: AnkiCard = {
    id: `card-${label}`, task_id: taskId, front: 'before', back: 'answer',
    text: null, tags: ['tag'], images: [], is_error_card: false, error_content: null,
    created_at: TIMESTAMP, updated_at: TIMESTAMP, extra_fields: {}, template_id: null,
  };
  expect(host.ctx.anki.cards.insertCard(card)).toBe(true);
  return { card, documentId };
}

function execute(name: string, args: Record<string, unknown>, sessionId = OWNER) {
  const context: ToolExecutionContext = {
    sessionId, messageId: 'message-real-mutations', blockId: 'block-real-mutations',
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined, saveToolBlock: () => undefined,
    warn: (message) => warnings.push(message),
  };
  return host.ctx.chatankiTools.execute({ id: `call-${name}`, name, arguments: args }, context);
}

async function deniedTool(card: AnkiCard, sessionId: string, name: string): Promise<void> {
  const initial = host.ctx.anki.cards.getCardWithDocument(card.id);
  const eventsBefore = events.length;
  const args = name === 'chatanki_update_card'
    ? { cardId: card.id, expectedVersion: card.updated_at, patch: { front: 'must not be written' } }
    : { cardId: card.id, expectedVersion: card.updated_at, expectedReviewVersion: null };
  const result = await execute(name, args, sessionId);
  expect(result.success).toBe(false);
  expect(result.error).toContain('blocks.ankiCards.errors.statusNotFound');
  expect(host.ctx.anki.cards.getCardWithDocument(card.id)).toEqual(initial);
  expect(events).toHaveLength(eventsBefore);
}

it('test_chatanki_update_card_rejects_wrong_owner_atomically with real providers', async () => {
  // Rust chatanki_executor.rs:16457-16474: insert / NotFound / unchanged front.
  const { card } = seed('update-wrong-owner');
  const repo = host.ctx.anki.cards;
  const outcome = repo.updateCardIfVersionForSession({ ...card, front: 'unauthorized' }, card.updated_at, OTHER);
  expect(outcome.kind).toBe('notFound');
  expect(repo.getCardWithDocument(card.id)?.card.front).toBe('before');
  await deniedTool(card, OTHER, 'chatanki_update_card');
});

it('test_chatanki_update_card_rejects_mixed_owner_document_atomically with real providers', async () => {
  // Rust :16478-16516, including complete-document vs concrete-task ownership.
  const { card, documentId } = seed('update-mixed-owner');
  addTask(documentId, 'task-update-mixed-foreign', OTHER, 1);
  const repo = host.ctx.anki.cards;
  expect(repo.getCardForSession(card.id, OWNER)).not.toBeNull();
  expect(repo.loadOwnedCard(card.id, OWNER)).toBeNull();
  expect(() => loadOwnedChatankiCard(repo, card.id, OWNER))
    .toThrow(new Error('blocks.ankiCards.errors.statusNotFound'));
  const outcome = repo.updateCardIfVersionForSession({ ...card, front: 'must not be written' }, card.updated_at, OWNER);
  expect(outcome.kind).toBe('notFound');
  const current = repo.getCardWithDocument(card.id)!.card;
  expect(current.front).toBe('before');
  expect(current.updated_at).toBe(card.updated_at);
  await deniedTool(card, OWNER, 'chatanki_update_card');
});

it('test_chatanki_delete_card_rejects_wrong_owner_atomically with real providers', async () => {
  // Rust :16520-16538.
  const { card } = seed('delete-wrong-owner');
  const repo = host.ctx.anki.cards;
  expect(repo.deleteCardForSession(card.id, card.updated_at, null, OTHER).kind).toBe('notFound');
  expect(repo.getCardWithDocument(card.id)).not.toBeNull();
  await deniedTool(card, OTHER, 'chatanki_delete_card');
});

it('test_chatanki_delete_card_rejects_mixed_owner_document_atomically with real providers', async () => {
  // Rust :16542-16572: physical row survives with no tombstone.
  const { card, documentId } = seed('delete-mixed-owner');
  addTask(documentId, 'task-delete-mixed-foreign', OTHER, 1);
  const repo = host.ctx.anki.cards;
  expect(repo.deleteCardForSession(card.id, card.updated_at, null, OWNER).kind).toBe('notFound');
  expect(storage.database('mistakes').one<{ deleted_at: string | null }>(
    'SELECT deleted_at FROM anki_cards WHERE id = ?1', [card.id],
  )).toEqual({ deleted_at: null });
  await deniedTool(card, OWNER, 'chatanki_delete_card');
});

it('test_chatanki_update_card_atomic_version_success_and_conflict with real providers', async () => {
  // Rust :16606-16638: all original values/directions, then the hydrated tool.
  const { card, documentId } = seed('update-version');
  const repo = host.ctx.anki.cards;
  const updated = repo.updateCardIfVersionForSession({ ...card, front: 'after' }, card.updated_at, OWNER);
  if (updated.kind !== 'updated') throw new Error(`unexpected ${updated.kind}`);
  expect(updated.card.front).toBe('after');
  expect(updated.card.updated_at).not.toBe(card.updated_at);
  const conflict = repo.updateCardIfVersionForSession({ ...card, front: 'after', back: 'stale overwrite' }, card.updated_at, OWNER);
  if (conflict.kind !== 'conflict') throw new Error(`expected conflict, got ${conflict.kind}`);
  expect(conflict.current.front).toBe('after');
  expect(conflict.current.back).toBe('answer');
  expect(conflict.current.updated_at).toBe(updated.card.updated_at);
  const payload = chatankiVersionConflictPayload(documentId, conflict.current);
  expect(payload.status).toBe('conflict');
  expect(payload.error).toBe('version_conflict');
  expect(payload.documentId).toBe(documentId);
  expect((payload.current as Record<string, unknown>).front).toBe('after');
  expect(payload.retryable).toBe(true);

  const before = events.length;
  const stale = await execute('chatanki_update_card', {
    cardId: card.id, expectedVersion: card.updated_at, patch: { back: 'stale overwrite' },
  });
  expect(stale.success, stale.error).toBe(true);
  expect(stale.output).toEqual(payload);
  expect(repo.getCardWithDocument(card.id)?.card).toEqual(updated.card);
  expect(events).toHaveLength(before);
  const fresh = await execute('chatanki_update_card', {
    cardId: card.id, expectedVersion: updated.card.updated_at, patch: { front: 'from production tool' },
  });
  expect(fresh.success, fresh.error).toBe(true);
  expect(fresh.output).toMatchObject({ status: 'ok', mutationApplied: true, retryable: false });
  expect(repo.getCardWithDocument(card.id)?.card.front).toBe('from production tool');
  expect(events).toHaveLength(before + 1);
  expect(warnings).toEqual([]);
});

it('test_chatanki_delete_card_normal_path with real providers and tool', async () => {
  // Rust :16645-16668: owned card, Deleted, absent live and physical row.
  const { card } = seed('delete-normal');
  const repo = host.ctx.anki.cards;
  expect(loadOwnedChatankiCard(repo, card.id, OWNER).card.id).toBe(card.id);
  expect(repo.deleteCardForSession(card.id, card.updated_at, null, OWNER).kind).toBe('deleted');
  expect(repo.getCardWithDocument(card.id)).toBeNull();
  expect(storage.database('mistakes').pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', [card.id])).toBe(0);

  const toolCard = seed('delete-normal-tool').card;
  const before = events.length;
  const result = await execute('chatanki_delete_card', {
    cardId: toolCard.id, expectedVersion: toolCard.updated_at, expectedReviewVersion: null,
  });
  expect(result.success, result.error).toBe(true);
  expect(result.output).toMatchObject({ status: 'ok', deleted: true, mutationApplied: true, retryable: false });
  expect(repo.getCardWithDocument(toolCard.id)).toBeNull();
  expect(storage.database('mistakes').pluck<number>('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', [toolCard.id])).toBe(0);
  expect(events).toHaveLength(before + 1);
  expect(warnings).toEqual([]);
});

it('test_chatanki_delete_card_stale_version_returns_conflict_without_deletion with real providers', async () => {
  // Rust :16672-16710.
  const { card, documentId } = seed('delete-stale');
  const repo = host.ctx.anki.cards;
  const updated = repo.updateCardIfVersionForSession({ ...card, front: 'current' }, card.updated_at, OWNER);
  if (updated.kind !== 'updated') throw new Error(`unexpected ${updated.kind}`);
  const conflict = repo.deleteCardForSession(card.id, card.updated_at, null, OWNER);
  if (conflict.kind !== 'conflict') throw new Error(`expected delete conflict, got ${conflict.kind}`);
  expect(conflict.current.front).toBe('current');
  expect(conflict.current.updated_at).toBe(updated.card.updated_at);
  const payload = chatankiVersionConflictPayload(documentId, conflict.current);
  expect(payload.status).toBe('conflict');
  expect(payload.error).toBe('version_conflict');
  expect((payload.current as Record<string, unknown>).id).toBe(card.id);
  expect((payload.current as Record<string, unknown>).version).toBe(updated.card.updated_at);
  expect(payload.retryable).toBe(true);
  expect(repo.getCardWithDocument(card.id)).not.toBeNull();
  const before = events.length;
  const result = await execute('chatanki_delete_card', {
    cardId: card.id, expectedVersion: card.updated_at, expectedReviewVersion: null,
  });
  expect(result.success, result.error).toBe(true);
  expect(result.output).toEqual(payload);
  expect(repo.getCardWithDocument(card.id)?.card).toEqual(updated.card);
  expect(events).toHaveLength(before);
});

it('test_chatanki_delete_card_review_cas_blocks_null_and_post_rating_stale_tokens with real providers', async () => {
  // Rust :16714-16819, including genuine rate and physical FSRS/log cleanup.
  const { card, documentId } = seed('delete-review-cas');
  const repo = host.ctx.anki.cards;
  const service = host.ctx.review;
  service.enqueueCardsForSession([card.id], OWNER, null);
  const preflight = service.getReviewStatesForSession([card.id], OWNER)[0]!;
  expect(preflight.reviewVersion).toBe(0n);
  const nullConflict = repo.deleteCardForSession(card.id, card.updated_at, null, OWNER);
  if (nullConflict.kind !== 'reviewConflict') throw new Error(`expected enrollment conflict, got ${nullConflict.kind}`);
  expect(nullConflict.current.id).toBe(card.id);
  expect(nullConflict.review?.reviewVersion).toBe(0n);

  await host.invoke('fsrs_rate', { cardStateId: preflight.cardStateId, rating: 3, durationMs: 80 });
  const staleConflict = repo.deleteCardForSession(card.id, card.updated_at, preflight.reviewVersion, OWNER);
  if (staleConflict.kind !== 'reviewConflict') throw new Error(`expected post-rating conflict, got ${staleConflict.kind}`);
  expect(staleConflict.review?.reviewVersion).toBe(1n);
  const currentReview = service.getReviewStatesForSession([card.id], OWNER)[0]!;
  const payload = chatankiDeleteReviewConflictPayload(documentId, staleConflict.current, currentReview);
  expect(payload.status).toBe('conflict');
  expect(payload.error).toBe('review_state_conflict');
  expect((payload.current as Record<string, unknown>).id).toBe(card.id);
  expect(((payload.current as Record<string, unknown>).reviewState as Record<string, unknown>).reviewVersion).toBe(1n);
  expect(payload.mutationApplied).toBe(false);
  expect(payload.retryable).toBe(true);
  expect(repo.getCardWithDocument(card.id)).not.toBeNull();

  // Also run the production refresh branch against the same genuine rated state.
  const before = events.length;
  const stale = await execute('chatanki_delete_card', {
    cardId: card.id, expectedVersion: card.updated_at, expectedReviewVersion: 0,
  });
  expect(stale.success, stale.error).toBe(true);
  expect(stale.output).toEqual(payload);
  expect(repo.getCardWithDocument(card.id)?.card).toEqual(card);
  expect(events).toHaveLength(before);
  expect(repo.deleteCardForSession(card.id, card.updated_at, currentReview.reviewVersion, OWNER).kind).toBe('deleted');
  expect(repo.getCardWithDocument(card.id)).toBeNull();
  expect(storage.database('mistakes').pluck<number>(
    `SELECT (SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1)
          + (SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1)`, [card.id],
  )).toBe(0);
});
