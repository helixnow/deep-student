import { describe, expect, it } from 'vitest';
import {
  BACKUP_LEASE_HELD_ERROR_CODE,
  BACKUP_LEASE_SPEC,
  BACKUP_REPO_LEASE_PREFIX,
  DEFAULT_BACKUP_LEASE_TTL_MS,
} from '../src/backup_lease.ts';
import { createLeaseRecord, leaseKey } from '../src/lease.ts';
import {
  SYNC_LEASE_HELD_ERROR_CODE,
  SYNC_TARGET_LEASE_PREFIX,
} from '../src/sync_lease.ts';

describe('backup_lease.rs', () => {
  it('backup_lease_namespace_is_isolated_from_sync_lease', () => {
    expect(BACKUP_REPO_LEASE_PREFIX.startsWith('backup-v2/locks/')).toBe(true);
    expect(BACKUP_REPO_LEASE_PREFIX.includes('data_governance')).toBe(false);
    const lease = createLeaseRecord(BACKUP_LEASE_SPEC, 'device-a', 60_000, BigInt(Date.now()) * 1_000_000n);
    const key = leaseKey(BACKUP_LEASE_SPEC, lease.operation_id);
    expect(key.startsWith('backup-v2/locks/')).toBe(true);
    expect(key.includes('data_governance/locks/sync-target')).toBe(false);
  });

  it('backup_lease_error_code_is_distinct_from_sync_lease', () => {
    expect(BACKUP_LEASE_HELD_ERROR_CODE).toBe('E_BACKUP_LEASE_HELD');
    expect(BACKUP_LEASE_HELD_ERROR_CODE).not.toBe(SYNC_LEASE_HELD_ERROR_CODE);
    expect(BACKUP_REPO_LEASE_PREFIX.replace(/\/+$/, '')).not.toBe(SYNC_TARGET_LEASE_PREFIX);
  });

  it('default_ttl_is_ten_minutes', () => {
    expect(DEFAULT_BACKUP_LEASE_TTL_MS).toBe(600_000);
  });
});
