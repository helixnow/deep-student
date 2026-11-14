import { describe, expect, it } from 'vitest';
import {
  SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
  SYNC_E2EE_MARKER_CORRUPTED_CODE,
  SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
  ensureDownloadNotDegraded,
  isCloudRateLimited,
  syncE2eeError,
  CLOUD_RATE_LIMITED_CODE,
  type DowngradeDecision,
} from '../src/mod.ts';
import { CloudStorageError } from '../src/errors.ts';
import { createBackupCrypto } from '../../../platform/secrets/backup-crypto.ts';
import { defaultLogSink, setDefaultLogSink, type LogSink } from '../src/logging.ts';

const backup = createBackupCrypto();

/** mod.rs:785-799/827-837: rejection is `AppErrorType::Validation`, not a plain string. */
function rejection(decision: DowngradeDecision): CloudStorageError {
  try {
    ensureDownloadNotDegraded(decision);
  } catch (error) {
    if (error instanceof CloudStorageError) return error;
    throw error;
  }
  throw new Error('expected ensureDownloadNotDegraded to reject');
}

function expectAllowed(decision: DowngradeDecision): void {
  expect(() => ensureDownloadNotDegraded(decision)).not.toThrow();
}

describe('cloud_storage/mod.rs', () => {
  it('sync_e2ee_error_prefixes_stable_codes', () => {
    expect(syncE2eeError(SYNC_E2EE_WRONG_PASSWORD_CODE, '密码不一致'))
      .toBe(`[${SYNC_E2EE_WRONG_PASSWORD_CODE}] 密码不一致`);
    expect(syncE2eeError(SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE, '已拒绝未加密上传')
      .startsWith(`[${SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE}]`)).toBe(true);
    expect(syncE2eeError(SYNC_E2EE_MARKER_CORRUPTED_CODE, '缺少密码校验子')
      .includes(SYNC_E2EE_MARKER_CORRUPTED_CODE)).toBe(true);
  });

  it('is_cloud_rate_limited_matches_only_the_stable_code', () => {
    expect(isCloudRateLimited(`[${CLOUD_RATE_LIMITED_CODE}] 429 Too Many Requests`)).toBe(true);
    expect(isCloudRateLimited('429 Too Many Requests')).toBe(false);
    expect(isCloudRateLimited('network timeout')).toBe(false);
  });

  it('download_rejected_when_marker_present_but_object_not_dsbk', () => {
    const error = rejection({
      cloudMarkerPresent: true,
      locallyRememberedEncrypted: false,
      objectIsEncrypted: false,
      plaintextHistoryOptIn: false,
    });
    // Rust: assert!(matches!(error.error_type, AppErrorType::Validation)).
    expect(error.value.error_type).toBe('Validation');
    expect(error.value.details).toBeNull();
    expect(error.value.message).toBe(error.message);
    expect(error.message.includes(SYNC_E2EE_DOWNGRADE_REJECTED_CODE)).toBe(true);
    expect(error.message.startsWith(`[${SYNC_E2EE_DOWNGRADE_REJECTED_CODE}]`)).toBe(true);
    expect(error.message).toContain('云端已登记端到端加密标记');
  });

  it('download_allowed_when_marker_present_and_object_is_dsbk', () => {
    expectAllowed({
      cloudMarkerPresent: true,
      locallyRememberedEncrypted: false,
      objectIsEncrypted: true,
      plaintextHistoryOptIn: false,
    });
  });

  it('download_allowed_for_legacy_plaintext_without_marker', () => {
    expectAllowed({
      cloudMarkerPresent: false,
      locallyRememberedEncrypted: false,
      objectIsEncrypted: false,
      plaintextHistoryOptIn: false,
    });
  });

  it('download_allowed_for_dsbk_without_marker', () => {
    expectAllowed({
      cloudMarkerPresent: false,
      locallyRememberedEncrypted: false,
      objectIsEncrypted: true,
      plaintextHistoryOptIn: false,
    });
  });

  it('download_rejected_when_marker_deleted_but_locally_remembered', () => {
    const error = rejection({
      cloudMarkerPresent: false,
      locallyRememberedEncrypted: true,
      objectIsEncrypted: false,
      plaintextHistoryOptIn: false,
    });
    // Rust: assert!(matches!(error.error_type, AppErrorType::Validation)).
    expect(error.value.error_type).toBe('Validation');
    expect(error.value.details).toBeNull();
    expect(error.value.message).toBe(error.message);
    expect(error.message.startsWith(`[${SYNC_E2EE_DOWNGRADE_REJECTED_CODE}]`)).toBe(true);
    expect(error.message).toContain('云端加密标记已缺失');
  });

  it('download_allowed_for_dsbk_when_locally_remembered', () => {
    expectAllowed({
      cloudMarkerPresent: false,
      locallyRememberedEncrypted: true,
      objectIsEncrypted: true,
      plaintextHistoryOptIn: false,
    });
  });

  it('download_opt_in_allows_plaintext_history_once', () => {
    for (const [marker, remembered] of [[true, false], [false, true], [true, true]] as const) {
      expectAllowed({
        cloudMarkerPresent: marker,
        locallyRememberedEncrypted: remembered,
        objectIsEncrypted: false,
        plaintextHistoryOptIn: true,
      });
    }
  });

  it('download_opt_in_has_no_effect_on_ciphertext_and_default_still_rejects', () => {
    expectAllowed({
      cloudMarkerPresent: true,
      locallyRememberedEncrypted: true,
      objectIsEncrypted: true,
      plaintextHistoryOptIn: true,
    });
    const error = rejection({
      cloudMarkerPresent: true,
      locallyRememberedEncrypted: false,
      objectIsEncrypted: false,
      plaintextHistoryOptIn: false,
    });
    expect(error.value.error_type).toBe('Validation');
    expect(error.value.message).toBe(error.message);
  });

  it('download_head_classification_matches_backup_crypto_magic', () => {
    expect(backup.isEncryptedBackup(Buffer.from([0x50, 0x4b, 3, 4]))).toBe(false);
    expect(backup.isEncryptedBackup(Buffer.from([0x00, 0x11, 0x22, 0x33]))).toBe(false);
    expect(backup.isEncryptedBackup(Buffer.from('DSBK', 'latin1'))).toBe(true);
  });

  it('download_opt_in_logs_the_same_warning_and_still_allows', () => {
    const previous = defaultLogSink();
    const warns: string[] = [];
    const recorder: LogSink = {
      error: () => {},
      warn: message => { warns.push(message); },
      info: () => {},
      debug: () => {},
    };
    setDefaultLogSink(recorder);
    try {
      expectAllowed({
        cloudMarkerPresent: true,
        locallyRememberedEncrypted: true,
        objectIsEncrypted: false,
        plaintextHistoryOptIn: true,
      });
    } finally {
      setDefaultLogSink(previous);
    }
    expect(warns.join('\n')).toContain('[CloudSync][R6-downgrade-optin]');
    expect(warns.join('\n')).toContain('本次放行');
  });
});
