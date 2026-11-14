import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import {
  BrowserDatabase, CURRENT_SCHEMA_VERSION, DATABASE_FILENAME,
} from '../src/database.ts';
import { BrowserFailure } from '../src/error.ts';

describe('crates/dstu-browser/src/browser/database.rs::tests', { timeout: 60_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let db: BrowserDatabase;

  function setup(): void {
    root = mkdtempSync(join(tmpdir(), 'browser-database-'));
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    db = new BrowserDatabase(storage);
  }

  beforeEach(setup);

  afterEach(() => {
    storage.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('new_does_not_create_file', () => {
    expect(db.isOpen()).toBe(false);
    expect(existsSync(join(root, DATABASE_FILENAME))).toBe(false);
    expect(existsSync(db.dbPath())).toBe(false);
    expect(db.getSchemaVersion()).toBe(0);
  });

  it('ensure_open_creates_and_migrates', () => {
    db.ensureOpen();
    expect(db.isOpen()).toBe(true);
    expect(existsSync(db.dbPath())).toBe(true);
    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.isForeignKeysEnabled()).toBe(true);

    db.ensureOpen();
    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('tables_exist_after_migrate', () => {
    db.ensureOpen();
    const conn = db.getConn();
    for (const table of ['sessions', 'history', 'downloads', 'site_permissions', 'settings']) {
      const count = conn.pluck<number>(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [table],
      );
      expect(count, `missing table ${table}`).toBe(1);
    }
  });

  it('try_get_conn_before_open_fails', () => {
    expect(() => db.tryGetConn()).toThrow(BrowserFailure);
    try {
      db.tryGetConn();
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserFailure);
      expect((error as BrowserFailure).error.kind).toBe('NotOpen');
    }
  });

  it('close_releases_pool', () => {
    db.ensureOpen();
    db.close();
    expect(db.isOpen()).toBe(false);
    expect(existsSync(db.dbPath())).toBe(true);
    db.ensureOpen();
    expect(db.isOpen()).toBe(true);
  });

  it('wal_mode_enabled', () => {
    db.ensureOpen();
    const mode = db.getConn().pluck<string>('PRAGMA journal_mode');
    expect(mode?.toLowerCase()).toBe('wal');
  });
});

describe('browser database helpers beyond the Rust unit tests', { timeout: 60_000 }, () => {
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let db: BrowserDatabase;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'browser-database-'));
    storage = createStorageService({ baseDir: root, dataLocalDir: root });
    db = new BrowserDatabase(storage);
  });
  afterEach(() => {
    storage.dispose();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the active directory and reopens after close', () => {
    expect(db.activeDir()).toBe(storage.locations.activeDir);
    db.ensureOpen();
    expect(db.getSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
    expect(() => db.tryGetConn()).toThrow(BrowserFailure);
    expect(db.getConn().pluck('SELECT 1')).toBe(1);
  });
});
