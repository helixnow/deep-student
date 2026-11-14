import { describe, expect, it } from 'vitest';
import { SyncStateStore } from '../repository/state.ts';
import { openTestDatabase } from './test-db.ts';

const suite = describe;

suite('sync state store', () => {
  it('tombstone_event_sequence_is_monotonic_and_idempotent', () => {
    const db = openTestDatabase();
    const store = new SyncStateStore(db);

    const first = store.reserveTombstoneEventSeq('instance', 'device', 'assets', 'operation-a', 0n);
    const retry = store.reserveTombstoneEventSeq('instance', 'device', 'assets', 'operation-a', 99n);
    const next = store.reserveTombstoneEventSeq('instance', 'device', 'assets', 'operation-b', 7n);

    expect(first).toBe(1n);
    expect(retry).toBe(first);
    expect(next).toBe(8n);
  });

  it('watermark_and_upload_seq_use_monotonic_max', () => {
    const db = openTestDatabase();
    const store = new SyncStateStore(db);

    store.setTombstoneWatermark('instance', 'device', 'assets', 5n);
    store.setTombstoneWatermark('instance', 'device', 'assets', 3n);
    expect(store.getTombstoneWatermark('instance', 'device', 'assets')).toBe(5n);

    expect(store.nextUploadSeq('instance', 'device', 4n)).toBe(5n);
    store.markPublishedSeq('instance', 'device', 5n);
    store.markPublishedSeq('instance', 'device', 2n);
    expect(store.publishedMaxSeq('instance', 'device')).toBe(5n);
  });

  it('instance_binding_rejects_provider_or_endpoint_change', () => {
    const db = openTestDatabase();
    const store = new SyncStateStore(db);
    store.bindInstance('instance', 's3', 'bucket-a');
    store.bindInstance('instance', 's3', 'bucket-a');
    expect(() => store.bindInstance('instance', 'webdav', 'bucket-a')).toThrow(/实例绑定不匹配/);
  });

  it('device_rotation_resets_consume_state_but_keeps_upload_seq', () => {
    const db = openTestDatabase();
    const store = new SyncStateStore(db);
    store.markPublishedSeq('instance', 'device', 9n);
    store.setCursor('instance', 'remote', 7n);
    store.markLegacyProcessed('instance', 'key');
    store.setTombstoneWatermark('instance', 'remote', 'blobs', 3n);

    store.recordDeviceRotation('old', 'new', 'restore');

    expect(store.publishedMaxSeq('instance', 'device')).toBe(9n);
    expect(store.getCursor('instance', 'remote')).toBe(0n);
    expect(store.isLegacyProcessed('instance', 'key')).toBe(false);
    expect(store.getTombstoneWatermark('instance', 'remote', 'blobs')).toBe(0n);
    expect(store.deviceRotationsForNew('new')).toEqual([['old', 'restore']]);
  });
});
