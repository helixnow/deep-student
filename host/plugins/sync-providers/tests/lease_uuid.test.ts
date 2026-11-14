/** P04: uuid 1.20.0 parser.rs::try_parse shape rules through all lease consumers. */
import { describe, expect, it } from 'vitest';
import { acquireBackupRepoLeaseWithTtl, acquireSyncTargetLeaseWithTtl } from '../api.ts';
import { BACKUP_LEASE_SPEC } from '../src/backup_lease.ts';
import { claimEncryptionMarker } from '../src/e2ee_claim.ts';
import { encodeEncryptionMarker } from '../src/marker.ts';
import { SYNC_LEASE_SPEC } from '../src/sync_lease.ts';
import { MemoryStorage } from './memory_storage.ts';

const UUID = '67e55044-10b1-426f-9247-bb680e5fe0c8';
const SIMPLE = UUID.replaceAll('-', '');
const TTL_MS = 600_000;
const invalidForms = [`urn:uuid:${SIMPLE}`, `{${SIMPLE}}`, `urn:uuid:{${UUID}}`, `${UUID}\n`, `${SIMPLE}\n`];
const validForms = [UUID, SIMPLE, `urn:uuid:${UUID}`, `{${UUID}}`, UUID.toUpperCase(),
  '00000000000000000000000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff'];
const protocols = [
  { label: 'sync', spec: SYNC_LEASE_SPEC, acquire: acquireSyncTargetLeaseWithTtl },
  { label: 'backup', spec: BACKUP_LEASE_SPEC, acquire: acquireBackupRepoLeaseWithTtl },
];

describe.each(protocols)('$label operation UUID follows Rust parse_str', ({ spec, acquire }) => {
  function seed(storage: MemoryStorage, operationId: string): string {
    const key = spec.keyFor(UUID);
    storage.putAt(key, Buffer.from(JSON.stringify({
      format_version: 1, target: spec.target, holder_device_id: 'other-device',
      operation_id: operationId, created_at: '2000-01-01T00:00:00+00:00',
      expires_at: '2000-01-01T00:10:00+00:00', activation_committed: true,
    })), Date.now());
    return key;
  }

  it.each(invalidForms)('treats %j as corrupt, not an expired valid contender', async operationId => {
    const storage = new MemoryStorage();
    const key = seed(storage, operationId);
    const outcome = await acquire(storage, 'local-device', TTL_MS).then(
      async guard => { await guard.release(); return null; },
      (error: unknown) => error,
    );
    expect(outcome).toMatchObject({ message: expect.stringContaining('未知设备（租约内容损坏）'), value: { error_type: 'Conflict' } });
    expect(storage.files.has(key)).toBe(true);
  });

  it.each(validForms)('accepts %s without adding variant/version restrictions', async operationId => {
    const storage = new MemoryStorage();
    const key = seed(storage, operationId);
    const guard = await acquire(storage, 'local-device', TTL_MS);
    try { expect(storage.files.has(key)).toBe(false); }
    finally { await guard.release(); }
  });
});

describe('claim nonce UUID follows the same Rust parse_str', () => {
  const markerKey = '.encryption-marker';
  const leaseKey = `${markerKey}.lease`;
  const marker = Uint8Array.from(encodeEncryptionMarker({
    version: 2, createdByDevice: 'local', createdAt: '2026-01-01T00:00:00Z', keyVerifier: null,
  }));

  async function attempt(nonce: string) {
    const storage = new MemoryStorage();
    storage.putAt(leaseKey, Buffer.from(JSON.stringify({
      format_version: 1, device_id: 'other-device', nonce,
      created_at: '2000-01-01T00:00:00+00:00', expires_at: '2000-01-01T00:10:00+00:00',
    })), Date.now());
    let builds = 0;
    const error = await claimEncryptionMarker(storage, {
      markerKey, deviceIdShort: 'local', ttlMs: TTL_MS, expectation: 'Absent',
      buildMarker: () => { builds++; return marker; },
    }).then(() => null, (failure: unknown) => failure);
    return { storage, builds, error };
  }

  it.each(invalidForms)('does not trust the expired time in a malformed nonce %j', async nonce => {
    const result = await attempt(nonce);
    expect(result.error).toMatchObject({ message: expect.stringContaining('未知设备（租约内容损坏）'), value: { error_type: 'Conflict' } });
    expect(result.builds).toBe(0);
    expect(result.storage.bytes(markerKey)).toBeNull();
  });

  it.each(validForms)('reclaims an expired lease with valid nonce %s', async nonce => {
    const result = await attempt(nonce);
    expect(result.error).toBeNull();
    expect(result.storage.bytes(markerKey)).toEqual(marker);
  });
});
