import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { AppError } from '../../../platform/errors/api.ts';
import review from '../index.ts';
import { mistakesFixture } from './storage.ts';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];

async function setup() {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const vfs = fixture.storage.database('vfs');
  for (const name of [
    'V20260718__add_mastery_tables.sql',
    'V20260719__mastery_events_signal.sql',
    'V20260720__mastery_events_sync.sql',
    'V20260909__mastery_events_insight_source.sql',
  ]) {
    vfs.exec(readFileSync(`resources/app/migrations/vfs/${name}`, 'utf8'));
  }
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

it('fsrs_enqueue_cards_emits_changed_with_full_card_content', async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-cmd-enqueue', 'task-cmd-enqueue', 'card-cmd-enqueue');
  const result = await host.invoke<{ enqueued: number; enqueuedStateIds: string[] }>(
    'fsrs_enqueue_cards', { ankiCardIds: ['card-cmd-enqueue'] },
  );
  expect(result.enqueued).toBe(1);
  const events = host.eventsNamed('fsrs://changed') as Array<Record<string, unknown>>;
  expect(events).toHaveLength(1);
  expect(events[0]!.source).toBe('user');
  expect(events[0]!.action).toBe('enqueue');
  expect(events[0]!.entityIds).toEqual(['card-cmd-enqueue']);
  expect(events[0]!.cardStateIds).toEqual(result.enqueuedStateIds);
  const cards = events[0]!.cards as Array<Record<string, unknown>>;
  expect(cards[0]!.front).toBe('front-card-cmd-enqueue');
  expect(cards[0]!.back).toBe('back-card-cmd-enqueue');
});

it('fsrs_rate_emits_rate_payload_with_log_id', async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-cmd-rate', 'task-cmd-rate', 'card-cmd-rate');
  const enqueued = await host.invoke<{ states: Array<{ id: string }> }>(
    'fsrs_enqueue_cards', { ankiCardIds: ['card-cmd-rate'] },
  );
  host.events.length = 0;
  const stateId = enqueued.states[0]!.id;
  const rated = await host.invoke<{ logId: string; cardState: { id: string; ankiCardId: string } }>(
    'fsrs_rate', { cardStateId: stateId, rating: 3, durationMs: 100, clientOpId: crypto.randomUUID() },
  );
  const events = host.eventsNamed('fsrs://changed') as Array<Record<string, unknown>>;
  expect(events).toHaveLength(1);
  expect(events[0]!.action).toBe('rate');
  expect(events[0]!.entityIds).toEqual(['card-cmd-rate']);
  expect(events[0]!.cardStateIds).toEqual([stateId]);
  const cards = events[0]!.cards as Array<Record<string, unknown>>;
  expect(cards[0]!.logId).toBe(rated.logId);
  const due = await host.invoke<unknown[]>('fsrs_get_due', {});
  expect(Array.isArray(due)).toBe(true);
});

it('fsrs_rate_rejects_malformed_client_op_id_through_command_error', async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-cmd-bad', 'task-cmd-bad', 'card-cmd-bad');
  const enqueued = await host.invoke<{ states: Array<{ id: string }> }>(
    'fsrs_enqueue_cards', { ankiCardIds: ['card-cmd-bad'] },
  );
  const stateId = enqueued.states[0]!.id;
  try {
    await host.invoke('fsrs_rate', { cardStateId: stateId, rating: 3, clientOpId: 'not-a-uuid' });
    throw new Error('expected command rejection');
  } catch (error) {
    expect(error).toMatchObject({
      error_type: 'Validation',
      message: 'clientOpId must be a valid UUID',
    } satisfies Partial<AppError>);
  }
  expect(Number(db.pluck('SELECT reps FROM fsrs_card_states WHERE id = ?1', [stateId]))).toBe(0);
});

it('v2_s3_fsrs_rate_client_op_id_accepts_only_uuid_parse_str_shapes', async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-cmd-uuid', 'task-cmd-uuid', 'card-cmd-uuid');
  const enqueued = await host.invoke<{ states: Array<{ id: string }> }>(
    'fsrs_enqueue_cards', { ankiCardIds: ['card-cmd-uuid'] },
  );
  const stateId = enqueued.states[0]!.id;
  const hex = '67e5504410b1426f9247bb680e5fe0c8';
  // Mixed hyphenation, braced simple and an uppercase URN prefix all fail uuid 1.20 `try_parse`.
  for (const clientOpId of [
    '67e55044-10b1426f-9247-bb680e5fe0c8',
    '67e5504410b1-426f-9247-bb680e5fe0c8',
    `{${hex}}`,
    'URN:UUID:67e55044-10b1-426f-9247-bb680e5fe0c8',
    `urn:uuid:${hex}`,
  ]) {
    await expect(host.invoke('fsrs_rate', { cardStateId: stateId, rating: 3, clientOpId }), clientOpId)
      .rejects.toMatchObject({ error_type: 'Validation', message: 'clientOpId must be a valid UUID' });
    expect(Number(db.pluck('SELECT reps FROM fsrs_card_states WHERE id = ?1', [stateId]))).toBe(0);
  }
  // Accepted shapes canonicalise to the lowercase hyphenated id, so they replay the same log.
  const canonical = '67e55044-10b1-426f-9247-bb680e5fe0c8';
  const shapes = [hex.toUpperCase(), canonical, `{${canonical}}`, `urn:uuid:${canonical.toUpperCase()}`];
  for (const clientOpId of shapes) {
    const rated = await host.invoke<{ logId: string }>('fsrs_rate', { cardStateId: stateId, rating: 3, clientOpId });
    expect(rated.logId, clientOpId).toBe(canonical);
  }
  expect(Number(db.pluck('SELECT COUNT(*) FROM fsrs_review_logs WHERE card_state_id = ?1', [stateId]))).toBe(1);
});

it('x6_lp_0247_rate_and_undo_outbox_logs_use_rust_call_site_text', async () => {
  const { db, storage, host } = await setup();
  storage.database('vfs').exec('CREATE TABLE __change_log (table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT)');
  insertTaskAndCard(db, 'doc-cmd-lp', 'task-cmd-lp', 'card-cmd-lp');
  const logs: Array<{ type: string; args: unknown[] }> = [];
  host.ctx.logger.exporter({
    levels: { review: 3 },
    export(message: { type: string; name: string; args: unknown[] }) {
      if (message.name === 'review') logs.push({ type: message.type, args: message.args });
    },
  });
  const pick = (prefix: string) => logs.filter(entry => String(entry.args[0]).startsWith(prefix));
  const enqueued = await host.invoke<{ states: Array<{ id: string }> }>(
    'fsrs_enqueue_cards', { ankiCardIds: ['card-cmd-lp'] },
  );
  const stateId = enqueued.states[0]!.id;
  // Mastery writes succeed; only the outbox confirmation is made to fail.
  db.exec(`CREATE TRIGGER block_mastery_confirm BEFORE UPDATE OF mastery_synced_at ON fsrs_review_logs
    BEGIN SELECT RAISE(ABORT, 'confirm blocked'); END`);
  const rated = await host.invoke<{ logId: string }>('fsrs_rate', { cardStateId: stateId, rating: 3 });
  expect(pick('[fsrs_rate]')).toEqual([{
    type: 'warn',
    args: ['[fsrs_rate] failed to confirm mastery row %s: %s', rated.logId, expect.stringContaining('confirm blocked')],
  }]);
  await host.invoke('fsrs_undo_last_review', { expectedLogId: rated.logId, cardStateId: stateId });
  expect(pick('[fsrs_undo]')).toEqual([{
    type: 'warn',
    args: ['[fsrs_undo] failed to confirm mastery revert for %s: %s', rated.logId, expect.stringContaining('confirm blocked')],
  }]);
  // The undone rating stays revert-pending, so the next rate's outbox pass reverts it again and
  // reports the confirm failure with the revert-specific Rust text before confirming the new rating.
  const second = await host.invoke<{ logId: string }>('fsrs_rate', { cardStateId: stateId, rating: 3 });
  const blocked = expect.stringContaining('confirm blocked');
  expect(pick('[fsrs_rate]').map(entry => entry.args)).toEqual([
    ['[fsrs_rate] failed to confirm mastery row %s: %s', rated.logId, blocked],
    ['[fsrs_rate] failed to confirm mastery revert for %s: %s', rated.logId, blocked],
    ['[fsrs_rate] failed to confirm mastery row %s: %s', second.logId, blocked],
  ]);
});

it('x6_lp_0247_get_due_compensation_failures_stay_silent_like_rust_but_confirm_still_warns', async () => {
  const { db, storage, host } = await setup();
  const vfs = storage.database('vfs');
  insertTaskAndCard(db, 'doc-cmd-due-lp', 'task-cmd-due-lp', 'card-cmd-due-lp');
  const logs: unknown[][] = [];
  host.ctx.logger.exporter({
    levels: { review: 3 },
    export(message: { type: string; name: string; args: unknown[] }) {
      if (message.name === 'review' && String(message.args[0]).startsWith('[fsrs_get_due]')) logs.push([message.type, ...message.args]);
    },
  });
  const stateId = (await host.invoke<{ states: Array<{ id: string }> }>(
    'fsrs_enqueue_cards', { ankiCardIds: ['card-cmd-due-lp'] },
  )).states[0]!.id;
  // Without __change_log every mastery write fails, so the rating stays in the outbox.
  const rated = await host.invoke<{ logId: string }>('fsrs_rate', { cardStateId: stateId, rating: 3 });
  const pendingRow = () => db.get<{ synced: string | null; revert: number }>(
    'SELECT mastery_synced_at AS synced, mastery_revert_pending AS revert FROM fsrs_review_logs WHERE id = ?1', [rated.logId],
  );

  // Rust fsrs_review.rs:158 `record(..).is_ok()`: the failed compensation write is not logged.
  await host.invoke('fsrs_get_due', {});
  expect(logs).toEqual([]);
  expect(pendingRow()).toEqual({ synced: null, revert: 0 });

  // The confirm warn (fsrs_review.rs:181) still fires once the write succeeds.
  vfs.exec('CREATE TABLE __change_log (table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT)');
  db.exec(`CREATE TRIGGER block_mastery_confirm BEFORE UPDATE OF mastery_synced_at ON fsrs_review_logs
    BEGIN SELECT RAISE(ABORT, 'confirm blocked'); END`);
  await host.invoke('fsrs_get_due', {});
  expect(logs).toEqual([
    ['warn', '[fsrs_get_due] failed to confirm mastery row %s: %s', rated.logId, expect.stringContaining('confirm blocked')],
  ]);
  logs.length = 0;

  // Rust fsrs_review.rs:149 `matches!(revert(..), Ok(Some(_)))`: a failed revert is not logged either.
  db.exec('DROP TRIGGER block_mastery_confirm');
  db.run('UPDATE fsrs_review_logs SET mastery_revert_pending = 1 WHERE id = ?1', [rated.logId]);
  vfs.exec('ALTER TABLE mastery_events RENAME TO mastery_events_offline');
  await host.invoke('fsrs_get_due', {});
  expect(logs).toEqual([]);
  expect(pendingRow()!.revert).toBe(1);
  vfs.exec('ALTER TABLE mastery_events_offline RENAME TO mastery_events');
});

it('review_service_exposes_agent_scopes_and_review_statistics', async () => {
  const { db, host } = await setup();
  insertTaskAndCard(db, 'doc-service', 'task-service', 'card-service');
  db.run(`UPDATE document_tasks SET source_session_id = 'session-service' WHERE id = 'task-service'`);
  const service = host.ctx.review;
  const enqueued = service.enqueueCardsForSession(
    ['card-service'], 'session-service', 'doc-service',
  );
  expect(enqueued.enqueued).toBe(1);
  const sessionStates = service.getReviewStatesForSession(['card-service'], 'session-service');
  expect(sessionStates.map(state => state.ankiCardId)).toEqual(['card-service']);
  const libraryStates = service.getReviewStatesForLibrary('library', ['card-service']);
  expect(libraryStates.map(state => state.ankiCardId)).toEqual(['card-service']);
  const statistics = service.getReviewStatistics(7);
  expect(statistics.days).toBe(7);
  expect(statistics.dailyLimits.newPerDay).toBeGreaterThan(0);
});

it('scheduler_config_null_fields_are_noops_like_rust_option_none', async () => {
  const { host } = await setup();
  const before = await host.invoke<Record<string, unknown>>('fsrs_get_scheduler_config', {});
  const update = {
    learnAheadMinutes: null, newPerDay: null, reviewsPerDay: null,
    desiredRetention: null, leechThreshold: null, leechAction: null,
    enableFuzz: null, learningSteps: null, relearningSteps: null,
    maximumInterval: null, dayRolloverHour: null, fsrsParams: null,
    buryNewSiblings: null, buryReviewSiblings: null, reviewOrder: null,
    newReviewOrder: null, maxAnswerSeconds: null,
  };
  const after = await host.invoke<Record<string, unknown>>(
    'fsrs_update_scheduler_config', { update },
  );
  expect(after).toEqual(before);
});

it('scheduler_config_fsrs_params_reach_the_wire_as_shortest_f32_decimals', async () => {
  const { host } = await setup();
  const params = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722,
    0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729];
  const updated = await host.invoke<{ fsrsParams: number[] }>(
    'fsrs_update_scheduler_config', { update: { fsrsParams: params } },
  );
  expect(updated.fsrsParams).toEqual(params);
  const read = await host.invoke<{ fsrsParams: number[] }>('fsrs_get_scheduler_config', {});
  expect(JSON.stringify(read.fsrsParams)).toBe(JSON.stringify(params));
});

it('fsrs_scheduler_config_commands_round_trip', async () => {
  const { host } = await setup();
  const defaults = await host.invoke<{ newPerDay: number; learningSteps: number[] }>(
    'fsrs_get_scheduler_config', {},
  );
  expect(defaults.learningSteps).toEqual([1, 10]);
  const updated = await host.invoke<{ newPerDay: number; leechAction: string }>(
    'fsrs_update_scheduler_config', { update: { newPerDay: 7, leechAction: 'mark' } },
  );
  expect(updated.newPerDay).toBe(7);
  expect(updated.leechAction).toBe('mark');
});
