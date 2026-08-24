/**
 * 云存储 / ZIP 备份错误的展示层映射。
 *
 * 短密码 / 读不到已存密码已有稳定 code，优先按 code 映射；
 * 其余 E2EE 诊断多数仍是中文原文。云设置页与本地 ZIP 导入导出共用这一层。
 */
import { getErrorMessage } from '@/utils/errorUtils';
import * as cloudApi from '@/utils/cloudStorageApi';
import {
  classifySyncE2eeError,
  SYNC_E2EE_ERROR_I18N_KEYS,
} from './syncE2eeErrorMapping';

/** 与后端 `MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS` / ZIP `MIN_ENCRYPTION_PASSWORD_CHARS` 对齐。 */
export const CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS = 8;

type Translate = (key: string, options?: Record<string, unknown>) => string;

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
  if (encryptionKey === 'cloudStorage:encryption.storedPasswordRequired') {
    return t(encryptionKey);
  }
  const e2eeKind = classifySyncE2eeError(raw);
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
