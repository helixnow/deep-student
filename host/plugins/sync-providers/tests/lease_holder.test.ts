/** P04: public lease IDs use Rust str::trim, including persisted UTF-8 BOM/NEL inputs. */
import { describe, expect, it } from 'vitest';
import {
  acquireBackupRepoLeaseWithTtl,
  acquireSyncTargetLeaseWithTtl,
  SYNC_LEASE_HELD_BY_SELF_ERROR_CODE,
} from '../api.ts';
import { MemoryStorage } from './memory_storage.ts';
import { BACKUP_LEASE_SPEC } from '../src/backup_lease.ts';
import { SYNC_LEASE_SPEC } from '../src/sync_lease.ts';

const TTL_MS = 600_000;
const protocols = [
  { label: 'sync', spec: SYNC_LEASE_SPEC, acquire: acquireSyncTargetLeaseWithTtl, missing: '同步租约缺少设备 ID' },
  { label: 'backup', spec: BACKUP_LEASE_SPEC, acquire: acquireBackupRepoLeaseWithTtl, missing: '备份仓库租约缺少设备 ID' },
];

describe.each(protocols)('$label lease holder Rust whitespace semantics', ({ spec, acquire, missing }) => {
  it('rejects a NEXT LINE-only holder before writing a lease', async () => {
    const storage = new MemoryStorage();
    const outcome = await acquire(storage, '\u0085', TTL_MS).then(
      async guard => { await guard.release(); return null; },
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({ message: missing, value: { error_type: 'Validation' } });
    expect(storage.putLog).toEqual([]);
  });

  it.each([
    { label: 'BOM around a real holder is retained', input: '\ufeffdevice\ufeff', expected: '\ufeffdevice\ufeff' },
    { label: 'BOM alone is not Rust whitespace', input: '\ufeff', expected: '\ufeff' },
    { label: 'NEXT LINE at both ends is trimmed', input: '\u0085device\u0085', expected: 'device' },
  ])('$label', async ({ input, expected }) => {
    const storage = new MemoryStorage();
    const guard = await acquire(storage, input, TTL_MS);
    try { expect(guard.lease.holder_device_id).toBe(expected); }
    finally { await guard.release(); }
  });

  function seedExpired(storage: MemoryStorage, holder: string): string {
    const operationId = '00000000-0000-4000-8000-000000000099';
    const key = spec.keyFor(operationId);
    storage.putAt(key, Buffer.from(JSON.stringify({
      format_version: 1, target: spec.target, holder_device_id: holder,
      operation_id: operationId, created_at: '2000-01-01T00:00:00+00:00',
      expires_at: '2000-01-01T00:10:00+00:00', activation_committed: true,
    })), Date.now());
    return key;
  }

  it('treats a fresh NEXT LINE-only foreign holder as corrupt instead of trusting its expiry', async () => {
    const storage = new MemoryStorage();
    const key = seedExpired(storage, '\u0085');
    const outcome = await acquire(storage, 'local-device', TTL_MS).then(
      async guard => { await guard.release(); return null; },
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({
      message: expect.stringContaining('未知设备（租约内容损坏）'), value: { error_type: 'Conflict' },
    });
    expect(storage.files.has(key)).toBe(true);
  });

  it('accepts a BOM-only foreign holder and reclaims its expired record normally', async () => {
    const storage = new MemoryStorage();
    const key = seedExpired(storage, '\ufeff');
    const guard = await acquire(storage, 'local-device', TTL_MS);
    try { expect(storage.files.has(key)).toBe(false); }
    finally { await guard.release(); }
  });
});

describe('sync lease self-held classification uses the same Rust trim', () => {
  it('does not conflate a BOM-prefixed persisted identity with the unprefixed one', async () => {
    const storage = new MemoryStorage();
    const guard = await acquireSyncTargetLeaseWithTtl(storage, '\ufeffdevice', TTL_MS);
    try {
      await expect(acquireSyncTargetLeaseWithTtl(storage, 'device', TTL_MS)).rejects.toMatchObject({
        message: expect.not.stringContaining(SYNC_LEASE_HELD_BY_SELF_ERROR_CODE),
        value: { error_type: 'Conflict' },
      });
    } finally { await guard.release(); }
  });

  it('recognizes the same device surrounded by NEXT LINE whitespace', async () => {
    const storage = new MemoryStorage();
    const guard = await acquireSyncTargetLeaseWithTtl(storage, 'device', TTL_MS);
    try {
      await expect(acquireSyncTargetLeaseWithTtl(storage, '\u0085device\u0085', TTL_MS))
        .rejects.toThrow(SYNC_LEASE_HELD_BY_SELF_ERROR_CODE);
    } finally { await guard.release(); }
  });
});
