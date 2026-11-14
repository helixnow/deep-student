/** P04: claim-lease Rust whitespace and DateTime precision through the real claim entry. */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { claimEncryptionMarker, createLease, MAX_E2EE_CLAIM_OBJECT_BYTES } from '../src/e2ee_claim.ts';
import { encodeEncryptionMarker } from '../src/marker.ts';
import { MemoryStorage } from './memory_storage.ts';

const MARKER = '.encryption-marker';
const LEASE = `${MARKER}.lease`;
const TTL_MS = 60_000;
const NOW_MS = Date.parse('2099-01-01T00:00:00Z');
const NOW_NS = BigInt(NOW_MS) * 1_000_000n;
const TTL_NS = BigInt(TTL_MS) * 1_000_000n;
const markerBytes = Uint8Array.from(encodeEncryptionMarker({
  version: 2, createdByDevice: 'local', createdAt: '2099-01-01T00:00:00Z', keyVerifier: null,
}));

beforeEach(() => {
  // The Rust helper receives an explicit now. Control only the standard clocks;
  // the production F4 parser/formatter and claim protocol run unchanged.
  vi.useFakeTimers({ toFake: ['Date', 'performance'] });
  vi.setSystemTime(NOW_MS);
});
afterEach(() => { vi.useRealTimers(); });

function foreignLease(deviceId = 'holder', expiresAt = toRfc3339(NOW_NS + TTL_NS + 123n)) {
  return Buffer.from(JSON.stringify({
    format_version: 1, device_id: deviceId, nonce: randomUUID(),
    created_at: toRfc3339(NOW_NS - TTL_NS), expires_at: expiresAt,
  }));
}

async function claim(storage: MemoryStorage, deviceId = 'local') {
  let builds = 0;
  let writtenHolder: unknown;
  const result = await claimEncryptionMarker(storage, {
    markerKey: MARKER, deviceIdShort: deviceId, ttlMs: TTL_MS, expectation: 'Absent',
    buildMarker: () => {
      builds++;
      const bytes = storage.bytes(LEASE);
      if (bytes !== null) writtenHolder = JSON.parse(Buffer.from(bytes).toString('utf8')).device_id;
      return markerBytes;
    },
  }).then(value => ({ bytes: value, error: null }), (error: unknown) => ({ bytes: null, error }));
  return { ...result, builds, writtenHolder };
}

class PreciseLeaseMetadataStorage extends MemoryStorage {
  private readonly modified: string;
  constructor(modified: string) { super(); this.modified = modified; }
  override async stat(key: string) {
    const info = await super.stat(key);
    return info !== null && key === LEASE ? { ...info, lastModified: this.modified } : info;
  }
}

describe('claim lease Rust trim', () => {
  it('rejects a NEXT LINE-only claimant before registration writes', async () => {
    const storage = new MemoryStorage();
    const result = await claim(storage, '\u0085');
    expect(result.error).toMatchObject({ message: 'E2EE 认领租约缺少设备 ID', value: { error_type: 'Validation' } });
    expect(storage.putLog).toEqual([]);
  });

  it.each([
    ['\ufefflocal\ufeff', '\ufefflocal\ufeff'],
    ['\ufeff', '\ufeff'],
    ['\u0085local\u0085', 'local'],
  ])('normalizes claimant %j like Rust, not String.trim', async (input, expected) => {
    const result = await claim(new MemoryStorage(), input);
    expect(result.error).toBeNull();
    expect(result.writtenHolder).toBe(expected);
  });

  it('keeps a fresh NEL-only foreign lease as corrupt instead of trusting its expired timestamp', async () => {
    const storage = new MemoryStorage();
    const bytes = foreignLease('\u0085', toRfc3339(NOW_NS - 1n));
    storage.putAt(LEASE, bytes, NOW_MS);
    const result = await claim(storage);
    expect(result.error).toMatchObject({ message: expect.stringContaining('未知设备（租约内容损坏）'), value: { error_type: 'Conflict' } });
    expect(result.builds).toBe(0);
    expect(Buffer.from(storage.bytes(LEASE)!)).toEqual(Buffer.from(bytes));
  });

  it('accepts an expired BOM-only foreign identity and reclaims it normally', async () => {
    const storage = new MemoryStorage();
    storage.putAt(LEASE, foreignLease('\ufeff', toRfc3339(NOW_NS - 1n)), NOW_MS);
    const result = await claim(storage);
    expect(result.error).toBeNull();
    expect(storage.bytes(MARKER)).toEqual(markerBytes);
  });
});

describe('claim lease nanosecond expiry and error Display', () => {
  it('keeps the full creation instant and TTL in both outgoing timestamps', () => {
    const now = NOW_NS + 123n;
    const lease = createLease('local', TTL_MS, now);
    expect(lease.created_at).toBe(toRfc3339(now));
    expect(lease.expires_at).toBe(toRfc3339(now + TTL_NS));
  });

  it('preserves a valid holder expiry down to nanoseconds in the conflict text', async () => {
    const storage = new MemoryStorage();
    const expiry = toRfc3339(NOW_NS + TTL_NS + 123n);
    storage.putAt(LEASE, foreignLease('holder', expiry), NOW_MS);
    const result = await claim(storage);
    expect(result.error).toMatchObject({ message: expect.stringContaining(`租约预计 ${expiry} 到期`), value: { error_type: 'Conflict' } });
    expect(result.builds).toBe(0);
  });

  it.each([false, true])('does not reclaim a fallback ending 1ns after now (oversized=%s)', async oversized => {
    const storage = new PreciseLeaseMetadataStorage(toRfc3339(NOW_NS - TTL_NS + 1n));
    const bytes = oversized ? Buffer.alloc(MAX_E2EE_CLAIM_OBJECT_BYTES + 1, 0x7b) : Buffer.from('{');
    storage.putAt(LEASE, bytes, NOW_MS);
    const result = await claim(storage);
    expect(result.error).toMatchObject({ message: expect.stringContaining(toRfc3339(NOW_NS + 1n)), value: { error_type: 'Conflict' } });
    expect(result.builds).toBe(0);
    expect(Buffer.from(storage.bytes(LEASE)!)).toEqual(Buffer.from(bytes));
    expect(storage.bytes(MARKER)).toBeNull();
  });

  it.each([false, true])('still reclaims at the exact fallback expiry (oversized=%s)', async oversized => {
    const storage = new PreciseLeaseMetadataStorage(toRfc3339(NOW_NS - TTL_NS));
    const bytes = oversized ? Buffer.alloc(MAX_E2EE_CLAIM_OBJECT_BYTES + 1, 0x7b) : Buffer.from('{');
    storage.putAt(LEASE, bytes, NOW_MS);
    const result = await claim(storage);
    expect(result.error).toBeNull();
    expect(storage.bytes(MARKER)).toEqual(markerBytes);
  });
});
