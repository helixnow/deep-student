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
  ATOMIC_RESTORE_UNAVAILABLE_CODE,
  CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
  findCloudBackupVersion,
  getCloudStorageErrorCode,
  isImportedArchiveSlotRestorable,
  isKnownPortableCloudBackup,
  PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE,
  SEALED_BACKUP_DECRYPT_FAILED_CODE,
  SEALED_BACKUP_PASSWORD_REQUIRED_CODE,
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

  it('maps portable/partial slot-restore refusals by stable code and Chinese fallback', () => {
    expect(
      localizeCloudStorageError(
        { code: PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE, message: 'rewritten partial archive' },
        t,
      ),
    ).toBe('cloudStorage:errors.partialArchiveNotSlotable');
    expect(
      localizeCloudStorageError(
        new Error('备份不能用于完整恢复: 备份不是可替换数据槽的完整快照: PartialOverlay'),
        t,
      ),
    ).toBe('cloudStorage:errors.partialArchiveNotSlotable');
  });

  it('Rust and TypeScript share the partial-archive slot-restore code', () => {
    const rust = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/data_governance/backup/mod.rs'),
      'utf-8',
    );
    expect(rust).toContain(`"${PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE}"`);
    const restore = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/data_governance/commands_restore.rs'),
      'utf-8',
    );
    expect(restore).toContain('PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE');
  });

  it('maps sealed-ZIP and atomic-restore refusals by stable code', () => {
    expect(
      localizeCloudStorageError(
        { code: SEALED_BACKUP_PASSWORD_REQUIRED_CODE, message: 'rewritten password prompt' },
        t,
      ),
    ).toBe('cloudStorage:errors.sealedBackupPasswordRequired');
    expect(
      localizeCloudStorageError(
        { code: SEALED_BACKUP_DECRYPT_FAILED_CODE, message: 'rewritten decrypt failure' },
        t,
      ),
    ).toBe('cloudStorage:errors.sealedBackupDecryptFailed');
    expect(
      localizeCloudStorageError(
        { code: ATOMIC_RESTORE_UNAVAILABLE_CODE, message: 'rewritten manager failure' },
        t,
      ),
    ).toBe('cloudStorage:errors.atomicRestoreUnavailable');
  });

  it('extracts new stable codes from background-job diagnostic strings', () => {
    for (const code of [
      SEALED_BACKUP_PASSWORD_REQUIRED_CODE,
      SEALED_BACKUP_DECRYPT_FAILED_CODE,
      ATOMIC_RESTORE_UNAVAILABLE_CODE,
    ]) {
      expect(getCloudStorageErrorCode(new Error(`[${code}] rewritten diagnostic`))).toBe(code);
    }
  });

  it('Rust and TypeScript share sealed-ZIP and atomic-restore codes', () => {
    const zip = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/data_governance/backup/zip_export.rs'),
      'utf-8',
    );
    expect(zip).toContain(`"${SEALED_BACKUP_PASSWORD_REQUIRED_CODE}"`);
    expect(zip).toContain(`"${SEALED_BACKUP_DECRYPT_FAILED_CODE}"`);

    const backup = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/data_governance/backup/mod.rs'),
      'utf-8',
    );
    expect(backup).toContain(`"${ATOMIC_RESTORE_UNAVAILABLE_CODE}"`);
  });

  it('cloud and local ZIP restore paths refuse before restoreBackup', () => {
    const cloud = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/CloudStorageSection.tsx'),
      'utf-8',
    );
    const cloudRestore = cloud.slice(
      cloud.indexOf('const performRestore = useCallback'),
      cloud.indexOf('const handleRestore = useCallback'),
    );
    const local = readFileSync(
      resolve(process.cwd(), 'src/components/DataImportExport.tsx'),
      'utf-8',
    );
    const localImport = local.slice(
      local.indexOf('const handleImportZipBackup'),
      local.indexOf('const handleSaveBackup'),
    );
    for (const src of [cloudRestore, localImport]) {
      const importIdx = src.indexOf('importZip(');
      const restoreIdx = src.indexOf('restoreBackup(');
      const kindIdx = src.indexOf('isImportedArchiveSlotRestorable');
      expect(importIdx).toBeGreaterThan(-1);
      expect(restoreIdx).toBeGreaterThan(importIdx);
      expect(kindIdx).toBeGreaterThan(importIdx);
      expect(kindIdx).toBeLessThan(restoreIdx);
    }
  });

  it('looks up cloud versions and refuses known portable packages before download', () => {
    const versions = [
      { id: 'a', recoveryKind: 'disaster_recovery' },
      { id: 'b', recoveryKind: 'partial_archive' },
    ];
    const latest = { id: 'c', recoveryKind: 'partial_archive' };
    expect(findCloudBackupVersion('b', versions, latest)?.id).toBe('b');
    expect(findCloudBackupVersion('c', versions, latest)?.id).toBe('c');
    expect(findCloudBackupVersion('missing', versions, latest)).toBeUndefined();
    expect(isKnownPortableCloudBackup(findCloudBackupVersion('b', versions, latest))).toBe(true);
    expect(isKnownPortableCloudBackup(findCloudBackupVersion('a', versions, latest))).toBe(false);
    expect(isKnownPortableCloudBackup(undefined)).toBe(false);
  });

  it('refuses portable/partial import stats before slot restore, and lets missing stats fall through', () => {
    expect(isImportedArchiveSlotRestorable(undefined)).toBe(true);
    expect(isImportedArchiveSlotRestorable(null)).toBe(true);
    expect(isImportedArchiveSlotRestorable({})).toBe(true);
    expect(isImportedArchiveSlotRestorable({ recovery_kind: 'disaster_recovery' })).toBe(true);
    expect(isImportedArchiveSlotRestorable({ restorable: true })).toBe(true);
    expect(isImportedArchiveSlotRestorable({ recovery_kind: 'partial_archive' })).toBe(false);
    expect(isImportedArchiveSlotRestorable({ restorable: false })).toBe(false);
    expect(
      isImportedArchiveSlotRestorable({
        recovery_kind: 'disaster_recovery',
        restorable: false,
      }),
    ).toBe(false);
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
