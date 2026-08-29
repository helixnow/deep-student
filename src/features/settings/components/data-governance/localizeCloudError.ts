/**
 * 云存储 / ZIP 备份错误的展示层映射。
 *
 * 短密码 / 读不到已存密码 / E2EE 三类失败优先按稳定 code 映射；
 * 接线前或旧客户端的中文诊断仍兜底。云设置页与本地 ZIP 导入导出共用这一层。
 */
import { getErrorMessage } from '@/utils/errorUtils';
import * as cloudApi from '@/utils/cloudStorageApi';
import {
  classifySyncE2eeError,
  classifySyncE2eeErrorCode,
  SYNC_E2EE_ERROR_I18N_KEYS,
} from './syncE2eeErrorMapping';

/** 与后端 `MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS` / ZIP `MIN_ENCRYPTION_PASSWORD_CHARS` 对齐。 */
export const CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS = 8;

/** [Wave2-R5] 与后端 `MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS` 对齐（弱口令熵下限）。 */
export const CLOUD_ENCRYPTION_PASSWORD_MIN_DISTINCT_CHARS = 4;

type Translate = (key: string, options?: Record<string, unknown>) => string;

function readCloudStorageErrorCode(error: unknown): string | undefined {
  try {
    return cloudApi.getCloudStorageErrorCode(error);
  } catch {
    // 部分 vitest mock 没导出该函数。
    return undefined;
  }
}

function readCloudEncryptionI18nKey(
  error: unknown,
): ReturnType<typeof cloudApi.getCloudEncryptionErrorI18nKey> {
  try {
    const mapped = cloudApi.getCloudEncryptionErrorI18nKey(error);
    if (mapped) return mapped;
  } catch {
    // 部分 vitest mock 没导出该函数；退回 message token。
  }
  const raw = getErrorMessage(error);
  if (raw.includes('E_CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT')) {
    return 'cloudStorage:encryption.tooShort';
  }
  if (raw.includes('E_CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK')) {
    return 'cloudStorage:encryption.tooWeak';
  }
  if (raw.includes('E_STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED')) {
    return 'cloudStorage:encryption.storedPasswordRequired';
  }
  return undefined;
}

export function localizeCloudStorageError(error: unknown, t: Translate): string {
  const raw = getErrorMessage(error);
  const encryptionKey = readCloudEncryptionI18nKey(error);
  if (encryptionKey === 'cloudStorage:encryption.tooShort') {
    return t(encryptionKey, { min: CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS });
  }
  if (encryptionKey === 'cloudStorage:encryption.tooWeak') {
    return t(encryptionKey, {
      minDistinct: CLOUD_ENCRYPTION_PASSWORD_MIN_DISTINCT_CHARS,
    });
  }
  if (encryptionKey === 'cloudStorage:encryption.storedPasswordRequired') {
    return t(encryptionKey);
  }
  const e2eeKind =
    classifySyncE2eeErrorCode(readCloudStorageErrorCode(error)) ??
    classifySyncE2eeError(raw);
  if (e2eeKind) {
    return `${t(SYNC_E2EE_ERROR_I18N_KEYS[e2eeKind])}\n(${raw})`;
  }
  // 接线前/旧诊断仍可能没有稳定 code，保留中文片段兜底。
  if (/云端端到端加密密码至少需要|备份密码至少需要/.test(raw)) {
    return t('cloudStorage:encryption.tooShort', {
      min: CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS,
    });
  }
  if (/无法整槽恢复的便携归档当成加密全保真/.test(raw)) {
    return t('cloudStorage:encryption.storedPasswordRequired');
  }
  if (
    readCloudStorageErrorCode(error) === 'E_BACKUP_PARTIAL_ARCHIVE_NOT_SLOTABLE' ||
    /备份不能用于完整恢复|不是可替换数据槽的完整快照|partial archive 不能替换数据槽/.test(raw)
  ) {
    return t('cloudStorage:errors.partialArchiveNotSlotable');
  }
  switch (readCloudStorageErrorCode(error)) {
    case 'E_BACKUP_SEALED_PASSWORD_REQUIRED':
      return t('cloudStorage:errors.sealedBackupPasswordRequired');
    case 'E_BACKUP_SEALED_DECRYPT_FAILED':
      return t('cloudStorage:errors.sealedBackupDecryptFailed');
    case 'E_BACKUP_ATOMIC_RESTORE_UNAVAILABLE':
      return t('cloudStorage:errors.atomicRestoreUnavailable');
    // [R5-i18n] R4 新稳定码 + commands_backup / commands_zip 第一批 code-only。
    // 云端目录/对象状态类附上原文（排查需要对象 key 等细节）；
    // 本机配置/资源类只给人话，原文进日志即可。
    case 'E_SYNC_BAD_OBJECT_FAIL_CLOSED':
      return `${t('cloudStorage:errors.syncBadObjectFailClosed')}\n(${raw})`;
    case 'E_DG_TOMBSTONE_LIMITER_BUSY':
      return t('cloudStorage:errors.governanceBusy');
    case 'E_BACKUP_DIR_MISSING':
      return t('cloudStorage:errors.backupDirMissing');
    case 'E_RESTORE_DISK_BUDGET_OVERFLOW':
      return t('cloudStorage:errors.restoreDiskBudgetOverflow');
    case 'E_ZIP_EXPORT_TEMP_MISSING':
      return t('cloudStorage:errors.zipExportTempMissing');
    case 'E_ZIP_EXPORT_COPY_TARGET_FAILED':
      return `${t('cloudStorage:errors.zipExportCopyTargetFailed')}\n(${raw})`;
    // [R6-i18n] R4 verified_publish.rs 稳定码：发布前/后校验 fail-closed。
    // 云端对象状态类，附原文（排查需要对象 key、字节数等细节）。
    case 'E_VERIFIED_PUBLISH_MISMATCH':
      return `${t('cloudStorage:errors.verifiedPublishMismatch')}\n(${raw})`;
    case 'E_VERIFIED_PUBLISH_OVERSIZE':
      return `${t('cloudStorage:errors.verifiedPublishOversize')}\n(${raw})`;
    case 'E_VERIFIED_PUBLISH_UNCONDITIONAL_WRITE':
      return `${t('cloudStorage:errors.verifiedPublishUnconditionalWrite')}\n(${raw})`;
  }
  // 恢复域账本稳定码（src-tauri/src/data_governance/restore_codes.rs）。
  // 后台任务失败消息以 `[E_...] 说明` 形式携带稳定码，没有 CommandError
  // envelope，因此除 code 外还需子串兜底。
  const restoreLedgerCode = readCloudStorageErrorCode(error);
  if (
    restoreLedgerCode === 'E_RESTORE_DOMAIN_UNCONSUMED' ||
    raw.includes('E_RESTORE_DOMAIN_UNCONSUMED')
  ) {
    return t('cloudStorage:errors.restoreDomainUnconsumed');
  }
  if (
    restoreLedgerCode === 'E_RESTORE_DOMAIN_FAILED' ||
    raw.includes('E_RESTORE_DOMAIN_FAILED')
  ) {
    return t('cloudStorage:errors.restoreDomainFailed');
  }
  if (
    restoreLedgerCode === 'E_RESTORE_UNTRUSTED_ISOLATED' ||
    raw.includes('E_RESTORE_UNTRUSTED_ISOLATED')
  ) {
    return t('cloudStorage:errors.restoreUntrustedIsolated');
  }
  if (/Missing WebDAV configuration/.test(raw)) {
    return t('cloudStorage:errors.missingWebdavConfig');
  }
  if (/Missing S3 configuration/.test(raw)) {
    return t('cloudStorage:errors.missingS3Config');
  }
  if (/Missing FTP configuration/.test(raw)) {
    return t('cloudStorage:errors.missingFtpConfig');
  }
  const platformErrorKey = cloudApi.getCloudPlatformErrorI18nKey(error);
  if (platformErrorKey) return t(platformErrorKey);
  return raw;
}
