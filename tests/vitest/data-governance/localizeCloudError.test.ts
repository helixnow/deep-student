/**
 * localizeCloudStorageError 行为契约：云设置页与本地 ZIP 共用同一套映射。
 * 短密码 / stored-password 优先稳定 code；旧中文诊断仍兜底。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/cloudStorageApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/cloudStorageApi')>();
  return {
    ...actual,
    getCloudPlatformErrorI18nKey: () => undefined,
  };
});

import {
  CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
  STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
} from '@/utils/cloudStorageApi';

import {
  CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS,
  localizeCloudStorageError,
} from '@/features/settings/components/data-governance/localizeCloudError';

const t = (key: string, options?: Record<string, unknown>) =>
  options?.min != null ? `${key}:${options.min}` : key;

describe('短密码 / stored-password 稳定 code 跨层契约', () => {
  it('Rust 与 TypeScript 使用同一对 code', () => {
    const secureStore = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/secure_store.rs'),
      'utf-8',
    );
    const zipCommands = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/data_governance/commands_zip.rs'),
      'utf-8',
    );
    expect(secureStore).toContain(`"${CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE}"`);
    expect(zipCommands).toContain(`"${STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED_CODE}"`);
  });
});

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

  it('maps short-password and stored-password by stable code even if message changes', () => {
    expect(
      localizeCloudStorageError(
        { code: CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE, message: 'rewritten short-password' },
        t,
      ),
    ).toBe(`cloudStorage:encryption.tooShort:${CLOUD_ENCRYPTION_PASSWORD_MIN_CHARS}`);
    expect(
      localizeCloudStorageError(
        {
          code: STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED_CODE,
          message: 'rewritten stored-password',
        },
        t,
      ),
    ).toBe('cloudStorage:encryption.storedPasswordRequired');
  });

  it('maps rewritten E2EE diagnostics by stable code', () => {
    expect(
      localizeCloudStorageError(
        { code: SYNC_E2EE_WRONG_PASSWORD_CODE, message: 'rewritten password' },
        t,
      ),
    ).toBe('cloudStorage:errors.e2eeWrongPassword\n(rewritten password)');
  });

  it('keeps unmapped diagnostics as the original message', () => {
    expect(localizeCloudStorageError(new Error('disk full'), t)).toBe('disk full');
  });
});
