import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { toWireJson } from '../../../kernel/json.ts';
import review from '../index.ts';
import { mistakesFixture } from './storage.ts';

const fixtures: ReturnType<typeof mistakesFixture>[] = [];
const hosts: Awaited<ReturnType<typeof createTestHost>>[] = [];
const card = 'card-d3-version', session = 'session-d3-version';
const I64_MAX = 9223372036854775807n;

async function setup(version: bigint) {
  const fixture = mistakesFixture();
  fixtures.push(fixture);
  const { db, storage } = fixture;
  const vfs = storage.database('vfs');
  vfs.exec('CREATE TABLE __change_log (table_name TEXT, record_id TEXT, operation TEXT, changed_at TEXT)');
  for (const name of ['V20260718__add_mastery_tables.sql', 'V20260719__mastery_events_signal.sql',
    'V20260720__mastery_events_sync.sql', 'V20260909__mastery_events_insight_source.sql']) {
    vfs.exec(readFileSync(`resources/app/migrations/vfs/${name}`, 'utf8'));
  }
  db.run(`INSERT INTO document_tasks (id, document_id, original_document_name, segment_index,
    content_segment, status, source_session_id, anki_generation_options_json)
    VALUES ('task-d3', 'doc-d3', 'version.md', 0, 'segment', 'Completed', ?1, '{}')`, [session]);
  db.run(`INSERT INTO anki_cards (id, task_id, front, back, source_type, source_id)
    VALUES (?1, 'task-d3', 'front', 'back', 'document', 'doc-d3')`, [card]);
  const host = await createTestHost({ plugins: [review], provide: { storage } });
  hosts.push(host);
  const svc = host.ctx.review;
  const initial = svc.enqueueCardsForSession([card], session, null).states[0]!;
  const { logId } = await host.invoke<{ logId: string }>('fsrs_rate', { cardStateId: initial.id, rating: 3 });
  db.run('UPDATE fsrs_card_states SET local_version = ?1 WHERE id = ?2', [version, initial.id]);
  const stateRow = () => db.get(`SELECT suspended, state, updated_at,
    CAST(local_version AS TEXT) AS version, typeof(local_version) AS versionType,
    last_review_ms FROM fsrs_card_states WHERE id = ?1`, [initial.id]);
  const logRow = () => db.get('SELECT * FROM fsrs_review_logs WHERE id = ?1', [logId]);
  return { db, svc, initial, logId, stateRow, logRow };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
  for (const fixture of fixtures.splice(0)) fixture.dispose();
  await setImmediate();
});

for (const version of [9007199254740993n, 9223372036854774784n]) {
  it(`l15_v2_s4_d3_suspension_cas_keeps_i64_${version}_exact_through_owner`, async () => {
    const { svc, initial, stateRow } = await setup(version);
    const before = svc.getReviewStatesForSession([card], session)[0]!;
    expect(before.reviewVersion).toBe(version);
    expect(svc.getReviewStatesForLibrary('library', [card])[0]!.reviewVersion).toBe(version);
    const row = stateRow();
    for (const stale of [version - 1n, version + 1n]) {
      expect(svc.setSuspendedForSession(card, session, stale, true)).toEqual({ status: 'conflict', current: before });
      expect(stateRow()).toEqual(row);
    }
    const updated = svc.setSuspendedForSession(card, session, version, true);
    expect(updated).toMatchObject({ status: 'updated', changed: true,
      state: { cardStateId: initial.id, suspended: true, reviewVersion: version + 1n } });
    expect(stateRow()).toMatchObject({ suspended: 1, version: String(version + 1n), versionType: 'integer' });
    expect(svc.setSuspendedForLibrary('library', card, version + 1n, true)).toMatchObject({
      status: 'updated', changed: false, state: { reviewVersion: version + 1n },
    });
    const resumed = svc.setSuspendedForLibrary('library', card, version + 1n, false);
    expect(resumed).toMatchObject({ status: 'updated', changed: true,
      state: { suspended: false, reviewVersion: version + 2n } });
    expect(stateRow()!.version).toBe(String(version + 2n));
    // Same outer conversion as Tauri JSON: rounding belongs here, never in owner storage/CAS.
    expect(toWireJson(before)).toMatchObject({ reviewVersion: Number(version) });
    expect(before.reviewVersion).toBe(version);
  });

  it(`l15_v2_s4_d3_undo_cas_keeps_i64_${version}_exact_through_owner`, async () => {
    const { svc, initial, logId, stateRow, logRow } = await setup(version);
    const before = svc.getReviewStatesForSession([card], session)[0]!;
    const row = stateRow(), log = logRow();
    expect(before.latestReview!.undoable).toBe(true);
    for (const stale of [version - 1n, version + 1n]) {
      expect(svc.undoLastReviewForSession(card, session, stale, logId)).toEqual({ status: 'conflict', current: before });
      expect(svc.undoLastReviewForLibrary('library', card, stale, logId)).toEqual({ status: 'conflict', current: before });
      expect(stateRow()).toEqual(row);
      expect(logRow()).toEqual(log);
    }
    expect(svc.undoLastReviewForLibrary('library', card, version, logId)).toMatchObject({
      status: 'updated', changed: true, state: { reviewVersion: version + 1n,
        state: initial.state, dueMs: initial.dueMs, lastReviewMs: initial.lastReviewMs, latestReview: null },
    });
    expect(stateRow()!.version).toBe(String(version + 1n));
    expect(logRow()!.deleted_at).not.toBeNull();
  });
}

it('l15_v2_s4_d3_i64_max_reads_and_noop_succeed_stale_conflicts_overflow_rolls_back_like_rust', async () => {
  const { svc, logId, stateRow, logRow } = await setup(I64_MAX);
  const current = svc.getReviewStatesForSession([card], session)[0]!;
  expect(current.reviewVersion).toBe(I64_MAX);
  const row = stateRow(), log = logRow();
  expect(svc.setSuspendedForSession(card, session, I64_MAX - 1n, true)).toEqual({ status: 'conflict', current });
  expect(svc.undoLastReviewForLibrary('library', card, I64_MAX - 1n, logId)).toEqual({ status: 'conflict', current });
  expect(svc.setSuspendedForLibrary('library', card, I64_MAX, false)).toEqual({ status: 'updated', changed: false, state: current });
  // Rust SQL does local_version + 1. SQLite promotes i64::MAX+1 to REAL; row.get::<i64>
  // then fails, so the owner transaction rolls back. Do not clamp/reject the valid input.
  for (const mutate of [
    () => svc.setSuspendedForSession(card, session, I64_MAX, true),
    () => svc.undoLastReviewForSession(card, session, I64_MAX, logId),
  ]) {
    expect(mutate).toThrow(/local_version has SQLite type real, expected integer/);
    expect(stateRow()).toEqual(row);
    expect(logRow()).toEqual(log);
    expect(svc.getReviewStatesForSession([card], session)[0]!.reviewVersion).toBe(I64_MAX);
  }
});
