import { describe, expect, it } from 'vitest';
import { stringifyJsonLossless } from '../../sync/api.ts';
import { plainCodec, type TombstoneEvent } from '../api.ts';
import { MemoryStorage } from './memory-storage.ts';
import { serviceHost } from './service-host.ts';

const ABOVE_SAFE = 9007199254740993n;
const deletedAt = '2026-08-01T00:00:00Z';

describe('S03: exact u64 tombstone event JSON through the installed service', () => {
  it('downloads an odd large event sequence without rejecting its exact path and hash', async () => {
    const h = await serviceHost();
    try {
      const storage = new MemoryStorage();
      const t = h.service.tombstones;
      const event = {
        format_version: 4, device_id: 'device-a', seq: ABOVE_SAFE,
        operation_id: t.eventOperationId('blobs', 'device-a', 'object', deletedAt),
        kind: 'blobs', object_id: 'object', deleted_at: deletedAt,
        size: ABOVE_SAFE + 2n, relative_path: null, payload_hash: '',
      } satisfies TombstoneEvent;
      event.payload_hash = t.eventPayloadHash(event);
      storage.files.set(t.eventKey(event), Buffer.from(stringifyJsonLossless({ ...event })));
      const [manifest, advances] = await t.downloadBlobTombstonesAfter(storage, plainCodec, () => ABOVE_SAFE - 1n);
      expect(manifest.entries.object?.deleted_at).toBe(deletedAt);
      expect(manifest.entries.object?.size).toBe(ABOVE_SAFE + 2n);
      expect(advances).toContainEqual({ source_device_id: 'event:device-a', last_applied_offset: ABOVE_SAFE });
    } finally { await h.dispose(); }
  });

  it('publishes and verifies the exact next odd sequence after a large cloud prefix', async () => {
    const h = await serviceHost();
    try {
      const storage = new MemoryStorage();
      const t = h.service.tombstones;
      const previous = {
        format_version: 4, device_id: 'device-a', seq: ABOVE_SAFE - 1n,
        operation_id: t.eventOperationId('blobs', 'device-a', 'previous', deletedAt),
        kind: 'blobs', object_id: 'previous', deleted_at: deletedAt,
        size: null, relative_path: null, payload_hash: '',
      } satisfies TombstoneEvent;
      previous.payload_hash = t.eventPayloadHash(previous);
      storage.files.set(t.eventKey(previous), Buffer.from(stringifyJsonLossless({ ...previous })));
      const manifest = { entries: { next: { device_id: 'device-a', deleted_at: deletedAt } }, updated_at: '' };
      await expect(t.uploadBlobTombstones(storage, plainCodec, 'device-a', manifest)).resolves.toBeUndefined();
      const eventKeys = storage.puts.filter(key => key.includes('/tombstone-events/'));
      expect(eventKeys).toHaveLength(1);
      expect(t.eventSeqFromKey(eventKeys[0]!)).toBe(ABOVE_SAFE);
      expect(Buffer.from(storage.files.get(eventKeys[0]!)!).toString()).toContain(`"seq":${ABOVE_SAFE}`);
      await expect(t.uploadBlobTombstones(storage, plainCodec, 'device-a', manifest)).resolves.toBeUndefined();
      expect(storage.puts.filter(key => key === eventKeys[0])).toHaveLength(1);
    } finally { await h.dispose(); }
  });
});
