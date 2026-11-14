import './local-runtime-fixture.ts';
import { describe, expect, it } from 'vitest';
import type { CoordinatedDatabaseName, StorageService } from '../../../platform/storage/api.ts';
import type { PathsService } from '../../../platform/paths/api.ts';
import type { EngineChange } from '../src/change-payload.ts';
import { serializeSyncChange } from '../src/change-payload.ts';
import { retryAllQuarantine, retryQuarantine } from '../src/quarantine-commands.ts';
import { ensureQuarantineTable, stableSyncValueHash, syncPayloadHash } from '../repository/quarantine.ts';
import { openTestDatabase, type TestDatabase } from './test-db.ts';

const suite = describe;

function storageFor(db: TestDatabase): StorageService {
  return {
    pathOf: (name: CoordinatedDatabaseName) => (name === 'vfs' ? '/tmp' : `/nonexistent/${name}.db`),
    openFile: () => db,
    close: () => undefined,
  } as unknown as StorageService;
}

const paths = { deviceId: async () => 'device-local' } as unknown as PathsService;

function createDb(): TestDatabase {
  const db = openTestDatabase();
  db.exec(`
    CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
    );
    CREATE TABLE notes (
        id TEXT PRIMARY KEY,
        title TEXT,
        updated_at TEXT,
        local_version INTEGER DEFAULT 0
    );
  `);
  ensureQuarantineTable(db);
  return db;
}

function change(overrides: Partial<EngineChange> = {}): EngineChange {
  return {
    table_name: 'notes',
    record_id: 'note-1',
    operation: 'Update',
    data: { id: 'note-1', title: 'cloud', updated_at: '2026-01-02T00:00:00Z' },
    changed_at: '2026-01-02T00:00:00Z',
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: 'device-remote',
    source_seq: 7,
    ...overrides,
  };
}

function seedQuarantine(
  db: TestDatabase,
  engineChange: EngineChange,
  options: { payloadHash?: string; baselineHash?: string; payloadJson?: string } = {},
): number {
  const payloadJson = options.payloadJson ?? serializeSyncChange(engineChange);
  const payloadHash = options.payloadHash ?? syncPayloadHash(payloadJson);
  const result = db.run(
    `INSERT INTO __sync_quarantine
     (source_device_id, source_seq, table_name, record_id, operation,
      payload_json, payload_hash, baseline_json, baseline_hash, error)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, 'seed')`,
    [
      engineChange.source_device_id ?? 'download:unknown',
      engineChange.source_seq ?? 0,
      engineChange.table_name,
      engineChange.record_id,
      engineChange.operation.toUpperCase(),
      payloadJson,
      payloadHash,
      options.baselineHash ?? stableSyncValueHash(null),
    ],
  );
  return Number(result.lastInsertRowid);
}

suite('quarantine commands', () => {
  it('retry_quarantine_applies_valid_payload_and_clears_entry', async () => {
    const db = createDb();
    const id = seedQuarantine(db, change());

    const applied = await retryQuarantine(storageFor(db), paths, 'vfs', id);

    expect(applied).toBe(true);
    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('cloud');
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_quarantine'))).toBe(0);
  });

  it('retry_quarantine_returns_false_for_missing_entry', async () => {
    const db = createDb();
    expect(await retryQuarantine(storageFor(db), paths, 'vfs', 999)).toBe(false);
    await expect(retryQuarantine(storageFor(db), paths, 'nope', 1)).rejects.toThrow('未知数据库: nope');
  });

  it('retry_quarantine_rejects_payload_hash_mismatch_without_writing', async () => {
    const db = createDb();
    const id = seedQuarantine(db, change(), { payloadHash: 'bad' });

    const applied = await retryQuarantine(storageFor(db), paths, 'vfs', id);

    expect(applied).toBe(false);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM notes'))).toBe(0);
    expect(db.pluck<string>('SELECT error FROM __sync_quarantine WHERE id = ?1', [id]))
      .toBe('payload hash 缺失或校验失败');
    expect(Number(db.pluck<number>('SELECT attempts FROM __sync_quarantine WHERE id = ?1', [id]))).toBe(2);
  });

  it('retry_quarantine_baseline_mismatch_preserves_both_sides_as_conflict', async () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'local-new', '2026-01-03T00:00:00Z')");
    const id = seedQuarantine(db, change(), { baselineHash: 'stale-baseline' });

    const handled = await retryQuarantine(storageFor(db), paths, 'vfs', id);

    expect(handled).toBe(true);
    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('local-new');
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_quarantine'))).toBe(0);
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id = 'note-1' AND resolved_at IS NULL",
    ))).toBe(2);
  });

  it('retry_quarantine_conflict_guard_preserves_unsynced_local_and_records_both_sides', async () => {
    const db = createDb();
    db.run("INSERT INTO notes (id, title, updated_at) VALUES ('note-1', 'local', '2026-01-01T00:00:00Z')");
    db.run(
      "INSERT INTO __change_log (table_name, record_id, operation, sync_version) VALUES ('notes', 'note-1', 'UPDATE', 0)",
    );
    const id = seedQuarantine(db, change());

    const applied = await retryQuarantine(storageFor(db), paths, 'vfs', id);

    expect(applied).toBe(true);
    // 本地时间戳更新 → KeepLatest 本地胜，云端败方留档。
    expect(db.pluck<string>('SELECT title FROM notes WHERE id = ?1', ['note-1'])).toBe('local');
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id = 'note-1' AND side = 'cloud' AND resolved_at IS NULL",
    ))).toBe(1);
  });

  it('retry_all_quarantine_reports_success_and_failures_per_entry', async () => {
    const db = createDb();
    seedQuarantine(db, change());
    seedQuarantine(db, change({ record_id: 'note-2' }), { payloadHash: 'bad' });

    const result = await retryAllQuarantine(storageFor(db), paths);
    expect(result.success).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/重试后仍未能应用/);
  });
});
