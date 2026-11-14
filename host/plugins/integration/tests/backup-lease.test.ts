import { describe, expect, it } from 'vitest';
import type { ListOutcome } from '../../sync-providers/api.ts';
import {
  BACKUP_LEASE_HELD_ERROR_CODE,
  BACKUP_REPO_LEASE_FORMAT_VERSION,
  BACKUP_REPO_LEASE_PREFIX,
  DEFAULT_BACKUP_LEASE_TTL_MS,
  SYNC_LEASE_HELD_ERROR_CODE,
  SYNC_TARGET_LEASE_PREFIX,
  acquireBackupRepoLeaseWithTtl,
  type BackupRepoLease,
} from '../../sync-providers/api.ts';
import { MemoryCloud } from './memory-cloud.ts';

/**
 * `sync_r12_backup_lease.rs` 的 TS 行为级移植：backup-v2 仓库租约。
 *
 * 验证 L23 发布的生产实现（`acquireBackupRepoLeaseWithTtl`），并钉死
 * namespace / 稳定错误码与记录级同步租约的隔离。
 */
class BarrierCloud extends MemoryCloud {
  private arrivals = 0;
  private putArrivals = 0;
  private readonly bothArrived: Promise<void>;
  private releaseBarrier!: () => void;
  private readonly bothPut: Promise<void>;
  private releasePut!: () => void;

  constructor() {
    super('memory-backup-lease-barrier');
    this.bothArrived = new Promise(resolve => { this.releaseBarrier = resolve; });
    this.bothPut = new Promise(resolve => { this.releasePut = resolve; });
  }

  override async put(key: string, data: Uint8Array): Promise<void> {
    await super.put(key, data);
    if (key.startsWith(BACKUP_REPO_LEASE_PREFIX)) {
      this.putArrivals += 1;
      if (this.putArrivals >= 2) this.releasePut();
      await this.bothPut;
    }
  }

  override async listOutcome(prefix: string): Promise<ListOutcome> {
    const outcome = await super.listOutcome(prefix);
    if (prefix.startsWith(BACKUP_REPO_LEASE_PREFIX) && outcome.files.length === 0) {
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
): BackupRepoLease {
  return {
    format_version: BACKUP_REPO_LEASE_FORMAT_VERSION,
    target: 'backup-v2',
    holder_device_id: holder,
    operation_id: operationId,
    created_at: new Date(createdAt).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    activation_committed: committed,
  };
}

function insertLease(storage: MemoryCloud, lease: BackupRepoLease): string {
  const key = `${BACKUP_REPO_LEASE_PREFIX}${lease.operation_id}.json`;
  storage.insertRaw(key, JSON.stringify(lease));
  return key;
}

function backupLeaseKeys(storage: MemoryCloud): string[] {
  return storage.keys().filter(key => key.startsWith(BACKUP_REPO_LEASE_PREFIX));
}

describe('sync_r12_backup_lease.rs', () => {
  it('concurrent_devices_elect_exactly_one_committed_holder', async () => {
    const storage = new BarrierCloud();
    const [deviceA, deviceB] = await Promise.allSettled([
      acquireBackupRepoLeaseWithTtl(storage, 'device-a', 60_000),
      acquireBackupRepoLeaseWithTtl(storage, 'device-b', 60_000),
    ]);

    expect(deviceA.status === 'fulfilled').not.toBe(deviceB.status === 'fulfilled');

    const loser = deviceA.status === 'rejected' ? deviceA.reason : (deviceB as PromiseRejectedResult).reason;
    const loserMessage = String(loser);
    expect(loserMessage).toContain(BACKUP_LEASE_HELD_ERROR_CODE);
    expect(loserMessage).not.toContain(SYNC_LEASE_HELD_ERROR_CODE);

    expect(storage.keys().every(key => key.startsWith(BACKUP_REPO_LEASE_PREFIX))).toBe(true);

    for (const result of [deviceA, deviceB]) {
      if (result.status === 'fulfilled') {
        expect(result.value.lease.activation_committed).toBe(true);
        await result.value.release();
      }
    }
    expect(backupLeaseKeys(storage)).toEqual([]);
  });

  it('live_lease_returns_stable_backup_code_and_retry_guidance', async () => {
    const storage = new MemoryCloud();
    const holder = await acquireBackupRepoLeaseWithTtl(storage, 'device-a', 60_000);

    const error = await acquireBackupRepoLeaseWithTtl(storage, 'device-b', 60_000)
      .then(() => { throw new Error('活锁期间第二台设备必须被拒绝'); }, (reason: unknown) => String(reason));
    expect(error).toContain(BACKUP_LEASE_HELD_ERROR_CODE);
    expect(error).not.toContain(SYNC_LEASE_HELD_ERROR_CODE);
    expect(error).toContain('等待');
    expect(error).toContain('重试');

    await holder.release();
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

    const guard = await acquireBackupRepoLeaseWithTtl(storage, 'recovery-device', 60_000);
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

    await expect(acquireBackupRepoLeaseWithTtl(storage, 'device-b', 60_000))
      .rejects.toThrow(new RegExp(BACKUP_LEASE_HELD_ERROR_CODE));

    storage.insertRaw(key, JSON.stringify(leaseRecord(
      'crashed-mid-acquire',
      operationId,
      now - 10 * 60_000,
      now - 1_000,
      false,
    )));

    const recovered = await acquireBackupRepoLeaseWithTtl(storage, 'device-b', 60_000);
    await recovered.release();
  });

  it('truncated_lease_listing_fails_closed_with_zero_locks', async () => {
    const storage = new MemoryCloud();
    storage.truncatedPrefixes.add(BACKUP_REPO_LEASE_PREFIX);

    const error = await acquireBackupRepoLeaseWithTtl(storage, 'device-a', 60_000)
      .then(() => { throw new Error('列表截断时不能证明没有竞争者'); }, (reason: unknown) => String(reason));
    expect(error).toContain('列表不完整');
    expect(error).toContain('fail-closed');
    expect(backupLeaseKeys(storage)).toEqual([]);
    expect(storage.keys()).toEqual([]);
  });

  it('default_ttl_is_ten_minutes_and_namespaces_are_isolated', () => {
    expect(DEFAULT_BACKUP_LEASE_TTL_MS).toBe(10 * 60_000);
    expect(BACKUP_REPO_LEASE_PREFIX.startsWith('backup-v2/locks/')).toBe(true);
    expect(BACKUP_REPO_LEASE_PREFIX.startsWith(SYNC_TARGET_LEASE_PREFIX)).toBe(false);
    expect(SYNC_TARGET_LEASE_PREFIX.startsWith(BACKUP_REPO_LEASE_PREFIX)).toBe(false);
    expect(BACKUP_LEASE_HELD_ERROR_CODE).not.toBe(SYNC_LEASE_HELD_ERROR_CODE);
  });
});
