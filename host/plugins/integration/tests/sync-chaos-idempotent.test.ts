import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L20 同步插件，经其公开 SyncService 验证幂等混沌
import syncPlugin from '../../sync/index.ts';
import { createTestHost, openTestDatabase, type TestDatabase } from './sync-fixture.ts';
import { createPayloadCodec, type EngineChange, type FilePayloadCodec, type SyncService } from '../../sync/api.ts';
import { createMemorySyncState } from './sync-chaos-helpers.ts';
import { MemoryCloud } from './memory-cloud.ts';

/**
 * `sync_r10_chaos_idempotent.rs` 的 TS 行为级移植。
 *
 * 用真实 L20 上传/下载/应用实现验证：重试风暴在应用前坍缩、崩溃重放幂等、
 * 游标提交后不重复消费且新增分片仍可增量消费。
 */
const hosts: TestHost[] = [];
const codecs: FilePayloadCodec[] = [];
afterEach(async () => {
  for (const codec of codecs.splice(0)) codec.dispose();
  for (const host of hosts.splice(0)) await host.dispose();
});

interface Fixture {
  host: TestHost;
  sync: SyncService;
  codec: FilePayloadCodec;
}

async function setup(): Promise<Fixture> {
  const { state } = createMemorySyncState();
  const host = await createTestHost({
    plugins: [syncPlugin],
    provide: { syncSupport: { state } },
  });
  hosts.push(host);
  const created = await createPayloadCodec(undefined, null);
  codecs.push(created);
  return { host, sync: host.ctx.sync, codec: created };
}

function uniqueDevice(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function change(
  operation: 'Insert' | 'Update',
  recordId: string,
  content: string,
  updatedAt: string,
): EngineChange {
  return {
    table_name: 'items_records',
    record_id: recordId,
    operation,
    data: { id: recordId, content, updated_at: updatedAt },
    changed_at: updatedAt,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: null,
    source_seq: null,
  };
}

function sampleChanges(tag: string): EngineChange[] {
  return [
    change('Insert', `${tag}-a`, 'alpha-v1', '2026-07-10T12:00:00Z'),
    change('Insert', `${tag}-b`, 'beta-v1', '2026-07-10T12:00:00Z'),
    change('Update', `${tag}-a`, 'alpha-v2', '2026-07-10T12:30:00Z'),
  ];
}

function newDb(): TestDatabase {
  const db = openTestDatabase();
  db.exec(`
    CREATE TABLE items_records (
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
    CREATE TRIGGER trg_items_records_insert
    AFTER INSERT ON items_records
    BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('items_records', NEW.id, 'INSERT');
    END;
    CREATE TRIGGER trg_items_records_update
    AFTER UPDATE ON items_records
    BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('items_records', NEW.id, 'UPDATE');
    END;
    CREATE TRIGGER trg_items_records_delete
    AFTER DELETE ON items_records
    BEGIN
        INSERT INTO __change_log(table_name, record_id, operation)
        VALUES('items_records', OLD.id, 'DELETE');
    END;
  `);
  return db;
}

type Row = { id: string; content: string; updated_at: string };

function allRows(db: TestDatabase): Row[] {
  return db.all<Row>('SELECT id, content, updated_at FROM items_records ORDER BY id');
}

function pendingCount(sync: SyncService, db: TestDatabase): number {
  return sync.getPendingChanges(db, null, null).total_count;
}

function apply(sync: SyncService, db: TestDatabase, deviceId: string, changes: readonly EngineChange[]) {
  return sync.applyDownloadedChanges(db, changes, { deviceId, allowSyncTestFixtureTables: true });
}

describe('sync_r10_chaos_idempotent.rs', () => {
  it('r10_chaos_upload_retry_storm_collapses_before_apply', async () => {
    const { sync, codec } = await setup();
    const storage = new MemoryCloud('memory-r10-idem-storm');
    const uploader = uniqueDevice('r10-idem-storm-src');
    const downloader = uniqueDevice('r10-idem-storm-dst');
    const changes = sampleChanges('storm');

    for (let round = 0; round < 3; round += 1) {
      await sync.uploadEnrichedChanges(storage, changes, { deviceId: uploader, codec });
    }
    const shardKeys = storage.keys().filter(key => key.startsWith('data_governance/changes/'));
    expect(shardKeys).toHaveLength(3);

    const downloaded = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    expect(downloaded.decode_failures).toEqual([]);
    expect(downloaded.changes).toHaveLength(changes.length);

    const db = newDb();
    const applied = apply(sync, db, downloader, downloaded.changes);
    expect(applied.failure_count).toBe(0);
    expect(allRows(db)).toEqual([
      { id: 'storm-a', content: 'alpha-v2', updated_at: '2026-07-10T12:30:00Z' },
      { id: 'storm-b', content: 'beta-v1', updated_at: '2026-07-10T12:00:00Z' },
    ]);
    expect(pendingCount(sync, db)).toBe(0);
  });

  it('r10_chaos_reapply_same_batch_after_crash_is_idempotent', async () => {
    const { sync, codec } = await setup();
    const storage = new MemoryCloud('memory-r10-idem-crash');
    const uploader = uniqueDevice('r10-idem-crash-src');
    const downloader = uniqueDevice('r10-idem-crash-dst');
    await sync.uploadEnrichedChanges(storage, sampleChanges('crash'), { deviceId: uploader, codec });

    const db = newDb();
    const first = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    const appliedFirst = apply(sync, db, downloader, first.changes);
    expect(appliedFirst.failure_count).toBe(0);
    const rowsAfterFirst = allRows(db);

    const second = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    expect(second.changes).toHaveLength(first.changes.length);

    const reapplied = apply(sync, db, downloader, second.changes);
    expect(reapplied.failure_count).toBe(0);
    expect(allRows(db)).toEqual(rowsAfterFirst);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM items_records'))).toBe(2);
    expect(pendingCount(sync, db)).toBe(0);
  });

  it('r10_chaos_committed_cursor_prevents_reconsumption', async () => {
    const { sync, codec } = await setup();
    const storage = new MemoryCloud('memory-r10-idem-cursor');
    const uploader = uniqueDevice('r10-idem-cursor-src');
    const downloader = uniqueDevice('r10-idem-cursor-dst');
    const changes = sampleChanges('cursor');
    await sync.uploadEnrichedChanges(storage, changes, { deviceId: uploader, codec });

    const db = newDb();
    const first = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    expect(first.changes).toHaveLength(changes.length);
    const appliedFirst = apply(sync, db, downloader, first.changes);
    expect(appliedFirst.failure_count).toBe(0);

    await sync.commitDownloadProgress(storage, first, { deviceId: downloader, codec });

    const afterCommit = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    expect(afterCommit.changes).toEqual([]);

    await sync.uploadEnrichedChanges(
      storage,
      [change('Update', 'cursor-b', 'beta-v2', '2026-07-10T13:00:00Z')],
      { deviceId: uploader, codec },
    );
    const incremental = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    expect(incremental.changes).toHaveLength(1);
    expect(incremental.changes[0]!.record_id).toBe('cursor-b');
    const applied = apply(sync, db, downloader, incremental.changes);
    expect(applied.failure_count).toBe(0);
    expect(allRows(db)).toEqual([
      { id: 'cursor-a', content: 'alpha-v2', updated_at: '2026-07-10T12:30:00Z' },
      { id: 'cursor-b', content: 'beta-v2', updated_at: '2026-07-10T13:00:00Z' },
    ]);
  });
});
