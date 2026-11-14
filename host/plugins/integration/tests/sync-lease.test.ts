import { describe, expect, it } from 'vitest';
import type { ListOutcome } from '../../sync-providers/api.ts';
import {
  SYNC_LEASE_HELD_BY_SELF_ERROR_CODE,
  SYNC_LEASE_HELD_ERROR_CODE,
  SYNC_TARGET_LEASE_FORMAT_VERSION,
  SYNC_TARGET_LEASE_PREFIX,
  acquireSyncTargetLeaseWithTtl,
  type SyncTargetLease,
} from '../../sync-providers/api.ts';
import { MemoryCloud } from './memory-cloud.ts';

/**
 * `sync_r11_lease.rs` 的 TS 行为级移植：记录级同步目标租约。
 *
 * 直接验证 L23 `sync-providers` 发布的生产实现（`acquireSyncTargetLeaseWithTtl`），
 * 用真实 contender 协议对抗内存云存储；不复制算法、不 mock 被测函数。
 */
class BarrierCloud extends MemoryCloud {
  private arrivals = 0;
  private putArrivals = 0;
  private readonly bothArrived: Promise<void>;
  private releaseBarrier!: () => void;
  private readonly bothPut: Promise<void>;
  private releasePut!: () => void;

  constructor() {
    super('memory-lease-barrier');
    this.bothArrived = new Promise(resolve => { this.releaseBarrier = resolve; });
    this.bothPut = new Promise(resolve => { this.releasePut = resolve; });
  }

  override async put(key: string, data: Uint8Array): Promise<void> {
    await super.put(key, data);
    if (key.startsWith(SYNC_TARGET_LEASE_PREFIX)) {
      this.putArrivals += 1;
      if (this.putArrivals >= 2) this.releasePut();
      await this.bothPut;
    }
  }

  override async listOutcome(prefix: string): Promise<ListOutcome> {
    const outcome = await super.listOutcome(prefix);
    if (prefix.startsWith(SYNC_TARGET_LEASE_PREFIX) && outcome.files.length === 0) {
      this.arrivals += 1;
      if (this.arrivals >= 2) this.releaseBarrier();
      await this.bothArrived;
    }
    return outcome;
  }
}

function leaseRecord(
  holder: string,
  operationId: string,
  createdAt: number,
  expiresAt: number,
  committed: boolean,
): SyncTargetLease {
  return {
    format_version: SYNC_TARGET_LEASE_FORMAT_VERSION,
    target: 'data_governance',
    holder_device_id: holder,
    operation_id: operationId,
    created_at: new Date(createdAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    activation_committed: committed,
  };
}

function insertLease(storage: MemoryCloud, lease: SyncTargetLease): string {
  const key = `${SYNC_TARGET_LEASE_PREFIX}/${lease.operation_id}.json`;
  storage.insertRaw(key, JSON.stringify(lease));
  return key;
}

function syncLeaseKeys(storage: MemoryCloud): string[] {
  return storage.keys().filter(key => key.startsWith(SYNC_TARGET_LEASE_PREFIX));
}

describe('sync_r11_lease.rs', () => {
  it('concurrent_devices_elect_exactly_one_committed_holder', async () => {
    const storage = new BarrierCloud();
    const [deviceA, deviceB] = await Promise.allSettled([
      acquireSyncTargetLeaseWithTtl(storage, 'device-a', 60_000),
      acquireSyncTargetLeaseWithTtl(storage, 'device-b', 60_000),
    ]);

    expect(deviceA.status === 'fulfilled').not.toBe(deviceB.status === 'fulfilled');

    const loser = deviceA.status === 'rejected' ? deviceA.reason : (deviceB as PromiseRejectedResult).reason;
    const loserMessage = String(loser);
    expect(loserMessage).toContain(SYNC_LEASE_HELD_ERROR_CODE);

    // namespace 隔离：选主过程只写 data_governance/locks/sync-target/。
    expect(storage.keys().every(key => key.startsWith(SYNC_TARGET_LEASE_PREFIX))).toBe(true);

    for (const result of [deviceA, deviceB]) {
      if (result.status === 'fulfilled') {
        expect(result.value.lease.activation_committed).toBe(true);
        await result.value.release();
      }
    }
    expect(syncLeaseKeys(storage)).toEqual([]);
  });

  it('live_lease_returns_stable_code_and_retry_guidance', async () => {
    const storage = new MemoryCloud();
    const holder = await acquireSyncTargetLeaseWithTtl(storage, 'device-a', 60_000);

    const error = await acquireSyncTargetLeaseWithTtl(storage, 'device-b', 60_000)
      .then(() => { throw new Error('活锁期间第二台设备必须被拒绝'); }, (reason: unknown) => String(reason));
    expect(error).toContain(SYNC_LEASE_HELD_ERROR_CODE);
    expect(error).toContain('等待');
    expect(error).toContain('重试');

    await holder.release();
  });

  it('lease_left_by_this_device_reports_self_and_is_not_preempted', async () => {
    const storage = new MemoryCloud();
    const leftover = await acquireSyncTargetLeaseWithTtl(storage, 'device-a', 60_000);

    const error = await acquireSyncTargetLeaseWithTtl(storage, 'device-a', 60_000)
      .then(() => { throw new Error('同设备 ID 的活跃租约同样必须拒绝'); }, (reason: unknown) => String(reason));
    expect(error).toContain(SYNC_LEASE_HELD_BY_SELF_ERROR_CODE);
    expect(error).toContain(SYNC_LEASE_HELD_ERROR_CODE);
    expect(error).toContain('上一次同步没有正常结束');
    expect(error).not.toContain('其他设备持有');
    expect(syncLeaseKeys(storage)).toHaveLength(1);

    await leftover.release();
  });

  it('expired_committed_lease_is_reclaimed_before_acquire', async () => {
    const storage = new MemoryCloud();
    const now = Date.now();
    const staleKey = insertLease(storage, leaseRecord(
      'crashed-device',
      '10000000-0000-4000-8000-000000000001',
      now - 20 * 60_000,
      now - 10 * 60_000,
      true,
    ));

    const guard = await acquireSyncTargetLeaseWithTtl(storage, 'recovery-device', 60_000);
    expect(storage.keys()).not.toContain(staleKey);
    await guard.release();
  });

  it('crash_pending_residue_blocks_until_ttl_then_recovers', async () => {
    const storage = new MemoryCloud();
    const operationId = '20000000-0000-4000-8000-000000000002';
    const now = Date.now();
    const key = insertLease(storage, leaseRecord(
      'crashed-mid-acquire',
      operationId,
      now,
      now + 5 * 60_000,
      false,
    ));

    await expect(acquireSyncTargetLeaseWithTtl(storage, 'device-b', 60_000))
      .rejects.toThrow(new RegExp(SYNC_LEASE_HELD_ERROR_CODE));

    storage.insertRaw(key, JSON.stringify(leaseRecord(
      'crashed-mid-acquire',
      operationId,
      now - 10 * 60_000,
      now - 1_000,
      false,
    )));

    const recovered = await acquireSyncTargetLeaseWithTtl(storage, 'device-b', 60_000);
    await recovered.release();
  });

  it('truncated_lease_listing_fails_closed', async () => {
    const storage = new MemoryCloud();
    storage.truncatedPrefixes.add(SYNC_TARGET_LEASE_PREFIX);

    const error = await acquireSyncTargetLeaseWithTtl(storage, 'device-a', 60_000)
      .then(() => { throw new Error('列表截断时不能证明没有竞争者'); }, (reason: unknown) => String(reason));
    expect(error).toContain('列表不完整');
    expect(error).toContain('fail-closed');
    expect(syncLeaseKeys(storage)).toEqual([]);
  });
});
