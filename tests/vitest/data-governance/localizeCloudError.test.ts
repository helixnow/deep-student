/**
 * localizeCloudStorageError 行为契约：云设置页与本地 ZIP 共用同一套映射。
 * 后端多数 E2EE / 短密码拒绝仍是中文诊断，尚无稳定 code。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/cloudStorageApi', () => ({
  getCloudPlatformErrorI18nKey: () => undefined,
}));

import {
  CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS,
  localizeCloudStorageError,
} from '@/features/settings/components/data-governance/localizeCloudError';

const t = (key: string, options?: Record<string, unknown>) =>
  options?.min != null ? `${key}:${options.min}` : key;

describe('localizeCloudStorageError', () => {
  it('maps short-password Chinese diagnostics from cloud and ZIP parsers', () => {
    expect(
      localizeCloudStorageError(new Error('云端端到端加密密码至少需要 8 个字符'), t),
    ).toBe(`cloudStorage:encryption.tooShort:${CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS}`);
    expect(
      localizeCloudStorageError(new Error('备份密码至少需要 8 个字符'), t),
    ).toBe(`cloudStorage:encryption.tooShort:${CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS}`);
  });

  it('maps stored-password-required fail-closed fragment', () => {
    expect(
      localizeCloudStorageError(
        new Error('无法整槽恢复的便携归档当成加密全保真'),
        t,
      ),
    ).toBe('cloudStorage:encryption.storedPasswordRequired');
  });

  it('maps Missing WebDAV/S3/FTP configuration English throws', () => {
    expect(localizeCloudStorageError(new Error('Missing WebDAV configuration'), t)).toBe(
      'cloudStorage:errors.missingWebdavConfig',
    );
    expect(localizeCloudStorageError(new Error('Missing S3 configuration'), t)).toBe(
      'cloudStorage:errors.missingS3Config',
    );
    expect(localizeCloudStorageError(new Error('Missing FTP configuration'), t)).toBe(
      'cloudStorage:errors.missingFtpConfig',
    );
  });

  it('keeps unmapped diagnostics as the original message', () => {
    expect(localizeCloudStorageError(new Error('disk full'), t)).toBe('disk full');
  });
});
