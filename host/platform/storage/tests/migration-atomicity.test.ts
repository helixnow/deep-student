import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { Migration, Runner } from '../migration/refinery-core.ts';

it.each([false, true])('preserves todo_items when decoupling todo_lists with foreign_keys enabled (grouped=%s)', grouped => {
  const conn = new Connection(':memory:', { label: 'todo-rebuild', profile: PROFILES.plain });
  const migration = (stem: string) => Migration.unapplied(stem, readFileSync(join(import.meta.dirname, '../../../../resources/app/migrations/vfs', `${stem}.sql`), 'utf8'));
  const initial = migration('V20260308__add_todo_tables');
  const decouple = migration('V20260309__decouple_todo_from_vfs');
  try {
    conn.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE resources(id TEXT PRIMARY KEY, source_table TEXT);
      CREATE TABLE folder_items(item_type TEXT);
      INSERT INTO resources VALUES ('r', 'todo_lists');`);
    new Runner([initial]).run(conn);
    conn.exec(`INSERT INTO todo_lists(id, resource_id, title, created_at, updated_at) VALUES ('l', 'r', 'list', 'now', 'now');
      INSERT INTO todo_items(id, todo_list_id, title, created_at, updated_at) VALUES ('i', 'l', 'keep me', 'now', 'now');
      INSERT INTO todo_items(id, todo_list_id, parent_id, title, created_at, updated_at) VALUES ('child', 'l', 'i', 'keep child', 'now', 'now');`);
    new Runner([initial, decouple], { grouped }).run(conn);
    expect(conn.all('SELECT id, parent_id FROM todo_items ORDER BY id')).toEqual([{ id: 'child', parent_id: 'i' }, { id: 'i', parent_id: null }]);
    expect(conn.pragmaValue('foreign_keys')).toBe(1);
    expect(conn.all('PRAGMA foreign_key_check')).toEqual([]);
  } finally { conn.close(); }
});

it('rolls back migration SQL if its history insert fails', () => {
  const conn = new Connection(':memory:', { label: 'atomic-history', profile: PROFILES.plain });
  try {
    const runner = new Runner([Migration.unapplied('V1__create_t', 'CREATE TABLE t(id INTEGER);')]);
    runner.getUnappliedMigrations(conn);
    conn.exec(`CREATE TRIGGER reject_history BEFORE INSERT ON refinery_schema_history BEGIN SELECT RAISE(ABORT, 'history failed'); END;`);
    expect(() => runner.run(conn)).toThrow('history failed');
    expect(conn.pluck("SELECT COUNT(*) FROM sqlite_master WHERE name = 't'")).toBe(0);
    expect(conn.pluck('SELECT COUNT(*) FROM refinery_schema_history')).toBe(0);
  } finally { conn.close(); }
});

it('rolls back invalid table rebuilds and restores the previous foreign_keys state', () => {
  const conn = new Connection(':memory:', { label: 'invalid-rebuild', profile: PROFILES.plain });
  try {
    conn.exec(`PRAGMA foreign_keys = ON; CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(id INTEGER REFERENCES parent(id) ON DELETE CASCADE);
      INSERT INTO parent VALUES (1); INSERT INTO child VALUES (1);`);
    const runner = new Runner([Migration.unapplied('V1__rebuild', 'DROP TABLE parent; CREATE TABLE parent(id INTEGER PRIMARY KEY);')]);
    expect(() => runner.run(conn)).toThrow('foreign_key_check');
    expect(conn.all('SELECT * FROM parent')).toEqual([{ id: 1 }]);
    expect(conn.all('SELECT * FROM child')).toEqual([{ id: 1 }]);
    expect(conn.pragmaValue('foreign_keys')).toBe(1);
  } finally { conn.close(); }
});
