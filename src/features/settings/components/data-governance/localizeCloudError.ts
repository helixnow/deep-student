/**
 * 云存储 / ZIP 备份错误的展示层映射。
 *
 * 后端多数 E2EE / 短密码拒绝仍是中文诊断文案、尚无稳定 code。
 * 云设置页与数据治理本地 ZIP 导入导出共用这一层，避免 en 用户只看到原文。
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

export function localizeCloudStorageError(error: unknown, t: Translate): string {
  const raw = getErrorMessage(error);
  const e2eeKind = classifySyncE2eeError(raw);
  if (e2eeKind) {
    return `${t(SYNC_E2EE_ERROR_I18N_KEYS[e2eeKind])}\n(${raw})`;
  }
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
