import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { TestHost } from '../../../kernel/testing.ts';
import { compression } from '../../../platform/native/compression/index.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { deviceIdShortHash } from '../../sync-providers/api.ts';
// boundary-allow cross-plugin-impl: L22 集成测试需安装真实 L20 同步插件，经其公开 SyncService 验证记录级路径
import syncPlugin from '../../sync/index.ts';
import { createTestHost } from './sync-fixture.ts';
import {
  createPayloadCodec,
  type EngineChange,
  type SyncManifest,
  type SyncService,
} from '../../sync/api.ts';
import { MemoryCloud } from './memory-cloud.ts';

/**
 * `sync_r12_record_path_names.rs` 的 TS 行为级移植。
 *
 * 直接驱动 L20 发布的生产 `SyncService`（uploadEnrichedChanges / uploadManifest /
 * downloadChanges / executeDownload），断言新写入使用短哈希目录，旧明文目录仍可读。
 * 不复制 key 构造算法：期望前缀由 L23 `deviceIdShortHash` 计算。
 */
let host: TestHost;
let sync: SyncService;
const codec = await createPayloadCodec(undefined, null);
let nextSeq = 1n;
const cursors = new Map<string, bigint>();
const legacyProcessed = new Set<string>();

const state = {
  bindInstance: () => undefined,
  nextUploadSeq: () => nextSeq,
  markPublishedSeq: () => undefined,
  deviceRotationsForNew: () => [] as [string, string][],
  publishedMaxSeq: () => 0n,
  cursors: () => new Map(cursors),
  getCursor: (_instanceId: string, deviceId: string) => cursors.get(deviceId) ?? 0n,
  setCursor: (_instanceId: string, deviceId: string, seq: bigint) => { cursors.set(deviceId, seq); },
  isLegacyProcessed: (_instanceId: string, key: string) => legacyProcessed.has(key),
  markLegacyProcessed: (_instanceId: string, key: string) => { legacyProcessed.add(key); },
};

beforeAll(async () => {
  host = await createTestHost({
    plugins: [syncPlugin],
    provide: {
      notes: {},
      backup: {},
      syncProvider: {},
      secrets: { backup: createBackupCrypto() },
      vfsDatabase: { isInMaintenanceMode: () => false },
      syncSupport: { state },
      nativeCompression: compression,
    },
  });
  sync = host.ctx.sync;
});

afterAll(async () => {
  codec.dispose();
  await host?.dispose();
});

function uniqueDevice(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function change(recordId: string, content: string): EngineChange {
  return {
    table_name: 'items',
    record_id: recordId,
    operation: 'Insert',
    data: { id: recordId, content, updated_at: '2026-08-25T00:00:00Z' },
    changed_at: '2026-08-25T00:00:00Z',
    change_log_id: null,
    database_name: 'vfs',
    suppress_change_log: true,
    source_device_id: null,
    source_seq: null,
  };
}

function sampleManifest(
  deviceId: string,
  dataVersion: number,
  publishedMaxSeq: number,
  checksum = 'abc',
): SyncManifest {
  return {
    sync_transaction_id: `tx-${deviceId}`,
    databases: {
      vfs: { schema_version: 1, data_version: dataVersion, checksum, last_updated_at: null },
    },
    status: 'Complete',
    created_at: '2026-08-25T00:00:00Z',
    device_id: deviceId,
    format_version: 4,
    published_max_seq: publishedMaxSeq,
    cursors: {},
    superseded_by: null,
    snapshot_seen: {},
  };
}

function hashedChangePrefix(deviceId: string): string {
  return `data_governance/changes/${deviceIdShortHash(deviceId)}/`;
}

function hashedManifestKey(deviceId: string): string {
  return `data_governance/manifests/${deviceIdShortHash(deviceId)}.json`;
}

function legacyManifestKey(deviceId: string): string {
  return `data_governance/manifests/${deviceId}.json`;
}

async function plantV3Change(
  storage: MemoryCloud,
  pathDevice: string,
  payloadDevice: string,
  seq: number,
  content: string,
): Promise<void> {
  const key = `data_governance/changes/${pathDevice}/${String(seq).padStart(12, '0')}-${Math.floor(Date.now() / 1000)}-${randomUUID()}.json.zst`;
  const payload = JSON.stringify({
    total_count: 1,
    changes: [change(`r${seq}`, content)],
    device_id: payloadDevice,
    format_version: 3,
    source_seq: seq,
    source_device_id: payloadDevice,
    operation_id: null,
  });
  storage.insertRaw(key, await compression.zstdEncode(Buffer.from(payload)));
}

it('new_upload_uses_hashed_change_and_manifest_names', async () => {
  const storage = new MemoryCloud();
  const device = uniqueDevice('r12-rec-src');
  await sync.uploadEnrichedChanges(storage, [change('n1', 'hashed-write')], { deviceId: device, codec });
  await sync.uploadManifest(storage, sampleManifest(device, 3, 0), { deviceId: device, codec });

  const hashedChanges = storage.keys().filter(key => key.startsWith(hashedChangePrefix(device)));
  expect(hashedChanges).toHaveLength(1);
  expect(hashedChanges[0]).not.toContain(device);

  const rawChanges = storage.keys().filter(key => key.startsWith(`data_governance/changes/${device}/`));
  expect(rawChanges).toEqual([]);

  expect(storage.bytes(hashedManifestKey(device))).not.toBeNull();
  expect(storage.bytes(legacyManifestKey(device))).toBeNull();
});

it('new_client_reads_legacy_raw_change_and_manifest', async () => {
  const storage = new MemoryCloud();
  const peer = uniqueDevice('r12-rec-legacy-peer');
  await plantV3Change(storage, peer, peer, 1, 'legacy-raw');
  storage.insertRaw(legacyManifestKey(peer), JSON.stringify(sampleManifest(peer, 9, 1)));

  const local = uniqueDevice('r12-rec-legacy-local');
  const downloaded = await sync.downloadChanges(storage, 0n, null, { deviceId: local, codec });
  expect(downloaded.changes).toHaveLength(1);
  expect((downloaded.changes[0]!.data as Record<string, unknown>).content).toBe('legacy-raw');

  // L20 公开面没有 downloadManifest；executeDownload 走同一条清单合并生产路径。
  // 本地 vfs=8 与旧明文清单 vfs=9 的版本差会被 detectConflicts 计为 1 个冲突，
  // 从而证明旧明文清单确实被读取并合并。
  const [result] = await sync.executeDownload(
    storage,
    sampleManifest(local, 8, 0, 'local'),
    'KeepLatest',
    { deviceId: local, codec },
  );
  expect(result.changes_downloaded).toBe(1);
  expect(result.conflicts_detected).toBe(1);
});

it('download_skips_own_hashed_change_and_manifest', async () => {
  const storage = new MemoryCloud();
  const device = uniqueDevice('r12-rec-self');
  await sync.uploadEnrichedChanges(storage, [change('self-1', 'own')], { deviceId: device, codec });
  await sync.uploadManifest(storage, sampleManifest(device, 4, 0), { deviceId: device, codec });

  const ownDownload = await sync.downloadChanges(storage, 0n, null, { deviceId: device, codec });
  expect(ownDownload.changes).toEqual([]);

  // 自己的清单必须按设备别名跳过：若误并进云端状态，vfs=0 的本地清单会出现冲突。
  const [ownResult] = await sync.executeDownload(
    storage,
    sampleManifest(device, 0, 0, 'self'),
    'KeepLatest',
    { deviceId: device, codec },
  );
  expect(ownResult.conflicts_detected).toBe(0);

  const peer = uniqueDevice('r12-rec-peer');
  const peerDownload = await sync.downloadChanges(storage, 0n, null, { deviceId: peer, codec });
  expect(peerDownload.changes).toHaveLength(1);
  const [peerResult] = await sync.executeDownload(
    storage,
    sampleManifest(peer, 0, 0, 'peer'),
    'KeepLatest',
    { deviceId: peer, codec },
  );
  expect(peerResult.conflicts_detected).toBe(1);
});

it('upload_manifest_migrates_legacy_raw_name', async () => {
  const storage = new MemoryCloud();
  const device = uniqueDevice('r12-rec-migrate');
  storage.insertRaw(legacyManifestKey(device), JSON.stringify(sampleManifest(device, 2, 0)));

  await sync.uploadManifest(storage, sampleManifest(device, 5, 0), { deviceId: device, codec });

  expect(storage.bytes(hashedManifestKey(device))).not.toBeNull();
  expect(storage.bytes(legacyManifestKey(device))).toBeNull();
});

it('mixed_raw_and_hashed_shards_are_one_device_stream', async () => {
  const storage = new MemoryCloud();
  const peer = uniqueDevice('r12-rec-mixed');
  await plantV3Change(storage, peer, peer, 1, 'raw-seq1');

  nextSeq = 2n;
  try {
    await sync.uploadEnrichedChanges(storage, [change('r2', 'hashed-seq2')], { deviceId: peer, codec });
  } finally {
    nextSeq = 1n;
  }

  const hashed = storage.keys().filter(key => key.startsWith(hashedChangePrefix(peer)));
  expect(hashed).toHaveLength(1);
  const raw = storage.keys().filter(key => key.startsWith(`data_governance/changes/${peer}/`));
  expect(raw).toHaveLength(1);

  const local = uniqueDevice('r12-rec-mixed-dst');
  const downloaded = await sync.downloadChanges(storage, 0n, null, { deviceId: local, codec });
  expect(downloaded.changes).toHaveLength(2);
  const contents = downloaded.changes.map(item => (item.data as Record<string, unknown>).content);
  expect(contents).toContain('raw-seq1');
  expect(contents).toContain('hashed-seq2');
});

it('hashed_payload_device_id_still_full_and_readable', async () => {
  const storage = new MemoryCloud();
  const device = uniqueDevice('r12-rec-payload');
  await sync.uploadEnrichedChanges(storage, [change('p1', 'inside')], { deviceId: device, codec });

  const key = storage.keys().find(candidate => candidate.startsWith(hashedChangePrefix(device)));
  expect(key).toBeDefined();
  const bytes = storage.bytes(key!);
  expect(bytes).not.toBeNull();
  const decoded = await compression.zstdDecode(bytes!);
  const payload = JSON.parse(Buffer.from(decoded).toString('utf8')) as Record<string, unknown>;
  expect(payload.source_device_id).toBe(device);
  expect(payload.device_id).toBe(device);
});

class CorruptManifestCloud extends MemoryCloud {
  override async put(key: string, data: Uint8Array): Promise<void> {
    if (key.startsWith('data_governance/manifests/') && key.endsWith('.json')) {
      await super.put(key, Buffer.from('corrupted-record-manifest'));
    } else {
      await super.put(key, data);
    }
  }
}

it('upload_manifest_fails_when_reread_mismatches', async () => {
  const storage = new CorruptManifestCloud();
  const device = uniqueDevice('r12-rec-reread');
  const error = await sync.uploadManifest(storage, sampleManifest(device, 1, 0), { deviceId: device, codec })
    .then(() => { throw new Error('清单回读不一致必须 fail-closed'); }, (reason: unknown) => String(reason));
  expect(error).toContain('记录级设备清单 上传后回读不一致');
  expect(storage.bytes(hashedManifestKey(device))).not.toBeNull();
});
