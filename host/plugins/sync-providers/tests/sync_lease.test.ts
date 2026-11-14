import { describe, expect, it } from 'vitest';
import { createLeaseRecord, leaseKey, type ActiveLease } from '../src/lease.ts';
import {
  DEFAULT_SYNC_LEASE_TTL_MS,
  SYNC_LEASE_HELD_BY_SELF_ERROR_CODE,
  SYNC_LEASE_HELD_ERROR_CODE,
  SYNC_LEASE_SPEC,
  syncLeaseHeldError,
} from '../src/sync_lease.ts';

const NOW = Date.parse('2026-10-06T06:00:00Z');

function activeLeaseFor(holder: string): ActiveLease {
  const lease = createLeaseRecord(SYNC_LEASE_SPEC, holder, DEFAULT_SYNC_LEASE_TTL_MS, BigInt(NOW) * 1_000_000n);
  return {
    key: leaseKey(SYNC_LEASE_SPEC, lease.operation_id),
    lease,
    fallbackExpiresAt: BigInt(NOW) * 1_000_000n,
  };
}

describe('sync_lease.rs', () => {
  it('lease_held_by_this_device_reports_unfinished_previous_sync', () => {
    const active = activeLeaseFor('LAPTOP-NLLQ1V2J-24357239');
    const message = syncLeaseHeldError(active, ' LAPTOP-NLLQ1V2J-24357239 ').message;

    expect(message).toContain(SYNC_LEASE_HELD_BY_SELF_ERROR_CODE);
    // Still the same error-code family: E_SYNC_LEASE_HELD substring handling works.
    expect(message).toContain(SYNC_LEASE_HELD_ERROR_CODE);
    expect(message).toContain('上一次同步没有正常结束');
    expect(message).toContain('2026-10-06T06:10:00+00:00');
    expect(message).not.toContain('其他设备持有');
    expect(message).not.toContain('请等待另一台设备');
  });

  it('lease_held_by_another_device_keeps_existing_message', () => {
    const active = activeLeaseFor('device-other');
    const message = syncLeaseHeldError(active, 'device-local').message;

    expect(message).toContain('[E_SYNC_LEASE_HELD]');
    expect(message).not.toContain(SYNC_LEASE_HELD_BY_SELF_ERROR_CODE);
    expect(message).toContain('被其他设备持有：device-other');
  });

  it('corrupt_or_unknown_holder_is_never_treated_as_self', () => {
    const corrupt = activeLeaseFor('device-local');
    corrupt.lease = null;
    const corruptMessage = syncLeaseHeldError(corrupt, 'device-local').message;
    expect(corruptMessage).not.toContain(SYNC_LEASE_HELD_BY_SELF_ERROR_CODE);

    const active = activeLeaseFor('device-local');
    const blankMessage = syncLeaseHeldError(active, '  ').message;
    expect(blankMessage).not.toContain(SYNC_LEASE_HELD_BY_SELF_ERROR_CODE);
  });
});
