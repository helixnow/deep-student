import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type {
  AssetTombstones,
  BlobTombstoneEntry,
  BlobTombstones,
  TombstoneEvent,
  WorkspaceTombstones,
  ProviderTombstoneStorage,
} from '../api.ts';
import { plainCodec } from '../src/codec.ts';
import { adaptTombstoneStorage } from '../api.ts';
import type { CloudStorage } from '../../sync-providers/api.ts';
import { SqliteSyncStateStore } from '../src/state.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import {
  BLOB_TOMBSTONE_PREFIX,
  createTombstoneSupport,
  assetDeviceTombstoneKey,
  applyBlobTombstones as applyBlobTombstonesWithLogger,
  blobDeviceTombstoneKey,
  blobDeviceTombstoneLegacyKey,
  decodeTombstoneFile,
  deletedAtIsNewer,
  downloadAssetTombstonesAfter as downloadAssetTombstonesAfterWithLogger,
  downloadBlobTombstones as downloadBlobTombstonesWithLogger,
  downloadBlobTombstonesAfter as downloadBlobTombstonesAfterWithLogger,
  downloadBlobTombstonesForDevice,
  downloadEvents,
  eventDevicePrefix,
  eventKey,
  eventKeyMatches,
  eventLegacyKey,
  eventOperationId,
  eventPayloadHash,
  eventSeqFromKey,
  filterAssetTombstonesAfter as filterAssetTombstonesAfterWithLogger,
  filterBlobTombstonesAfter as filterBlobTombstonesAfterWithLogger,
  filterWorkspaceTombstonesAfter,
  findBlobByHashWith,
  normalizeBlobManifest,
  parseTombstoneEvent,
  pruneTombstones,
  publishEvents,
  sourceDeviceFromTombstoneEntries,
  tombstoneDevicePathId,
  tombstoneOffsetFromDeletedAt,
  uploadAssetTombstones as uploadAssetTombstonesWithLogger,
  uploadBlobTombstones as uploadBlobTombstonesWithLogger,
  type TombstoneLogger,
} from '../src/tombstones.ts';
import { MemoryStorage } from './memory-storage.ts';
import { tempDirLocalFiles } from './local-files.ts';
import { openTestDatabase } from './test-db.ts';

// 仅注入日志接收器；每个测试仍执行同一个生产函数。
const logger: TombstoneLogger = { warn: vi.fn(), info: vi.fn() };
function withLogger<A extends unknown[], R>(fn: (...args: [...A, TombstoneLogger]) => R) {
  return (...args: A): R => fn(...args, logger);
}
type ApplyArgs = Parameters<typeof applyBlobTombstonesWithLogger>;
const applyBlobTombstones = (...args: [ApplyArgs[0], ApplyArgs[1], ApplyArgs[2], ApplyArgs[3], ApplyArgs[4]]) =>
  applyBlobTombstonesWithLogger(...args, logger, tempDirLocalFiles());
const downloadAssetTombstonesAfter = withLogger(downloadAssetTombstonesAfterWithLogger);
const downloadBlobTombstones = withLogger(downloadBlobTombstonesWithLogger);
const downloadBlobTombstonesAfter = withLogger(downloadBlobTombstonesAfterWithLogger);
const filterAssetTombstonesAfter = withLogger(filterAssetTombstonesAfterWithLogger);
const filterBlobTombstonesAfter = withLogger(filterBlobTombstonesAfterWithLogger);
const uploadAssetTombstones = withLogger(uploadAssetTombstonesWithLogger);
const uploadBlobTombstones = withLogger(uploadBlobTombstonesWithLogger);

function state(): SqliteSyncStateStore {
  return new SqliteSyncStateStore(openTestDatabase());
}

function blobEntry(deletedAt: string, deviceId = 'device-a', extra: Partial<BlobTombstoneEntry> = {}): BlobTombstoneEntry {
  return { deleted_at: deletedAt, device_id: deviceId, size: null, relative_path: null, ...extra };
}

function sampleBlobTombstones(deviceId: string): BlobTombstones {
  return {
    entries: { ['aa'.repeat(32)]: blobEntry('2026-08-01T00:00:00Z', deviceId) },
    updated_at: '',
  };
}

function rawManifest(entries: Record<string, BlobTombstoneEntry>, updatedAt = ''): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify({ entries, updated_at: updatedAt }), 'utf8'));
}

function makeEvent(device: string, seq: bigint, objectId: string, deletedAt: string): TombstoneEvent {
  const event: TombstoneEvent = {
    format_version: 4,
    device_id: device,
    seq,
    operation_id: eventOperationId('blobs', device, objectId, deletedAt),
    kind: 'blobs',
    object_id: objectId,
    deleted_at: deletedAt,
    size: null,
    relative_path: null,
    payload_hash: '',
  };
  event.payload_hash = eventPayloadHash(event);
  return event;
}

function eventJson(event: TombstoneEvent): Uint8Array {
  return new Uint8Array(Buffer.from(JSON.stringify({
    format_version: event.format_version,
    device_id: event.device_id,
    seq: Number(event.seq),
    operation_id: event.operation_id,
    kind: event.kind,
    object_id: event.object_id,
    deleted_at: event.deleted_at,
    size: event.size,
    relative_path: event.relative_path,
    payload_hash: event.payload_hash,
  }), 'utf8'));
}

describe('tombstone (tombstone.rs)', () => {
  it('adapts the published provider API without changing the original storage contract', async () => {
    const memory = new MemoryStorage();
    expectTypeOf<CloudStorage>().toExtend<ProviderTombstoneStorage>();
    const provider: ProviderTombstoneStorage = {
      instanceBindingHint: () => memory.instanceBindingHint(),
      listOutcome: prefix => memory.listOutcome(prefix),
      put: (key, data) => memory.put(key, data),
      get: key => memory.get(key),
      delete: key => memory.delete(key),
      stat: key => memory.stat(key),
    };
    const storage = adaptTombstoneStorage(provider);
    expect(storage.instance_binding_hint()).toBe('memory-test');
    const manifest = sampleBlobTombstones('provider-device');
    await uploadBlobTombstones(storage, plainCodec, state(), 'provider-device', manifest);
    expect((await downloadBlobTombstones(storage, plainCodec)).entries).toEqual(manifest.entries);
    expect((await storage.list_outcome(BLOB_TOMBSTONE_PREFIX)).files).not.toHaveLength(0);
  });

  it('test_prune_tombstones_retains_expired_without_authoritative_snapshot', () => {
    const map = new Map<string, BlobTombstoneEntry>([
      ['old', blobEntry(new Date(Date.now() - 120 * 86_400_000).toISOString(), 'd1')],
      ['fresh', blobEntry(new Date().toISOString(), 'd1')],
    ]);
    const removed = pruneTombstones(map, 90, entry => entry.deleted_at);
    expect(removed).toBe(0);
    expect(map.has('fresh')).toBe(true);
    expect(map.has('old')).toBe(true);
  });

  it('watermark_never_filters_same_millisecond_or_clock_rewind_tombstones', () => {
    const sameMillis = '2026-05-01T00:00:00.123Z';
    const older = '2026-04-30T23:59:59.000Z';
    const watermark = tombstoneOffsetFromDeletedAt(sameMillis);

    const blobs: BlobTombstones = {
      entries: { same: blobEntry(sameMillis), rewind: blobEntry(older) },
      updated_at: '',
    };
    expect(Object.keys(filterBlobTombstonesAfter(blobs, watermark)[0].entries)).toHaveLength(2);

    const assets: AssetTombstones = {
      entries: { same: { deleted_at: sameMillis, device_id: 'device-a', size: null } },
      updated_at: '',
    };
    expect(Object.hasOwn(filterAssetTombstonesAfter(assets, watermark)[0].entries, 'same')).toBe(true);

    const workspaces: WorkspaceTombstones = {
      entries: { rewind: { deleted_at: older, device_id: 'device-a' } },
      updated_at: '',
    };
    expect(Object.hasOwn(filterWorkspaceTombstonesAfter(workspaces, watermark)[0].entries, 'rewind')).toBe(true);
  });

  it('malformed_tombstone_manifest_fails_closed', () => {
    const malformed = new Uint8Array(Buffer.from('{"entries":{"broken":]}}', 'utf8'));
    let message = '';
    try {
      decodeTombstoneFile(plainCodec, malformed, 'blob');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('未推进水位');
    // serde 形状校验：显式 null、错误字段类型、u64 越界都不得被当作空清单。
    expect(() => normalizeBlobManifest(null)).toThrow();
    expect(() => normalizeBlobManifest({ entries: null, updated_at: '' })).toThrow();
    expect(() => normalizeBlobManifest({
      entries: { bad: { deleted_at: '2026-05-01T00:00:00Z', device_id: 'd', size: -1 } },
      updated_at: '',
    })).toThrow();
    expect(() => parseTombstoneEvent({
      format_version: null,
      device_id: 'd',
      seq: 1,
      operation_id: 'op',
      kind: 'blobs',
      object_id: 'o',
      deleted_at: '2026-05-01T00:00:00Z',
    })).toThrow();
  });

  it('sub_millisecond_deleted_at_orders_like_chrono', () => {
    // Rust 比较 chrono DateTime 全精度；Node Date 只有毫秒，不能把不同纳秒
    // 的两次删除误判为同一时刻。
    expect(deletedAtIsNewer(
      '2026-05-01T00:00:00.123456789Z',
      '2026-05-01T00:00:00.123000000Z',
    )).toBe(true);
    expect(deletedAtIsNewer(
      '2026-05-01T00:00:00.123000000Z',
      '2026-05-01T00:00:00.123456789Z',
    )).toBe(false);
    expect(deletedAtIsNewer(
      '2026-05-01T00:00:01.000000001Z',
      '2026-05-01T00:00:00.999999999Z',
    )).toBe(true);
  });

  it('test_find_blob_by_hash', async () => {
    const files = tempDirLocalFiles();
    const findBlobByHash = (blobsDir: string, hash: string) => findBlobByHashWith(files, blobsDir, hash);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-support-blobs-'));
    try {
      const hash = 'ab'.repeat(32);
      const missing = 'cd'.repeat(32);
      fs.mkdirSync(path.join(dir, 'ab'));
      fs.writeFileSync(path.join(dir, 'ab', `${hash}.pdf`), 'x');
      const found = await findBlobByHash(dir, hash);
      expect(found).not.toBeNull();
      expect(path.basename(found!)).toBe(`${hash}.pdf`);
      expect(await findBlobByHash(dir, missing)).toBeNull();
      expect(await findBlobByHash(dir, 'a')).toBeNull();
      expect(await findBlobByHash(dir, 'abhash123')).toBeNull();
      expect(await findBlobByHash(dir, `zz${'c'.repeat(62)}`)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('test_blob_tombstones_roundtrip', () => {
    const manifest: BlobTombstones = {
      entries: {
        hash1: {
          deleted_at: '2026-05-01T00:00:00Z',
          device_id: 'dev1',
          size: 1024,
          relative_path: 'ha/hash1',
        },
      },
      updated_at: '',
    };
    const back = normalizeBlobManifest(JSON.parse(JSON.stringify({
      entries: { hash1: { ...manifest.entries.hash1, size: 1024 } },
      updated_at: '',
    })) as unknown);
    expect(back).not.toBeNull();
    expect(Object.keys(back!.entries)).toHaveLength(1);
    expect(back!.entries.hash1!.device_id).toBe('dev1');
  });

  it('immutable_event_identity_and_key_are_stable', () => {
    const operationId = eventOperationId(
      'assets', 'device-a', 'active/images/a.png', '2026-07-20T00:00:00Z',
    );
    expect(operationId).toHaveLength(64);
    expect(operationId).toBe(eventOperationId(
      'assets', 'device-a', 'active/images/a.png', '2026-07-20T00:00:00Z',
    ));
    const event: TombstoneEvent = {
      format_version: 4,
      device_id: 'device-a',
      seq: 1n,
      operation_id: operationId,
      kind: 'assets',
      object_id: 'active/images/a.png',
      deleted_at: '2026-07-20T00:00:00Z',
      size: 3n,
      relative_path: null,
      payload_hash: '',
    };
    event.payload_hash = eventPayloadHash(event);
    const key = eventKey(event);
    expect(key.startsWith(`data_governance/tombstone-events/assets/${tombstoneDevicePathId('device-a')}/`)).toBe(true);
    expect(key.includes('device-a')).toBe(false);
    expect(eventSeqFromKey(key)).toBe(1n);
    const back = parseTombstoneEvent(JSON.parse(JSON.stringify({
      ...event, seq: 1, size: 3,
    })) as unknown);
    expect(back).toEqual(event);
  });

  it.each(['blob', 'asset', 'workspace'] as const)(
    'per_device_tombstone_manifests_reread_after_put (%s)', async kind => {
      // Rust 的 source-lock 表达三种清单都必须通过回读闸；TS 直接验证这个不变量。
      class ObservedStorage extends MemoryStorage {
        readonly operations: { operation: string; key: string }[] = [];
        override async put(key: string, data: Uint8Array): Promise<void> {
          this.operations.push({ operation: 'put', key });
          await super.put(key, data);
        }
        override async get(key: string): Promise<Uint8Array | null> {
          this.operations.push({ operation: 'get', key });
          return super.get(key);
        }
      }
      const db = openTestDatabase();
      const support = createTombstoneSupport(new SqliteSyncStateStore(db), logger);
      const cases = {
        blob: { upload: support.uploadBlobTombstones, key: support.blobDeviceTombstoneKey },
        asset: { upload: support.uploadAssetTombstones, key: support.assetDeviceTombstoneKey },
        workspace: { upload: support.uploadWorkspaceTombstones, key: support.workspaceDeviceTombstoneKey },
      };
      const device = `readback-${kind}`;
      const { upload, key } = cases[kind];
      try {
        for (const behavior of ['normal', 'corrupt-manifest', 'drop-manifest'] as const) {
          const storage = new ObservedStorage();
          storage.behavior = behavior;
          const result = upload(storage, plainCodec, device, { entries: {}, updated_at: '' });
          if (behavior === 'normal') {
            await expect(result).resolves.toBeUndefined();
          } else {
            await expect(result).rejects.toThrow(`${kind} tombstone 清单 上传后${
              behavior === 'corrupt-manifest' ? '回读不一致' : '对象不存在'
            }`);
          }
          const putIndex = storage.operations.findIndex(op => op.operation === 'put' && op.key === key(device));
          expect(putIndex).toBeGreaterThanOrEqual(0);
          expect(storage.operations[putIndex + 1]).toEqual({ operation: 'get', key: key(device) });
        }
      } finally {
        db.raw.close();
      }
    },
  );

  it('upload_blob_tombstones_fails_when_reread_mismatches', async () => {
    const storage = new MemoryStorage();
    const device = 'r12-tomb-reread-mismatch-device';
    const legacy = blobDeviceTombstoneLegacyKey(device);
    storage.files.set(legacy, rawManifest({}, 'legacy'));
    storage.behavior = 'corrupt-manifest';

    await expect(uploadBlobTombstones(storage, plainCodec, state(), device, sampleBlobTombstones(device)))
      .rejects.toThrow('blob tombstone 清单 上传后回读不一致');
    expect(await storage.get(blobDeviceTombstoneKey(device))).not.toBeNull();
    expect(await storage.get(legacy)).not.toBeNull();
  });

  it('upload_blob_tombstones_fails_when_missing_after_put', async () => {
    const storage = new MemoryStorage();
    storage.behavior = 'drop-manifest';
    const device = 'r12-tomb-reread-missing-device';
    await expect(uploadBlobTombstones(storage, plainCodec, state(), device, sampleBlobTombstones(device)))
      .rejects.toThrow('blob tombstone 清单 上传后对象不存在');
    expect(await storage.get(blobDeviceTombstoneKey(device))).toBeNull();
  });

  it('bad_or_future_deleted_at_is_skipped_and_never_advances_watermark', () => {
    const valid = toRfc3339(BigInt(Date.now() - 5 * 60_000) * 1_000_000n);
    const future = toRfc3339(BigInt(Date.now() + 2 * 3_600_000) * 1_000_000n);
    const garbage = 'not-a-timestamp';
    const validOffset = tombstoneOffsetFromDeletedAt(valid);
    expect(tombstoneOffsetFromDeletedAt(future) > validOffset).toBe(true);

    const blobs: BlobTombstones = {
      entries: { good: blobEntry(valid), future: blobEntry(future), garbage: blobEntry(garbage) },
      updated_at: '',
    };
    const [blobFiltered, blobOffset] = filterBlobTombstonesAfter(blobs, 0n);
    expect(Object.keys(blobFiltered.entries)).toEqual(['good']);
    expect(blobOffset).toBe(validOffset);

    const assets: AssetTombstones = {
      entries: {
        'active/images/good.png': { deleted_at: valid, device_id: 'device-a', size: null },
        'active/images/future.png': { deleted_at: future, device_id: 'device-a', size: null },
        'active/images/garbage.png': { deleted_at: garbage, device_id: 'device-a', size: null },
      },
      updated_at: '',
    };
    const [assetFiltered, assetOffset] = filterAssetTombstonesAfter(assets, 0n);
    expect(Object.keys(assetFiltered.entries)).toEqual(['active/images/good.png']);
    expect(assetOffset).toBe(validOffset);
  });

  it('apply_blob_tombstones_skips_bad_clock_entries_without_failing_batch', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-support-apply-'));
    try {
      const goodHash = 'aa'.repeat(32);
      const futureHash = 'bb'.repeat(32);
      const garbageHash = 'cc'.repeat(32);
      fs.mkdirSync(path.join(dir, 'aa'));
      fs.mkdirSync(path.join(dir, 'bb'));
      const goodFile = path.join(dir, 'aa', `${goodHash}.png`);
      const futureFile = path.join(dir, 'bb', `${futureHash}.png`);
      fs.writeFileSync(goodFile, 'good');
      fs.writeFileSync(futureFile, 'future');

      const tombstones: BlobTombstones = {
        entries: {
          [goodHash]: blobEntry(toRfc3339(BigInt(Date.now() + 30_000) * 1_000_000n), 'device-a', {
            relative_path: `aa/${goodHash}.png`,
          }),
          [futureHash]: blobEntry(toRfc3339(BigInt(Date.now() + 2 * 3_600_000) * 1_000_000n), 'device-a', {
            relative_path: `bb/${futureHash}.png`,
          }),
          [garbageHash]: blobEntry('not-a-timestamp'),
        },
        updated_at: '',
      };
      const affected = await applyBlobTombstones(
        new MemoryStorage(), tombstones, dir, 'blobs', true,
      );
      expect(affected).toEqual([goodHash]);
      expect(fs.existsSync(goodFile)).toBe(false);
      expect(fs.existsSync(futureFile)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('event_watermark_stops_before_bad_clock_event', async () => {
    const storage = new MemoryStorage();
    const device = 'device-a';
    const past = toRfc3339(BigInt(Date.now() - 5 * 60_000) * 1_000_000n);
    const future = toRfc3339(BigInt(Date.now() + 2 * 3_600_000) * 1_000_000n);
    const laterPast = toRfc3339(BigInt(Date.now() - 60_000) * 1_000_000n);
    for (const event of [
      makeEvent(device, 1n, 'h1', past),
      makeEvent(device, 2n, 'h2', future),
      makeEvent(device, 3n, 'h3', laterPast),
    ]) {
      await storage.put(eventKey(event), eventJson(event));
    }

    const [merged, advances] = await downloadBlobTombstonesAfter(storage, plainCodec, () => 0n);
    expect(Object.keys(merged.entries).sort()).toEqual(['h1', 'h3']);
    expect(advances).toHaveLength(1);
    expect(advances[0]!.source_device_id).toBe('event:device-a');
    expect(advances[0]!.last_applied_offset).toBe(1n);
  });

  it('download_blob_tombstones_after_excludes_bad_entries_from_merge_and_watermark', async () => {
    const storage = new MemoryStorage();
    const past = toRfc3339(BigInt(Date.now() - 5 * 60_000) * 1_000_000n);
    const future = toRfc3339(BigInt(Date.now() + 2 * 3_600_000) * 1_000_000n);
    await storage.put(blobDeviceTombstoneKey('device-a'), rawManifest({
      good: blobEntry(past),
      future: blobEntry(future),
    }));

    const [merged, advances] = await downloadBlobTombstonesAfter(storage, plainCodec, () => 0n);
    expect(Object.hasOwn(merged.entries, 'good')).toBe(true);
    expect(Object.hasOwn(merged.entries, 'future')).toBe(false);
    const advance = advances.find(item => item.source_device_id === 'device-a');
    expect(advance).toBeDefined();
    expect(advance!.last_applied_offset).toBe(tombstoneOffsetFromDeletedAt(past));
    expect(advances.some(item => item.source_device_id === tombstoneDevicePathId('device-a'))).toBe(false);
  });

  it('tombstone_watermark_source_uses_content_device_id', () => {
    const hashedKey = blobDeviceTombstoneKey('device-a');
    const legacyKey = blobDeviceTombstoneLegacyKey('device-a');
    expect(sourceDeviceFromTombstoneEntries(hashedKey, BLOB_TOMBSTONE_PREFIX, ['device-a'])).toBe('device-a');
    expect(sourceDeviceFromTombstoneEntries(legacyKey, BLOB_TOMBSTONE_PREFIX, ['device-a'])).toBe('device-a');
    expect(() => sourceDeviceFromTombstoneEntries(hashedKey, BLOB_TOMBSTONE_PREFIX, ['device-b'])).toThrow();
    expect(() => sourceDeviceFromTombstoneEntries(hashedKey, BLOB_TOMBSTONE_PREFIX, ['device-a', 'device-b'])).toThrow();
    expect(() => sourceDeviceFromTombstoneEntries(hashedKey, BLOB_TOMBSTONE_PREFIX, [''])).toThrow();
  });

  it('download_blob_tombstones_after_reads_legacy_raw_name_as_same_device', async () => {
    const storage = new MemoryStorage();
    const past = toRfc3339(BigInt(Date.now() - 5 * 60_000) * 1_000_000n);
    await storage.put(blobDeviceTombstoneLegacyKey('device-a'), rawManifest({ 'legacy-good': blobEntry(past) }));

    const [, advances] = await downloadBlobTombstonesAfter(storage, plainCodec, () => 0n);
    expect(advances).toHaveLength(1);
    expect(advances[0]!.source_device_id).toBe('device-a');
    expect(advances[0]!.last_applied_offset).toBe(tombstoneOffsetFromDeletedAt(past));
  });

  it('download_blob_tombstones_after_rejects_path_content_mismatch', async () => {
    const storage = new MemoryStorage();
    const past = toRfc3339(BigInt(Date.now() - 5 * 60_000) * 1_000_000n);
    await storage.put(blobDeviceTombstoneKey('device-a'), rawManifest({ spoof: blobEntry(past, 'device-b') }));
    await expect(downloadBlobTombstonesAfter(storage, plainCodec, () => 0n)).rejects.toThrow('路径与内容');
  });

  it('tombstone_device_keys_use_short_hash_not_raw_id', () => {
    const hashed = tombstoneDevicePathId('device-a');
    expect(hashed).toHaveLength(16);
    expect(hashed).not.toBe('device-a');
    expect(blobDeviceTombstoneKey('device-a')).toBe(`${BLOB_TOMBSTONE_PREFIX}${hashed}.json`);
    expect(blobDeviceTombstoneLegacyKey('device-a')).toBe('data_governance/tombstones/blobs/device-a.json');
    expect(eventKeyMatches({
      format_version: 4,
      device_id: 'device-a',
      seq: 1n,
      operation_id: 'op',
      kind: 'blobs',
      object_id: 'h',
      deleted_at: '2026-01-01T00:00:00Z',
      size: null,
      relative_path: null,
      payload_hash: '',
    }, 'data_governance/tombstone-events/blobs/device-a/00000000000000000001-op.json')).toBe(true);
  });

  it('download_own_blob_tombstone_reads_legacy_raw_name', async () => {
    const storage = new MemoryStorage();
    await storage.put(blobDeviceTombstoneLegacyKey('device-a'), rawManifest({
      'legacy-hash': blobEntry('2026-08-01T00:00:00Z'),
    }));
    const loaded = await downloadBlobTombstonesForDevice(storage, plainCodec, 'device-a');
    expect(Object.hasOwn(loaded.entries, 'legacy-hash')).toBe(true);
  });

  it('upload_blob_tombstone_migrates_legacy_raw_name', async () => {
    const storage = new MemoryStorage();
    await storage.put(blobDeviceTombstoneLegacyKey('device-a'), rawManifest({
      old: blobEntry('2026-08-01T00:00:00Z'),
    }));
    await uploadBlobTombstones(storage, plainCodec, state(), 'device-a', {
      entries: { new: blobEntry('2026-08-02T00:00:00Z') },
      updated_at: '',
    });
    expect(await storage.get(blobDeviceTombstoneKey('device-a'))).not.toBeNull();
    expect(await storage.get(blobDeviceTombstoneLegacyKey('device-a'))).toBeNull();
  });

  it('publish_events_continues_seq_from_legacy_raw_prefix', async () => {
    const storage = new MemoryStorage();
    const device = 'r12-tomb-seq-continue-device';
    const existing = makeEvent(device, 1n, 'old-obj', '2026-08-01T00:00:00Z');
    await storage.put(eventLegacyKey(existing), eventJson(existing));

    await publishEvents(storage, plainCodec, state(), device, 'blobs', [{
      objectId: 'new-obj', deletedAt: '2026-08-02T00:00:00Z', size: null, relativePath: null,
    }]);

    const hashedKeys = (await storage.listOutcome(eventDevicePrefix('blobs', device))).files;
    expect(hashedKeys).toHaveLength(1);
    expect(eventSeqFromKey(hashedKeys[0]!.key)).toBe(2n);

    const downloaded = await downloadEvents(storage, plainCodec, 'blobs');
    expect(downloaded).toHaveLength(2);
    expect(downloaded[0]!.seq).toBe(1n);
    expect(downloaded[1]!.seq).toBe(2n);
  });

  it('torn_blob_dual_write_retry_converges_without_duplicate_event', async () => {
    const storage = new MemoryStorage();
    storage.behavior = 'fail-manifest';
    const device = 'r7-tomb-torn-retry-device';
    const hash = 'aa'.repeat(32);

    await expect(uploadBlobTombstones(storage, plainCodec, state(), device, sampleBlobTombstones(device)))
      .rejects.toThrow('blob tombstone 清单 上传失败');

    let eventKeys = (await storage.listOutcome(eventDevicePrefix('blobs', device))).files;
    expect(eventKeys).toHaveLength(1);
    expect(eventSeqFromKey(eventKeys[0]!.key)).toBe(1n);
    expect(await storage.get(blobDeviceTombstoneKey(device))).toBeNull();

    const mergedWhileTorn = await downloadBlobTombstones(storage, plainCodec);
    expect(Object.hasOwn(mergedWhileTorn.entries, hash)).toBe(true);

    storage.behavior = 'normal';
    await uploadBlobTombstones(storage, plainCodec, state(), device, sampleBlobTombstones(device));

    eventKeys = (await storage.listOutcome(eventDevicePrefix('blobs', device))).files;
    expect(eventKeys).toHaveLength(1);
    expect(eventSeqFromKey(eventKeys[0]!.key)).toBe(1n);
    expect(await storage.get(blobDeviceTombstoneKey(device))).not.toBeNull();

    const [merged, advances] = await downloadBlobTombstonesAfter(storage, plainCodec, () => 0n);
    expect(Object.keys(merged.entries)).toHaveLength(1);
    expect(advances.some(item => item.source_device_id === `event:${device}`
      && item.last_applied_offset === 1n)).toBe(true);
  });

  it('interleaved_blob_dual_writes_extend_stream_without_gap_or_duplicate', async () => {
    const storage = new MemoryStorage();
    storage.behavior = 'fail-manifest';
    const device = 'r7-tomb-interleave-extend-device';
    const firstHash = 'aa'.repeat(32);
    const secondHash = 'bb'.repeat(32);

    await expect(uploadBlobTombstones(storage, plainCodec, state(), device, sampleBlobTombstones(device)))
      .rejects.toThrow('blob tombstone 清单 上传失败');

    storage.behavior = 'normal';
    const mergedManifest = sampleBlobTombstones(device);
    mergedManifest.entries[secondHash] = blobEntry('2026-08-02T00:00:00Z', device);
    await uploadBlobTombstones(storage, plainCodec, state(), device, mergedManifest);

    const events = await downloadEvents(storage, plainCodec, 'blobs');
    expect(events).toHaveLength(2);
    expect(events[0]!.seq).toBe(1n);
    expect(events[0]!.object_id).toBe(firstHash);
    expect(events[1]!.seq).toBe(2n);
    expect(events[1]!.object_id).toBe(secondHash);

    const [merged, advances] = await downloadBlobTombstonesAfter(storage, plainCodec, () => 0n);
    expect(Object.hasOwn(merged.entries, firstHash)).toBe(true);
    expect(Object.hasOwn(merged.entries, secondHash)).toBe(true);
    expect(advances.some(item => item.source_device_id === `event:${device}`
      && item.last_applied_offset === 2n)).toBe(true);
  });

  it('cross_device_dual_write_interleaving_keeps_streams_independent', async () => {
    const storage = new MemoryStorage();
    storage.behavior = 'fail-manifest';
    const deviceA = 'r7-tomb-cross-device-a';
    const deviceB = 'r7-tomb-cross-device-b';

    await expect(uploadBlobTombstones(storage, plainCodec, state(), deviceA, sampleBlobTombstones(deviceA)))
      .rejects.toThrow('blob tombstone 清单 上传失败');

    storage.behavior = 'normal';
    await uploadBlobTombstones(storage, plainCodec, state(), deviceB, {
      entries: { ['bb'.repeat(32)]: blobEntry('2026-08-02T00:00:00Z', deviceB) },
      updated_at: '',
    });
    await uploadBlobTombstones(storage, plainCodec, state(), deviceA, sampleBlobTombstones(deviceA));

    for (const device of [deviceA, deviceB]) {
      const keys = (await storage.listOutcome(eventDevicePrefix('blobs', device))).files;
      expect(keys).toHaveLength(1);
      expect(eventSeqFromKey(keys[0]!.key)).toBe(1n);
    }

    const [merged, advances] = await downloadBlobTombstonesAfter(storage, plainCodec, () => 0n);
    expect(Object.hasOwn(merged.entries, 'aa'.repeat(32))).toBe(true);
    expect(Object.hasOwn(merged.entries, 'bb'.repeat(32))).toBe(true);
    for (const device of [deviceA, deviceB]) {
      expect(advances.some(item => item.source_device_id === `event:${device}`
        && item.last_applied_offset === 1n)).toBe(true);
    }
  });

  it('torn_asset_dual_write_retry_converges_without_duplicate_event', async () => {
    const storage = new MemoryStorage();
    storage.behavior = 'fail-manifest';
    const device = 'r7-tomb-torn-asset-device';
    const object = 'active/images/r7-torn.png';
    const manifest: AssetTombstones = {
      entries: { [object]: { deleted_at: '2026-08-01T00:00:00Z', device_id: device, size: 3 } },
      updated_at: '',
    };

    await expect(uploadAssetTombstones(storage, plainCodec, state(), device, manifest))
      .rejects.toThrow('asset tombstone 清单 上传失败');
    expect(await storage.get(assetDeviceTombstoneKey(device))).toBeNull();

    storage.behavior = 'normal';
    await uploadAssetTombstones(storage, plainCodec, state(), device, manifest);

    const keys = (await storage.listOutcome(eventDevicePrefix('assets', device))).files;
    expect(keys).toHaveLength(1);
    expect(eventSeqFromKey(keys[0]!.key)).toBe(1n);

    const [merged, advances] = await downloadAssetTombstonesAfter(storage, plainCodec, () => 0n);
    expect(Object.keys(merged.entries)).toHaveLength(1);
    expect(merged.entries[object]!.size).toBe(3n);
    expect(advances.some(item => item.source_device_id === `event:${device}`
      && item.last_applied_offset === 1n)).toBe(true);
  });

  it('conflicting_same_operation_rewrite_fails_closed_and_keeps_original_event', async () => {
    const storage = new MemoryStorage();
    const device = 'r7-tomb-conflicting-rewrite-device';
    const hash = 'cc'.repeat(32);
    const deletedAt = '2026-08-03T00:00:00Z';

    await uploadBlobTombstones(storage, plainCodec, state(), device, {
      entries: { [hash]: blobEntry(deletedAt, device) },
      updated_at: '',
    });
    const manifestBytes = await storage.get(blobDeviceTombstoneKey(device));
    expect(manifestBytes).not.toBeNull();

    await expect(uploadBlobTombstones(storage, plainCodec, state(), device, {
      entries: { [hash]: blobEntry(deletedAt, device, { size: 7 }) },
      updated_at: '',
    })).rejects.toThrow('冲突且内容不同');

    const events = await downloadEvents(storage, plainCodec, 'blobs');
    expect(events).toHaveLength(1);
    expect(events[0]!.size).toBeNull();
    expect(await storage.get(blobDeviceTombstoneKey(device))).toEqual(manifestBytes);
  });
});
