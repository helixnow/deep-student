import './local-runtime-fixture.ts';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { triggerEvent, validateSyncRegistryDrift } from '../repository/registry-preflight.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function setup(sql: string) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-registry-'));
  const storage = createStorageService({ baseDir: dir, dataLocalDir: dir });
  const db = storage.openFile(storage.pathOf('vfs'), { profile: 'plain' });
  db.exec(`CREATE TABLE __change_log(id INTEGER PRIMARY KEY, table_name TEXT NOT NULL,
    record_id TEXT NOT NULL, operation TEXT NOT NULL, changed_at TEXT, sync_version INTEGER);`);
  db.exec(sql);
  storage.close(db);
  cleanup.push(() => { storage.dispose(); rmSync(dir, { recursive: true, force: true }); });
  return storage;
}

it('registry_drift_preflight_rejects_missing_row_sync_trigger', () => {
  const storage = setup('CREATE TABLE notes(id TEXT PRIMARY KEY, title TEXT, updated_at TEXT);');
  expect(() => validateSyncRegistryDrift(storage)).toThrow('vfs.notes 缺少 __change_log insert 触发器');
});

it('registry_drift_preflight_rejects_unregistered_change_log_trigger', () => {
  const storage = setup(`CREATE TABLE review_history(id TEXT PRIMARY KEY, updated_at TEXT);
    CREATE TRIGGER trg__change_log_review_history_insert AFTER INSERT ON review_history BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES ('review_history',NEW.id,'INSERT'); END;`);
  expect(() => validateSyncRegistryDrift(storage)).toThrow('vfs.review_history 存在 __change_log 触发器');
});

it('trigger_event_reads_the_header_regardless_of_whitespace', () => {
  const pin = "CREATE TRIGGER IF NOT EXISTS trg__change_log_note_document_revisions_pin\nAFTER UPDATE OF pinned ON note_document_revisions WHEN OLD.pinned != NEW.pinned BEGIN\n INSERT INTO __change_log(table_name) VALUES ('x');\nEND";
  expect(triggerEvent(pin)).toBe('update');
  expect(triggerEvent('CREATE TRIGGER t\tafter\tinsert ON x BEGIN SELECT 1; END')).toBe('insert');
  expect(triggerEvent('CREATE TRIGGER t INSTEAD OF DELETE ON v BEGIN SELECT 1; END')).toBe('delete');
  expect(triggerEvent('CREATE TRIGGER t BEGIN INSERT INTO __change_log VALUES (1); END')).toBeNull();
});

const revisionTable = `CREATE TABLE note_document_revisions(id TEXT PRIMARY KEY, note_id TEXT, pinned INTEGER DEFAULT 0, updated_at TEXT);
  CREATE TRIGGER trg__change_log_note_document_revisions_insert AFTER INSERT ON note_document_revisions BEGIN
  INSERT INTO __change_log(table_name,record_id,operation) VALUES ('note_document_revisions',NEW.id,'INSERT'); END;`;

it('registry_drift_preflight_accepts_the_production_pin_trigger_text', () => {
  const migration = readFileSync('resources/app/migrations/vfs/V20260924__note_editor_leases.sql', 'utf8');
  const start = migration.indexOf('CREATE TRIGGER IF NOT EXISTS trg__change_log_note_document_revisions_pin');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf('END;', start) + 'END;'.length;
  const pin = migration.slice(start, end);
  const storage = setup(revisionTable + pin);
  // The migration text is executed against SQLite, not asserted as source-lock coverage.
  expect(() => validateSyncRegistryDrift(storage)).not.toThrow();
});

it('registry_drift_preflight_allows_exempt_delete_and_update_of_trigger', () => {
  const storage = setup(revisionTable + `CREATE TRIGGER trg__change_log_note_document_revisions_pin
    AFTER UPDATE OF pinned ON note_document_revisions BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES ('note_document_revisions',NEW.id,'UPDATE'); END;`);
  expect(() => validateSyncRegistryDrift(storage)).not.toThrow();
});

it('registry_drift_preflight_update_of_counts_as_update_op', () => {
  const storage = setup(`CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT,pinned INTEGER DEFAULT 0,updated_at TEXT);
    CREATE TRIGGER trg__change_log_notes_insert AFTER INSERT ON notes BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES ('notes',NEW.id,'INSERT'); END;
    CREATE TRIGGER trg__change_log_notes_pin AFTER UPDATE OF pinned ON notes BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES ('notes',NEW.id,'UPDATE'); END;
    CREATE TRIGGER trg__change_log_notes_delete AFTER DELETE ON notes BEGIN
    INSERT INTO __change_log(table_name,record_id,operation) VALUES ('notes',OLD.id,'DELETE'); END;`);
  expect(() => validateSyncRegistryDrift(storage)).not.toThrow();
});

it('registry_drift_preflight_accepts_study_space_and_anchor_edge_triggers', () => {
  const migration = readFileSync('resources/app/migrations/vfs/V20261111__study_space_profiles_and_mounts.sql', 'utf8');
  const storage = setup(migration);
  expect(() => validateSyncRegistryDrift(storage)).not.toThrow();
});
