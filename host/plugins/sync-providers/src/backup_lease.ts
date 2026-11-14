/**
 * backup-v2 / GC cloud repository lease (`backup_lease.rs`).
 *
 * This module only reserves a mutual-exclusion primitive for future backup-v2
 * repository writes and GC; there is no incremental backup implementation and no
 * production entry point wires it up. Record-level sync keeps using
 * `sync_lease` and `E_SYNC_LEASE_HELD`.
 *
 * Isolation from the record-level sync lease is a hard constraint:
 * - namespace is fixed to `backup-v2/locks/`; objects under
 *   `data_governance/locks/sync-target` are never read or written;
 * - the stable error code is `E_BACKUP_LEASE_HELD`, never `E_SYNC_LEASE_HELD`;
 * - truncated listings, unreadable leases and corrupted leases inside their
 *   fallback window all fail closed.
 */

import type { CloudStorage } from '../api.ts';
import { parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import { CloudStorageError } from './errors.ts';
import {
  type ActiveLease,
  type LeaseMessages,
  type LeaseRecord,
  type LeaseSpec,
  LeaseGuard,
  acquireLease,
} from './lease.ts';

/** backup-v2 repository lease object directory. */
export const BACKUP_REPO_LEASE_PREFIX = 'backup-v2/locks/';
/** Stable "repository lease is held" code, distinct from the sync lease. */
export const BACKUP_LEASE_HELD_ERROR_CODE = 'E_BACKUP_LEASE_HELD';
/** Default TTL: long operations renew via heartbeat; a crash recovers within 10 minutes. */
export const DEFAULT_BACKUP_LEASE_TTL_MS = 10 * 60 * 1000;
/** backup-v2 repository lease format version. */
export const BACKUP_REPO_LEASE_FORMAT_VERSION = 1;
const BACKUP_REPO_TARGET = 'backup-v2';

export type BackupRepoLease = LeaseRecord;

function holderLabel(active: ActiveLease): string {
  return active.lease?.holder_device_id ?? '未知设备（租约内容损坏）';
}

function expiresLabel(active: ActiveLease): string {
  const parsed = active.lease === null ? null : parseRfc3339(active.lease.expires_at);
  return toRfc3339(parsed?.epochNanos ?? active.fallbackExpiresAt);
}

function leaseHeldError(active: ActiveLease): CloudStorageError {
  return new CloudStorageError(
    'Conflict',
    `[${BACKUP_LEASE_HELD_ERROR_CODE}] 备份仓库租约被其他设备持有：${holderLabel(active)}`
      + `（预计 ${expiresLabel(active)} 到期）。`
      + '请等待另一台设备完成备份/GC，或等待租约过期后重试；不要手工覆盖云端备份仓库对象。',
  );
}

const messages: LeaseMessages = {
  missingDeviceId: '备份仓库租约缺少设备 ID',
  ttlOverflow: '备份仓库租约 TTL 超出可表示范围',
  ttlMustBePositive: '备份仓库租约 TTL 必须大于零',
  serializeFailed: detail => `序列化备份仓库租约失败: ${detail}`,
  writeFailed: detail => `写入备份仓库租约失败: ${detail}`,
  verifyReadFailed: detail => `回验备份仓库租约失败: ${detail}`,
  writeInvisible: '备份仓库租约写入后不可见，已拒绝开始操作',
  verifyParseFailed: detail => `回验备份仓库租约内容失败: ${detail}`,
  changedDuringWrite: `[${BACKUP_LEASE_HELD_ERROR_CODE}] 备份仓库租约在写入期间被其他客户端改动，`
    + '已拒绝开始操作；请稍后重试。',
  recycleReadFailed: detail => `回收备份仓库租约前复核失败: ${detail}`,
  recycleDeleteFailed: detail => `回收过期备份仓库租约失败: ${detail}`,
  listFailed: detail => `列举备份仓库租约失败: ${detail}`,
  listTruncated: '备份仓库租约列表不完整，无法证明当前没有其他持有者，'
    + '已拒绝开始操作（fail-closed）',
  readLeaseFailed: (key, detail) => `读取备份仓库租约失败 ${key}: ${detail}`,
  releaseReadFailed: detail => `释放备份仓库租约前读取失败: ${detail}`,
  releaseParseFailed: detail => `释放备份仓库租约前解析失败: ${detail}`,
  releaseOwnershipChanged: '备份仓库租约所有权已变化，拒绝删除不属于本次操作的租约',
  renewReadFailed: detail => `续租前读取备份仓库租约失败: ${detail}`,
  renewMissing: '备份仓库租约在操作完成前消失',
  renewParseFailed: detail => `备份仓库租约在持有期间损坏: ${detail}`,
  renewOwnershipChanged: '备份仓库租约所有权在持有期间变化',
  contenderInvisible: '备份仓库租约 contender 写入后不可见，已拒绝开始操作',
  commitUnconfirmed: `[${BACKUP_LEASE_HELD_ERROR_CODE}] 备份仓库租约提交后所有权无法确认，请稍后重试。`,
};

export const BACKUP_LEASE_SPEC: LeaseSpec = {
  serdeName: 'BackupRepoLease',
  prefix: BACKUP_REPO_LEASE_PREFIX,
  logPrefix: '[backup-lease]',
  target: BACKUP_REPO_TARGET,
  formatVersion: BACKUP_REPO_LEASE_FORMAT_VERSION,
  keyFor: operationId => `${BACKUP_REPO_LEASE_PREFIX}${operationId}.json`,
  messages,
  heldError: active => leaseHeldError(active),
};

export type BackupRepoLeaseGuard = LeaseGuard;

/** Acquires the backup-v2 repository lease with the default 10-minute TTL. */
export async function acquireBackupRepoLease(
  storage: CloudStorage,
  holderDeviceId: string,
): Promise<BackupRepoLeaseGuard> {
  return acquireBackupRepoLeaseWithTtl(storage, holderDeviceId, DEFAULT_BACKUP_LEASE_TTL_MS);
}

/** Acquires the lease with an explicit TTL (short TTLs are for protocol tests). */
export async function acquireBackupRepoLeaseWithTtl(
  storage: CloudStorage,
  holderDeviceId: string,
  ttlMs: number,
): Promise<BackupRepoLeaseGuard> {
  return acquireLease(BACKUP_LEASE_SPEC, storage, holderDeviceId, ttlMs);
}
