import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ASSET_TOMBSTONE_PREFIX,
  BLOB_TOMBSTONE_PREFIX,
  blobDeviceTombstoneKey,
  blobDeviceTombstoneLegacyKey,
  decodeTombstoneFile,
  eventKey,
  eventKeyMatches,
  eventOperationFromKey,
  eventOperationId,
  eventPayloadHash,
  eventSeqFromKey,
  filterAssetTombstonesAfter,
  filterBlobTombstonesAfter,
  filterWorkspaceTombstonesAfter,
  findBlobByHash,
  mergeBlobTombstones,
  plainCodec,
  pruneTombstones,
  sourceDeviceFromTombstoneEntries,
  tombstoneDevicePathId,
  tombstoneOffsetFromDeletedAt,
  type BlobTombstoneEntry,
  type BlobTombstones,
  type TombstoneEvent,
} from '../repository/tombstone.ts';

describe('tombstone', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('test_prune_tombstones_retains_expired_without_authoritative_snapshot', () => {
    const old = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    const entries: Record<string, BlobTombstoneEntry> = {
      old: { deleted_at: old, device_id: 'd1' },
      fresh: { deleted_at: fresh, device_id: 'd1' },
    };
    const removed = pruneTombstones(entries, 90, entry => entry.deleted_at);
    expect(removed).toBe(0);
    expect(Object.hasOwn(entries, 'fresh')).toBe(true);
    expect(Object.hasOwn(entries, 'old')).toBe(true);
  });

  it('watermark_never_filters_same_millisecond_or_clock_rewind_tombstones', () => {
    const sameMillis = '2026-05-01T00:00:00.123Z';
    const older = '2026-04-30T23:59:59.000Z';
    const watermark = tombstoneOffsetFromDeletedAt(sameMillis);

    const blobs: BlobTombstones = {
      entries: {
        same: { deleted_at: sameMillis, device_id: 'device-a' },
        rewind: { deleted_at: older, device_id: 'device-a' },
      },
      updated_at: '',
    };
    const [filteredBlobs] = filterBlobTombstonesAfter(blobs, watermark);
    expect(Object.keys(filteredBlobs.entries)).toHaveLength(2);

    const [filteredAssets] = filterAssetTombstonesAfter({
      entries: { same: { deleted_at: sameMillis, device_id: 'device-a' } },
      updated_at: '',
    }, watermark);
    expect(Object.hasOwn(filteredAssets.entries, 'same')).toBe(true);

    const [filteredWorkspaces] = filterWorkspaceTombstonesAfter({
      entries: { rewind: { deleted_at: older, device_id: 'device-a' } },
      updated_at: '',
    }, watermark);
    expect(Object.hasOwn(filteredWorkspaces.entries, 'rewind')).toBe(true);
  });

  it('malformed_tombstone_manifest_fails_closed', () => {
    let message = '';
    try {
      decodeTombstoneFile<BlobTombstones>(
        plainCodec,
        Buffer.from('{"entries":{"broken":]}}', 'utf8'),
        'blob',
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('未推进水位');
  });

  it('test_find_blob_by_hash', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-tombstone-'));
    dirs.push(dir);
    const hash = 'ab'.repeat(32);
    const missing = 'cd'.repeat(32);
    mkdirSync(join(dir, 'ab'), { recursive: true });
    writeFileSync(join(dir, 'ab', `${hash}.pdf`), 'x');

    const found = findBlobByHash(dir, hash);
    expect(found).not.toBeNull();
    expect(found!.slice(found!.lastIndexOf('/') + 1)).toBe(`${hash}.pdf`);
    expect(findBlobByHash(dir, missing)).toBeNull();
    expect(findBlobByHash(dir, 'a')).toBeNull();
    expect(findBlobByHash(dir, 'abhash123')).toBeNull();
    expect(findBlobByHash(dir, `zz${'c'.repeat(62)}`)).toBeNull();
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
    const back = JSON.parse(JSON.stringify(manifest)) as BlobTombstones;
    expect(Object.keys(back.entries)).toHaveLength(1);
    expect(back.entries.hash1?.device_id).toBe('dev1');
  });

  it('immutable_event_identity_and_key_are_stable', () => {
    const operationId = eventOperationId(
      'assets',
      'device-a',
      'active/images/a.png',
      '2026-07-20T00:00:00Z',
    );
    expect(operationId).toHaveLength(64);
    expect(operationId).toBe(eventOperationId(
      'assets',
      'device-a',
      'active/images/a.png',
      '2026-07-20T00:00:00Z',
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
    const hashed = tombstoneDevicePathId('device-a');
    expect(key.startsWith(`data_governance/tombstone-events/assets/${hashed}/`)).toBe(true);
    expect(key).not.toContain('device-a');
    expect(eventSeqFromKey(key)).toBe(1n);
    expect(eventOperationFromKey(key)).toBe(operationId);
    const roundtrip = JSON.parse(JSON.stringify(event, (_key, value) =>
      typeof value === 'bigint' ? Number(value) : value)) as TombstoneEvent;
    expect(roundtrip.operation_id).toBe(operationId);
    expect(roundtrip.payload_hash).toBe(event.payload_hash);
  });

  it('bad_or_future_deleted_at_is_skipped_and_never_advances_watermark', () => {
    const valid = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const validOffset = tombstoneOffsetFromDeletedAt(valid);
    expect(tombstoneOffsetFromDeletedAt(future) > validOffset).toBe(true);

    const [filteredBlobs, blobOffset] = filterBlobTombstonesAfter({
      entries: {
        good: { deleted_at: valid, device_id: 'device-a' },
        future: { deleted_at: future, device_id: 'device-a' },
        garbage: { deleted_at: 'not-a-timestamp', device_id: 'device-a' },
      },
      updated_at: '',
    }, 0n);
    expect(Object.keys(filteredBlobs.entries)).toHaveLength(1);
    expect(Object.hasOwn(filteredBlobs.entries, 'good')).toBe(true);
    expect(blobOffset).toBe(validOffset);

    const [filteredAssets, assetOffset] = filterAssetTombstonesAfter({
      entries: {
        'active/images/good.png': { deleted_at: valid, device_id: 'device-a' },
        'active/images/future.png': { deleted_at: future, device_id: 'device-a' },
        'active/images/garbage.png': { deleted_at: 'not-a-timestamp', device_id: 'device-a' },
      },
      updated_at: '',
    }, 0n);
    expect(Object.keys(filteredAssets.entries)).toHaveLength(1);
    expect(Object.hasOwn(filteredAssets.entries, 'active/images/good.png')).toBe(true);
    expect(assetOffset).toBe(validOffset);
  });

  it('tombstone_watermark_source_uses_content_device_id', () => {
    const hashedKey = blobDeviceTombstoneKey('device-a');
    const legacyKey = blobDeviceTombstoneLegacyKey('device-a');
    expect(sourceDeviceFromTombstoneEntries(hashedKey, BLOB_TOMBSTONE_PREFIX, ['device-a']))
      .toBe('device-a');
    expect(sourceDeviceFromTombstoneEntries(legacyKey, BLOB_TOMBSTONE_PREFIX, ['device-a']))
      .toBe('device-a');
    expect(() => sourceDeviceFromTombstoneEntries(hashedKey, BLOB_TOMBSTONE_PREFIX, ['device-b']))
      .toThrow(/路径与内容/);
    expect(() => sourceDeviceFromTombstoneEntries(hashedKey, BLOB_TOMBSTONE_PREFIX, ['device-a', 'device-b']))
      .toThrow(/混有多台设备/);
    expect(() => sourceDeviceFromTombstoneEntries(hashedKey, BLOB_TOMBSTONE_PREFIX, ['']))
      .toThrow(/缺少 device_id/);
  });

  it('tombstone_device_keys_use_short_hash_not_raw_id', () => {
    const hashed = tombstoneDevicePathId('device-a');
    expect(hashed).toHaveLength(16);
    expect(hashed).not.toBe('device-a');
    expect(blobDeviceTombstoneKey('device-a'))
      .toBe(`data_governance/tombstones/blobs/${hashed}.json`);
    expect(blobDeviceTombstoneLegacyKey('device-a'))
      .toBe('data_governance/tombstones/blobs/device-a.json');
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
    expect(ASSET_TOMBSTONE_PREFIX).toBe('data_governance/tombstones/assets/');
  });

  it('merge_keeps_newer_deleted_at_and_updates_timestamp', () => {
    const destination: BlobTombstones = {
      entries: { hash: { deleted_at: '2026-01-01T00:00:00Z', device_id: 'a' } },
      updated_at: '2026-01-01T00:00:00Z',
    };
    mergeBlobTombstones(destination, {
      entries: { hash: { deleted_at: '2026-02-01T00:00:00Z', device_id: 'b' } },
      updated_at: '2026-02-01T00:00:00Z',
    });
    expect(destination.entries.hash?.device_id).toBe('b');
    expect(destination.updated_at).toBe('2026-02-01T00:00:00Z');
    mergeBlobTombstones(destination, {
      entries: { hash: { deleted_at: '2025-12-01T00:00:00Z', device_id: 'c' } },
      updated_at: '2025-12-01T00:00:00Z',
    });
    expect(destination.entries.hash?.device_id).toBe('b');
    expect(destination.updated_at).toBe('2026-02-01T00:00:00Z');
  });
});
