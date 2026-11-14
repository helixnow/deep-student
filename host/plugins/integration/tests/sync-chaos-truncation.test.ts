import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { compression } from '../../../platform/native/compression/index.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L20 同步插件，经其公开 SyncService 验证截断混沌
import syncPlugin from '../../sync/index.ts';
import { createTestHost, openTestDatabase, type TestDatabase } from './sync-fixture.ts';
import { createPayloadCodec, type EngineChange, type SyncService } from '../../sync/api.ts';
import { HiddenListCloud, createMemorySyncState } from './sync-chaos-helpers.ts';

/**
 * `sync_r10_chaos_truncation.rs` 的 TS 行为级移植。
 *
 * 用真实 L20 `downloadChanges` 对可篡改的内存 CloudStorage 验证：
 * 诚实截断立即拒绝、静默丢中段停在安全点、静默丢尾部不丢数据且恢复后可继续。
 */
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});

interface Fixture {
  host: TestHost;
  sync: SyncService;
  codec: Awaited<ReturnType<typeof createPayloadCodec>>;
}

async function setup(): Promise<Fixture> {
  const { state } = createMemorySyncState();
  const host = await createTestHost({
    plugins: [syncPlugin],
    provide: { syncSupport: { state } },
  });
  hosts.push(host);
  return { host, sync: host.ctx.sync, codec: await createPayloadCodec(undefined, null) };
}

function uniqueDevice(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function change(recordId: string, content: string, updatedAt: string): EngineChange {
  return {
    table_name: 'items_records',
    record_id: recordId,
    operation: 'Insert',
    data: { id: recordId, content, updated_at: updatedAt },
    changed_at: updatedAt,
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: null,
    source_seq: null,
  };
}

async function seedTwoShards(
  sync: SyncService,
  codec: Fixture['codec'],
  storage: HiddenListCloud,
  uploader: string,
): Promise<string[]> {
  await sync.uploadEnrichedChanges(storage, [change('rec-one', 'first', '2026-07-10T12:00:00Z')], { deviceId: uploader, codec });
  await sync.uploadEnrichedChanges(storage, [change('rec-two', 'second', '2026-07-10T12:10:00Z')], { deviceId: uploader, codec });
  const keys = storage.keys().filter(key => key.startsWith('data_governance/changes/'));
  expect(keys).toHaveLength(2);
  return keys.sort();
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
  `);
  return db;
}

describe('sync_r10_chaos_truncation.rs', () => {
  it('r10_chaos_honest_list_truncation_flag_fails_closed', async () => {
    const { sync, codec } = await setup();
    const storage = new HiddenListCloud('memory-r10-trunc-honest');
    const uploader = uniqueDevice('r10-trunc-honest-src');
    await seedTwoShards(sync, codec, storage, uploader);

    storage.truncatedPrefixes.add('data_governance/changes');
    const downloader = uniqueDevice('r10-trunc-honest-dst');
    await expect(sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec }))
      .rejects.toThrow('截断');

    storage.truncatedPrefixes.clear();
    const downloaded = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    expect(downloaded.changes).toHaveLength(2);
  });

  it('r10_chaos_silent_truncation_hiding_earlier_seq_stops_at_safe_point', async () => {
    const { sync, codec } = await setup();
    const storage = new HiddenListCloud('memory-r10-trunc-gap');
    const uploader = uniqueDevice('r10-trunc-gap-src');
    const keys = await seedTwoShards(sync, codec, storage, uploader);

    storage.hide(keys[0]!);
    const downloader = uniqueDevice('r10-trunc-gap-dst');
    await expect(sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec }))
      .rejects.toThrow('缺少序号');

    storage.unhide(keys[0]!);
    const downloaded = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    expect(downloaded.changes.map(item => item.record_id)).toEqual(['rec-one', 'rec-two']);
  });

  it('r10_chaos_silent_truncation_hiding_tail_seq_does_not_lose_data', async () => {
    const { sync, codec } = await setup();
    const storage = new HiddenListCloud('memory-r10-trunc-tail');
    const uploader = uniqueDevice('r10-trunc-tail-src');
    const keys = await seedTwoShards(sync, codec, storage, uploader);

    storage.hide(keys[1]!);
    const downloader = uniqueDevice('r10-trunc-tail-dst');
    const first = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    expect(first.changes.map(item => item.record_id)).toEqual(['rec-one']);

    const db = newDb();
    const appliedFirst = sync.applyDownloadedChanges(db, first.changes, {
      deviceId: downloader,
      allowSyncTestFixtureTables: true,
    });
    expect(appliedFirst.failure_count).toBe(0);
    await sync.commitDownloadProgress(storage, first, { deviceId: downloader, codec });

    storage.unhide(keys[1]!);
    const second = await sync.downloadChanges(storage, 0n, null, { deviceId: downloader, codec });
    expect(second.changes.map(item => item.record_id)).toEqual(['rec-two']);
    const appliedSecond = sync.applyDownloadedChanges(db, second.changes, {
      deviceId: downloader,
      allowSyncTestFixtureTables: true,
    });
    expect(appliedSecond.failure_count).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM items_records'))).toBe(2);
  });
});
