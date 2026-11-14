import { describe, expect, it } from 'vitest';
import type { EngineChange } from '../src/change-payload.ts';
import {
  applyDownloadedChanges,
  applyDownloadedChangesWithConflictGuard,
  changesAffectRefCounts,
  ensureIdAliasTable,
  foldSafeFieldMergeIntoLocal,
  recomputeBlobRefCounts,
  remapJsonEmbeddedIds,
  resolvePersistedIdAlias,
  sourceDeviceForQuarantine,
  sourceSeqForQuarantine,
  type IdAliasMap,
} from '../repository/apply.ts';
import { dedupeDownloadedChanges, getRecordData } from '../repository/record-data.ts';
import { isLocalDerivedSyncColumn, jsonValueToSqlParam, sqliteValueToJson } from '../repository/sqlite-values.ts';
import { quarantineChange, replayQuarantinedChanges } from '../repository/quarantine.ts';
import { openTestDatabase, type TestDatabase } from './test-db.ts';

const suite = describe;

function createTestDb(): TestDatabase {
  const db = openTestDatabase();
  db.exec(`
    CREATE TABLE test_records (
        id TEXT PRIMARY KEY,
        content TEXT,
        updated_at TEXT
    );
    CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
    );
  `);
  return db;
}

function change(overrides: Partial<EngineChange>): EngineChange {
  return {
    table_name: 'test_records',
    record_id: 'rec-1',
    operation: 'Insert',
    data: null,
    changed_at: '2024-01-01T10:00:00Z',
    change_log_id: null,
    database_name: null,
    suppress_change_log: null,
    source_device_id: null,
    source_seq: null,
    ...overrides,
  };
}

suite('apply downloaded changes', () => {
  it('does not resurrect a delete when its full-width source sequence ties an upsert', () => {
    const db = createTestDb();
    const context = { deviceId: 'device-local', allowSyncTestFixtureTables: true };
    const seq = 9007199254740993n;
    const deleted = change({ operation: 'Delete', source_device_id: 'peer', source_seq: seq });
    expect(applyDownloadedChanges(db, [deleted], context).failure_count).toBe(0);
    const replay = change({ source_device_id: 'peer', source_seq: seq,
      data: { id: 'rec-1', content: 'must stay deleted', updated_at: deleted.changed_at } });
    const result = applyDownloadedChanges(db, [replay], context);
    expect(result.success_count).toBe(0);
    expect(result.skipped_count).toBe(1);
    expect(db.pluck('SELECT COUNT(*) FROM test_records')).toBe(0);
  });
  it('test_apply_insert_with_data_none_is_skipped', () => {
    const db = createTestDb();
    const result = applyDownloadedChanges(db, [change({})], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(0);
    expect(result.skipped_count).toBe(1);
    expect(result.skipped_incomplete_count).toBe(1);
    expect(result.failure_count).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM test_records'))).toBe(0);
  });

  it('test_apply_update_with_data_none_is_skipped', () => {
    const db = createTestDb();
    db.run("INSERT INTO test_records (id, content) VALUES ('existing', 'original')");

    const result = applyDownloadedChanges(db, [
      change({ record_id: 'existing', operation: 'Update' }),
    ], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(0);
    expect(result.skipped_count).toBe(1);
    expect(result.skipped_incomplete_count).toBe(1);
    expect(result.failure_count).toBe(0);
    expect(db.pluck<string>('SELECT content FROM test_records WHERE id = ?1', ['existing']))
      .toBe('original');
  });

  it('test_apply_delete_without_data_succeeds', () => {
    const db = createTestDb();
    db.run("INSERT INTO test_records (id, content) VALUES ('to-delete', 'bye')");

    const result = applyDownloadedChanges(db, [
      change({ record_id: 'to-delete', operation: 'Delete' }),
    ], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(1);
    expect(result.skipped_count).toBe(0);
    expect(result.skipped_incomplete_count).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM test_records'))).toBe(0);
  });

  it('test_apply_mixed_data_none_and_valid', () => {
    const db = createTestDb();
    const result = applyDownloadedChanges(db, [
      change({ record_id: 'no-data' }),
      change({
        record_id: 'has-data',
        data: { id: 'has-data', content: 'valid', updated_at: '2024-01-01' },
        changed_at: '2024-01-01T10:00:01Z',
      }),
    ], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(1);
    expect(result.skipped_count).toBe(1);
    expect(result.skipped_incomplete_count).toBe(1);
    expect(result.failure_count).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM test_records'))).toBe(1);
  });

  function createNotesDb(): TestDatabase {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE notes (
          id TEXT PRIMARY KEY,
          tags TEXT,
          is_favorite INTEGER DEFAULT 0,
          updated_at TEXT
      );
      CREATE TABLE __change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now')),
          sync_version INTEGER DEFAULT 0
      );
    `);
    return db;
  }

  function insertPendingLog(db: TestDatabase, table: string, id: string): void {
    db.run(
      "INSERT INTO __change_log(table_name, record_id, operation, sync_version) VALUES(?1, ?2, 'UPDATE', 0)",
      [table, id],
    );
  }

  it('regression_m1_single_sided_remote_tag_delete_is_not_field_merged_back', () => {
    const db = createNotesDb();
    db.run(
      "INSERT INTO notes(id, tags, updated_at) VALUES(?1, ?2, ?3)",
      ['note-1', '["local"]', '2026-02-09T00:00:00Z'],
    );
    const result = applyDownloadedChanges(db, [change({
      table_name: 'notes',
      record_id: 'note-1',
      operation: 'Update',
      data: { id: 'note-1', tags: [], updated_at: '2026-02-10T00:00:00Z' },
      changed_at: '2026-02-10T00:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(1);
    expect(db.pluck<string>("SELECT tags FROM notes WHERE id='note-1'")).toBe('[]');
  });

  it('regression_m1_pending_local_change_allows_field_merge', () => {
    const db = createNotesDb();
    db.run(
      "INSERT INTO notes(id, tags, updated_at) VALUES(?1, ?2, ?3)",
      ['note-merge', '["local"]', '2026-02-09T00:00:00Z'],
    );
    insertPendingLog(db, 'notes', 'note-merge');

    const result = applyDownloadedChanges(db, [change({
      table_name: 'notes',
      record_id: 'note-merge',
      operation: 'Update',
      data: { id: 'note-merge', tags: ['remote'], updated_at: '2026-02-10T00:00:00Z' },
      changed_at: '2026-02-10T00:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(1);
    expect(db.pluck<string>("SELECT tags FROM notes WHERE id='note-merge'"))
      .toBe('["local","remote"]');
  });

  it('regression_r02_conflict_guard_merges_tags_union_when_cloud_wins', () => {
    const db = createNotesDb();
    db.run(
      "INSERT INTO notes(id, tags, is_favorite, updated_at) VALUES(?1, ?2, 0, ?3)",
      ['note-r02', '["local"]', '2026-02-09T00:00:00Z'],
    );
    insertPendingLog(db, 'notes', 'note-r02');

    const result = applyDownloadedChangesWithConflictGuard(db, [change({
      table_name: 'notes',
      record_id: 'note-r02',
      operation: 'Update',
      data: { id: 'note-r02', tags: ['remote'], is_favorite: 1, updated_at: '2026-02-10T00:00:00Z' },
      changed_at: '2026-02-10T00:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-cloud',
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true }, {
      policy: 'KeepLatest',
      cloudDeviceId: 'device-cloud',
      localDeviceId: 'device-local',
    });

    expect(result.apply.success_count).toBe(1);
    expect(result.conflict.conflicts_saved).toBeGreaterThan(0);
    expect(db.pluck<string>("SELECT tags FROM notes WHERE id='note-r02'"))
      .toBe('["local","remote"]');
    expect(Number(db.pluck<number>("SELECT is_favorite FROM notes WHERE id='note-r02'"))).toBe(1);
  });

  it('regression_r02_conflict_guard_folds_safe_fields_when_local_wins', () => {
    const db = createNotesDb();
    db.run(
      "INSERT INTO notes(id, tags, is_favorite, updated_at) VALUES(?1, ?2, 0, ?3)",
      ['note-r02', '["local"]', '2026-02-10T00:00:00Z'],
    );
    insertPendingLog(db, 'notes', 'note-r02');

    const result = applyDownloadedChangesWithConflictGuard(db, [change({
      table_name: 'notes',
      record_id: 'note-r02',
      operation: 'Update',
      data: { id: 'note-r02', tags: ['remote'], is_favorite: 1, updated_at: '2026-02-09T00:00:00Z' },
      changed_at: '2026-02-09T00:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-cloud',
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true }, {
      policy: 'KeepLatest',
      cloudDeviceId: 'device-cloud',
      localDeviceId: 'device-local',
    });

    expect(result.apply.success_count).toBe(0);
    expect(result.conflict.rejected).toBe(1);
    expect(db.pluck<string>("SELECT tags FROM notes WHERE id='note-r02'"))
      .toBe('["local","remote"]');
    expect(Number(db.pluck<number>("SELECT is_favorite FROM notes WHERE id='note-r02'"))).toBe(1);
    expect(db.pluck<string>("SELECT updated_at FROM notes WHERE id='note-r02'"))
      .toBe('2026-02-10T00:00:00Z');
  });

  it('regression_r04_keep_local_policy_does_not_fold_safe_fields', () => {
    const db = createNotesDb();
    db.run(
      "INSERT INTO notes(id, tags, is_favorite, updated_at) VALUES(?1, ?2, 0, ?3)",
      ['note-r02', '["local"]', '2026-02-10T00:00:00Z'],
    );
    insertPendingLog(db, 'notes', 'note-r02');

    const result = applyDownloadedChangesWithConflictGuard(db, [change({
      table_name: 'notes',
      record_id: 'note-r02',
      operation: 'Update',
      data: { id: 'note-r02', tags: ['remote'], is_favorite: 1, updated_at: '2026-02-11T00:00:00Z' },
      changed_at: '2026-02-11T00:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-cloud',
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true }, {
      policy: 'KeepLocal',
      cloudDeviceId: 'device-cloud',
      localDeviceId: 'device-local',
    });

    expect(result.apply.success_count).toBe(0);
    expect(result.conflict.rejected).toBe(1);
    expect(db.pluck<string>("SELECT tags FROM notes WHERE id='note-r02'")).toBe('["local"]');
    expect(Number(db.pluck<number>("SELECT is_favorite FROM notes WHERE id='note-r02'"))).toBe(0);
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE table_name='notes' AND record_id='note-r02' AND side='cloud'",
    ))).toBeGreaterThan(0);
  });

  it('regression_r04_fold_skips_semantically_equal_local_values', () => {
    const db = createNotesDb();
    db.run(
      "INSERT INTO notes(id, tags, is_favorite, updated_at) VALUES(?1, ?2, 0, ?3)",
      ['note-r02', '["local","remote"]', '2026-02-10T00:00:00Z'],
    );
    const base = change({
      table_name: 'notes',
      record_id: 'note-r02',
      operation: 'Update',
      data: { id: 'note-r02', tags: ['remote'], updated_at: '2026-02-09T00:00:00Z' },
      changed_at: '2026-02-09T00:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-cloud',
    });

    const folded = foldSafeFieldMergeIntoLocal(db, base, 'KeepLatest');
    expect(folded).toBe(false);
    expect(db.pluck<string>("SELECT tags FROM notes WHERE id='note-r02'")).toBe('["local","remote"]');

    const withNewTag = { ...base, data: { id: 'note-r02', tags: ['extra'], updated_at: '2026-02-09T00:00:00Z' } };
    const foldedAgain = foldSafeFieldMergeIntoLocal(db, withNewTag, 'KeepLatest');
    expect(foldedAgain).toBe(true);
    expect(db.pluck<string>("SELECT tags FROM notes WHERE id='note-r02'")).toBe('["extra","local","remote"]');
  });

  it('regression_r02_stale_delete_without_tombstone_is_rejected', () => {
    const db = createTestDb();
    db.run(
      'INSERT INTO test_records(id, content, updated_at) VALUES(?1, ?2, ?3)',
      ['delete-version-record', 'newer-local', '2026-07-10T13:00:00Z'],
    );
    const staleDelete = change({
      record_id: 'delete-version-record',
      operation: 'Delete',
      changed_at: '2026-07-10T12:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-slow',
      source_seq: 1,
    });
    const result = applyDownloadedChangesWithConflictGuard(db, [staleDelete], { deviceId: 'device-local', allowSyncTestFixtureTables: true }, {
      policy: 'KeepLatest',
      cloudDeviceId: 'device-slow',
      localDeviceId: 'device-local',
    });
    expect(result.apply.success_count).toBe(0);
    expect(result.apply.skipped_count).toBe(1);
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM test_records WHERE id='delete-version-record'",
    ))).toBe(1);

    const freshDelete = change({
      record_id: 'delete-version-record',
      operation: 'Delete',
      changed_at: '2026-07-10T14:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-fresh',
      source_seq: 2,
    });
    const fresh = applyDownloadedChangesWithConflictGuard(db, [freshDelete], { deviceId: 'device-local', allowSyncTestFixtureTables: true }, {
      policy: 'KeepLatest',
      cloudDeviceId: 'device-fresh',
      localDeviceId: 'device-local',
    });
    expect(fresh.apply.success_count).toBe(1);
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM test_records WHERE id='delete-version-record'",
    ))).toBe(0);
  });

  it('regression_r02_slow_clock_stale_upsert_is_visible_in_conflicts', () => {
    const db = createTestDb();
    db.run(
      'INSERT INTO test_records(id, content, updated_at) VALUES(?1, ?2, ?3)',
      ['delete-version-record', 'newer-local', '2026-07-10T13:00:00Z'],
    );
    const staleUpsert = change({
      record_id: 'delete-version-record',
      operation: 'Update',
      data: {
        id: 'delete-version-record',
        content: 'slow-clock-write',
        updated_at: '2026-07-10T12:00:00Z',
      },
      changed_at: '2026-07-10T12:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-slow',
      source_seq: 1,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = applyDownloadedChangesWithConflictGuard(db, [staleUpsert], { deviceId: 'device-local', allowSyncTestFixtureTables: true }, {
        policy: 'KeepLatest',
        cloudDeviceId: 'device-slow',
        localDeviceId: 'device-local',
      });
      expect(result.apply.success_count).toBe(0);
      expect(result.apply.skipped_count).toBe(1);
    }
    expect(db.pluck<string>(
      "SELECT content FROM test_records WHERE id='delete-version-record'",
    )).toBe('newer-local');
    const row = db.get<{ count: number; side: string; data_json: string; losing_device_id: string | null }>(
      `SELECT COUNT(*) AS count, side, data_json, losing_device_id FROM __sync_conflicts
       WHERE table_name='test_records' AND record_id='delete-version-record'`,
    );
    expect(Number(row?.count)).toBe(1);
    expect(row?.side).toBe('cloud');
    expect(row?.data_json).toContain('slow-clock-write');
    expect(row?.losing_device_id).toBe('device-slow');
  });

  it('regression_r04_delete_with_unparseable_changed_at_fails_closed', () => {
    const db = createTestDb();
    db.run(
      'INSERT INTO test_records(id, content, updated_at) VALUES(?1, ?2, ?3)',
      ['delete-version-record', 'must-survive', '2026-07-10T13:00:00Z'],
    );
    const badDelete = change({
      record_id: 'delete-version-record',
      operation: 'Delete',
      changed_at: 'not-a-timestamp',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-bad-clock',
      source_seq: 3,
    });
    const result = applyDownloadedChangesWithConflictGuard(db, [badDelete], { deviceId: 'device-local', allowSyncTestFixtureTables: true }, {
      policy: 'KeepLatest',
      cloudDeviceId: 'device-bad-clock',
      localDeviceId: 'device-local',
    });
    expect(result.apply.success_count).toBe(0);
    expect(result.apply.failure_count).toBe(1);
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM test_records WHERE id='delete-version-record'",
    ))).toBe(1);
    expect(Number(db.pluck<number>(
      `SELECT COUNT(*) FROM __sync_quarantine
       WHERE table_name='test_records' AND record_id='delete-version-record' AND operation='DELETE'`,
    ))).toBe(1);
  });

  it('regression_r04_stale_delete_losing_lww_lands_in_sync_conflicts', () => {
    const db = createTestDb();
    db.run(
      'INSERT INTO test_records(id, content, updated_at) VALUES(?1, ?2, ?3)',
      ['delete-version-record', 'newer-local', '2026-07-10T13:00:00Z'],
    );
    const staleDelete = change({
      record_id: 'delete-version-record',
      operation: 'Delete',
      changed_at: '2026-07-10T12:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-slow',
      source_seq: 1,
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = applyDownloadedChangesWithConflictGuard(db, [staleDelete], { deviceId: 'device-local', allowSyncTestFixtureTables: true }, {
        policy: 'KeepLatest',
        cloudDeviceId: 'device-slow',
        localDeviceId: 'device-local',
      });
      expect(result.apply.success_count).toBe(0);
      expect(result.apply.skipped_count).toBe(1);
    }
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM test_records WHERE id='delete-version-record'",
    ))).toBe(1);
    const row = db.get<{ count: number; side: string; data_json: string; losing_device_id: string | null }>(
      `SELECT COUNT(*) AS count, side, data_json, losing_device_id FROM __sync_conflicts
       WHERE table_name='test_records' AND record_id='delete-version-record'`,
    );
    expect(Number(row?.count)).toBe(1);
    expect(row?.side).toBe('cloud');
    expect(row?.data_json).toBe('null');
    expect(row?.losing_device_id).toBe('device-slow');
  });

  it('delete_version_blocks_delayed_older_upsert', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO test_records(id, content, updated_at) VALUES(?1, ?2, ?3)",
      ['delete-version-record', 'before-delete', '2026-07-10T10:00:00Z'],
    );
    const deleteChange = change({
      record_id: 'delete-version-record',
      operation: 'Delete',
      changed_at: '2026-07-10T12:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-delete',
      source_seq: 7,
    });
    const staleUpsert = change({
      record_id: 'delete-version-record',
      operation: 'Update',
      changed_at: '2026-07-10T11:00:00Z',
      data: {
        id: 'delete-version-record',
        content: 'stale-resurrection',
        updated_at: '2026-07-10T11:00:00Z',
      },
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-offline',
      source_seq: 99,
    });

    const deleted = applyDownloadedChanges(db, [deleteChange], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
    expect(deleted.success_count).toBe(1);
    const delayed = applyDownloadedChanges(db, [staleUpsert], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
    expect(delayed.success_count).toBe(0);
    expect(delayed.skipped_count).toBe(1);
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM test_records WHERE id='delete-version-record'",
    ))).toBe(0);
  });

  it('strictly_newer_upsert_can_resurrect_and_clears_delete_version', () => {
    const db = createTestDb();
    const deleteChange = change({
      record_id: 'delete-version-record',
      operation: 'Delete',
      changed_at: '2026-07-10T12:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-delete',
      source_seq: 7,
    });
    const newerUpsert = change({
      record_id: 'delete-version-record',
      operation: 'Insert',
      changed_at: '2026-07-10T13:00:00Z',
      data: {
        id: 'delete-version-record',
        content: 'intentional-resurrection',
        updated_at: '2026-07-10T13:00:00Z',
      },
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-newer',
      source_seq: 1,
    });

    applyDownloadedChanges(db, [deleteChange], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
    const applied = applyDownloadedChanges(db, [newerUpsert], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
    expect(applied.success_count).toBe(1);
    expect(db.pluck<string>(
      "SELECT content FROM test_records WHERE id='delete-version-record'",
    )).toBe('intentional-resurrection');
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __sync_delete_versions WHERE table_name='test_records' AND record_id='delete-version-record'",
    ))).toBe(0);
  });

  it('regression_m5_apply_explicit_null_clears_column', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO test_records(id, content, updated_at) VALUES(?1, ?2, ?3)",
      ['rec-null', 'keep-me', '2024-01-01T00:00:00Z'],
    );
    const result = applyDownloadedChanges(db, [change({
      record_id: 'rec-null',
      operation: 'Update',
      data: { id: 'rec-null', content: null, updated_at: '2024-01-02T00:00:00Z' },
      changed_at: '2024-01-02T00:00:00Z',
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(1);
    expect(db.pluck<string | null>('SELECT content FROM test_records WHERE id=?1', ['rec-null']))
      .toBeNull();
  });

  it('test_get_record_data_composite_pk_with_json_record_id', () => {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE test_usage_daily (
          date TEXT NOT NULL,
          caller_type TEXT NOT NULL,
          model TEXT NOT NULL,
          provider TEXT NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (date, caller_type, model, provider)
      );
      INSERT INTO test_usage_daily(date, caller_type, model, provider, request_count)
      VALUES('2026-02-10', 'chat', 'gpt-4o', 'openai', 7);
    `);
    const recordId = JSON.stringify({
      date: '2026-02-10', caller_type: 'chat', model: 'gpt-4o', provider: 'openai',
    });

    const data = getRecordData(db, 'test_usage_daily', recordId, 'id');

    expect(data).not.toBeNull();
    expect((data as { request_count: number }).request_count).toBe(7);
  });

  it('test_apply_downloaded_changes_can_suppress_change_log_echo', () => {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE test_records (id TEXT PRIMARY KEY, content TEXT, updated_at TEXT);
      CREATE TABLE __change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now')),
          sync_version INTEGER DEFAULT 0
      );
      CREATE TRIGGER trg_echo_insert AFTER INSERT ON test_records
      BEGIN
          INSERT INTO __change_log(table_name, record_id, operation)
          VALUES('test_records', NEW.id, 'INSERT');
      END;
    `);

    applyDownloadedChanges(db, [change({
      record_id: 'r1',
      data: { id: 'r1', content: 'ok', updated_at: '2026-02-10' },
      database_name: 'vfs',
      suppress_change_log: true,
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version = 0')))
      .toBe(0);
  });

  it('test_apply_downloaded_changes_skips_equivalent_replay_without_new_echo_log', () => {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE test_records (id TEXT PRIMARY KEY, content TEXT, updated_at TEXT);
      CREATE TABLE __change_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          table_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          changed_at TEXT NOT NULL DEFAULT (datetime('now')),
          sync_version INTEGER DEFAULT 0
      );
      CREATE TRIGGER trg_echo_insert AFTER INSERT ON test_records
      BEGIN
          INSERT INTO __change_log(table_name, record_id, operation)
          VALUES('test_records', NEW.id, 'INSERT');
      END;
      CREATE TRIGGER trg_echo_update AFTER UPDATE ON test_records
      BEGIN
          INSERT INTO __change_log(table_name, record_id, operation)
          VALUES('test_records', NEW.id, 'UPDATE');
      END;
    `);
    const replay = change({
      record_id: 'r1',
      data: { id: 'r1', content: 'same', updated_at: '2026-02-10T00:00:00Z' },
      database_name: 'vfs',
      suppress_change_log: true,
    });

    applyDownloadedChanges(db, [replay], { deviceId: 'device-local', allowSyncTestFixtureTables: true });
    applyDownloadedChanges(db, [replay], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __change_log'))).toBe(1);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __change_log WHERE sync_version = 0')))
      .toBe(0);
  });

  it('test_apply_semantically_equal_skip_is_not_incomplete', () => {
    const db = createTestDb();
    db.run("INSERT INTO test_records (id, content, updated_at) VALUES ('same', 'value', '2024-01-01')");

    const result = applyDownloadedChanges(db, [
      change({
        record_id: 'same',
        operation: 'Update',
        data: { id: 'same', content: 'value', updated_at: '2024-01-01' },
      }),
    ], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(0);
    expect(result.skipped_count).toBe(1);
    expect(result.skipped_incomplete_count).toBe(0);
    expect(result.failure_count).toBe(0);
  });

  it('test_dedupe_downloaded_changes_collapses_equivalent_payloads', () => {
    const first = change({
      record_id: 'r1',
      operation: 'Update',
      data: { id: 'r1', content: 'same', updated_at: '2026-02-10T00:00:00Z' },
      changed_at: '2026-02-10T00:00:00Z',
      change_log_id: 1,
      database_name: 'vfs',
    });
    const duplicate = {
      ...first,
      changed_at: '2026-02-10T00:00:05Z',
      change_log_id: 99,
    };

    const deduped = dedupeDownloadedChanges([first, duplicate]);

    expect(deduped).toHaveLength(1);
  });

  it('test_apply_delete_uses_tombstone_when_column_exists', () => {
    const db = openTestDatabase();
    db.exec(`CREATE TABLE test_records (
        id TEXT PRIMARY KEY,
        content TEXT,
        deleted_at TEXT
      );
      INSERT INTO test_records (id, content, deleted_at) VALUES ('r1', 'alive', NULL);`);

    const result = applyDownloadedChanges(db, [change({
      record_id: 'r1',
      operation: 'Delete',
      changed_at: '2026-02-10T00:00:00Z',
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(1);
    const row = db.get<{ count: number; deleted_at: string | null }>(
      "SELECT COUNT(*) AS count, MAX(deleted_at) AS deleted_at FROM test_records WHERE id = 'r1'",
    );
    expect(Number(row?.count)).toBe(1);
    expect(row?.deleted_at).not.toBeNull();
  });

  it('test_apply_skips_incomplete_upsert_shadowed_by_batch_delete', () => {
    const db = createTestDb();
    const changes = [
      change({
        record_id: 'hard-deleted',
        operation: 'Insert',
        data: null,
        changed_at: '2026-02-10T00:00:00Z',
        change_log_id: 1,
        database_name: 'vfs',
        suppress_change_log: true,
      }),
      change({
        record_id: 'hard-deleted',
        operation: 'Delete',
        data: null,
        changed_at: '2026-02-10T00:00:01Z',
        change_log_id: 2,
        database_name: 'vfs',
        suppress_change_log: true,
      }),
    ];

    const result = applyDownloadedChanges(db, changes, {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    });

    expect(result.success_count).toBe(1);
    expect(result.skipped_count).toBe(1);
    expect(result.skipped_incomplete_count).toBe(1);
    expect(result.failure_count).toBe(0);
  });

  it('test_conflict_guard_skips_incomplete_upsert_shadowed_by_batch_delete', () => {
    const db = createTestDb();
    const changes = [
      change({
        record_id: 'hard-deleted',
        operation: 'Insert',
        data: null,
        changed_at: '2026-02-10T00:00:00Z',
        change_log_id: 1,
        database_name: 'vfs',
        suppress_change_log: true,
      }),
      change({
        record_id: 'hard-deleted',
        operation: 'Delete',
        data: null,
        changed_at: '2026-02-10T00:00:01Z',
        change_log_id: 2,
        database_name: 'vfs',
        suppress_change_log: true,
      }),
    ];

    const result = applyDownloadedChangesWithConflictGuard(db, changes, {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    }, {
      policy: 'KeepLatest',
      cloudDeviceId: 'cloud-device',
      localDeviceId: 'local-device',
    });

    expect(result.apply.success_count).toBe(1);
    expect(result.apply.skipped_count).toBe(1);
    expect(result.apply.skipped_incomplete_count).toBe(1);
    expect(result.apply.failure_count).toBe(0);
    expect(result.conflict.conflicts_saved).toBe(0);
  });

  it('test_apply_downloaded_changes_rolls_back_on_fk_violation', () => {
    const db = openTestDatabase();
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE parent_records (id TEXT PRIMARY KEY);
      CREATE TABLE child_records (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        FOREIGN KEY(parent_id) REFERENCES parent_records(id)
      );
      CREATE TABLE test_records (id TEXT PRIMARY KEY, content TEXT);
    `);

    const result = applyDownloadedChanges(db, [
      change({
        record_id: 'safe-1',
        operation: 'Insert',
        data: { id: 'safe-1', content: 'should rollback' },
        changed_at: '2026-02-10T00:00:00Z',
      }),
      change({
        table_name: 'child_records',
        record_id: 'child-1',
        operation: 'Insert',
        data: { id: 'child-1', parent_id: 'missing-parent' },
        changed_at: '2026-02-10T00:00:01Z',
      }),
    ], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(1);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM test_records'))).toBe(1);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM child_records'))).toBe(0);
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __sync_quarantine WHERE record_id = 'child-1'",
    ))).toBe(1);
  });

  it('regression_m10_poison_payload_is_quarantined_without_blocking_batch', () => {
    const db = createTestDb();
    const result = applyDownloadedChanges(db, [
      change({
        record_id: 'bad-id',
        operation: 'Insert',
        data: { id: 'different-id', content: 'poison', updated_at: '2026-02-10T00:00:00Z' },
        changed_at: '2026-02-10T00:00:00Z',
        change_log_id: 1,
        suppress_change_log: true,
      }),
      change({
        record_id: 'good-id',
        operation: 'Insert',
        data: { id: 'good-id', content: 'applied', updated_at: '2026-02-10T00:00:01Z' },
        changed_at: '2026-02-10T00:00:01Z',
        change_log_id: 2,
        suppress_change_log: true,
      }),
    ], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(1);
    expect(result.failures[0]?.record_id).toBe('bad-id');
    expect(db.pluck<string>("SELECT content FROM test_records WHERE id = 'good-id'")).toBe('applied');
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_quarantine'))).toBe(1);
  });

  it('quarantine_replay_persists_baseline_and_clears_state_with_guarded_apply', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO test_records(id, content, updated_at) VALUES('q-1', 'base', '2026-01-01T00:00:00Z')",
    );
    const pending = change({
      record_id: 'q-1',
      operation: 'Update',
      data: { id: 'q-1', content: 'cloud', updated_at: '2026-01-02T00:00:00Z' },
      changed_at: '2026-01-02T00:00:00Z',
      suppress_change_log: true,
      source_device_id: 'remote-a',
      source_seq: 1,
    });
    quarantineChange(db, pending, new Error('temporary poison'));
    const hashes = db.get<{ payload_hash: string; baseline_hash: string }>(
      'SELECT payload_hash, baseline_hash FROM __sync_quarantine',
    );
    expect(hashes?.payload_hash).not.toBe('');
    expect(hashes?.baseline_hash).not.toBe('');

    expect(replayQuarantinedChanges(db, null, 20, 'device-local', true)).toBe(1);
    expect(db.pluck<string>("SELECT content FROM test_records WHERE id='q-1'")).toBe('cloud');
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_quarantine'))).toBe(0);
  });

  it('quarantine_replay_baseline_mismatch_preserves_both_sides', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO test_records(id, content, updated_at) VALUES('q-2', 'base', '2026-01-01T00:00:00Z')",
    );
    const pending = change({
      record_id: 'q-2',
      operation: 'Update',
      data: { id: 'q-2', content: 'cloud', updated_at: '2026-01-02T00:00:00Z' },
      changed_at: '2026-01-02T00:00:00Z',
      suppress_change_log: true,
      source_device_id: 'remote-a',
      source_seq: 2,
    });
    quarantineChange(db, pending, new Error('temporary poison'));
    db.run("UPDATE test_records SET content='local-new', updated_at='2026-01-03T00:00:00Z' WHERE id='q-2'");

    expect(replayQuarantinedChanges(db, null, 20, 'device-local', true)).toBe(1);
    expect(db.pluck<string>("SELECT content FROM test_records WHERE id='q-2'")).toBe('local-new');
    expect(Number(db.pluck<number>(
      "SELECT COUNT(*) FROM __sync_conflicts WHERE record_id='q-2' AND resolved_at IS NULL",
    ))).toBe(2);
  });

  it('quarantine_replay_rejects_payload_hash_mismatch', () => {
    const db = createTestDb();
    db.run(
      "INSERT INTO test_records(id, content, updated_at) VALUES('q-3', 'base', '2026-01-01T00:00:00Z')",
    );
    const pending = change({
      record_id: 'q-3',
      operation: 'Update',
      data: { id: 'q-3', content: 'cloud', updated_at: '2026-01-02T00:00:00Z' },
      changed_at: '2026-01-02T00:00:00Z',
      suppress_change_log: true,
      source_device_id: 'remote-a',
      source_seq: 3,
    });
    quarantineChange(db, pending, new Error('temporary poison'));
    db.run("UPDATE __sync_quarantine SET payload_json = replace(payload_json, 'cloud', 'tampered')");

    expect(replayQuarantinedChanges(db, null, 20, 'device-local', true)).toBe(0);
    expect(db.pluck<string>("SELECT content FROM test_records WHERE id='q-3'")).toBe('base');
    expect(db.pluck<string>('SELECT error FROM __sync_quarantine')).toContain('payload hash');
  });

  it('regression_m20_unregistered_table_payload_is_quarantined', () => {
    const db = openTestDatabase();
    db.exec('CREATE TABLE evil_payloads (id TEXT PRIMARY KEY, content TEXT)');

    const result = applyDownloadedChanges(db, [change({
      table_name: 'evil_payloads',
      record_id: 'evil-1',
      operation: 'Insert',
      data: { id: 'evil-1', content: 'must not be written' },
      changed_at: '2026-02-10T00:00:00Z',
      database_name: 'vfs',
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(0);
    expect(result.failure_count).toBe(1);
    expect(result.failures[0]?.error).toContain('禁止同步未注册为 RowSync 的表');
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM evil_payloads'))).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_quarantine'))).toBe(1);
  });

  function createTodoConstraintDb(): TestDatabase {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE todo_lists (
        id TEXT PRIMARY KEY,
        title TEXT,
        updated_at TEXT
      );
      CREATE TABLE todo_items (
        id TEXT PRIMARY KEY,
        todo_list_id TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        parent_id TEXT,
        updated_at TEXT,
        deleted_at TEXT
      );
      CREATE TRIGGER trg_todo_items_validate_insert
      BEFORE INSERT ON todo_items
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'todo_items.parent_id must belong to the same list')
        WHERE NEW.parent_id IS NOT NULL
          AND (SELECT todo_list_id FROM todo_items WHERE id = NEW.parent_id) IS NOT NEW.todo_list_id;
      END;
      CREATE TRIGGER trg_todo_items_validate_update
      BEFORE UPDATE ON todo_items
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'todo_items.parent_id must belong to the same list')
        WHERE NEW.parent_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM todo_items WHERE id = NEW.parent_id)
          AND (SELECT todo_list_id FROM todo_items WHERE id = NEW.parent_id) IS NOT NEW.todo_list_id;
      END;
    `);
    return db;
  }

  function todoChanges(): EngineChange[] {
    return [
      change({
        table_name: 'todo_lists',
        record_id: 'list-1',
        data: { id: 'list-1', title: 'List', updated_at: '2026-05-31T00:00:00Z' },
        changed_at: '2026-05-31T00:00:00Z',
        change_log_id: 1,
        database_name: 'vfs',
        suppress_change_log: true,
      }),
      change({
        table_name: 'todo_items',
        record_id: 'todo-child',
        data: {
          id: 'todo-child',
          todo_list_id: 'list-1',
          title: 'Child',
          status: 'pending',
          priority: 'medium',
          parent_id: 'todo-parent',
          updated_at: '2026-05-31T00:00:00Z',
          deleted_at: null,
        },
        changed_at: '2026-05-31T00:00:00Z',
        change_log_id: 2,
        database_name: 'vfs',
        suppress_change_log: true,
      }),
      change({
        table_name: 'todo_items',
        record_id: 'todo-parent',
        data: {
          id: 'todo-parent',
          todo_list_id: 'list-1',
          title: 'Parent',
          status: 'pending',
          priority: 'high',
          parent_id: null,
          updated_at: '2026-05-31T00:00:00Z',
          deleted_at: null,
        },
        changed_at: '2026-05-31T00:00:00Z',
        change_log_id: 3,
        database_name: 'vfs',
        suppress_change_log: true,
      }),
    ];
  }

  function assertTodoParentChildApplied(db: TestDatabase): void {
    const child = db.get<{ parent_id: string; todo_list_id: string }>(
      "SELECT parent_id, todo_list_id FROM todo_items WHERE id = 'todo-child'",
    );
    expect(child?.parent_id).toBe('todo-parent');
    expect(child?.todo_list_id).toBe('list-1');
    expect(db.pluck<string>(
      "SELECT todo_list_id FROM todo_items WHERE id = 'todo-parent'",
    )).toBe('list-1');
  }

  it('test_apply_downloaded_changes_orders_todo_parent_before_child', () => {
    const db = createTodoConstraintDb();
    const result = applyDownloadedChanges(db, todoChanges(), {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    });
    expect(result.success_count).toBe(3);
    assertTodoParentChildApplied(db);
  });

  it('test_conflict_guard_orders_todo_parent_before_child', () => {
    const db = createTodoConstraintDb();
    const result = applyDownloadedChangesWithConflictGuard(db, todoChanges(), {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    }, {
      policy: 'KeepLatest',
      cloudDeviceId: 'cloud-device',
      localDeviceId: 'local-device',
    });
    expect(result.apply.success_count).toBe(3);
    expect(result.conflict.conflicts_saved).toBe(0);
    assertTodoParentChildApplied(db);
  });

  function createBlobFkDb(): TestDatabase {
    const db = openTestDatabase();
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE blobs (
        hash TEXT PRIMARY KEY,
        relative_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime_type TEXT,
        ref_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE files (
        id TEXT PRIMARY KEY,
        blob_hash TEXT,
        sha256 TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(blob_hash) REFERENCES blobs(hash)
      );
    `);
    return db;
  }

  function blobMetadataChange(refCount = 1): EngineChange {
    return change({
      table_name: 'blobs',
      record_id: 'blob-hash-1',
      data: {
        hash: 'blob-hash-1',
        relative_path: 'bl/ob/blob-hash-1.md',
        size: 12,
        mime_type: 'text/markdown',
        ref_count: refCount,
        created_at: 1780225200000,
      },
      changed_at: '2026-05-31T00:00:01Z',
      change_log_id: 2,
      database_name: 'vfs',
      suppress_change_log: true,
    });
  }

  function blobFileChange(): EngineChange {
    return change({
      table_name: 'files',
      record_id: 'file-1',
      data: {
        id: 'file-1',
        blob_hash: 'blob-hash-1',
        sha256: 'sha256-file-1',
        file_name: 'blob-backed.md',
        size: 12,
        created_at: '2026-05-31T00:00:00Z',
        updated_at: '2026-05-31T00:00:00Z',
      },
      changed_at: '2026-05-31T00:00:00Z',
      change_log_id: 1,
      database_name: 'vfs',
      suppress_change_log: true,
    });
  }

  function assertBlobFileApplied(db: TestDatabase): void {
    const row = db.get<{ blob_hash: string; relative_path: string }>(
      `SELECT files.blob_hash, blobs.relative_path
       FROM files JOIN blobs ON blobs.hash = files.blob_hash
       WHERE files.id = 'file-1'`,
    );
    expect(row?.blob_hash).toBe('blob-hash-1');
    expect(row?.relative_path).toBe('bl/ob/blob-hash-1.md');
  }

  it('test_quarantine_source_uses_v3_metadata', () => {
    const pending = change({
      table_name: 'notes',
      record_id: 'note-1',
      operation: 'Update',
      data: null,
      changed_at: '2026-06-01T00:00:00Z',
      change_log_id: 7,
      database_name: 'vfs',
      suppress_change_log: true,
      source_device_id: 'device-a',
      source_seq: 42,
    });
    expect(sourceDeviceForQuarantine(pending)).toBe('device-a');
    expect(sourceSeqForQuarantine(pending)).toBe(42);
  });

  it('test_apply_downloaded_changes_orders_blob_metadata_before_files', () => {
    const db = createBlobFkDb();
    const result = applyDownloadedChanges(db, [blobFileChange(), blobMetadataChange()], {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    });
    expect(result.success_count).toBe(2);
    assertBlobFileApplied(db);
  });

  it('test_conflict_guard_orders_blob_metadata_before_files', () => {
    const db = createBlobFkDb();
    const result = applyDownloadedChangesWithConflictGuard(db, [blobFileChange(), blobMetadataChange()], {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    }, {
      policy: 'KeepLatest',
      cloudDeviceId: 'cloud-device',
      localDeviceId: 'local-device',
    });
    expect(result.apply.success_count).toBe(2);
    expect(result.conflict.conflicts_saved).toBe(0);
    assertBlobFileApplied(db);
  });

  it('regression_ref_count_is_recomputed_after_download_apply', () => {
    const db = createBlobFkDb();
    const result = applyDownloadedChanges(db, [blobFileChange(), blobMetadataChange(99)], {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    });
    expect(result.success_count).toBe(2);
    expect(Number(db.pluck<number>("SELECT ref_count FROM blobs WHERE hash='blob-hash-1'"))).toBe(1);
  });

  it('regression_recompute_counts_json_embedded_blob_refs', () => {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE blobs (hash TEXT PRIMARY KEY, ref_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE files (id TEXT PRIMARY KEY, blob_hash TEXT, compressed_blob_hash TEXT, preview_json TEXT);
      CREATE TABLE exam_sheets (id TEXT PRIMARY KEY, preview_json TEXT);
      CREATE TABLE questions (id TEXT PRIMARY KEY, images_json TEXT);
    `);
    for (const hash of ['main-blob', 'page-blob', 'page-compressed-blob', 'exam-page-blob', 'question-img-blob', 'dedup-blob']) {
      db.run('INSERT INTO blobs(hash, ref_count) VALUES (?1, 99)', [hash]);
    }
    db.run(`INSERT INTO files(id, blob_hash, compressed_blob_hash, preview_json) VALUES (
      'file-1', 'main-blob', NULL,
      '{"pages":[{"page_index":0,"blob_hash":"page-blob","compressed_blob_hash":"page-compressed-blob"}]}'
    )`);
    db.run(`INSERT INTO files(id, blob_hash, compressed_blob_hash, preview_json) VALUES (
      'file-2', 'dedup-blob', 'dedup-blob',
      '{"pages":[{"page_index":0,"blob_hash":"dedup-blob","compressed_blob_hash":"dedup-blob"}]}'
    )`);
    db.run(`INSERT INTO exam_sheets(id, preview_json) VALUES (
      'exam-1', '{"pages":[{"page_index":0,"blob_hash":"exam-page-blob"}]}'
    )`);
    db.run(`INSERT INTO questions(id, images_json) VALUES
      ('q-1', '[{"id":"att_1","hash":"question-img-blob"}]'),
      ('q-2', '[{"id":"att_2","hash":"question-img-blob"}]')`);
    db.run("INSERT INTO files(id, blob_hash, preview_json) VALUES ('file-bad', NULL, '{not json')");

    recomputeBlobRefCounts(db);

    const countOf = (hash: string): number => Number(
      db.pluck<number>('SELECT ref_count FROM blobs WHERE hash = ?1', [hash]),
    );
    expect(countOf('main-blob')).toBe(1);
    expect(countOf('page-blob')).toBe(1);
    expect(countOf('page-compressed-blob')).toBe(1);
    expect(countOf('exam-page-blob')).toBe(1);
    expect(countOf('question-img-blob')).toBe(2);
    expect(countOf('dedup-blob')).toBe(2);
  });

  it('regression_changes_to_json_ref_tables_trigger_recompute_gate', () => {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE questions (id TEXT PRIMARY KEY, images_json TEXT);
      CREATE TABLE exam_sheets (id TEXT PRIMARY KEY, preview_json TEXT);
      CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT);
    `);
    const changeFor = (table: string): EngineChange => change({
      table_name: table,
      record_id: 'r1',
      operation: 'Update',
      data: null,
      changed_at: '2026-06-12T00:00:00Z',
      change_log_id: 1,
      database_name: 'vfs',
      suppress_change_log: true,
    });
    expect(changesAffectRefCounts(db, [changeFor('questions')])).toBe(true);
    expect(changesAffectRefCounts(db, [changeFor('exam_sheets')])).toBe(true);
    expect(changesAffectRefCounts(db, [changeFor('notes')])).toBe(false);
  });

  it('persisted_id_alias_lookup_is_read_only_and_preserves_cycle_behavior', () => {
    const db = openTestDatabase();
    db.exec('PRAGMA query_only = ON');
    expect(resolvePersistedIdAlias(db, 'files', 'remote')).toBe('remote');
    db.exec('PRAGMA query_only = OFF');
    ensureIdAliasTable(db);
    db.exec(`INSERT INTO __sync_id_aliases(table_name, remote_id, canonical_id) VALUES
      ('files', 'remote', 'intermediate'),
      ('files', 'intermediate', 'local'),
      ('files', 'cycle-a', 'cycle-b'),
      ('files', 'cycle-b', 'cycle-a')`);
    db.exec('PRAGMA query_only = ON');
    expect(resolvePersistedIdAlias(db, 'files', 'remote')).toBe('local');
    expect(resolvePersistedIdAlias(db, 'resources', 'remote')).toBe('remote');
    expect(resolvePersistedIdAlias(db, 'files', 'cycle-a')).toBe('cycle-a');
    db.exec('PRAGMA query_only = OFF');
  });

  it('regression_p3_5_files_same_sha_is_aliased_to_existing_file', () => {
    const db = createBlobFkDb();
    db.run(
      `INSERT INTO blobs(hash, relative_path, size, mime_type, ref_count, created_at)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6)`,
      ['blob-hash-1', 'bl/ob/blob-hash-1.md', 12, 'text/markdown', 1, 1780225200000],
    );
    db.run(
      `INSERT INTO files(id, blob_hash, sha256, file_name, size, created_at, updated_at)
       VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ['file-1', 'blob-hash-1', 'same-sha', 'original.md', 12, '2026-05-31T00:00:00Z', '2026-05-31T00:00:00Z'],
    );
    const result = applyDownloadedChanges(db, [change({
      table_name: 'files',
      record_id: 'file-2',
      operation: 'Insert',
      data: {
        id: 'file-2',
        blob_hash: 'blob-hash-1',
        sha256: 'same-sha',
        file_name: 'must-not-merge.md',
        size: 12,
        created_at: '2026-06-01T00:00:00Z',
        updated_at: '2026-06-01T00:00:00Z',
      },
      changed_at: '2026-06-01T00:00:00Z',
      change_log_id: 42,
      database_name: 'vfs',
      suppress_change_log: true,
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    expect(result.success_count).toBe(1);
    expect(result.failure_count).toBe(0);
    expect(db.pluck<string>("SELECT file_name FROM files WHERE id='file-1'")).toBe('must-not-merge.md');
    expect(Number(db.pluck<number>("SELECT COUNT(*) FROM files WHERE id='file-2'"))).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM __sync_quarantine'))).toBe(0);
    expect(db.pluck<string>(
      "SELECT canonical_id FROM __sync_id_aliases WHERE table_name='files' AND remote_id='file-2'",
    )).toBe('file-1');
  });

  it('regression_m15_sqlite_text_json_string_is_not_reserialized', () => {
    const db = openTestDatabase();
    db.exec(`CREATE TABLE docs (id TEXT PRIMARY KEY, body TEXT);
      INSERT INTO docs (id, body) VALUES ('d1', '{"b":2, "a":1}');`);
    const body = sqliteValueToJson(
      'text',
      db.pluck<string>("SELECT body FROM docs WHERE id='d1'"),
    );
    expect(body).toBe('{"b":2, "a":1}');
  });

  it('regression_m15_sqlite_blob_is_typed_dsblob_payload', () => {
    const db = openTestDatabase();
    db.exec(`CREATE TABLE docs (id TEXT PRIMARY KEY, payload BLOB);
      INSERT INTO docs (id, payload) VALUES ('d1', x'000102ff');`);
    const raw = db.pluck<Uint8Array>("SELECT payload FROM docs WHERE id='d1'");
    const payload = sqliteValueToJson('blob', raw);
    expect(payload).toEqual({ $dsblob: 'AAEC/w==' });
    const param = jsonValueToSqlParam(payload);
    expect(param).toBeInstanceOf(Uint8Array);
    expect([...(param as Uint8Array)]).toEqual([0, 1, 2, 255]);
  });

  function createResourceAliasDb(): TestDatabase {
    const db = openTestDatabase();
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE resources (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL UNIQUE,
        body TEXT,
        updated_at TEXT
      );
      CREATE TABLE resource_notes (
        id TEXT PRIMARY KEY,
        resource_id TEXT NOT NULL,
        note TEXT,
        updated_at TEXT,
        FOREIGN KEY(resource_id) REFERENCES resources(id)
      );
      INSERT INTO resources (id, hash, body, updated_at)
      VALUES ('local-res', 'same-business-hash', 'local body', '2024-01-01T00:00:00Z');
    `);
    return db;
  }

  function resourceAliasParentChange(): EngineChange {
    return change({
      table_name: 'resources',
      record_id: 'remote-res',
      data: {
        id: 'remote-res',
        hash: 'same-business-hash',
        body: 'cloud body',
        updated_at: '2024-01-02T00:00:00Z',
      },
      changed_at: '2024-01-02T00:00:00Z',
      database_name: 'vfs',
    });
  }

  function resourceAliasChildChange(): EngineChange {
    return change({
      table_name: 'resource_notes',
      record_id: 'note-remote',
      data: {
        id: 'note-remote',
        resource_id: 'remote-res',
        note: 'child uses remote id',
        updated_at: '2024-01-02T00:00:01Z',
      },
      changed_at: '2024-01-02T00:00:01Z',
      database_name: 'vfs',
    });
  }

  function assertResourceAliasResult(db: TestDatabase): void {
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM resources'))).toBe(1);
    expect(Number(db.pluck<number>("SELECT COUNT(*) FROM resources WHERE id = 'remote-res'"))).toBe(0);
    expect(db.pluck<string>("SELECT body FROM resources WHERE id = 'local-res'")).toBe('cloud body');
    expect(db.pluck<string>("SELECT resource_id FROM resource_notes WHERE id = 'note-remote'"))
      .toBe('local-res');
    expect(db.all('PRAGMA foreign_key_check')).toHaveLength(0);
  }

  it('test_business_key_alias_remaps_child_fk_when_child_arrives_first', () => {
    const db = createResourceAliasDb();
    const result = applyDownloadedChanges(
      db,
      [resourceAliasChildChange(), resourceAliasParentChange()],
      { deviceId: 'device-local', allowSyncTestFixtureTables: true },
    );
    expect(result.success_count).toBe(2);
    assertResourceAliasResult(db);
  });

  it('test_business_key_alias_reuses_canonical_id_when_parent_arrives_first', () => {
    const db = createResourceAliasDb();
    const result = applyDownloadedChanges(
      db,
      [resourceAliasParentChange(), resourceAliasChildChange()],
      { deviceId: 'device-local', allowSyncTestFixtureTables: true },
    );
    expect(result.success_count).toBe(2);
    // Rust 在 remap 之后登记 applied_keys（mod.rs:7140）：别名场景记录 canonical id。
    expect(result.applied_keys.has('resources\u001flocal-res')).toBe(true);
    expect(result.applied_keys.has('resources\u001fremote-res')).toBe(false);
    assertResourceAliasResult(db);
  });

  it('fsrs_child_first_log_remaps_duplicate_state_id_without_physical_fk', () => {
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
      CREATE TABLE anki_cards (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE anki_decks (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL, deleted_at TEXT);
      CREATE TABLE fsrs_card_states (
        id TEXT PRIMARY KEY,
        anki_card_id TEXT NOT NULL UNIQUE,
        deck_id TEXT,
        state INTEGER NOT NULL,
        due_ms INTEGER NOT NULL,
        fsrs_params_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE fsrs_review_logs (
        id TEXT PRIMARY KEY,
        card_state_id TEXT NOT NULL,
        anki_card_id TEXT NOT NULL,
        rating INTEGER NOT NULL,
        state_before INTEGER NOT NULL,
        state_after INTEGER NOT NULL,
        review_ms INTEGER NOT NULL,
        fsrs_params_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      INSERT INTO anki_cards(id, updated_at) VALUES ('card-shared', '2026-07-11T00:00:00Z');
      INSERT INTO anki_decks(id, name, updated_at) VALUES ('deck-local', 'Default', '2026-07-11T00:00:00Z');
      INSERT INTO fsrs_card_states(
        id, anki_card_id, deck_id, state, due_ms, fsrs_params_version, created_at, updated_at
      ) VALUES (
        'state-local', 'card-shared', 'deck-local', 0, 0, 'rs-fsrs-test',
        '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'
      );
    `);
    const childFirst = change({
      table_name: 'fsrs_review_logs',
      record_id: 'log-remote',
      data: {
        id: 'log-remote',
        card_state_id: 'state-remote',
        anki_card_id: 'card-shared',
        rating: 3,
        state_before: 0,
        state_after: 1,
        review_ms: 1783728000000,
        fsrs_params_version: 'rs-fsrs-test',
        created_at: '2026-07-11T00:00:02Z',
        updated_at: '2026-07-11T00:00:02Z',
      },
      changed_at: '2026-07-11T00:00:02Z',
      database_name: 'mistakes',
      suppress_change_log: true,
      source_device_id: 'remote-device',
      source_seq: 2,
    });
    const duplicateParent = change({
      table_name: 'fsrs_card_states',
      record_id: 'state-remote',
      data: {
        id: 'state-remote',
        anki_card_id: 'card-shared',
        deck_id: 'deck-local',
        state: 1,
        due_ms: 1783728600000,
        fsrs_params_version: 'rs-fsrs-test',
        created_at: '2026-07-11T00:00:01Z',
        updated_at: '2026-07-11T00:00:01Z',
      },
      changed_at: '2026-07-11T00:00:01Z',
      database_name: 'mistakes',
      suppress_change_log: true,
      source_device_id: 'remote-device',
      source_seq: 1,
    });

    const result = applyDownloadedChanges(db, [childFirst, duplicateParent], {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    });

    expect(result.success_count).toBe(2);
    expect(result.failure_count).toBe(0);
    const stateId = db.pluck<string>(
      "SELECT card_state_id FROM fsrs_review_logs WHERE id = 'log-remote'",
    );
    expect(stateId).toBe('state-local');
    expect(Number(db.pluck<number>(
      `SELECT COUNT(s.id) FROM fsrs_review_logs l
       LEFT JOIN fsrs_card_states s ON s.id = l.card_state_id
       WHERE l.id = 'log-remote'`,
    ))).toBe(1);
    expect(db.pluck<string>(
      `SELECT canonical_id FROM __sync_id_aliases
       WHERE table_name = 'fsrs_card_states' AND remote_id = 'state-remote'`,
    )).toBe('state-local');
  });

  it('regression_m9_same_batch_business_key_alias_remaps_later_child_fk', () => {
    const db = createResourceAliasDb();
    db.exec('DELETE FROM resource_notes; DELETE FROM resources;');
    const parentA = change({
      table_name: 'resources',
      record_id: 'remote-res-a',
      data: { id: 'remote-res-a', hash: 'same-batch-hash', body: 'first parent', updated_at: '2024-01-02T00:00:00Z' },
      changed_at: '2024-01-02T00:00:00Z',
      database_name: 'vfs',
    });
    const parentB = change({
      table_name: 'resources',
      record_id: 'remote-res-b',
      data: { id: 'remote-res-b', hash: 'same-batch-hash', body: 'second parent', updated_at: '2024-01-02T00:00:01Z' },
      changed_at: '2024-01-02T00:00:01Z',
      database_name: 'vfs',
    });
    const child = change({
      table_name: 'resource_notes',
      record_id: 'note-remote-b',
      data: { id: 'note-remote-b', resource_id: 'remote-res-b', note: 'child references duplicate parent', updated_at: '2024-01-02T00:00:02Z' },
      changed_at: '2024-01-02T00:00:02Z',
      database_name: 'vfs',
    });

    const result = applyDownloadedChanges(db, [parentA, parentB, child], {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    });

    expect(result.success_count).toBe(3);
    expect(result.failure_count).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM resources'))).toBe(1);
    expect(db.pluck<string>("SELECT resource_id FROM resource_notes WHERE id='note-remote-b'"))
      .toBe('remote-res-a');
    expect(db.pluck<string>(
      "SELECT canonical_id FROM __sync_id_aliases WHERE table_name='resources' AND remote_id='remote-res-b'",
    )).toBe('remote-res-a');
    expect(db.all('PRAGMA foreign_key_check')).toHaveLength(0);
  });

  it('test_conflict_guard_business_key_alias_remaps_child_fk', () => {
    const db = createResourceAliasDb();
    const result = applyDownloadedChangesWithConflictGuard(
      db,
      [resourceAliasChildChange(), resourceAliasParentChange()],
      { deviceId: 'device-local', allowSyncTestFixtureTables: true },
      { policy: 'KeepLatest', cloudDeviceId: 'cloud-device', localDeviceId: 'local-device' },
    );
    expect(result.apply.success_count).toBe(2);
    expect(result.conflict.conflicts_saved).toBe(0);
    assertResourceAliasResult(db);
  });

  it('test_suppress_change_log_does_not_mark_existing_user_update', () => {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE test_records (id TEXT PRIMARY KEY, content TEXT, updated_at TEXT);
      CREATE TABLE __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
      );
      CREATE TRIGGER trg_echo_insert AFTER INSERT ON test_records
      BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('test_records', NEW.id, 'INSERT');
      END;
      CREATE TRIGGER trg_echo_update AFTER UPDATE ON test_records
      BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('test_records', NEW.id, 'UPDATE');
      END;
    `);
    const replayInsert = change({
      record_id: 'r1',
      operation: 'Insert',
      data: { id: 'r1', content: 'cloud', updated_at: '2026-02-10T00:00:00Z' },
      changed_at: '2026-02-10T00:00:00Z',
      suppress_change_log: true,
    });
    applyDownloadedChanges(db, [replayInsert], {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    });
    db.run("UPDATE test_records SET content = 'local-edit' WHERE id = 'r1'");
    const userUpdateLogId = Number(db.pluck<number | bigint>(
      "SELECT id FROM __change_log WHERE operation = 'UPDATE' ORDER BY id DESC LIMIT 1",
    ));

    applyDownloadedChanges(db, [replayInsert], {
      deviceId: 'device-local',
      allowSyncTestFixtureTables: true,
    });

    expect(Number(db.pluck<number>(
      'SELECT sync_version FROM __change_log WHERE id = ?1',
      [userUpdateLogId],
    ))).toBe(0);
  });

  it('remote_resource_apply_strips_and_resets_local_vector_index_lifecycle', () => {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, hash TEXT, type TEXT, storage_mode TEXT, data TEXT,
        ref_count INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER,
        index_state TEXT, index_hash TEXT, index_error TEXT, indexed_at INTEGER,
        index_retry_count INTEGER, index_next_retry_at INTEGER, index_generation INTEGER,
        mm_index_state TEXT, mm_index_error TEXT, mm_index_retry_count INTEGER,
        mm_index_next_retry_at INTEGER, mm_embedding_dim INTEGER, mm_indexing_mode TEXT,
        mm_indexed_at INTEGER, mm_index_generation INTEGER
      );
      INSERT INTO resources
        (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
        VALUES ('res_sync_index', 'hash_sync_index', 'note', 'inline', 'local', 0, 1, 1);
      UPDATE resources SET
        index_state = 'indexed', index_hash = 'local-index-hash',
        index_error = 'local-error', indexed_at = 10,
        index_retry_count = 4, index_next_retry_at = 99, index_generation = 7,
        mm_index_state = NULL, mm_index_error = 'local-mm-error',
        mm_index_retry_count = 5, mm_index_next_retry_at = 88,
        mm_embedding_dim = 64, mm_indexing_mode = 'local-mode',
        mm_indexed_at = 11, mm_index_generation = 6
      WHERE id = 'res_sync_index';
    `);
    applyDownloadedChanges(db, [change({
      table_name: 'resources',
      record_id: 'res_sync_index',
      data: {
        id: 'res_sync_index',
        hash: 'hash_sync_index',
        type: 'note',
        storage_mode: 'inline',
        data: 'remote',
        created_at: 1,
        updated_at: 2,
        index_state: 'indexed',
        index_hash: 'remote-index-hash',
        index_retry_count: 999,
        index_next_retry_at: 999,
        index_generation: 999,
        mm_index_state: 'indexed',
        mm_index_retry_count: 999,
        mm_index_next_retry_at: 999,
        mm_embedding_dim: 4096,
        mm_indexing_mode: 'remote-mode',
        mm_index_generation: 999,
      },
      changed_at: '2026-05-31T00:00:00Z',
      database_name: 'vfs',
      suppress_change_log: true,
    })], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    const state = db.get<Record<string, string | number | null>>(
      `SELECT data, index_state, index_hash, index_retry_count,
              index_next_retry_at, index_generation, mm_index_state,
              mm_index_error, mm_index_retry_count, mm_index_next_retry_at,
              mm_embedding_dim, mm_indexing_mode, mm_index_generation
       FROM resources WHERE id = 'res_sync_index'`,
    );
    expect(state?.data).toBe('remote');
    expect(state?.index_state).toBe('pending');
    expect(state?.index_hash).toBeNull();
    expect([Number(state?.index_retry_count), Number(state?.index_next_retry_at), Number(state?.index_generation)])
      .toEqual([0, 0, 0]);
    expect(state?.mm_index_state).toBeNull();
    expect(state?.mm_index_error).toBeNull();
    expect([Number(state?.mm_index_retry_count), Number(state?.mm_index_next_retry_at)]).toEqual([0, 0]);
    expect(state?.mm_embedding_dim).toBeNull();
    expect(state?.mm_indexing_mode).toBeNull();
    expect(Number(state?.mm_index_generation)).toBe(0);
    // X6-AP-0407: mod.rs:14464-14473 also asserts the outbound strip classification.
    for (const column of ['index_next_retry_at', 'index_generation', 'mm_index_next_retry_at', 'mm_index_generation']) {
      expect(isLocalDerivedSyncColumn('resources', column)).toBe(true);
    }
  });

  it('remote_business_rows_keep_multimodal_index_fields_local', () => {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE files (
        id TEXT PRIMARY KEY, sha256 TEXT, file_name TEXT, size INTEGER,
        created_at TEXT, updated_at TEXT, mm_index_state TEXT, mm_index_error TEXT,
        mm_indexed_pages_json TEXT
      );
      CREATE TABLE exam_sheets (
        id TEXT PRIMARY KEY, status TEXT, temp_id TEXT, metadata_json TEXT, preview_json TEXT,
        created_at TEXT, updated_at TEXT, mm_index_state TEXT, mm_index_error TEXT,
        mm_indexed_pages_json TEXT, mm_embedding_dim INTEGER, mm_indexing_mode TEXT,
        mm_indexed_at INTEGER
      );
      INSERT INTO files
        (id, sha256, file_name, size, created_at, updated_at,
         mm_index_state, mm_index_error, mm_indexed_pages_json)
        VALUES ('file_sync_mm', 'sha_sync_mm', 'local.pdf', 1, '1', '1',
                'indexed', 'local-error', '[{"page":1}]');
      INSERT INTO exam_sheets
        (id, status, temp_id, metadata_json, preview_json, created_at, updated_at,
         mm_index_state, mm_index_error, mm_indexed_pages_json,
         mm_embedding_dim, mm_indexing_mode, mm_indexed_at)
        VALUES ('exam_sync_mm', 'completed', 'temp_sync_mm', '{}', '{}', '1', '1',
                'indexed', 'local-error', '[{"page":1}]', 128, 'local-mode', 12);
    `);
    applyDownloadedChanges(db, [
      change({
        table_name: 'files',
        record_id: 'file_sync_mm',
        data: {
          id: 'file_sync_mm',
          sha256: 'sha_sync_mm',
          file_name: 'remote.pdf',
          size: 1,
          created_at: '1',
          updated_at: '2',
          mm_index_state: 'indexed',
          mm_index_error: 'remote-error',
          mm_indexed_pages_json: [{ page: 999 }],
        },
        changed_at: '2026-05-31T00:00:00Z',
        database_name: 'vfs',
        suppress_change_log: true,
      }),
      change({
        table_name: 'exam_sheets',
        record_id: 'exam_sync_mm',
        data: {
          id: 'exam_sync_mm',
          status: 'completed',
          temp_id: 'temp_sync_mm',
          metadata_json: '{}',
          preview_json: '{}',
          created_at: '1',
          updated_at: '2',
          mm_index_state: 'indexed',
          mm_index_error: 'remote-error',
          mm_indexed_pages_json: [{ page: 999 }],
          mm_embedding_dim: 4096,
          mm_indexing_mode: 'remote-mode',
          mm_indexed_at: 999,
        },
        changed_at: '2026-05-31T00:00:00Z',
        database_name: 'vfs',
        suppress_change_log: true,
      }),
    ], { deviceId: 'device-local', allowSyncTestFixtureTables: true });

    const file = db.get<Record<string, string | null>>(
      `SELECT file_name, mm_index_state, mm_index_error, mm_indexed_pages_json
       FROM files WHERE id = 'file_sync_mm'`,
    );
    expect(file).toEqual({
      file_name: 'remote.pdf',
      mm_index_state: 'pending',
      mm_index_error: null,
      mm_indexed_pages_json: null,
    });
    const exam = db.get<Record<string, string | number | null>>(
      `SELECT mm_index_state, mm_index_error, mm_indexed_pages_json,
              mm_embedding_dim, mm_indexing_mode, mm_indexed_at
       FROM exam_sheets WHERE id = 'exam_sync_mm'`,
    );
    expect(exam).toEqual({
      mm_index_state: 'pending',
      mm_index_error: null,
      mm_indexed_pages_json: null,
      mm_embedding_dim: null,
      mm_indexing_mode: null,
      mm_indexed_at: null,
    });
    // X6-AP-0408: retain mod.rs:14590-14593 in addition to the resulting row state.
    expect(isLocalDerivedSyncColumn('exam_sheets', 'mm_indexing_mode')).toBe(true);
  });

  it('preferred_project_root_path_is_local_derived_for_session_groups', () => {
    expect(isLocalDerivedSyncColumn('chat_v2_session_groups', 'preferred_project_root_path')).toBe(true);
    expect(isLocalDerivedSyncColumn('chat_v2_session_groups', 'default_runtime_root_id')).toBe(false);
  });

  it('regression_recompute_counts_qbank_material_source_and_pinned_draft_assets', () => {
    const db = openTestDatabase();
    db.exec(`
      CREATE TABLE blobs (hash TEXT PRIMARY KEY, ref_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE qbank_materials (id TEXT PRIMARY KEY, images_json TEXT);
      CREATE TABLE qbank_sources (id TEXT PRIMARY KEY, descriptor_json TEXT);
      CREATE TABLE qbank_import_jobs (
        id TEXT PRIMARY KEY, status TEXT, document_json TEXT, metadata_json TEXT
      );
    `);
    for (const hash of ['material-img', 'source-page', 'draft-crop', 'settled-draft-crop']) {
      db.run('INSERT INTO blobs(hash, ref_count) VALUES (?1, 99)', [hash]);
    }
    db.run(`INSERT INTO qbank_materials(id, images_json) VALUES
      ('m-1', '[{"id":"att_1","hash":"material-img","role":"material"}]')`);
    db.run(`INSERT INTO qbank_sources(id, descriptor_json) VALUES
      ('s-1', '{"pages":[{"page":1,"blob_hash":"source-page"}],"content_hash":"c1"}')`);
    db.run(`INSERT INTO qbank_import_jobs(id, status, document_json, metadata_json) VALUES
      ('job-ready', 'ready', '{"questions":[{"images":[{"hash":"draft-crop"}]}]}', '{}'),
      ('job-committed', 'committed', '{"questions":[{"images":[{"hash":"settled-draft-crop"}]}]}', '{}')`);

    recomputeBlobRefCounts(db);

    const countOf = (hash: string): number => Number(
      db.pluck<number>('SELECT ref_count FROM blobs WHERE hash = ?1', [hash]),
    );
    expect(countOf('material-img')).toBe(1);
    expect(countOf('source-page')).toBe(1);
    expect(countOf('draft-crop')).toBe(1);
    expect(countOf('settled-draft-crop')).toBe(0);
  });

  it('remap_json_embedded_file_ids_rewrites_material_images_and_source_descriptors', () => {
    const aliases: IdAliasMap = new Map([['filesfile-old', 'file-new']]);
    const material: { [key: string]: import('../../../platform/util/lossless-json.ts').DbJson } = {
      images_json: '[{"id":"file-old","hash":"h1"},{"id":"file-other","hash":"h2"}]',
    };
    remapJsonEmbeddedIds(aliases, material, 'images_json', ['id']);
    const images = JSON.parse(material.images_json as string) as Array<{ id: string; hash: string }>;
    expect(images[0]?.id).toBe('file-new');
    expect(images[1]?.id).toBe('file-other');

    const source: { [key: string]: import('../../../platform/util/lossless-json.ts').DbJson } = {
      descriptor_json: '{"pages":[{"page":1,"file_id":"file-old","blob_hash":"h1"}]}',
    };
    remapJsonEmbeddedIds(aliases, source, 'descriptor_json', ['file_id', 'vfs_file_id']);
    const descriptor = JSON.parse(source.descriptor_json as string) as {
      pages: Array<{ file_id: string; blob_hash: string }>;
    };
    expect(descriptor.pages[0]?.file_id).toBe('file-new');
    expect(descriptor.pages[0]?.blob_hash).toBe('h1');
  });
});
