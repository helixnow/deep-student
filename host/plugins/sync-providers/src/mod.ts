/**
 * Module-level constants and pure predicates from cloud_storage/mod.rs.
 *
 * The stable E2EE error codes are part of the wire contract: the frontend dispatches on
 * them and never on the message text (mod.rs:94-108).
 */

import { CloudStorageError } from './errors.ts';
import { defaultLogSink } from './logging.ts';

export const CLOUD_RATE_LIMITED_CODE = 'E_CLOUD_RATE_LIMITED';
export const SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE = 'E_SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED';
export const SYNC_E2EE_WRONG_PASSWORD_CODE = 'E_SYNC_E2EE_WRONG_PASSWORD';
export const SYNC_E2EE_MARKER_CORRUPTED_CODE = 'E_SYNC_E2EE_MARKER_CORRUPTED';
export const SYNC_E2EE_PASSWORD_REQUIRED_CODE = 'E_SYNC_E2EE_PASSWORD_REQUIRED';
export const SYNC_E2EE_DOWNGRADE_REJECTED_CODE = 'E_SYNC_E2EE_DOWNGRADE_REJECTED';
export const SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE = 'E_SYNC_E2EE_MEMORY_PERSIST_FAILED';

export function isCloudRateLimited(message: string): boolean {
  return message.includes(CLOUD_RATE_LIMITED_CODE);
}

/** mod.rs:111: prefix a fail-closed diagnosis with its stable code. */
export function syncE2eeError(code: string, message: string): string {
  return `[${code}] ${message}`;
}

export interface DowngradeDecision {
  cloudMarkerPresent: boolean;
  locallyRememberedEncrypted: boolean;
  objectIsEncrypted: boolean;
  plaintextHistoryOptIn: boolean;
}

export type DegradeRejection = { rejected: false } | { rejected: true; message: string };

/**
 * mod.rs:139 `ensure_download_not_degraded`: returns `Result<(), AppError>` in Rust,
 * so rejection is a thrown `Validation` error (never a silent success value).
 *
 * - DSBK ciphertext always passes through to the decryption chain;
 * - no marker and no local memory is a legitimate pre-E2EE plaintext backup;
 * - an explicit per-download opt-in relaxes only this gate;
 * - otherwise the object is treated as a downgrade attack and rejected.
 */
export function ensureDownloadNotDegraded(decision: DowngradeDecision): void {
  if (decision.objectIsEncrypted) return;
  if (!decision.cloudMarkerPresent && !decision.locallyRememberedEncrypted) return;
  if (decision.plaintextHistoryOptIn) {
    defaultLogSink().warn(
      '[CloudSync][R6-downgrade-optin] 用户显式确认恢复明文历史版本，本次放行'
      + `（云端标记存在: ${decision.cloudMarkerPresent}, 本机曾加密记忆: ${decision.locallyRememberedEncrypted}）。`
      + '该确认不持久化，仅对本次下载有效。',
    );
    return;
  }
  if (decision.cloudMarkerPresent) {
    throw new CloudStorageError('Validation', syncE2eeError(
      SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
      '云端已登记端到端加密标记，但下载到的备份对象不是 DSBK 密文，疑似密文被明文替换（降级攻击）或云端目录被篡改，已拒绝还原该对象。请人工核查云端目录完整性后重试。',
    ));
  }
  throw new CloudStorageError('Validation', syncE2eeError(
    SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
    '云端加密标记已缺失，但本机记忆显示该云端目录曾启用端到端加密，且下载到的备份对象不是 DSBK 密文——疑似云端目录被降级篡改（加密标记被删除、密文被明文替换），已拒绝还原该对象。请人工核查云端目录完整性后重试。',
  ));
}

