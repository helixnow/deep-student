/** P04: Rust lease contender ordering/expiry uses DateTime nanoseconds, not milliseconds. */
import { describe, expect, it } from 'vitest';
import { parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import { acquireBackupRepoLeaseWithTtl, acquireSyncTargetLeaseWithTtl } from '../api.ts';
import { BACKUP_LEASE_SPEC } from '../src/backup_lease.ts';
import { createLeaseRecord, scanActiveLeases, type LeaseRecord } from '../src/lease.ts';
import { SYNC_LEASE_SPEC } from '../src/sync_lease.ts';
import { MemoryStorage } from './memory_storage.ts';

const TTL_MS = 600_000;
const NOW_MS = Date.parse('2026-11-05T00:00:01Z');
const NOW_NS = BigInt(NOW_MS) * 1_000_000n;
const EARLY_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const LATE_ID = '00000000-0000-4000-8000-000000000001';

const protocols = [
  { label: 'SyncTargetLease', spec: SYNC_LEASE_SPEC, acquire: acquireSyncTargetLeaseWithTtl },
  { label: 'BackupRepoLease', spec: BACKUP_LEASE_SPEC, acquire: acquireBackupRepoLeaseWithTtl },
];

function record(target: string, id = EARLY_ID): LeaseRecord {
  return {
    format_version: 1, target, holder_device_id: 'other-device', operation_id: id,
    created_at: '2026-11-05T00:00:00.123000001+00:00',
    expires_at: '2099-01-01T00:00:00.123456789+00:00', activation_committed: true,
  };
}

describe.each(protocols)('$label nanosecond time semantics', ({ spec, acquire }) => {
  it('orders distinct instants inside one millisecond before using the UUID tie-break', async () => {
    const storage = new MemoryStorage();
    const early = record(spec.target);
    const late = { ...record(spec.target, LATE_ID), created_at: '2026-11-05T00:00:00.123000002+00:00' };
    storage.putAt(spec.keyFor(early.operation_id), Buffer.from(JSON.stringify(early)), NOW_MS);
    storage.putAt(spec.keyFor(late.operation_id), Buffer.from(JSON.stringify(late)), NOW_MS);
    const active = await scanActiveLeases(spec, storage, TTL_MS, NOW_NS);
    expect(active.map(item => item.lease?.operation_id)).toEqual([EARLY_ID, LATE_ID]);
  });

  it('does not reclaim an expiry one nanosecond after the supplied current instant', async () => {
    const storage = new MemoryStorage();
    const lease = { ...record(spec.target), expires_at: toRfc3339(NOW_NS + 1n) };
    const key = spec.keyFor(lease.operation_id);
    storage.putAt(key, Buffer.from(JSON.stringify(lease)), NOW_MS);
    const active = await scanActiveLeases(spec, storage, TTL_MS, NOW_NS);
    expect(active.map(item => item.key)).toEqual([key]);
    expect(storage.deleted).toEqual([]);
  });

  it('still reclaims at an expiry exactly equal to now', async () => {
    const storage = new MemoryStorage();
    const lease = { ...record(spec.target), expires_at: toRfc3339(NOW_NS) };
    const key = spec.keyFor(lease.operation_id);
    storage.putAt(key, Buffer.from(JSON.stringify(lease)), NOW_MS);
    expect(await scanActiveLeases(spec, storage, TTL_MS, NOW_NS)).toEqual([]);
    expect(storage.deleted).toContain(key);
  });

  it('uses the UUID tie-break only for equal instants, including different offsets', async () => {
    const storage = new MemoryStorage();
    const first = record(spec.target);
    const sameInstant = { ...record(spec.target, LATE_ID), created_at: '2026-11-05T01:00:00.123000001+01:00' };
    storage.putAt(spec.keyFor(first.operation_id), Buffer.from(JSON.stringify(first)), NOW_MS);
    storage.putAt(spec.keyFor(sameInstant.operation_id), Buffer.from(JSON.stringify(sameInstant)), NOW_MS);
    const active = await scanActiveLeases(spec, storage, TTL_MS, NOW_NS);
    expect(active.map(item => item.lease?.operation_id)).toEqual([LATE_ID, EARLY_ID]);
  });

  it('preserves the nanosecond creation instant and adds the complete TTL', () => {
    const now = NOW_NS + 123_456_789n;
    const lease = createLeaseRecord(spec, 'local-device', TTL_MS, now);
    expect(lease.created_at).toBe(toRfc3339(now));
    expect(lease.expires_at).toBe(toRfc3339(now + BigInt(TTL_MS) * 1_000_000n));
  });

  it('preserves provider nanoseconds when calculating a corrupt contender fallback expiry', async () => {
    const modified = toRfc3339(NOW_NS - BigInt(TTL_MS) * 1_000_000n + 1n);
    class NanosecondMetadataStorage extends MemoryStorage {
      override async list(prefix: string) {
        return (await super.list(prefix)).map(file => ({ ...file, lastModified: modified }));
      }
    }
    const storage = new NanosecondMetadataStorage();
    const key = spec.keyFor(EARLY_ID);
    storage.putAt(key, Buffer.from('{'), NOW_MS);
    const active = await scanActiveLeases(spec, storage, TTL_MS, NOW_NS);
    expect(active.map(item => [item.key, item.lease])).toEqual([[key, null]]);
    expect(storage.deleted).toEqual([]);
  });

  it('keeps all chrono AutoSi fractional digits in the held error', async () => {
    const storage = new MemoryStorage();
    const lease = record(spec.target);
    storage.putAt(spec.keyFor(lease.operation_id), Buffer.from(JSON.stringify(lease)), Date.now());
    await expect(acquire(storage, 'local-device', TTL_MS))
      .rejects.toThrow(toRfc3339(parseRfc3339(lease.expires_at)!.epochNanos));
  });
});
