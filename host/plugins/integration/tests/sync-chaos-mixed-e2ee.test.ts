import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import { createBackupCrypto, isEncryptedBackup } from '../../../platform/secrets/backup-crypto.ts';
import { deviceIdShortHash } from '../../sync-providers/api.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L20 同步插件，经其公开 SyncService 验证混合 E2EE 混沌
import syncPlugin from '../../sync/index.ts';
import { createTestHost, openTestDatabase, type TestDatabase } from './sync-fixture.ts';
import { createPayloadCodec, type EngineChange, type FilePayloadCodec, type SyncService } from '../../sync/api.ts';
import { createMemorySyncState } from './sync-chaos-helpers.ts';
import { MemoryCloud } from './memory-cloud.ts';

/**
 * `sync_r10_chaos_mixed_e2ee.rs` 的 TS 行为级移植。
 *
 * 用真实 L20 `uploadEnrichedChanges` 生成 DSBK 密文流，再向同一设备目录注入
 * 明文 v3 分片，验证带密码/无密码/错密码客户端的 fail-closed 与修复后恢复。
 */
const PASSWORD = 'r10-chaos-mixed-e2ee-password';

const hosts: TestHost[] = [];
const codecs: FilePayloadCodec[] = [];
afterEach(async () => {
  for (const codec of codecs.splice(0)) codec.dispose();
  for (const host of hosts.splice(0)) await host.dispose();
});

interface Fixture {
  host: TestHost;
  sync: SyncService;
}

async function setup(): Promise<Fixture> {
  const { state } = createMemorySyncState();
  const host = await createTestHost({
    plugins: [syncPlugin],
    provide: { syncSupport: { state } },
  });
  hosts.push(host);
  return { host, sync: host.ctx.sync };
}

async function codec(password: string | null): Promise<FilePayloadCodec> {
  const created = await createPayloadCodec(createBackupCrypto(), password);
  codecs.push(created);
  return created;
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

interface DowngradeScene {
  storage: MemoryCloud;
  uploader: string;
  seq1Key: string;
  seq2Key: string;
}

async function seedMidstreamDowngrade(sync: SyncService, uploaderCodec: FilePayloadCodec): Promise<DowngradeScene> {
  const storage = new MemoryCloud('memory-r10-mixed-e2ee');
  const uploader = uniqueDevice('r10-mixed-enc');
  await sync.uploadEnrichedChanges(
    storage,
    [change('mixed-legit', 'encrypted-payload', '2026-07-10T12:00:00Z')],
    { deviceId: uploader, codec: uploaderCodec },
  );

  const prefix = `data_governance/changes/${deviceIdShortHash(uploader)}/`;
  const seq1Keys = storage.keys().filter(key => key.startsWith(prefix));
  expect(seq1Keys).toHaveLength(1);
  const seq1Key = seq1Keys[0]!;
  expect(isEncryptedBackup(storage.bytes(seq1Key)!)).toBe(true);

  const seq2Key = `${prefix}000000000002-${Math.floor(Date.now() / 1000)}-${randomUUID()}.json.zst`;
  const payload = JSON.stringify({
    total_count: 1,
    changes: [change('mixed-injected', 'plaintext-downgrade', '2026-07-10T12:30:00Z')],
    device_id: uploader,
    format_version: 3,
    source_seq: 2,
    source_device_id: uploader,
    operation_id: null,
  });
  storage.insertRaw(seq2Key, await compression.zstdEncode(Buffer.from(payload)));
  return { storage, uploader, seq1Key, seq2Key };
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

describe('sync_r10_chaos_mixed_e2ee.rs', () => {
  it('r10_chaos_midstream_plaintext_downgrade_fails_closed', async () => {
    const { sync } = await setup();
    const scene = await seedMidstreamDowngrade(sync, await codec(PASSWORD));
    const target = uniqueDevice('r10-mixed-target');

    let message = '';
    try { await sync.downloadChanges(scene.storage, 0n, null, { deviceId: target, codec: await codec(PASSWORD) }); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain(scene.seq2Key);
    expect(message).toContain('DSBK');

    const db = newDb();
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM items_records'))).toBe(0);
  });

  it('r10_chaos_no_password_client_stops_at_encrypted_shard', async () => {
    const { sync } = await setup();
    const scene = await seedMidstreamDowngrade(sync, await codec(PASSWORD));

    let message = '';
    try { await sync.downloadChanges(scene.storage, 0n, null, { deviceId: uniqueDevice('r10-mixed-nopass'), codec: await codec(null) }); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain(scene.seq1Key);
    expect(message).toContain('密码');
  });

  it('r10_chaos_wrong_password_client_fails_closed_at_first_shard', async () => {
    const { sync } = await setup();
    const scene = await seedMidstreamDowngrade(sync, await codec(PASSWORD));

    let message = '';
    try {
      await sync.downloadChanges(scene.storage, 0n, null, {
        deviceId: uniqueDevice('r10-mixed-wrongpass'),
        codec: await codec('totally-wrong-password'),
      });
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain(scene.seq1Key);
    expect(/解密|密码/u.test(message)).toBe(true);
  });

  it('r10_chaos_removing_injected_plaintext_restores_full_consumption', async () => {
    const { sync } = await setup();
    const scene = await seedMidstreamDowngrade(sync, await codec(PASSWORD));
    const target = uniqueDevice('r10-mixed-recover');
    const targetCodec = await codec(PASSWORD);

    await expect(sync.downloadChanges(scene.storage, 0n, null, { deviceId: target, codec: targetCodec }))
      .rejects.toThrow(scene.seq2Key);

    scene.storage.removeRaw(scene.seq2Key);
    const downloaded = await sync.downloadChanges(scene.storage, 0n, null, { deviceId: target, codec: targetCodec });
    expect(downloaded.changes).toHaveLength(1);
    expect(downloaded.changes[0]!.record_id).toBe('mixed-legit');

    const db = newDb();
    const applied = sync.applyDownloadedChanges(db, downloaded.changes, {
      deviceId: target,
      allowSyncTestFixtureTables: true,
    });
    expect(applied.failure_count).toBe(0);
    expect(Number(db.pluck<number>('SELECT COUNT(*) FROM items_records'))).toBe(1);
    expect(db.pluck<string>("SELECT content FROM items_records WHERE id='mixed-legit'")).toBe('encrypted-payload');
  });
});
