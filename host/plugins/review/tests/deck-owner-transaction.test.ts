import { setImmediate } from 'node:timers/promises';
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
  await setImmediate();
});

it('sw_anki_decks_ensure_uses_the_enqueue_transaction_and_keeps_rust_default_fields', async () => {
  const { db, host } = await setup();
  db.run("DELETE FROM anki_decks WHERE id = 'deck_default'");
  db.run(`INSERT INTO document_tasks (id, document_id, original_document_name, segment_index,
    content_segment, status, anki_generation_options_json)
    VALUES ('task-deck-owner', 'doc-deck-owner', 'deck.md', 0, 'segment', 'Completed', '{}')`);
  db.run(`INSERT INTO anki_cards (id, task_id, front, back, source_type, source_id)
    VALUES ('card-deck-owner', 'task-deck-owner', 'front', 'back', 'document', 'doc-deck-owner')`);
  // The default insert must roll back with a later FSRS insert failure, not commit separately.
  db.exec(`CREATE TRIGGER block_fsrs_insert BEFORE INSERT ON fsrs_card_states
    BEGIN SELECT RAISE(ABORT, 'FSRS insert blocked'); END`);
  await expect(host.invoke('fsrs_enqueue_cards', { ankiCardIds: ['card-deck-owner'] })).rejects.toMatchObject({
    error_type: 'Database', message: expect.stringContaining('FSRS insert blocked'),
  });
  expect(db.pluck("SELECT COUNT(*) FROM anki_decks WHERE id = 'deck_default'")).toBe(0);
  expect(db.pluck('SELECT COUNT(*) FROM fsrs_card_states')).toBe(0);
  db.exec('DROP TRIGGER block_fsrs_insert');
  await host.invoke('fsrs_enqueue_cards', { ankiCardIds: ['card-deck-owner'] });
  const deck = db.get("SELECT * FROM anki_decks WHERE id = 'deck_default'")!;
  expect(deck).toMatchObject({ id: 'deck_default', name: 'Default',
    description: 'Default flashcard deck for FSRS reviews', config_json: '{"desired_retention":0.9}',
    local_version: 0, deleted_at: null });
  expect(deck.created_at).toBe(deck.updated_at);
});

it('sw_anki_decks_config_write_shares_ensure_transaction_and_preserves_error_prefixes', async () => {
  const { db, host } = await setup();
  db.run("DELETE FROM anki_decks WHERE id = 'deck_default'");
  db.exec(`CREATE TRIGGER block_deck_insert BEFORE INSERT ON anki_decks
    BEGIN SELECT RAISE(ABORT, 'deck insert blocked'); END`);
  await expect(host.invoke('fsrs_update_scheduler_config', { update: { newPerDay: 7 } })).rejects.toMatchObject({
    error_type: 'Database', message: '确保默认牌组失败: deck insert blocked',
  });
  db.exec('DROP TRIGGER block_deck_insert');
  db.exec(`CREATE TRIGGER block_deck_config BEFORE UPDATE OF config_json ON anki_decks
    BEGIN SELECT RAISE(ABORT, 'deck config blocked'); END`);
  await expect(host.invoke('fsrs_update_scheduler_config', { update: { newPerDay: 7 } })).rejects.toMatchObject({
    error_type: 'Database', message: '写入牌组调度配置失败: deck config blocked',
  });
  expect(db.pluck("SELECT COUNT(*) FROM anki_decks WHERE id = 'deck_default'")).toBe(0);
  db.exec('DROP TRIGGER block_deck_config');
  await host.invoke('fsrs_update_scheduler_config', { update: { newPerDay: 7 } });
  expect(db.get("SELECT config_json, local_version FROM anki_decks WHERE id = 'deck_default'"))
    .toEqual({ config_json: '{"desired_retention":0.9,"new_per_day":7}', local_version: 1 });
});

it('sw_anki_decks_config_retains_existing_fields_exact_sql_version_and_deleted_filter', async () => {
  const { db, host } = await setup();
  await host.invoke('fsrs_update_scheduler_config', { update: { newPerDay: 5 } });
  db.run(`UPDATE anki_decks SET name = 'keep name', description = 'keep description',
    config_json = '{"desired_retention":0.85,"custom":"keep","newPerDay":5}',
    created_at = 'original-created', local_version = ?1 WHERE id = 'deck_default'`, [9007199254740993n]);
  await host.invoke('fsrs_update_scheduler_config', { update: { newPerDay: 9 } });
  const row = db.get(`SELECT name, description, config_json, created_at,
    CAST(local_version AS TEXT) AS version FROM anki_decks WHERE id = 'deck_default'`)!;
  expect(row).toMatchObject({ name: 'keep name', description: 'keep description',
    created_at: 'original-created', version: '9007199254740994' });
  expect(JSON.parse(String(row.config_json))).toEqual({ desired_retention: 0.85, custom: 'keep', new_per_day: 9 });

  db.run("UPDATE anki_decks SET deleted_at = 'deleted-marker' WHERE id = 'deck_default'");
  const deletedRow = () => db.get("SELECT *, CAST(local_version AS TEXT) AS exactVersion FROM anki_decks WHERE id = 'deck_default'");
  const before = deletedRow();
  await host.invoke('fsrs_update_scheduler_config', { update: { newPerDay: 12 } });
  // INSERT OR IGNORE must not resurrect the row, and UPDATE excludes deleted rows.
  expect(deletedRow()).toEqual(before);
});
