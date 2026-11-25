/**
 * localizeCloudStorageError 行为契约：云设置页与本地 ZIP 共用同一套映射。
 * 短密码 / stored-password 优先稳定 code；旧中文诊断仍兜底。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE as hostShortPasswordCode } from '../../../host/platform/secrets/api';
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
  it('Host 与前端使用同一对 code', () => {
    const zipCommands = readFileSync(
      resolve(process.cwd(), 'host/plugins/backup/src/zip-commands.ts'),
      'utf-8',
    );
    expect(hostShortPasswordCode).toBe(CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE);
    expect(zipCommands).toContain(`'${STORED_CLOUD_ENCRYPTION_PASSWORD_REQUIRED_CODE}'`);
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
    const host = readFileSync(
      resolve(process.cwd(), 'host/plugins/backup/src/manifest-model.ts'),
      'utf-8',
    );
    expect(host).toContain(`'${PARTIAL_ARCHIVE_NOT_SLOTABLE_CODE}'`);
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
      resolve(process.cwd(), 'host/plugins/backup/src/zip-codes.ts'),
      'utf-8',
    );
    expect(zip).toContain(`'${SEALED_BACKUP_PASSWORD_REQUIRED_CODE}'`);
    expect(zip).toContain(`'${SEALED_BACKUP_DECRYPT_FAILED_CODE}'`);

    const backup = readFileSync(
      resolve(process.cwd(), 'host/plugins/backup/src/manifest-model.ts'),
      'utf-8',
    );
    expect(backup).toContain(`'${ATOMIC_RESTORE_UNAVAILABLE_CODE}'`);
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
    const importIdx = cloudRestore.indexOf('importZip(');
    const restoreIdx = cloudRestore.indexOf('restoreBackup(');
    const kindIdx = cloudRestore.indexOf('isImportedArchiveSlotRestorable');
    expect(importIdx).toBeGreaterThan(-1);
    expect(restoreIdx).toBeGreaterThan(importIdx);
    expect(kindIdx).toBeGreaterThan(importIdx);
    expect(kindIdx).toBeLessThan(restoreIdx);

    // Local ZIP restore is consolidated in DataGovernanceDashboard
    const governance = readFileSync(
      resolve(process.cwd(), 'src/features/settings/components/DataGovernanceDashboard.tsx'),
      'utf-8',
    );
    expect(governance).toContain('cloudApi.isImportedArchiveSlotRestorable(stats)');
    expect(governance).toContain('if (backupId && resultSuccess && importedArchiveIsRestorable)');
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

  it('maps rewritten E2EE diagnostics by stable code without leaking raw codes or paths', () => {
    const e2eeMsg = localizeCloudStorageError(
      {
        code: SYNC_E2EE_WRONG_PASSWORD_CODE,
        message: '[E_SYNC_E2EE_WRONG_PASSWORD] Database error: decrypt failed [path]/9f0e0e7fa512c679.json',
      },
      t,
    );
    expect(e2eeMsg).toBe('cloudStorage:errors.e2eeWrongPassword');
    expect(e2eeMsg).not.toContain('E_SYNC_E2EE_WRONG_PASSWORD');
    expect(e2eeMsg).not.toContain('Database error:');
    expect(e2eeMsg).not.toContain('[path]/9f0e0e7fa512c679.json');

    const badObjMsg = localizeCloudStorageError(
      {
        code: 'E_SYNC_BAD_OBJECT_FAIL_CLOSED',
        message: '[E_SYNC_BAD_OBJECT_FAIL_CLOSED] corrupt [path]/abc123.json',
      },
      t,
    );
    expect(badObjMsg).toBe('cloudStorage:errors.syncBadObjectFailClosed');
    expect(badObjMsg).not.toContain('[path]/abc123.json');
  });

  it('collapses nested WebDAV GET/PROPFIND offline and connection-reset chains in zh-CN and en-US', () => {
    const offlineChain =
      '检查云端变更断层失败: Network error: WebDAV GET 请求失败（已重试 3 次）: error sending request for url (https://dav.example.com/sync/manifest.json)';
    const zhOffline = localizeCloudStorageError(new Error(offlineChain), t, 'zh-CN');
    expect(zhOffline).toBe('暂时无法连接到云端服务器，请检查网络连接和服务器地址后重试。');
    expect(zhOffline).not.toContain('WebDAV GET');
    expect(zhOffline).not.toContain('检查云端变更断层失败');

    const enOffline = localizeCloudStorageError(new Error(offlineChain), t, 'en-US');
    expect(enOffline).toBe(
      'Cannot reach the cloud server. Please check your network connection and server URL, then retry.',
    );
    expect(enOffline).not.toMatch(/[\u4e00-\u9fff]/);
    expect(enOffline).not.toContain('WebDAV GET');

    const resetChain =
      'WebDAV PROPFIND /sync/ 失败（已重试 3 次）: connection reset by peer';
    const zhReset = localizeCloudStorageError(new Error(resetChain), t, 'zh-CN');
    expect(zhReset).toBe('同步途中网络连接中断，本地更改已安全保留，网络恢复后重试即可。');
    const enReset = localizeCloudStorageError(new Error(resetChain), t, 'en-US');
    expect(enReset).toBe(
      'Network connection was interrupted mid-sync. Your local changes are safe—please retry.',
    );
    expect(enReset).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it('keeps unmapped diagnostics as the original message', () => {
    expect(localizeCloudStorageError(new Error('disk full'), t)).toBe('disk full');
  });
});
