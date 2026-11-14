/**
 * [L23/R06+R07 port] 单侧 DELETE 冲突的写入形状与解决闭环。
 *
 * Rust 源：`tests/sync_r06_delete_resolve_tests.rs`、
 * `tests/sync_r07_delete_resolve_lock_tests.rs`。
 *
 * Rust fixture 的 `items(id, content, updated_at)` 在 Host 中没有注册为
 * RowSync；这里改用真实注册的 `note_learning_relations`（vfs，Lww，无
 * `deleted_at`），保持原断言：LWW 败方 DELETE 只写一行 `side='cloud'` /
 * `data_json='null'`，本地行原样保留；keep_local、keep_cloud、
 * merged+null 与 expected_conflict_ids 失配四条出口全部按原断言执行。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createStorageService, type StorageService } from '../../../platform/storage/service.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import sync from '../../sync/index.ts';
import type { EngineChange } from '../../sync/api.ts';

const DEVICE_ID = 'device-local';
let root: string;
let storage: StorageService;
let host: TestHost;

function unused(service: string): object {
  return new Proxy({}, {
    get: (_target, key) => {
      if (typeof key === 'symbol' || key === 'then') return undefined;
      throw new Error(`test unexpectedly entered ${service}.${String(key)}`);
    },
  });
}

const VFS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS note_learning_relations (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL DEFAULT '',
    block_id TEXT,
    relation_type TEXT NOT NULL DEFAULT 'source',
    resource_id TEXT NOT NULL DEFAULT '',
    locator_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL DEFAULT 1,
    invalidated_at TEXT,
    created_at TEXT NOT NULL DEFAULT '2026-07-10T13:00:00Z',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS __change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    record_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
    changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    sync_version INTEGER DEFAULT 0
  );
`;

function openVfs(): DatabaseHandle {
  const vfsPath = storage.pathOf('vfs');
  mkdirSync(dirname(vfsPath), { recursive: true });
  const db = storage.openFile(vfsPath, { profile: 'plain' });
  db.exec(VFS_SCHEMA);
  return db;
}

function insertLocalRelation(db: DatabaseHandle, recordId: string): void {
  db.run(
    `INSERT INTO note_learning_relations
       (id, note_id, relation_type, resource_id, updated_at)
     VALUES (?1, 'note-local', 'source', 'kept-local', '2026-07-10T13:00:00Z')`,
    [recordId],
  );
}

function staleDeleteChange(recordId: string, sourceSeq: number): EngineChange {
  return {
    table_name: 'note_learning_relations',
    record_id: recordId,
    operation: 'Delete',
    data: null,
    // Rust: 早于本地 updated_at（13:00Z）→ 输掉 LWW 门。
    changed_at: '2026-07-10T12:00:00Z',
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: 'device-slow',
    source_seq: sourceSeq,
  };
}

function unresolvedConflictRows(db: DatabaseHandle, recordId: string): Array<{
  id: number; side: string; data_json: string;
}> {
  return db.all<{ id: number; side: string; data_json: string }>(
    `SELECT id, side, data_json FROM __sync_conflicts
     WHERE table_name='note_learning_relations' AND record_id=?1 AND resolved_at IS NULL
     ORDER BY id ASC`,
    [recordId],
  );
}

function recordResourceId(db: DatabaseHandle, recordId: string): string | null {
  return db.pluck<string | null>(
    `SELECT resource_id FROM note_learning_relations WHERE id=?1`,
    [recordId],
  ) ?? null;
}

/** Rust `seed_one_sided_delete_conflict`：返回未解决冲突 id（恰好一个）。 */
function seedOneSidedDeleteConflict(db: DatabaseHandle, recordId: string, sourceSeq: number): number[] {
  insertLocalRelation(db, recordId);
  const { apply } = host.ctx.sync.applyDownloadedChangesWithConflictGuard(
    db,
    [staleDeleteChange(recordId, sourceSeq)],
    { deviceId: DEVICE_ID },
    { policy: 'KeepLatest', cloudDeviceId: 'device-slow', localDeviceId: DEVICE_ID },
  );
  expect(apply.success_count).toBe(0);
  expect(apply.failure_count).toBe(0);

  const rows = unresolvedConflictRows(db, recordId);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.side).toBe('cloud');
  expect(rows[0]!.data_json).toBe('null');
  return [rows[0]!.id];
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'l23-delete-resolve-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  host = await createTestHost();
  host.ctx.provide('storage', storage);
  host.ctx.provide('paths', { deviceId: async () => DEVICE_ID });
  host.ctx.provide('secrets', { backup: createBackupCrypto() });
  host.ctx.provide('nativeCompression', compression);
  host.ctx.provide('backup', {
    tryAcquireOperation: () => ({ release: () => undefined }),
  });
  host.ctx.provide('syncProvider', unused('syncProvider'));
  host.ctx.provide('syncSupport', unused('syncSupport'));
  host.ctx.provide('vfsDatabase', { isInMaintenanceMode: () => false });
  host.ctx.provide('notes', unused('notes'));
  host.ctx.provide('vfsRepo', unused('vfsRepo'));
  // These engine-only cases never enter the mastery rebuild/import path.
  host.ctx.provide('mastery', unused('mastery'));
  await host.install(sync);
  openVfs();
});

afterAll(async () => {
  await host?.dispose();
  (storage as StorageService & { dispose(): void } | undefined)?.dispose();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('sync R06 delete resolve', () => {
  it('r06_lww_gate_losing_delete_writes_only_cloud_side_snapshot', () => {
    const db = openVfs();
    seedOneSidedDeleteConflict(db, 'rec-shape', 1);

    expect(Number(db.pluck(
      `SELECT COUNT(*) FROM __sync_conflicts
       WHERE table_name='note_learning_relations' AND record_id='rec-shape' AND side='local'`,
    ) ?? 0)).toBe(0);
    expect(recordResourceId(db, 'rec-shape')).toBe('kept-local');
  });

  it('r06_one_sided_delete_conflict_should_be_resolvable', () => {
    const recordId = 'r06-fix-rec';
    const db = openVfs();
    const expectedIds = seedOneSidedDeleteConflict(db, recordId, 202);

    host.ctx.sync.resolveRecordConflict({
      databaseName: 'vfs',
      tableName: 'note_learning_relations',
      recordId,
      resolution: 'keep_local',
      mergedDataJson: null,
      expectedConflictIds: expectedIds,
    });

    expect(unresolvedConflictRows(db, recordId)).toHaveLength(0);
    expect(Number(db.pluck(
      `SELECT COUNT(*) FROM __sync_conflicts
       WHERE table_name='note_learning_relations' AND record_id=?1
         AND resolved_at IS NOT NULL AND resolution='keep_local'`,
      [recordId],
    ) ?? 0)).toBeGreaterThanOrEqual(1);
    expect(recordResourceId(db, recordId)).toBe('kept-local');
    expect(host.ctx.sync.listRecordConflicts().some(row =>
      row.database_name === 'vfs' && row.record_id === recordId)).toBe(false);
  });
});

describe('sync R07 delete resolve lock', () => {
  it('r07_one_sided_delete_conflict_keep_cloud_applies_delete', () => {
    const recordId = 'r07-keep-cloud-rec';
    const db = openVfs();
    const expectedIds = seedOneSidedDeleteConflict(db, recordId, 701);

    host.ctx.sync.resolveRecordConflict({
      databaseName: 'vfs',
      tableName: 'note_learning_relations',
      recordId,
      resolution: 'keep_cloud',
      mergedDataJson: null,
      expectedConflictIds: expectedIds,
    });

    expect(recordResourceId(db, recordId)).toBeNull();
    expect(unresolvedConflictRows(db, recordId)).toHaveLength(0);
    expect(Number(db.pluck(
      `SELECT COUNT(*) FROM __sync_conflicts
       WHERE table_name='note_learning_relations' AND record_id=?1
         AND resolved_at IS NOT NULL AND resolution='keep_cloud'`,
      [recordId],
    ) ?? 0)).toBeGreaterThanOrEqual(1);
    expect(host.ctx.sync.listRecordConflicts().some(row =>
      row.database_name === 'vfs' && row.record_id === recordId)).toBe(false);
  });

  it('r07_one_sided_delete_conflict_merged_null_applies_delete', () => {
    const recordId = 'r07-merged-null-rec';
    const db = openVfs();
    const expectedIds = seedOneSidedDeleteConflict(db, recordId, 702);

    host.ctx.sync.resolveRecordConflict({
      databaseName: 'vfs',
      tableName: 'note_learning_relations',
      recordId,
      resolution: 'merged',
      mergedDataJson: 'null',
      expectedConflictIds: expectedIds,
    });

    expect(recordResourceId(db, recordId)).toBeNull();
    expect(unresolvedConflictRows(db, recordId)).toHaveLength(0);
    expect(Number(db.pluck(
      `SELECT COUNT(*) FROM __sync_conflicts
       WHERE table_name='note_learning_relations' AND record_id=?1
         AND resolved_at IS NOT NULL AND resolution='merged'`,
      [recordId],
    ) ?? 0)).toBeGreaterThanOrEqual(1);
  });

  it('r07_one_sided_delete_conflict_stale_expected_ids_rejected_without_side_effects', () => {
    const recordId = 'r07-stale-ids-rec';
    const db = openVfs();
    const expectedIds = seedOneSidedDeleteConflict(db, recordId, 703);

    expect(() => host.ctx.sync.resolveRecordConflict({
      databaseName: 'vfs',
      tableName: 'note_learning_relations',
      recordId,
      resolution: 'keep_cloud',
      mergedDataJson: null,
      expectedConflictIds: [expectedIds[0]! + 999_999],
    })).toThrow(/刷新/);

    expect(recordResourceId(db, recordId)).toBe('kept-local');
    expect(unresolvedConflictRows(db, recordId)).toHaveLength(1);

    host.ctx.sync.resolveRecordConflict({
      databaseName: 'vfs',
      tableName: 'note_learning_relations',
      recordId,
      resolution: 'keep_local',
      mergedDataJson: null,
      expectedConflictIds: expectedIds,
    });
    expect(unresolvedConflictRows(db, recordId)).toHaveLength(0);
    expect(recordResourceId(db, recordId)).toBe('kept-local');
  });
});
