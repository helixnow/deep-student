/** D1 anki_decks owner seam: published functions, real migrated DB, caller transaction. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { ensureDefaultFsrsDeckWithConn, writeFsrsDeckConfigWithConn } from '../api.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

let env: AnkiTestEnv;
beforeAll(async () => { env = await createAnkiTestEnv({ withReview: false }); });
afterAll(async () => { await env.dispose(); });
beforeEach(() => { env.storage.database('mistakes').run('DELETE FROM anki_decks'); });

it('ensure_default_deck inserts exact Rust defaults but does not reset existing or tombstoned rows', () => {
  const db = env.storage.database('mistakes');
  ensureDefaultFsrsDeckWithConn(db, 'N1');
  expect(db.get('SELECT id, name, description, config_json, created_at, updated_at, local_version, deleted_at FROM anki_decks'))
    .toEqual({
      id: 'deck_default', name: 'Default', description: 'Default flashcard deck for FSRS reviews',
      config_json: '{"desired_retention":0.9}', created_at: 'N1', updated_at: 'N1', local_version: 0, deleted_at: null,
    });
  writeFsrsDeckConfigWithConn(db, 'deck_default', '{"custom":"keep"}', 'N2');
  const existing = db.get('SELECT * FROM anki_decks');
  ensureDefaultFsrsDeckWithConn(db, 'N3');
  expect(db.get('SELECT * FROM anki_decks')).toEqual(existing);
  db.run("UPDATE anki_decks SET deleted_at = 'N4' WHERE id = 'deck_default'");
  const tombstone = db.get('SELECT * FROM anki_decks');
  ensureDefaultFsrsDeckWithConn(db, 'N5');
  writeFsrsDeckConfigWithConn(db, 'deck_default', '{}', 'N5');
  expect(db.get('SELECT * FROM anki_decks')).toEqual(tombstone);
});

it('config update preserves caller JSON bytes, increments even for equal content, and ignores missing rows', () => {
  const db = env.storage.database('mistakes');
  ensureDefaultFsrsDeckWithConn(db, 'N1');
  const json = '{ "desired_retention": 0.8, "other": true }';
  writeFsrsDeckConfigWithConn(db, 'deck_default', json, 'N2');
  writeFsrsDeckConfigWithConn(db, 'deck_default', json, 'N3');
  expect(db.get('SELECT config_json, updated_at, created_at, local_version FROM anki_decks')).toEqual({
    config_json: json, updated_at: 'N3', created_at: 'N1', local_version: 2,
  });
  writeFsrsDeckConfigWithConn(db, 'missing', '{}', 'N4');
  expect(db.pluck('SELECT COUNT(*) FROM anki_decks')).toBe(1);
});

it('both statements use the caller transaction and roll back with its other writes', () => {
  const db = env.storage.database('mistakes');
  expect(() => db.transaction((tx) => {
    ensureDefaultFsrsDeckWithConn(tx, 'N1');
    writeFsrsDeckConfigWithConn(tx, 'deck_default', '{"rollback":true}', 'N2');
    expect(tx.get('SELECT config_json, local_version FROM anki_decks')).toEqual({
      config_json: '{"rollback":true}', local_version: 1,
    });
    throw new Error('caller rollback');
  }, { behavior: 'immediate' })).toThrow('caller rollback');
  expect(db.pluck('SELECT COUNT(*) FROM anki_decks')).toBe(0);
});

it('storage failures propagate unwrapped for the L15 Database error prefix', () => {
  const db = env.storage.database('mistakes');
  db.exec(`CREATE TEMP TRIGGER reject_anki_deck_insert BEFORE INSERT ON anki_decks
    BEGIN SELECT RAISE(ABORT, 'deck insert denied'); END`);
  try {
    expect(() => ensureDefaultFsrsDeckWithConn(db, 'N1')).toThrow(/^deck insert denied$/);
  } finally {
    db.exec('DROP TRIGGER reject_anki_deck_insert');
  }
  ensureDefaultFsrsDeckWithConn(db, 'N1');
  db.exec(`CREATE TEMP TRIGGER reject_anki_deck_update BEFORE UPDATE ON anki_decks
    BEGIN SELECT RAISE(ABORT, 'deck update denied'); END`);
  try {
    expect(() => writeFsrsDeckConfigWithConn(db, 'deck_default', '{}', 'N2')).toThrow(/^deck update denied$/);
    expect(db.get('SELECT config_json, local_version FROM anki_decks')).toEqual({
      config_json: '{"desired_retention":0.9}', local_version: 0,
    });
  } finally {
    db.exec('DROP TRIGGER reject_anki_deck_update');
  }
});
