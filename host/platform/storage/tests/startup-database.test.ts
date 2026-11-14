import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageError } from '../api.ts';
import { openStartupDatabase, syncStateDatabasePath, type StartupDatabase } from '../node.ts';

let dir: string;
const handles: StartupDatabase[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-startup-database-'));
});
afterEach(() => {
  for (const db of handles.splice(0)) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function open(): StartupDatabase {
  const db = openStartupDatabase(syncStateDatabasePath(dir));
  handles.push(db);
  return db;
}

describe('openStartupDatabase (pre-storage seam)', () => {
  it('opens the given file with PROFILES.sync_state PRAGMAs and no business database', () => {
    const db = open();
    expect(db.path).toBe(syncStateDatabasePath(dir));
    expect(db.label).toBe('sync_state');
    expect(db.pluck<number>('PRAGMA synchronous')).toBe(2);
    expect(db.pluck<number>('PRAGMA busy_timeout')).toBe(5000);
    expect(db.pluck<string>('PRAGMA journal_mode')).toBe('delete');
    expect(db.pluck<number>('PRAGMA foreign_keys')).toBe(1);
    expect(fs.readdirSync(path.join(dir, 'deep-student', 'sync'))).toEqual(['sync_state.db']);
  });

  it('exposes SqlExecutor rows plus begin()/commit()/rollback()/close() with rusqlite semantics', () => {
    const db = open();
    db.exec('CREATE TABLE consume_cursor (id INTEGER PRIMARY KEY, value TEXT)');
    db.run('INSERT INTO consume_cursor (value) VALUES (?)', ['kept']);

    db.begin();
    expect(db.inTransaction).toBe(true);
    db.run('INSERT INTO consume_cursor (value) VALUES (?)', ['rolled-back']);
    db.rollback();
    expect(db.inTransaction).toBe(false);
    expect(db.all<{ value: string }>('SELECT value FROM consume_cursor ORDER BY id')).toEqual([{ value: 'kept' }]);

    db.begin('deferred');
    db.run('DELETE FROM consume_cursor');
    db.commit();
    expect(db.pluck<number>('SELECT COUNT(*) FROM consume_cursor')).toBe(0);

    expect(() => db.one('SELECT value FROM consume_cursor')).toThrowError(StorageError);
    try {
      db.one('SELECT value FROM consume_cursor');
    } catch (error) {
      expect(error).toMatchObject({ code: 'NO_ROWS', message: 'Query returned no rows' });
    }

    db.close();
    expect(() => db.run('SELECT 1')).toThrow();
    db.close();
  });
});
