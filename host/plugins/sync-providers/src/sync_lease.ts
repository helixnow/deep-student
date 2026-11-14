/**
 * Record-level sync cloud target lease (`sync_lease.rs`, R11-lease).
 *
 * `CloudStorage` is dumb storage without conditional PUT / compare-and-swap, so
 * the lease uses independent contender objects (see `lease.ts`): reclaim expired
 * contenders, reject when an active one exists, write a pending contender, elect
 * by `(created_at, operation_id)`, promote the winner to committed and confirm
 * ownership with one more complete listing.
 *
 * Normal exit deletes only the object whose operation ID matches; pending or
 * committed objects left by a crash are reclaimed after the TTL.
 */

import type { CloudStorage } from '../api.ts';
import { parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import { rustTrim } from '../../../platform/util/portable.ts';
import { CloudStorageError } from './errors.ts';
import {
  type ActiveLease,
  type LeaseMessages,
  type LeaseRecord,
  type LeaseSpec,
  LeaseGuard,
  acquireLease,
} from './lease.ts';

/** Cloud lease object directory. Each operation uses its own key. */
export const SYNC_TARGET_LEASE_PREFIX = 'data_governance/locks/sync-target';
/** Stable "lease is held" code used by automatic sync. */
export const SYNC_LEASE_HELD_ERROR_CODE = 'E_SYNC_LEASE_HELD';
/**
 * Sub-code when the holder is this device (#447).
 *
 * It is prefixed by `SYNC_LEASE_HELD_ERROR_CODE`, so existing handling based on
 * the `E_SYNC_LEASE_HELD` substring (auto-sync skip, frontend classification)
 * keeps working while the frontend can say "this device's previous sync did not
 * finish" instead of asking the user to wait for a non-existent other device.
 */
export const SYNC_LEASE_HELD_BY_SELF_ERROR_CODE = 'E_SYNC_LEASE_HELD_SELF';
/** Default TTL: long syncs renew via heartbeat; a crash recovers within 10 minutes. */
export const DEFAULT_SYNC_LEASE_TTL_MS = 10 * 60 * 1000;
/** Lease format version. */
export const SYNC_TARGET_LEASE_FORMAT_VERSION = 1;
const SYNC_TARGET = 'data_governance';

export type SyncTargetLease = LeaseRecord;

function holderLabel(active: ActiveLease): string {
  return active.lease?.holder_device_id ?? '未知设备（租约内容损坏）';
}

function expiresLabel(active: ActiveLease): string {
  const parsed = active.lease === null ? null : parseRfc3339(active.lease.expires_at);
  return toRfc3339(parsed?.epochNanos ?? active.fallbackExpiresAt);
}

function heldByDevice(active: ActiveLease, deviceId: string): boolean {
  const local = rustTrim(deviceId);
  return local !== ''
    && active.lease !== null
    && rustTrim(active.lease.holder_device_id) === local;
}

/**
 * Builds the "lease is held" error.
 *
 * When the holder is this device (#447) the previous sync most likely died
 * without releasing. We do **not** reclaim it immediately: the same device ID can
 * belong to another live process (dev and release bundles, a copied data
 * directory). Without CAS the TTL is the only provably safe reclaim path.
 */
export function syncLeaseHeldError(active: ActiveLease, localDeviceId: string): CloudStorageError {
  if (heldByDevice(active, localDeviceId)) {
    return new CloudStorageError(
      'Conflict',
      `[${SYNC_LEASE_HELD_BY_SELF_ERROR_CODE}] 本机（${holderLabel(active)}）`
        + '上一次同步没有正常结束（例如同步进行中关闭或重启了应用），'
        + `云端遗留的同步租约尚未过期（预计 ${expiresLabel(active)} 到期）。`
        + '租约到期后会自动回收，届时重试即可；这不是其他设备在同步。'
        + '若本机另有一个应用实例正在同步，请等待它完成。不要手工覆盖云端同步文件。',
    );
  }
  return new CloudStorageError(
    'Conflict',
    `[${SYNC_LEASE_HELD_ERROR_CODE}] 同步目标租约被其他设备持有：${holderLabel(active)}`
      + `（预计 ${expiresLabel(active)} 到期）。`
      + '请等待另一台设备完成同步，或等待租约过期后重试；不要手工覆盖云端同步文件。',
  );
}

const messages: LeaseMessages = {
  missingDeviceId: '同步租约缺少设备 ID',
  ttlOverflow: '同步租约 TTL 超出可表示范围',
  ttlMustBePositive: '同步租约 TTL 必须大于零',
  serializeFailed: detail => `序列化同步租约失败: ${detail}`,
  writeFailed: detail => `写入同步租约失败: ${detail}`,
  verifyReadFailed: detail => `回验同步租约失败: ${detail}`,
  writeInvisible: '同步租约写入后不可见，已拒绝开始同步',
  verifyParseFailed: detail => `回验同步租约内容失败: ${detail}`,
  changedDuringWrite: `[${SYNC_LEASE_HELD_ERROR_CODE}] 同步租约在写入期间被其他客户端改动，`
    + '已拒绝开始同步；请稍后重试。',
  recycleReadFailed: detail => `回收同步租约前复核失败: ${detail}`,
  recycleDeleteFailed: detail => `回收过期同步租约失败: ${detail}`,
  listFailed: detail => `列举同步租约失败: ${detail}`,
  listTruncated: '同步租约列表不完整，无法证明当前没有其他持有者，'
    + '已拒绝开始同步（fail-closed）',
  readLeaseFailed: (key, detail) => `读取同步租约失败 ${key}: ${detail}`,
  releaseReadFailed: detail => `释放同步租约前读取失败: ${detail}`,
  releaseParseFailed: detail => `释放同步租约前解析失败: ${detail}`,
  releaseOwnershipChanged: '同步租约所有权已变化，拒绝删除不属于本次操作的租约',
  renewReadFailed: detail => `续租前读取同步租约失败: ${detail}`,
  renewMissing: '同步租约在操作完成前消失',
  renewParseFailed: detail => `同步租约在持有期间损坏: ${detail}`,
  renewOwnershipChanged: '同步租约所有权在持有期间变化',
  contenderInvisible: '同步租约 contender 写入后不可见，已拒绝开始同步',
  commitUnconfirmed: `[${SYNC_LEASE_HELD_ERROR_CODE}] 同步租约提交后所有权无法确认，请稍后重试。`,
};

export const SYNC_LEASE_SPEC: LeaseSpec = {
  serdeName: 'SyncTargetLease',
  prefix: SYNC_TARGET_LEASE_PREFIX,
  logPrefix: '[sync-lease]',
  target: SYNC_TARGET,
  formatVersion: SYNC_TARGET_LEASE_FORMAT_VERSION,
  keyFor: operationId => `${SYNC_TARGET_LEASE_PREFIX}/${operationId}.json`,
  messages,
  heldError: (active, localDeviceId) => syncLeaseHeldError(active, localDeviceId),
};

export type SyncTargetLeaseGuard = LeaseGuard;

/** Acquires the sync target lease with the default 10-minute TTL. */
export async function acquireSyncTargetLease(
  storage: CloudStorage,
  holderDeviceId: string,
): Promise<SyncTargetLeaseGuard> {
  return acquireSyncTargetLeaseWithTtl(storage, holderDeviceId, DEFAULT_SYNC_LEASE_TTL_MS);
}

/** Acquires the lease with an explicit TTL (short TTLs are for protocol tests). */
export async function acquireSyncTargetLeaseWithTtl(
  storage: CloudStorage,
  holderDeviceId: string,
  ttlMs: number,
): Promise<SyncTargetLeaseGuard> {
  return acquireLease(SYNC_LEASE_SPEC, storage, holderDeviceId, ttlMs);
}
