import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CloudStorage } from '../api.ts';
import {
  DEFAULT_E2EE_CLAIM_LEASE_TTL_MS,
  E2EE_CLAIM_LEASE_FORMAT_VERSION,
  ENCRYPTION_MARKER_LEASE_SUFFIX,
  MAX_E2EE_CLAIM_OBJECT_BYTES,
  SYNC_E2EE_CLAIM_CONFLICT_CODE,
  claimEncryptionMarker,
  ensureNoPendingClaims,
  type ClaimExpectation,
} from '../src/e2ee_claim.ts';
import { CloudStorageBase } from '../src/traits.ts';
import { chronoAutoSiZ } from '../src/time.ts';
import { MemoryStorage } from './memory_storage.ts';

const MARKER_KEY = '.encryption-marker';
const TTL = DEFAULT_E2EE_CLAIM_LEASE_TTL_MS;

const leaseKey = (): string => `${MARKER_KEY}${ENCRYPTION_MARKER_LEASE_SUFFIX}`;
const pendingPrefix = (): string => `${MARKER_KEY}.pending/`;

function leaseJson(device: string, expiresInSeconds: number): Uint8Array {
  const now = Date.now();
  return Buffer.from(JSON.stringify({
    format_version: E2EE_CLAIM_LEASE_FORMAT_VERSION,
    device_id: device,
    nonce: randomUUID(),
    created_at: chronoAutoSiZ(now),
    expires_at: chronoAutoSiZ(now + expiresInSeconds * 1000),
  }, null, 2), 'utf8');
}

function v1MarkerBytes(device: string): Uint8Array {
  return Buffer.from(JSON.stringify({
    version: 1, createdByDevice: device, createdAt: chronoAutoSiZ(Date.now()),
  }, null, 2), 'utf8');
}

function v2MarkerBytes(device: string): Uint8Array {
  return Buffer.from(JSON.stringify({
    version: 2, createdByDevice: device, createdAt: chronoAutoSiZ(Date.now()),
  }, null, 2), 'utf8');
}

function claim(
  storage: CloudStorage,
  device: string,
  expectation: ClaimExpectation,
  payload: Uint8Array,
  ttlMs = TTL,
): Promise<Uint8Array> {
  return claimEncryptionMarker(storage, {
    markerKey: MARKER_KEY,
    deviceIdShort: device,
    ttlMs,
    expectation,
    buildMarker: () => payload,
  });
}

/** Runs `action` right after the first PUT to a matching key succeeds. */
class AfterPutHook extends CloudStorageBase {
  private fired = false;

  private readonly inner: MemoryStorage;
  private readonly match: (key: string) => boolean;
  private readonly action: (key: string) => Promise<void>;

  constructor(
    inner: MemoryStorage,
    match: (key: string) => boolean,
    action: (key: string) => Promise<void>,
  ) { super();
    this.inner = inner;
    this.match = match;
    this.action = action; }

  override providerName(): string { return 'memory-hooked'; }
  override async checkConnection(): Promise<void> { await this.inner.checkConnection(); }

  override async put(key: string, data: Uint8Array): Promise<void> {
    await this.inner.put(key, data);
    if (!this.fired && this.match(key)) {
      this.fired = true;
      await this.action(key);
    }
  }

  override async get(key: string): Promise<Uint8Array | null> { return this.inner.get(key); }
  override async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> { return this.inner.getBounded(key, maxBytes); }
  override async list(prefix: string) { return this.inner.list(prefix); }
  override async listOutcome(prefix: string) { return this.inner.listOutcome(prefix); }
  override async delete(key: string): Promise<void> { await this.inner.delete(key); }
  override async stat(key: string) { return this.inner.stat(key); }
  override supportsConditionalPut(): boolean { return this.inner.supportsConditionalPut(); }
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) { return error as Error; }
  throw new Error('expected the operation to fail');
}

/** Parks the marker PUT until released, emulating a request still in flight. */
class PausedMarkerWrite extends CloudStorageBase {
  entered: (() => void) | null = null;
  private readonly enteredPromise: Promise<void>;
  private releaseGate: (() => void) | null = null;
  private readonly releasePromise: Promise<void>;

  private readonly inner: MemoryStorage;

  constructor(inner: MemoryStorage) {
    super();
    this.inner = inner;
    this.enteredPromise = new Promise<void>(resolve => { this.entered = resolve; });
    this.releasePromise = new Promise<void>(resolve => { this.releaseGate = resolve; });
  }

  waitEntered(): Promise<void> { return this.enteredPromise; }
  release(): void { this.releaseGate?.(); }

  override providerName(): string { return 'paused-marker-write'; }
  override async checkConnection(): Promise<void> { await this.inner.checkConnection(); }

  override async put(key: string, data: Uint8Array): Promise<void> {
    if (key === MARKER_KEY) {
      this.entered?.();
      await this.releasePromise;
    }
    await this.inner.put(key, data);
  }

  override async get(key: string): Promise<Uint8Array | null> { return this.inner.get(key); }
  override async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> { return this.inner.getBounded(key, maxBytes); }
  override async list(prefix: string) { return this.inner.list(prefix); }
  override async listOutcome(prefix: string) { return this.inner.listOutcome(prefix); }
  override async delete(key: string): Promise<void> { await this.inner.delete(key); }
  override async stat(key: string) { return this.inner.stat(key); }
}

describe('e2ee_claim.rs', () => {
  it('in_flight_writer_cannot_be_stolen_after_its_lease_expires', async () => {
    const storage = new MemoryStorage();
    const slow = new PausedMarkerWrite(storage);
    const slowClaim = claim(slow, 'slow', 'Absent', Buffer.from('slow-marker'))
      .then(() => null).catch((error: Error) => error);
    await slow.waitEntered();

    // A server request is still in flight even though the lease looks expired.
    await storage.put(leaseKey(), leaseJson('slow', -1));
    const contender = await claim(storage, 'contender', 'Absent', Buffer.from('contender-marker'))
      .then(() => null).catch((error: Error) => error);
    slow.release();
    await slowClaim;

    expect(contender).not.toBeNull();
    expect(contender!.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(Buffer.from(storage.bytes(MARKER_KEY)!).toString()).toBe('slow-marker');
    expect(await storage.list(pendingPrefix())).toEqual([]);
  });

  it('abandoned_pending_writer_is_not_silently_stolen_by_ttl', async () => {
    const storage = new MemoryStorage();
    const pending = `${pendingPrefix()}abandoned.json`;
    await storage.put(pending, leaseJson('other-device', -3600));

    const error = await failure(claim(storage, 'new-device', 'Absent', Buffer.from('new-marker')));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(storage.bytes(MARKER_KEY)).toBeNull();
    expect(storage.bytes(pending)).not.toBeNull();
    expect(await failure(ensureNoPendingClaims(storage, MARKER_KEY))).toBeInstanceOf(Error);
  });

  it('first_claim_writes_lease_then_marker_and_cleans_lease', async () => {
    const storage = new MemoryStorage();
    const published = await claim(storage, 'device-a', 'Absent', Buffer.from('marker-A'));
    expect(Buffer.from(published).toString()).toBe('marker-A');
    expect(Buffer.from(storage.bytes(MARKER_KEY)!).toString()).toBe('marker-A');
    expect(storage.bytes(leaseKey())).toBeNull();

    const puts = storage.putLog;
    const leasePos = puts.indexOf(leaseKey());
    const markerPos = puts.indexOf(MARKER_KEY);
    expect(leasePos).toBeGreaterThanOrEqual(0);
    expect(markerPos).toBeGreaterThan(leasePos);
  });

  it('claim_fails_when_marker_already_exists', async () => {
    const storage = new MemoryStorage();
    await storage.put(MARKER_KEY, Buffer.from('marker-A'));
    const error = await failure(claim(storage, 'device-b', 'Absent', Buffer.from('marker-B')));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(Buffer.from(storage.bytes(MARKER_KEY)!).toString()).toBe('marker-A');
  });

  it('live_foreign_lease_blocks_claim_and_never_writes_marker', async () => {
    const storage = new MemoryStorage();
    await storage.put(leaseKey(), leaseJson('device-x', 60));
    const error = await failure(claim(storage, 'device-b', 'Absent', Buffer.from('marker-B')));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(error.message).toContain('device-x');
    expect(storage.bytes(MARKER_KEY)).toBeNull();
  });

  it('expired_foreign_lease_is_reclaimed', async () => {
    const storage = new MemoryStorage();
    await storage.put(leaseKey(), leaseJson('device-x', -5));
    await claim(storage, 'device-b', 'Absent', Buffer.from('marker-B'));
    expect(Buffer.from(storage.bytes(MARKER_KEY)!).toString()).toBe('marker-B');
    expect(storage.bytes(leaseKey())).toBeNull();
  });

  it('corrupted_fresh_lease_fails_closed_and_stale_one_is_reclaimed', async () => {
    const storage = new MemoryStorage();
    await storage.put(leaseKey(), Buffer.from('not-json'));
    const error = await failure(claim(storage, 'device-b', 'Absent', Buffer.from('marker-B')));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);

    storage.putAt(leaseKey(), Buffer.from('not-json'), Date.now() - 120_000);
    await claim(storage, 'device-b', 'Absent', Buffer.from('marker-B'), 60_000);
    expect(Buffer.from(storage.bytes(MARKER_KEY)!).toString()).toBe('marker-B');
  });

  it('legacy_v1_upgrade_hands_snapshot_to_builder_and_rejects_v2', async () => {
    const storage = new MemoryStorage();
    await storage.put(MARKER_KEY, v1MarkerBytes('device-legacy'));

    const published = await claimEncryptionMarker(storage, {
      markerKey: MARKER_KEY,
      deviceIdShort: 'device-a',
      ttlMs: TTL,
      expectation: 'LegacyV1',
      buildMarker: snapshot => {
        expect(snapshot).not.toBeNull();
        expect(snapshot!.createdByDevice).toBe('device-legacy');
        return Buffer.from(`upgraded-by-${snapshot!.createdByDevice}`, 'utf8');
      },
    });
    expect(Buffer.from(published).toString()).toBe('upgraded-by-device-legacy');

    const v2 = v2MarkerBytes('device-legacy');
    await storage.put(MARKER_KEY, v2);
    const error = await failure(claim(storage, 'device-b', 'LegacyV1', Buffer.from('marker-B')));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(Buffer.from(storage.bytes(MARKER_KEY)!).equals(v2)).toBe(true);
  });

  it('lease_overwritten_before_readback_aborts_without_marker_write', async () => {
    const inner = new MemoryStorage();
    const foreign = leaseJson('device-x', 60);
    const storage = new AfterPutHook(inner, key => key.endsWith(ENCRYPTION_MARKER_LEASE_SUFFIX), async key => {
      await inner.put(key, foreign);
    });
    const error = await failure(claim(storage, 'device-a', 'Absent', Buffer.from('marker-A')));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(inner.bytes(MARKER_KEY)).toBeNull();
  });

  it('lease_stolen_after_marker_write_reports_failure_without_rollback', async () => {
    const inner = new MemoryStorage();
    const foreign = leaseJson('device-x', 60);
    const storage = new AfterPutHook(inner, key => key === MARKER_KEY, async () => {
      await inner.put(leaseKey(), foreign);
    });
    const error = await failure(claim(storage, 'device-a', 'Absent', Buffer.from('marker-A')));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(Buffer.from(inner.bytes(MARKER_KEY)!).toString()).toBe('marker-A');
  });

  it('conditional_put_backend_claims_without_lease_and_second_claim_conflicts', async () => {
    const inner = new MemoryStorage();
    const storage = new ConditionalStorage(inner);
    await claim(storage, 'device-a', 'Absent', Buffer.from('marker-A'));
    expect(inner.putLog).not.toContain(leaseKey());
    expect(Buffer.from(inner.bytes(MARKER_KEY)!).toString()).toBe('marker-A');

    const error = await failure(claim(storage, 'device-b', 'Absent', Buffer.from('marker-B')));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(Buffer.from(inner.bytes(MARKER_KEY)!).toString()).toBe('marker-A');
  });

  it('oversized_lease_object_fails_closed_within_ttl_window', async () => {
    const storage = new MemoryStorage();
    await storage.put(leaseKey(), new Uint8Array(MAX_E2EE_CLAIM_OBJECT_BYTES + 1).fill(0x78));
    const error = await failure(claim(storage, 'device-a', 'Absent', Buffer.from('marker-A')));
    expect(error.message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
    expect(storage.bytes(MARKER_KEY)).toBeNull();
  });

  it('two_device_claim_full_permutation_at_most_one_succeeds', async () => {
    type MarkerNow = 'Empty' | 'V1' | 'V2';
    const markerCases = ['Empty', 'ExistingV2', 'LegacyV1'] as const;
    const leaseCases = ['NoLease', 'LiveForeign', 'ExpiredForeign'] as const;
    const expectations: ClaimExpectation[] = ['Absent', 'LegacyV1'];
    const expectationMatches = (expectation: ClaimExpectation, marker: MarkerNow): boolean =>
      (expectation === 'Absent' && marker === 'Empty') || (expectation === 'LegacyV1' && marker === 'V1');

    for (const markerCase of markerCases) {
      for (const leaseCase of leaseCases) {
        for (const expA of expectations) {
          for (const expB of expectations) {
            const ctx = `[marker=${markerCase} lease=${leaseCase} A=${expA} B=${expB}]`;
            const storage = new MemoryStorage();

            const initialMarker = markerCase === 'Empty' ? null
              : markerCase === 'ExistingV2' ? v2MarkerBytes('device-owner') : v1MarkerBytes('device-legacy');
            if (initialMarker !== null) await storage.put(MARKER_KEY, initialMarker);
            const initialLease = leaseCase === 'NoLease' ? null
              : leaseCase === 'LiveForeign' ? leaseJson('device-x', 3600) : leaseJson('device-x', -5);
            if (initialLease !== null) await storage.put(leaseKey(), initialLease);
            storage.putLog = [];

            let markerNow: MarkerNow = markerCase === 'Empty' ? 'Empty' : markerCase === 'ExistingV2' ? 'V2' : 'V1';
            let leaseLive = leaseCase === 'LiveForeign';
            let successes = 0;
            let expectedFinalMarker = initialMarker;

            for (const [device, expectation] of [['device-a', expA], ['device-b', expB]] as const) {
              const payload = v2MarkerBytes(device);
              const shouldSucceed = expectationMatches(expectation, markerNow) && !leaseLive;
              const result = await claim(storage, device, expectation, payload)
                .then(value => ({ ok: true as const, value }))
                .catch((error: Error) => ({ ok: false as const, error }));
              if (result.ok && shouldSucceed) {
                expect(Buffer.from(result.value).equals(payload), `${ctx} ${device}`).toBe(true);
                successes += 1;
                markerNow = 'V2';
                leaseLive = false;
                expectedFinalMarker = payload;
              } else if (!result.ok && !shouldSucceed) {
                expect(result.error.message, `${ctx} ${device}`).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
              } else if (result.ok) {
                throw new Error(`${ctx} ${device} 必须失败却成功：两设备互斥被打破`);
              } else {
                throw new Error(`${ctx} ${device} 必须成功却失败: ${result.error.message}`);
              }
            }

            expect(successes, `${ctx} 至多一个成功`).toBeLessThanOrEqual(1);
            const markerPuts = storage.putLog.filter(key => key === MARKER_KEY).length;
            expect(markerPuts, `${ctx} marker 写入次数必须等于成功次数`).toBe(successes);
            const finalMarker = storage.bytes(MARKER_KEY);
            if (expectedFinalMarker === null) expect(finalMarker, ctx).toBeNull();
            else expect(Buffer.from(finalMarker!).equals(expectedFinalMarker), ctx).toBe(true);
            const finalLease = storage.bytes(leaseKey());
            if (successes > 0) expect(finalLease, ctx).toBeNull();
            else if (initialLease === null) expect(finalLease, ctx).toBeNull();
            else expect(Buffer.from(finalLease!).equals(initialLease), ctx).toBe(true);
          }
        }
      }
    }
  });

  it('registered_writer_blocks_rival_in_lease_window', async () => {
    const arms: Array<{ marker: Uint8Array | null; expectation: ClaimExpectation; name: string }> = [
      { marker: null, expectation: 'Absent', name: '空仓首次认领' },
      { marker: v1MarkerBytes('device-legacy'), expectation: 'LegacyV1', name: 'v1 升级' },
    ];
    for (const arm of arms) {
      for (const initialLease of [null, leaseJson('device-x', -5)]) {
        const ctx = `[${arm.name} lease=${initialLease === null ? '无' : '他人过期租约'}]`;
        const inner = new MemoryStorage();
        if (arm.marker !== null) await inner.put(MARKER_KEY, arm.marker);
        if (initialLease !== null) await inner.put(leaseKey(), initialLease);

        const rivalPayload = v2MarkerBytes('device-rival');
        let rivalError: Error | null = null;
        let triggered = false;
        const storage = new AfterPutHook(inner, key => key.endsWith(ENCRYPTION_MARKER_LEASE_SUFFIX), async () => {
          if (triggered) return;
          triggered = true;
          rivalError = await claim(inner, 'device-rival', arm.expectation, rivalPayload)
            .then(() => null).catch((error: Error) => error);
        });

        const published = await claim(storage, 'device-ours', arm.expectation, Buffer.from('marker-ours'))
          .catch((error: Error) => { throw new Error(`${ctx} 对手退出后已登记的写入者应完成: ${error.message}`); });
        expect(Buffer.from(published).toString()).toBe('marker-ours');
        expect(triggered, `${ctx} 交错必须实际发生`).toBe(true);
        expect(rivalError, `${ctx} 对手不得趁固定租约窗口宣告成功`).not.toBeNull();
        expect((rivalError as unknown as Error).message).toContain(SYNC_E2EE_CLAIM_CONFLICT_CODE);
        expect(Buffer.from(inner.bytes(MARKER_KEY)!).toString(), ctx).toBe('marker-ours');
        expect(inner.bytes(leaseKey()), ctx).toBeNull();
      }
    }
  });
});

/** A backend that advertises conditional PUT, so the first claim skips the lease. */
class ConditionalStorage extends CloudStorageBase {
  private readonly inner: MemoryStorage;

  constructor(inner: MemoryStorage) { super();
    this.inner = inner; }
  override providerName(): string { return 'memory-conditional'; }
  override async checkConnection(): Promise<void> { await this.inner.checkConnection(); }
  override supportsConditionalPut(): boolean { return true; }

  override async putIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
    if (this.inner.files.has(key)) return false;
    await this.inner.put(key, data);
    return true;
  }

  override async put(key: string, data: Uint8Array): Promise<void> { await this.inner.put(key, data); }
  override async get(key: string): Promise<Uint8Array | null> { return this.inner.get(key); }
  override async getBounded(key: string, maxBytes: number): Promise<Uint8Array | null> { return this.inner.getBounded(key, maxBytes); }
  override async list(prefix: string) { return this.inner.list(prefix); }
  override async listOutcome(prefix: string) { return this.inner.listOutcome(prefix); }
  override async delete(key: string): Promise<void> { await this.inner.delete(key); }
  override async stat(key: string) { return this.inner.stat(key); }
}
