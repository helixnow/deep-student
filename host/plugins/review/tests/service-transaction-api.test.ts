import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import review from '../index.ts';
import { mistakesFixture } from './storage.ts';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];

async function setup() {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const host = await createTestHost({ plugins: [review], provide: { storage: fixture.storage } });
  hosts.push(host);
  return { ...fixture, host };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
});

function insertTaskAndCard(
  db: ReturnType<typeof mistakesFixture>['db'],
  documentId: string,
  taskId: string,
  cardId: string,
): void {
  db.run(`INSERT INTO document_tasks (
    id, document_id, original_document_name, segment_index,
    content_segment, status, anki_generation_options_json
  ) VALUES (?1, ?2, 'test.md', 0, 'segment', 'Completed', '{}')`, [taskId, documentId]);
  db.run(`INSERT INTO anki_cards (
    id, task_id, front, back, source_type, source_id
  ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)`, [cardId, taskId, `front-${cardId}`, `back-${cardId}`, documentId]);
}

function insertCardForTask(
  db: ReturnType<typeof mistakesFixture>['db'],
  documentId: string,
  taskId: string,
  cardId: string,
): void {
  db.run(`INSERT INTO anki_cards (
    id, task_id, front, back, source_type, source_id
  ) VALUES (?1, ?2, ?3, ?4, 'document', ?5)`, [cardId, taskId, `front-${cardId}`, `back-${cardId}`, documentId]);
}

function fsrsRowCount(db: ReturnType<typeof mistakesFixture>['db'], cardId: string): number {
  const states = Number(db.pluck('SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', [cardId]));
  const logs = Number(db.pluck('SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1', [cardId]));
  return states + logs;
}

it('review_service_cleanup_shares_the_callers_transaction', async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-tx-delete', 'task-tx-delete', 'card-tx-delete');
  host.ctx.review.enqueueCards(['card-tx-delete']);
  expect(fsrsRowCount(db, 'card-tx-delete')).toBe(1);

  expect(() => db.transaction((tx) => {
    host.ctx.review.cleanupCardDeletionInTx(tx, ['card-tx-delete']);
    tx.run('DELETE FROM anki_cards WHERE id = ?1', ['card-tx-delete']);
    throw new Error('rollback');
  })).toThrow('rollback');
  expect(fsrsRowCount(db, 'card-tx-delete')).toBe(1);
  expect(Number(db.pluck('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', ['card-tx-delete']))).toBe(1);

  db.transaction((tx) => {
    host.ctx.review.cleanupCardDeletionInTx(tx, ['card-tx-delete']);
    tx.run('DELETE FROM anki_cards WHERE id = ?1', ['card-tx-delete']);
  });
  expect(fsrsRowCount(db, 'card-tx-delete')).toBe(0);
  expect(Number(db.pluck('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', ['card-tx-delete']))).toBe(0);
});

it('review_service_enqueue_imported_cards_shares_the_callers_transaction', async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-tx-import', 'task-tx-import', 'card-tx-existing');

  expect(() => db.transaction((tx) => {
    insertCardForTask(db, 'doc-tx-import', 'task-tx-import', 'card-tx-import-rollback');
    host.ctx.review.enqueueImportedCardsInTx(tx, [
      { cardId: 'card-tx-import-rollback', seed: null },
    ]);
    throw new Error('rollback');
  })).toThrow('rollback');
  expect(fsrsRowCount(db, 'card-tx-import-rollback')).toBe(0);
  expect(Number(db.pluck('SELECT COUNT(*) FROM anki_cards WHERE id = ?1', ['card-tx-import-rollback']))).toBe(0);

  const summary = db.transaction((tx) => {
    insertCardForTask(db, 'doc-tx-import', 'task-tx-import', 'card-tx-import-commit');
    return host.ctx.review.enqueueImportedCardsInTx(tx, [
      { cardId: 'card-tx-import-commit', seed: null },
      {
        cardId: 'card-tx-import-commit',
        seed: {
          state: 2, stability: 5, difficulty: 4, elapsedDays: 1, scheduledDays: 3,
          reps: 2, lapses: 0, dueMs: Date.now(), lastReviewMs: Date.now() - 86_400_000,
          suspended: false,
        },
      },
    ]);
  });
  expect(summary).toEqual({ enqueued: 1, skipped: 1, withHistory: 0, suspended: 0 });
  expect(fsrsRowCount(db, 'card-tx-import-commit')).toBe(1);
});

it('review_service_import_summary_counts_history_and_suspended_seeds', async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-tx-seed', 'task-tx-seed', 'card-tx-seed-a');
  insertCardForTask(db, 'doc-tx-seed', 'task-tx-seed', 'card-tx-seed-b');
  const now = Date.now();
  const summary = db.transaction((tx) => host.ctx.review.enqueueImportedCardsInTx(tx, [
    {
      cardId: 'card-tx-seed-a',
      seed: {
        state: 2, stability: 10, difficulty: 5, elapsedDays: 2, scheduledDays: 7,
        reps: 4, lapses: 1, dueMs: now, lastReviewMs: now - 2 * 86_400_000, suspended: true,
      },
    },
    {
      cardId: 'card-tx-seed-b',
      seed: {
        state: 1, stability: null, difficulty: null, elapsedDays: 0, scheduledDays: 0,
        reps: 1, lapses: 0, dueMs: now, lastReviewMs: null, suspended: false,
      },
    },
  ]));
  expect(summary).toEqual({ enqueued: 2, skipped: 0, withHistory: 2, suspended: 1 });
  const suspended = Number(db.pluck(
    'SELECT suspended FROM fsrs_card_states WHERE anki_card_id = ?1', ['card-tx-seed-a'],
  ));
  expect(suspended).toBe(1);
});
