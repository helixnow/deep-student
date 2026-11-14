import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createTestHost } from './host-fixture.ts';
import sync from '../index.ts';
import { newBatchId } from '../src/history.ts';
import {
  ensureHistoryTable,
  listBatches,
  pruneBatchesToCap,
  snapshotRecordWithData,
} from '../repository/history.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let db: DatabaseHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-history-'));
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  db = storage.openFile(':memory:');
});
afterEach(() => {
  storage.dispose();
  rmSync(root, { recursive: true, force: true });
});

it('new_batch_id_uses_utc_compact_timestamp_and_hex_suffix', () => {
  const id = newBatchId(new Date('2026-11-03T10:19:21.123Z'));
  expect(id).toMatch(/^20261103T101921123Z-[0-9a-f]{8}$/u);
  expect(newBatchId()).not.toBe(newBatchId());
});

it('snapshot_keeps_first_state_and_distinguishes_missing_records', () => {
  ensureHistoryTable(db);
  expect(snapshotRecordWithData(db, 'batch-1', 'policy_override', 'notes', 'a', { id: 'a', content: 'before' })).toBe(true);
  expect(snapshotRecordWithData(db, 'batch-1', 'policy_override', 'notes', 'a', { id: 'a', content: 'after' })).toBe(false);
  expect(snapshotRecordWithData(db, 'batch-1', 'policy_override', 'notes', 'b', null)).toBe(true);

  const rows = db.all<{ record_id: string; existed: number; data_json: string | null }>(
    'SELECT record_id, existed, data_json FROM __sync_record_history ORDER BY id',
  );
  expect(rows).toEqual([
    { record_id: 'a', existed: 1, data_json: '{"id":"a","content":"before"}' },
    { record_id: 'b', existed: 0, data_json: null },
  ]);
});

it('prune_batches_retains_newest_by_max_row_id', () => {
  for (let i = 0; i < 5; i += 1) {
    snapshotRecordWithData(db, `batch-${i}`, 'conflict_resolve', 'notes', `n-${i}`, { id: `n-${i}` });
  }
  expect(pruneBatchesToCap(db, 2)).toBe(3);
  expect(listBatches(db, 10).map(batch => batch.batch_id)).toEqual(['batch-4', 'batch-3']);
});

it('list_batches_returns_empty_without_table_and_aggregates_rows', () => {
  expect(listBatches(db, 10)).toEqual([]);
  snapshotRecordWithData(db, 'batch-a', 'conflict_resolve', 'notes', 'n1', { id: 'n1' });
  snapshotRecordWithData(db, 'batch-a', 'conflict_resolve', 'notes', 'n2', null);
  snapshotRecordWithData(db, 'batch-b', 'rollback_undo', 'notes', 'n3', { id: 'n3' });

  const batches = listBatches(db, 10);
  expect(batches.map(batch => [batch.batch_id, batch.reason, batch.record_count, batch.rolled_back_at])).toEqual([
    ['batch-b', 'rollback_undo', 1, null],
    ['batch-a', 'conflict_resolve', 2, null],
  ]);
});

it('list_sync_snapshot_batches_merges_databases_and_applies_global_limit', async () => {
  const vfs = storage.database('vfs');
  snapshotRecordWithData(vfs, '20240101T000000000Z-aaaaaaaa', 'conflict_resolve', 'notes', 'n1', { id: 'n1' });
  const chat = storage.database('chat_v2');
  snapshotRecordWithData(chat, '20240102T000000000Z-bbbbbbbb', 'policy_override', 'messages', 'm1', { id: 'm1' });

  const host = await createTestHost({ plugins: [sync], provide: { storage, paths: { deviceId: async () => 'd' } } });
  try {
    expect(await host.invoke('data_governance_list_sync_snapshot_batches', { limit: 5 })).toEqual([
      {
        database_name: 'chat_v2',
        batch_id: '20240102T000000000Z-bbbbbbbb',
        reason: 'policy_override',
        created_at: expect.any(String),
        record_count: 1,
        rolled_back_at: null,
      },
      {
        database_name: 'vfs',
        batch_id: '20240101T000000000Z-aaaaaaaa',
        reason: 'conflict_resolve',
        created_at: expect.any(String),
        record_count: 1,
        rolled_back_at: null,
      },
    ]);
    const limited = await host.invoke<Array<{ batch_id: string }>>('data_governance_list_sync_snapshot_batches', { limit: 1 });
    expect(limited.map(row => row.batch_id)).toEqual(['20240102T000000000Z-bbbbbbbb']);
  } finally {
    await host.dispose();
  }
});

it('purge_resolved_conflicts_uses_default_30_days_and_ignores_broken_tables', async () => {
  const vfs = storage.database('vfs');
  vfs.exec('CREATE TABLE __sync_conflicts (id INTEGER PRIMARY KEY, resolved_at TEXT)');
  vfs.run("INSERT INTO __sync_conflicts (id, resolved_at) VALUES (1, '2020-01-01T00:00:00Z'), (2, '2999-01-01T00:00:00Z'), (3, NULL)");
  const chat = storage.database('chat_v2');
  chat.exec('CREATE TABLE __sync_conflicts (id INTEGER PRIMARY KEY, unrelated TEXT)');
  const mistakes = storage.database('mistakes');
  mistakes.exec('CREATE TABLE __sync_conflicts (id INTEGER PRIMARY KEY, resolved_at TEXT)');
  mistakes.run("INSERT INTO __sync_conflicts (id, resolved_at) VALUES (1, '2020-02-02T00:00:00Z')");

  const host = await createTestHost({ plugins: [sync], provide: { storage, paths: { deviceId: async () => 'd' } } });
  try {
    expect(await host.invoke('data_governance_purge_resolved_conflicts')).toBe(2);
    expect(vfs.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts')).toBe(2);
    expect(mistakes.pluck<number>('SELECT COUNT(*) FROM __sync_conflicts')).toBe(0);
  } finally {
    await host.dispose();
  }
});
