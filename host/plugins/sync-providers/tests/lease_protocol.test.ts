import { describe, expect, it } from 'vitest';
import type { ListOutcome } from '../api.ts';
import { acquireBackupRepoLeaseWithTtl, BACKUP_REPO_LEASE_PREFIX } from '../src/backup_lease.ts';
import { chronoAutoSiUtc } from '../src/time.ts';
import { acquireSyncTargetLeaseWithTtl, SYNC_TARGET_LEASE_PREFIX } from '../src/sync_lease.ts';
import { MemoryStorage } from './memory_storage.ts';

const NOW = Date.now();
const TTL = 600_000;

class TruncatedStorage extends MemoryStorage {
  override async listOutcome(prefix: string): Promise<ListOutcome> {
    return { files: await this.list(prefix), truncated: true };
  }
}

describe('lease contender protocol', () => {
  it('acquires, blocks a second device and releases its own object', async () => {
    const storage = new MemoryStorage();
    const guard = await acquireSyncTargetLeaseWithTtl(storage, 'device-a', TTL);

    expect(guard.lease.activation_committed).toBe(true);
    expect(guard.key.startsWith(`${SYNC_TARGET_LEASE_PREFIX}/`)).toBe(true);
    expect(storage.files.size).toBe(1);

    await expect(acquireSyncTargetLeaseWithTtl(storage, 'device-b', TTL))
      .rejects.toThrow(/E_SYNC_LEASE_HELD/);
    expect(storage.files.size).toBe(1);

    await guard.release();
    expect(storage.files.size).toBe(0);
    expect(storage.deleted).toContain(guard.key);
  });

  it('reclaims an expired contender before acquiring', async () => {
    const storage = new MemoryStorage();
    const oldKey = `${SYNC_TARGET_LEASE_PREFIX}/00000000-0000-4000-8000-000000000001.json`;
    storage.putAt(oldKey, Buffer.from(JSON.stringify({
      format_version: 1,
      target: 'data_governance',
      holder_device_id: 'device-old',
      operation_id: '00000000-0000-4000-8000-000000000001',
      created_at: chronoAutoSiUtc(NOW - 20 * 60 * 1000),
      expires_at: chronoAutoSiUtc(NOW - 10 * 60 * 1000),
      activation_committed: true,
    })), NOW - 20 * 60 * 1000);

    const guard = await acquireSyncTargetLeaseWithTtl(storage, 'device-new', TTL);
    expect(storage.files.has(oldKey)).toBe(false);
    expect(storage.files.size).toBe(1);
    await guard.release();
  });

  it('fails closed on a truncated listing', async () => {
    const storage = new TruncatedStorage();
    await expect(acquireSyncTargetLeaseWithTtl(storage, 'device-a', TTL))
      .rejects.toThrow(/列表不完整/);
    expect(storage.files.size).toBe(0);
  });

  it('keeps a corrupted contender inside the fallback window', async () => {
    const storage = new MemoryStorage();
    storage.putAt(
      `${SYNC_TARGET_LEASE_PREFIX}/00000000-0000-4000-8000-000000000002.json`,
      Buffer.from('{not json'),
      NOW - 1_000,
    );
    await expect(acquireSyncTargetLeaseWithTtl(storage, 'device-a', TTL))
      .rejects.toThrow(/未知设备（租约内容损坏）/);
    expect(storage.files.size).toBe(1);
  });

  it('reclaims a corrupted contender after the fallback window', async () => {
    const storage = new MemoryStorage();
    const key = `${SYNC_TARGET_LEASE_PREFIX}/00000000-0000-4000-8000-000000000003.json`;
    storage.putAt(key, Buffer.from('{not json'), NOW - TTL - 1_000);
    const guard = await acquireSyncTargetLeaseWithTtl(storage, 'device-a', TTL);
    expect(storage.files.has(key)).toBe(false);
    await guard.release();
  });

  it('keeps backup-v2 and record-level sync leases independent', async () => {
    const storage = new MemoryStorage();
    const backup = await acquireBackupRepoLeaseWithTtl(storage, 'device-a', TTL);
    const sync = await acquireSyncTargetLeaseWithTtl(storage, 'device-a', TTL);
    expect(backup.key.startsWith(BACKUP_REPO_LEASE_PREFIX)).toBe(true);
    expect(sync.key.startsWith(`${SYNC_TARGET_LEASE_PREFIX}/`)).toBe(true);
    expect(storage.files.size).toBe(2);
    await sync.release();
    await backup.release();
    expect(storage.files.size).toBe(0);
  });
});
