import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { CommandError } from '../../../kernel/api.ts';
import type { AppError } from '../../../platform/errors/api.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { createTestHost } from '../../../kernel/testing.ts';
// boundary-allow cross-plugin-impl: R3 用真实 L16 插件命令验证删除路径的 FSRS 同事务清理；L16 api.ts 未发布卡片删除接口
import anki from '../../anki/index.ts';
import review from '../index.ts';
import { FsrsReviewService } from '../src/review.ts';
import { FSRS_PARAMS_VERSION } from '../src/fsrs-types.ts';
import { mistakesFixture } from './storage.ts';
import {
  assertNoFsrsRows, countFsrsRows, countRecentCards, countRecentTasks, countTasksForDocument,
  deleteAnkiCard, deleteAnkiCardForLibrary, deleteAnkiCardForSession, deleteDocumentSession,
  deleteDocumentTask, getAnkiAgentLibraryCard, getAnkiCardForSession, getAnkiCardWithDocument,
  getCardsByIds, getCardsForDocument, getCardsForDocumentForSession, getCardsForTask,
  getDocumentSessionSource, getDocumentTask, insertAnkiCardsForDocument, insertCardForTask,
  insertTaskAndCard, isDocumentOwnedBySession, listLibraryCards, loadReviewVersion,
  recoverStuckDocumentTasks, setTaskOwner, updateAnkiCardIfVersionForSession,
  updateDocumentTaskStatus,
} from './anki-data-layer.ts';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const coordinated: Array<{ dispose(): void }> = [];
const crossHosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
afterEach(async () => {
  for (const host of crossHosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  for (const fixture of coordinated.splice(0)) fixture.dispose();
});

function setup() {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  return { ...fixture, service: new FsrsReviewService(fixture.db) };
}

function coordinatedSetup() {
  const root = mkdtempSync(join(tmpdir(), 'review-coordinated-'));
  const storage = createStorageService({ baseDir: root, dataLocalDir: root });
  const fixture = {
    storage,
    get db() { return storage.database('mistakes'); },
    dispose() { storage.dispose(); rmSync(root, { recursive: true, force: true }); },
  };
  coordinated.push(fixture);
  return fixture;
}

function appErrorValue(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CommandError) return error.value as AppError;
    throw error;
  }
  throw new Error('expected an AppError');
}

function enqueueAndRate(db: ReturnType<typeof mistakesFixture>['db'], cardId: string): string {
  const service = new FsrsReviewService(db);
  const result = service.enqueueCards([cardId]);
  expect(result.enqueued).toBe(1);
  const stateId = result.states[0]!.id;
  expect(stateId).not.toBe(cardId);
  service.rate(stateId, 3, 250, null);
  return stateId;
}

function removeV20260711HistoryAndObjects(db: ReturnType<typeof mistakesFixture>['db']): void {
  db.exec(`
    DELETE FROM refinery_schema_history WHERE version >= 20260711 AND version <= 20260801;

    DROP TRIGGER IF EXISTS trg__change_log_anki_decks_insert;
    DROP TRIGGER IF EXISTS trg__change_log_anki_decks_update;
    DROP TRIGGER IF EXISTS trg__change_log_anki_decks_delete;
    DROP TRIGGER IF EXISTS trg__change_log_fsrs_card_states_insert;
    DROP TRIGGER IF EXISTS trg__change_log_fsrs_card_states_update;
    DROP TRIGGER IF EXISTS trg__change_log_fsrs_card_states_delete;
    DROP TRIGGER IF EXISTS trg__change_log_fsrs_review_logs_insert;
    DROP TRIGGER IF EXISTS trg__change_log_fsrs_review_logs_update;
    DROP TRIGGER IF EXISTS trg__change_log_fsrs_review_logs_delete;
    DROP TRIGGER IF EXISTS trg_fsrs_cleanup_before_anki_card_delete;

    DROP INDEX IF EXISTS idx_anki_decks_local_version;
    DROP INDEX IF EXISTS idx_anki_decks_deleted_at;
    DROP INDEX IF EXISTS idx_anki_decks_device_id;
    DROP INDEX IF EXISTS idx_anki_decks_sync_updated_at;
    DROP INDEX IF EXISTS idx_anki_decks_device_version;
    DROP INDEX IF EXISTS idx_anki_decks_updated_not_deleted;
    DROP INDEX IF EXISTS idx_fsrs_card_states_local_version;
    DROP INDEX IF EXISTS idx_fsrs_card_states_deleted_at;
    DROP INDEX IF EXISTS idx_fsrs_card_states_device_id;
    DROP INDEX IF EXISTS idx_fsrs_card_states_sync_updated_at;
    DROP INDEX IF EXISTS idx_fsrs_card_states_device_version;
    DROP INDEX IF EXISTS idx_fsrs_card_states_updated_not_deleted;
    DROP INDEX IF EXISTS idx_fsrs_review_logs_local_version;
    DROP INDEX IF EXISTS idx_fsrs_review_logs_deleted_at;
    DROP INDEX IF EXISTS idx_fsrs_review_logs_device_id;
    DROP INDEX IF EXISTS idx_fsrs_review_logs_sync_updated_at;
    DROP INDEX IF EXISTS idx_fsrs_review_logs_device_version;
    DROP INDEX IF EXISTS idx_fsrs_review_logs_updated_not_deleted;
    DROP INDEX IF EXISTS idx_fsrs_logs_state_active;
    DROP INDEX IF EXISTS idx_fsrs_review_logs_mastery_pending;
    DROP INDEX IF EXISTS idx_fsrs_logs_review_ms;
  `);
}

function assertV20260711ObjectsRestored(db: ReturnType<typeof mistakesFixture>['db']): void {
  const changeTriggers = Number(db.pluck(`SELECT COUNT(*) FROM sqlite_master
    WHERE type = 'trigger' AND name IN (
      'trg__change_log_anki_decks_insert', 'trg__change_log_anki_decks_update',
      'trg__change_log_anki_decks_delete', 'trg__change_log_fsrs_card_states_insert',
      'trg__change_log_fsrs_card_states_update', 'trg__change_log_fsrs_card_states_delete',
      'trg__change_log_fsrs_review_logs_insert', 'trg__change_log_fsrs_review_logs_update',
      'trg__change_log_fsrs_review_logs_delete')`));
  expect(changeTriggers).toBe(9);
  for (const [type, name] of [
    ['trigger', 'trg_fsrs_cleanup_before_anki_card_delete'],
    ['index', 'idx_anki_decks_device_version'],
    ['index', 'idx_fsrs_card_states_device_version'],
    ['index', 'idx_fsrs_review_logs_device_version'],
    ['index', 'idx_fsrs_logs_state_active'],
  ] as const) {
    expect(Number(db.pluck('SELECT COUNT(*) FROM sqlite_master WHERE type = ?1 AND name = ?2', [type, name])))
      .toBe(1);
  }
  expect(Number(db.pluck('SELECT COUNT(*) FROM refinery_schema_history WHERE version IN (20260711, 20260712)')))
    .toBe(2);
}

// MIRROR: 该用例仍直接调用 tests/anki-data-layer 的仓储镜像；L16 main 未合并
// cards/documents 子仓储前，TESTMAP 保持 pending，不能作为真实 L16 生产消费证据。
it('soft_deleted_card_is_hidden_from_agent_crud_and_fsrs', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-card-tombstone', 'task-card-tombstone', 'card-tombstone');
  insertCardForTask(db, 'doc-card-tombstone', 'task-card-tombstone', 'card-still-live');
  setTaskOwner(db, 'task-card-tombstone', 'session-owner');
  const before = getAnkiCardForSession(db, 'card-tombstone', 'session-owner');
  expect(before).not.toBeNull();
  const expectedVersion = before!.updated_at;
  const initial = service.enqueueCardsForSession(['card-tombstone'], 'session-owner', null);
  expect(initial.enqueued).toBe(1);
  const stateId = initial.states[0]!.id;
  expect(service.getDue(null)).toHaveLength(1);
  expect(service.getStats().total).toBe(1);

  const tombstone = '2026-07-14T01:00:00Z';
  db.run(`UPDATE anki_cards SET deleted_at = ?1, card_order_in_task = 99
    WHERE id = 'card-tombstone'`, [tombstone]);

  expect(getCardsForTask(db, 'task-card-tombstone').map(card => card.id)).toEqual(['card-still-live']);
  expect(getCardsForDocument(db, 'doc-card-tombstone').map(card => card.id)).toEqual(['card-still-live']);
  expect(getCardsForDocumentForSession(db, 'doc-card-tombstone', 'session-owner')!.map(card => card.id))
    .toEqual(['card-still-live']);
  expect(getCardsByIds(db, ['card-tombstone', 'card-still-live']).map(card => card.id))
    .toEqual(['card-still-live']);
  expect(getAnkiCardWithDocument(db, 'card-tombstone')).toBeNull();
  expect(getAnkiCardForSession(db, 'card-tombstone', 'session-owner')).toBeNull();

  expect(updateAnkiCardIfVersionForSession(
    db, 'card-tombstone', expectedVersion, 'session-owner', 'must not overwrite tombstone',
  )).toBe('not_found');
  expect(deleteAnkiCardForSession(db, 'card-tombstone', expectedVersion, null, 'session-owner').status)
    .toBe('not_found');

  expect(appErrorValue(() => service.enqueueCardsForSession(['card-tombstone'], 'session-owner', null)).message)
    .toBe('blocks.ankiCards.errors.statusNotFound');
  expect(service.getDue(null)).toEqual([]);
  expect(service.getStats().total).toBe(0);
  expect(appErrorValue(() => service.rate(stateId, 3, null, null)).message)
    .toContain('fsrs card state not found');

  const addedAt = new Date().toISOString();
  const inserted = insertAnkiCardsForDocument(db, 'doc-card-tombstone', 'session-owner', [
    { id: 'card-added-after-tombstone', front: 'new live front', back: 'new live back' },
  ]);
  expect(inserted).toEqual(['card-added-after-tombstone']);
  expect(Number(db.pluck(`SELECT card_order_in_task FROM anki_cards
    WHERE id = 'card-added-after-tombstone'`))).toBe(1);
  expect(Number(db.pluck(`SELECT COUNT(*) FROM anki_cards WHERE id = 'card-tombstone' AND deleted_at = ?1`,
    [tombstone]))).toBe(1);
  expect(Number(db.pluck('SELECT COUNT(*) FROM fsrs_card_states WHERE id = ?1', [stateId]))).toBe(1);
  void addedAt;
});

// MIRROR: 同上，待 L16 main 提供 cards/documents 子仓储后替换为真实面。
it('soft_deleted_document_task_is_hidden_and_cannot_be_recovered_or_mutated', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-task-tombstone', 'task-tombstone', 'card-live-child');
  setTaskOwner(db, 'task-tombstone', 'session-owner');
  const child = getAnkiCardForSession(db, 'card-live-child', 'session-owner');
  expect(child).not.toBeNull();
  const childVersion = child!.updated_at;
  const initial = service.enqueueCardsForSession(['card-live-child'], 'session-owner', null);
  expect(initial.enqueued).toBe(1);
  const stateId = initial.states[0]!.id;
  expect(service.getDue(null)).toHaveLength(1);
  expect(service.getStats().total).toBe(1);
  service.rate(stateId, 3, 25, null);
  expect(service.getStats().reviewsToday).toBe(1);
  expect(listLibraryCards(db).total).toBe(1);
  expect(listLibraryCards(db).ids[0]).toBe('card-live-child');

  const tombstone = '2026-07-14T02:00:00Z';
  const originalUpdatedAt = '2000-01-01T00:00:00Z';
  db.run(`UPDATE document_tasks SET status = 'Processing', updated_at = ?1, deleted_at = ?2
    WHERE id = 'task-tombstone'`, [originalUpdatedAt, tombstone]);

  expect(() => getDocumentTask(db, 'task-tombstone')).toThrow('Query returned no rows');
  expect(countTasksForDocument(db, 'doc-task-tombstone')).toBe(0);
  expect(countRecentTasks(db, 20)).toBe(0);
  expect(countRecentCards(db, 20)).toBe(0);

  expect(() => updateDocumentTaskStatus(db, 'task-tombstone', 'Failed'))
    .toThrow('document_task_not_found_or_deleted');
  expect(recoverStuckDocumentTasks(db, 0)).toBe(0);
  expect(db.get(`SELECT status, updated_at, deleted_at FROM document_tasks WHERE id = 'task-tombstone'`))
    .toEqual({ status: 'Processing', updated_at: originalUpdatedAt, deleted_at: tombstone });

  expect(getDocumentSessionSource(db, 'doc-task-tombstone')).toBeNull();
  expect(isDocumentOwnedBySession(db, 'doc-task-tombstone', 'session-owner')).toBe(false);
  expect(getCardsForDocument(db, 'doc-task-tombstone')).toEqual([]);
  expect(getCardsForDocumentForSession(db, 'doc-task-tombstone', 'session-owner')).toBeNull();
  expect(getCardsForTask(db, 'task-tombstone')).toEqual([]);
  expect(getCardsByIds(db, ['card-live-child'])).toEqual([]);
  expect(getAnkiCardWithDocument(db, 'card-live-child')).toBeNull();
  expect(getAnkiCardForSession(db, 'card-live-child', 'session-owner')).toBeNull();
  expect(updateAnkiCardIfVersionForSession(
    db, 'card-live-child', childVersion, 'session-owner', 'must not update child of tombstoned task',
  )).toBe('not_found');
  expect(deleteAnkiCardForSession(db, 'card-live-child', childVersion, null, 'session-owner').status)
    .toBe('not_found');

  expect(() => insertAnkiCardsForDocument(db, 'doc-task-tombstone', 'session-owner', [
    { id: 'card-must-not-add', front: 'must not add', back: 'must not add' },
  ])).toThrow('document_ownership_mismatch');

  expect(appErrorValue(() => service.enqueueCardsForSession(['card-live-child'], 'session-owner', null)).message)
    .toBe('blocks.ankiCards.errors.statusNotFound');
  expect(appErrorValue(() => service.enqueueCardsForSession([], 'session-owner', 'doc-task-tombstone')).message)
    .toBe('blocks.ankiCards.errors.statusNotFound');
  expect(service.getDue(null)).toEqual([]);
  const stats = service.getStats();
  expect(stats.total).toBe(0);
  expect(stats.due).toBe(0);
  expect(stats.reviewsToday).toBe(0);
  expect(appErrorValue(() => service.suspendCard(stateId)).message).toContain('fsrs card state not found');
  expect(listLibraryCards(db).total).toBe(0);
  expect(Number(db.pluck(`SELECT COUNT(*) FROM anki_cards WHERE id = 'card-must-not-add'`))).toBe(0);
});

// MIRROR: 同上，待 L16 main 提供 cards/deleteCardForSession 后替换为真实面。
it('chatanki_versioned_delete_cas_cleans_fsrs_without_cleanup_trigger_and_conflict_preserves_it', () => {
  const { db } = setup();
  db.exec(`DROP TRIGGER trg_fsrs_cleanup_before_anki_card_delete;
    CREATE TRIGGER require_fsrs_cleanup_before_anki_card_delete
    BEFORE DELETE ON anki_cards
    WHEN EXISTS (SELECT 1 FROM fsrs_review_logs WHERE anki_card_id = OLD.id)
      OR EXISTS (SELECT 1 FROM fsrs_card_states WHERE anki_card_id = OLD.id)
    BEGIN
      SELECT RAISE(ABORT, 'dependent FSRS rows must be deleted first');
    END;`);

  insertTaskAndCard(db, 'doc-delete-success', 'task-delete-success', 'card-delete-success');
  setTaskOwner(db, 'task-delete-success', 'session-owner');
  const successVersion = getAnkiCardWithDocument(db, 'card-delete-success')!.updated_at;
  enqueueAndRate(db, 'card-delete-success');
  const success = deleteAnkiCardForSession(
    db, 'card-delete-success', successVersion, 1, 'session-owner',
  );
  expect(success.status).toBe('deleted');
  expect(Number(db.pluck(`SELECT COUNT(*) FROM anki_cards WHERE id = 'card-delete-success'`))).toBe(0);
  assertNoFsrsRows(db, ['card-delete-success']);

  insertTaskAndCard(db, 'doc-delete-conflict', 'task-delete-conflict', 'card-delete-conflict');
  setTaskOwner(db, 'task-delete-conflict', 'session-owner');
  const staleVersion = getAnkiCardWithDocument(db, 'card-delete-conflict')!.updated_at;
  const stateId = enqueueAndRate(db, 'card-delete-conflict');
  const currentVersion = '2026-07-14T00:00:00Z';
  db.run('UPDATE anki_cards SET updated_at = ?1 WHERE id = ?2', [currentVersion, 'card-delete-conflict']);

  const conflict = deleteAnkiCardForSession(
    db, 'card-delete-conflict', staleVersion, 1, 'session-owner',
  );
  expect(conflict.status).toBe('conflict');
  if (conflict.status !== 'conflict') throw new Error('unreachable');
  expect(conflict.current.updated_at).toBe(currentVersion);
  expect(Number(db.pluck(`SELECT COUNT(*) FROM anki_cards WHERE id = 'card-delete-conflict'`))).toBe(1);
  expect(Number(db.pluck(`SELECT COUNT(*) FROM fsrs_card_states WHERE id = ?1 AND anki_card_id = ?2`,
    [stateId, 'card-delete-conflict']))).toBe(1);
  expect(Number(db.pluck(`SELECT COUNT(*) FROM fsrs_review_logs WHERE card_state_id = ?1 AND anki_card_id = ?2`,
    [stateId, 'card-delete-conflict']))).toBe(1);
});

it('migration_recovery_replays_tail_when_all_alter_columns_exist', async () => {
  const { storage, db } = coordinatedSetup();
  const first = await storage.migrations.runAll();
  expect(first.success).toBe(true);
  expect(storage.migrations.currentVersion('mistakes')).toBeGreaterThan(20260801);

  removeV20260711HistoryAndObjects(db);
  insertTaskAndCard(db, 'doc-recovery-all', 'task-recovery-all', 'card-recovery-all');
  insertTaskAndCard(db, 'doc-recovery-soft', 'task-recovery-soft', 'card-recovery-soft');

  db.run(`INSERT INTO fsrs_card_states (
      id, anki_card_id, state, due_ms, fsrs_params_version, created_at, updated_at
    ) VALUES ('state-recovery-all', 'card-recovery-all', 0, 0, ?1,
      '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z')`, [FSRS_PARAMS_VERSION]);
  db.run(`INSERT INTO fsrs_review_logs (
      id, card_state_id, anki_card_id, rating, state_before, state_after,
      review_ms, fsrs_params_version, created_at, updated_at
    ) VALUES ('log-recovery-all', 'state-recovery-all', 'card-recovery-all',
      3, 0, 1, 1783728000000, ?1, NULL, NULL)`, [FSRS_PARAMS_VERSION]);
  db.run(`INSERT INTO fsrs_card_states (
      id, anki_card_id, state, due_ms, fsrs_params_version, created_at, updated_at
    ) VALUES ('state-recovery-orphan', 'card-recovery-missing', 0, 0, ?1,
      '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z')`, [FSRS_PARAMS_VERSION]);
  db.run(`INSERT INTO fsrs_review_logs (
      id, card_state_id, anki_card_id, rating, state_before, state_after,
      review_ms, fsrs_params_version
    ) VALUES ('log-recovery-orphan', 'state-recovery-orphan', 'card-recovery-missing',
      3, 0, 1, 1783728000000, ?1)`, [FSRS_PARAMS_VERSION]);
  db.run(`INSERT INTO fsrs_card_states (
      id, anki_card_id, state, due_ms, fsrs_params_version, created_at, updated_at
    ) VALUES ('state-recovery-soft', 'card-recovery-soft', 0, 0, ?1,
      '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z')`, [FSRS_PARAMS_VERSION]);
  db.run(`INSERT INTO fsrs_review_logs (
      id, card_state_id, anki_card_id, rating, state_before, state_after,
      review_ms, fsrs_params_version, created_at, updated_at
    ) VALUES ('log-recovery-soft', 'state-recovery-soft', 'card-recovery-soft',
      3, 0, 1, 1783728000000, ?1, '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z')`,
  [FSRS_PARAMS_VERSION]);
  db.run(`UPDATE anki_cards SET deleted_at = '2026-07-11T00:00:00Z' WHERE id = 'card-recovery-soft'`);

  const recovered = await storage.migrations.runAll();
  expect(recovered.success).toBe(true);
  expect(storage.migrations.currentVersion('mistakes')).toBeGreaterThan(20260801);
  assertV20260711ObjectsRestored(db);

  const timestamps = db.get<{ created_at: string | null; updated_at: string | null }>(`SELECT created_at, updated_at
    FROM fsrs_review_logs WHERE id = 'log-recovery-all'`)!;
  expect(timestamps.created_at).not.toBeNull();
  expect(timestamps.updated_at).not.toBeNull();
  expect(Number(db.pluck(`SELECT
    (SELECT COUNT(*) FROM fsrs_card_states WHERE id = 'state-recovery-orphan') +
    (SELECT COUNT(*) FROM fsrs_review_logs WHERE id = 'log-recovery-orphan')`))).toBe(0);
  expect(Number(db.pluck(`SELECT
    (SELECT COUNT(*) FROM fsrs_card_states WHERE id = 'state-recovery-soft') +
    (SELECT COUNT(*) FROM fsrs_review_logs WHERE id = 'log-recovery-soft')`))).toBe(2);
  for (const [tableName, recordId] of [
    ['fsrs_card_states', 'state-recovery-all'],
    ['fsrs_review_logs', 'log-recovery-all'],
    ['fsrs_card_states', 'state-recovery-soft'],
    ['fsrs_review_logs', 'log-recovery-soft'],
  ] as const) {
    expect(Number(db.pluck(`SELECT COUNT(*) FROM __change_log
      WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0`, [tableName, recordId])))
      .toBe(tableName === 'fsrs_review_logs' ? 2 : 1);
  }

  db.run('DELETE FROM refinery_schema_history WHERE version >= 20260711 AND version <= 20260801');
  const repeated = await storage.migrations.runAll();
  expect(repeated.success).toBe(true);
  expect(storage.migrations.currentVersion('mistakes')).toBeGreaterThan(20260801);
  for (const [tableName, recordId] of [
    ['fsrs_card_states', 'state-recovery-all'],
    ['fsrs_review_logs', 'log-recovery-all'],
    ['fsrs_card_states', 'state-recovery-soft'],
    ['fsrs_review_logs', 'log-recovery-soft'],
  ] as const) {
    expect(Number(db.pluck(`SELECT COUNT(*) FROM __change_log
      WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0 AND operation = 'INSERT'`,
    [tableName, recordId]))).toBe(1);
    if (tableName === 'fsrs_review_logs') {
      expect(Number(db.pluck(`SELECT COUNT(*) FROM __change_log
        WHERE table_name = ?1 AND record_id = ?2 AND sync_version = 0`, [tableName, recordId]))).toBe(3);
    }
  }
});

it('migration_recovery_replays_tail_when_only_some_alter_columns_exist', async () => {
  const { storage, db } = coordinatedSetup();
  expect((await storage.migrations.runAll()).success).toBe(true);
  removeV20260711HistoryAndObjects(db);
  db.exec('ALTER TABLE fsrs_review_logs DROP COLUMN deleted_at');

  const recovered = await storage.migrations.runAll();
  expect(recovered.success).toBe(true);
  expect(storage.migrations.currentVersion('mistakes')).toBeGreaterThan(20260801);
  assertV20260711ObjectsRestored(db);
  const columns = db.all<{ name: string }>('PRAGMA table_info(fsrs_review_logs)').map(row => row.name);
  expect(columns).toContain('deleted_at');
});

it('deletion_paths_and_tombstones_do_not_leave_schedulable_ghosts', async () => {
  const { storage, db, service } = setup();
  const host = await createTestHost({
    plugins: [review, anki],
    provide: {
      storage,
      paths: { appDataDir: storage.database('mistakes').path, os: { temp: tmpdir() } },
    },
  });
  crossHosts.push(host);

  insertTaskAndCard(db, 'doc-card', 'task-card', 'card-direct-api');
  enqueueAndRate(db, 'card-direct-api');
  await host.invoke('delete_anki_card', { cardId: 'card-direct-api' });
  assertNoFsrsRows(db, ['card-direct-api']);

  insertTaskAndCard(db, 'doc-task', 'task-delete', 'card-task-delete');
  enqueueAndRate(db, 'card-task-delete');
  await host.invoke('delete_document_task', { taskId: 'task-delete' });
  assertNoFsrsRows(db, ['card-task-delete']);

  insertTaskAndCard(db, 'doc-session', 'task-session-a', 'card-session-a');
  insertTaskAndCard(db, 'doc-session', 'task-session-b', 'card-session-b');
  enqueueAndRate(db, 'card-session-a');
  enqueueAndRate(db, 'card-session-b');
  await host.invoke('delete_document_session', { documentId: 'doc-session' });
  assertNoFsrsRows(db, ['card-session-a', 'card-session-b']);

  insertTaskAndCard(db, 'doc-sql', 'task-sql', 'card-direct-sql');
  enqueueAndRate(db, 'card-direct-sql');
  db.run('DELETE FROM anki_cards WHERE id = ?1', ['card-direct-sql']);
  assertNoFsrsRows(db, ['card-direct-sql']);

  insertTaskAndCard(db, 'doc-tombstone', 'task-tombstone', 'card-tombstone');
  const tombstonedState = enqueueAndRate(db, 'card-tombstone');
  db.run(`UPDATE anki_cards SET deleted_at = '2026-07-11T00:00:00Z' WHERE id = 'card-tombstone'`);

  expect(service.getDue(50)).toEqual([]);
  expect(appErrorValue(() => service.rate(tombstonedState, 3, null, null)).message)
    .toContain('fsrs card state not found');
  const stats = service.getStats();
  expect(stats.total).toBe(0);
  expect(stats.reviewsToday).toBe(0);

  db.run(`UPDATE anki_cards SET deleted_at = NULL WHERE id = 'card-tombstone'`);
  expect(Number(db.pluck('SELECT COUNT(*) FROM fsrs_review_logs WHERE card_state_id = ?1', [tombstonedState])))
    .toBe(1);
  const restored = service.getStats();
  expect(restored.total).toBe(1);
  expect(restored.reviewsToday).toBe(1);
  service.rate(tombstonedState, 3, null, null);
});

// PARTIAL: library/content 读取侧三字段已补；Rust 原测试还断言 agent page，
// main 的 L16 尚无 agent-page 命令，TESTMAP 保持 pending，不以共享 decoder 推测代替。
it('legacy_null_anki_json_fields_do_not_break_library_reads_or_enqueue', async () => {
  const { storage, db, service } = setup();
  const host = await createTestHost({
    plugins: [review, anki],
    provide: {
      storage,
      paths: { appDataDir: storage.database('mistakes').path, os: { temp: tmpdir() } },
    },
  });
  crossHosts.push(host);
  insertTaskAndCard(db, 'doc-library-legacy-null', 'task-library-legacy-null', 'card-library-legacy-null');
  db.run(`UPDATE anki_cards SET tags_json = NULL, images_json = NULL, extra_fields_json = NULL
    WHERE id = ?1`, ['card-library-legacy-null']);

  const listing = await host.invoke<{
    total: number;
    items: Array<{
      id: string; tags: string[]; images: string[];
      extra_fields: Record<string, string>;
    }>;
  }>(
    'list_anki_library_cards', { request: { page: 1, pageSize: 12 } },
  );
  expect(listing.total).toBe(1);
  expect(listing.items.map(item => item.id)).toEqual(['card-library-legacy-null']);
  // Rust `list_anki_library_cards` 读取侧原字段断言：NULL 列解码为空集合，而不是落成 null。
  expect(listing.items[0]).toMatchObject({ tags: [], images: [], extra_fields: {} });
  const content = await host.invoke<{
    tags: string[]; images: string[]; extra_fields: Record<string, string>;
  } | null>('get_anki_library_card_content', {
    cardId: 'card-library-legacy-null',
  });
  expect(content).not.toBeNull();
  expect(content).toMatchObject({ tags: [], images: [], extra_fields: {} });
  // Rust 还断言 agent page；main 的 L16 尚未发布 agent-page 命令，
  // L16 分支的 listAnkiAgentLibraryCards 复用同一卡片解码路径，合并后再补该断言。
  expect(db.pluck('SELECT tags_json FROM anki_cards WHERE id = ?1', ['card-library-legacy-null'])).toBeNull();
  expect(db.pluck('SELECT images_json FROM anki_cards WHERE id = ?1', ['card-library-legacy-null'])).toBeNull();
  expect(db.pluck('SELECT extra_fields_json FROM anki_cards WHERE id = ?1', ['card-library-legacy-null']))
    .toBeNull();

  const enqueue = service.enqueueCards(['card-library-legacy-null']);
  expect(enqueue.enqueued).toBe(1);
  expect(enqueue.reviewCards).toHaveLength(1);
  expect(enqueue.reviewCards[0]!.tags).toEqual([]);
  expect(enqueue.reviewCards[0]!.images).toEqual([]);
  expect(enqueue.reviewCards[0]!.extraFields).toEqual({});
});

// MIRROR: 同上，待 L16 main 提供 deleteAnkiCardForLibrary 后替换为真实面。
it('agent_library_delete_conflicts_when_user_rates_after_preflight', () => {
  const { db, service } = setup();
  insertTaskAndCard(db, 'doc-library-delete', 'task-library-delete', 'card-library-delete');
  setTaskOwner(db, 'task-library-delete', 'session-foreign');
  const card = getAnkiCardWithDocument(db, 'card-library-delete')!;

  const outcome = service.enqueueCardsForLibrary('agent', [
    { cardId: card.id, expectedContentVersion: card.updated_at },
  ]);
  expect(outcome.status).toBe('enqueued');
  if (outcome.status !== 'enqueued') throw new Error('unreachable');
  const stateId = outcome.result.states[0]!.id;

  const unexpectedEnrollment = deleteAnkiCardForLibrary(db, card.id, card.updated_at, null);
  expect(unexpectedEnrollment.status).toBe('review_conflict');
  if (unexpectedEnrollment.status !== 'review_conflict') throw new Error('unreachable');
  expect(unexpectedEnrollment.review!.reviewVersion).toBe(0);

  const preflight = service.getReviewStatesForLibrary('agent', [card.id])[0]!;
  expect(preflight.reviewVersion).toBe(0n);
  service.rate(stateId, 3, 75, null);

  const conflict = deleteAnkiCardForLibrary(db, card.id, card.updated_at, preflight.reviewVersion);
  expect(conflict.status).toBe('review_conflict');
  if (conflict.status !== 'review_conflict') throw new Error('unreachable');
  expect(conflict.current.id).toBe(card.id);
  expect(conflict.review!.reviewVersion).toBe(1);
  expect(getAnkiAgentLibraryCard(db, card.id)).not.toBeNull();

  const current = service.getReviewStatesForLibrary('agent', [card.id])[0]!;
  const deleted = deleteAnkiCardForLibrary(db, card.id, card.updated_at, current.reviewVersion);
  expect(deleted.status).toBe('deleted');
  if (deleted.status !== 'deleted') throw new Error('unreachable');
  expect(deleted.documentId).toBe('doc-library-delete');
  expect(deleted.sourceSessionId).toBe('session-foreign');
  expect(getAnkiAgentLibraryCard(db, card.id)).toBeNull();
  expect(loadReviewVersion(db, card.id)).toBeNull();
  expect(countFsrsRows(db, card.id)).toEqual({ states: 0, logs: 0 });
});
